"""
axon/routes.py -- aiohttp HTTP and WebSocket route handlers.
"""

import asyncio
import json
import socket

from aiohttp import web, WSMsgType

from .cfg_file import cfg_to_frontend, frontend_to_cfg
from .config import ASYNC_PORT, devices, log, ws_clients
from .discovery import broadcast_scan, query_and_update, register_device
from .protocol import broadcast_all, cmd_proto, async_proto
from .push import blocking_push
from .sync import blocking_sync


# ---------------------------------------------------------------------------
# Device management
# ---------------------------------------------------------------------------

async def api_list_devices(req: web.Request) -> web.Response:
    return web.json_response(list(devices.values()))


async def api_interfaces(req: web.Request) -> web.Response:
    """GET /api/interfaces -- list available network interfaces with IPv4 addresses."""
    interfaces = []
    try:
        import netifaces
        for iface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(iface).get(netifaces.AF_INET, [])
            for a in addrs:
                ip = a.get("addr", "")
                if ip and not ip.startswith("127."):
                    interfaces.append({"name": iface, "ip": ip})
    except ImportError:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
            s.close()
            interfaces.append({"name": "default", "ip": ip})
        except Exception:
            interfaces.append({"name": "default", "ip": "0.0.0.0"})

    if not interfaces:
        interfaces.append({"name": "default", "ip": "0.0.0.0"})

    return web.json_response(interfaces)


async def api_device_add(req: web.Request) -> web.Response:
    body = await req.json()
    ip   = body.get("ip", "").strip()
    if not ip:
        return web.json_response({"error": "ip required"}, status=400)
    register_device(ip, {"source": "manual"})
    asyncio.ensure_future(query_and_update(ip))
    return web.json_response({"status": "added", "ip": ip})


async def api_scan(req: web.Request) -> web.Response:
    """POST /api/scan -- trigger a broadcast QUERY scan, return found IPs."""
    found = await broadcast_scan()
    return web.json_response({"found": found, "total": len(found)})


async def api_discover(req: web.Request) -> web.Response:
    """GET /api/device/{ip}/discover"""
    ip = req.match_info["ip"]
    try:
        await query_and_update(ip)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=504)
    return web.json_response(devices.get(ip, {}))


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

async def api_sync(req: web.Request) -> web.Response:
    """POST /api/device/{ip}/sync -- streaming NDJSON sync progress + final config."""
    ip = req.match_info["ip"]

    response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
    await response.prepare(req)

    loop = asyncio.get_event_loop()

    def progress(msg: str):
        line = json.dumps({"log": msg}) + "\n"
        asyncio.run_coroutine_threadsafe(response.write(line.encode()), loop)
        asyncio.run_coroutine_threadsafe(
            broadcast_all({"type": "sync_log", "device_ip": ip, "msg": msg}), loop)

    dev = devices.get(ip, {})
    mdns_name = dev.get("name") or dev.get("frontend_config", {}).get("deviceName") or None
    log.info("sync %s: device registry=%s mdns_name=%r", ip, {k: v for k, v in dev.items() if k not in ("sv_values", "sm_values", "frontend_config", "mdns_props")}, mdns_name)
    result = await loop.run_in_executor(None, blocking_sync, ip, progress, mdns_name)

    if result["ok"] and result.get("config"):
        cfg        = result["config"]
        sv_to_slot = cfg.pop("svToSlot", {})
        slot_to_sv = cfg.pop("slotToSV", {})
        update = {
            "sv_to_slot": {int(k): v for k, v in sv_to_slot.items()},
            "slot_to_sv": {int(k): v for k, v in slot_to_sv.items()},
            "synced": True,
        }
        if cfg.get("deviceName"):
            update["name"] = cfg["deviceName"]
        devices.setdefault(ip, {}).update(update)
        await broadcast_all({
            "type":      "device_synced",
            "device_ip": ip,
            "config":    cfg,
            "summary":   result.get("summary", {}),
        })

    await response.write((json.dumps({"result": result}) + "\n").encode())
    await response.write_eof()
    return response


# ---------------------------------------------------------------------------
# Commands and SV
# ---------------------------------------------------------------------------

async def api_send_command(req: web.Request) -> web.Response:
    ip   = req.match_info["ip"]
    body = await req.json()
    cmd  = body.get("cmd", "").strip()
    if not cmd:
        return web.json_response({"error": "cmd required"}, status=400)
    try:
        # cmd_proto is set at startup in protocol module
        import axon.protocol as _p
        resp = await _p.cmd_proto.send_await(ip, cmd)
        return web.json_response({"response": resp})
    except TimeoutError as e:
        return web.json_response({"error": str(e)}, status=504)


async def api_set_sv(req: web.Request) -> web.Response:
    import axon.protocol as _p
    ip   = req.match_info["ip"]
    body = await req.json()
    ch   = int(body["channel"])
    db   = int(body["db"])
    devices.setdefault(ip, {}).setdefault("sv_values", {})[ch] = db
    _p.async_proto.transport.sendto(f"SV {ch} {db}\r".encode(), (ip, ASYNC_PORT))
    return web.json_response({"status": "sent", "channel": ch, "db": db})


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

async def api_push(req: web.Request) -> web.Response:
    """POST /api/device/{ip}/push -- streaming NDJSON push progress."""
    ip   = req.match_info["ip"]
    body = await req.json()

    response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
    await response.prepare(req)

    loop = asyncio.get_event_loop()

    def progress(msg: str):
        asyncio.run_coroutine_threadsafe(
            response.write((json.dumps({"log": msg}) + "\n").encode()), loop)
        asyncio.run_coroutine_threadsafe(
            broadcast_all({"type": "push_log", "device_ip": ip, "msg": msg}), loop)

    result = await loop.run_in_executor(None, blocking_push, ip, body, progress)
    if result["ok"]:
        devices.setdefault(ip, {})["configHash"] = result["hash"]

    await response.write((json.dumps({"result": result}) + "\n").encode())
    await response.write_eof()
    return response


# ---------------------------------------------------------------------------
# .cfg import / export
# ---------------------------------------------------------------------------

async def api_cfg_export(req: web.Request) -> web.Response:
    """GET or POST /api/device/{ip}/cfg -- download current config as .cfg file."""
    ip  = req.match_info["ip"]
    dev = devices.get(ip, {})
    cfg = dev.get("frontend_config", {
        "mode":              dev.get("mode", "THIRD_PARTY"),
        "displayBrightness": int(dev.get("displayBright", 7)),
        "displayTimeout":    10,
        "lbBrightness":      int(dev.get("lbBright", 5)),
        "lbTimeout":         10,
        "lbColor":           "#ffffff",
        "lbOn":              True,
        "pinEnabled":        False,
        "pin":               "0000",
        "displayLock":       False,
        "devices":           [],
        "mainMenu":          {"entry_type": "menu", "display_txt": "MAIN MENU", "entries": []},
        "volMuteScreen":     None,
    })
    body = await req.json() if req.content_length else {}
    if body.get("config"):
        cfg = body["config"]
        devices.setdefault(ip, {})["frontend_config"] = cfg
    fw = dev.get("firmware", "V1.5.0")
    if not fw.startswith("V"):
        fw = f"V{fw}"
    try:
        xml_bytes = frontend_to_cfg(cfg, firmware_ver=fw)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    name = cfg.get("deviceName") or dev.get("name") or ""
    return web.Response(
        body=xml_bytes,
        content_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{name}.cfg"'},
    )


async def api_cfg_import(req: web.Request) -> web.Response:
    """POST /api/cfg/import -- upload a .cfg file, returns frontend config."""
    try:
        data = await req.read()
        cfg  = cfg_to_frontend(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True, "config": cfg})


# ---------------------------------------------------------------------------
# WebSocket handlers
# ---------------------------------------------------------------------------

async def ws_handler(req: web.Request) -> web.WebSocketResponse:
    import axon.protocol as _p
    ip = req.match_info["ip"]
    ws = web.WebSocketResponse()
    await ws.prepare(req)
    ws_clients[ip].add(ws)
    await ws.send_json({"type": "device_list", "devices": list(devices.values())})
    log.info("WS connected for %s", ip)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    if data.get("type") == "sv_set":
                        ch = int(data["channel"])
                        db = int(data["db"])
                        devices.setdefault(ip, {}).setdefault("sv_values", {})[ch] = db
                        _p.async_proto.transport.sendto(
                            f"SV {ch} {db}\r".encode(), (ip, ASYNC_PORT))
                except Exception:
                    pass
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        ws_clients[ip].discard(ws)
    return ws


async def ws_discovery_handler(req: web.Request) -> web.WebSocketResponse:
    """WebSocket /ws/_discovery -- receives device_found/device_updated for all devices."""
    ws = web.WebSocketResponse()
    await ws.prepare(req)
    ws_clients["_discovery"].add(ws)
    await ws.send_json({"type": "device_list", "devices": list(devices.values())})
    try:
        async for msg in ws:
            if msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        ws_clients["_discovery"].discard(ws)
    return ws

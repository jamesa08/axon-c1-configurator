"""
Axon C1 Configurator - Backend Server

Discovery: two parallel strategies run at startup and on-demand:
  1. mDNS browse for _attero._udp.local (C1 native advertisement)
  2. UDP broadcast QUERY on 49494 -- catches anything mDNS misses

Push protocol: 7-phase sequence ported from push_cfg_v3.py (hardware-verified).
"""

import asyncio
import json
import logging
import math
import re
import socket
import time
import uuid
from collections import defaultdict
from pathlib import Path

from aiohttp import web, WSMsgType
from zeroconf import ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("axon")

CMD_PORT   = 49494
ASYNC_PORT = 49500
STATIC_DIR = Path(__file__).parent.parent / "frontend" / "dist"

# ip -> device state dict
devices: dict[str, dict] = {}
# ip -> set of open WebSocket connections
ws_clients: dict[str, set] = defaultdict(set)

# mDNS service types to browse (try both; one will be right)
MDNS_SERVICE_TYPES = [
    "_attero._udp.local.",
    "_axon._udp.local.",
    "_http._tcp.local.",   # fallback -- some firmware versions use this
]


# ---------------------------------------------------------------------------
# QUERY response parser
# ---------------------------------------------------------------------------

def parse_query_response(resp: str) -> dict:
    """
    Parse ACK QUERY MAC=... IP=... CM=... etc into a dict.
    All fields from the RE doc firmware format string are handled.
    """
    if not resp or not resp.startswith("ACK QUERY"):
        return {}
    out = {}
    for token in resp.split():
        if "=" in token:
            k, _, v = token.partition("=")
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# cmdMask helpers (match push_cfg_v3.py byte-for-byte)
# ---------------------------------------------------------------------------

def sv_set_mask(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0xe3, 0x0d]

def sv_query_mask(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0x0d]

def sv_resp_mask(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0xe3, 0x0d]


# ---------------------------------------------------------------------------
# Device registration helper
# ---------------------------------------------------------------------------

def _register_device(ip: str, info: dict | None = None):
    """Add or update a device in the registry and broadcast to all WS clients."""
    existing = devices.get(ip, {})
    devices[ip] = {
        "ip":        ip,
        "sv_values": existing.get("sv_values", {}),
        "sm_values": existing.get("sm_values", {}),
        **(info or {}),
    }
    log.info("Device registered: %s  %s", ip, info or "")
    asyncio.ensure_future(_broadcast_all({"type": "device_found", "device": devices[ip]}))


async def _broadcast_all(payload: dict):
    """Broadcast to every connected WebSocket regardless of device IP."""
    for ip_clients in ws_clients.values():
        dead = set()
        for ws in ip_clients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.add(ws)
        ip_clients -= dead
    # Also broadcast to the global "_discovery" room
    dead = set()
    for ws in ws_clients.get("_discovery", set()):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    ws_clients["_discovery"] -= dead


# ---------------------------------------------------------------------------
# Discovery: mDNS
# ---------------------------------------------------------------------------

class _MDNSListener:
    """zeroconf service listener -- fires when an Attero device appears/disappears."""

    def __init__(self, azc: AsyncZeroconf):
        self._azc = azc

    def async_update_service(self, zc, stype, name):
        pass  # don't care about updates

    def async_remove_service(self, zc, stype, name):
        log.info("mDNS remove: %s", name)

    def async_add_service(self, zc, stype, name):
        asyncio.ensure_future(self._resolve(stype, name))

    # zeroconf calls these without 'async_' prefix too in older builds
    update_service = async_update_service
    remove_service = async_remove_service
    add_service    = async_add_service

    async def _resolve(self, stype: str, name: str):
        info = AsyncServiceInfo(stype, name)
        ok   = await info.async_request(self._azc.zeroconf, timeout=3000)
        if not ok:
            log.warning("mDNS: could not resolve %s", name)
            return

        addrs = info.parsed_addresses()
        if not addrs:
            return
        ip = addrs[0]

        props = {}
        try:
            props = {k.decode(): v.decode() for k, v in info.properties.items()}
        except Exception:
            pass

        # Only register Axon C1 devices (CtrlType=AtteroUDP, Model=AxonC1)
        ctrl_type = props.get("CtrlType", "")
        model     = props.get("Model", "")
        if ctrl_type != "AtteroUDP" and "Axon" not in name and "Axon" not in model:
            log.debug("mDNS: ignoring non-Axon service %s (CtrlType=%s)", name, ctrl_type)
            return

        device_name = name.split(".")[0]  # "AxonC1-XXYYZZ"
        _register_device(ip, {
            "source":     "mdns",
            "name":       device_name,
            "mdns_name":  name,
            "mdns_props": props,
        })
        # Fire QUERY to get full device state
        asyncio.ensure_future(_query_and_update(ip))


_mdns_browsers: list = []
_azc: AsyncZeroconf | None = None


async def start_mdns_discovery():
    """Start async mDNS browsers for all candidate service types."""
    global _azc, _mdns_browsers
    _azc = AsyncZeroconf()
    listener = _MDNSListener(_azc)
    for stype in MDNS_SERVICE_TYPES:
        browser = AsyncServiceBrowser(_azc.zeroconf, stype, listener=listener)
        _mdns_browsers.append(browser)
        log.info("mDNS browser started for %s", stype)


async def stop_mdns_discovery():
    global _azc
    for b in _mdns_browsers:
        await b.async_cancel()
    if _azc:
        await _azc.async_close()


# ---------------------------------------------------------------------------
# Discovery: UDP broadcast QUERY
# ---------------------------------------------------------------------------

async def broadcast_scan(subnet_broadcast: str = "255.255.255.255", timeout: float = 2.0) -> list[str]:
    """
    Send QUERY\r as a UDP broadcast and collect ACK QUERY responses.
    Returns list of discovered IPs (also registers them automatically).
    Also probes the 192.168.x.y /24 subnets of each local interface.
    """
    found = []
    targets = {subnet_broadcast}

    # Add subnet-directed broadcasts for each non-loopback interface
    try:
        import netifaces  # optional -- graceful fallback if absent
        for iface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(iface).get(netifaces.AF_INET, [])
            for a in addrs:
                bcast = a.get("broadcast")
                if bcast and bcast != "127.255.255.255":
                    targets.add(bcast)
    except ImportError:
        pass  # netifaces not installed -- 255.255.255.255 covers most cases

    loop = asyncio.get_event_loop()

    def _scan_blocking() -> list[str]:
        results = []
        for target in targets:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.settimeout(timeout)
                s.sendto(b"QUERY\r", (target, CMD_PORT))
                log.info("Broadcast QUERY -> %s:%d", target, CMD_PORT)
                deadline = time.time() + timeout
                while time.time() < deadline:
                    try:
                        data, addr = s.recvfrom(65535)
                        src_ip = addr[0]
                        text   = data.decode(errors="replace").strip()
                        if text.startswith("ACK QUERY") and src_ip not in results:
                            results.append((src_ip, text))
                            log.info("Broadcast scan found: %s  %s", src_ip, text[:80])
                    except socket.timeout:
                        break
                s.close()
            except OSError as e:
                log.warning("Broadcast scan error (%s): %s", target, e)
        return results

    pairs = await loop.run_in_executor(None, _scan_blocking)

    for src_ip, resp_text in pairs:
        found.append(src_ip)
        fields = parse_query_response(resp_text)
        _register_device(src_ip, {
            "source":       "broadcast",
            "mac":          fields.get("MAC", ""),
            "mode":         fields.get("CM", ""),
            "query_resp":   resp_text,
        })
        asyncio.ensure_future(_query_and_update(src_ip))

    return found


# ---------------------------------------------------------------------------
# Full QUERY + VERSION + GETMAC for a known IP
# ---------------------------------------------------------------------------

async def _query_and_update(ip: str):
    """Run QUERY/VERSION/GETMAC against a known device IP and update registry."""
    try:
        query   = await cmd_proto.send_await(ip, "QUERY",   timeout=3.0)
        version = await cmd_proto.send_await(ip, "VERSION", timeout=2.0)
        mac     = await cmd_proto.send_await(ip, "GETMAC",  timeout=2.0)
    except TimeoutError:
        log.warning("_query_and_update: timeout for %s", ip)
        return

    fields = parse_query_response(query)
    existing = devices.get(ip, {})
    devices[ip] = {
        **existing,
        "ip":             ip,
        "mac":            fields.get("MAC", existing.get("mac", "")),
        "mode":           fields.get("CM",  existing.get("mode", "")),
        "firmware":       version.replace("ACK VERSION ", "").strip() if version else "",
        "query_resp":     query,
        "version_resp":   version,
        "mac_resp":       mac,
        "lbColor":        fields.get("LC", ""),
        "displayBright":  fields.get("DB", ""),
        "displayTimeout": fields.get("DT", ""),
        "lbBright":       fields.get("LBB", ""),
        "lbTimeout":      fields.get("LBT", ""),
        "destIp":         fields.get("QSYSIP", ""),
        "destPort":       fields.get("QSYSPORT", ""),
        "online":         True,
    }
    log.info("Updated device %s: fw=%s mac=%s mode=%s",
             ip, devices[ip]["firmware"], devices[ip]["mac"], devices[ip]["mode"])
    await _broadcast_all({"type": "device_updated", "device": devices[ip]})


# ---------------------------------------------------------------------------
# Blocking push (thread-pool, ported from push_cfg_v3.py)
# ---------------------------------------------------------------------------

def _blocking_push(device_ip: str, config: dict, progress_cb) -> dict:
    HOST      = device_ip
    CORE_IP   = config.get("destIp",   "10.0.0.1")
    CORE_PORT = int(config.get("destPort", 49500))
    COMP_IP   = config.get("selfIp",   "0.0.0.0")
    DEV_NAME  = config.get("devName",  "QSC")
    MIN_DB    = int(config.get("minDb",  -100))
    MAX_DB    = int(config.get("maxDb",  20))
    STEP      = int(config.get("step",   2))
    POLL_MS   = int(config.get("pollMs", 500))

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    sock.bind(("0.0.0.0", 0))
    jid = [1]

    def log_(msg):
        progress_cb(msg)

    def send_raw(cmd):
        sock.sendto(cmd.encode("latin-1"), (HOST, CMD_PORT))
        try:
            r, _ = sock.recvfrom(65535)
            return r.decode("latin-1", errors="replace").strip()
        except socket.timeout:
            return None

    def send_json(cmd, payload, fixed_jid=None):
        payload["jsonId"] = fixed_jid if fixed_jid is not None else jid[0]
        if fixed_jid is None:
            jid[0] += 1
        payload["version"] = "1.0.0"
        msg = cmd + json.dumps(payload, separators=(",", ":"))
        sock.sendto(msg.encode("latin-1"), (HOST, CMD_PORT))
        try:
            r, _ = sock.recvfrom(65535)
            rs = r.decode("latin-1", errors="replace").strip()
            ok = f"ACK MENU_JSON {payload['jsonId']}" in rs
            label = f"{cmd} id=0x{payload.get('id', payload.get('first', 0)):04x}"
            log_(f"  [{payload['jsonId']:3d}] {label} -> {'OK' if ok else 'FAIL: '+rs[:60]}")
            return ok
        except socket.timeout:
            log_(f"  [{payload['jsonId']:3d}] {cmd} -> TIMEOUT")
            return False

    try:
        # Phase 1
        log_("=== Phase 1: Handshake")
        r = send_raw("QUERY\r")
        if not r:
            return {"ok": False, "error": "No response to QUERY"}
        log_(f"  QUERY  -> {r}")
        log_(f"  SCM    -> {send_raw('SCM THIRD_PARTY\r')}")
        r = send_raw("GND\r")
        n = int(r.split()[-1]) if r else 0
        log_(f"  GND    -> {r} ({n} devices)")
        for i in range(n):
            log_(f"  GDI {i}  -> {(send_raw(f'GDI {i}\r') or 'None')[:80]}")
        time.sleep(0.05)

        # Phase 2
        log_("=== Phase 2: Menu discovery (GMIID + GMI)")
        r = send_raw("GMIID\r")
        log_(f"  GMIID  -> {(r or 'None')[:120]}")
        if not r or not r.startswith("ACK GMIID"):
            return {"ok": False, "error": f"GMIID failed: {r}"}
        parts    = r.split()
        all_ids  = [int(x, 16) for x in parts[3:]]
        log_(f"  -> {int(parts[2])} items: {parts[3:]}")
        time.sleep(0.05)

        def parse_gmi(r):
            pfx = "ACK GMI "
            if not r or not r.startswith(pfx):
                return None
            rest = r[len(pfx):]
            sp   = rest.index(" ")
            iid  = int(rest[:sp], 16)
            pay  = rest[sp+1:]
            if len(pay) < 6:
                return None
            itype = ord(pay[2]) if isinstance(pay[2], str) else pay[2]
            return {"id": iid, "type": itype, "name": pay[5:].split("\x00")[0].strip()}

        all_items = []
        for iid in all_ids:
            hs = f"0x{iid:04X}"
            parsed = parse_gmi(send_raw(f"GMI {hs}\r"))
            if parsed:
                all_items.append(parsed)
                tn = {0: "MENU", 2: "TRIGGER", 3: "LEVEL"}.get(parsed["type"], f"0x{parsed['type']:02x}")
                log_(f"  GMI {hs} -> {tn} '{parsed['name']}'")
            else:
                log_(f"  GMI {hs} -> FAILED")
            time.sleep(0.05)

        level_items   = [i for i in all_items if i["type"] == 3]
        trigger_items = [i for i in all_items if i["type"] == 2]
        log_(f"  Found: {len(level_items)} level, {len(trigger_items)} trigger")

        # Phase 3
        log_("=== Phase 3: Channel assignment + GLI M reads")
        root_lvl = sorted([i for i in level_items if i["id"] >= 0xfff0], key=lambda x: x["id"])
        sub_lvl  = sorted([i for i in level_items if i["id"] <  0xfff0], key=lambda x: x["id"])
        for idx, item in enumerate(root_lvl + sub_lvl):
            item["channel"] = idx + 1
            log_(f"  SV {item['channel']:2d}  0x{item['id']:04x}  '{item['name']}'")
        for item in level_items:
            send_raw(f"GLI 0x{item['id']:04x} M\r")
            time.sleep(0.05)

        # Phase 4
        log_("=== Phase 4: jsonId budget")
        submenu_cols = sorted(set((i["id"] & 0x0f) for i in all_items if i["id"] < 0xfff0))
        n_mi  = 1 + 1 + len(submenu_cols)
        n_ai  = math.ceil(len(trigger_items) / 4) if trigger_items else 0
        n_lvl = len(level_items)
        n_ci = n_cq = n_ca = n_lvl * 2
        total  = 1 + 1 + n_mi + n_ai + n_ci + n_cq + n_ca
        dl_jid = total
        mi_start = 2
        ai_start = mi_start + n_mi
        ci_start = ai_start + n_ai
        cq_start = ci_start + n_ci
        ca_start = cq_start + n_cq
        log_(f"  Total={total}  DL={dl_jid}  MI={n_mi}  AI={n_ai}  CI/CQ/CA={n_ci} each")

        # Phase 5
        log_("=== Phase 5: MT / DL / MI / AI")
        jid[0] = 1
        seen, uid_list = set(), []
        for iid in [i["id"] for i in all_items]:
            if iid not in seen:
                seen.add(iid)
                uid_list.append(iid)
        send_json("MT", {"ids": uid_list})

        send_json("DL", {"entries": [
            {"entry": {"async_ip": CORE_IP, "async_port": CORE_PORT,
                       "ctrl_ip": CORE_IP,  "ctrl_port": CORE_PORT,
                       "ctrl_proto": "udp",  "name": DEV_NAME, "type": "general"}},
            {"entry": {"async_ip": COMP_IP, "async_port": CMD_PORT,
                       "ctrl_ip": COMP_IP,  "ctrl_port": CMD_PORT,
                       "ctrl_proto": "udp",  "name": "Computer", "type": "general"}},
        ]}, fixed_jid=dl_jid)

        jid[0] = mi_start
        root_all = sorted([i for i in all_items if i["id"] >= 0xfff0], key=lambda x: x["id"])
        def etype(i):
            return "ctrl" if i["type"] == 3 else ("action" if i["type"] == 2 else "menu")
        rentries = [{"entry": {"id": i["id"], "txt": i["name"], "type": etype(i)}} for i in root_all]
        rids = [e["entry"]["id"] for e in rentries]
        send_json("MI", {"entries": rentries, "first": min(rids), "last": max(rids)})

        for col in submenu_cols:
            citems = sorted([i for i in all_items if (i["id"] & 0x0f) == col and i["id"] < 0xfff0], key=lambda x: x["id"])
            if not citems:
                continue
            entries = [{"entry": {"id": i["id"], "txt": i["name"], "type": etype(i)}} for i in citems]
            ids = [e["entry"]["id"] for e in entries]
            send_json("MI", {"entries": entries, "first": min(ids), "last": max(ids)})

        send_json("MI", {"entries": [{"entry": {"id": 0xffff, "txt": "MAIN MENU", "type": "menu"}}],
                         "first": 0xffff, "last": 0xffff})

        trig_ordered = sorted(trigger_items, key=lambda x: x["id"])
        for idx, t in enumerate(trig_ordered):
            t["trigger_num"] = idx + 1
        jid[0] = ai_start
        for bs in range(0, len(trig_ordered), 4):
            batch = trig_ordered[bs:bs+4]
            entries = [{"entry": {"action": {"bin": False,
                "bytes": [ord(c) for c in f"TR {i['trigger_num']}"] + [0x0d],
                "dev": DEV_NAME, "type": "3rd_party"}, "id": i["id"], "type": "action"}}
                for i in batch]
            ids = [e["entry"]["id"] for e in entries]
            send_json("AI", {"entries": entries, "first": min(ids), "last": max(ids)})

        # Phase 6
        log_("=== Phase 6: CI / CQ / CA")
        sub_o  = sorted([i for i in level_items if i["id"] < 0xfff0],  key=lambda x: x["id"], reverse=True)
        root_o = sorted([i for i in level_items if i["id"] >= 0xfff0], key=lambda x: x["id"], reverse=True)
        ordered = sub_o + root_o

        jid[0] = ci_start
        for item in ordered:
            ch = item["channel"]
            send_json("CI", {"ack": False, "ackMask": [], "active": [], "altActive": [], "altInactive": [],
                "altRespState": False, "async": False, "bin": False, "cmdMask": [],
                "ctrlType": "mute", "dev": DEV_NAME, "headerTxt": "", "id": item["id"],
                "inactive": [], "lvlPostStr": "", "lvlPreStr": "", "max": 0, "min": 0,
                "paramDecPt": 0, "query": False, "step": 0, "trim": False, "type": "stateless"})
            send_json("CI", {"ack": False, "ackMask": [], "active": [], "altActive": [], "altInactive": [],
                "altRespState": False, "async": True, "bin": False, "cmdMask": sv_set_mask(ch),
                "ctrlType": "vol", "dev": DEV_NAME, "headerTxt": "", "id": item["id"],
                "inactive": [], "lvlPostStr": "", "lvlPreStr": "", "max": MAX_DB, "min": MIN_DB,
                "paramDecPt": 0, "query": True, "step": STEP, "trim": False, "type": "explicit"})

        jid[0] = cq_start
        for item in ordered:
            ch = item["channel"]
            send_json("CQ", {"altRespState": False, "bin": False, "cmdMask": [],
                "ctrlType": "mute", "dev": DEV_NAME, "id": item["id"], "pollMsec": POLL_MS, "respMask": []})
            send_json("CQ", {"altRespState": False, "bin": False, "cmdMask": sv_query_mask(ch),
                "ctrlType": "vol", "dev": DEV_NAME, "id": item["id"],
                "pollMsec": POLL_MS, "respMask": sv_resp_mask(ch)})

        jid[0] = ca_start
        for item in ordered:
            ch = item["channel"]
            send_json("CA", {"altRespState": False, "bin": False, "ctrlType": "mute",
                "dev": DEV_NAME, "id": item["id"], "matchSrc": True, "msgMask": []})
            send_json("CA", {"altRespState": False, "bin": False, "ctrlType": "vol",
                "dev": DEV_NAME, "id": item["id"], "matchSrc": True, "msgMask": sv_resp_mask(ch)})

        # Phase 7
        log_("=== Phase 7: Batch result + commit")
        sock.settimeout(5)
        batch = None
        try:
            while True:
                data, _ = sock.recvfrom(65535)
                t = data.decode("latin-1", errors="replace").strip()
                if t.startswith("{") and '"json_ids"' in t:
                    batch = t
                    break
        except socket.timeout:
            pass

        if batch:
            log_(f"  Batch result: {batch[:120]}")
            try:
                obj = json.loads(batch)
                bad = [(j, rc) for j, rc in zip(obj["json_ids"], obj["result_ids"]) if rc != 0]
                log_(f"  {len(bad)} failed" if bad else f"  All {len(obj['json_ids'])} packets OK")
            except Exception:
                log_("  (Could not parse batch result)")
        else:
            log_("  WARNING: No batch result -- proceeding anyway")

        sock.settimeout(2)
        log_(f"  SCM    -> {send_raw('SCM THIRD_PARTY\r')}")
        h = uuid.uuid4().hex
        log_(f"  SMID   -> {send_raw(f'SMID {h}\r')}")
        log_(f"OK  Committed. Hash: {h}")
        return {"ok": True, "hash": h, "error": None}

    except Exception as exc:
        log.exception("Push failed")
        return {"ok": False, "error": str(exc), "hash": None}
    finally:
        sock.close()


# ---------------------------------------------------------------------------
# UDP protocols
# ---------------------------------------------------------------------------

class CmdProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.transport = None
        self._pending: dict[str, asyncio.Future] = {}

    def connection_made(self, transport):
        self.transport = transport
        log.info("CMD socket bound on :%d", CMD_PORT)

    def datagram_received(self, data: bytes, addr: tuple):
        ip, _ = addr
        text  = data.decode(errors="replace").rstrip("\r\n")
        log.debug("CMD <- [%s] %r", ip, text)
        if ip in devices:
            devices[ip]["last_cmd_response"] = text
        for key, fut in list(self._pending.items()):
            if key.startswith(ip) and not fut.done():
                fut.set_result(text)
                del self._pending[key]
                break
        asyncio.ensure_future(_broadcast_ws(ip, {"type": "cmd_response", "data": text}))

    def error_received(self, exc):
        log.error("CMD socket error: %s", exc)

    def send(self, ip: str, cmd: str):
        if not cmd.endswith("\r"):
            cmd += "\r"
        self.transport.sendto(cmd.encode(), (ip, CMD_PORT))

    async def send_await(self, ip: str, cmd: str, timeout: float = 2.0) -> str:
        loop = asyncio.get_event_loop()
        fut  = loop.create_future()
        key  = f"{ip}:{cmd.strip()}"
        self._pending[key] = fut
        self.send(ip, cmd)
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(key, None)
            raise TimeoutError(f"No response from {ip} for {cmd!r}")


class AsyncProtocol(asyncio.DatagramProtocol):
    def __init__(self, cmd_proto: CmdProtocol):
        self.transport  = None
        self.cmd_proto  = cmd_proto

    def connection_made(self, transport):
        self.transport = transport
        log.info("ASYNC socket bound on :%d", ASYNC_PORT)

    def datagram_received(self, data: bytes, addr: tuple):
        ip, _ = addr
        text  = data.decode(errors="replace").rstrip("\r\n")
        log.debug("ASYNC <- [%s] %r", ip, text)
        parts = text.split()
        if not parts:
            return
        pkt = parts[0]
        if pkt == "SV" and len(parts) >= 2:
            ch = int(parts[1])
            if len(parts) == 2:
                self._sv_poll(ip, ch)
            else:
                self._sv_value(ip, ch, int(parts[2]))
        elif pkt == "SM" and len(parts) == 3:
            self._sm(ip, int(parts[1]), bool(int(parts[2])))
        elif pkt == "TR" and len(parts) == 2:
            self._tr(ip, int(parts[1]))
        elif pkt in ("VERSION", "GETMAC"):
            asyncio.ensure_future(_broadcast_ws(ip, {"type": "connect_info", "data": text}))

    def _sv_poll(self, ip, ch):
        db = devices.get(ip, {}).get("sv_values", {}).get(ch, 0)
        self.transport.sendto(f"SV {ch} {db}\r".encode(), (ip, ASYNC_PORT))
        asyncio.ensure_future(_broadcast_ws(ip, {"type": "sv_poll", "channel": ch, "db": db}))

    def _sv_value(self, ip, ch, db):
        devices.setdefault(ip, {}).setdefault("sv_values", {})[ch] = db
        asyncio.ensure_future(_broadcast_ws(ip, {"type": "sv_change", "channel": ch, "db": db}))

    def _sm(self, ip, ch, muted):
        devices.setdefault(ip, {}).setdefault("sm_values", {})[ch] = muted
        asyncio.ensure_future(_broadcast_ws(ip, {"type": "sm_change", "channel": ch, "muted": muted}))

    def _tr(self, ip, trigger):
        asyncio.ensure_future(_broadcast_ws(ip, {"type": "trigger_fire", "trigger": trigger, "timestamp": time.time()}))

    def error_received(self, exc):
        log.error("ASYNC socket error: %s", exc)


async def _broadcast_ws(ip: str, payload: dict):
    dead = set()
    for ws in ws_clients.get(ip, set()):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    ws_clients[ip] -= dead


cmd_proto:   CmdProtocol   = None
async_proto: AsyncProtocol = None


# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------

async def api_device_add(req: web.Request) -> web.Response:
    body = await req.json()
    ip   = body.get("ip", "").strip()
    if not ip:
        return web.json_response({"error": "ip required"}, status=400)
    _register_device(ip, {"source": "manual"})
    asyncio.ensure_future(_query_and_update(ip))
    return web.json_response({"status": "added", "ip": ip})


async def api_list_devices(req: web.Request) -> web.Response:
    return web.json_response(list(devices.values()))


async def api_scan(req: web.Request) -> web.Response:
    """POST /api/scan  -- trigger a broadcast QUERY scan, return found IPs."""
    found = await broadcast_scan()
    return web.json_response({"found": found, "total": len(found)})


async def api_discover(req: web.Request) -> web.Response:
    """GET /api/device/{ip}/discover"""
    ip = req.match_info["ip"]
    try:
        await _query_and_update(ip)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=504)
    return web.json_response(devices.get(ip, {}))


async def api_send_command(req: web.Request) -> web.Response:
    ip   = req.match_info["ip"]
    body = await req.json()
    cmd  = body.get("cmd", "").strip()
    if not cmd:
        return web.json_response({"error": "cmd required"}, status=400)
    try:
        resp = await cmd_proto.send_await(ip, cmd)
        return web.json_response({"response": resp})
    except TimeoutError as e:
        return web.json_response({"error": str(e)}, status=504)


async def api_set_sv(req: web.Request) -> web.Response:
    ip   = req.match_info["ip"]
    body = await req.json()
    ch   = int(body["channel"])
    db   = int(body["db"])
    devices.setdefault(ip, {}).setdefault("sv_values", {})[ch] = db
    async_proto.transport.sendto(f"SV {ch} {db}\r".encode(), (ip, ASYNC_PORT))
    return web.json_response({"status": "sent", "channel": ch, "db": db})


async def api_push(req: web.Request) -> web.Response:
    """POST /api/device/{ip}/push  -- streaming NDJSON push progress."""
    ip   = req.match_info["ip"]
    body = await req.json()

    response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
    await response.prepare(req)

    loop = asyncio.get_event_loop()

    def progress(msg: str):
        asyncio.run_coroutine_threadsafe(
            response.write((json.dumps({"log": msg}) + "\n").encode()), loop)
        asyncio.run_coroutine_threadsafe(
            _broadcast_all({"type": "push_log", "device_ip": ip, "msg": msg}), loop)

    result = await loop.run_in_executor(None, _blocking_push, ip, body, progress)
    if result["ok"]:
        devices.setdefault(ip, {})["configHash"] = result["hash"]

    await response.write((json.dumps({"result": result}) + "\n").encode())
    await response.write_eof()
    return response


async def ws_handler(req: web.Request) -> web.WebSocketResponse:
    ip = req.match_info["ip"]
    ws = web.WebSocketResponse()
    await ws.prepare(req)
    ws_clients[ip].add(ws)
    # Send current device list immediately on connect
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
                        async_proto.transport.sendto(f"SV {ch} {db}\r".encode(), (ip, ASYNC_PORT))
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
    # Send current snapshot immediately
    await ws.send_json({"type": "device_list", "devices": list(devices.values())})
    try:
        async for msg in ws:
            if msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        ws_clients["_discovery"].discard(ws)
    return ws


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get ("/api/devices",              api_list_devices)
    app.router.add_post("/api/device",               api_device_add)
    app.router.add_post("/api/scan",                 api_scan)
    app.router.add_get ("/api/device/{ip}/discover", api_discover)
    app.router.add_post("/api/device/{ip}/cmd",      api_send_command)
    app.router.add_post("/api/device/{ip}/sv",       api_set_sv)
    app.router.add_post("/api/device/{ip}/push",     api_push)
    app.router.add_get ("/ws/_discovery",            ws_discovery_handler)
    app.router.add_get ("/ws/{ip}",                  ws_handler)
    if STATIC_DIR.exists():
        app.router.add_static("/", path=str(STATIC_DIR), show_index=True)
    else:
        log.warning("frontend/dist not found -- run npm run build in frontend/")
    return app


async def main():
    global cmd_proto, async_proto

    loop = asyncio.get_event_loop()

    _, cmd_proto = await loop.create_datagram_endpoint(
        CmdProtocol, local_addr=("0.0.0.0", CMD_PORT))

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", ASYNC_PORT))
    _, async_proto = await loop.create_datagram_endpoint(
        lambda: AsyncProtocol(cmd_proto), sock=sock)

    app    = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8080).start()

    log.info("http://0.0.0.0:8080  |  CMD :%d  |  ASYNC :%d", CMD_PORT, ASYNC_PORT)

    # Start mDNS discovery in background
    await start_mdns_discovery()

    # Initial broadcast scan (non-blocking, runs in thread)
    asyncio.ensure_future(broadcast_scan())

    try:
        await asyncio.Event().wait()
    finally:
        await stop_mdns_discovery()


if __name__ == "__main__":
    asyncio.run(main())

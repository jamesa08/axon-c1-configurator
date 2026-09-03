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
        # Run full sync on discovery
        asyncio.ensure_future(_auto_sync(ip))


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
        asyncio.ensure_future(_auto_sync(src_ip))

    return found


# ---------------------------------------------------------------------------
# Full QUERY + VERSION + GETMAC for a known IP
# ---------------------------------------------------------------------------

async def _auto_sync(ip: str):
    """Run full sync on discovery; broadcasts device_synced with live config."""
    loop = asyncio.get_event_loop()

    def progress(msg: str):
        asyncio.run_coroutine_threadsafe(
            _broadcast_all({"type": "sync_log", "device_ip": ip, "msg": msg}), loop)

    result = await loop.run_in_executor(None, _blocking_sync, ip, progress)
    if result["ok"] and result.get("config"):
        cfg        = result["config"]
        sv_to_slot = cfg.pop("svToSlot", {})
        slot_to_sv = cfg.pop("slotToSV", {})
        devices.setdefault(ip, {}).update({
            "sv_to_slot": {int(k): v for k, v in sv_to_slot.items()},
            "slot_to_sv": {int(k): v for k, v in slot_to_sv.items()},
            "online": True, "synced": True,
            "firmware": cfg.get("firmwareVersion", ""),
            "mac":      cfg.get("mac", ""),
            "mode":     cfg.get("mode", ""),
        })
        await _broadcast_all({
            "type":      "device_synced",
            "device_ip": ip,
            "config":    cfg,
            "summary":   result.get("summary", {}),
        })
        log.info("Auto-sync complete for %s: %s", ip, result.get("summary"))
    else:
        log.warning("Auto-sync failed for %s: %s", ip, result.get("error"))
        await _query_and_update(ip)


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
# Blocking sync (thread-pool) -- ported from qplug SyncState machine
#
# Phases match the Lua plugin exactly:
#   1. QUERY  -- get current device settings
#   2. GMIID  -- get all item IDs in one shot
#   3. GMI loop -- get name + type for each ID
#   4. GLI loop -- get SV channel assignment per level item
#   5. SyncAssignLabels -- build display order, svToSlot/slotToSV maps
#
# Returns a dict shaped to match the frontend mkDefaultConfig() structure
# so the UI can replace its static config with live device state.
# ---------------------------------------------------------------------------

def _blocking_sync(device_ip: str, progress_cb) -> dict:
    """
    Full config read from device.  Runs in a thread pool.
    Returns {"ok": bool, "config": dict, "error": str|None}
    where "config" matches the shape expected by the React frontend.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    sock.bind(("0.0.0.0", 0))

    def log_(msg: str):
        progress_cb(msg)

    def send_raw(cmd: str, timeout: float = 2.0) -> str | None:
        sock.settimeout(timeout)
        sock.sendto(cmd.encode("latin-1"), (device_ip, CMD_PORT))
        try:
            r, _ = sock.recvfrom(65535)
            return r.decode("latin-1", errors="replace").strip()
        except socket.timeout:
            return None

    try:
        # ── Phase 1: QUERY for current device settings ──────────────────────
        log_("=== Sync Phase 1: QUERY")
        r = send_raw("QUERY\r")
        if not r:
            return {"ok": False, "error": "No response to QUERY", "config": None}
        log_(f"  {r[:120]}")
        fields   = parse_query_response(r)
        ver_r    = send_raw("VERSION\r") or ""
        mac_r    = send_raw("GETMAC\r")  or ""
        model_r  = send_raw("MODEL\r")   or ""

        firmware = ver_r.replace("ACK VERSION ", "").strip()
        mac_raw  = fields.get("MAC", mac_r.replace("ACK GETMAC ", "").strip())

        # Parse MAC into human-readable form
        mac_clean = mac_raw.replace("0x", "").replace("0X", "")
        if len(mac_clean) == 12:
            mac_str = ":".join(mac_clean[i:i+2] for i in range(0, 12, 2)).upper()
        else:
            mac_str = mac_raw

        # Parse lightbar color (LC field: R:G:B or named color)
        lc_raw = fields.get("LC", "OFF")
        lb_color = "#ffffff"
        lb_on    = True
        if lc_raw == "OFF":
            lb_on = False
        else:
            parts = lc_raw.split(":")
            if len(parts) == 3:
                try:
                    r_v, g_v, b_v = int(parts[0]), int(parts[1]), int(parts[2])
                    lb_color = f"#{r_v:02x}{g_v:02x}{b_v:02x}"
                except ValueError:
                    pass
            # Named colors
            named = {"RED":"#ff0000","GREEN":"#00ff00","BLUE":"#0000ff",
                     "YELLOW":"#ffff00","WHITE":"#ffffff","ORANGE":"#ff8800"}
            if lc_raw.upper() in named:
                lb_color = named[lc_raw.upper()]

        device_settings = {
            "mac":             mac_str,
            "firmwareVersion": firmware,
            "mode":            fields.get("CM", "THIRD_PARTY"),
            "ip":              device_ip,
            "displayBrightness": int(fields.get("DB",  7)),
            "displayTimeout":    int(fields.get("DT",  60)),
            "lbBrightness":      int(fields.get("LBB", 7)),
            "lbTimeout":         int(fields.get("LBT", 60)),
            "lbColor":           lb_color,
            "lbOn":              lb_on,
            "lbColorMode":       int(fields.get("LCMS", 0)),
            "pinEnabled":        fields.get("LPM", "0") == "1",
            "pin":               fields.get("LP",  "0000"),
            "destIp":            fields.get("QSYSIP",   ""),
            "destPort":          int(fields.get("QSYSPORT", 49500)),
        }
        log_(f"  fw={firmware} mac={mac_str} mode={device_settings['mode']}")

        # ── Phase 2: SCM THIRD_PARTY + GMIID ────────────────────────────────
        log_("=== Sync Phase 2: GMIID")
        send_raw("SCM THIRD_PARTY\r")

        r = send_raw("GMIID\r")
        if not r or not r.startswith("ACK GMIID"):
            return {"ok": False, "error": f"GMIID failed: {r}", "config": None}

        parts   = r.split()
        count   = int(parts[2]) if len(parts) > 2 else 0
        all_ids = [int(x, 16) for x in parts[3:3+count]]
        log_(f"  {count} items: {[hex(x) for x in all_ids]}")

        # ── Phase 3: GMI loop ────────────────────────────────────────────────
        log_("=== Sync Phase 3: GMI loop")
        all_items = []  # {id, type, name}

        def parse_gmi(resp):
            pfx = "ACK GMI "
            if not resp or not resp.startswith(pfx):
                return None
            rest = resp[len(pfx):]
            try:
                sp   = rest.index(" ")
            except ValueError:
                return None
            iid  = int(rest[:sp], 16)
            pay  = rest[sp+1:]
            if len(pay) < 6:
                return None
            itype = ord(pay[2]) if isinstance(pay[2], str) else pay[2]
            name  = pay[5:].split("\x00")[0].split("\r")[0].split("\n")[0].strip()
            return {"id": iid, "type": itype, "name": name}

        import time as _time
        for iid in all_ids:
            hs     = f"0x{iid:04X}"
            resp   = send_raw(f"GMI {hs}\r")
            parsed = parse_gmi(resp)
            if parsed:
                all_items.append(parsed)
                tn = {0: "MENU", 2: "TRIGGER", 3: "LEVEL"}.get(parsed["type"], f"0x{parsed['type']:02x}")
                log_(f"  GMI {hs} -> {tn} '{parsed['name']}'")
            else:
                log_(f"  GMI {hs} -> FAILED ({resp or 'timeout'})")
            _time.sleep(0.05)

        level_items   = [i for i in all_items if i["type"] == 3]
        trigger_items = [i for i in all_items if i["type"] == 2]
        menu_items    = [i for i in all_items if i["type"] == 0]
        log_(f"  Found: {len(level_items)} level, {len(trigger_items)} trigger, {len(menu_items)} menu")

        # ── Phase 4: GLI loop -- get actual SV channel per level item ────────
        log_("=== Sync Phase 4: GLI loop")
        for item in level_items:
            hs   = f"0x{item['id']:04x}"
            resp = send_raw(f"GLI {hs} V\r", timeout=3.0)
            if resp and "ACK GLI" in resp:
                idx = resp.find("SV ")
                if idx != -1:
                    after = resp[idx+3:]
                    digits = ""
                    for c in after:
                        if c.isdigit():
                            digits += c
                        else:
                            break
                    if digits:
                        item["svChannel"] = int(digits)
                        log_(f"  GLI {hs} -> SV {item['svChannel']}  '{item['name']}'")
                        continue
            # Fallback: no GLI data, will be assigned sequentially
            log_(f"  GLI {hs} -> no SV found (will assign sequential)")
            _time.sleep(0.05)

        # GLI M reads (keeps device state clean, per RE doc)
        for item in level_items:
            send_raw(f"GLI 0x{item['id']:04x} M\r")
            _time.sleep(0.03)

        # ── Phase 5: SyncAssignLabels -- build display order + channel maps ──
        log_("=== Sync Phase 5: Assign labels + build menu tree")

        # Build col -> parent menu name map (matches Lua SyncAssignLabels)
        col_to_menu = {}
        for item in all_items:
            if item["id"] >= 0xfff0 and item["type"] == 0:  # root menu container
                col_to_menu[item["id"] % 16] = item["name"]

        def item_label(item):
            if item["id"] == 0xfffe:
                return "Vol/Mute Screen"
            if item["id"] < 0xfff0:
                menu_name = col_to_menu.get(item["id"] % 16)
                return f"{menu_name} / {item['name']}" if menu_name else item["name"]
            return item["name"]

        # Sort into display order (matches Lua plugin exactly)
        vm_screen   = next((i for i in level_items if i["id"] == 0xfffe), None)
        root_levels = sorted([i for i in level_items if i["id"] >= 0xfff0 and i["id"] != 0xfffe], key=lambda x: x["id"])
        sub_levels  = sorted([i for i in level_items if i["id"] < 0xfff0],
                             key=lambda x: (x["id"] % 16, x["id"]))

        # Assign SV channels sequentially to items without GLI data
        seq_ch = 1
        ordered_for_ch = ([vm_screen] if vm_screen else []) + root_levels + sub_levels
        for item in ordered_for_ch:
            if "svChannel" not in item:
                item["svChannel"] = seq_ch
            seq_ch = max(seq_ch, item["svChannel"]) + 1

        # svToSlot / slotToSV (for the frontend sim and SV poll replies)
        sv_to_slot = {}
        slot_to_sv = {}
        display_order = ([vm_screen] if vm_screen else []) + root_levels + sub_levels
        for slot, item in enumerate(display_order, 1):
            if "svChannel" in item:
                sv_to_slot[item["svChannel"]] = slot
                slot_to_sv[slot]              = item["svChannel"]

        log_(f"  svToSlot: {sv_to_slot}")

        # Sort triggers: col then row (matches Lua)
        trigger_items_sorted = sorted(trigger_items,
                                      key=lambda x: (x["id"] % 16, x["id"]))

        # ── Build frontend-shaped menu tree ───────────────────────────────────
        # The frontend tree is: volMuteScreen (special) + mainMenu (tree)
        # mainMenu has submenus matching what the device actually has.
        # We reconstruct from the discovered items.

        def make_level_entry(item, slot):
            ch = item.get("svChannel", slot)
            return {
                "id":           f"dev_{item['id']:04x}",
                "entry_type":   "level",
                "display_txt":  item["name"],
                "binary":       False,
                "level_vol": {
                    "channel":      ch,
                    "setBytes":     _sv_set_bytes(ch),
                    "queryBytes":   _sv_query_bytes(ch),
                    "respQueryBytes": _sv_set_bytes(ch),
                    "syncBytes":    _sv_set_bytes(ch),
                    "minParam":   -100,
                    "maxParam":    20,
                    "stepSize":     2,
                    "paramDecPts":  0,
                    "trimEnable":   False,
                    "pollMs":       500,
                    "queryEnable":  True,
                    "asyncEnable":  True,
                    "ackEnable":    False,
                    "headerText":   "",
                    "lvlPreStr":    "",
                    "lvlPostStr":   "",
                    "setter_type":  1,
                    "set_dev_name": "QSC",
                    "footerEnable": 1,
                    "active": [], "altActive": [], "altInactive": [], "inactive": [],
                    "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
                },
                "level_mute": {
                    "setBytes": [], "queryBytes": [], "respQueryBytes": [], "syncBytes": [],
                    "minParam": 0, "maxParam": 0, "stepSize": 0, "paramDecPts": 0,
                    "trimEnable": False, "pollMs": 500,
                    "queryEnable": False, "asyncEnable": False,
                    "ackEnable": False, "headerText": "", "lvlPreStr": "", "lvlPostStr": "",
                    "setter_type": 0, "set_dev_name": "QSC", "footerEnable": 0,
                    "active": [], "altActive": [], "altInactive": [], "inactive": [],
                    "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
                },
            }

        def make_trigger_entry(item, trigger_num):
            tr_bytes = [ord(c) for c in f"TR {trigger_num}"] + [0x0d]
            return {
                "id":           f"dev_{item['id']:04x}",
                "entry_type":   "action",
                "display_txt":  item["name"],
                "binary":       False,
                "action_type":  "3rd_party",
                "bytes":        tr_bytes,
                "dev":          "QSC",
                "cr":           True,
                "lf":           False,
                "triggerNum":   trigger_num,
            }

        def make_menu_entry(name, entries):
            return {
                "id":          f"dev_menu_{name.replace(' ','_')}",
                "entry_type":  "menu",
                "display_txt": name,
                "entries":     entries,
            }

        # Build vol/mute screen entry
        vol_mute_entry = None
        if vm_screen:
            vol_mute_entry = make_level_entry(vm_screen, 1)
            vol_mute_entry["_isRoot"] = True
        else:
            # Fallback placeholder
            vol_mute_entry = {
                "id": "dev_fffe", "entry_type": "level", "display_txt": "Vol/Mute Screen",
                "binary": False, "_isRoot": True,
                "level_vol": {"channel": 1, "minParam": -100, "maxParam": 20,
                              "stepSize": 2, "pollMs": 500, "queryEnable": True,
                              "asyncEnable": True, "setter_type": 1, "set_dev_name": "QSC",
                              "setBytes": _sv_set_bytes(1), "queryBytes": _sv_query_bytes(1),
                              "respQueryBytes": _sv_set_bytes(1), "syncBytes": _sv_set_bytes(1),
                              "paramDecPts": 0, "trimEnable": False, "ackEnable": False,
                              "headerText": "", "lvlPreStr": "", "lvlPostStr": "",
                              "footerEnable": 1, "active": [], "altActive": [], "altInactive": [],
                              "inactive": [], "asyncAltResponse": False,
                              "queryAltResponse": False, "setAltResponse": False},
                "level_mute": {"setBytes": [], "queryBytes": [], "respQueryBytes": [],
                               "syncBytes": [], "minParam": 0, "maxParam": 0, "stepSize": 0,
                               "paramDecPts": 0, "trimEnable": False, "pollMs": 500,
                               "queryEnable": False, "asyncEnable": False, "ackEnable": False,
                               "headerText": "", "lvlPreStr": "", "lvlPostStr": "",
                               "setter_type": 0, "set_dev_name": "QSC", "footerEnable": 0,
                               "active": [], "altActive": [], "altInactive": [], "inactive": [],
                               "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False},
            }

        # Group submenu items by column (col = id & 0x0f)
        col_items = {}
        for item in sub_levels:
            col = item["id"] & 0x0f
            col_items.setdefault(col, []).append(item)

        # Build submenu groups -- use the root menu container name if we have it
        submenus = []
        for col in sorted(col_items.keys()):
            menu_name = col_to_menu.get(col, f"Menu {col}")
            slot_start = len(([vm_screen] if vm_screen else []) + root_levels) + 1
            entries = []
            for item in col_items[col]:
                slot = display_order.index(item) + 1 if item in display_order else slot_start
                entries.append(make_level_entry(item, slot))
            submenus.append(make_menu_entry(menu_name, entries))

        # Add triggers as a submenu group (or inline if no submenus)
        trigger_entries = []
        for n, item in enumerate(trigger_items_sorted, 1):
            trigger_entries.append(make_trigger_entry(item, n))

        if trigger_entries:
            # Find the trigger container name from menu items
            trig_menu_name = "TRIGGERS"
            # Trigger items are col=4 typically; find matching root menu container
            if trigger_items_sorted:
                trig_col = trigger_items_sorted[0]["id"] & 0x0f
                trig_menu_name = col_to_menu.get(trig_col, "TRIGGERS")
            submenus.append(make_menu_entry(trig_menu_name, trigger_entries))

        # Root-level items (direct on main menu, not in submenus)
        root_entries = []
        for slot, item in enumerate(root_levels, (2 if vm_screen else 1)):
            root_entries.append(make_level_entry(item, slot))

        # MAIN MENU: root level items + submenus
        main_menu = make_menu_entry("MAIN MENU", root_entries + submenus)

        # Assemble final config
        result_config = {
            **device_settings,
            "volMuteEnabled": vm_screen is not None,
            "menuEnabled":    bool(root_levels or sub_levels or trigger_items),
            "volMuteScreen":  vol_mute_entry,
            "mainMenu":       main_menu,
            "svToSlot":       sv_to_slot,
            "slotToSV":       slot_to_sv,
            # Preserve device list from existing config (devices are 3rd-party targets)
            "deviceName": f"AxonC1-{mac_clean[-6:]}",
            # simVol/simMutes stay at defaults
            "simVol": 0, "simMutes": {}, "simChannelVols": {},
            "simScreen": "menu", "simFaderEntry": None,
        }

        log_(f"  Built: {len(display_order)} levels, {len(trigger_items_sorted)} triggers")
        log_("OK  Sync complete")
        return {"ok": True, "config": result_config, "error": None,
                "summary": {
                    "levels":   len(display_order),
                    "triggers": len(trigger_items_sorted),
                    "mac":      mac_str,
                    "firmware": firmware,
                }}

    except Exception as exc:
        log.exception("Sync failed")
        return {"ok": False, "error": str(exc), "config": None}
    finally:
        sock.close()


def _sv_set_bytes(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0xe3, 0x0d]

def _sv_query_bytes(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0x0d]


# ---------------------------------------------------------------------------
# Blocking push -- drives entirely from the frontend config tree
# ---------------------------------------------------------------------------

def _walk_config_tree(frontend_cfg: dict) -> tuple[list, list, list]:
    """
    Walk the frontend config tree and return:
      level_items: [{display_txt, channel, level_vol, level_mute}]
      trigger_items: [{display_txt, bytes, dev}]
      menu_structure: [{name, children: [item_or_submenu]}]  (for MI building)
    """
    level_items   = []
    trigger_items = []

    def walk(node):
        et = node.get("entry_type", "")
        if et == "level":
            level_items.append(node)
        elif et == "action":
            trigger_items.append(node)
        elif et in ("menu", "main_menu"):
            for child in node.get("entries", []):
                walk(child)

    vm = frontend_cfg.get("volMuteScreen")
    if vm:
        walk(vm)
    walk(frontend_cfg.get("mainMenu", {}))
    return level_items, trigger_items


def _blocking_push(device_ip: str, config: dict, progress_cb) -> dict:
    """
    Push the frontend config to the device.
    config must contain the full frontend config dict (mainMenu, volMuteScreen,
    devices, destIp, destPort, etc.)  plus optional overrides.
    """
    # ── Pull parameters from the frontend config ───────────────────────────
    frontend_cfg = config.get("frontendConfig") or config

    # Destination: prefer explicit destIp/destPort, fall back to devices[0]
    devs      = frontend_cfg.get("devices", [])
    CORE_IP   = frontend_cfg.get("destIp") or (devs[0]["ip"]   if devs else "10.0.0.1")
    CORE_PORT = int(frontend_cfg.get("destPort") or (devs[0].get("port", 49500) if devs else 49500))
    DEV_NAME  = (devs[0]["name"] if devs else "QSC")
    COMP_IP   = config.get("selfIp", "0.0.0.0")

    HOST = device_ip

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    sock.bind(("0.0.0.0", 0))
    jid = [1]

    def log_(msg: str):
        progress_cb(msg)

    def send_raw(cmd: str) -> str | None:
        sock.sendto(cmd.encode("latin-1"), (HOST, CMD_PORT))
        log_(f"  >>> SEND RAW {repr(cmd)}")
        try:
            r, _ = sock.recvfrom(65535)
            result = r.decode("latin-1", errors="replace").strip()
            log_(f"  <<< RECV RAW {repr(result)}")
            return result
        except socket.timeout:
            log_(f"  <<< RECV RAW TIMEOUT")
            return None

    def send_json(cmd: str, payload: dict, fixed_jid: int | None = None) -> bool:
        payload["jsonId"] = fixed_jid if fixed_jid is not None else jid[0]
        if fixed_jid is None:
            jid[0] += 1
        payload["version"] = "1.0.0"
        msg = cmd + json.dumps(payload, separators=(",", ":"))
        raw_bytes = msg.encode("latin-1")
        sock.sendto(raw_bytes, (HOST, CMD_PORT))
        log_(f"  >>> SEND {cmd} jid={payload['jsonId']} raw={msg}")
        try:
            r, _ = sock.recvfrom(65535)
            rs = r.decode("latin-1", errors="replace").strip()
            log_(f"  <<< RECV {rs}")
            ok = f"ACK MENU_JSON {payload['jsonId']}" in rs
            label = f"{cmd} id=0x{payload.get('id', payload.get('first', 0)):04x}"
            log_(f"  [{payload['jsonId']:3d}] {label} -> {'OK' if ok else 'FAIL: '+rs[:60]}")
            return ok
        except socket.timeout:
            log_(f"  [{payload['jsonId']:3d}] {cmd} -> TIMEOUT")
            return False

    try:
        # ── Phase 1: Handshake ────────────────────────────────────────────
        log_("> QUERY\r")
        log_("=== Phase 1: Handshake")
        r = send_raw("QUERY\r")
        if not r:
            return {"ok": False, "error": "No response to QUERY"}
        log_(f"  QUERY -> {r}")
        log_(f"  SCM   -> {send_raw('SCM THIRD_PARTY\r')}")
        r = send_raw("GND\r")
        n = int(r.split()[-1]) if r else 0
        log_(f"  GND   -> {r} ({n} devices)")
        for i in range(n):
            log_(f"  GDI {i} -> {(send_raw(f'GDI {i}\r') or 'None')[:80]}")
        import time as _time
        _time.sleep(0.05)

        # ── Phase 2: Walk the frontend config tree ────────────────────────
        log_("=== Phase 2: Building item list from UI config")
        level_items, trigger_items = _walk_config_tree(frontend_cfg)
        log_(f"  Levels: {len(level_items)}  Triggers: {len(trigger_items)}")

        if not level_items and not trigger_items:
            log_("  WARNING: Config has no levels or triggers -- will push empty menu")

        # ── Phase 3: Assign device IDs to each item ───────────────────────
        log_("=== Phase 3: Assigning device IDs")
        # ID scheme:
        #   0xFFFE = vol/mute screen
        #   0xFFF0..0xFFFE = submenu containers (one per col, col = id & 0x0f)
        #   0xFF{row}{col} = items within submenus
        # We walk the mainMenu tree to assign IDs preserving the column grouping.

        def assign_ids(frontend_cfg: dict, level_items_flat: list, trigger_items_flat: list):
            vm   = frontend_cfg.get("volMuteScreen")
            main = frontend_cfg.get("mainMenu", {})

            all_items = []
            if vm:
                all_items.append({"id": 0xfffe, "name": vm.get("display_txt","Vol/Mute"), "type": 3, "orig": vm})
            mm_label_ = frontend_cfg.get("mainMenu", {}).get("display_txt", "MAIN MENU")
            all_items.append({"id": 0xffff, "name": mm_label_, "type": 0, "orig": None})

            sv_auto  = [2]
            next_col = [0]
            # mi_groups: ordered list of (container_id, [direct child items])
            # Built during recursion; drives MI emission in Phase 5.
            mi_groups = []

            def walk(entries, col_ctx):
                """Walk entries, assign IDs, return list of all_item dicts for this level."""
                result = []
                for entry in entries:
                    et = entry.get("entry_type", "")
                    if et == "menu":
                        col = next_col[0]
                        next_col[0] += 1
                        container_id = 0xfff0 + col
                        item = {"id": container_id, "name": entry.get("display_txt","Menu"), "type": 0, "orig": entry}
                        all_items.append(item)
                        # Recurse: children of this container get their own col context
                        children = walk(entry.get("entries", []), col)
                        mi_groups.append((container_id, children))
                        result.append(item)
                    elif et == "level":
                        col = col_ctx if col_ctx is not None else 0
                        row = sum(1 for i in all_items if i["id"] < 0xfff0 and (i["id"] & 0x0f) == col)
                        item_id = (row << 4) | col | 0xff00
                        lv = entry.get("level_vol", {})
                        if not lv.get("channel") or lv.get("channel") == 1:
                            lv["channel"] = sv_auto[0]
                            entry["level_vol"] = lv
                        sv_auto[0] = max(sv_auto[0], lv["channel"]) + 1
                        item = {"id": item_id, "name": entry.get("display_txt",""), "type": 3, "orig": entry}
                        all_items.append(item)
                        entry["_push_id"] = item_id
                        result.append(item)
                    elif et == "action":
                        col = col_ctx if col_ctx is not None else 0
                        row = sum(1 for i in all_items if i["id"] < 0xfff0 and (i["id"] & 0x0f) == col)
                        item_id = (row << 4) | col | 0xff00
                        item = {"id": item_id, "name": entry.get("display_txt",""), "type": 2, "orig": entry}
                        all_items.append(item)
                        entry["_push_id"] = item_id
                        result.append(item)
                return result

            top_level_items = walk(main.get("entries", []), None)
            return all_items, mi_groups, top_level_items

        all_items, mi_groups, top_level_items = assign_ids(frontend_cfg, level_items, trigger_items)

        # Re-extract with IDs assigned
        vm_item       = next((i for i in all_items if i["id"] == 0xfffe), None)
        level_with_id = [i for i in all_items if i["type"] == 3]
        trig_with_id  = [i for i in all_items if i["type"] == 2]

        for item in level_with_id:
            sv_ch = item["orig"].get("level_vol", {}).get("channel", 1) if item["orig"] else 1
            log_(f"  SV {sv_ch:2d}  0x{item['id']:04x}  '{item['name']}'")
        for idx, item in enumerate(trig_with_id, 1):
            item["trigger_num"] = idx
            log_(f"  TR {idx:2d}  0x{item['id']:04x}  '{item['name']}'")

        # ── Phase 4: jsonId budget ────────────────────────────────────────
        log_("=== Phase 4: jsonId budget")
        col_to_container = {}
        for i in all_items:
            if i["id"] >= 0xfff0 and i["id"] not in (0xffff, 0xfffe) and i["type"] == 0:
                col_to_container[i["id"] & 0x0f] = i

        has_vm        = vm_item is not None
        n_containers  = len(col_to_container)
        # MI budget: count groups recursively
        def count_groups(items):
            if not items: return 0
            c = 1
            for item in items:
                if item["type"] == 0:
                    for cid, ch in mi_groups:
                        if cid == item["id"]:
                            c += count_groups(ch)
                            break
            return c
        n_mi = max(1, 1 + count_groups(top_level_items))
        n_ai          = math.ceil(len(trig_with_id) / 4) if trig_with_id else 0
        n_lvl         = len(level_with_id)
        n_ci = n_cq = n_ca = n_lvl * 2
        total         = 1 + 1 + n_mi + n_ai + n_ci + n_cq + n_ca
        dl_jid        = total
        mi_start      = 2
        ai_start      = mi_start + n_mi
        ci_start      = ai_start + n_ai
        cq_start      = ci_start + n_ci
        ca_start      = cq_start + n_cq
        log_(f"  Total={total}  DL={dl_jid}  MI={n_mi}  AI={n_ai}  CI/CQ/CA={n_ci} each")

        # ── Phase 5: MT / DL / MI / AI ───────────────────────────────────
        log_("=== Phase 5: MT / DL / MI / AI")
        jid[0] = 1

        # MT: all item IDs
        seen, uid_list = set(), []
        for i in all_items:
            if i["id"] not in seen:
                seen.add(i["id"])
                uid_list.append(i["id"])
        send_json("MT", {"ids": uid_list})

        # DL: device list
        dl_entries = []
        for d in devs:
            dl_entries.append({"entry": {
                "async_ip":   d.get("asyncIp", d.get("ip", CORE_IP)),
                "async_port": int(d.get("asyncPort", d.get("port", CORE_PORT))),
                "ctrl_ip":    d.get("ip", CORE_IP),
                "ctrl_port":  int(d.get("port", CORE_PORT)),
                "ctrl_proto": "udp", "name": d["name"], "type": "general",
            }})
        if not dl_entries:
            dl_entries = [
                {"entry": {"async_ip": CORE_IP, "async_port": CORE_PORT,
                           "ctrl_ip":  CORE_IP, "ctrl_port":  CORE_PORT,
                           "ctrl_proto": "udp", "name": DEV_NAME, "type": "general"}},
                {"entry": {"async_ip": COMP_IP, "async_port": CMD_PORT,
                           "ctrl_ip":  COMP_IP, "ctrl_port":  CMD_PORT,
                           "ctrl_proto": "udp", "name": "Computer", "type": "general"}},
            ]
        send_json("DL", {"entries": dl_entries}, fixed_jid=dl_jid)

        # MI packets
        jid[0] = mi_start
        mm_label = frontend_cfg.get("mainMenu", {}).get("display_txt", "MAIN MENU")

        def etype_str(i):
            return "ctrl" if i["type"] == 3 else ("action" if i["type"] == 2 else "menu")

        # MI structure from pcap of working unIFY push (frame order matters, jid controls device processing):
        #
        # Send order (by frame/time):
        #   1st sent: MAIN MENU children (jid=miStart+1) -- root levels ctrl first, then containers menu
        #   2nd..Nth: col packets in REVERSE col order (highest col first)
        #   LAST sent: [0xFFFE ctrl, 0xFFFF menu] (jid=miStart) -- sent last despite lowest jid
        #
        # Device processes by jid so logical order is:
        #   jid=miStart:   [vol/mute, MAIN MENU]
        #   jid=miStart+1: MAIN MENU children
        #   jid=miStart+2..N: col children

        # MI sequencing rule: each type=menu entry in group N spawns group N+1.
        # We BFS-emit groups: root first, then each menu entry's children in order.
        #
        # jid=miStart:   [0xFFFE ctrl, 0xFFFF menu]  -- 0xFFFF spawns jid=miStart+1
        # jid=miStart+1: top_level_items (MAIN MENU children)
        # jid=miStart+2..N: children of each menu in BFS order

        g1_entries = []
        if vm_item:
            g1_entries.append({"entry": {"id": 0xfffe, "txt": vm_item["name"], "type": "ctrl"}})
        g1_entries.append({"entry": {"id": 0xffff, "txt": mm_label, "type": "menu"}})
        g1_ids = [e["entry"]["id"] for e in g1_entries]
        send_json("MI", {"entries": g1_entries, "first": min(g1_ids), "last": max(g1_ids)},
                  fixed_jid=mi_start)

        jid[0] = mi_start + 1
        # BFS queue: each element is a list of items to emit as one MI group
        bfs_queue = [top_level_items]
        while bfs_queue:
            group = bfs_queue.pop(0)
            if not group:
                continue
            entries = [{"entry": {"id": i["id"], "txt": i["name"], "type": etype_str(i)}}
                       for i in group]
            ids = [i["id"] for i in group]
            send_json("MI", {"entries": entries, "first": min(ids), "last": max(ids)})
            # Queue children of each menu item in this group, in order
            for item in group:
                if item["type"] == 0:
                    for container_id, children in mi_groups:
                        if container_id == item["id"] and children:
                            bfs_queue.append(children)
                            break

        # AI: trigger actions
        jid[0] = ai_start
        for bs in range(0, len(trig_with_id), 4):
            batch = trig_with_id[bs:bs+4]
            entries = []
            for item in batch:
                orig = item["orig"] or {}
                raw_bytes = orig.get("bytes") or ([ord(c) for c in f"TR {item['trigger_num']}"] + [0x0d])
                dev = orig.get("dev", DEV_NAME)
                entries.append({"entry": {"action": {
                    "bin": orig.get("binary", False),
                    "bytes": raw_bytes, "dev": dev, "type": "3rd_party",
                }, "id": item["id"], "type": "action"}})
            if entries:
                ids = [e["entry"]["id"] for e in entries]
                send_json("AI", {"entries": entries, "first": min(ids), "last": max(ids)})

        # ── Phase 6: CI / CQ / CA ─────────────────────────────────────────
        log_("=== Phase 6: CI / CQ / CA")
        sub_o  = sorted([i for i in level_with_id if i["id"] < 0xfff0],  key=lambda x: x["id"], reverse=True)
        root_o = sorted([i for i in level_with_id if i["id"] >= 0xfff0], key=lambda x: x["id"], reverse=True)
        ordered = sub_o + root_o

        jid[0] = ci_start
        for item in ordered:
            orig    = item["orig"] or {}
            vol     = orig.get("level_vol",  {})
            mute    = orig.get("level_mute", {})
            sv_ch   = int(vol.get("channel", 1))
            MIN_DB  = int(vol.get("minParam", -100))
            MAX_DB  = int(vol.get("maxParam",  20))
            STEP    = int(vol.get("stepSize",   2))
            POLL_MS = int(vol.get("pollMs",   500))
            dev     = vol.get("set_dev_name", DEV_NAME)
            # Always derive correct byte masks from the SV channel
            # Use stored bytes if present, otherwise generate from channel number
            set_bytes  = vol.get("setBytes")  or _sv_set_bytes(sv_ch)
            qry_bytes  = vol.get("queryBytes") or _sv_query_bytes(sv_ch)
            resp_bytes = vol.get("respQueryBytes") or _sv_set_bytes(sv_ch)
            send_json("CI", {"ack": False, "ackMask": [], "active": [], "altActive": [], "altInactive": [],
                "altRespState": False, "async": False, "bin": False, "cmdMask": [],
                "ctrlType": "mute", "dev": dev, "headerTxt": "", "id": item["id"],
                "inactive": [], "lvlPostStr": "", "lvlPreStr": "", "max": 0, "min": 0,
                "paramDecPt": 0, "query": False, "step": 0, "trim": False, "type": "stateless"})
            send_json("CI", {"ack": False, "ackMask": [], "active": [], "altActive": [], "altInactive": [],
                "altRespState": False, "async": True, "bin": orig.get("binary", False),
                "cmdMask": set_bytes,
                "ctrlType": "vol", "dev": dev, "headerTxt": vol.get("headerText", ""),
                "id": item["id"], "inactive": [], "lvlPostStr": vol.get("lvlPostStr", ""),
                "lvlPreStr": vol.get("lvlPreStr", ""), "max": MAX_DB, "min": MIN_DB,
                "paramDecPt": int(vol.get("paramDecPts", 0)), "query": vol.get("queryEnable", True),
                "step": STEP, "trim": vol.get("trimEnable", False), "type": "explicit"})

        jid[0] = cq_start
        for item in ordered:
            orig    = item["orig"] or {}
            vol     = orig.get("level_vol",  {})
            sv_ch   = int(vol.get("channel", 1))
            dev     = vol.get("set_dev_name", DEV_NAME)
            POLL_MS = int(vol.get("pollMs", 500))
            set_bytes  = vol.get("setBytes")  or _sv_set_bytes(sv_ch)
            qry_bytes  = vol.get("queryBytes") or _sv_query_bytes(sv_ch)
            resp_bytes = vol.get("respQueryBytes") or _sv_set_bytes(sv_ch)
            send_json("CQ", {"altRespState": False, "bin": False, "cmdMask": [],
                "ctrlType": "mute", "dev": dev, "id": item["id"],
                "pollMsec": POLL_MS, "respMask": []})
            send_json("CQ", {"altRespState": False, "bin": False,
                "cmdMask":  qry_bytes,
                "ctrlType": "vol", "dev": dev, "id": item["id"],
                "pollMsec": POLL_MS,
                "respMask": resp_bytes})

        jid[0] = ca_start
        for item in ordered:
            orig    = item["orig"] or {}
            vol     = orig.get("level_vol", {})
            sv_ch   = int(vol.get("channel", 1))
            dev     = vol.get("set_dev_name", DEV_NAME)
            resp_bytes = vol.get("respQueryBytes") or _sv_set_bytes(sv_ch)
            send_json("CA", {"altRespState": False, "bin": False, "ctrlType": "mute",
                "dev": dev, "id": item["id"], "matchSrc": True, "msgMask": []})
            send_json("CA", {"altRespState": False, "bin": False, "ctrlType": "vol",
                "dev": dev, "id": item["id"], "matchSrc": True,
                "msgMask": resp_bytes})

        # ── Phase 7: SF 1 (finalize) + batch result + commit ────────────
        log_("=== Phase 7: SF finalize + batch result + commit")

        # SF 1: signals device that push sequence is complete
        # Device will not send batch result until SF is received
        log_(f"  SF     -> {send_raw('SF 1\r')}")

        # Batch result arrives ~5 seconds after SF
        sock.settimeout(8)
        batch = None
        try:
            while True:
                data, _ = sock.recvfrom(65535)
                t = data.decode("latin-1", errors="replace").strip()
                if t.startswith("{") and '"json_ids"' in t:
                    batch = t
                    break
                # If batch result arrives as response to something else, catch it
                if '"result_ids"' in t:
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
        log_(f"  SCM   -> {send_raw('SCM THIRD_PARTY\r')}")
        h = uuid.uuid4().hex
        log_(f"  SMID  -> {send_raw(f'SMID {h}\r')}")
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
# .cfg file read / write  (XML + HTML-escaped JSON, file version 1.2)
# ---------------------------------------------------------------------------
import xml.etree.ElementTree as ET
import html
import re as _re

FILE_VER     = "1.2"
PRODUCT_NAME = "AxonC1"
MENU_VER     = "1.2.0"


def _bytes_to_sv_channel(byte_list: list[int]) -> int | None:
    """
    Decode SV channel from a queryBytes / setBytes list.
    Format: [83, 86, 32, <digits...>, 32, ...]  = "SV <N> ..."
    """
    try:
        s = bytes(byte_list).decode("latin-1")
        m = _re.match(r"SV (\d+)", s)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def _lc_to_hex(lc_str: str) -> str:
    """Convert 'R:G:B' or named color or 'OFF' to '#rrggbb' or '#ffffff'."""
    if not lc_str or lc_str == "OFF":
        return "#ffffff"
    named = {"RED": "#ff0000", "GREEN": "#00ff00", "BLUE": "#0000ff",
             "YELLOW": "#ffff00", "WHITE": "#ffffff", "ORANGE": "#ff8800"}
    if lc_str.upper() in named:
        return named[lc_str.upper()]
    parts = lc_str.split(":")
    if len(parts) == 3:
        try:
            return f"#{int(parts[0]):02x}{int(parts[1]):02x}{int(parts[2]):02x}"
        except ValueError:
            pass
    return "#ffffff"


def _hex_to_lc(hex_color: str) -> str:
    """Convert '#rrggbb' to 'R:G:B' string for the device."""
    h = hex_color.lstrip("#")
    if len(h) == 6:
        return f"{int(h[0:2],16)}:{int(h[2:4],16)}:{int(h[4:6],16)}"
    return "0:0:0"


def cfg_to_frontend(xml_bytes: bytes) -> dict:
    """
    Parse a .cfg file and return a frontend-shaped config dict.
    """
    root = ET.fromstring(xml_bytes)
    data = root.find("SNAPSHOT_DATA")
    if data is None:
        raise ValueError("Missing SNAPSHOT_DATA element")

    def text(tag, default=""):
        el = data.find(tag)
        return el.text.strip() if el is not None and el.text else default

    # ── Device-level settings ─────────────────────────────────────────────
    lc_raw = text("LC", "OFF")
    cfg = {
        "mode":              text("CM", "THIRD_PARTY"),
        "displayBrightness": int(text("DB", "7")),
        "displayTimeout":    int(text("DT", "60")),
        "lbBrightness":      int(text("LBB", "7")),
        "lbTimeout":         int(text("LBT", "10")),
        "lbColor":           _lc_to_hex(lc_raw),
        "lbOn":              lc_raw != "OFF",
        "pinEnabled":        text("LPM", "0") == "1",
        "pin":               text("LP", "0000"),
        "displayLock":       text("DL", "0") == "1",
    }

    # ── MENU_CONFIG JSON ─────────────────────────────────────────────────
    mc_el = data.find("MENU_CONFIG")
    if mc_el is None or not mc_el.text:
        return cfg

    mc_json = html.unescape(mc_el.text.strip())
    try:
        mc = json.loads(mc_json)
    except json.JSONDecodeError as e:
        raise ValueError(f"MENU_CONFIG JSON parse error: {e}")

    # ── dev_list -> devices[] ─────────────────────────────────────────────
    dev_entries = mc.get("dev_list", {}).get("entries", [])
    devices = []
    for i, d in enumerate(dev_entries):
        devices.append({
            "id":        f"cfg_dev_{i}",
            "name":      d.get("name", f"Device{i}"),
            "ip":        d.get("ip", ""),
            "port":      int(d.get("port", 49500)),
            "asyncIp":   d.get("async_ip", d.get("ip", "")),
            "asyncPort": int(d.get("async_port", d.get("port", 49500))),
            "proto":     "UDP",
            "type":      "general",
        })
    cfg["devices"] = devices
    if devices:
        cfg["destIp"]   = devices[0]["ip"]
        cfg["destPort"] = devices[0]["port"]

    # ── menu.control -> volMuteScreen + mainMenu tree ─────────────────────
    controls = mc.get("menu", {}).get("control", [])

    # Split: first two entries are vol + mute for the vol/mute screen (0xFFFE),
    # then the main_menu entry is the tree
    vol_mute_vol  = None
    vol_mute_mute = None
    main_menu_raw = None

    for ctrl in controls:
        if ctrl.get("entry_type") == "level" and ctrl.get("path", "").count(">") == 1:
            # Root-level level entry = vol/mute screen
            if "level_vol" in ctrl:
                vol_mute_vol  = ctrl
            elif "level_mute" in ctrl:
                vol_mute_mute = ctrl
        elif ctrl.get("entry_type") == "main_menu":
            main_menu_raw = ctrl

    uid_counter = [0]
    def uid():
        uid_counter[0] += 1
        return f"cfg_{uid_counter[0]:04d}"

    def parse_level(name: str, vol_ctrl: dict | None, mute_ctrl: dict | None) -> dict:
        vol  = vol_ctrl.get("level_vol",  {}) if vol_ctrl  else {}
        mute = mute_ctrl.get("level_mute", {}) if mute_ctrl else {}
        ch = _bytes_to_sv_channel(vol.get("setBytes", [])) or 1
        return {
            "id":          uid(),
            "entry_type":  "level",
            "display_txt": name,
            "binary":      False,
            "level_vol": {
                "channel":          ch,
                "setBytes":         vol.get("setBytes", []),
                "queryBytes":       vol.get("queryBytes", []),
                "respQueryBytes":   vol.get("respQueryBytes", vol.get("respBytes", [])),
                "syncBytes":        vol.get("syncBytes", []),
                "minParam":         vol.get("minParam", -100),
                "maxParam":         vol.get("maxParam", 20),
                "stepSize":         vol.get("stepSize", 2),
                "paramDecPts":      vol.get("paramDecPts", 0),
                "trimEnable":       vol.get("trimEnable", False),
                "pollMs":           vol.get("pollMs", 500),
                "queryEnable":      vol.get("queryEnable", True),
                "asyncEnable":      vol.get("asyncEnable", True),
                "ackEnable":        vol.get("ackEnable", False),
                "headerText":       vol.get("headerText", ""),
                "lvlPreStr":        vol.get("levelPreStr", ""),
                "lvlPostStr":       vol.get("levelPostStr", ""),
                "setter_type":      vol.get("setter_type", 1),
                "set_dev_name":     vol.get("set_dev_name", devices[0]["name"] if devices else "QSC"),
                "footerEnable":     vol.get("footerEnable", 1),
                "active": [], "altActive": [], "altInactive": [], "inactive": [],
                "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
            },
            "level_mute": {
                "setBytes":         mute.get("setBytes", []),
                "queryBytes":       mute.get("queryBytes", []),
                "respQueryBytes":   mute.get("respQueryBytes", []),
                "syncBytes":        mute.get("syncBytes", []),
                "minParam":         mute.get("minParam", 0),
                "maxParam":         mute.get("maxParam", 0),
                "stepSize":         mute.get("stepSize", 0),
                "paramDecPts":      mute.get("paramDecPts", 0),
                "trimEnable":       mute.get("trimEnable", False),
                "pollMs":           mute.get("pollMs", 500),
                "queryEnable":      mute.get("queryEnable", False),
                "asyncEnable":      mute.get("asyncEnable", False),
                "ackEnable":        mute.get("ackEnable", False),
                "headerText":       mute.get("headerText", ""),
                "lvlPreStr":        mute.get("levelPreStr", ""),
                "lvlPostStr":       mute.get("levelPostStr", ""),
                "setter_type":      mute.get("setter_type", 0),
                "set_dev_name":     mute.get("set_dev_name", devices[0]["name"] if devices else "QSC"),
                "footerEnable":     mute.get("footerEnable", 0),
                "active": [], "altActive": [], "altInactive": [], "inactive": [],
                "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
            },
        }

    def parse_action(raw: dict) -> dict:
        return {
            "id":          uid(),
            "entry_type":  "action",
            "display_txt": raw.get("display_txt", "Action"),
            "binary":      raw.get("binary", False),
            "action_type": raw.get("action_type", "3rd_party"),
            "bytes":       raw.get("bytes", []),
            "dev":         raw.get("dev", devices[0]["name"] if devices else "QSC"),
            "cr":          True, "lf": False,
        }

    def parse_menu_entries(raw_entries: list) -> list:
        """Recursively parse menu entries from .cfg control list."""
        out = []
        i = 0
        while i < len(raw_entries):
            entry = raw_entries[i]
            etype = entry.get("entry_type", "")
            if etype == "menu":
                children = parse_menu_entries(entry.get("entries", []))
                out.append({
                    "id":          uid(),
                    "entry_type":  "menu",
                    "display_txt": entry.get("display_txt", "Menu"),
                    "entries":     children,
                })
                i += 1
            elif etype == "level":
                # Levels come in pairs (vol + mute) with the same display_txt
                next_entry = raw_entries[i+1] if i+1 < len(raw_entries) else None
                vol_e  = entry      if "level_vol"  in entry      else None
                mute_e = next_entry if next_entry and "level_mute" in next_entry else None
                if mute_e is None:
                    vol_e = None
                    mute_e = entry if "level_mute" in entry else None
                name = entry.get("display_txt", "Level")
                out.append(parse_level(name, vol_e, mute_e))
                i += 2 if mute_e else 1
            elif etype == "action":
                out.append(parse_action(entry))
                i += 1
            else:
                i += 1
        return out

    # Vol/mute screen
    vol_mute_entry = None
    if vol_mute_vol or vol_mute_mute:
        name = (vol_mute_vol or vol_mute_mute).get("display_txt", "Vol/Mute Screen")
        vol_mute_entry = parse_level(name, vol_mute_vol, vol_mute_mute)
        vol_mute_entry["_isRoot"] = True

    # Main menu tree
    main_menu = {"id": uid(), "entry_type": "menu", "display_txt": "MAIN MENU", "entries": []}
    if main_menu_raw:
        main_menu["entries"] = parse_menu_entries(main_menu_raw.get("entries", []))

    cfg["volMuteScreen"] = vol_mute_entry
    cfg["mainMenu"]      = main_menu
    cfg["volMuteEnabled"] = vol_mute_entry is not None
    cfg["menuEnabled"]    = bool(main_menu["entries"])

    return cfg


def frontend_to_cfg(cfg: dict, firmware_ver: str = "V1.5.0") -> bytes:
    """
    Serialize a frontend config dict to .cfg XML bytes.
    """
    # ── Build MENU_CONFIG JSON ─────────────────────────────────────────────
    devs = cfg.get("devices", [])
    dev_entries = []
    for d in devs:
        dev_entries.append({
            "async_ip":   d.get("asyncIp", d.get("ip", "")),
            "async_port": str(d.get("asyncPort", d.get("port", 49500))),
            "ip":         d.get("ip", ""),
            "name":       d.get("name", "QSC"),
            "port":       str(d.get("port", 49500)),
            "proto":      1,
            "type":       0,
        })

    dev_name = devs[0]["name"] if devs else "QSC"

    def level_to_ctrl(entry: dict, path_prefix: str) -> list[dict]:
        """Return a [vol_ctrl, mute_ctrl] pair for a level entry."""
        name = entry.get("display_txt", "Level")
        path = path_prefix + ">" + name
        vol  = entry.get("level_vol",  {})
        mute = entry.get("level_mute", {})
        vol_ctrl = {
            "binary":      entry.get("binary", False),
            "display_txt": name,
            "entry_type":  "level",
            "hasDefVol":   True,
            "level_vol": {
                "ackEnable":       vol.get("ackEnable", False),
                "active":          vol.get("active", []),
                "altActive":       vol.get("altActive", []),
                "altInactive":     vol.get("altInactive", []),
                "asyncAltResponse": vol.get("asyncAltResponse", False),
                "asyncEnable":     vol.get("asyncEnable", True),
                "footerEnable":    vol.get("footerEnable", 1),
                "headerText":      vol.get("headerText", ""),
                "inactive":        vol.get("inactive", []),
                "levelPostStr":    vol.get("lvlPostStr", ""),
                "levelPreStr":     vol.get("lvlPreStr", ""),
                "maxParam":        vol.get("maxParam", 20),
                "minParam":        vol.get("minParam", -100),
                "paramDecPts":     vol.get("paramDecPts", 0),
                "pollMs":          vol.get("pollMs", 500),
                "queryAltResponse": vol.get("queryAltResponse", False),
                "queryBytes":      vol.get("queryBytes", []),
                "queryEnable":     vol.get("queryEnable", True),
                "respBytes":       [],
                "respQueryBytes":  vol.get("respQueryBytes", []),
                "setAltResponse":  vol.get("setAltResponse", False),
                "setBytes":        vol.get("setBytes", []),
                "set_dev_name":    vol.get("set_dev_name", dev_name),
                "setter_type":     vol.get("setter_type", 1),
                "stepSize":        vol.get("stepSize", 2),
                "syncBytes":       vol.get("syncBytes", []),
                "trimEnable":      vol.get("trimEnable", False),
            },
            "path": path,
        }
        mute_ctrl = {
            "binary":      entry.get("binary", False),
            "display_txt": name,
            "entry_type":  "level",
            "hasDefVol":   True,
            "level_mute": {
                "ackEnable":       mute.get("ackEnable", False),
                "active":          mute.get("active", []),
                "altActive":       mute.get("altActive", []),
                "altInactive":     mute.get("altInactive", []),
                "asyncAltResponse": mute.get("asyncAltResponse", False),
                "asyncEnable":     mute.get("asyncEnable", False),
                "footerEnable":    mute.get("footerEnable", 0),
                "headerText":      mute.get("headerText", ""),
                "inactive":        mute.get("inactive", []),
                "levelPostStr":    mute.get("lvlPostStr", ""),
                "levelPreStr":     mute.get("lvlPreStr", ""),
                "maxParam":        mute.get("maxParam", 0),
                "minParam":        mute.get("minParam", 0),
                "paramDecPts":     mute.get("paramDecPts", 0),
                "pollMs":          mute.get("pollMs", 500),
                "queryAltResponse": mute.get("queryAltResponse", False),
                "queryBytes":      mute.get("queryBytes", []),
                "queryEnable":     mute.get("queryEnable", False),
                "respBytes":       [],
                "respQueryBytes":  mute.get("respQueryBytes", []),
                "setAltResponse":  mute.get("setAltResponse", False),
                "setBytes":        mute.get("setBytes", []),
                "set_dev_name":    mute.get("set_dev_name", dev_name),
                "setter_type":     mute.get("setter_type", 0),
                "stepSize":        mute.get("stepSize", 0),
                "syncBytes":       mute.get("syncBytes", []),
                "trimEnable":      mute.get("trimEnable", False),
            },
            "path": path,
        }
        return [vol_ctrl, mute_ctrl]

    def menu_entry_to_ctrl(entry: dict, path_prefix: str) -> list[dict]:
        etype = entry.get("entry_type", "")
        name  = entry.get("display_txt", "")
        path  = path_prefix + ">" + name
        if etype == "level":
            return level_to_ctrl(entry, path_prefix)
        elif etype == "action":
            return [{
                "action_type": entry.get("action_type", "3rd_party"),
                "binary":      entry.get("binary", False),
                "bytes":       entry.get("bytes", []),
                "dev":         entry.get("dev", dev_name),
                "display_txt": name,
                "entry_type":  "action",
                "path":        path,
            }]
        elif etype == "menu":
            return []  # menus appear inline in the tree, not in flat control list
        return []

    def build_menu_tree(entry: dict, path_prefix: str) -> dict:
        name  = entry.get("display_txt", "")
        path  = path_prefix + ">" + name
        etype = entry.get("entry_type", "")
        if etype == "menu":
            children_raw = entry.get("entries", [])
            children = [build_menu_tree(c, path) for c in children_raw]
            # Filter out None
            children = [c for c in children if c]
            return {"display_txt": name, "entries": children, "entry_type": "menu", "path": path}
        elif etype == "level":
            # In the tree, levels don't carry vol/mute detail (that's in the control list)
            # but the .cfg format DOES embed them in the entries array
            vol  = entry.get("level_vol",  {})
            mute = entry.get("level_mute", {})
            result_entries = []
            for ctrl_pair in [{"level_vol": vol}, {"level_mute": mute}]:
                key = "level_vol" if "level_vol" in ctrl_pair else "level_mute"
                d = {
                    "binary": False, "display_txt": name,
                    "entry_type": "level", key: ctrl_pair[key],
                    "path": path,
                }
                if key == "level_vol":
                    d["hasDefVol"] = True
                result_entries.append(d)
            return result_entries  # returns a list, caller must flatten
        elif etype == "action":
            return {
                "action_type": entry.get("action_type", "3rd_party"),
                "binary":      entry.get("binary", False),
                "bytes":       entry.get("bytes", []),
                "dev":         entry.get("dev", dev_name),
                "display_txt": name, "entry_type": "action", "path": path,
            }
        return None

    def flatten_menu_children(entries: list, path_prefix: str) -> list:
        result = []
        for entry in entries:
            built = build_menu_tree(entry, path_prefix)
            if isinstance(built, list):
                result.extend(built)
            elif built:
                result.append(built)
        return result

    def build_submenu_tree(menu_entry: dict, path_prefix: str) -> dict:
        name     = menu_entry.get("display_txt", "")
        path     = path_prefix + ">" + name
        children = []
        for child in menu_entry.get("entries", []):
            built = build_menu_tree(child, path)
            if isinstance(built, list):
                children.extend(built)
            elif built:
                children.append(built)
        return {"display_txt": name, "entries": children, "entry_type": "menu", "path": path}

    # Build flat control list
    controls = []

    # Vol/mute screen (root level entries)
    vm = cfg.get("volMuteScreen")
    if vm:
        vm_path = ""
        controls.extend(level_to_ctrl(vm, vm_path))

    # Main menu tree
    main_menu = cfg.get("mainMenu", {})
    main_path = ""
    main_menu_entries = []
    for child in main_menu.get("entries", []):
        built = build_submenu_tree(child, ">MAIN MENU")
        main_menu_entries.append(built)

    controls.append({
        "display_txt": "MAIN MENU",
        "entries":     main_menu_entries,
        "entry_type":  "main_menu",
        "hasMainMenu": True,
        "path":        ">MAIN MENU",
    })

    mc = {
        "dev_list": {"entries": dev_entries},
        "menu":     {"control": controls, "version": MENU_VER},
        "qsc_mode": 1,
    }

    mc_json = json.dumps(mc, indent=4)
    mc_escaped = html.escape(mc_json)

    # ── Build XML ─────────────────────────────────────────────────────────
    lc_str = _hex_to_lc(cfg.get("lbColor", "#ffffff")) if cfg.get("lbOn", True) else "OFF"

    xml_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<SNAPSHOT_FILE>',
        '    <SNAPSHOT_INFO>',
        f'        <FILE_VER>{FILE_VER}</FILE_VER>',
        '        <PRODUCT_ID>NA</PRODUCT_ID>',
        f'        <PRODUCT_NAME>{PRODUCT_NAME}</PRODUCT_NAME>',
        f'        <PRODUCT_MCU_VER>{firmware_ver}</PRODUCT_MCU_VER>',
        '    </SNAPSHOT_INFO>',
        '    <SNAPSHOT_DATA>',
        f'        <CM>{cfg.get("mode","THIRD_PARTY")}</CM>',
        f'        <DB>{cfg.get("displayBrightness", 7)}</DB>',
        f'        <DL>{"1" if cfg.get("displayLock") else "0"}</DL>',
        f'        <DT>{cfg.get("displayTimeout", 60)}</DT>',
        '        <GDR>false</GDR>',
        f'        <LBB>{cfg.get("lbBrightness", 5)}</LBB>',
        f'        <LBT>{cfg.get("lbTimeout", 10)}</LBT>',
        f'        <LC>{lc_str}</LC>',
        f'        <LP>{cfg.get("pin","0000")}</LP>',
        f'        <LPM>{"1" if cfg.get("pinEnabled") else "0"}</LPM>',
        f'        <MENU_CONFIG>{mc_escaped}</MENU_CONFIG>',
        '    </SNAPSHOT_DATA>',
        '</SNAPSHOT_FILE>',
    ]
    return "\n".join(xml_lines).encode("utf-8")


# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------

async def api_interfaces(req: web.Request) -> web.Response:
    """GET /api/interfaces -- list available network interfaces with IPv4 addresses."""
    import subprocess, platform
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
        # Fallback: use socket to find default outbound IP
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
            _broadcast_all({"type": "sync_log", "device_ip": ip, "msg": msg}), loop)

    result = await loop.run_in_executor(None, _blocking_sync, ip, progress)

    if result["ok"] and result.get("config"):
        cfg        = result["config"]
        sv_to_slot = cfg.pop("svToSlot", {})
        slot_to_sv = cfg.pop("slotToSV", {})
        devices.setdefault(ip, {}).update({
            "sv_to_slot": {int(k): v for k, v in sv_to_slot.items()},
            "slot_to_sv": {int(k): v for k, v in slot_to_sv.items()},
            "synced": True,
        })
        await _broadcast_all({
            "type":      "device_synced",
            "device_ip": ip,
            "config":    cfg,
            "summary":   result.get("summary", {}),
        })

    await response.write((json.dumps({"result": result}) + "\n").encode())
    await response.write_eof()
    return response


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


async def api_cfg_export(req: web.Request) -> web.Response:
    """GET /api/device/{ip}/cfg  -- download current config as .cfg file."""
    ip  = req.match_info["ip"]
    dev = devices.get(ip, {})
    # Merge device registry info into a minimal config if no full cfg is stored
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
    # Allow caller to pass full frontend config in body
    if body.get("config"):
        cfg = body["config"]
        devices.setdefault(ip, {})["frontend_config"] = cfg
    fw  = dev.get("firmware", "V1.5.0")
    if not fw.startswith("V"):
        fw = f"V{fw}"
    try:
        xml_bytes = frontend_to_cfg(cfg, firmware_ver=fw)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    name = cfg.get("deviceName") or dev.get("name") or f"AxonC1-{ip.replace('.','_')}"
    return web.Response(
        body=xml_bytes,
        content_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{name}.cfg"'},
    )


async def api_cfg_import(req: web.Request) -> web.Response:
    """POST /api/cfg/import  -- upload a .cfg file, returns frontend config."""
    try:
        data = await req.read()
        cfg  = cfg_to_frontend(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True, "config": cfg})


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
    app.router.add_get ("/api/interfaces",             api_interfaces)
    app.router.add_post("/api/device",               api_device_add)
    app.router.add_post("/api/scan",                 api_scan)
    app.router.add_get ("/api/device/{ip}/discover", api_discover)
    app.router.add_post("/api/device/{ip}/sync",      api_sync)
    app.router.add_post("/api/device/{ip}/cmd",      api_send_command)
    app.router.add_post("/api/device/{ip}/sv",       api_set_sv)
    app.router.add_post("/api/device/{ip}/push",     api_push)
    app.router.add_get ("/api/device/{ip}/cfg",       api_cfg_export)
    app.router.add_post("/api/device/{ip}/cfg",       api_cfg_export)
    app.router.add_post("/api/cfg/import",            api_cfg_import)
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

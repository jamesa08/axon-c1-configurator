"""
axon/sync.py -- blocking full-device config read (runs in a thread pool).

Phases match the Lua plugin exactly:
  1. QUERY  -- get current device settings
  2. GMIID  -- get all item IDs in one shot
  3. GMI loop -- get name + type for each ID
  4. GLI loop -- get SV channel assignment per level item
  5. SyncAssignLabels -- build display order, svToSlot/slotToSV maps

Returns a dict shaped to match the frontend mkDefaultConfig() structure
so the UI can replace its static config with live device state.
"""

import socket
import time
import uuid

from .config import CMD_PORT, log
from .discovery import parse_query_response


# ---------------------------------------------------------------------------
# Byte-mask builders for SV (QSC volume/mute) control protocol.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Blocking sync
# ---------------------------------------------------------------------------

def blocking_sync(device_ip: str, progress_cb, device_name: str | None = None) -> dict:
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

    def send_raw(cmd: str, timeout: float = 2.0) -> bytes | None:
        """Send a command and return the raw response bytes (no decoding)."""
        sock.settimeout(timeout)
        sock.sendto(cmd.encode("latin-1"), (device_ip, CMD_PORT))
        try:
            r, _ = sock.recvfrom(65535)
            return r.rstrip(b"\r\n")
        except socket.timeout:
            return None

    def send_raw_text(cmd: str, timeout: float = 2.0) -> str | None:
        """Send a command and return the response as a decoded string (for ASCII-only responses)."""
        raw = send_raw(cmd, timeout)
        if raw is None:
            return None
        return raw.decode("latin-1", errors="replace").strip()

    try:
        # Phase 1: QUERY for current device settings
        log_(f"=== Query device settings (mdns_name={device_name!r})")
        r = send_raw_text("QUERY\r")
        if not r:
            return {"ok": False, "error": "No response to QUERY", "config": None}
        log_(f"  {r[:120]}")
        fields   = parse_query_response(r)
        ver_r    = send_raw_text("VERSION\r") or ""
        mac_r    = send_raw_text("GETMAC\r")  or ""
        send_raw_text("MODEL\r")   # consume but not used

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
            named = {"RED": "#ff0000", "GREEN": "#00ff00", "BLUE": "#0000ff",
                     "YELLOW": "#ffff00", "WHITE": "#ffffff", "ORANGE": "#ff8800"}
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

        # Phase 2: SCM THIRD_PARTY + GMIID
        log_("=== Reading item IDs (GMIID)")
        send_raw_text("SCM THIRD_PARTY\r")

        r = send_raw_text("GMIID\r")
        if not r or not r.startswith("ACK GMIID"):
            return {"ok": False, "error": f"GMIID failed: {r}", "config": None}

        parts   = r.split()
        count   = int(parts[2]) if len(parts) > 2 else 0
        all_ids = [int(x, 16) for x in parts[3:3+count]]
        log_(f"  {count} items: {[hex(x) for x in all_ids]}")

        # Phase 3: GMI loop
        log_("=== Reading item details (GMI)")
        all_items = []  # {id, type, name}

        def parse_gmi(resp_bytes: bytes):
            # resp_bytes is the raw UDP payload.
            # Format: b"ACK GMI 0xXXXX <binary-payload>\r"
            # Binary payload layout (confirmed from pcap):
            #   pay[0:2]  = item ID, little-endian
            #   pay[2]    = type byte: 0=menu, 1=macro, 2=action, 3=ctrl/level, 6=sync
            #   pay[3]    = flags/subtype byte
            #   pay[4]    = 0x00
            #   pay[5:]   = null-terminated display name string
            pfx = b"ACK GMI "
            if not resp_bytes or not resp_bytes.startswith(pfx):
                return None
            rest = resp_bytes[len(pfx):]
            # rest starts with the hex ID string, then a space, then binary payload
            sp = rest.find(b" ")
            if sp == -1:
                return None
            try:
                iid = int(rest[:sp], 16)
            except ValueError:
                return None
            pay = rest[sp + 1:]
            if len(pay) < 6:
                return None
            itype = pay[2]  # raw byte, no ord() needed
            # Name is null-terminated starting at pay[5]
            name_bytes = pay[5:]
            null = name_bytes.find(b"\x00")
            if null != -1:
                name_bytes = name_bytes[:null]
            name = name_bytes.decode("latin-1", errors="replace").strip()
            return {"id": iid, "type": itype, "name": name, "_pay": pay}

        for iid in all_ids:
            hs     = f"0x{iid:04X}"
            resp   = send_raw(f"GMI {hs}\r")   # raw bytes -- parse_gmi needs bytes
            parsed = parse_gmi(resp)
            if parsed:
                all_items.append(parsed)
                tn = {0: "MENU", 1: "MACRO", 2: "ACTION", 3: "LEVEL", 6: "SYNC"}.get(parsed["type"], f"0x{parsed['type']:02x}")
                log_(f"  GMI {hs} -> {tn} '{parsed['name']}'")
            else:
                log_(f"  GMI {hs} -> FAILED ({resp or 'timeout'})")
            time.sleep(0.05)

        # For each ctrl/level item, fetch GLI V to read lvlPreStr / lvlPostStr
        def parse_gli_strings(raw: bytes) -> tuple[str, str]:
            """
            GLI V payload layout (after 'ACK GLI 0xHHHH V ' prefix):
              [0]     type byte
              [1-39]  binary fields (set bytes, floats, flags)
              [40]    lvlPreStr  (null-terminated ASCII)
              [41+]   lvlPostStr (null-terminated ASCII)
            """
            if len(raw) <= 40:
                return "", ""
            seg = raw[40:]
            n1 = seg.find(b"\x00")
            if n1 == -1:
                return seg.decode("latin-1", errors="replace"), ""
            pre = seg[:n1].decode("latin-1", errors="replace")
            seg2 = seg[n1 + 1:]
            n2 = seg2.find(b"\x00")
            post = (seg2[:n2] if n2 != -1 else seg2).decode("latin-1", errors="replace")
            return pre, post

        log_("=== Reading level pre/post strings (GLI)")
        for item in all_items:
            if item["type"] != 3:
                continue
            hs = f"0x{item['id']:04X}"
            raw_gli = send_raw(f"GLI {hs} V\r")
            pfx = f"ACK GLI {hs} V ".encode("latin-1")
            if raw_gli and raw_gli.startswith(pfx):
                pre, post = parse_gli_strings(raw_gli[len(pfx):])
                item["_lvlPre"]  = pre
                item["_lvlPost"] = post
                log_(f"  GLI {hs}: pre={pre!r} post={post!r}")
            else:
                item["_lvlPre"]  = ""
                item["_lvlPost"] = ""
            time.sleep(0.05)

        level_items   = [i for i in all_items if i["type"] == 3]   # ctrl/vol/mute
        trigger_items = [i for i in all_items if i["type"] == 2]   # action
        menu_items    = [i for i in all_items if i["type"] == 0]   # menu container
        macro_items   = [i for i in all_items if i["type"] == 1]   # init macro
        sync_items    = [i for i in all_items if i["type"] == 6]   # startup sync
        log_(f"  Found: {len(level_items)} level, {len(trigger_items)} trigger, {len(menu_items)} menu, {len(macro_items)} macro, {len(sync_items)} sync")

        # Phase 4: GLI loop -- get actual SV channel per level item
        # GLI V response is binary: payload byte 0 = SV channel (1-based integer).
        # There is NO ASCII "SV N" string in the response -- it's a raw binary struct.
        log_("=== Reading SV channel assignments (GLI)")
        for item in level_items:
            hs   = f"0x{item['id']:04X}"   # uppercase to match device echo format
            resp = send_raw(f"GLI {hs} V\r", timeout=3.0)   # raw bytes
            if resp:
                # Find the payload: after "ACK GLI 0xXXXX V "
                marker = f"ACK GLI {hs} V ".encode("latin-1")
                # Device may echo lowercase; try both
                marker_lc = f"ACK GLI {hs.lower()} V ".encode("latin-1")
                pay_start = -1
                for m in (marker, marker_lc):
                    idx = resp.find(m)
                    if idx != -1:
                        pay_start = idx + len(m)
                        break
                if pay_start != -1 and pay_start < len(resp):
                    sv_ch = resp[pay_start]   # first byte of binary payload = SV channel
                    if sv_ch > 0:
                        item["svChannel"] = sv_ch
                        log_(f"  GLI {hs} -> SV {sv_ch}  '{item['name']}'")
                        time.sleep(0.05)
                        continue
            log_(f"  GLI {hs} -> no SV found (will assign sequential)")
            time.sleep(0.05)

        # GLI M reads (keeps device state clean, per RE doc)
        for item in level_items:
            send_raw(f"GLI 0x{item['id']:04X} M\r")
            time.sleep(0.03)

        # Phase 4c: GMBA -- read macro actions for each macro item
        log_("=== Reading startup macro actions (GMBA)")
        startup_macro = None
        for macro in macro_items:
            hs = f"0x{macro['id']:04X}"
            actions = []
            for idx in range(32):
                resp = send_raw(f"GMBA {hs} {idx}\r")
                if resp is None:
                    break
                text = resp.decode("latin-1", errors="replace")
                if "NACK" in text:
                    break
                # Payload: null-terminated name, then at offset 16: device_idx(1), padding(2), command bytes
                pfx  = f"ACK GMBA {hs.lower()} {idx} ".encode("latin-1")
                pfx2 = f"ACK GMBA {hs} {idx} ".encode("latin-1")
                pay = resp
                for p in (pfx, pfx2):
                    i2 = resp.find(p)
                    if i2 != -1:
                        pay = resp[i2 + len(p):]
                        break
                null = pay.find(b"\x00")
                action_name = pay[:null].decode("latin-1", errors="replace").strip() if null != -1 else ""
                # Command bytes start at offset 19 (after 16-byte name field + 3 header bytes)
                cmd_bytes = list(pay[19:]) if len(pay) > 19 else []
                # Trim trailing nulls from command
                while cmd_bytes and cmd_bytes[-1] == 0:
                    cmd_bytes.pop()
                device_idx = pay[16] if len(pay) > 16 else 0
                actions.append({
                    "id": str(uuid.uuid4()),
                    "name": action_name,
                    "deviceIdx": int(device_idx),
                    "dev": "",  # resolved below after GDI
                    "bytes": cmd_bytes,
                    "cr": True, "lf": False,
                })
                log_(f"  GMBA {hs} {idx}: '{action_name}' dev={device_idx}")
                time.sleep(0.05)
            startup_macro = {"enabled": True, "id": macro["id"], "name": macro["name"], "actions": actions}
            log_(f"  Macro '{macro['name']}': {len(actions)} actions")

        # Parse target device name from SYNC item payload (at pay[21], after 16-byte name field)
        startup_sync = None
        for sync_item in sync_items:
            pay = sync_item.get("_pay", b"")
            target_name = ""
            if len(pay) > 21:
                tn_bytes = pay[21:]
                null = tn_bytes.find(b"\x00")
                if null != -1:
                    tn_bytes = tn_bytes[:null]
                target_name = tn_bytes.decode("latin-1", errors="replace").strip()
            startup_sync = {
                "enabled": True,
                "name": sync_item["name"],
                "targetDevice": target_name,
                "destination": target_name,
                "hexValues": False,
                "inactiveState": [], "activeState": [],
                "queryEnable": False, "queryInterval": 500,
                "queryBytes": [], "queryCr": True, "queryLf": False, "queryResponse": [],
                "asyncEnable": False, "asyncIp": "", "asyncPort": 49500,
                "asyncType": "UDP", "asyncSrcIp": "",
                "asyncBytes": [], "asyncCr": True, "asyncLf": False,
            }
            log_(f"  Sync '{sync_item['name']}' -> target='{target_name}'")

        # Phase 4d: GDI -- read 3rd party device list
        log_("=== Reading 3rd party devices (GDI)")
        gdi_devices = []
        for idx in range(16):
            resp = send_raw(f"GDI {idx}\r")
            if resp is None:
                break
            text = resp.decode("latin-1", errors="replace")
            if "NACK" in text:
                break
            pfx = f"ACK GDI {idx} ".encode("latin-1")
            pay = resp[len(pfx):] if resp.startswith(pfx) else resp
            null = pay.find(b"\x00")
            dev_name = pay[:null].decode("latin-1", errors="replace") if null != -1 else f"Device{idx}"
            dev = {"id": str(uuid.uuid4()), "name": dev_name, "port": 49500, "asyncPort": 49500,
                   "proto": "UDP", "type": "general"}
            # GDI binary struct (from DLL reverse-engineering):
            #   pay[0:16]  = device name, null-terminated, zero-padded to 16 bytes
            #   pay[16:20] = ctrl IP (big-endian uint32)
            #   pay[20:22] = ctrl port (big-endian uint16)
            #   pay[22]    = ctrl protocol type
            #   pay[23:27] = async IP (big-endian uint32)
            #   pay[27]    = async protocol type
            #   pay[28:30] = async port (big-endian uint16, high byte first)
            if len(pay) >= 20:
                ip = ".".join(str(b) for b in pay[16:20])
                port = ((pay[20] << 8) | pay[21]) if len(pay) >= 22 else 49500
                dev["ip"] = ip
                dev["port"] = port
                dev["asyncIp"] = ip
            if len(pay) >= 29:
                async_ip = ".".join(str(b) for b in pay[23:27])
                async_port = (pay[27] << 8) | pay[28]
                dev["asyncIp"] = async_ip
                dev["asyncPort"] = async_port
            gdi_devices.append(dev)
            log_(f"  GDI {idx}: '{dev_name}' {dev.get('ip','?')}:{dev.get('port','?')}")
            time.sleep(0.05)
        log_(f"  {len(gdi_devices)} device(s) found")

        # Resolve device names in macro actions now that GDI is read
        if startup_macro:
            for action in startup_macro.get("actions", []):
                idx = action.get("deviceIdx", 0)
                if idx < len(gdi_devices):
                    action["dev"] = gdi_devices[idx]["name"]

        # Phase 5: SyncAssignLabels -- build display order + channel maps
        log_("=== Building menu tree")

        # Build col -> parent menu name map.
        # D1 submenu IDs are 0xFFF0..0xFFF7 (type=0, menu container).
        # 0xFFFF is the top-level root container -- exclude it.
        # column = id & 0x0f  (low nibble, matches child grouping below)
        col_to_menu = {}
        for item in all_items:
            if item["type"] == 0 and 0xFFF0 <= item["id"] <= 0xFFF7:
                col_to_menu[item["id"] & 0x0f] = item["name"]

        # Sort into display order.
        # vm_screen: the root vol/mute screen (0xFFFE, type=3)
        # root_menus: D1 menu containers (0xFFF0..0xFFF7, type=0) -- these are the nav items
        # sub_levels: deeper ctrl/level items (id < 0xFFF0, type=3)
        vm_screen  = next((i for i in level_items if i["id"] == 0xFFFE), None)
        root_menus = sorted(
            [i for i in menu_items if 0xFFF0 <= i["id"] <= 0xFFF7],
            key=lambda x: x["id"])
        sub_levels = sorted(
            [i for i in level_items if i["id"] < 0xFFF0],
            key=lambda x: (x["id"] & 0x0f, x["id"]))

        # Assign SV channels sequentially to items without GLI data
        seq_ch = 1
        ordered_for_ch = ([vm_screen] if vm_screen else []) + sub_levels
        for item in ordered_for_ch:
            if "svChannel" not in item:
                item["svChannel"] = seq_ch
            seq_ch = max(seq_ch, item["svChannel"]) + 1

        # svToSlot / slotToSV
        sv_to_slot   = {}
        slot_to_sv   = {}
        display_order = ([vm_screen] if vm_screen else []) + sub_levels
        for slot, item in enumerate(display_order, 1):
            if "svChannel" in item:
                sv_to_slot[item["svChannel"]] = slot
                slot_to_sv[slot]              = item["svChannel"]

        log_(f"  svToSlot: {sv_to_slot}")

        # Sort triggers: col then row within col (matches Lua)
        trigger_items_sorted = sorted(trigger_items, key=lambda x: (x["id"] & 0x0f, x["id"]))

        # Build frontend-shaped menu tree

        def parse_gmi_extra(pay: bytes):
            """
            Parse the extra data that follows the 16-byte fixed name field in a GMI payload.
            Layout (confirmed from pcap / SYNC item RE):
              pay[5:21]  = name (16-byte null-padded field)
              pay[21:]   = device name (null-terminated ASCII)
              after null = raw command bytes
            Returns (dev_name: str, cmd_bytes: list[int]).
            """
            if len(pay) <= 21:
                return "", []
            rest = pay[21:]
            null = rest.find(b"\x00")
            if null == -1:
                # No null found — treat all as device name, no bytes
                return rest.decode("latin-1", errors="replace").strip(), []
            dev_name = rest[:null].decode("latin-1", errors="replace").strip()
            cmd_bytes = list(rest[null + 1:])
            # Trim trailing non-printable / non-special bytes (nulls, protocol footers like 0x08)
            # Keep: printable ASCII (0x20-0x7e), CR (0x0d), LF (0x0a), 0xe3 (SV marker)
            KEEP = lambda b: 0x20 <= b <= 0x7e or b in (0x0d, 0x0a, 0xe3)
            while cmd_bytes and not KEEP(cmd_bytes[-1]):
                cmd_bytes.pop()
            # Trim leading nulls / padding
            while cmd_bytes and cmd_bytes[0] == 0:
                cmd_bytes.pop(0)
            return dev_name, cmd_bytes

        def _strip_cr_lf(cmd_bytes):
            """Strip trailing CR/LF and return (bytes_without_terminator, has_cr, has_lf)."""
            b = list(cmd_bytes)
            has_lf = bool(b and b[-1] == 0x0a)
            if has_lf:
                b = b[:-1]
            has_cr = bool(b and b[-1] == 0x0d)
            if has_cr:
                b = b[:-1]
            return b, has_cr, has_lf

        def make_level_entry(item, slot):
            ch = item.get("svChannel", slot)
            dev_name, raw_bytes = parse_gmi_extra(item.get("_pay", b""))
            set_bytes, _, _ = _strip_cr_lf(raw_bytes) if raw_bytes else ([], False, False)
            return {
                "id":           f"dev_{item['id']:04x}",
                "entry_type":   "level",
                "display_txt":  item["name"],
                "binary":       False,
                "level_vol": {
                    "channel":         ch,
                    "setBytes":        set_bytes,
                    "queryBytes":      [],
                    "respQueryBytes":  set_bytes,
                    "syncBytes":       set_bytes,
                    "minParam":        -100,
                    "maxParam":         20,
                    "stepSize":          2,
                    "paramDecPts":       0,
                    "trimEnable":       False,
                    "pollMs":           500,
                    "queryEnable":      True,
                    "asyncEnable":      True,
                    "ackEnable":        False,
                    "headerText":       "",
                    "levelPreStr":      item.get("_lvlPre", ""),
                    "levelPostStr":     item.get("_lvlPost", ""),
                    "setter_type":       1,
                    "set_dev_name":     dev_name,
                    "footerEnable":      1,
                    "active": [], "altActive": [], "altInactive": [], "inactive": [],
                    "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
                },
                "level_mute": {
                    "setBytes": [], "queryBytes": [], "respQueryBytes": [], "syncBytes": [],
                    "minParam": 0, "maxParam": 0, "stepSize": 0, "paramDecPts": 0,
                    "trimEnable": False, "pollMs": 500,
                    "queryEnable": False, "asyncEnable": False,
                    "ackEnable": False, "headerText": "", "levelPreStr": "", "levelPostStr": "",
                    "setter_type": 0, "set_dev_name": dev_name, "footerEnable": 0,
                    "active": [], "altActive": [], "altInactive": [], "inactive": [],
                    "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
                },
            }

        def make_trigger_entry(item, trigger_num):
            dev_name, cmd_bytes = parse_gmi_extra(item.get("_pay", b""))
            # Fall back to "TR N\r" only if the payload contained no bytes
            if not cmd_bytes:
                cmd_bytes = [ord(c) for c in f"TR {trigger_num}"] + [0x0d]
            cmd_bytes, has_cr, has_lf = _strip_cr_lf(cmd_bytes)
            return {
                "id":           f"dev_{item['id']:04x}",
                "entry_type":   "action",
                "display_txt":  item["name"],
                "binary":       False,
                "action_type":  "3rd_party",
                "bytes":        cmd_bytes,
                "dev":          dev_name,
                "cr":           has_cr,
                "lf":           has_lf,
                "triggerNum":   trigger_num,
            }

        def make_menu_entry(name, entries):
            return {
                "id":          f"dev_menu_{name.replace(' ', '_')}",
                "entry_type":  "menu",
                "display_txt": name,
                "entries":     entries,
            }

        # Build vol/mute screen entry
        if vm_screen:
            vol_mute_entry = make_level_entry(vm_screen, 1)
            vol_mute_entry["_isRoot"] = True
        else:
            vol_mute_entry = {
                "id": "dev_fffe", "entry_type": "level", "display_txt": "Vol/Mute Screen",
                "binary": False, "_isRoot": True,
                "level_vol": {
                    "channel": 1, "minParam": -100, "maxParam": 20,
                    "stepSize": 2, "pollMs": 500, "queryEnable": True,
                    "asyncEnable": True, "setter_type": 1, "set_dev_name": "",
                    "setBytes": [], "queryBytes": [],
                    "respQueryBytes": [], "syncBytes": [],
                    "paramDecPts": 0, "trimEnable": False, "ackEnable": False,
                    "headerText": "", "levelPreStr": "", "levelPostStr": "",
                    "footerEnable": 1, "active": [], "altActive": [], "altInactive": [],
                    "inactive": [], "asyncAltResponse": False,
                    "queryAltResponse": False, "setAltResponse": False,
                },
                "level_mute": {
                    "setBytes": [], "queryBytes": [], "respQueryBytes": [],
                    "syncBytes": [], "minParam": 0, "maxParam": 0, "stepSize": 0,
                    "paramDecPts": 0, "trimEnable": False, "pollMs": 500,
                    "queryEnable": False, "asyncEnable": False, "ackEnable": False,
                    "headerText": "", "levelPreStr": "", "levelPostStr": "",
                    "setter_type": 0, "set_dev_name": "", "footerEnable": 0,
                    "active": [], "altActive": [], "altInactive": [], "inactive": [],
                    "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
                },
            }

        # Assign sequential trigger numbers globally (col-then-row order)
        trigger_num_map = {item["id"]: n for n, item in enumerate(trigger_items_sorted, 1)}

        # Build main menu from root_menus (type=0 items at 0xFFF0-0xFFF7).
        # Each menu's children are all items whose column (id & 0x0f) matches.
        main_menu_entries = []
        for menu in root_menus:
            col = menu["id"] & 0x0f
            children_level  = sorted([i for i in sub_levels   if (i["id"] & 0x0f) == col], key=lambda x: x["id"])
            children_action = sorted([i for i in trigger_items if (i["id"] & 0x0f) == col], key=lambda x: x["id"])
            all_children    = sorted(children_level + children_action, key=lambda x: x["id"])

            entries = []
            for item in all_children:
                if item["type"] == 3:
                    slot = display_order.index(item) + 1 if item in display_order else 1
                    entries.append(make_level_entry(item, slot))
                elif item["type"] == 2:
                    entries.append(make_trigger_entry(item, trigger_num_map[item["id"]]))
            main_menu_entries.append(make_menu_entry(menu["name"], entries))

        root_container = next((i for i in menu_items if i["id"] == 0xFFFF), None)
        main_menu_name = root_container["name"] if root_container else ""
        main_menu = make_menu_entry(main_menu_name, main_menu_entries)

        result_config = {
            **device_settings,
            "volMuteEnabled": vm_screen is not None,
            "menuEnabled":    bool(root_menus or sub_levels or trigger_items),
            "volMuteScreen":  vol_mute_entry,
            "mainMenu":       main_menu,
            "devices":              gdi_devices,
            "startupSync":          startup_sync,
            "startupSyncEnabled":   startup_sync is not None,
            "startupMacro":         startup_macro,
            "startupMacroEnabled":  startup_macro is not None,
            "svToSlot":       sv_to_slot,
            "slotToSV":       slot_to_sv,
            "deviceName": device_name or "",
            "simVol": 0, "simMutes": {}, "simChannelVols": {},
            "simScreen": "menu", "simFaderEntry": None,
        }

        log_(f"  Built: {len(root_menus)} menus, {len(display_order)} levels, {len(trigger_items_sorted)} triggers")
        log_("OK  Sync complete")
        return {
            "ok":     True,
            "config": result_config,
            "error":  None,
            "summary": {
                "menus":    len(root_menus),
                "levels":   len(display_order),
                "triggers": len(trigger_items_sorted),
                "mac":      mac_str,
                "firmware": firmware,
            },
        }

    except Exception as exc:
        log.exception("Sync failed")
        return {"ok": False, "error": str(exc), "config": None}
    finally:
        sock.close()

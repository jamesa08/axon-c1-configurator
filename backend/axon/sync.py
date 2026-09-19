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

from .config import CMD_PORT, log
from .discovery import parse_query_response


# ---------------------------------------------------------------------------
# Byte-mask builders for SV (QSC volume/mute) control protocol.
# ---------------------------------------------------------------------------

def sv_set_bytes(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0xe3, 0x0d]


def sv_query_bytes(ch: int) -> list[int]:
    return [ord(c) for c in f"SV {ch} "] + [0x0d]


# ---------------------------------------------------------------------------
# Blocking sync
# ---------------------------------------------------------------------------

def blocking_sync(device_ip: str, progress_cb) -> dict:
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
        # Phase 1: QUERY for current device settings
        log_("=== Sync Phase 1: QUERY")
        r = send_raw("QUERY\r")
        if not r:
            return {"ok": False, "error": "No response to QUERY", "config": None}
        log_(f"  {r[:120]}")
        fields   = parse_query_response(r)
        ver_r    = send_raw("VERSION\r") or ""
        mac_r    = send_raw("GETMAC\r")  or ""
        send_raw("MODEL\r")   # consume but not used

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
        log_("=== Sync Phase 2: GMIID")
        send_raw("SCM THIRD_PARTY\r")

        r = send_raw("GMIID\r")
        if not r or not r.startswith("ACK GMIID"):
            return {"ok": False, "error": f"GMIID failed: {r}", "config": None}

        parts   = r.split()
        count   = int(parts[2]) if len(parts) > 2 else 0
        all_ids = [int(x, 16) for x in parts[3:3+count]]
        log_(f"  {count} items: {[hex(x) for x in all_ids]}")

        # Phase 3: GMI loop
        log_("=== Sync Phase 3: GMI loop")
        all_items = []  # {id, type, name}

        def parse_gmi(resp):
            pfx = "ACK GMI "
            if not resp or not resp.startswith(pfx):
                return None
            rest = resp[len(pfx):]
            try:
                sp = rest.index(" ")
            except ValueError:
                return None
            iid  = int(rest[:sp], 16)
            pay  = rest[sp+1:]
            if len(pay) < 6:
                return None
            itype = ord(pay[2]) if isinstance(pay[2], str) else pay[2]
            name  = pay[5:].split("\x00")[0].split("\r")[0].split("\n")[0].strip()
            return {"id": iid, "type": itype, "name": name}

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
            time.sleep(0.05)

        level_items   = [i for i in all_items if i["type"] == 3]
        trigger_items = [i for i in all_items if i["type"] == 2]
        menu_items    = [i for i in all_items if i["type"] == 0]
        log_(f"  Found: {len(level_items)} level, {len(trigger_items)} trigger, {len(menu_items)} menu")

        # Phase 4: GLI loop -- get actual SV channel per level item
        log_("=== Sync Phase 4: GLI loop")
        for item in level_items:
            hs   = f"0x{item['id']:04x}"
            resp = send_raw(f"GLI {hs} V\r", timeout=3.0)
            if resp and "ACK GLI" in resp:
                idx = resp.find("SV ")
                if idx != -1:
                    after  = resp[idx+3:]
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
            log_(f"  GLI {hs} -> no SV found (will assign sequential)")
            time.sleep(0.05)

        # GLI M reads (keeps device state clean, per RE doc)
        for item in level_items:
            send_raw(f"GLI 0x{item['id']:04x} M\r")
            time.sleep(0.03)

        # Phase 5: SyncAssignLabels -- build display order + channel maps
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
        root_levels = sorted(
            [i for i in level_items if i["id"] >= 0xfff0 and i["id"] != 0xfffe],
            key=lambda x: x["id"])
        sub_levels  = sorted(
            [i for i in level_items if i["id"] < 0xfff0],
            key=lambda x: (x["id"] % 16, x["id"]))

        # Assign SV channels sequentially to items without GLI data
        seq_ch = 1
        ordered_for_ch = ([vm_screen] if vm_screen else []) + root_levels + sub_levels
        for item in ordered_for_ch:
            if "svChannel" not in item:
                item["svChannel"] = seq_ch
            seq_ch = max(seq_ch, item["svChannel"]) + 1

        # svToSlot / slotToSV
        sv_to_slot   = {}
        slot_to_sv   = {}
        display_order = ([vm_screen] if vm_screen else []) + root_levels + sub_levels
        for slot, item in enumerate(display_order, 1):
            if "svChannel" in item:
                sv_to_slot[item["svChannel"]] = slot
                slot_to_sv[slot]              = item["svChannel"]

        log_(f"  svToSlot: {sv_to_slot}")

        # Sort triggers: col then row (matches Lua)
        trigger_items_sorted = sorted(trigger_items, key=lambda x: (x["id"] % 16, x["id"]))

        # Build frontend-shaped menu tree
        def make_level_entry(item, slot):
            ch = item.get("svChannel", slot)
            return {
                "id":           f"dev_{item['id']:04x}",
                "entry_type":   "level",
                "display_txt":  item["name"],
                "binary":       False,
                "level_vol": {
                    "channel":         ch,
                    "setBytes":        sv_set_bytes(ch),
                    "queryBytes":      sv_query_bytes(ch),
                    "respQueryBytes":  sv_set_bytes(ch),
                    "syncBytes":       sv_set_bytes(ch),
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
                    "lvlPreStr":        "",
                    "lvlPostStr":       "",
                    "setter_type":       1,
                    "set_dev_name":     "QSC",
                    "footerEnable":      1,
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
                    "asyncEnable": True, "setter_type": 1, "set_dev_name": "QSC",
                    "setBytes": sv_set_bytes(1), "queryBytes": sv_query_bytes(1),
                    "respQueryBytes": sv_set_bytes(1), "syncBytes": sv_set_bytes(1),
                    "paramDecPts": 0, "trimEnable": False, "ackEnable": False,
                    "headerText": "", "lvlPreStr": "", "lvlPostStr": "",
                    "footerEnable": 1, "active": [], "altActive": [], "altInactive": [],
                    "inactive": [], "asyncAltResponse": False,
                    "queryAltResponse": False, "setAltResponse": False,
                },
                "level_mute": {
                    "setBytes": [], "queryBytes": [], "respQueryBytes": [],
                    "syncBytes": [], "minParam": 0, "maxParam": 0, "stepSize": 0,
                    "paramDecPts": 0, "trimEnable": False, "pollMs": 500,
                    "queryEnable": False, "asyncEnable": False, "ackEnable": False,
                    "headerText": "", "lvlPreStr": "", "lvlPostStr": "",
                    "setter_type": 0, "set_dev_name": "QSC", "footerEnable": 0,
                    "active": [], "altActive": [], "altInactive": [], "inactive": [],
                    "asyncAltResponse": False, "queryAltResponse": False, "setAltResponse": False,
                },
            }

        # Group submenu items by column (col = id & 0x0f)
        col_items = {}
        for item in sub_levels:
            col = item["id"] & 0x0f
            col_items.setdefault(col, []).append(item)

        submenus = []
        for col in sorted(col_items.keys()):
            menu_name  = col_to_menu.get(col, f"Menu {col}")
            slot_start = len(([vm_screen] if vm_screen else []) + root_levels) + 1
            entries    = []
            for item in col_items[col]:
                slot = display_order.index(item) + 1 if item in display_order else slot_start
                entries.append(make_level_entry(item, slot))
            submenus.append(make_menu_entry(menu_name, entries))

        trigger_entries = []
        for n, item in enumerate(trigger_items_sorted, 1):
            trigger_entries.append(make_trigger_entry(item, n))

        if trigger_entries:
            trig_menu_name = "TRIGGERS"
            if trigger_items_sorted:
                trig_col       = trigger_items_sorted[0]["id"] & 0x0f
                trig_menu_name = col_to_menu.get(trig_col, "TRIGGERS")
            submenus.append(make_menu_entry(trig_menu_name, trigger_entries))

        root_entries = []
        for slot, item in enumerate(root_levels, (2 if vm_screen else 1)):
            root_entries.append(make_level_entry(item, slot))

        main_menu = make_menu_entry("MAIN MENU", root_entries + submenus)

        result_config = {
            **device_settings,
            "volMuteEnabled": vm_screen is not None,
            "menuEnabled":    bool(root_levels or sub_levels or trigger_items),
            "volMuteScreen":  vol_mute_entry,
            "mainMenu":       main_menu,
            "svToSlot":       sv_to_slot,
            "slotToSV":       slot_to_sv,
            "deviceName": f"AxonC1-{mac_clean[-6:]}",
            "simVol": 0, "simMutes": {}, "simChannelVols": {},
            "simScreen": "menu", "simFaderEntry": None,
        }

        log_(f"  Built: {len(display_order)} levels, {len(trigger_items_sorted)} triggers")
        log_("OK  Sync complete")
        return {
            "ok":     True,
            "config": result_config,
            "error":  None,
            "summary": {
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

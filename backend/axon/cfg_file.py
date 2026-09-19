"""
axon/cfg_file.py -- .cfg file read/write (XML + HTML-escaped JSON, file version 1.2).

cfg_to_frontend(xml_bytes)          -> frontend config dict
frontend_to_cfg(cfg, firmware_ver)  -> XML bytes
"""

import html
import json
import re as _re
import xml.etree.ElementTree as ET

FILE_VER     = "1.2"
PRODUCT_NAME = "AxonC1"
MENU_VER     = "1.2.0"


# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

def bytes_to_sv_channel(byte_list: list[int]) -> int | None:
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


def lc_to_hex(lc_str: str) -> str:
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


def hex_to_lc(hex_color: str) -> str:
    """Convert '#rrggbb' to 'R:G:B' string for the device."""
    h = hex_color.lstrip("#")
    if len(h) == 6:
        return f"{int(h[0:2], 16)}:{int(h[2:4], 16)}:{int(h[4:6], 16)}"
    return "0:0:0"


# ---------------------------------------------------------------------------
# cfg -> frontend
# ---------------------------------------------------------------------------

def cfg_to_frontend(xml_bytes: bytes) -> dict:
    """Parse a .cfg file and return a frontend-shaped config dict."""
    root = ET.fromstring(xml_bytes)
    data = root.find("SNAPSHOT_DATA")
    if data is None:
        raise ValueError("Missing SNAPSHOT_DATA element")

    def text(tag, default=""):
        el = data.find(tag)
        return el.text.strip() if el is not None and el.text else default

    lc_raw = text("LC", "OFF")
    cfg = {
        "mode":              text("CM", "THIRD_PARTY"),
        "displayBrightness": int(text("DB", "7")),
        "displayTimeout":    int(text("DT", "60")),
        "lbBrightness":      int(text("LBB", "7")),
        "lbTimeout":         int(text("LBT", "10")),
        "lbColor":           lc_to_hex(lc_raw),
        "lbOn":              lc_raw != "OFF",
        "pinEnabled":        text("LPM", "0") == "1",
        "pin":               text("LP", "0000"),
        "displayLock":       text("DL", "0") == "1",
    }

    mc_el = data.find("MENU_CONFIG")
    if mc_el is None or not mc_el.text:
        return cfg

    mc_json = html.unescape(mc_el.text.strip())
    try:
        mc = json.loads(mc_json)
    except json.JSONDecodeError as e:
        raise ValueError(f"MENU_CONFIG JSON parse error: {e}")

    # dev_list -> devices[]
    dev_entries_raw = mc.get("dev_list", {}).get("entries", [])
    devices = []
    for i, d in enumerate(dev_entries_raw):
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

    # menu.control -> volMuteScreen + mainMenu tree
    controls = mc.get("menu", {}).get("control", [])

    vol_mute_vol  = None
    vol_mute_mute = None
    main_menu_raw = None
    root_controls = []

    for ctrl in controls:
        et = ctrl.get("entry_type", "")
        if et == "level" and ctrl.get("path", "").count(">") == 1:
            if "level_vol" in ctrl:
                vol_mute_vol  = ctrl
            elif "level_mute" in ctrl:
                vol_mute_mute = ctrl
        elif et == "main_menu":
            main_menu_raw = ctrl
        elif et == "sync_action":
            root_controls.append({
                "entry_type":  "sync_action",
                "display_txt": ctrl.get("display_txt", "Sync Action"),
                "path":        ctrl.get("path", ""),
                "init_sync":   ctrl.get("init_sync", {}),
            })
        elif et == "init_macro":
            root_controls.append({
                "entry_type":     "init_macro",
                "display_txt":    ctrl.get("display_txt", "Init Macro"),
                "path":           ctrl.get("path", ""),
                "initMacroDelay": ctrl.get("initMacroDelay", 3),
                "interCmdDelay":  ctrl.get("interCmdDelay", 100),
                "entries":        ctrl.get("entries", []),
            })

    uid_counter = [0]

    def uid():
        uid_counter[0] += 1
        return f"cfg_{uid_counter[0]:04d}"

    def parse_level(name: str, vol_ctrl: dict | None, mute_ctrl: dict | None) -> dict:
        vol  = vol_ctrl.get("level_vol",  {}) if vol_ctrl  else {}
        mute = mute_ctrl.get("level_mute", {}) if mute_ctrl else {}
        ch   = bytes_to_sv_channel(vol.get("setBytes", [])) or 1
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
            "cr":          True,
            "lf":          False,
        }

    def parse_menu_entries(raw_entries: list) -> list:
        out = []
        i   = 0
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
                next_entry = raw_entries[i+1] if i+1 < len(raw_entries) else None
                vol_e  = entry      if "level_vol"  in entry                   else None
                mute_e = next_entry if next_entry and "level_mute" in next_entry else None
                if mute_e is None:
                    vol_e  = None
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
        name           = (vol_mute_vol or vol_mute_mute).get("display_txt", "Vol/Mute Screen")
        vol_mute_entry = parse_level(name, vol_mute_vol, vol_mute_mute)
        vol_mute_entry["_isRoot"] = True

    # Main menu tree
    main_menu = {"id": uid(), "entry_type": "menu", "display_txt": "MAIN MENU", "entries": []}
    if main_menu_raw:
        main_menu["entries"] = parse_menu_entries(main_menu_raw.get("entries", []))

    cfg["volMuteScreen"]  = vol_mute_entry
    cfg["mainMenu"]       = main_menu
    cfg["volMuteEnabled"] = vol_mute_entry is not None
    cfg["menuEnabled"]    = bool(main_menu["entries"])
    cfg["_rootControls"]  = root_controls

    return cfg


# ---------------------------------------------------------------------------
# frontend -> cfg
# ---------------------------------------------------------------------------

def frontend_to_cfg(cfg: dict, firmware_ver: str = "V1.5.0") -> bytes:
    """Serialize a frontend config dict to .cfg XML bytes."""
    devs        = cfg.get("devices", [])
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
        name     = entry.get("display_txt", "Level")
        path     = path_prefix + ">" + name
        vol      = entry.get("level_vol",  {})
        mute     = entry.get("level_mute", {})
        vol_ctrl = {
            "binary":      entry.get("binary", False),
            "display_txt": name,
            "entry_type":  "level",
            "hasDefVol":   True,
            "level_vol": {
                "ackEnable":        vol.get("ackEnable", False),
                "active":           vol.get("active", []),
                "altActive":        vol.get("altActive", []),
                "altInactive":      vol.get("altInactive", []),
                "asyncAltResponse": vol.get("asyncAltResponse", False),
                "asyncEnable":      vol.get("asyncEnable", True),
                "footerEnable":     vol.get("footerEnable", 1),
                "headerText":       vol.get("headerText", ""),
                "inactive":         vol.get("inactive", []),
                "levelPostStr":     vol.get("lvlPostStr", ""),
                "levelPreStr":      vol.get("lvlPreStr", ""),
                "maxParam":         vol.get("maxParam", 20),
                "minParam":         vol.get("minParam", -100),
                "paramDecPts":      vol.get("paramDecPts", 0),
                "pollMs":           vol.get("pollMs", 500),
                "queryAltResponse": vol.get("queryAltResponse", False),
                "queryBytes":       vol.get("queryBytes", []),
                "queryEnable":      vol.get("queryEnable", True),
                "respBytes":        [],
                "respQueryBytes":   vol.get("respQueryBytes", []),
                "setAltResponse":   vol.get("setAltResponse", False),
                "setBytes":         vol.get("setBytes", []),
                "set_dev_name":     vol.get("set_dev_name", dev_name),
                "setter_type":      vol.get("setter_type", 1),
                "stepSize":         vol.get("stepSize", 2),
                "syncBytes":        vol.get("syncBytes", []),
                "trimEnable":       vol.get("trimEnable", False),
            },
            "path": path,
        }
        mute_ctrl = {
            "binary":      entry.get("binary", False),
            "display_txt": name,
            "entry_type":  "level",
            "hasDefVol":   True,
            "level_mute": {
                "ackEnable":        mute.get("ackEnable", False),
                "active":           mute.get("active", []),
                "altActive":        mute.get("altActive", []),
                "altInactive":      mute.get("altInactive", []),
                "asyncAltResponse": mute.get("asyncAltResponse", False),
                "asyncEnable":      mute.get("asyncEnable", False),
                "footerEnable":     mute.get("footerEnable", 0),
                "headerText":       mute.get("headerText", ""),
                "inactive":         mute.get("inactive", []),
                "levelPostStr":     mute.get("lvlPostStr", ""),
                "levelPreStr":      mute.get("lvlPreStr", ""),
                "maxParam":         mute.get("maxParam", 0),
                "minParam":         mute.get("minParam", 0),
                "paramDecPts":      mute.get("paramDecPts", 0),
                "pollMs":           mute.get("pollMs", 500),
                "queryAltResponse": mute.get("queryAltResponse", False),
                "queryBytes":       mute.get("queryBytes", []),
                "queryEnable":      mute.get("queryEnable", False),
                "respBytes":        [],
                "respQueryBytes":   mute.get("respQueryBytes", []),
                "setAltResponse":   mute.get("setAltResponse", False),
                "setBytes":         mute.get("setBytes", []),
                "set_dev_name":     mute.get("set_dev_name", dev_name),
                "setter_type":      mute.get("setter_type", 0),
                "stepSize":         mute.get("stepSize", 0),
                "syncBytes":        mute.get("syncBytes", []),
                "trimEnable":       mute.get("trimEnable", False),
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
            return []
        return []

    def build_menu_tree(entry: dict, path_prefix: str):
        name  = entry.get("display_txt", "")
        path  = path_prefix + ">" + name
        etype = entry.get("entry_type", "")
        if etype == "menu":
            children_raw = entry.get("entries", [])
            children     = [build_menu_tree(c, path) for c in children_raw]
            children     = [c for c in children if c]
            return {"display_txt": name, "entries": children, "entry_type": "menu", "path": path}
        elif etype == "level":
            vol  = entry.get("level_vol",  {})
            mute = entry.get("level_mute", {})
            result_entries = []
            for ctrl_pair in [{"level_vol": vol}, {"level_mute": mute}]:
                key = "level_vol" if "level_vol" in ctrl_pair else "level_mute"
                d   = {
                    "binary": False, "display_txt": name,
                    "entry_type": "level", key: ctrl_pair[key],
                    "path": path,
                }
                if key == "level_vol":
                    d["hasDefVol"] = True
                result_entries.append(d)
            return result_entries  # caller must flatten
        elif etype == "action":
            return {
                "action_type": entry.get("action_type", "3rd_party"),
                "binary":      entry.get("binary", False),
                "bytes":       entry.get("bytes", []),
                "dev":         entry.get("dev", dev_name),
                "display_txt": name,
                "entry_type":  "action",
                "path":        path,
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

    vm = cfg.get("volMuteScreen")
    if vm:
        controls.extend(level_to_ctrl(vm, ""))

    main_menu         = cfg.get("mainMenu", {})
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

    mc_json    = json.dumps(mc, indent=4)
    mc_escaped = html.escape(mc_json)

    lc_str = hex_to_lc(cfg.get("lbColor", "#ffffff")) if cfg.get("lbOn", True) else "OFF"

    xml_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<SNAPSHOT_FILE>",
        "    <SNAPSHOT_INFO>",
        f"        <FILE_VER>{FILE_VER}</FILE_VER>",
        "        <PRODUCT_ID>NA</PRODUCT_ID>",
        f"        <PRODUCT_NAME>{PRODUCT_NAME}</PRODUCT_NAME>",
        f"        <PRODUCT_MCU_VER>{firmware_ver}</PRODUCT_MCU_VER>",
        "    </SNAPSHOT_INFO>",
        "    <SNAPSHOT_DATA>",
        f'        <CM>{cfg.get("mode", "THIRD_PARTY")}</CM>',
        f'        <DB>{cfg.get("displayBrightness", 7)}</DB>',
        f'        <DL>{"1" if cfg.get("displayLock") else "0"}</DL>',
        f'        <DT>{cfg.get("displayTimeout", 60)}</DT>',
        "        <GDR>false</GDR>",
        f'        <LBB>{cfg.get("lbBrightness", 5)}</LBB>',
        f'        <LBT>{cfg.get("lbTimeout", 10)}</LBT>',
        f"        <LC>{lc_str}</LC>",
        f'        <LP>{cfg.get("pin", "0000")}</LP>',
        f'        <LPM>{"1" if cfg.get("pinEnabled") else "0"}</LPM>',
        f"        <MENU_CONFIG>{mc_escaped}</MENU_CONFIG>",
        "    </SNAPSHOT_DATA>",
        "</SNAPSHOT_FILE>",
    ]
    return "\n".join(xml_lines).encode("utf-8")

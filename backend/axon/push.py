"""
axon/push.py -- blocking config push to the device (runs in a thread pool).

Packet sequence and ordering match push.py (the ground-truth script)
which was verified against hardware pcap captures.

Phases:
  Pre-push: plain ASCII settings commands
  1. MT   -- announce all IDs
  2. DL   -- device list
  3. MI   -- menu item hierarchy (deepest leaf first, root last)
  4. AI   -- action items (macro then per-parent)
  5. CI/CQ/CA -- control parameters (vol before mute, 0xFFFE last)
  6. Sync CI/CQ/CA
  7. SF 1 -- finalize/commit
  Post-SF: SCM + SMID
"""

import json
import socket
import time
import uuid
from collections import defaultdict

from .config import CMD_PORT, log

# System IDs (confirmed from pcap)
_ID_TOP_MENU   = 0xFFFF   # main menu container
_ID_ROOT_CTRL  = 0xFFFE   # root vol/mute screen
_ID_SYNC       = 0xFFFD   # startup sync action
_ID_INIT_MACRO = 0xFFFB   # init macro

VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# Menu tree helpers
# ---------------------------------------------------------------------------

def child_id(parent_id: int, position: int, depth: int) -> int:
    """
    Nibble-inheritance ID formula (confirmed from pcap).
    depth is the depth of the CHILD being computed (1-indexed, child of root=1).
    """
    if depth == 1:
        return 0xFFF0 | position
    elif depth == 2:
        return 0xFF00 | (position << 4) | (parent_id & 0x00F)
    elif depth == 3:
        return 0xF000 | (position << 8) | (parent_id & 0x0FF)
    elif depth == 4:
        return 0x0000 | (position << 12) | (parent_id & 0xFFF)
    else:
        raise ValueError(f"Unsupported depth {depth}")


def walk_menu(submenus: list, parent_id: int = _ID_TOP_MENU, depth: int = 1):
    """
    Recursively walk the menu tree.
    Yields (node_id, parent_id, depth, position, node) for every node.
    """
    for pos, node in enumerate(submenus):
        nid = child_id(parent_id, pos, depth)
        yield nid, parent_id, depth, pos, node
        if node.get("entry_type") == "menu":
            yield from walk_menu(node.get("entries", []), nid, depth + 1)


def build_id_list(frontend_cfg: dict, include_vol_mute: bool, include_menu: bool,
                  include_sync: bool, include_macro: bool) -> list[int]:
    """
    Build the MT ids array in column-major walk order (confirmed from pcap).
    System IDs first, then tree walk depth-first.
    """
    ids = []
    if include_sync:
        ids.append(_ID_SYNC)
    if include_macro:
        ids.append(_ID_INIT_MACRO)
    if include_vol_mute:
        ids.append(_ID_ROOT_CTRL)
    if include_menu:
        ids.append(_ID_TOP_MENU)
        submenus = frontend_cfg.get("mainMenu", {}).get("entries", [])
        for nid, _pid, _depth, _pos, _node in walk_menu(submenus):
            ids.append(nid)
    return ids


def count_total_packets(frontend_cfg: dict, ctrl_ids: list, include_menu: bool,
                        include_sync: bool, include_macro: bool) -> int:
    """
    Pre-compute total JSON packet count so DL's jsonId can be assigned up front.
    Mirrors push.py count_total_packets().
    """
    submenus = frontend_cfg.get("mainMenu", {}).get("entries", [])

    n_mi = 1  # root system MI block always present
    n_ai = 1 if include_macro else 0

    if include_menu:
        parent_groups: set = set()
        for _nid, parent_id, _depth, _pos, _node in walk_menu(submenus):
            parent_groups.add(parent_id)
        n_mi += len(parent_groups)

        action_parents: set = set()
        for _nid, parent_id, _depth, _pos, node in walk_menu(submenus):
            if node.get("entry_type") == "action":
                action_parents.add(parent_id)
        n_ai += len(action_parents)

    n_ctrl     = len(ctrl_ids)
    n_sync_pkt = 3 if include_sync else 0

    return (
        1            # MT
        + n_mi
        + n_ai
        + n_ctrl * 2  # CI vol+mute
        + n_ctrl * 2  # CQ vol+mute
        + n_ctrl * 2  # CA vol+mute
        + n_sync_pkt
        + 1           # DL
    )


# ---------------------------------------------------------------------------
# Blocking push
# ---------------------------------------------------------------------------

def blocking_push(device_ip: str, config: dict, progress_cb) -> dict:
    """
    Push the frontend config to the device.
    """
    frontend_cfg = config.get("frontendConfig") or config

    devs = frontend_cfg.get("devices", [])
    HOST = device_ip

    include_vol_mute = bool(frontend_cfg.get("volMuteEnabled", True))
    include_menu     = bool(frontend_cfg.get("menuEnabled", True))
    sync_ctrl  = next((c for c in frontend_cfg.get("_rootControls", [])
                       if c.get("entry_type") == "sync_action"), None)
    macro_ctrl = next((c for c in frontend_cfg.get("_rootControls", [])
                       if c.get("entry_type") == "init_macro"), None)
    include_sync  = sync_ctrl  is not None
    include_macro = macro_ctrl is not None

    submenus = frontend_cfg.get("mainMenu", {}).get("entries", [])

    TIMEOUT = 0.05
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(TIMEOUT)
    sock.bind(("0.0.0.0", 0))

    seq = [0]

    def log_(msg: str):
        progress_cb(msg)

    def _next_jid() -> int:
        seq[0] += 1
        return seq[0]

    def send_raw(cmd: str) -> str | None:
        data = (cmd + "\r").encode()
        sock.sendto(data, (HOST, CMD_PORT))
        responses = []
        while True:
            try:
                pkt, _ = sock.recvfrom(65535)
                responses.append(pkt.decode("utf-8", errors="replace").rstrip("\r\n"))
            except socket.timeout:
                break
        result = responses[0] if responses else None
        ack = result and f"ACK {cmd.split()[0]}" in result
        log_(f"  {'OK  ' if ack else 'FAIL'}  {cmd}  ->  {result or 'TIMEOUT'}")
        return result

    def send_json_pkt(prefix: str, payload: dict, jid: int, desc: str = "") -> bool:
        payload["jsonId"]  = jid
        payload["version"] = VERSION
        msg = (prefix + json.dumps(payload, separators=(",", ":")) + "\r").encode()
        sock.sendto(msg, (HOST, CMD_PORT))

        ack_str  = f"ACK MENU_JSON {jid}"
        deadline = time.monotonic() + 2.0
        responses = []
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            sock.settimeout(min(remaining, TIMEOUT))
            try:
                pkt, _ = sock.recvfrom(65535)
                r = pkt.decode("utf-8", errors="replace").rstrip("\r\n")
                responses.append(r)
                if ack_str in r:
                    break
            except socket.timeout:
                break
        sock.settimeout(TIMEOUT)

        ack   = any(ack_str in r for r in responses)
        label = (prefix + json.dumps(payload, separators=(",", ":")))[:72]
        log_(f"  [{jid:>3}] {'OK  ' if ack else 'FAIL'}  {label}")
        return ack

    try:
        # PRE-PUSH SETTINGS BLOCK
        log_("=== Pre-push device settings")
        r = send_raw("QUERY")
        if not r or "ACK QUERY" not in r:
            return {"ok": False, "error": "No response to QUERY -- device offline?"}

        cm  = frontend_cfg.get("mode", "THIRD_PARTY")
        db  = int(frontend_cfg.get("displayBrightness", 5))
        dt  = int(frontend_cfg.get("displayTimeout", 60))
        sdr = int(frontend_cfg.get("displayRotation", 0))
        lbb = int(frontend_cfg.get("lbBrightness", 5))
        lbt = int(frontend_cfg.get("lbTimeout", 60))
        lpm = 1 if frontend_cfg.get("pinEnabled") else 0
        lp  = str(frontend_cfg.get("pin", "0000")).zfill(4)
        sdn = (frontend_cfg.get("deviceName") or "").strip()

        send_raw(f"SCM {cm}")
        send_raw(f"SCM {cm}")
        send_raw(f"SDB {db}")
        send_raw("SDL 0")
        send_raw(f"SDT {dt}")
        send_raw(f"SDR {sdr}")
        send_raw(f"SLBB {lbb}")
        send_raw(f"SLBT {lbt}")
        if lpm:
            send_raw(f"SLP {lp}")
        send_raw(f"SLPM {lpm}")
        if sdn:
            send_raw(f"SDN {sdn}")

        # BUILD ID LISTS
        log_("=== Building menu IDs")
        all_ids = build_id_list(frontend_cfg, include_vol_mute, include_menu,
                                include_sync, include_macro)

        ctrl_ids: list[int] = []
        if include_menu:
            for nid, _pid, _depth, _pos, node in walk_menu(submenus):
                if node.get("entry_type") == "level":
                    ctrl_ids.append(nid)
        ctrl_ids = sorted(ctrl_ids, reverse=True)
        if include_vol_mute:
            ctrl_ids.append(_ID_ROOT_CTRL)

        id_count = len(all_ids)
        if id_count > 64:
            return {"ok": False,
                    "error": f"MT contains {id_count} IDs which exceeds the device hard limit "
                             f"of 64. Reduce the menu size and try again."}
        if id_count >= 56:
            log_(f"  NOTE: MT contains {id_count} IDs (within 8 of the 64-ID hard limit).")

        total_packets = count_total_packets(
            frontend_cfg, ctrl_ids, include_menu, include_sync, include_macro)
        dl_jid = total_packets

        log_(f"  IDs={id_count}  total_packets={total_packets}  dl_jid={dl_jid}")

        # 1. MT
        log_("=== MT")
        send_json_pkt("MT", {"ids": all_ids}, jid=_next_jid(),
                      desc=f"MT ({id_count} ids)")

        # 2. DL
        log_("=== DL")
        dl_entries = [{"entry": {
            "name":       d["name"],
            "ctrl_ip":    d.get("ip", ""),
            "ctrl_port":  int(d.get("port", 49500)),
            "ctrl_proto": d.get("proto", "udp").lower(),
            "async_ip":   d.get("asyncIp") or d.get("ip", ""),
            "async_port": int(d.get("asyncPort") or d.get("port", 49500)),
            "type":       d.get("type", "general"),
        }} for d in devs]
        if not dl_entries:
            dl_entries = [{"entry": {
                "name": "Device", "ctrl_ip": "0.0.0.0", "ctrl_port": 49500,
                "ctrl_proto": "udp", "async_ip": "0.0.0.0", "async_port": 49500,
                "type": "general",
            }}]
        send_json_pkt("DL", {"entries": dl_entries}, jid=dl_jid, desc="DL device list")

        # 3. MI packets
        log_("=== MI")
        if include_menu:
            parent_to_children: dict = defaultdict(list)
            for nid, parent_id, depth, _pos, node in walk_menu(submenus):
                et       = node.get("entry_type", "action")
                mi_type  = "ctrl" if et == "level" else et
                entry    = {"id": nid, "txt": node.get("display_txt", ""), "type": mi_type}
                parent_to_children[(parent_id, depth)].append((nid, entry))

            sorted_groups = sorted(
                parent_to_children.items(),
                key=lambda x: (-x[0][1], -x[0][0])
            )
            for (parent_id, depth), children in sorted_groups:
                entries = [{"entry": e} for _nid, e in children]
                ids     = [e["entry"]["id"] for e in entries]
                send_json_pkt("MI", {
                    "entries": entries,
                    "first":   ids[0],
                    "last":    ids[-1],
                }, jid=_next_jid(), desc=f"MI children of 0x{parent_id:04X} depth {depth}")

        root_entries = []
        if include_sync:
            root_entries.append({"entry": {
                "id":  _ID_SYNC,
                "txt": (sync_ctrl or {}).get("display_txt", "Sync Action"),
                "type": "sync",
            }})
        if include_macro:
            orig = macro_ctrl or {}
            root_entries.append({"entry": {
                "id":             _ID_INIT_MACRO,
                "txt":            orig.get("display_txt", "Init Macro"),
                "type":           "macro",
                "initMacro":      True,
                "initMacroDelay": int(orig.get("initMacroDelay", 3)),
                "interCmdDelay":  int(orig.get("interCmdDelay", 100)),
            }})
        if include_vol_mute:
            vm = frontend_cfg.get("volMuteScreen") or {}
            root_entries.append({"entry": {
                "id":   _ID_ROOT_CTRL,
                "txt":  vm.get("display_txt", ""),
                "type": "ctrl",
            }})
        if include_menu:
            mm = frontend_cfg.get("mainMenu") or {}
            root_entries.append({"entry": {
                "id":   _ID_TOP_MENU,
                "txt":  mm.get("display_txt", "MAIN MENU"),
                "type": "menu",
            }})
        if root_entries:
            root_ids = [e["entry"]["id"] for e in root_entries]
            send_json_pkt("MI", {
                "entries": root_entries,
                "first":   root_ids[0],
                "last":    root_ids[-1],
            }, jid=_next_jid(), desc="MI root system block")

        # 4. AI packets
        log_("=== AI")
        if include_macro:
            orig       = macro_ctrl or {}
            macro_cmds = orig.get("entries", [])
            m_entries  = [
                {"entry": {
                    "id":       _ID_INIT_MACRO,
                    "type":     "m_action",
                    "m_action": {
                        "idx":    idx,
                        "name":   cmd.get("display_txt", f"CMD {idx}"),
                        "action": {
                            "bin":   cmd.get("binary", False),
                            "bytes": cmd.get("bytes", []),
                            "dev":   cmd.get("dev", ""),
                            "type":  "3rd_party",
                        },
                    },
                }}
                for idx, cmd in enumerate(macro_cmds)
            ]
            if m_entries:
                send_json_pkt("AI", {
                    "entries": m_entries,
                    "first":   _ID_INIT_MACRO,
                    "last":    _ID_INIT_MACRO,
                }, jid=_next_jid(), desc="AI macro commands")

        if include_menu:
            action_groups: dict = defaultdict(list)
            for nid, parent_id, _depth, _pos, node in walk_menu(submenus):
                if node.get("entry_type") == "action":
                    action_groups[parent_id].append((nid, node))
            for parent_id, actions in sorted(action_groups.items(), key=lambda x: -x[0]):
                entries = [{"entry": {
                    "action": {
                        "bin":   node.get("binary", False),
                        "bytes": node.get("bytes", []),
                        "dev":   node.get("dev", ""),
                        "type":  "3rd_party",
                    },
                    "id":   nid,
                    "type": "action",
                }} for nid, node in actions]
                ids = [nid for nid, _ in actions]
                send_json_pkt("AI", {
                    "entries": entries,
                    "first":   ids[0],
                    "last":    ids[-1],
                }, jid=_next_jid(), desc=f"AI actions under 0x{parent_id:04X}")

        # 5. CI/CQ/CA
        log_("=== CI")
        ctrl_params: dict = {}
        if include_vol_mute:
            vm = frontend_cfg.get("volMuteScreen") or {}
            ctrl_params[_ID_ROOT_CTRL] = {
                "vol":      vm.get("level_vol")  or {},
                "mute":     vm.get("level_mute") or {},
                "lvl_pre":  (vm.get("level_vol") or {}).get("levelPreStr", ""),
                "lvl_post": (vm.get("level_vol") or {}).get("levelPostStr", ""),
            }
        if include_menu:
            for nid, _pid, _depth, _pos, node in walk_menu(submenus):
                if node.get("entry_type") == "level":
                    ctrl_params[nid] = {
                        "vol":      node.get("level_vol")  or {},
                        "mute":     node.get("level_mute") or {},
                        "lvl_pre":  (node.get("level_vol") or {}).get("levelPreStr", ""),
                        "lvl_post": (node.get("level_vol") or {}).get("levelPostStr", ""),
                    }

        def _ci(ctrl_id: int, ctrl_type: str, p: dict) -> None:
            if ctrl_type == "vol":
                vol = p["vol"]
                send_json_pkt("CI", {
                    "ack":          False,
                    "ackMask":      [],
                    "active":       vol.get("active", []),
                    "altActive":    vol.get("altActive", []),
                    "altInactive":  vol.get("altInactive", []),
                    "altRespState": bool(vol.get("queryAltResponse", False)),
                    "async":        False,
                    "bin":          False,
                    "cmdMask":      vol.get("setBytes", []),
                    "ctrlType":     "vol",
                    "dev":          vol.get("set_dev_name", ""),
                    "headerTxt":    vol.get("headerText", ""),
                    "id":           ctrl_id,
                    "inactive":     vol.get("inactive", []),
                    "lvlPostStr":   p["lvl_post"],
                    "lvlPreStr":    p["lvl_pre"],
                    "max":          float(vol.get("maxParam", 0.0)),
                    "min":          float(vol.get("minParam", -30.0)),
                    "paramDecPt":   int(vol.get("paramDecPts", 0)),
                    "query":        bool(vol.get("queryEnable", False)),
                    "step":         float(vol.get("stepSize", 1.0)),
                    "trim":         bool(vol.get("trimEnable", False)),
                    "type":         "stateless",
                }, jid=_next_jid(), desc=f"CI 0x{ctrl_id:04X} vol")
            else:  # mute
                mute = p["mute"]
                send_json_pkt("CI", {
                    "ack":          False,
                    "ackMask":      [],
                    "active":       mute.get("active", []),
                    "altActive":    mute.get("altActive", []),
                    "altInactive":  mute.get("altInactive", []),
                    "altRespState": False,
                    "async":        False,
                    "bin":          False,
                    "cmdMask":      [],
                    "ctrlType":     "mute",
                    "dev":          mute.get("set_dev_name", ""),
                    "headerTxt":    "",
                    "id":           ctrl_id,
                    "inactive":     mute.get("inactive", []),
                    "lvlPostStr":   "",
                    "lvlPreStr":    "",
                    "max":          0.0,
                    "min":          0.0,
                    "paramDecPt":   0,
                    "query":        False,
                    "step":         0.0,
                    "trim":         False,
                    "type":         "stateless",
                }, jid=_next_jid(), desc=f"CI 0x{ctrl_id:04X} mute")

        for ci_id in ctrl_ids:
            p = ctrl_params.get(ci_id, {"vol": {}, "mute": {}, "lvl_pre": "", "lvl_post": ""})
            _ci(ci_id, "vol",  p)
            _ci(ci_id, "mute", p)

        log_("=== CQ")
        for ci_id in ctrl_ids:
            p   = ctrl_params.get(ci_id, {"vol": {}})
            vol = p["vol"]
            send_json_pkt("CQ", {
                "altRespState": False,
                "bin":          False,
                "cmdMask":      vol.get("queryBytes", []),
                "ctrlType":     "vol",
                "dev":          vol.get("set_dev_name", ""),
                "id":           ci_id,
                "pollMsec":     int(vol.get("pollMs", 500)),
                "respMask":     vol.get("respQueryBytes", []),
            }, jid=_next_jid(), desc=f"CQ 0x{ci_id:04X} vol")
            send_json_pkt("CQ", {
                "altRespState": False,
                "bin":          False,
                "cmdMask":      [],
                "ctrlType":     "mute",
                "dev":          (p.get("mute") or {}).get("set_dev_name", ""),
                "id":           ci_id,
                "pollMsec":     500,
                "respMask":     [],
            }, jid=_next_jid(), desc=f"CQ 0x{ci_id:04X} mute")

        log_("=== CA")
        for ci_id in ctrl_ids:
            p   = ctrl_params.get(ci_id, {"vol": {}})
            vol = p["vol"]
            send_json_pkt("CA", {
                "altRespState": False,
                "bin":          False,
                "ctrlType":     "vol",
                "dev":          vol.get("set_dev_name", ""),
                "id":           ci_id,
                "matchSrc":     True,
                "msgMask":      vol.get("respQueryBytes", []),
            }, jid=_next_jid(), desc=f"CA 0x{ci_id:04X} vol")
            send_json_pkt("CA", {
                "altRespState": False,
                "bin":          False,
                "ctrlType":     "mute",
                "dev":          (p.get("mute") or {}).get("set_dev_name", ""),
                "id":           ci_id,
                "matchSrc":     True,
                "msgMask":      [],
            }, jid=_next_jid(), desc=f"CA 0x{ci_id:04X} mute")

        # 6. Sync CI/CQ/CA
        if include_sync:
            log_("=== Sync CI/CQ/CA")
            orig       = sync_ctrl or {}
            init_sync  = orig.get("init_sync", {})
            active_b   = init_sync.get("activeBytes",   list(b"ACTIVE\r"))
            inactive_b = init_sync.get("inactiveBytes", list(b"INACTIVE\r"))
            sync_dev   = orig.get("dev", "")

            send_json_pkt("CI", {
                "active":       active_b,
                "altActive":    [],
                "altInactive":  [],
                "altRespState": False,
                "async":        False,
                "bin":          False,
                "ctrlType":     "sync",
                "dev":          sync_dev,
                "id":           _ID_SYNC,
                "inactive":     inactive_b,
                "query":        False,
                "type":         "stateless",
            }, jid=_next_jid(), desc="CI sync")

            send_json_pkt("CQ", {
                "bin":      False,
                "cmdMask":  init_sync.get("queryBytes", []),
                "ctrlType": "sync",
                "dev":      sync_dev,
                "id":       _ID_SYNC,
                "pollMsec": 500,
                "respMask": [],
            }, jid=_next_jid(), desc="CQ sync")

            send_json_pkt("CA", {
                "bin":      False,
                "ctrlType": "sync",
                "dev":      sync_dev,
                "id":       _ID_SYNC,
                "matchSrc": True,
                "msgMask":  [],
            }, jid=_next_jid(), desc="CA sync")

        # 7. SF 1
        log_("=== SF")
        sock.sendto(b"SF 1\r", (HOST, CMD_PORT))
        log_("  [SF ]       SF 1")

        result_json = None
        got_sf_ack  = False
        deadline    = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(min(remaining, 0.5))
            try:
                raw, _ = sock.recvfrom(65535)
                r = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                log_(f"              << {r[:120]!r}")
                if "ACK SF" in r:
                    got_sf_ack = True
                if r.strip().startswith("{"):
                    try:
                        result_json = json.loads(r.strip())
                        break
                    except json.JSONDecodeError:
                        pass
            except socket.timeout:
                pass
        sock.settimeout(TIMEOUT)

        if result_json:
            jids = result_json.get("json_ids", [])
            rids = result_json.get("result_ids", [])
            bad  = [(jids[i], rids[i]) for i in range(len(rids)) if rids[i] != 0]
            if bad:
                log_(f"  DEVICE REPORTED {len(bad)} ERROR(S): {bad}")
            else:
                log_(f"  Device accepted all {len(jids)} tracked packets.")
        else:
            log_("  WARNING: No result JSON received from device.")

        # Post-SF: SCM + SMID
        send_raw(f"SCM {cm}")
        h = uuid.uuid4().hex
        h = uuid.uuid4().hex  # second assignment matches original
        sock.settimeout(1.0)
        sock.sendto(f"SMID {h}\r".encode(), (HOST, CMD_PORT))
        smid_resp = []
        try:
            pkt, _ = sock.recvfrom(65535)
            smid_resp.append(pkt.decode("utf-8", errors="replace").rstrip("\r\n"))
        except socket.timeout:
            pass
        sock.settimeout(TIMEOUT)
        smid_ok = any("ACK SMID" in r for r in smid_resp)
        log_(f"  {'OK  ' if smid_ok else 'WARN'}  SMID {h}  ->  "
             f"{smid_resp[0] if smid_resp else 'no response'}")

        log_(f"OK  Config committed. Hash: {h}")
        return {"ok": True, "hash": h, "error": None}

    except Exception as exc:
        log.exception("Push failed")
        return {"ok": False, "error": str(exc), "hash": None}
    finally:
        sock.close()

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
  5. CI/CQ/CA -- control parameters (mute before vol, 0xFFFE last)
  6. Sync CI/CQ/CA
  7. SF 1 -- finalize/commit
  Post-SF: SCM + SMID
"""

import hashlib
import json
import socket
import time
from collections import defaultdict

from .config import CMD_PORT, log

# System IDs (confirmed from pcap)
_ID_TOP_MENU   = 0xFFFF   # main menu container
_ID_ROOT_CTRL  = 0xFFFE   # root vol/mute screen
_ID_SYNC       = 0xFFFD   # startup sync action
_ID_INIT_MACRO = 0xFFFB   # init macro

VERSION = "1.0.0"

# Error code table (mirrors reference push.py)
RESULT_ERRORS = {
    0:  "OK",
    4:  "MT rejected (malformed MT packet; NOT caused by the 64-ID silent truncation)",
    7:  "Orphaned packet (parent ID not registered by MT, or MT itself failed)",
    19: "DL entry count exceeded, or AI/MA action references an overflowed DL entry.",
}


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

        action_counts: dict = {}
        for _nid, parent_id, _depth, _pos, node in walk_menu(submenus):
            if node.get("entry_type") == "action":
                action_counts[parent_id] = action_counts.get(parent_id, 0) + 1
        for cnt in action_counts.values():
            n_ai += (cnt + 3) // 4  # ceil(n / 4): each parent chunked at 4 entries

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
# PushSession: packet log + structured error reporting
# ---------------------------------------------------------------------------

class PushSession:
    """
    Tracks every JSON packet sent (jid, prefix, desc, ack_ok) so that
    report_errors() can map device result_ids back to human-readable context.
    Mirrors the PushSession class in the reference push.py.
    """

    def __init__(self):
        self.log: list[tuple[int, str, str, bool]] = []  # (jid, prefix, desc, ack_ok)

    def record(self, jid: int, prefix: str, desc: str, ack_ok: bool) -> None:
        self.log.append((jid, prefix, desc, ack_ok))


def report_errors(result_json: dict | None, session: PushSession, log_fn) -> list[tuple]:
    """
    Structured error report matching the reference push.py report_errors().
    Maps each failed jsonId back to the packet description from the session log,
    identifies error codes with human-readable meanings, and detects MT-cascade
    failures where a single MT rejection orphans all downstream packets.

    Returns the list of (jid, code) failure tuples (empty on clean push).
    """
    if not result_json:
        log_fn("  WARNING: No result JSON received from device.")
        return []

    jids = result_json.get("json_ids", [])
    rids = result_json.get("result_ids", [])

    log_map = {jid: (prefix, desc) for jid, prefix, desc, _ in session.log}
    failures = [(jids[i], rids[i]) for i in range(len(rids)) if rids[i] != 0]

    if not failures:
        log_fn(f"  Device accepted all {len(jids)} tracked packets.")
        return []

    log_fn(f"  DEVICE REPORTED {len(failures)} ERROR(S):")
    for jid, code in failures:
        prefix, desc = log_map.get(jid, ("??", "unknown packet"))
        meaning = RESULT_ERRORS.get(code, f"unknown error code {code}")
        log_fn(f"    jsonId={jid:3d}  code={code}  [{prefix}]  {desc}")
        log_fn(f"             -> {meaning}")

    # Cascade analysis: MT rejection (code 4) orphans all downstream packets (code 7)
    if any(code == 4 for _, code in failures):
        cascade = [(j, c) for j, c in failures if c == 7]
        log_fn(f"  Root cause: MT rejected (result=4). "
               f"{len(cascade)} downstream packet(s) orphaned as cascade (result=7).")
        log_fn(f"  The 64-ID hard limit does NOT produce error 4 (silent truncation).")
        log_fn(f"  Check MT packet structure.")
    elif any(code == 7 for _, code in failures):
        log_fn(f"  Orphaned packets: these reference IDs not registered in MT.")
        log_fn(f"  Verify all IDs in MI/AI packets appear in the MT ids array.")

    return failures


def _verify(sock, host: str, port: int, timeout: float, log_fn) -> None:
    """
    Post-push readback: GMIID + GMID confirm device registered the menu.
    Mirrors the verify() function in the reference push.py.
    """
    log_fn("=== Verify")
    for cmd in ("GMIID", "GMID"):
        data = (cmd + "\r").encode()
        sock.sendto(data, (host, port))
        sock.settimeout(timeout)
        while True:
            try:
                pkt, _ = sock.recvfrom(65535)
                r = pkt.decode("utf-8", errors="replace").rstrip("\r\n")
                log_fn(f"  {r}")
            except socket.timeout:
                break


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

    seq      = [0]
    session  = PushSession()
    _hash_buf = bytearray()
    _cq_objs  = []

    def log_(msg: str):
        progress_cb(msg)

    def _next_jid() -> int:
        seq[0] += 1
        return seq[0]

    def send_raw(cmd: str) -> list[str]:
        """Send a plain ASCII command; collect all responses until 50ms silence."""
        data = (cmd + "\r").encode()
        sock.sendto(data, (HOST, CMD_PORT))
        responses = []
        while True:
            try:
                pkt, _ = sock.recvfrom(65535)
                responses.append(pkt.decode("utf-8", errors="replace").rstrip("\r\n"))
            except socket.timeout:
                break
        ack = any(f"ACK {cmd.split()[0]}" in r for r in responses)
        first = responses[0] if responses else "TIMEOUT"
        log_(f"  {'OK  ' if ack else 'FAIL'}  {cmd}  ->  {first}")
        return responses

    def send_json_pkt(prefix: str, payload: dict, jid: int, desc: str = "") -> bool:
        payload["jsonId"]  = jid
        payload["version"] = VERSION
        body = prefix + json.dumps(payload, sort_keys=True, separators=(",", ":"))
        msg  = (body + "\r").encode()
        if prefix != "CA":
            _hash_buf.extend(body.encode())
        if prefix == "CQ":
            _cq_objs.append(dict(payload))
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
        session.record(jid, prefix, desc or label, ack)
        return ack

    try:
        # PRE-PUSH SETTINGS BLOCK
        log_("=== Pre-push device settings")
        r = send_raw("QUERY")
        if not any("ACK QUERY" in x for x in r):
            return {"ok": False, "error": "No response to QUERY -- device offline?"}

        cm  = frontend_cfg.get("mode", "THIRD_PARTY")
        db  = int(frontend_cfg.get("displayBrightness", 5))
        dl  = int(frontend_cfg.get("displayLevelEnabled", 0))
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
        send_raw(f"SDL {dl}")
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
        ctrl_ids = sorted(ctrl_ids, key=lambda x: (-(x & 0xF), -((x >> 4) & 0xF)))
        if include_vol_mute:
            ctrl_ids.append(_ID_ROOT_CTRL)

        id_count = len(all_ids)
        if id_count > 64:
            return {"ok": False,
                    "error": f"MT contains {id_count} IDs which exceeds the device hard limit "
                             f"of 64. Reduce the menu size and try again."}
        elif id_count == 64:
            log_(f"  NOTE: MT contains {id_count} IDs (at the hard limit of 64).")
        elif id_count >= 56:
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
        # Jid assignment order (Unify): root MI first (lowest jid), then depth-1, then depth-2
        # ascending col. Wire send order: depth-1 first, depth-2 descending col, root last.
        log_("=== MI")
        if include_menu:
            parent_to_children: dict = defaultdict(list)
            for nid, parent_id, depth, _pos, node in walk_menu(submenus):
                et       = node.get("entry_type", "action")
                mi_type  = "ctrl" if et == "level" else et
                entry    = {"id": nid, "txt": node.get("display_txt", ""), "type": mi_type}
                parent_to_children[(parent_id, depth)].append((nid, entry))

            # Wire send order: depth asc, parent_id desc within each depth
            sorted_groups = sorted(
                parent_to_children.items(),
                key=lambda x: (x[0][1], -x[0][0])
            )

        # Build root_entries first so we know if a root MI exists
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

        # Pre-assign MI jids in assignment order: root first, then depth-1, then depth-2
        # ascending col (ascending parent_id within depth-2).
        mi_jid_root = _next_jid() if root_entries else None
        mi_jid_by_group: dict = {}
        if include_menu:
            for (parent_id, depth), _ in sorted(sorted_groups, key=lambda x: (x[0][1], x[0][0])):
                mi_jid_by_group[(parent_id, depth)] = _next_jid()

        # Send MI packets in wire order using pre-assigned jids
        if include_menu:
            for (parent_id, depth), children in sorted_groups:
                entries = [{"entry": e} for _nid, e in children]
                ids     = [e["entry"]["id"] for e in entries]
                send_json_pkt("MI", {
                    "entries": entries,
                    "first":   ids[0],
                    "last":    ids[-1],
                }, jid=mi_jid_by_group[(parent_id, depth)],
                   desc=f"MI children of 0x{parent_id:04X} depth {depth}")

        if root_entries:
            root_ids = [e["entry"]["id"] for e in root_entries]
            send_json_pkt("MI", {
                "entries": root_entries,
                "first":   root_ids[0],
                "last":    root_ids[-1],
            }, jid=mi_jid_root, desc="MI root system block")

        # 4. AI packets
        # Jid assignment order (Unify): reverse of send order — last chunk sent gets lowest jid.
        log_("=== AI")
        ai_queue: list = []  # collect (entries, first, last, desc) before sending

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
                            "dev":   "",
                            "type":  "3rd_party",
                        },
                    },
                }}
                for idx, cmd in enumerate(macro_cmds)
            ]
            if m_entries:
                ai_queue.append({"entries": m_entries, "first": _ID_INIT_MACRO,
                                 "last": _ID_INIT_MACRO, "desc": "AI macro commands"})

        if include_menu:
            action_groups: dict = defaultdict(list)
            for nid, parent_id, _depth, _pos, node in walk_menu(submenus):
                if node.get("entry_type") == "action":
                    action_groups[parent_id].append((nid, node))
            for parent_id, actions in sorted(action_groups.items(), key=lambda x: -x[0]):
                def _action_bytes(node: dict) -> list[int]:
                    bts = list(node.get("bytes", []))
                    if not node.get("binary", False):
                        bts = [b for b in bts if b != 0]  # null bytes invalid in ASCII commands
                    if node.get("cr", False) and (not bts or bts[-1] != 0x0d):
                        bts.append(0x0d)
                    if node.get("lf", False) and (not bts or bts[-1] != 0x0a):
                        bts.append(0x0a)
                    return bts[:64]  # device rejects payloads > 64 bytes (error 17)
                all_entries = [{"entry": {
                    "action": {
                        "bin":   node.get("binary", False),
                        "bytes": _action_bytes(node),
                        "dev":   "",
                        "type":  "3rd_party",
                    },
                    "id":   nid,
                    "type": "action",
                }} for nid, node in actions]
                all_ids = [nid for nid, _ in actions]
                # Unify chunks AI at 4 entries max, highest-nid chunk first, ascending within chunk
                sorted_desc = sorted(zip(all_ids, all_entries), key=lambda x: -x[0])
                for chunk_start in range(0, len(sorted_desc), 4):
                    chunk = sorted(sorted_desc[chunk_start:chunk_start+4], key=lambda x: x[0])
                    c_ids = [nid for nid, _ in chunk]
                    c_entries = [e for _, e in chunk]
                    ai_queue.append({"entries": c_entries, "first": c_ids[0],
                                     "last": c_ids[-1], "desc": f"AI actions under 0x{parent_id:04X}"})

        # Pre-assign AI jids in reverse send order (last chunk → lowest jid)
        n_ai = len(ai_queue)
        ai_jids_pool = [_next_jid() for _ in range(n_ai)]
        ai_send_jids = list(reversed(ai_jids_pool))  # first chunk sent gets highest jid

        for i, pkt in enumerate(ai_queue):
            send_json_pkt("AI", {"entries": pkt["entries"], "first": pkt["first"],
                                 "last": pkt["last"]},
                          jid=ai_send_jids[i], desc=pkt["desc"])

        # 5. CI/CQ/CA
        log_("=== CI")
        ctrl_params: dict = {}
        if include_vol_mute:
            vm = frontend_cfg.get("volMuteScreen") or {}
            ctrl_params[_ID_ROOT_CTRL] = {
                "vol":      vm.get("level_vol")  or {},
                "mute":     vm.get("level_mute") or {},
                "lvl_pre":  (vm.get("level_vol") or {}).get("levelPreStr", "")[:7],
                "lvl_post": (vm.get("level_vol") or {}).get("levelPostStr", "")[:7],
            }
        if include_menu:
            for nid, _pid, _depth, _pos, node in walk_menu(submenus):
                if node.get("entry_type") == "level":
                    ctrl_params[nid] = {
                        "vol":      node.get("level_vol")  or {},
                        "mute":     node.get("level_mute") or {},
                        "lvl_pre":  (node.get("level_vol") or {}).get("levelPreStr", "")[:7],
                        "lvl_post": (node.get("level_vol") or {}).get("levelPostStr", "")[:7],
                    }

        # Pre-assign CI/CQ/CA jids in reverse send order (first ctrl sent gets highest jid).
        # Send order per ctrl_id: mute first, then vol.
        # Jid formula for ctrl_id at send position k (0-indexed):
        #   mute jid = pool[n_ci - 1 - 2*k]
        #   vol  jid = pool[n_ci - 2 - 2*k]
        n_ci = len(ctrl_ids) * 2
        ci_jids_pool = [_next_jid() for _ in range(n_ci)]
        cq_jids_pool = [_next_jid() for _ in range(n_ci)]
        ca_jids_pool = [_next_jid() for _ in range(n_ci)]

        def _ctrl_jid(pool: list, k: int, ctrl_type: str) -> int:
            n = len(pool)
            return pool[n - 1 - 2*k] if ctrl_type == "mute" else pool[n - 2 - 2*k]

        def _jnum(v) -> int | float:
            """Qt5 serializes integer-valued floats as integers (no decimal point)."""
            f = float(v)
            return int(f) if f == int(f) else f

        def _ci(ctrl_id: int, ctrl_type: str, p: dict, jid: int) -> None:
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
                    "cmdMask":      [],
                    "ctrlType":     "vol",
                    "dev":          "",
                    "headerTxt":    vol.get("headerText", ""),
                    "id":           ctrl_id,
                    "inactive":     vol.get("inactive", []),
                    "lvlPostStr":   p["lvl_post"],
                    "lvlPreStr":    p["lvl_pre"],
                    "max":          _jnum(vol.get("maxParam", 0.0)),
                    "min":          _jnum(vol.get("minParam", -30.0)),
                    "paramDecPt":   int(vol.get("paramDecPts", 0)),
                    "query":        False,
                    "step":         _jnum(vol.get("stepSize", 1.0)),
                    "trim":         bool(vol.get("trimEnable", False)),
                    "type":         "stateless",
                }, jid=jid, desc=f"CI 0x{ctrl_id:04X} vol")
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
                    "dev":          "",
                    "headerTxt":    "",
                    "id":           ctrl_id,
                    "inactive":     mute.get("inactive", []),
                    "lvlPostStr":   "",
                    "lvlPreStr":    "",
                    "max":          0,
                    "min":          0,
                    "paramDecPt":   0,
                    "query":        False,
                    "step":         0,
                    "trim":         False,
                    "type":         "stateless",
                }, jid=jid, desc=f"CI 0x{ctrl_id:04X} mute")

        for k, ci_id in enumerate(ctrl_ids):
            p = ctrl_params.get(ci_id, {"vol": {}, "mute": {}, "lvl_pre": "", "lvl_post": ""})
            _ci(ci_id, "mute", p, jid=_ctrl_jid(ci_jids_pool, k, "mute"))
            _ci(ci_id, "vol",  p, jid=_ctrl_jid(ci_jids_pool, k, "vol"))

        log_("=== CQ")
        for k, ci_id in enumerate(ctrl_ids):
            p   = ctrl_params.get(ci_id, {"vol": {}})
            vol = p["vol"]
            send_json_pkt("CQ", {
                "altRespState": False,
                "bin":          False,
                "cmdMask":      [],
                "ctrlType":     "mute",
                "dev":          "",
                "id":           ci_id,
                "pollMsec":     500,
                "respMask":     [],
            }, jid=_ctrl_jid(cq_jids_pool, k, "mute"), desc=f"CQ 0x{ci_id:04X} mute")
            send_json_pkt("CQ", {
                "altRespState": False,
                "bin":          False,
                "cmdMask":      vol.get("queryBytes", []),
                "ctrlType":     "vol",
                "dev":          "",
                "id":           ci_id,
                "pollMsec":     int(vol.get("pollMs", 500)),
                "respMask":     vol.get("respQueryBytes", []),
            }, jid=_ctrl_jid(cq_jids_pool, k, "vol"), desc=f"CQ 0x{ci_id:04X} vol")

        log_("=== CA")
        for k, ci_id in enumerate(ctrl_ids):
            p   = ctrl_params.get(ci_id, {"vol": {}})
            vol = p["vol"]
            send_json_pkt("CA", {
                "altRespState": False,
                "bin":          False,
                "ctrlType":     "mute",
                "dev":          "",
                "id":           ci_id,
                "matchSrc":     True,
                "msgMask":      [],
            }, jid=_ctrl_jid(ca_jids_pool, k, "mute"), desc=f"CA 0x{ci_id:04X} mute")
            send_json_pkt("CA", {
                "altRespState": False,
                "bin":          False,
                "ctrlType":     "vol",
                "dev":          "",
                "id":           ci_id,
                "matchSrc":     True,
                "msgMask":      vol.get("respQueryBytes", []),
            }, jid=_ctrl_jid(ca_jids_pool, k, "vol"), desc=f"CA 0x{ci_id:04X} vol")

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

        failures = report_errors(result_json, session, log_)

        # Post-SF: SCM + SMID
        send_raw(f"SCM {cm}")

        def compute_smid() -> str:
            buf  = bytes(_hash_buf)
            n_cq = len(_cq_objs)
            for cq in _cq_objs:
                ca = {
                    "altRespState": cq.get("altRespState", False),
                    "bin":          cq["bin"],
                    "ctrlType":     cq["ctrlType"],
                    "dev":          cq["dev"],
                    "id":           cq["id"],
                    "jsonId":       cq["jsonId"] + n_cq,
                    "matchSrc":     True,
                    "msgMask":      cq.get("respMask", []),
                    "version":      VERSION,
                }
                buf += b"CA" + json.dumps(ca, sort_keys=True, separators=(",", ":")).encode()
            buf += b"SF 1\r"
            log_(f"  [SMID debug] hash input ({len(buf)} bytes): {buf.hex()}")
            return hashlib.md5(buf).hexdigest()

        smid_hash = compute_smid()
        log_(f"  SMID (computed): {smid_hash}")
        sock.sendto(f"SMID {smid_hash}\r".encode(), (HOST, CMD_PORT))
        smid_ack = False
        smid_deadline = time.monotonic() + 1.0
        while time.monotonic() < smid_deadline:
            sock.settimeout(min(smid_deadline - time.monotonic(), 0.5))
            try:
                pkt, _ = sock.recvfrom(65535)
                r = pkt.decode("utf-8", errors="replace").rstrip("\r\n")
                if "ACK SMID" in r:
                    smid_ack = True
                    break
            except socket.timeout:
                break
        sock.settimeout(TIMEOUT)
        first_smid = "ACK SMID" if smid_ack else "TIMEOUT"
        log_(f"  {'OK  ' if smid_ack else 'FAIL'}  SMID {smid_hash}  ->  {first_smid}")
        if not smid_ack:
            log_("  WARN  SMID no response")

        # Post-push verify: confirm device registered the menu
        _verify(sock, HOST, CMD_PORT, TIMEOUT, log_)

        log_("OK  Config committed.")
        return {"ok": True, "hash": smid_hash, "error": None,
                "push_errors": [(j, c) for j, c in failures]}

    except Exception as exc:
        log.exception("Push failed")
        return {"ok": False, "error": str(exc), "hash": None}
    finally:
        sock.close()

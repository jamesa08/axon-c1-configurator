#!/usr/bin/env python3
"""
axon_c1.py  --  AxonC1 protocol harness.

Compiles a .cfg XML snapshot file into the exact UDP packet sequence the
official configurator sends, then pushes it to the device.

Usage:
    python3 axon_c1.py <device_ip> <config.cfg> [options]
    python3 axon_c1.py 192.168.80.209 my_menu.cfg
    python3 axon_c1.py 192.168.80.209 my_menu.cfg --dry-run
    python3 axon_c1.py 192.168.80.209 my_menu.cfg --no-verify --port 49494

Options:
    --port       UDP port (default: 49494)
    --timeout    Per-packet ACK wait seconds (default: 2.0)
    --dry-run    Print packets without sending
    --no-verify  Send without waiting for ACKs
    --dump       Dump compiled packet list and exit (no send)
"""

import argparse
import json
import socket
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

CMD_PORT = 49494
VERSION  = "1.0.0"

# ---------------------------------------------------------------------------
# Reserved IDs (fixed, match the official configurator exactly)
# ---------------------------------------------------------------------------
ID_CTRL_ROOT = 0xFFFE   # root-level hidden vol/mute control
ID_SYNC      = 0xFFFD   # sync action
ID_MACRO     = 0xFFFB   # init macro
ID_MENU_ROOT = 0xFFFF   # top-level menu container (CustomTitle etc.)

# Menu node IDs: 0xFFF0 for depth-1, 0xFF00 for depth-2, 0xF000 for depth-3.
# Formula: menu_id(depth) = 0xFFF0 >> (depth * 4), masked to 16 bits.
# Max useful depth is 3 before it collides with ctrl space.
def menu_id_for_depth(depth: int) -> int:
    # depth 1 -> 0xFFF0, depth 2 -> 0xFF00, depth 3 -> 0xF000
    return 0xFFFF & ~((1 << (depth * 4)) - 1)

# Control/action IDs: start at 0x0000, step 0x1000 each.
CTRL_START = 0x0000
CTRL_STEP  = 0x1000


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
@dataclass
class CtrlConfig:
    ctrl_type:    str
    min_param:    int  = 0
    max_param:    int  = 0
    step:         int  = 0
    poll_ms:      int  = 500
    ack:          bool = False
    query:        bool = False
    trim:         bool = False
    async_en:     bool = False
    alt_resp:     bool = False
    bin_mode:     bool = False
    header_txt:   str  = ""
    lvl_pre:      str  = ""
    lvl_post:     str  = ""
    param_dec:    int  = 0
    active:       list = field(default_factory=list)
    inactive:     list = field(default_factory=list)
    alt_active:   list = field(default_factory=list)
    alt_inactive: list = field(default_factory=list)
    ci_cmd_mask:  list = field(default_factory=list)  # setBytes -> CI cmdMask
    cq_cmd_mask:  list = field(default_factory=list)  # queryBytes -> CQ cmdMask (sync only)
    ack_mask:     list = field(default_factory=list)
    dev:          str  = ""


@dataclass
class ActionConfig:
    display_txt: str
    bytes_data:  list = field(default_factory=list)
    bin_mode:    bool = False
    dev:         str  = ""


@dataclass
class MacroConfig:
    display_txt:       str
    init_macro_delay:  int  = 3
    inter_cmd_delay:   int  = 100
    actions:           list = field(default_factory=list)


@dataclass
class CtrlItem:
    display_txt: str
    ctrl_id:     int  = 0
    vol:         Optional[CtrlConfig] = None
    mute:        Optional[CtrlConfig] = None


@dataclass
class ActionItem:
    display_txt: str
    action_id:   int  = 0
    action:      Optional[ActionConfig] = None


@dataclass
class MenuNode:
    display_txt: str
    depth:       int  = 0
    node_id:     int  = 0
    children:    list = field(default_factory=list)


# ---------------------------------------------------------------------------
# CFG parser
# ---------------------------------------------------------------------------

def _parse_ctrl(obj: dict, ctrl_type: str) -> CtrlConfig:
    return CtrlConfig(
        ctrl_type    = ctrl_type,
        min_param    = obj.get("minParam", 0),
        max_param    = obj.get("maxParam", 0),
        step         = obj.get("stepSize", 0),
        poll_ms      = obj.get("pollMs", 500),
        ack          = obj.get("ackEnable", False),
        query        = obj.get("queryEnable", False),
        trim         = obj.get("trimEnable", False),
        async_en     = obj.get("asyncEnable", False),
        alt_resp     = obj.get("asyncAltResponse", False),
        bin_mode     = obj.get("binary", False),
        header_txt   = obj.get("headerText", ""),
        lvl_pre      = obj.get("levelPreStr", ""),
        lvl_post     = obj.get("levelPostStr", ""),
        param_dec    = obj.get("paramDecPts", 0),
        active       = obj.get("active", []),
        inactive     = obj.get("inactive", []),
        alt_active   = obj.get("altActive", []),
        alt_inactive = obj.get("altInactive", []),
        ci_cmd_mask  = obj.get("setBytes", []),
        cq_cmd_mask  = obj.get("queryBytes", []),  # only non-empty for sync
        ack_mask     = obj.get("respBytes", []),
        dev          = obj.get("set_dev_name", ""),
    )


def _parse_menu_entries(entries: list, depth: int) -> list:
    """
    Recursively parse cfg entry list.
    Returns list of (kind, obj) where kind is 'menu'|'ctrl'|'action'.
    depth is the sub-menu depth (1 = first level under main_menu).
    """
    result = []
    i = 0
    while i < len(entries):
        e = entries[i]
        etype = e.get("entry_type", "")

        if etype == "menu":
            node = MenuNode(
                display_txt = e["display_txt"],
                depth       = depth,
                children    = _parse_menu_entries(e.get("entries", []), depth + 1),
            )
            result.append(("menu", node))

        elif etype == "level":
            vol_obj  = e.get("level_vol")
            mute_obj = e.get("level_mute")
            txt      = e["display_txt"]

            # level entries may come in vol+mute pairs on consecutive entries
            if vol_obj and not mute_obj:
                if i + 1 < len(entries) and "level_mute" in entries[i + 1]:
                    mute_obj = entries[i + 1]["level_mute"]
                    i += 1
            elif mute_obj and not vol_obj:
                if i + 1 < len(entries) and "level_vol" in entries[i + 1]:
                    vol_obj = entries[i + 1]["level_vol"]
                    i += 1

            item = CtrlItem(
                display_txt = txt,
                vol  = _parse_ctrl(vol_obj,  "vol")  if vol_obj  else None,
                mute = _parse_ctrl(mute_obj, "mute") if mute_obj else None,
            )
            result.append(("ctrl", item))

        elif etype == "action":
            act = ActionConfig(
                display_txt = e["display_txt"],
                bytes_data  = e.get("bytes", []),
                bin_mode    = e.get("binary", False),
                dev         = e.get("dev", ""),
            )
            result.append(("action", act))

        i += 1
    return result


def parse_cfg(path: str) -> dict:
    tree = ET.parse(path)
    root = tree.getroot()
    data = root.find("SNAPSHOT_DATA")
    cm        = data.findtext("CM", "THIRD_PARTY")
    raw_menu  = data.findtext("MENU_CONFIG", "")
    menu_json = json.loads(raw_menu)
    return {"cm": cm, "menu_json": menu_json}


# ---------------------------------------------------------------------------
# Packet compiler
# ---------------------------------------------------------------------------

class PacketCompiler:

    def __init__(self, menu_json: dict, cm: str, smid: str):
        self.menu_json = menu_json
        self.cm        = cm
        self.smid      = smid
        self._jid      = 0
        self._next_ctrl_id = CTRL_START

        # Collected per phase
        self._all_menu_ids:  list = []   # menu node IDs in MT order
        self._all_ctrl_ids:  list = []   # ctrl/action IDs in MT order (for MT)
        self._gli_ctrl_ids:  list = []   # ctrl IDs only (not actions) for GLI
        self._mi_sub:        list = []   # MI packets for sub-menus
        self._mi_leaf:       tuple = ()  # MI for leaf ctrl/action items
        self._mi_root:       tuple = ()  # MI for root group
        self._ai_leaf:       list = []   # AI for leaf actions
        self._ai_macro:      tuple = ()  # AI for macro sub-actions
        self._ci_items:      list = []   # (ctrl_id, CtrlConfig) pairs
        self._cq_items:      list = []
        self._ca_items:      list = []

        # Special top-level entries
        self._root_vol:   Optional[CtrlConfig] = None
        self._root_mute:  Optional[CtrlConfig] = None
        self._sync_ctrl:  Optional[CtrlConfig] = None
        self._sync_txt:   str = "Sync Action"
        self._macro_cfg:  Optional[MacroConfig] = None
        self._main_menu:  Optional[MenuNode] = None

    def _next_jid(self) -> int:
        self._jid += 1
        return self._jid

    def _alloc_ctrl(self) -> int:
        v = self._next_ctrl_id
        self._next_ctrl_id += CTRL_STEP
        return v

    # -- JSON packet serialisers ------------------------------------------

    def _mt(self, ids: list) -> tuple:
        jid = self._next_jid()
        return True, f"MT{json.dumps({'ids':ids,'jsonId':jid,'version':VERSION}, separators=(',',':'))}".encode()

    def _mi(self, entries: list, first, last) -> tuple:
        jid = self._next_jid()
        obj = {"entries": entries, "first": first, "jsonId": jid,
               "last": last, "version": VERSION}
        return True, f"MI{json.dumps(obj, separators=(',',':'))}".encode()

    def _ai(self, entries: list, first, last) -> tuple:
        jid = self._next_jid()
        obj = {"entries": entries, "first": first, "jsonId": jid,
               "last": last, "version": VERSION}
        return True, f"AI{json.dumps(obj, separators=(',',':'))}".encode()

    def _ci(self, ctrl_id: int, cc: CtrlConfig) -> tuple:
        jid = self._next_jid()
        obj = {
            "ack":          cc.ack,
            "ackMask":      cc.ack_mask,
            "active":       cc.active,
            "altActive":    cc.alt_active,
            "altInactive":  cc.alt_inactive,
            "altRespState": cc.alt_resp,
            "async":        cc.async_en,
            "bin":          cc.bin_mode,
            "cmdMask":      cc.ci_cmd_mask,
            "ctrlType":     cc.ctrl_type,
            "dev":          cc.dev,
            "headerTxt":    cc.header_txt,
            "id":           ctrl_id,
            "inactive":     cc.inactive,
            "jsonId":       jid,
            "lvlPostStr":   cc.lvl_post,
            "lvlPreStr":    cc.lvl_pre,
            "max":          cc.max_param,
            "min":          cc.min_param,
            "paramDecPt":   cc.param_dec,
            "query":        cc.query,
            "step":         cc.step,
            "trim":         cc.trim,
            "type":         "stateless",
            "version":      VERSION,
        }
        if cc.ctrl_type == "sync":
            for k in ("ack","ackMask","cmdMask","headerTxt",
                      "lvlPostStr","lvlPreStr","max","min","paramDecPt","step","trim"):
                obj.pop(k, None)
        return True, f"CI{json.dumps(obj, separators=(',',':'))}".encode()

    def _cq(self, ctrl_id: int, cc: CtrlConfig) -> tuple:
        jid = self._next_jid()
        obj = {
            "altRespState": cc.alt_resp,
            "bin":          cc.bin_mode,
            "cmdMask":      cc.cq_cmd_mask,
            "ctrlType":     cc.ctrl_type,
            "dev":          cc.dev,
            "id":           ctrl_id,
            "jsonId":       jid,
            "pollMsec":     cc.poll_ms,
            "respMask":     [],
            "version":      VERSION,
        }
        if cc.ctrl_type == "sync":
            for k in ("altRespState", "respMask"):
                obj.pop(k, None)
        return True, f"CQ{json.dumps(obj, separators=(',',':'))}".encode()

    def _ca(self, ctrl_id: int, cc: CtrlConfig) -> tuple:
        jid = self._next_jid()
        obj = {
            "altRespState": cc.alt_resp,
            "bin":          cc.bin_mode,
            "ctrlType":     cc.ctrl_type,
            "dev":          cc.dev,
            "id":           ctrl_id,
            "jsonId":       jid,
            "matchSrc":     True,
            "msgMask":      [],
            "version":      VERSION,
        }
        if cc.ctrl_type == "sync":
            obj.pop("altRespState", None)
        return True, f"CA{json.dumps(obj, separators=(',',':'))}".encode()

    @staticmethod
    def _plain(cmd: str) -> tuple:
        return False, f"{cmd}\r".encode("latin-1")

    # -- Menu tree walker -------------------------------------------------

    def _walk_menu(self, node: MenuNode):
        """
        Walk a MenuNode recursively. Assigns IDs and populates the
        MI/AI/CI/CQ/CA lists. Depth-first, sub-menus before their parent MI.
        """
        child_entries  = []
        sub_menu_nodes = []
        ctrl_items     = []
        action_items   = []

        for kind, child in node.children:
            if kind == "menu":
                child.node_id = menu_id_for_depth(child.depth)
                self._all_menu_ids.append(child.node_id)
                child_entries.append({"entry": {
                    "id":   child.node_id,
                    "txt":  child.display_txt,
                    "type": "menu",
                }})
                sub_menu_nodes.append(child)

            elif kind == "ctrl":
                item: CtrlItem = child
                item.ctrl_id = self._alloc_ctrl()
                self._all_ctrl_ids.append(item.ctrl_id)
                child_entries.append({"entry": {
                    "id":   item.ctrl_id,
                    "txt":  item.display_txt,
                    "type": "ctrl",
                }})
                ctrl_items.append(item)

            elif kind == "action":
                act: ActionConfig = child
                aitem = ActionItem(
                    display_txt = act.display_txt,
                    action_id   = self._alloc_ctrl(),
                    action      = act,
                )
                self._all_ctrl_ids.append(aitem.action_id)
                child_entries.append({"entry": {
                    "id":   aitem.action_id,
                    "txt":  act.display_txt,
                    "type": "action",
                }})
                action_items.append(aitem)

        # MI for this node's children goes BEFORE recursing into sub-menus.
        # Pcap order: outermost menu MI first, innermost last, leaf items last.
        if child_entries:
            first = child_entries[0]["entry"]["id"]
            last  = child_entries[-1]["entry"]["id"]
            self._mi_sub.append((child_entries, first, last))

        # Recurse into sub-menus after emitting this level's MI
        for sub in sub_menu_nodes:
            self._walk_menu(sub)

        # AI for leaf actions in this node
        for aitem in action_items:
            entry = [{"entry": {
                "action": {
                    "bin":   aitem.action.bin_mode,
                    "bytes": aitem.action.bytes_data,
                    "dev":   aitem.action.dev,
                    "type":  "3rd_party",
                },
                "id":   aitem.action_id,
                "type": "action",
            }}]
            self._ai_leaf.append((entry, aitem.action_id, aitem.action_id))

        # CI/CQ/CA for level controls -- mute before vol within each ctrl ID
        for item in ctrl_items:
            cid = item.ctrl_id
            pair = []
            for cc in [item.mute, item.vol]:
                if cc is not None:
                    pair.append((cid, cc))
            self._ci_items.append(pair)
            self._cq_items.append(pair)
            self._ca_items.append(pair)
            self._gli_ctrl_ids.append(cid)

    # -- Main compile -----------------------------------------------------

    def compile(self) -> list:
        menu     = self.menu_json.get("menu", {})
        controls = menu.get("control", [])

        # Parse top-level control list
        i = 0
        while i < len(controls):
            e     = controls[i]
            etype = e.get("entry_type", "")

            if etype == "level":
                vol_obj  = e.get("level_vol")
                mute_obj = e.get("level_mute")
                if vol_obj and not mute_obj and i + 1 < len(controls) and "level_mute" in controls[i+1]:
                    mute_obj = controls[i + 1]["level_mute"]
                    i += 1
                if vol_obj:
                    self._root_vol  = _parse_ctrl(vol_obj,  "vol")
                if mute_obj:
                    self._root_mute = _parse_ctrl(mute_obj, "mute")

            elif etype == "sync_action":
                sync_obj         = e.get("init_sync", {})
                self._sync_ctrl  = _parse_ctrl(sync_obj, "sync")
                self._sync_txt   = e.get("display_txt", "Sync Action")

            elif etype == "init_macro":
                sub_actions = [
                    ActionConfig(
                        display_txt = s["display_txt"],
                        bytes_data  = s.get("bytes", []),
                        bin_mode    = s.get("binary", False),
                        dev         = s.get("dev", ""),
                    )
                    for s in e.get("entries", [])
                ]
                self._macro_cfg = MacroConfig(
                    display_txt      = e["display_txt"],
                    init_macro_delay = e.get("initMacroDelay", 3),
                    inter_cmd_delay  = e.get("interCmdDelay", 100),
                    actions          = sub_actions,
                )

            elif etype == "main_menu":
                self._main_menu = MenuNode(
                    display_txt = e["display_txt"],
                    depth       = 0,
                    node_id     = ID_MENU_ROOT,
                    children    = _parse_menu_entries(e.get("entries", []), depth=1),
                )

            i += 1

        # Walk the menu tree to assign IDs and collect packets
        if self._main_menu:
            self._walk_menu(self._main_menu)

        # -- Build root MI (the one with reserved IDs) --
        root_mi_entries = []
        if self._root_vol is not None or self._root_mute is not None:
            root_mi_entries.append({"entry": {
                "id": ID_CTRL_ROOT, "txt": "", "type": "ctrl"
            }})
        if self._sync_ctrl is not None:
            root_mi_entries.append({"entry": {
                "id": ID_SYNC, "txt": self._sync_txt, "type": "sync"
            }})
        if self._macro_cfg is not None:
            root_mi_entries.append({"entry": {
                "id":             ID_MACRO,
                "initMacro":      True,
                "initMacroDelay": self._macro_cfg.init_macro_delay,
                "interCmdDelay":  self._macro_cfg.inter_cmd_delay,
                "txt":            self._macro_cfg.display_txt,
                "type":           "macro",
            }})
        if self._main_menu is not None:
            root_mi_entries.append({"entry": {
                "id":             ID_MENU_ROOT,
                "initMacro":      True,
                "initMacroDelay": 3,
                "interCmdDelay":  100,
                "txt":            self._main_menu.display_txt,
                "type":           "menu",
            }})

        # -- Assemble MT ID list: reserved + menu node IDs + ctrl IDs --
        # Order matches pcap: reserved first, then menu IDs, then ctrl IDs
        reserved_ids = [ID_CTRL_ROOT, ID_SYNC, ID_MACRO, ID_MENU_ROOT]
        all_ids = reserved_ids + self._all_menu_ids + self._all_ctrl_ids

        packets = []

        # Phase 1: MT
        packets.append(self._mt(all_ids))

        # Phase 2: MI (sub-menus first, root last -- matches pcap)
        for entries, first, last in self._mi_sub:
            packets.append(self._mi(entries, first, last))
        if root_mi_entries:
            packets.append(self._mi(
                root_mi_entries,
                root_mi_entries[0]["entry"]["id"],
                root_mi_entries[-1]["entry"]["id"],
            ))

        # Phase 3: AI (leaf actions first, macro second)
        for entries, first, last in self._ai_leaf:
            packets.append(self._ai(entries, first, last))
        if self._macro_cfg:
            mac_entries = []
            for idx, act in enumerate(self._macro_cfg.actions):
                mac_entries.append({"entry": {
                    "id": ID_MACRO,
                    "m_action": {
                        "action": {
                            "bin":   act.bin_mode,
                            "bytes": act.bytes_data,
                            "dev":   act.dev,
                            "type":  "3rd_party",
                        },
                        "idx":  idx,
                        "name": act.display_txt,
                    },
                    "type": "m_action",
                }})
            packets.append(self._ai(mac_entries, ID_MACRO, ID_MACRO))

        # Phase 4: CI -- pairs reversed (high ID first), mute before vol within pair
        for pair in reversed(self._ci_items):
            for cid, cc in pair:
                packets.append(self._ci(cid, cc))
        if self._root_mute:
            packets.append(self._ci(ID_CTRL_ROOT, self._root_mute))
        if self._root_vol:
            packets.append(self._ci(ID_CTRL_ROOT, self._root_vol))
        if self._sync_ctrl:
            packets.append(self._ci(ID_SYNC, self._sync_ctrl))

        # Phase 5: CQ -- pairs reversed (highest ctrl ID first), mute before vol within pair
        for pair in reversed(self._cq_items):
            for cid, cc in pair:
                packets.append(self._cq(cid, cc))
        if self._sync_ctrl:
            packets.append(self._cq(ID_SYNC, self._sync_ctrl))
        if self._root_mute:
            packets.append(self._cq(ID_CTRL_ROOT, self._root_mute))
        if self._root_vol:
            packets.append(self._cq(ID_CTRL_ROOT, self._root_vol))

        # Phase 6: CA -- same ordering as CQ
        for pair in reversed(self._ca_items):
            for cid, cc in pair:
                packets.append(self._ca(cid, cc))
        if self._sync_ctrl:
            packets.append(self._ca(ID_SYNC, self._sync_ctrl))
        if self._root_mute:
            packets.append(self._ca(ID_CTRL_ROOT, self._root_mute))
        if self._root_vol:
            packets.append(self._ca(ID_CTRL_ROOT, self._root_vol))

        # Phase 7: SF finalize
        packets.append(self._plain("SF 1"))

        # Phase 8: post-save plain-text commands
        packets.append(self._plain(f"SCM {self.cm}"))
        packets.append(self._plain(f"SMID {self.smid}"))
        packets.append(self._plain("QUERY"))
        packets.append(self._plain(f"SCM {self.cm}"))
        packets.append(self._plain("SSIPC 0.0.0.0 0.0.0.0 0.0.0.0"))
        packets.append(self._plain("GDR"))
        packets.append(self._plain("GND"))
        packets.append(self._plain("GMIID"))

        # GMI read-back for all known IDs
        for mid in [ID_MENU_ROOT, ID_CTRL_ROOT, ID_SYNC, ID_MACRO]:
            packets.append(self._plain(f"GMI {hex(mid)}"))
        for mid in self._all_menu_ids:
            packets.append(self._plain(f"GMI {hex(mid)}"))
        for cid in self._all_ctrl_ids:
            packets.append(self._plain(f"GMI {hex(cid)}"))

        # GLI / GMBA read-back
        packets.append(self._plain(f"GLI {hex(ID_CTRL_ROOT)} V"))
        packets.append(self._plain(f"GLI {hex(ID_CTRL_ROOT)} M"))
        if self._macro_cfg:
            for idx in range(len(self._macro_cfg.actions)):
                packets.append(self._plain(f"GMBA {hex(ID_MACRO)} {idx}"))
        for cid in self._gli_ctrl_ids:
            packets.append(self._plain(f"GLI {hex(cid)} V"))
            packets.append(self._plain(f"GLI {hex(cid)} M"))

        packets.append(self._plain("GF"))
        packets.append(self._plain("GMID"))

        return packets


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def _decode(raw: bytes) -> str:
    return raw.decode("latin-1", errors="replace").strip()


def _send_packet(sock, data, timeout, expects_json_ack, verify, dry_run):
    text   = _decode(data)
    prefix = text[:2]
    if dry_run:
        print(f"  [DRY] {prefix}  {text[:120]}")
        return True
    sock.send(data)
    print(f"  >>> {prefix}  {text[:120]}")
    if not verify:
        return True
    sock.settimeout(timeout)
    try:
        resp, _ = sock.recvfrom(65535)
        resp_str = _decode(resp)
        print(f"  <<< {resp_str[:120]}")
        if expects_json_ack:
            try:
                jid = json.loads(text[2:]).get("jsonId", "?")
                ok  = f"ACK MENU_JSON {jid}" in resp_str
            except Exception:
                ok = "ACK" in resp_str
        else:
            ok = "ACK" in resp_str or len(resp_str) > 0
        if not ok:
            print(f"  [WARN] unexpected: {resp_str[:80]}")
        return ok
    except socket.timeout:
        print(f"  [WARN] timeout ({timeout}s)")
        return False


def push(device_ip, port, packets, timeout, verify, dry_run):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    if not dry_run:
        sock.connect((device_ip, port))
    failures = 0
    for expects_json_ack, data in packets:
        ok = _send_packet(sock, data, timeout, expects_json_ack, verify, dry_run)
        if not ok:
            failures += 1
        if not dry_run:
            time.sleep(0.02)
    sock.close()

    if not dry_run and verify:
        print("\nWaiting for batch result (up to 8s)...")
        listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        listener.bind(("", port))
        listener.settimeout(8)
        try:
            while True:
                data, addr = listener.recvfrom(65535)
                text = _decode(data)
                if '"json_ids"' in text or '"result_ids"' in text:
                    print(f"  Batch result from {addr[0]}: {text[:200]}")
                    try:
                        obj = json.loads(text)
                        bad = [(j, r) for j, r in
                               zip(obj["json_ids"], obj["result_ids"]) if r != 0]
                        if bad:
                            print(f"  {len(bad)} FAILED: {bad}")
                            failures += len(bad)
                        else:
                            print(f"  All {len(obj['json_ids'])} packets OK")
                    except Exception:
                        pass
                    break
        except socket.timeout:
            print("  (no batch result -- device may have committed already)")
        finally:
            listener.close()

    status = "DONE" if failures == 0 else "DONE WITH WARNINGS"
    print(f"\n{status}  ({failures} failure(s))")
    return failures == 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="AxonC1 cfg compiler + pusher")
    parser.add_argument("device_ip")
    parser.add_argument("config")
    parser.add_argument("--port",      type=int,   default=CMD_PORT)
    parser.add_argument("--timeout",   type=float, default=2.0)
    parser.add_argument("--dry-run",   action="store_true")
    parser.add_argument("--no-verify", action="store_true")
    parser.add_argument("--dump",      action="store_true",
                        help="Print compiled packets as text and exit")
    args = parser.parse_args()

    cfg  = parse_cfg(args.config)
    smid = uuid.uuid4().hex

    compiler = PacketCompiler(menu_json=cfg["menu_json"], cm=cfg["cm"], smid=smid)
    packets  = compiler.compile()

    if args.dump:
        for i, (ack, data) in enumerate(packets, 1):
            text = data.decode("latin-1", errors="replace").replace("\r", "\\r")
            print(f"{i:>3d} [{'JSON' if ack else 'txt '}] {text[:140]}")
        return

    print(f"AxonC1 push")
    print(f"  Target : {args.device_ip}:{args.port}")
    print(f"  Config : {args.config}")
    print(f"  Packets: {len(packets)}")
    print(f"  SMID   : {smid}\n")

    ok = push(
        device_ip = args.device_ip,
        port      = args.port,
        packets   = packets,
        timeout   = args.timeout,
        verify    = not args.no_verify,
        dry_run   = args.dry_run,
    )
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
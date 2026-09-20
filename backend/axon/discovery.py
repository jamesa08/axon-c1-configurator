"""
axon/discovery.py -- device discovery and registry.

Two parallel strategies run at startup and on-demand:
  1. mDNS browse for _attero-ad._udp.local (C1 native advertisement)
  2. UDP broadcast QUERY on 49494 -- catches anything mDNS misses

Also contains the device registry helper (_register_device) and the
synchronous query helpers (_query_and_update, _auto_sync).
"""

import asyncio
import socket
import time

from zeroconf import ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

from .config import (
    CMD_PORT, MDNS_SERVICE_TYPES, devices, log,
)
from .protocol import broadcast_all, broadcast_ws


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
# Device registration helper
# ---------------------------------------------------------------------------

def register_device(ip: str, info: dict | None = None):
    """Add or update a device in the registry and broadcast to all WS clients."""
    existing = devices.get(ip, {})
    merged = {
        "ip":        ip,
        "sv_values": existing.get("sv_values", {}),
        "sm_values": existing.get("sm_values", {}),
        **(info or {}),
    }
    # Never let a broadcast registration overwrite a name already set by mDNS
    if existing.get("name") and not (info or {}).get("name"):
        merged["name"] = existing["name"]
    devices[ip] = merged
    log.info("Device registered: %s  %s", ip, info or "")
    asyncio.ensure_future(broadcast_all({"type": "device_found", "device": devices[ip]}))


# ---------------------------------------------------------------------------
# Discovery: mDNS
# ---------------------------------------------------------------------------

class _MDNSListener:
    """zeroconf service listener -- fires when an Attero device appears/disappears."""

    def __init__(self, azc: AsyncZeroconf):
        self._azc = azc

    def async_update_service(self, zc, stype, name):
        log.info("mDNS UPDATE: stype=%s name=%s", stype, name)
        asyncio.ensure_future(self._resolve(stype, name, event="update"))

    def async_remove_service(self, zc, stype, name):
        log.info("mDNS REMOVE: stype=%s name=%s", stype, name)

    def async_add_service(self, zc, stype, name):
        log.info("mDNS ADD: stype=%s name=%s", stype, name)
        asyncio.ensure_future(self._resolve(stype, name, event="add"))

    # zeroconf calls these without 'async_' prefix too in older builds
    update_service = async_update_service
    remove_service = async_remove_service
    add_service    = async_add_service

    async def _resolve(self, stype: str, name: str, event: str = "add"):
        log.info("mDNS resolving: %s (event=%s)", name, event)
        info = AsyncServiceInfo(stype, name)
        ok   = await info.async_request(self._azc.zeroconf, timeout=3000)
        if not ok:
            log.warning("mDNS: could not resolve %s", name)
            return

        addrs = info.parsed_addresses()
        log.info("mDNS resolved: %s -> addrs=%s", name, addrs)
        if not addrs:
            return
        ip = addrs[0]

        props = {}
        try:
            props = {k.decode(): v.decode() for k, v in info.properties.items()}
        except Exception:
            pass

        log.info("mDNS props for %s: %s", name, props)

        # Accept if CtrlType contains AtteroUDP, or service type is a known Attero type
        ctrl_type = props.get("CtrlType", "").strip("\x00").strip()
        attero_stypes = {"_attero-ad._udp.local.", "_attero._udp.local.", "_axon._udp.local."}
        is_attero = "AtteroUDP" in ctrl_type or stype in attero_stypes
        if not is_attero:
            log.info("mDNS: ignoring non-Attero service %s (CtrlType=%r stype=%s)", name, ctrl_type, stype)
            return

        device_name = name.split(".")[0]
        old_name = devices.get(ip, {}).get("name")
        log.info("mDNS: registering %s ip=%s old_name=%r new_name=%r", name, ip, old_name, device_name)
        register_device(ip, {
            "source":     "mdns",
            "name":       device_name,
            "mdns_name":  name,
            "mdns_props": props,
        })
        if old_name and old_name != device_name:
            log.info("mDNS: device %s renamed %r -> %r", ip, old_name, device_name)
            asyncio.ensure_future(broadcast_all({
                "type":      "device_renamed",
                "device_ip": ip,
                "name":      device_name,
            }))
        elif not old_name:
            # First time we have a name — run full sync
            asyncio.ensure_future(auto_sync(ip))


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
    Send QUERY\\r as a UDP broadcast and collect ACK QUERY responses.
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
        register_device(src_ip, {
            "source":     "broadcast",
            "mac":        fields.get("MAC", ""),
            "mode":       fields.get("CM", ""),
            "query_resp": resp_text,
        })
        asyncio.ensure_future(auto_sync(src_ip))

    return found


# ---------------------------------------------------------------------------
# Full QUERY + VERSION + GETMAC for a known IP
# ---------------------------------------------------------------------------

async def auto_sync(ip: str):
    """Run full sync on discovery; broadcasts device_synced with live config."""
    from .sync import blocking_sync  # late import avoids circular dependency

    loop = asyncio.get_event_loop()

    def progress(msg: str):
        asyncio.run_coroutine_threadsafe(
            broadcast_all({"type": "sync_log", "device_ip": ip, "msg": msg}), loop)

    result = await loop.run_in_executor(None, blocking_sync, ip, progress)
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
        await broadcast_all({
            "type":      "device_synced",
            "device_ip": ip,
            "config":    cfg,
            "summary":   result.get("summary", {}),
        })
        log.info("Auto-sync complete for %s: %s", ip, result.get("summary"))
    else:
        log.warning("Auto-sync failed for %s: %s", ip, result.get("error"))
        await query_and_update(ip)


async def query_and_update(ip: str):
    """Run QUERY/VERSION/GETMAC against a known device IP and update registry."""
    from .protocol import cmd_proto  # late import avoids circular at module level

    try:
        query   = await cmd_proto.send_await(ip, "QUERY",   timeout=3.0)
        version = await cmd_proto.send_await(ip, "VERSION", timeout=2.0)
        mac     = await cmd_proto.send_await(ip, "GETMAC",  timeout=2.0)
    except TimeoutError:
        log.warning("query_and_update: timeout for %s", ip)
        return

    fields   = parse_query_response(query)
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
    await broadcast_all({"type": "device_updated", "device": devices[ip]})

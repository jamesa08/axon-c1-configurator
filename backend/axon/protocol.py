"""
axon/protocol.py -- asyncio UDP datagram protocols and WebSocket broadcast helpers.

CmdProtocol  : bound to CMD_PORT (49494); handles request/reply commands.
AsyncProtocol: bound to ASYNC_PORT (49500); handles async device push messages
               (SV volume, SM mute, TR trigger).
"""

import asyncio
import time

from .config import (
    CMD_PORT, ASYNC_PORT, devices, ws_clients, log,
)


# ---------------------------------------------------------------------------
# WebSocket broadcast helpers
# ---------------------------------------------------------------------------

async def broadcast_ws(ip: str, payload: dict):
    """Broadcast a payload to every WebSocket subscribed to a specific device IP."""
    dead = set()
    for ws in ws_clients.get(ip, set()):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    ws_clients[ip] -= dead


async def broadcast_all(payload: dict):
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
        asyncio.ensure_future(broadcast_ws(ip, {"type": "cmd_response", "data": text}))

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
            asyncio.ensure_future(broadcast_ws(ip, {"type": "connect_info", "data": text}))

    def _sv_poll(self, ip, ch):
        db = devices.get(ip, {}).get("sv_values", {}).get(ch, 0)
        self.transport.sendto(f"SV {ch} {db}\r".encode(), (ip, ASYNC_PORT))
        asyncio.ensure_future(broadcast_ws(ip, {"type": "sv_poll", "channel": ch, "db": db}))

    def _sv_value(self, ip, ch, db):
        devices.setdefault(ip, {}).setdefault("sv_values", {})[ch] = db
        asyncio.ensure_future(broadcast_ws(ip, {"type": "sv_change", "channel": ch, "db": db}))

    def _sm(self, ip, ch, muted):
        devices.setdefault(ip, {}).setdefault("sm_values", {})[ch] = muted
        asyncio.ensure_future(broadcast_ws(ip, {"type": "sm_change", "channel": ch, "muted": muted}))

    def _tr(self, ip, trigger):
        asyncio.ensure_future(broadcast_ws(ip, {
            "type": "trigger_fire", "trigger": trigger, "timestamp": time.time()}))

    def error_received(self, exc):
        log.error("ASYNC socket error: %s", exc)


# ---------------------------------------------------------------------------
# Module-level singletons (set by app.py at startup)
# ---------------------------------------------------------------------------

cmd_proto:   CmdProtocol   = None   # type: ignore[assignment]
async_proto: AsyncProtocol = None   # type: ignore[assignment]

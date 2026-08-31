"""
Axon C1 Configurator - Backend Server
Serves React frontend + handles bidirectional UDP to/from Axon C1 devices.
"""

import asyncio
import json
import logging
import socket
import time
from collections import defaultdict
from pathlib import Path

from aiohttp import web, WSMsgType

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("axon")

# ─── Ports (from reverse engineering doc) ────────────────────────────────────
CMD_PORT  = 49494   # bidirectional: config commands to/from C1
ASYNC_PORT = 49500  # C1 sends SV/SM/TR here; host replies with SV values

STATIC_DIR = Path(__file__).parent.parent / "frontend" / "dist"

# ─── Per-device state ─────────────────────────────────────────────────────────
devices: dict[str, dict] = {}       # ip -> device state dict
ws_clients: dict[str, set] = defaultdict(set)  # ip -> set of WebSocket connections


# ─── UDP: Command socket (port 49494) ─────────────────────────────────────────

class CmdProtocol(asyncio.DatagramProtocol):
    """Handles bidirectional UDP on port 49494 (config/command channel)."""

    def __init__(self):
        self.transport = None
        self._pending: dict[str, asyncio.Future] = {}  # cmd_key -> Future

    def connection_made(self, transport):
        self.transport = transport
        log.info("CMD socket bound on port %d", CMD_PORT)

    def datagram_received(self, data: bytes, addr: tuple):
        ip, port = addr
        text = data.decode(errors="replace").rstrip("\r\n")
        log.debug("CMD <- [%s:%d] %r", ip, port, text)

        # Store latest raw response per device
        if ip in devices:
            devices[ip]["last_cmd_response"] = text

        # Resolve pending futures
        key = f"{ip}:{text.split()[0] if text.startswith('ACK') else '?'}"
        for pending_key, fut in list(self._pending.items()):
            if pending_key.startswith(ip) and not fut.done():
                fut.set_result(text)
                del self._pending[pending_key]
                break

        # Broadcast to WebSocket clients watching this device
        asyncio.ensure_future(_broadcast_ws(ip, {"type": "cmd_response", "data": text}))

    def error_received(self, exc):
        log.error("CMD socket error: %s", exc)

    def send(self, ip: str, cmd: str):
        """Send a command to device. Appends \\r if not present."""
        if not cmd.endswith("\r"):
            cmd += "\r"
        self.transport.sendto(cmd.encode(), (ip, CMD_PORT))
        log.debug("CMD -> [%s] %r", ip, cmd)

    async def send_await(self, ip: str, cmd: str, timeout: float = 2.0) -> str:
        """Send a command and wait for an ACK response."""
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        key = f"{ip}:{cmd.strip()}"
        self._pending[key] = fut
        self.send(ip, cmd)
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(key, None)
            raise TimeoutError(f"No response from {ip} for command {cmd!r}")


class AsyncProtocol(asyncio.DatagramProtocol):
    """
    Handles port 49500 - runtime async channel.
    C1 sends SV/SM/TR here; host replies to SV polls with current dB values.
    """

    def __init__(self, cmd_proto: CmdProtocol):
        self.transport = None
        self.cmd_proto = cmd_proto

    def connection_made(self, transport):
        self.transport = transport
        log.info("ASYNC socket bound on port %d", ASYNC_PORT)

    def datagram_received(self, data: bytes, addr: tuple):
        ip, port = addr
        text = data.decode(errors="replace").rstrip("\r\n")
        log.debug("ASYNC <- [%s:%d] %r", ip, port, text)

        parts = text.split()
        if not parts:
            return

        pkt_type = parts[0]

        if pkt_type == "SV" and len(parts) >= 2:
            channel = int(parts[1])
            if len(parts) == 2:
                # Bare SV poll: "SV N " - C1 is asking what the current level is
                self._handle_sv_poll(ip, channel)
            else:
                # Value report: "SV N db" - user turned the encoder
                db = int(parts[2])
                self._handle_sv_value(ip, channel, db)

        elif pkt_type == "SM" and len(parts) == 3:
            channel = int(parts[1])
            muted = bool(int(parts[2]))
            self._handle_sm(ip, channel, muted)

        elif pkt_type == "TR" and len(parts) == 2:
            trigger = int(parts[1])
            self._handle_tr(ip, trigger)

        elif pkt_type in ("VERSION", "GETMAC"):
            # Unsolicited on connect
            asyncio.ensure_future(_broadcast_ws(ip, {"type": "connect_info", "data": text}))

    def _handle_sv_poll(self, ip: str, channel: int):
        """C1 is asking what the current dB value is for SV channel N."""
        dev = devices.get(ip, {})
        sv_values = dev.get("sv_values", {})
        current_db = sv_values.get(channel, 0)
        # Reply to device on port 49500
        reply = f"SV {channel} {current_db}\r"
        self.transport.sendto(reply.encode(), (ip, ASYNC_PORT))
        log.debug("ASYNC -> [%s] SV poll reply %r", ip, reply)
        asyncio.ensure_future(_broadcast_ws(ip, {
            "type": "sv_poll",
            "channel": channel,
            "db": current_db,
        }))

    def _handle_sv_value(self, ip: str, channel: int, db: int):
        """User turned the encoder, store the new value and broadcast."""
        if ip not in devices:
            devices[ip] = {}
        devices[ip].setdefault("sv_values", {})[channel] = db
        asyncio.ensure_future(_broadcast_ws(ip, {
            "type": "sv_change",
            "channel": channel,
            "db": db,
        }))

    def _handle_sm(self, ip: str, channel: int, muted: bool):
        if ip not in devices:
            devices[ip] = {}
        devices[ip].setdefault("sm_values", {})[channel] = muted
        asyncio.ensure_future(_broadcast_ws(ip, {
            "type": "sm_change",
            "channel": channel,
            "muted": muted,
        }))

    def _handle_tr(self, ip: str, trigger: int):
        asyncio.ensure_future(_broadcast_ws(ip, {
            "type": "trigger_fire",
            "trigger": trigger,
            "timestamp": time.time(),
        }))

    def error_received(self, exc):
        log.error("ASYNC socket error: %s", exc)


# ─── Global protocol instances (set during startup) ───────────────────────────
cmd_proto: CmdProtocol = None
async_proto: AsyncProtocol = None


# ─── WebSocket broadcast helper ───────────────────────────────────────────────

async def _broadcast_ws(ip: str, payload: dict):
    dead = set()
    for ws in ws_clients.get(ip, set()):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    ws_clients[ip] -= dead


# ─── HTTP API handlers ────────────────────────────────────────────────────────

async def api_device_add(request: web.Request) -> web.Response:
    """POST /api/device  { "ip": "192.168.1.100" }"""
    body = await request.json()
    ip = body.get("ip", "").strip()
    if not ip:
        return web.json_response({"error": "ip required"}, status=400)
    devices.setdefault(ip, {"ip": ip, "sv_values": {}, "sm_values": {}})
    return web.json_response({"status": "added", "ip": ip})


async def api_discover(request: web.Request) -> web.Response:
    """GET /api/device/{ip}/discover - QUERY + VERSION + GETMAC"""
    ip = request.match_info["ip"]
    try:
        query_resp = await cmd_proto.send_await(ip, "QUERY")
        version_resp = await cmd_proto.send_await(ip, "VERSION")
        mac_resp = await cmd_proto.send_await(ip, "GETMAC")
        model_resp = await cmd_proto.send_await(ip, "MODEL")
    except TimeoutError as e:
        return web.json_response({"error": str(e)}, status=504)

    result = {
        "query": query_resp,
        "version": version_resp,
        "mac": mac_resp,
        "model": model_resp,
    }
    devices.setdefault(ip, {}).update({"discover": result})
    return web.json_response(result)


async def api_send_command(request: web.Request) -> web.Response:
    """POST /api/device/{ip}/cmd  { "cmd": "SLC RED" }"""
    ip = request.match_info["ip"]
    body = await request.json()
    cmd = body.get("cmd", "").strip()
    if not cmd:
        return web.json_response({"error": "cmd required"}, status=400)
    try:
        resp = await cmd_proto.send_await(ip, cmd)
        return web.json_response({"response": resp})
    except TimeoutError as e:
        return web.json_response({"error": str(e)}, status=504)


async def api_set_sv(request: web.Request) -> web.Response:
    """POST /api/device/{ip}/sv  { "channel": 1, "db": -12 }"""
    ip = request.match_info["ip"]
    body = await request.json()
    channel = int(body["channel"])
    db = int(body["db"])
    devices.setdefault(ip, {}).setdefault("sv_values", {})[channel] = db
    # Push value to device on the async port
    pkt = f"SV {channel} {db}\r"
    async_proto.transport.sendto(pkt.encode(), (ip, ASYNC_PORT))
    return web.json_response({"status": "sent", "channel": channel, "db": db})


async def api_list_devices(request: web.Request) -> web.Response:
    """GET /api/devices"""
    return web.json_response(list(devices.values()))


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    """WebSocket /ws/{ip} - streams SV/SM/TR events for a device."""
    ip = request.match_info["ip"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients[ip].add(ws)
    log.info("WS client connected for device %s", ip)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                # Accept SV overrides from the browser
                try:
                    data = json.loads(msg.data)
                    if data.get("type") == "sv_set":
                        ch = int(data["channel"])
                        db = int(data["db"])
                        devices.setdefault(ip, {}).setdefault("sv_values", {})[ch] = db
                        pkt = f"SV {ch} {db}\r"
                        async_proto.transport.sendto(pkt.encode(), (ip, ASYNC_PORT))
                except Exception:
                    pass
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        ws_clients[ip].discard(ws)
        log.info("WS client disconnected for device %s", ip)
    return ws


# ─── App factory ──────────────────────────────────────────────────────────────

def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/devices", api_list_devices)
    app.router.add_post("/api/device", api_device_add)
    app.router.add_get("/api/device/{ip}/discover", api_discover)
    app.router.add_post("/api/device/{ip}/cmd", api_send_command)
    app.router.add_post("/api/device/{ip}/sv", api_set_sv)
    app.router.add_get("/ws/{ip}", ws_handler)

    # Serve React build (production)
    if STATIC_DIR.exists():
        app.router.add_static("/", path=str(STATIC_DIR), name="static", show_index=True)
    else:
        log.warning("Frontend dist/ not found - run 'npm run build' in frontend/")

    return app


async def main():
    global cmd_proto, async_proto
    loop = asyncio.get_event_loop()

    # Bind CMD socket (49494) - bidirectional
    cmd_transport, cmd_protocol = await loop.create_datagram_endpoint(
        CmdProtocol,
        local_addr=("0.0.0.0", CMD_PORT),
    )
    cmd_proto = cmd_protocol

    # Bind ASYNC socket (49500) - receives SV/SM/TR from device
    # Use SO_REUSEPORT so Q-SYS or other tools can also bind this port
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", ASYNC_PORT))
    async_transport, async_protocol = await loop.create_datagram_endpoint(
        lambda: AsyncProtocol(cmd_proto),
        sock=sock,
    )
    async_proto = async_protocol

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()

    log.info("Server running at http://0.0.0.0:8080")
    log.info("CMD  UDP bound on port %d", CMD_PORT)
    log.info("ASYNC UDP bound on port %d", ASYNC_PORT)

    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())

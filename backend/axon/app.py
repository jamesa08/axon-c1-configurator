"""
axon/app.py -- aiohttp application factory and async main entry point.
"""

import asyncio
import socket

from aiohttp import web

from .config import CMD_PORT, ASYNC_PORT, STATIC_DIR, log
from .discovery import broadcast_scan, start_mdns_discovery, stop_mdns_discovery
from .protocol import CmdProtocol, AsyncProtocol
import axon.protocol as _proto
from .routes import (
    api_cfg_export,
    api_cfg_import,
    api_device_add,
    api_discover,
    api_interfaces,
    api_list_devices,
    api_push,
    api_scan,
    api_send_command,
    api_set_sv,
    api_sync,
    ws_discovery_handler,
    ws_handler,
)


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get ("/api/devices",               api_list_devices)
    app.router.add_get ("/api/interfaces",             api_interfaces)
    app.router.add_post("/api/device",                 api_device_add)
    app.router.add_post("/api/scan",                   api_scan)
    app.router.add_get ("/api/device/{ip}/discover",   api_discover)
    app.router.add_post("/api/device/{ip}/sync",       api_sync)
    app.router.add_post("/api/device/{ip}/cmd",        api_send_command)
    app.router.add_post("/api/device/{ip}/sv",         api_set_sv)
    app.router.add_post("/api/device/{ip}/push",       api_push)
    app.router.add_get ("/api/device/{ip}/cfg",        api_cfg_export)
    app.router.add_post("/api/device/{ip}/cfg",        api_cfg_export)
    app.router.add_post("/api/cfg/import",             api_cfg_import)
    app.router.add_get ("/ws/_discovery",              ws_discovery_handler)
    app.router.add_get ("/ws/{ip}",                    ws_handler)
    if STATIC_DIR.exists():
        async def index(_):
            return web.FileResponse(STATIC_DIR / "index.html")
        app.router.add_get("/", index)
        app.router.add_static("/", path=str(STATIC_DIR), show_index=False)
    else:
        log.warning("frontend/dist not found -- run npm run build in frontend/")
    return app


async def main():
    loop = asyncio.get_event_loop()

    _, cmd = await loop.create_datagram_endpoint(
        CmdProtocol, local_addr=("0.0.0.0", CMD_PORT))

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", ASYNC_PORT))
    _, asyn = await loop.create_datagram_endpoint(
        lambda: AsyncProtocol(cmd), sock=sock)

    # Publish singletons so other modules can reference them
    _proto.cmd_proto   = cmd
    _proto.async_proto = asyn

    app    = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8080).start()

    log.info("http://0.0.0.0:8080  |  CMD :%d  |  ASYNC :%d", CMD_PORT, ASYNC_PORT)

    await start_mdns_discovery()
    asyncio.ensure_future(broadcast_scan())

    try:
        await asyncio.Event().wait()
    finally:
        await stop_mdns_discovery()


if __name__ == "__main__":
    asyncio.run(main())

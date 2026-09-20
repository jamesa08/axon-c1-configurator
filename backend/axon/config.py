"""
axon/config.py -- shared constants and global mutable state.

All other modules import from here instead of declaring their own globals.
"""

import logging
import sys
from collections import defaultdict
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("axon")

CMD_PORT   = 49494
ASYNC_PORT = 49500

if getattr(sys, "frozen", False):
    # PyInstaller bundle: _MEIPASS is the extraction root
    _BASE = Path(sys._MEIPASS)
else:
    _BASE = Path(__file__).parent.parent.parent

STATIC_DIR = _BASE / "frontend" / "dist"

# ip -> device state dict
devices: dict[str, dict] = {}

# ip -> set of open WebSocket connections
ws_clients: dict[str, set] = defaultdict(set)

# mDNS service types to browse (try both; one will be right)
MDNS_SERVICE_TYPES = [
    "_attero-ad._udp.local.",
    "_attero._udp.local.",
    "_axon._udp.local.",
    "_http._tcp.local.",   # fallback -- some firmware versions use this
]

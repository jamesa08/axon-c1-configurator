"""
launch.py -- starts the aiohttp backend then opens a PyWebView window.
"""

import asyncio
import threading
import time

import webview

from axon.app import main as aiohttp_main


def _run_server():
    asyncio.run(aiohttp_main())


def main():
    t = threading.Thread(target=_run_server, daemon=True)
    t.start()

    # Give aiohttp a moment to bind before opening the window
    time.sleep(0.8)

    window = webview.create_window(
        "Axon C1 Configurator",
        "http://localhost:8080",
        width=1200,
        height=750,
        min_size=(1000, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()

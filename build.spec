# -*- mode: python ; coding: utf-8 -*-
import sys
from pathlib import Path

block_cipher = None

a = Analysis(
    ["backend/launch.py"],
    pathex=["backend"],
    binaries=[],
    datas=[
        ("frontend/dist", "frontend/dist"),
        ("/Library/Frameworks/Python.framework/Versions/3.13/lib/python3.13/site-packages/async_timeout", "async_timeout"),
    ],
    hiddenimports=[
        "webview",
        "webview.platforms.cocoa",
        "webview.platforms.winforms",
        "webview.platforms.gtk",
        "aiohttp",
        "aiohttp.web",
        "aiohttp.web_runner",
        "aiohttp.web_middlewares",
        "zeroconf",
        "zeroconf._utils.ipaddress",
        "zeroconf._utils.name",
        "zeroconf._dns",
        "zeroconf._services.browser",
        "zeroconf._services.info",
        "aiohappyeyeballs",
        "aiosignal",
        "frozenlist",
        "multidict",
        "yarl",
        "attr",
        "attrs",
        "async_timeout",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Axon C1 Configurator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="universal2",
    codesign_identity=None,
    entitlements_file=None,
    icon="AppIcon.icns",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="Axon C1 Configurator",
)

# macOS .app bundle
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Axon C1 Configurator.app",
        icon="AppIcon.icns",
        bundle_identifier="com.jamesa08.axon-c1-configurator",
        info_plist={
            "NSHighResolutionCapable": True,
            "CFBundleShortVersionString": "0.2.0",
            "NSMicrophoneUsageDescription": "",
            "NSCameraUsageDescription": "",
        },
    )

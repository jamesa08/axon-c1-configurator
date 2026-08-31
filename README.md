# Axon C1 Configurator

Web-based configurator for the Attero Tech Axon C1, built from complete reverse engineering findings.

## Architecture

```
Browser (React) <--HTTP/WS--> Python/aiohttp <--UDP 49494/49500--> Axon C1
```

- **Port 49494**: Bidirectional config/command channel (QUERY, SLC, GMIID, config push, etc.)
- **Port 49500**: Async runtime channel (C1 sends SV/SM/TR; host replies to SV polls)
- **WebSocket /ws/{ip}**: Streams all device events to the browser in real time

## Setup

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

### Frontend (dev mode)

```bash
cd frontend
npm install
npm run dev
# Opens http://localhost:5173 with HMR; API/WS proxied to backend on :8080
```

### Frontend (production build)

```bash
cd frontend
npm run build
# Backend then serves dist/ statically at http://localhost:8080
```

## Usage

1. Start the backend: `python backend/server.py`
2. Open http://localhost:5173 (dev) or http://localhost:8080 (prod)
3. Add a device by IP on the Devices page
4. Click Discover to run QUERY/VERSION/GETMAC
5. Use the raw command box to send any protocol command
6. Switch to Live Monitor to watch SV/SM/TR events in real time

## Protocol Notes (from reverse engineering)

- The C1 sends runtime traffic to the IP:port configured in its last push (not broadcast)
- SV polls ("SV N ") must be replied to within ~500ms or the display shows stale values
- The lightbar color resets after ~5s; send SLC on a timer to maintain it
- SDL (display lock) is a confirmed stub on firmware 1.5 - do not implement
- Safe SV channel range when interoperating with unIFY DLL: 1-9 only (8-byte cmdMask bug)
- Always create a fresh UDP socket for each config push (cfgUDP cannot be reopened)

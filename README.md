# Axon C1 Configurator

Web-based configurator for the Attero Tech Axon C1, built from complete reverse engineering findings.

## Architecture

```
Browser (React) <--HTTP/WS--> Python/aiohttp <--UDP 49494/49500--> Axon C1
```

- **Port 49494**: Bidirectional config/command channel (QUERY, SLC, GMIID, config push...)
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

### Frontend (dev)

```bash
cd frontend
npm install
npm run dev
# Opens http://localhost:5173 -- API/WS proxied to backend on :8080
```

### Frontend (production)

```bash
cd frontend
npm run build
# Backend serves dist/ at http://localhost:8080
```

## Push protocol

The `/api/device/{ip}/push` endpoint runs the full 7-phase push sequence:

1. QUERY + SCM THIRD_PARTY
2. GMIID + GMI (discover all menu item IDs and types)
3. Channel assignment + GLI M reads
4. jsonId budget calculation
5. MT / DL / MI / AI packets
6. CI / CQ / CA packets (vol + mute per level item)
7. Batch result wait + SCM THIRD_PARTY commit + SMID

The response is a streaming newline-delimited JSON so the frontend can show
live push progress line by line.

## Protocol notes

- SDL (display lock) is a stub on firmware 1.5 -- does not persist
- Safe SV channel range when interoperating with unIFY DLL: 1-9 (8-byte cmdMask bug in DLL; firmware has no such limit)
- Lightbar color resets after ~5s; use SLC on a timer to maintain it
- Always create a fresh UDP socket per push (cfgUDP cannot be reopened)
- The C1 sends runtime SV/SM/TR to the IP:port set in the last DL packet, not broadcast

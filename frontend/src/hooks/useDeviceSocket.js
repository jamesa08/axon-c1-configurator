import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Connects to /ws/{ip} and streams SV/SM/TR events from the Axon C1.
 * Also lets you send SV overrides back to the device.
 */
export function useDeviceSocket(ip) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!ip) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws/${ip}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        setEvents((prev) => [
          { ...msg, ts: Date.now() },
          ...prev.slice(0, 199), // keep last 200 events
        ]);
      } catch {
        // ignore parse errors
      }
    };

    return () => ws.close();
  }, [ip]);

  const setSV = useCallback((channel, db) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "sv_set", channel, db }));
    }
  }, []);

  return { events, connected, setSV };
}

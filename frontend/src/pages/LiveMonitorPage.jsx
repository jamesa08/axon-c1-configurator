import { useDeviceSocket } from "../hooks/useDeviceSocket";

const EVENT_COLORS = {
  sv_change: "#4ade80",
  sv_poll: "#60a5fa",
  sm_change: "#f59e0b",
  trigger_fire: "#f87171",
  cmd_response: "#a78bfa",
  connect_info: "#34d399",
};

function formatEvent(evt) {
  switch (evt.type) {
    case "sv_change":
      return `SV ch${evt.channel} = ${evt.db} dB`;
    case "sv_poll":
      return `SV poll ch${evt.channel} (replied ${evt.db} dB)`;
    case "sm_change":
      return `SM ch${evt.channel} ${evt.muted ? "MUTED" : "UNMUTED"}`;
    case "trigger_fire":
      return `TR ${evt.trigger} FIRED`;
    case "cmd_response":
      return evt.data;
    case "connect_info":
      return evt.data;
    default:
      return JSON.stringify(evt);
  }
}

export default function LiveMonitorPage({ device }) {
  const { events, connected, setSV } = useDeviceSocket(device);

  if (!device) {
    return (
      <div className="page">
        <p className="empty">Select a device on the Devices page first.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="monitor-header">
        <h2>Live Monitor: {device}</h2>
        <span className={`badge ${connected ? "badge-green" : "badge-red"}`}>
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <div className="event-log">
        {events.length === 0 && (
          <p className="empty">Waiting for events from device...</p>
        )}
        {events.map((evt, i) => (
          <div key={i} className="event-row">
            <span className="event-ts">
              {new Date(evt.ts).toLocaleTimeString()}
            </span>
            <span
              className="event-type"
              style={{ color: EVENT_COLORS[evt.type] ?? "#fff" }}
            >
              {evt.type}
            </span>
            <span className="event-msg">{formatEvent(evt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { api } from "../lib/api";

export default function DevicesPage({ selectedDevice, onSelect }) {
  const [devices, setDevices] = useState([]);
  const [newIp, setNewIp] = useState("");
  const [discovering, setDiscovering] = useState(null);
  const [cmdInput, setCmdInput] = useState("");
  const [cmdResponse, setCmdResponse] = useState("");
  const [cmdLoading, setCmdLoading] = useState(false);

  useEffect(() => {
    api.listDevices().then(setDevices).catch(console.error);
  }, []);

  async function handleAdd() {
    if (!newIp.trim()) return;
    await api.addDevice(newIp.trim());
    const updated = await api.listDevices();
    setDevices(updated);
    setNewIp("");
  }

  async function handleDiscover(ip) {
    setDiscovering(ip);
    try {
      const result = await api.discover(ip);
      setDevices((prev) =>
        prev.map((d) => (d.ip === ip ? { ...d, discover: result } : d))
      );
    } catch (e) {
      alert(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(null);
    }
  }

  async function handleSendCmd() {
    if (!selectedDevice || !cmdInput.trim()) return;
    setCmdLoading(true);
    setCmdResponse("");
    try {
      const result = await api.sendCmd(selectedDevice, cmdInput.trim());
      setCmdResponse(result.response || result.error || JSON.stringify(result));
    } catch (e) {
      setCmdResponse(`Error: ${e.message}`);
    } finally {
      setCmdLoading(false);
    }
  }

  return (
    <div className="page">
      <h2>Devices</h2>

      <div className="add-device">
        <input
          className="input"
          placeholder="Device IP (e.g. 192.168.1.100)"
          value={newIp}
          onChange={(e) => setNewIp(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button className="btn" onClick={handleAdd}>
          Add Device
        </button>
      </div>

      <div className="device-list">
        {devices.length === 0 && (
          <p className="empty">No devices added yet.</p>
        )}
        {devices.map((dev) => (
          <div
            key={dev.ip}
            className={`device-card ${selectedDevice === dev.ip ? "selected" : ""}`}
            onClick={() => onSelect(dev.ip)}
          >
            <div className="device-header">
              <span className="device-ip">{dev.ip}</span>
              <button
                className="btn btn-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDiscover(dev.ip);
                }}
                disabled={discovering === dev.ip}
              >
                {discovering === dev.ip ? "Discovering..." : "Discover"}
              </button>
            </div>

            {dev.discover && (
              <div className="device-details">
                <pre>{dev.discover.query}</pre>
                <pre>{dev.discover.version}</pre>
                <pre>{dev.discover.mac}</pre>
              </div>
            )}
          </div>
        ))}
      </div>

      {selectedDevice && (
        <div className="cmd-panel">
          <h3>Raw Command: {selectedDevice}</h3>
          <div className="cmd-row">
            <input
              className="input"
              placeholder="e.g. SLC RED or GDB"
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendCmd()}
            />
            <button className="btn" onClick={handleSendCmd} disabled={cmdLoading}>
              {cmdLoading ? "Sending..." : "Send"}
            </button>
          </div>
          {cmdResponse && (
            <pre className="cmd-response">{cmdResponse}</pre>
          )}
        </div>
      )}
    </div>
  );
}

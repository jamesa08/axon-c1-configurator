import { useState } from "react";
import DevicesPage from "./pages/DevicesPage";
import LiveMonitorPage from "./pages/LiveMonitorPage";

const PAGES = ["Devices", "Live Monitor"];

export default function App() {
  const [page, setPage] = useState("Devices");
  const [selectedDevice, setSelectedDevice] = useState(null);

  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-title">Axon C1 Configurator</span>
        <div className="nav-links">
          {PAGES.map((p) => (
            <button
              key={p}
              className={`nav-btn ${page === p ? "active" : ""}`}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </nav>

      <main className="main">
        {page === "Devices" && (
          <DevicesPage
            selectedDevice={selectedDevice}
            onSelect={setSelectedDevice}
          />
        )}
        {page === "Live Monitor" && (
          <LiveMonitorPage device={selectedDevice} />
        )}
      </main>
    </div>
  );
}

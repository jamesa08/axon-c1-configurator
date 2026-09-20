import React, { useState, useEffect, useRef, useCallback } from "react";
import { LayoutGrid, Settings, Upload, RefreshCw, Plus, ChevronLeft, ChevronRight, ArrowUp, Loader, ChevronUp, ChevronDown } from "lucide-react";
import { C, MONO, SANS, G } from "./tokens.js";
import { addLog } from "./helpers.js";
import { mkDefaultConfig, mkDevice } from "./defaultData.js";
import C1Sim from "./components/C1Sim.jsx";
import MenuBuilder from "./components/MenuBuilder.jsx";
import DeviceListPanel from "./components/DeviceListPanel.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import PushPanel from "./components/PushPanel.jsx";
import LogPanel from "./components/LogPanel.jsx";
import NicPicker from "./components/NicPicker.jsx";
import { SbSection, SbNavRow, SbDeviceRow, SbUnitRow, SbAddRow } from "./components/Sidebar.jsx";

// --- C1 unit helpers ----------------------------------------------------------
const mkC1 = (name, ip) => ({ id: crypto.randomUUID(), name, ip, mac:"--", firmware:"--", online:false, config: mkDefaultConfig() });

const _applyDeviceInfo = (unit, d) => {
  const cfg = { ...unit.config };
  if (d.mac)     cfg.mac             = d.mac.replace("0x","").replace(/(.{2})(?=.)/g,"$1:").toUpperCase();
  if (d.firmware) cfg.firmwareVersion = d.firmware;
  if (d.mode)    cfg.mode            = d.mode;
  if (d.destIp)  cfg.destIp          = d.destIp;
  if (d.destPort) cfg.destPort       = Number(d.destPort);
  if (d.lbColor) cfg.lbColor         = d.lbColor;
  if (d.ip)      cfg.ip              = d.ip;
  return {
    ...unit,
    name:     d.name || unit.name || d.ip,
    ip:       d.ip   || unit.ip,
    mac:      d.mac  || unit.mac,
    firmware: d.firmware || unit.firmware,
    online:   d.online !== undefined ? d.online : unit.online,
    config:   cfg,
  };
};

const _mkC1FromDevice = (d) => {
  const base = mkC1(d.name || d.ip, d.ip);
  return _applyDeviceInfo(base, d);
};

// After a sync overwrites mainMenu, restore user-only fields (queryBytes, respQueryBytes)
// that the C1 device never stores — matched by the stable "dev_XXXX" level IDs.
const _preserveUserBytes = (newMenu, oldMenu) => {
  if (!newMenu || !oldMenu) return newMenu;
  const oldMap = {};
  const collect = (entries) => {
    for (const e of (entries || [])) {
      if (e.id) oldMap[e.id] = e;
      if (e.entries) collect(e.entries);
    }
  };
  collect(oldMenu.entries);
  const patch = (entries) => (entries || []).map(e => {
    const old = oldMap[e.id];
    let out = e;
    if (e.entry_type === "level" && old) {
      out = {
        ...e,
        level_vol:  { ...e.level_vol,
          queryBytes:     old.level_vol?.queryBytes     ?? [],
          respQueryBytes: old.level_vol?.respQueryBytes ?? [],
        },
        level_mute: { ...e.level_mute,
          queryBytes: old.level_mute?.queryBytes ?? [],
        },
      };
    }
    if (out.entries) out = { ...out, entries: patch(out.entries) };
    return out;
  });
  return { ...newMenu, entries: patch(newMenu.entries) };
};

// --- Root App -----------------------------------------------------------------
export default function App() {
  const [c1List, setC1List]         = useState([]);
  const [selectedC1, setSelectedC1] = useState(null);
  const [syncing, setSyncing]       = useState(false);
  const [tab, setTab]               = useState("builder");
  const pushRunRef                  = useRef(null);
  const blockNextSyncRef            = useRef(false); // set true after failed push to suppress config overwrite
  const [navState, setNavState] = useState({ view:"root", path:[] });

  const navigate = useCallback((action) => {
    setNavState(prev => {
      switch (action.type) {
        case "ROOT":   return { view:"root", path:[] };
        case "MENU":   return { view:"menu", path:[] };
        case "PUSH":   return { view:"menu", path:[...prev.path, action.step] };
        case "POP":    return prev.path.length > 0
          ? { view:"menu", path:prev.path.slice(0,-1) }
          : { view:"root", path:[] };
        case "GOTO":   return { view:"menu", path:action.path };
        default:       return prev;
      }
    });
    setSimState(s => ({ ...s, cursorIdx:0, scrollOffset:0 }));
  }, []);

  const [simState, setSimState] = useState({
    navPath: null,
    cursorIdx: 0,
    scrollOffset: 0,
  });

  useEffect(()=>{
    const s = document.createElement("style");
    s.textContent = G;
    document.head.appendChild(s);

    // Grain overlay
    const grain = document.createElement("style");
    const svgNoise = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/></filter><rect width='200' height='200' filter='url(%23g)' opacity='1'/></svg>`;
    grain.textContent = `body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:0.03;background-image:url("data:image/svg+xml,${encodeURIComponent(svgNoise)}")}`;
    document.head.appendChild(grain);

    addLog("INFO","Configurator ready.");
    const initialIp = c1List[0]?.config?.ip;
    if (initialIp && initialIp !== "192.168.1.200") {
      fetch("/api/device", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ip:initialIp}) })
        .then(()=>fetch(`/api/device/${initialIp}/discover`))
        .then(r=>r.json())
        .then(d=>{
          if(d.query)   addLog("ACK","QUERY -> "+d.query);
          if(d.version) addLog("ACK","VERSION -> "+d.version);
          if(d.mac)     addLog("ACK","GETMAC -> "+d.mac);
        })
        .catch(()=>addLog("INFO","Discovery skipped -- no device reachable at "+initialIp));
    } else {
      addLog("INFO","Set device IP in Settings then push to connect.");
    }

    let ws = null;
    const connectWS = (ip) => {
      if (ws) ws.close();
      if (!ip || ip === "192.168.1.200") return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws/${ip}`);
      ws.onopen = () => addLog("INFO", `WS connected for ${ip}`);
      ws.onclose = () => addLog("INFO", `WS closed for ${ip}`);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "sv_change") {
            addLog("SV", `SV ${msg.channel} ${msg.db} dB`);
            setC1List(list => list.map(d => {
              if (d.id !== selectedC1) return d;
              const cfg = d.config;
              if (msg.channel === 1) return { ...d, config: { ...cfg, simVol: msg.db } };
              const updVols = { ...cfg.simChannelVols };
              const walk = n => {
                if (n.entry_type === "level" && n.level_vol?.channel === msg.channel) {
                  updVols[n.id] = msg.db;
                }
                (n.entries || []).forEach(walk);
              };
              walk(cfg.mainMenu);
              return { ...d, config: { ...cfg, simChannelVols: updVols } };
            }));
          } else if (msg.type === "sv_poll") {
            addLog("SV", `SV ${msg.channel} poll -> replied ${msg.db} dB`);
          } else if (msg.type === "sm_change") {
            addLog("SM", `SM ${msg.channel} ${msg.muted ? "MUTED" : "UNMUTED"}`);
          } else if (msg.type === "trigger_fire") {
            addLog("TR", `TR ${msg.trigger} fired`);
            const T = 250;
            setC1List(list => list.map(d => d.id===selectedC1 ? {...d,config:{...d.config,lbOn:false}} : d));
            setTimeout(()=>setC1List(list=>list.map(d=>d.id===selectedC1?{...d,config:{...d.config,lbOn:true}}:d)), T*1);
            setTimeout(()=>setC1List(list=>list.map(d=>d.id===selectedC1?{...d,config:{...d.config,lbOn:false}}:d)), T*2);
            setTimeout(()=>setC1List(list=>list.map(d=>d.id===selectedC1?{...d,config:{...d.config,lbOn:true}}:d)), T*3);
            setTimeout(()=>setC1List(list=>list.map(d=>d.id===selectedC1?{...d,config:{...d.config,lbOn:false}}:d)), T*4);
            setTimeout(()=>setC1List(list=>list.map(d=>d.id===selectedC1?{...d,config:{...d.config,lbOn:true}}:d)), T*5);
          } else if (msg.type === "cmd_response") {
            addLog("ACK", msg.data);
          }
        } catch {}
      };
    };
    connectWS(c1List[0]?.config?.ip);

    return()=>{ document.head.removeChild(s); document.head.removeChild(grain); if(ws) ws.close(); };
  },[]);

  const _c1Found = (selectedC1 && c1List.find(d=>d.id===selectedC1)) || c1List[0] || null;
  const _c1Placeholder = { id:null, name:"...", ip:"", mac:"--", firmware:"--", online:false, config: mkDefaultConfig() };
  const c1 = _c1Found ?? _c1Placeholder;
  const noDevices = !_c1Found;

  const setC1Config = useCallback((updater) => {
    setC1List(list=>list.map(d=>d.id===selectedC1 ? { ...d, config: typeof updater==="function" ? updater(d.config) : updater } : d));
  }, [selectedC1]);

  const setDevices = useCallback((updater) => {
    setC1Config(cfg=>({ ...cfg, devices: typeof updater==="function" ? updater(cfg.devices) : updater }));
  }, [setC1Config]);

  const cfg = c1.config;

  const [scanning, setScanning] = useState(false);
  const [scanNic, setScanNic] = useState("");
  const [consoleH, setConsoleH] = useState(180);
  const consoleDragging = useRef(false);
  const consoleDragStartY = useRef(0);
  const consoleDragStartH = useRef(0);

  const addC1 = (ip) => {
    const name = ip ? `AxonC1-manual` : `AxonC1-${Math.floor(Math.random()*0xffffff).toString(16).padStart(6,"0")}`;
    const addr = ip || "192.168.1.xxx";
    const d    = mkC1(name, addr);
    setC1List(l=>[...l,d]);
    setSelectedC1(d.id);
    if (ip) {
      fetch("/api/device", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ip}) })
        .catch(()=>{});
    }
  };

  const doScan = async () => {
    setScanning(true);
    addLog("INFO", `Scanning network for Axon C1 devices${scanNic ? ` via ${scanNic}` : ""}...`);
    try {
      const r = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nic: scanNic || null }),
      });
      const j = await r.json();
      addLog("INFO", `Scan complete. Found ${j.total} device(s): ${(j.found||[]).join(", ") || "none"}`);
    } catch(e) {
      addLog("ERR", `Scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  };

  // Discovery WebSocket with auto-reconnect
  useEffect(() => {
    let ws = null;
    let dead = false;
    let retryMs = 500;

    function applyDeviceSynced(device_ip, liveConfig, summary) {
      const blocked = blockNextSyncRef.current;
      if (blocked) {
        blockNextSyncRef.current = false;
        addLog("INFO", `Sync from ${device_ip} suppressed (last push had errors) — config preserved.`);
        return;
      }
      addLog("ACK", `Synced ${device_ip}: ${summary?.levels ?? 0} levels, ${summary?.triggers ?? 0} triggers, fw=${summary?.firmware ?? "?"}`);
      setC1List(prev => {
        const idx = prev.findIndex(u => u.ip === device_ip);
        if (idx < 0) {
          const newUnit = _mkC1FromDevice({ ip: device_ip, ...liveConfig });
          newUnit.config = { ...newUnit.config, ...liveConfig, devices: liveConfig.devices ?? [] };
          setSelectedC1(cur => cur ?? newUnit.id);
          return [...prev, newUnit];
        }
        const next = [...prev];
        const existing = next[idx];
        const mergedCfg = { ...existing.config, ...liveConfig, devices: liveConfig.devices ?? [] };
        if (mergedCfg.mainMenu && existing.config.mainMenu)
          mergedCfg.mainMenu = _preserveUserBytes(mergedCfg.mainMenu, existing.config.mainMenu);
        next[idx] = {
          ...existing,
          name:     liveConfig.deviceName || existing.name,
          mac:      liveConfig.mac        || existing.mac,
          firmware: liveConfig.firmwareVersion || existing.firmware,
          config:   mergedCfg,
        };
        return next;
      });
    }

    function connect() {
      if (dead) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws/_discovery`);

      ws.onopen = () => { addLog("INFO", "Discovery WS connected"); retryMs = 500; };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "device_list") {
            const incoming = (msg.devices || []).filter(d => d.ip);
            if (!incoming.length) return;
            setC1List(prev => {
              const existingIps = new Set(prev.map(u => u.ip));
              const fresh = incoming.filter(d => !existingIps.has(d.ip)).map(d => _mkC1FromDevice(d));
              const updated = prev.map(u => { const m = incoming.find(d => d.ip === u.ip); return m ? _applyDeviceInfo(u, m) : u; });
              const next = [...updated, ...fresh];
              if (next.length > 0) setSelectedC1(cur => cur ?? next[0].id);
              return next;
            });
          } else if (msg.type === "device_found" || msg.type === "device_updated") {
            const d = msg.device;
            if (!d?.ip) return;
            addLog("INFO", `Device ${msg.type === "device_found" ? "found" : "updated"}: ${d.ip} ${d.mac || ""} fw=${d.firmware || "?"}`);
            setC1List(prev => {
              const idx = prev.findIndex(u => u.ip === d.ip);
              if (idx >= 0) { const next = [...prev]; next[idx] = _applyDeviceInfo(next[idx], d); return next; }
              const newUnit = _mkC1FromDevice(d);
              if (prev.length === 0) setSelectedC1(newUnit.id);
              return [...prev, newUnit];
            });
          } else if (msg.type === "device_synced") {
            const { device_ip, config: liveConfig, summary } = msg;
            if (device_ip && liveConfig) applyDeviceSynced(device_ip, liveConfig, summary);
          } else if (msg.type === "sync_log") {
            addLog("SYNC", `[${msg.device_ip}] ${msg.msg}`);
          }
        } catch {}
      };

      ws.onclose = () => { if (!dead) { setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 8000); } };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => { dead = true; ws?.close(); };
  }, []);

  const syncDevice = useCallback((ip) => {
    if (!ip || ip === "192.168.1.xxx") return;
    addLog("INFO", `Loading config from ${ip}...`);
    setSyncing(true);
    fetch(`/api/device/${ip}/sync`, { method: "POST" })
      .then(async res => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const ls = buf.split("\n"); buf = ls.pop();
          for (const line of ls) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.result) {
                const { ok, config: liveConfig, error, summary } = obj.result;
                if (ok && liveConfig) {
                  delete liveConfig.svToSlot; delete liveConfig.slotToSV;
                  setC1List(prev => {
                    const idx = prev.findIndex(u => u.ip === ip);
                    if (idx < 0) return prev;
                    const next = [...prev];
                    const ex = next[idx];
                    const syncedCfg = { ...ex.config, ...liveConfig, devices: (liveConfig.devices ?? []).map(d => d.id ? d : { ...d, id: crypto.randomUUID() }) };
                    if (syncedCfg.mainMenu && ex.config.mainMenu)
                      syncedCfg.mainMenu = _preserveUserBytes(syncedCfg.mainMenu, ex.config.mainMenu);
                    next[idx] = { ...ex, name: liveConfig.deviceName || ex.name,
                      mac: liveConfig.mac || ex.mac, firmware: liveConfig.firmwareVersion || ex.firmware,
                      config: syncedCfg };
                    return next;
                  });
                  addLog("ACK", `Config loaded: ${summary?.levels ?? 0} levels, ${summary?.triggers ?? 0} triggers`);
                } else if (!ok) { addLog("ERR", `Sync failed: ${error}`); }
              }
            } catch {}
          }
        }
      })
      .catch(e => addLog("ERR", `Sync request failed: ${e.message}`))
      .finally(() => setSyncing(false));
  }, []);

  useEffect(() => {
    if (!selectedC1) return;
    const unit = c1List.find(u => u.id === selectedC1);
    if (!unit?.ip || unit.ip === "192.168.1.xxx") return;
    syncDevice(unit.ip);
  }, [selectedC1]);

  // Sim panel
  const simPanel = (
    <div style={{ display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 14px 14px",gap:14,overflowY:"auto",flex:1 }}>
      <C1Sim
        config={cfg}
        simNavPath={navState.view === "root" ? null : navState.path}
        simState={simState}
        onSimStateChange={setSimState}
        onBuilderNav={(action) => navigate(action)}
        setConfig={setC1Config}
      />
      <div style={{ width:"100%",display:"flex",flexDirection:"column",gap:10 }}>
        {/* Faders */}
        <div>
          <div style={{ fontSize:9.5,color:C.dim,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingTop:4,borderTop:`1px solid ${C.border}` }}>Faders</div>
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:5 }}>
            <span style={{ fontSize:11,color:C.mid,minWidth:72,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
              {cfg.volMuteScreen.display_txt || "Zone"}
            </span>
            <input type="range" min={-100} max={20} value={cfg.simVol}
              onChange={e=>{ const v=Number(e.target.value); setC1Config(c=>({...c,simVol:v})); addLog("SV",`SV 1 ${v}`); }}
              style={{ flex:1 }} />
            <span style={{ fontFamily:MONO,fontSize:10,color:C.mono,minWidth:36,textAlign:"right",flexShrink:0 }}>
              {cfg.simVol>0?`+${cfg.simVol}`:cfg.simVol}
            </span>
          </div>
          {(() => {
            const levels = [];
            const walk = n => { if(n.entry_type==="level") levels.push(n); (n.entries||[]).forEach(walk); };
            walk(cfg.mainMenu);
            return levels.map((lv, i) => {
              const chVol = cfg.simChannelVols?.[lv.id] ?? lv.level_vol?.minParam ?? -100;
              return (
                <div key={lv.id} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                  <span style={{ fontSize:11,color:C.mid,minWidth:72,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                    {lv.display_txt}
                  </span>
                  <input type="range"
                    min={lv.level_vol?.minParam ?? -100}
                    max={lv.level_vol?.maxParam ?? 20}
                    step={lv.level_vol?.stepSize ?? 2}
                    value={chVol}
                    onChange={e => {
                      const v = Number(e.target.value);
                      setC1Config(c => ({ ...c, simChannelVols: { ...c.simChannelVols, [lv.id]: v } }));
                      addLog("SV", `SV ${lv.level_vol?.channel ?? i+2} ${v}  (${lv.display_txt})`);
                    }}
                    style={{ flex:1 }} />
                  <span style={{ fontFamily:MONO,fontSize:10,color:C.mono,minWidth:36,textAlign:"right",flexShrink:0 }}>
                    {chVol>0?`+${chVol}`:chVol}
                  </span>
                </div>
              );
            });
          })()}
        </div>
        {/* Triggers */}
        {(() => {
          const trigs = [];
          const walk = n => { if(n.entry_type==="action") trigs.push(n); (n.entries||[]).forEach(walk); };
          walk(cfg.mainMenu);
          return trigs.length > 0 ? (
            <div>
              <div style={{ fontSize:9.5,color:C.dim,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingTop:4,borderTop:`1px solid ${C.border}` }}>Triggers</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>
                {trigs.map(t => (
                  <button key={t.id}
                    onClick={()=>{
                      addLog("TR",`TR ${t.triggerNum}  (${t.display_txt})`);
                      const T = 250;
                      setC1Config(c=>({...c,lbOn:false}));
                      setTimeout(()=>setC1Config(c=>({...c,lbOn:true })),T*1);
                      setTimeout(()=>setC1Config(c=>({...c,lbOn:false})),T*2);
                      setTimeout(()=>setC1Config(c=>({...c,lbOn:true })),T*3);
                      setTimeout(()=>setC1Config(c=>({...c,lbOn:false})),T*4);
                      setTimeout(()=>setC1Config(c=>({...c,lbOn:true })),T*5);
                    }}
                    style={{
                      height:24, padding:"0 10px", borderRadius:4,
                      background:C.s1, color:C.mid, border:`1px solid ${C.border}`,
                      fontWeight:500, fontSize:12, cursor:"pointer",
                    }}>
                    {t.display_txt}
                  </button>
                ))}
              </div>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );

  const [selectedDevice, setSelectedDevice] = useState(cfg.devices[0]?.name ?? null);

  const breadcrumb = (() => {
    if (tab !== "builder") return null;
    if (navState.view === "root") return null;
    const mmLabel = cfg.mainMenu?.display_txt || "";
    if (navState.path.length === 0) return [{ label: mmLabel }];
    return [{ label: mmLabel }, ...navState.path.map(s=>({ label:s.label }))];
  })();

  return (
    <div style={{ display:"flex", height:"100vh", overflow:"hidden", fontFamily:SANS, background:C.bg }}>

      {/* NO DEVICES: waiting for discovery */}
      {noDevices && (
        <div style={{ position:"absolute", inset:0, display:"flex", zIndex:10, background:C.bg }}>
          <div style={{
            width:216, flexShrink:0, background:C.s0, borderRight:`1px solid ${C.border}`,
            display:"flex", flexDirection:"column",
          }}>
            <div style={{ padding:"16px 14px 12px", borderBottom:`1px solid ${C.border}` }}>
              <div style={{ fontSize:13, fontWeight:600, color:C.text }}>Axon C1</div>
              <div style={{ fontSize:10, color:C.dim, marginTop:2, fontFamily:MONO }}>configurator</div>
            </div>
            <div style={{ flex:1, display:"flex", flexDirection:"column", padding:"16px 14px", gap:10 }}>
              <div style={{ fontSize:11, color:C.dim, marginBottom:4 }}>No devices found yet.</div>
              <div>
                <div style={{ fontSize:10, color:C.dim, marginBottom:4 }}>Host NIC</div>
                <NicPicker value={scanNic} onChange={setScanNic} compact />
              </div>
              <button onClick={doScan} disabled={scanning} style={{
                height:28, borderRadius:4, border:`1px solid ${C.borderHi}`,
                background:C.s1, color:scanning?C.accent:C.mid, fontFamily:SANS, fontSize:12,
                cursor:scanning?"not-allowed":"pointer",
              }} style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                {scanning ? <Loader size={12} style={{ animation:"spin 1s linear infinite" }} /> : <RefreshCw size={12} />}
                {scanning ? "Scanning..." : "Scan network"}
              </button>
              <button onClick={()=>{ const ip=prompt("Enter device IP:"); if(ip?.trim()) addC1(ip.trim()); }} style={{
                height:28, borderRadius:4, border:`1px solid ${C.border}`,
                background:C.s1, color:C.dim, fontFamily:SANS, fontSize:12, cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              }}><Plus size={12} />  Add by IP</button>
            </div>
          </div>
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:12 }}>
            <div style={{ fontSize:13, color:C.dim }}>{scanning ? "Scanning network..." : "Waiting for device discovery..."}</div>
            <div style={{ fontSize:11, color:C.dim, opacity:.6 }}>Devices appear automatically via mDNS or broadcast scan.</div>
          </div>
        </div>
      )}

      {/* APPLE-STYLE SIDEBAR */}
      <div style={{
        width:216, flexShrink:0,
        background:C.s0, borderRight:`1px solid ${C.border}`,
        display:"flex", flexDirection:"column", overflow:"hidden",
      }}>
        <div style={{ padding:"16px 14px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:C.text, letterSpacing:"-0.01em" }}>Axon C1</div>
          <div style={{ fontSize:10, color:C.dim, marginTop:2, fontFamily:MONO, letterSpacing:"0.02em" }}>
            configurator
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"6px 0" }}>
          <SbSection>Configure</SbSection>
          <SbNavRow icon={<LayoutGrid size={14} />} label="Menu builder"        active={tab==="builder"}  onClick={()=>setTab("builder")} />
          <SbNavRow icon={<Settings size={14} />}    label="Device settings"     active={tab==="settings"} onClick={()=>setTab("settings")} />
          <SbNavRow icon={<Upload size={14} />}      label="Push to device"      active={tab==="push"}     onClick={()=>setTab("push")} />

          <SbSection>3rd party devices</SbSection>
          {cfg.devices.map(d => (
            <SbDeviceRow
              key={d.name}
              device={d}
              active={selectedDevice === d.name && tab === "devices"}
              onClick={() => { setSelectedDevice(d.name); setTab("devices"); }}
            />
          ))}
          <SbAddRow label="Add device" onClick={() => {
            const d = mkDevice("New Device", "10.0.0.1");
            setDevices(ds => [...ds, d]);
            setSelectedDevice(d.name);
            setTab("devices");
          }} />

          <SbSection>Units</SbSection>
          <div style={{ padding:"4px 14px 6px", display:"flex", gap:6, alignItems:"center" }}>
            <button onClick={doScan} disabled={scanning} style={{
              flex:1, height:24, borderRadius:4, border:`1px solid ${scanning ? C.borderHi : C.border}`,
              background: scanning ? C.s2 : C.s1, color: scanning ? C.accent : C.mid,
              fontFamily:SANS, fontSize:11, cursor: scanning ? "not-allowed" : "pointer",
              display:"flex", alignItems:"center", justifyContent:"center", gap:5,
              transition:"all .12s",
            }}>
              {scanning ? <Loader size={11} style={{ animation:"spin 1s linear infinite" }} /> : <RefreshCw size={11} />}
              {scanning ? "Scanning..." : "Scan network"}
            </button>
            <button onClick={() => {
              const ip = prompt("Enter device IP address:");
              if (ip?.trim()) addC1(ip.trim());
            }} style={{
              width:24, height:24, borderRadius:4, border:`1px solid ${C.border}`,
              background:C.s1, color:C.mid, fontFamily:SANS, fontSize:14,
              cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
            }} title="Add by IP"><Plus size={12} /></button>
          </div>

          <div style={{ padding:"2px 14px 6px" }}>
            <div style={{ fontSize:9.5, color:C.dim, marginBottom:3, opacity:.7 }}>Host NIC</div>
            <NicPicker value={scanNic} onChange={setScanNic} compact />
          </div>

          {c1List.length === 0 && !scanning && (
            <div style={{ padding:"4px 14px 6px", fontSize:11, color:C.dim, lineHeight:1.8 }}>
              No devices found yet.<br/>
              <span style={{ fontSize:10, color:C.dim, opacity:.7 }}>Scan runs automatically on start.</span>
            </div>
          )}

          {c1List.map(unit => (
            <SbUnitRow
              key={unit.id}
              unit={unit}
              active={selectedC1 === unit.id}
              onClick={() => { setSelectedC1(unit.id); syncDevice(unit.ip); }}
            />
          ))}
        </div>
      </div>

      {/* MAIN COLUMN */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0, position:"relative" }}>

        {/* Context / breadcrumb bar */}
        <div style={{
          height:36, flexShrink:0,
          borderBottom:`1px solid ${C.border}`, background:C.s0,
          display:"flex", alignItems:"center", padding:"0 14px", gap:6,
        }}>
          {breadcrumb ? (
            <>
              {navState.path.length > 0 && (
                <button onClick={()=>navigate({ type:"POP" })} style={{
                  background:"transparent", border:"none", color:C.dim,
                  cursor:"pointer", padding:"0 4px 0 0", display:"flex", alignItems:"center",
                }}><ChevronLeft size={14} /></button>
              )}
              {breadcrumb.map((b, i) => (
                <span key={i} style={{ display:"flex", alignItems:"center", gap:6 }}>
                  {i > 0 && <ChevronRight size={12} style={{ color:C.dim }} />}
                  <span style={{
                    fontSize:11, cursor: i < breadcrumb.length-1 ? "pointer" : "default",
                    color: i === breadcrumb.length-1 ? C.text : C.dim,
                    fontWeight: i === breadcrumb.length-1 ? 500 : 400,
                  }}
                    onClick={() => {
                      if (i === 0) navigate({ type:"MENU" });
                      else navigate({ type:"GOTO", path: navState.path.slice(0, i) });
                    }}
                  >{b.label}</span>
                </span>
              ))}
            </>
          ) : (
            <span style={{ fontSize:11, fontWeight:500, color:C.text }}>
              {tab === "builder"  ? "Menu builder" :
               tab === "devices"  ? "3rd party devices" :
               tab === "settings" ? "Device settings" :
               tab === "push"     ? "Push to device" : ""}
            </span>
          )}
          <div style={{ flex:1 }} />
          <button
            onClick={() => { setTab("push"); pushRunRef.current?.(); }}
            style={{
              height:24, padding:"0 10px", borderRadius:4,
              border:`1px solid ${C.border}`,
              background: tab === "push" ? C.accent : C.s1,
              color: tab === "push" ? "#0b0d14" : C.mid,
              fontSize:11, fontWeight:500, cursor:"pointer",
              display:"flex", alignItems:"center", gap:5,
              transition:"all .12s",
            }}
          >
            <ArrowUp size={11} /> Push
          </button>
          <span style={{ fontSize:10, color:C.dim, fontFamily:MONO, marginLeft:8 }}>
            {c1.name}
          </span>
        </div>

        {/* Loading bar */}
        <div style={{ height:2, flexShrink:0, background:C.s1, overflow:"hidden" }}>
          {syncing && (
            <div style={{
              height:"100%", background:C.accent,
              animation:"syncBar 1.4s ease-in-out infinite",
            }} />
          )}
        </div>

        {/* Tab content */}
        <div style={{ flex:1, overflow:"hidden", minHeight:0, position:"relative" }}>
          {syncing && (
            <div style={{
              position:"absolute", inset:0, zIndex:20,
              background:"rgba(10,11,18,0.55)",
              display:"flex", alignItems:"center", justifyContent:"center",
              backdropFilter:"blur(1px)",
              pointerEvents:"all",
            }}>
              <div style={{ fontSize:12, color:C.dim, letterSpacing:"0.1em", textTransform:"uppercase" }}>
                Syncing device…
              </div>
            </div>
          )}
          <div style={{ display:tab==="builder"?"flex":"none", height:"100%", overflow:"hidden" }}>
            <div style={{ flex:1, overflow:"hidden" }}>
              <MenuBuilder
                config={cfg}
                setConfig={setC1Config}
                simState={simState}
                navState={navState}
                navigate={navigate}
                onSimCursorChange={(idx) => {
                  setSimState(s => {
                    const offset = idx < s.scrollOffset ? idx
                      : idx >= s.scrollOffset + 4 ? idx - 3
                      : s.scrollOffset;
                    return { ...s, cursorIdx: idx, scrollOffset: Math.max(0, offset) };
                  });
                }}
              />
            </div>
          </div>

          <div style={{ display:tab==="devices"?"flex":"none", flexDirection:"column", height:"100%", overflow:"hidden" }}>
            <DeviceListPanel devices={cfg.devices} setDevices={setDevices} selectedName={selectedDevice} onSelectName={setSelectedDevice} />
          </div>

          <div style={{ display:tab==="settings"?"flex":"none", flexDirection:"column", height:"100%", overflow:"hidden" }}>
            <SettingsPanel config={cfg} setConfig={setC1Config} />
          </div>

          <div style={{ display:tab==="push"?"flex":"none", flexDirection:"column", height:"100%", overflow:"hidden" }}>
            <PushPanel config={cfg} setConfig={setC1Config} runRef={pushRunRef}
              onPushResult={ok => { blockNextSyncRef.current = !ok; }} />
          </div>
        </div>

        {/* Console -- draggable resizable drawer */}
        {(() => {
          const collapsed = consoleH <= 32;
          const onDragStart = (e) => {
            e.preventDefault();
            consoleDragging.current   = true;
            consoleDragStartY.current = e.clientY;
            consoleDragStartH.current = consoleH;
            const onMove = (ev) => {
              if (!consoleDragging.current) return;
              const delta = consoleDragStartY.current - ev.clientY;
              setConsoleH(Math.max(32, Math.min(600, consoleDragStartH.current + delta)));
            };
            const onUp = () => {
              consoleDragging.current = false;
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          };
          return (
            <div style={{
              flexShrink:0, borderTop:`1px solid ${C.border}`, background:C.s0,
              height: collapsed ? 32 : consoleH,
              display:"flex", flexDirection:"column",
            }}>
              <div
                onMouseDown={onDragStart}
                style={{
                  display:"flex", alignItems:"center", height:32, flexShrink:0,
                  borderBottom: collapsed ? "none" : `1px solid ${C.border}`,
                  cursor:"ns-resize", userSelect:"none",
                }}
              >
                <div style={{ padding:"0 10px", display:"flex", flexDirection:"column", gap:2.5, opacity:.3 }}>
                  {[0,1].map(r=>(
                    <div key={r} style={{ display:"flex", gap:2.5 }}>
                      {[0,1,2,3,4].map(i=><div key={i} style={{width:2.5,height:1.5,borderRadius:1,background:C.mid}}/>)}
                    </div>
                  ))}
                </div>
                <span style={{ fontSize:10, fontWeight:500, color:C.dim, fontFamily:MONO, flex:1 }}>console</span>
                <span
                  onClick={e => { e.stopPropagation(); setConsoleH(h => h <= 32 ? 180 : 32); }}
                  style={{ color:C.dim, padding:"0 14px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}
                >{collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
              </div>
              {!collapsed && (
                <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>
                  <LogPanel />
                </div>
              )}
            </div>
          );
        })()}

      </div>

      {/* PREVIEW RAIL */}
      <div style={{
        width:256, flexShrink:0,
        borderLeft:`1px solid ${C.border}`, background:C.s0,
        display:"flex", flexDirection:"column", overflow:"hidden",
      }}>
        <div style={{
          height:36, flexShrink:0,
          borderBottom:`1px solid ${C.border}`,
          display:"flex", alignItems:"center", padding:"0 14px", gap:8,
        }}>
          <span style={{
            width:6, height:6, borderRadius:"50%", background:C.sage,
            boxShadow:`0 0 5px ${C.sage}`, flexShrink:0, display:"inline-block",
          }} />
          <span style={{ fontSize:10, fontWeight:500, color:C.dim, fontFamily:MONO, flex:1 }}>preview</span>
          <span style={{ fontSize:9, color:C.dim, fontFamily:MONO }}>locked</span>
        </div>
        {simPanel}
      </div>

    </div>
  );
}

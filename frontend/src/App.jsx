import React, { useState, useEffect, useRef, useCallback } from "react";
import { LayoutGrid, Settings, Upload, RefreshCw, Plus, ChevronLeft, ChevronRight, ArrowUp, Loader, ChevronUp, ChevronDown, Home } from "lucide-react";
import { C, SANS, G } from "./tokens.js";
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
import { Btn } from "./components/Primitives.jsx";
import AxonLogo from "./components/AxonLogo.jsx";

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
  const [tab, setTab]               = useState("home");
  const pushRunRef                  = useRef(null);
  const blockNextSyncRef            = useRef(false);
  const [navState, setNavState] = useState({ view:"root", path:[] });
  const [pickingC1, setPickingC1] = useState(false);

  // Inline "Add by IP" state (replaces prompt())
  const [showAddIp, setShowAddIp] = useState(false);
  const [addIpVal, setAddIpVal]   = useState("");
  const addIpRef                  = useRef(null);

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

    return()=>{ document.head.removeChild(s); if(ws) ws.close(); };
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

  const doAddByIp = () => {
    const ip = addIpVal.trim();
    if (ip) addC1(ip);
    setAddIpVal("");
    setShowAddIp(false);
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
          <div style={{ fontSize:11,fontWeight:600,color:C.dim,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:8,paddingTop:4,borderTop:`1px solid ${C.border}` }}>Faders</div>
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:5 }}>
            <span style={{ fontSize:11,color:C.mid,minWidth:72,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
              {cfg.volMuteScreen.display_txt || "Zone"}
            </span>
            <input type="range" min={-100} max={20} value={cfg.simVol}
              onChange={e=>{ const v=Number(e.target.value); setC1Config(c=>({...c,simVol:v})); addLog("SV",`SV 1 ${v}`); }}
              style={{ flex:1 }} />
            <span style={{ fontFamily:SANS,fontSize:10,color:C.mono,minWidth:36,textAlign:"right",flexShrink:0 }}>
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
                  <span style={{ fontFamily:SANS,fontSize:10,color:C.mono,minWidth:36,textAlign:"right",flexShrink:0 }}>
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
              <div style={{ fontSize:11,fontWeight:600,color:C.dim,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:8,paddingTop:4,borderTop:`1px solid ${C.border}` }}>Triggers</div>
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

  const openConfig = () => {
    if (c1List.length === 0) return;
    if (c1List.length === 1) {
      setSelectedC1(c1List[0].id);
      setTab("push");
    } else {
      setPickingC1(true);
    }
  };

  const breadcrumb = (() => {
    if (tab !== "builder") return null;
    if (navState.view === "root") return null;
    const mmLabel = cfg.mainMenu?.display_txt || "";
    if (navState.path.length === 0) return [{ label: mmLabel }];
    return [{ label: mmLabel }, ...navState.path.map(s=>({ label:s.label }))];
  })();

  const tabLabel = {
    builder:  "Menu Builder",
    devices:  "3rd Party Devices",
    settings: "Device Settings",
    push:     "Push to Device",
  }[tab] || "";

  return (
    <div style={{ display:"flex", height:"100vh", overflow:"hidden", fontFamily:SANS, background:C.bg }}>

      {/* NO DEVICES: waiting for discovery */}
      {noDevices && (
        <div style={{ position:"absolute", inset:0, display:"flex", zIndex:10, background:C.bg }}>
          <div style={{
            width:216, flexShrink:0,
            background:"linear-gradient(to bottom,#eaeaef 0%,#e2e2e8 100%)",
            borderRight:`1px solid rgba(0,0,0,0.18)`,
            display:"flex", flexDirection:"column",
          }}>
            <div style={{
              height:52, borderBottom:"1px solid #444",
              display:"flex", flexDirection:"row", justifyContent:"center", alignItems:"center", gap:10,
              background:"linear-gradient(to bottom,#e9e9e9 0%,#bbbabb 100%)",
              boxShadow:"0 0 10px #141414", flexShrink:0,
              padding:"0 14px",
            }}>
              <AxonLogo scale={0.8} />
              <div style={{ fontSize:18, color:"#1a1a1a", fontFamily:SANS, fontWeight:300, letterSpacing:"0.02em", lineHeight:1, textShadow:"0 1px 1px rgba(255,255,255,0.6)" }}>configurator</div>
            </div>
            <div style={{ flex:1, display:"flex", flexDirection:"column", padding:"16px 14px", gap:10 }}>
              <div style={{ fontSize:11, color:C.dim, marginBottom:4 }}>No devices found yet.</div>
            </div>
            {/* Bottom bar — controls for discovery, outside the list body */}
            <div style={{ borderTop:`1px solid ${C.border}`, padding:"8px 10px", flexShrink:0, display:"flex", flexDirection:"column", gap:6 }}>
              {showAddIp && (
                <div style={{ display:"flex", gap:4 }}>
                  <input
                    ref={addIpRef}
                    autoFocus
                    value={addIpVal}
                    onChange={e=>setAddIpVal(e.target.value)}
                    onKeyDown={e=>{ if(e.key==="Enter") doAddByIp(); if(e.key==="Escape"){ setShowAddIp(false); setAddIpVal(""); } }}
                    placeholder="e.g. 192.168.1.100"
                    style={{ flex:1, fontSize:11, height:24 }}
                  />
                  <Btn small variant="primary" onClick={doAddByIp}>Add</Btn>
                  <Btn small onClick={()=>{ setShowAddIp(false); setAddIpVal(""); }}>×</Btn>
                </div>
              )}
              <div style={{ display:"flex", gap:4 }}>
                <Btn small disabled={scanning} onClick={doScan} style={{ flex:1, justifyContent:"center" }}>
                  {scanning ? <Loader size={11} style={{ animation:"spin 1s linear infinite" }} /> : <RefreshCw size={11} />}
                  {scanning ? "Scanning…" : "Scan Network"}
                </Btn>
                <Btn small active={showAddIp} onClick={()=>{ setShowAddIp(v=>!v); setAddIpVal(""); }} title="Add by IP" style={{ width:26, padding:0, justifyContent:"center", flexShrink:0 }}>
                  <Plus size={12} />
                </Btn>
              </div>
              <div>
                <div style={{ fontSize:10, color:C.dim, marginBottom:3 }}>Network Interface</div>
                <NicPicker value={scanNic} onChange={setScanNic} compact />
              </div>
            </div>
          </div>
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:64, padding:"0 48px" }}>

            {/* Left: logo + welcome */}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, flexShrink:0 }}>
              <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-start" }}>
                <AxonLogo scale={2.2} />
                <div style={{ fontSize:28, fontWeight:300, color:C.dim, fontFamily:SANS, letterSpacing:"0.02em", lineHeight:1, paddingLeft:41, marginTop:3 }}>configurator</div>
              </div>
              <div style={{ fontSize:28, fontWeight:300, color:C.text, fontFamily:SANS, letterSpacing:"-0.02em", marginTop:16 }}>Welcome.</div>
            </div>

            {/* Divider */}
            <div style={{ width:1, height:160, background:C.border, flexShrink:0 }} />

            {/* Right: steps + buttons */}
            <div style={{ display:"flex", flexDirection:"column", gap:20, maxWidth:280 }}>
              <div style={{ fontSize:15, fontWeight:500, color:C.text }}>Start in just 3 easy steps:</div>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {[
                  { n:"1.", text:"Plug your Axon C1 into the network." },
                  { n:"2.", text:"Select your Network Interface in the sidebar. This tells the app which adapter to scan." },
                  { n:"3.", text:"Hit Scan and your device pops up automatically. That's it!" },
                ].map(s => (
                  <div key={s.n} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                    <div style={{ fontSize:13, fontWeight:600, color:C.dim, flexShrink:0, minWidth:16 }}>{s.n}</div>
                    <div style={{ fontSize:13, color:C.mid, lineHeight:1.5 }}>{s.text}</div>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:8, marginTop:4 }}>
                <Btn variant="primary" onClick={openConfig}>{c1List.length > 0 ? "Open Config" : "Open Config Offline"}</Btn>
                <Btn onClick={() => {}}>Simulator Mode</Btn>
              </div>
              {showAddIp && (
                <div style={{ display:"flex", gap:4 }}>
                  <input
                    ref={addIpRef} autoFocus value={addIpVal}
                    onChange={e => setAddIpVal(e.target.value)}
                    onKeyDown={e => { if(e.key==="Enter") doAddByIp(); if(e.key==="Escape"){ setShowAddIp(false); setAddIpVal(""); } }}
                    placeholder="e.g. 192.168.1.100"
                    style={{ flex:1, fontSize:12, height:28 }}
                  />
                  <Btn variant="primary" onClick={doAddByIp}>Add</Btn>
                  <Btn onClick={() => { setShowAddIp(false); setAddIpVal(""); }}>×</Btn>
                </div>
              )}
            </div>

          </div>
          <div style={{ position:"absolute", bottom:12, left:216, right:0, textAlign:"center", fontSize:10, color:C.dim, opacity:0.5, fontFamily:SANS, padding:"0 48px", lineHeight:1.6 }}>
            This is an independent, community-built tool and is not affiliated with, endorsed by, or sponsored by Attero Tech, QSC, or any of their subsidiaries, partners, or related parties. All product names and trademarks are the property of their respective owners.
          </div>
        </div>
      )}

      {/* SIDEBAR (source list) */}
      <div style={{
        width:216, flexShrink:0,
        background:"linear-gradient(to bottom,#eaeaef 0%,#e2e2e8 100%)",
        borderRight:`1px solid rgba(0,0,0,0.18)`,
        display:"flex", flexDirection:"column", overflow:"hidden",
      }}>
        <div style={{
          height:52, borderBottom:"1px solid #444",
          flexShrink:0, display:"flex", flexDirection:"row", justifyContent:"center", alignItems:"center", gap:10,
          background:"linear-gradient(to bottom,#e9e9e9 0%,#bbbabb 100%)",
          boxShadow:"0 0 10px #141414",
          padding:"0 14px",
        }}>
          <AxonLogo scale={0.8} />
          <div style={{ fontSize:18, color:"#1a1a1a", fontFamily:SANS, fontWeight:300, letterSpacing:"0.02em", lineHeight:1, textShadow:"0 1px 1px rgba(255,255,255,0.6)" }}>configurator</div>
        </div>

        {/* Scrollable list body — source list proper */}
        <div style={{ flex:1, overflowY:"auto", padding:"6px 0" }}>
          <div style={{ height:8 }} />
          <SbNavRow icon={<Home size={14} />} label="Home" active={tab==="home"} onClick={()=>setTab("home")} />
          <SbSection>Configure</SbSection>
          <SbNavRow icon={<LayoutGrid size={14} />} label="Menu Builder"        active={tab==="builder"}  onClick={()=>setTab("builder")} />
          <SbNavRow icon={<Settings size={14} />}    label="Device Settings"     active={tab==="settings"} onClick={()=>setTab("settings")} />
          <SbNavRow icon={<Upload size={14} />}      label="Push to Device"      active={tab==="push"}     onClick={()=>setTab("push")} />

          <SbSection>3rd Party Devices</SbSection>
          {cfg.devices.map((d,i) => (
            <SbDeviceRow
              key={d.name}
              device={d}
              index={i}
              active={selectedDevice === d.name && tab === "devices"}
              onClick={() => { setSelectedDevice(d.name); setTab("devices"); }}
            />
          ))}
          <SbAddRow label="Add Device" onClick={() => {
            const d = mkDevice("New Device", "10.0.0.1");
            setDevices(ds => [...ds, d]);
            setSelectedDevice(d.name);
            setTab("devices");
          }} />

          <SbSection>Units</SbSection>
          {c1List.length === 0 && !scanning && (
            <div style={{ padding:"4px 14px 6px", fontSize:11, color:C.dim, lineHeight:1.8 }}>
              No devices found yet.
            </div>
          )}
          {c1List.map((unit,i) => (
            <SbUnitRow
              key={unit.id}
              unit={unit}
              index={i}
              active={selectedC1 === unit.id}
              onClick={() => { setSelectedC1(unit.id); syncDevice(unit.ip); }}
            />
          ))}
        </div>

        {/* Sidebar bottom bar — scan / add controls live here, not in the list body */}
        <div style={{ borderTop:`1px solid ${C.border}`, padding:"8px 10px", flexShrink:0, display:"flex", flexDirection:"column", gap:6 }}>
          {showAddIp && (
            <div style={{ display:"flex", gap:4 }}>
              <input
                ref={addIpRef}
                autoFocus
                value={addIpVal}
                onChange={e=>setAddIpVal(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter") doAddByIp(); if(e.key==="Escape"){ setShowAddIp(false); setAddIpVal(""); } }}
                placeholder="e.g. 192.168.1.100"
                style={{ flex:1, fontSize:11, height:24 }}
              />
              <Btn small variant="primary" onClick={doAddByIp}>Add</Btn>
              <Btn small onClick={()=>{ setShowAddIp(false); setAddIpVal(""); }}>×</Btn>
            </div>
          )}
          <div style={{ display:"flex", gap:4 }}>
            <Btn small disabled={scanning} onClick={doScan} style={{ flex:1, justifyContent:"center" }}>
              {scanning ? <Loader size={11} style={{ animation:"spin 1s linear infinite" }} /> : <RefreshCw size={11} />}
              {scanning ? "Scanning…" : "Scan Network"}
            </Btn>
            <Btn small active={showAddIp} onClick={()=>{ setShowAddIp(v=>!v); setAddIpVal(""); }} title="Add by IP" style={{ width:26, padding:0, justifyContent:"center", flexShrink:0 }}>
              <Plus size={12} />
            </Btn>
          </div>
          <div>
            <div style={{ fontSize:10, color:C.dim, marginBottom:3 }}>Network Interface</div>
            <NicPicker value={scanNic} onChange={setScanNic} compact />
          </div>
        </div>
      </div>

      {/* MAIN COLUMN */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0, position:"relative" }}>

        {/* Toolbar / breadcrumb bar */}
        {tab !== "home" && <div style={{
          height:52, flexShrink:0,
          borderBottom:"1px solid #444",
          background:"linear-gradient(to bottom,#e9e9e9 0%,#bbbabb 100%)",
          display:"flex", alignItems:"center", padding:"0 14px",
          boxShadow:"0 0 10px #141414",
          position:"relative",
        }}>
          {/* Back button — left-anchored, only in breadcrumb mode */}
          <div style={{ width:24, flexShrink:0 }}>
            {breadcrumb && navState.path.length > 0 && (
              <button onClick={()=>navigate({ type:"POP" })} style={{
                background:"transparent", border:"none", color:C.dim,
                cursor:"pointer", padding:0, display:"flex", alignItems:"center",
              }}><ChevronLeft size={14} /></button>
            )}
          </div>

          {/* Center label: "Device {name} - {title}" */}
          <div style={{
            position:"absolute", left:0, right:0, top:0, bottom:0,
            display:"flex", alignItems:"center", justifyContent:"center",
            pointerEvents:"none",
          }}>
            <span style={{ fontSize:13, fontWeight:500, color:C.text }}>
              {c1.name ? `Device ${c1.name} – ` : ""}
              {breadcrumb ? breadcrumb.map((b,i)=>(
                <span key={i}>
                  {i > 0 && <span> / </span>}
                  <span>{b.label}</span>
                </span>
              )) : tabLabel}
            </span>
          </div>

          <div style={{ flex:1 }} />

          {/* Push button — right-anchored */}
          <button
            onClick={() => { setTab("push"); pushRunRef.current?.(); }}
            style={{
              height:26, padding:"0 12px", borderRadius:5,
              border: tab === "push" ? "1px solid #56578f" : "1px solid #9a9a9a",
              background: tab === "push"
                ? "linear-gradient(to bottom, #d4e9fc 0%, #a1d1f9 50%, #87c5fb 50%, #d3f7fd 100%)"
                : "linear-gradient(to bottom, #ffffff 0%, #f3f3f3 50%, #ececec 50%, #ebebeb 100%)",
              color: C.text,
              fontSize:12, fontWeight:400, cursor:"pointer",
              display:"flex", alignItems:"center", gap:5,
              boxShadow: tab === "push"
                ? "inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 0 rgba(0,0,0,0.12)"
                : "inset 0 1px 0 rgba(255,255,255,1), 0 1px 0 rgba(0,0,0,0.09)",
              textShadow:"0 1px 0 rgba(255,255,255,0.8)",
            }}
          >
            <ArrowUp size={11} /> Push
          </button>
        </div>}

        {/* Sync progress bar (non-blocking) */}
        <div style={{ height:2, flexShrink:0, background:C.s2, overflow:"hidden" }}>
          {syncing && (
            <div style={{
              height:"100%", background:C.accent,
              animation:"syncBar 1.4s ease-in-out infinite",
            }} />
          )}
        </div>

        {/* Tab content */}
        <div style={{ flex:1, overflow:"hidden", minHeight:0, position:"relative", background:C.s1 }}>
          {/* Pick-a-unit modal for "Open Config" when multiple Axons are discovered */}
          {pickingC1 && (
            <div style={{
              position:"absolute", inset:0, zIndex:20,
              background:"rgba(0,0,0,0.25)",
              backdropFilter:"blur(2px)",
              display:"flex", alignItems:"center", justifyContent:"center",
            }} onClick={() => setPickingC1(false)}>
              <div style={{
                background:C.s1, border:`1px solid ${C.border}`,
                boxShadow:"0 4px 20px rgba(0,0,0,.18)",
                padding:"20px", minWidth:240,
                display:"flex", flexDirection:"column", gap:12,
              }} onClick={e => e.stopPropagation()}>
                <div style={{ fontSize:13, fontWeight:600, color:C.text }}>Select a device to configure</div>
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {c1List.map(unit => (
                    <button key={unit.id} onClick={() => {
                      setSelectedC1(unit.id);
                      setTab("push");
                      setPickingC1(false);
                    }} style={{
                      background:"none", border:`1px solid ${C.border}`,
                      padding:"7px 12px", cursor:"pointer",
                      textAlign:"left", fontSize:13, color:C.text,
                      fontFamily:SANS,
                    }}>
                      <div style={{ fontWeight:500 }}>{unit.name || unit.id}</div>
                      {unit.ip && <div style={{ fontSize:11, color:C.dim }}>{unit.ip}</div>}
                    </button>
                  ))}
                </div>
                <Btn onClick={() => setPickingC1(false)}>Cancel</Btn>
              </div>
            </div>
          )}

          {/* Non-blocking loading veil: dims content while sync is in progress */}
          {syncing && (
            <div style={{
              position:"absolute", inset:0, zIndex:10,
              background: `${C.bg}99`,
              backdropFilter:"blur(1px)",
              display:"flex", alignItems:"center", justifyContent:"center",
              pointerEvents:"none",
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, background:C.s1,
                border:`1px solid ${C.border}`, padding:"7px 14px",
                boxShadow:"0 2px 8px rgba(0,0,0,.08)",
              }}>
                <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation:"spin .9s linear infinite", flexShrink:0 }}>
                  <circle cx="7" cy="7" r="5.5" fill="none" stroke={C.border} strokeWidth="2"/>
                  <path d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <span style={{ fontSize:11, color:C.mid }}>Loading config…</span>
              </div>
            </div>
          )}
          {tab==="home" && (
            <div style={{
              flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:64, padding:"0 48px", position:"relative", height:"100%", overflow:"hidden",
              background:[
                `radial-gradient(at 50% 120%, rgba(255,255,255,0.4) 0px, transparent 50%)`,
                `radial-gradient(at 96.4% 100%, rgba(105,177,229,0.4) 0px, transparent 50%)`,
                `radial-gradient(at 64.1% 100%, rgba(238,238,238,0.4) 0px, transparent 50%)`,
                `radial-gradient(at 20.9% 100%, rgba(170,170,170,0.4) 0px, transparent 50%)`,
                `radial-gradient(at 14.8% 97.7%, rgba(255,255,255,0.4) 0px, transparent 50%)`,
                `radial-gradient(at 62.1% 82.8%, rgba(170,170,170,0.4) 0px, transparent 50%)`,
              ].join(",") + " #fff",
            }}>
              <div style={{
                position:"absolute", inset:0, pointerEvents:"none",
                backgroundImage:`url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><defs><filter id='n' x='0' y='0' width='100%25' height='100%25' color-interpolation-filters='sRGB'><feTurbulence type='fractalNoise' baseFrequency='0.3' numOctaves='3' stitchTiles='stitch' result='t'/><feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.48 0 0 0 -0.126' in='t' result='g'/></filter></defs><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`,
                backgroundSize:"6.5%",
                backgroundPosition:"center",
                backgroundRepeat:"repeat",
                opacity:0.2,
              }} />
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, flexShrink:0 }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-start" }}>
                  <AxonLogo scale={2.2} />
                  <div style={{ fontSize:28, fontWeight:300, color:C.dim, fontFamily:SANS, letterSpacing:"0.02em", lineHeight:1, paddingLeft:41, marginTop:3 }}>configurator</div>
                </div>
                <div style={{ fontSize:28, fontWeight:300, color:C.text, fontFamily:SANS, letterSpacing:"-0.02em", marginTop:16 }}>Welcome.</div>
              </div>
              <div style={{ width:1, height:160, background:C.border, flexShrink:0 }} />
              <div style={{ display:"flex", flexDirection:"column", gap:20, maxWidth:280 }}>
                <div style={{ fontSize:15, fontWeight:500, color:C.text }}>Start in just 3 easy steps:</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {[
                    { n:"1.", text:"Plug your Axon C1 into the network." },
                    { n:"2.", text:"Select your Network Interface in the sidebar. This tells the app which adapter to scan." },
                    { n:"3.", text:"Hit Scan and your device pops up automatically. That's it!" },
                  ].map(s => (
                    <div key={s.n} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                      <div style={{ fontSize:13, fontWeight:600, color:C.dim, flexShrink:0, minWidth:16 }}>{s.n}</div>
                      <div style={{ fontSize:13, color:C.mid, lineHeight:1.5 }}>{s.text}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:8, marginTop:4 }}>
                  <Btn variant="primary" onClick={openConfig}>{c1List.length > 0 ? "Open Config" : "Open Config Offline"}</Btn>
                  <Btn onClick={() => {}}>Simulator Mode</Btn>
                </div>
              </div>
              <div style={{ position:"absolute", bottom:12, left:0, right:0, textAlign:"center", fontSize:10, color:C.dim, opacity:0.5, fontFamily:SANS, padding:"0 48px", lineHeight:1.6 }}>
                This is an independent, community-built tool and is not affiliated with, endorsed by, or sponsored by Attero Tech, QSC, or any of their subsidiaries, partners, or related parties. All product names and trademarks are the property of their respective owners.
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

        {/* Console — draggable resizable drawer */}
        {tab !== "home" && (() => {
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
                <div style={{ padding:"0 10px", display:"flex", flexDirection:"column", gap:2.5, opacity:.25 }}>
                  {[0,1].map(r=>(
                    <div key={r} style={{ display:"flex", gap:2.5 }}>
                      {[0,1,2,3,4].map(i=><div key={i} style={{width:2.5,height:1.5,background:C.mid}}/>)}
                    </div>
                  ))}
                </div>
                <span style={{ fontSize:14, fontWeight:800, color:"rgb(99,99,115)", fontFamily:SANS, flex:1 }}>Console</span>
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
      {tab !== "home" && <div style={{
        width:256, flexShrink:0,
        borderLeft:`1px solid ${C.border}`, background:C.s0,
        display:"flex", flexDirection:"column", overflow:"hidden",
      }}>
        <div style={{
          height:52, flexShrink:0,
          borderBottom:"1px solid #444",
          background:"linear-gradient(to bottom,#e9e9e9 0%,#bbbabb 100%)",
          boxShadow:"0 0 10px #141414",
        }} />
        {simPanel}
      </div>}

    </div>
  );
}

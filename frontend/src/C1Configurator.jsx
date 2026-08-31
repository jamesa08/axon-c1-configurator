import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// --- TOKENS (Warp x ClickHouse remix) -----------------------------------------
// Warp's depth system + ClickHouse's density philosophy + sienna brand accent
const C = {
  // Surface stack (Warp-derived) — depth through bg steps, never shadows
  bg:        "#0b0d14",   // deepest bg
  s0:        "#11141d",   // sidebar / panel bg
  s1:        "#161a25",   // card / surface
  s2:        "#1e2331",   // raised / hover
  s3:        "#252b3a",   // border-adjacent
  border:    "#232838",   // normal border
  borderHi:  "#2e3447",   // strong border / focus ring base

  // Text (Warp-derived)
  text:      "#f1f1f4",   // primary
  mid:       "#9aa1b3",   // muted labels
  dim:       "#5f6580",   // placeholder / disabled

  // Mono values — slightly warmer than pure white
  mono:      "#b8cdd8",

  // Primary accent: sienna (replaces Warp's teal)
  accent:    "#c87941",
  accentDim: "#2a1808",
  accentHi:  "#e0924e",

  // Secondary: sage (success / ACK / status)
  sage:      "#5db897",
  sageDim:   "#0d2820",

  // Danger / warn
  danger:    "#e05555",
  dangerDim: "#2a0d0d",
  warn:      "#d4913a",
  warnDim:   "#2a1a06",

  // Protocol log colors
  green:     "#5db897",
  greenDim:  "#0d2820",
  blue:      "#5c8fcf",
  blueDim:   "#0d1e36",

  // LCD
  lcd:       "#c8dce8",
  lcdBg:     "#000000",
};

// Aliases for compatibility
C.orange    = C.accent;
C.orangeDim = C.accentDim;
C.greenMid  = C.sageDim;

// IBM Plex Sans for UI labels, JetBrains Mono for every value/number/ID (Warp signature)
const MONO = "'JetBrains Mono','Fira Code','Consolas',monospace";
const SANS = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const G = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{
  background:${C.bg};color:${C.text};
  font-family:${SANS};font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;font-weight:400;
  font-variant-numeric:tabular-nums;
}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${C.borderHi};border-radius:2px}
::selection{background:${C.accentDim};color:${C.accentHi}}

/* Inputs: bg-alt fill, 1px border-strong, 4px radius, mono for values */
input,select,textarea{
  background:${C.s0};color:${C.text};
  border:1px solid ${C.borderHi};
  border-radius:4px;
  font-family:${SANS};font-size:12px;font-weight:400;
  height:28px;padding:0 8px;outline:none;
  transition:border-color .12s;width:100%;
}
input:focus,select:focus{
  border-color:${C.accent};
  box-shadow:0 0 0 2px ${C.accentDim};
}
input[type=range]{
  padding:0;height:auto;background:transparent;border:none;
  box-shadow:none;cursor:pointer;accent-color:${C.accent};
}
input[type=checkbox]{width:13px;height:13px;cursor:pointer;accent-color:${C.accent}}
input[type=color]{padding:2px;cursor:pointer;border-radius:4px}
select{cursor:pointer}
button{
  cursor:pointer;font-family:${SANS};border:none;outline:none;
  font-size:12px;font-weight:400;
}
`;


// --- HELPERS ------------------------------------------------------------------
let _id = 0;
const uid  = () => (++_id).toString(36);
const pad2 = n => String(n).padStart(2, "0");
const nowStr = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,"0")}`; };

// Build SV set bytes: "SV N \xe3\r"
const svSetBytes  = ch => [...`SV ${ch} `].map(c=>c.charCodeAt(0)).concat([0xe3, 0x0d]);
const svQueryBytes = ch => [...`SV ${ch} `].map(c=>c.charCodeAt(0)).concat([0x0d]);
const svRespBytes  = ch => svSetBytes(ch);
const trBytes     = n  => [...`TR ${n}`].map(c=>c.charCodeAt(0)).concat([0x0d]);
const bytesToStr  = arr => arr.length ? arr.map(b => b === 0xe3 ? "\\xe3" : b === 0x0d ? "\\r" : String.fromCharCode(b)).join("") : "(empty)";

// --- LOG BUS ------------------------------------------------------------------
const LOG = { cbs:[], entries:[], push(e){ this.entries=[e,...this.entries].slice(0,400); this.cbs.forEach(f=>f(this.entries)); }};
const addLog = (type, msg) => LOG.push({ id:uid(), time:nowStr(), type, msg });
const useLog = () => { const [e,setE]=useState(LOG.entries); useEffect(()=>{ const f=v=>setE([...v]); LOG.cbs.push(f); return ()=>{LOG.cbs=LOG.cbs.filter(x=>x!==f)}; },[]); return e; };

// --- DEFAULT DATA -------------------------------------------------------------
const mkDevice = (name, ip, port, asyncPort) => ({ id:uid(), name, ip, port:port??49500, asyncIp:ip, asyncPort:asyncPort??49500, proto:"UDP", type:"general" });

const mkLevelVol = (ch, devName) => ({
  setBytes:       svSetBytes(ch),
  queryBytes:     svQueryBytes(ch),
  respQueryBytes: svRespBytes(ch),
  syncBytes:      svSetBytes(ch),
  minParam: -100, maxParam: 20, stepSize: 2, paramDecPts: 0,
  trimEnable: false, pollMs: 500,
  queryEnable: true, asyncEnable: true,
  ackEnable: false, headerText: "",
  levelPreStr: "", levelPostStr: "",
  setter_type: 1,  // 1=explicit
  set_dev_name: devName,
  footerEnable: 1,
  active:[], altActive:[], altInactive:[], inactive:[],
  asyncAltResponse:false, queryAltResponse:false, setAltResponse:false,
});

const mkLevelMute = (devName) => ({
  setBytes:[], queryBytes:[], respQueryBytes:[], syncBytes:[],
  minParam:0, maxParam:0, stepSize:0, paramDecPts:0,
  trimEnable:false, pollMs:500,
  queryEnable:false, asyncEnable:false,
  ackEnable:false, headerText:"",
  levelPreStr:"", levelPostStr:"",
  setter_type:0,  // 0=stateless
  set_dev_name: devName,
  footerEnable: 0,
  active:[], altActive:[], altInactive:[], inactive:[],
  asyncAltResponse:false, queryAltResponse:false, setAltResponse:false,
});

const mkLevelEntry = (name, ch, devName) => ({
  id: uid(), entry_type:"level",
  display_txt: name,
  binary: false,
  level_vol:  mkLevelVol(ch, devName),
  level_mute: mkLevelMute(devName),
});

const mkTriggerEntry = (name, n, devName) => ({
  id: uid(), entry_type:"action",
  display_txt: name,
  binary: false,
  action_type: "3rd_party",
  bytes: trBytes(n),
  dev: devName,
  cr: true, lf: false,
  triggerNum: n,
});

const mkMenuEntry = (name) => ({ id:uid(), entry_type:"menu", display_txt:name, entries:[] });

const mkDefaultConfig = () => {
  const devices = [
    mkDevice("QSC",      "192.168.1.10",  49500, 49500),
    mkDevice("Computer", "192.168.1.100", 49494, 49494),
  ];
  const devName = devices[0].name;
  const volMuteScreen = mkLevelEntry("Vol/Mute Screen", 1, devName);
  volMuteScreen._isRoot = true; // 0xFFFE

  const mainMenu = mkMenuEntry("MAIN MENU");
  const levels18  = mkMenuEntry("LEVELS 1-8");
  const levels915 = mkMenuEntry("LEVELS 9-16");
  const triggers  = mkMenuEntry("TRIGGERS");
  for (let i=1;i<=8;i++)  levels18.entries.push(mkLevelEntry(`G${i}`,   i+1, devName));
  for (let i=9;i<=16;i++) levels915.entries.push(mkLevelEntry(`G${i}`, i+1, devName));
  for (let i=1;i<=8;i++)  triggers.entries.push(mkTriggerEntry(`Entry - ${i}`, i, devName));
  mainMenu.entries = [levels18, levels915, triggers];

  return {
    volMuteEnabled: true,
    menuEnabled: true,
    volMuteScreen,
    mainMenu,
    devices,
    // device settings
    deviceName: "AxonC1-000000",
    ip: "192.168.1.200",
    mac: "00:1c:e2:f0:9c:3a",
    firmwareVersion: "1.5.0",
    configHash: "NONE",
    mode: "THIRD_PARTY",
    displayBrightness: 7,
    displayTimeout: 60,
    displayRotation: 0,
    displayLock: 0,
    lbBrightness: 7,
    lbTimeout: 60,
    lbColor: "#ffffff",
    lbOn: true,
    lbColorMode: 0,
    pinEnabled: false,
    pin: "0000",
    dhcp: true,
    staticIp: "", staticMask: "", staticGw: "",
    destIp: "192.168.1.10",
    destPort: 49500,
    // sim state
    simVol: -12,
    simMutes: {},
    simChannelVols: {}, // per-level-entry id -> current dB value
    simScreen: "menu", // "menu" | "volmute" | "fader"
    simFaderEntry: null, // the level entry currently being faded (for "fader" screen)
  };
};

// --- PRIMITIVE COMPONENTS -----------------------------------------------------

function Btn({ children, variant="default", onClick, disabled, style, small, active }) {
  const [hov,setHov] = useState(false);
  const v = {
    default: { bg:C.s1,       color:C.mid,    border:`1px solid ${C.border}`,              hbg:C.s2 },
    primary: { bg:C.accent,   color:"#0b0d14", border:`1px solid ${C.accent}`,             hbg:C.accentHi },
    ghost:   { bg:"transparent", color:C.dim,  border:`1px solid ${C.border}`,             hbg:C.s1 },
    danger:  { bg:C.dangerDim, color:C.danger, border:`1px solid rgba(224,85,85,0.3)`,     hbg:C.dangerDim },
    green:   { bg:C.sageDim,   color:C.sage,   border:`1px solid rgba(93,184,151,0.3)`,    hbg:C.sageDim },
  }[variant] || {};
  return (
    <button onClick={onClick} disabled={disabled}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{
        height: small ? 24 : 28,
        padding: small ? "0 10px" : "0 14px",
        borderRadius: 4,
        background: active ? C.s2 : hov ? v.hbg : v.bg,
        color: active ? C.accent : v.color,
        border: active ? `1px solid ${C.borderHi}` : v.border,
        fontWeight: 500,
        opacity: disabled ? 0.35 : 1,
        transition: "background .12s, color .12s",
        whiteSpace: "nowrap",
        display: "inline-flex", alignItems: "center", gap: 5,
        letterSpacing: "0.01em",
        ...style,
      }}>
      {children}
    </button>
  );
}

function Toggle({ value, onChange, disabled }) {
  return (
    <div onClick={()=>!disabled&&onChange(!value)}
      style={{
        width:32, height:17, borderRadius:8,
        background: value ? C.accent : C.s2,
        border: `1px solid ${value ? C.accent : C.borderHi}`,
        position:"relative", cursor:disabled?"not-allowed":"pointer",
        transition:"background .15s, border-color .15s",
        flexShrink:0, opacity:disabled?0.35:1,
      }}>
      <div style={{
        position:"absolute", top:2.5, left:value?16:2.5, width:11, height:11,
        borderRadius:6, background: value ? "#0b0d14" : C.mid,
        transition:"left .15s", boxShadow:"0 1px 2px rgba(0,0,0,0.5)",
      }} />
    </div>
  );
}

function Tag({ children, color="dim" }) {
  const m = {
    green:  { bg:C.sageDim,   c:C.sage   },
    orange: { bg:C.accentDim, c:C.accent },
    blue:   { bg:C.blueDim,   c:C.blue   },
    warn:   { bg:C.warnDim,   c:C.warn   },
    danger: { bg:C.dangerDim, c:C.danger },
    dim:    { bg:C.s2,        c:C.dim    },
  };
  const s = m[color]||m.dim;
  return (
    <span style={{
      display:"inline-block", background:s.bg, color:s.c,
      fontFamily:MONO, fontSize:10, fontWeight:500,
      padding:"1px 6px", borderRadius:3,
      letterSpacing:"0.04em", lineHeight:"17px",
    }}>{children}</span>
  );
}

function HR() { return <div style={{ height:"1px", background:C.border, margin:"14px 0" }} />; }

function SectionHead({ children }) {
  return (
    <div style={{
      fontSize:10, fontWeight:600, letterSpacing:"0.08em",
      textTransform:"uppercase", color:C.dim,
      marginBottom:10, paddingBottom:8,
      borderBottom:`1px solid ${C.border}`,
    }}>{children}</div>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:12, minHeight:28 }}>
      <div style={{ minWidth:140, paddingTop:6, flexShrink:0 }}>
        <div style={{ fontSize:12, color:C.mid }}>{label}</div>
        {hint && <div style={{ fontSize:10, color:C.dim, marginTop:1, lineHeight:1.4, fontFamily:MONO }}>{hint}</div>}
      </div>
      <div style={{ flex:1, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>{children}</div>
    </div>
  );
}

function Stack({ children, gap=10 }) {
  return <div style={{ display:"flex", flexDirection:"column", gap }}>{children}</div>;
}

function Row({ children, gap=8 }) {
  return <div style={{ display:"flex", alignItems:"center", gap }}>{children}</div>;
}

function Tabs({ tabs, active, onSelect }) {
  return (
    <div style={{ display:"flex", borderBottom:`1px solid ${C.border}`, marginBottom:12 }}>
      {tabs.map(t=>(
        <button key={t} onClick={()=>onSelect(t)} style={{
          padding:"6px 14px", fontFamily:SANS, fontSize:12, fontWeight:500,
          background:"transparent", border:"none", cursor:"pointer",
          color: active===t ? C.text : C.dim,
          borderBottom: active===t ? `2px solid ${C.accent}` : "2px solid transparent",
          marginBottom:-1, transition:"color .12s",
        }}>{t}</button>
      ))}
    </div>
  );
}


// --- C1 PANEL SIMULATOR -------------------------------------------------------

function C1Sim({ config, simNavPath, simState, onSimStateChange, onBuilderNav, setConfig }) {
  const { simVol, simScreen, mainMenu, volMuteScreen, volMuteEnabled, menuEnabled } = config;

  const isBuilderAtRoot = simNavPath === null;
  const navPath         = simNavPath || [];
  const cursorIdx       = simState?.cursorIdx ?? 0;
  const scrollOffset    = simState?.scrollOffset ?? 0;

  const volStr = v => v > 0 ? `+${v}` : `${v}`;

  const resolveMenu = useCallback((path) => {
    let node = mainMenu;
    for (const step of path) {
      const found = node.entries?.find(e => e.id === step.id);
      if (!found) return node;
      node = found;
    }
    return node;
  }, [mainMenu]);

  const currentMenu = resolveMenu(navPath);
  const allEntries  = currentMenu?.entries || [];
  const totalItems  = allEntries.length;

  const clampedScroll = Math.min(Math.max(0, scrollOffset), Math.max(0, totalItems - 4));
  const windowEntries = allEntries.slice(clampedScroll, clampedScroll + 4);
  const canScrollUp   = clampedScroll > 0;
  const canScrollDown = clampedScroll + 4 < totalItems;

  // -- KNOB drag --------------------------------------------------------------
  const knobDrag = useRef({ active: false, lastY: 0, accumulated: 0 });

  const onKnobMouseDown = useCallback((e) => {
    e.preventDefault();
    knobDrag.current = { active: true, lastY: e.clientY, accumulated: 0 };
  }, []);

  useEffect(() => {
    const STEP_PX = 12;
    const onMouseMove = (e) => {
      if (!knobDrag.current.active) return;
      const dy = e.clientY - knobDrag.current.lastY;
      knobDrag.current.accumulated += dy;
      knobDrag.current.lastY = e.clientY;

      // Knob drag in menu mode moves cursor; in volmute/fader mode changes volume
      if (simScreen === "menu") {
        const steps = Math.round(knobDrag.current.accumulated / STEP_PX);
        if (Math.abs(steps) >= 1) {
          knobDrag.current.accumulated -= steps * STEP_PX;
          onSimStateChange(s => {
            const cur  = s.cursorIdx ?? 0;
            const scr  = s.scrollOffset ?? 0;
            const next = Math.max(0, Math.min(totalItems - 1, cur + steps));
            const newScr = next < scr ? next : next >= scr + 4 ? next - 3 : scr;
            return { ...s, cursorIdx: next, scrollOffset: Math.max(0, newScr) };
          });
        }
      } else {
        // volmute or fader: drag changes volume (up = louder)
        const steps = -Math.round(knobDrag.current.accumulated / 2);
        if (Math.abs(steps) >= 1) {
          knobDrag.current.accumulated = 0;
          setConfig(c => {
            if (c.simScreen === "fader" && c.simFaderEntry) {
              // Control the per-channel fader, not the zone master
              const entry   = c.simFaderEntry;
              const min     = entry.level_vol?.minParam ?? -100;
              const max     = entry.level_vol?.maxParam ?? 20;
              const step    = entry.level_vol?.stepSize ?? 2;
              const cur     = c.simChannelVols?.[entry.id] ?? min;
              const nv      = Math.max(min, Math.min(max, Math.round((cur + steps) / step) * step));
              const svCh    = entry.level_vol?.channel ?? 2;
              addLog("SV", `SV ${svCh} ${nv}  (${entry.display_txt})`);
              return { ...c, simChannelVols: { ...c.simChannelVols, [entry.id]: nv } };
            } else {
              // Zone master (volmute screen)
              const nv = Math.max(-100, Math.min(20, c.simVol + steps));
              addLog("SV", `SV 1 ${nv}`);
              return { ...c, simVol: nv };
            }
          });
        }
      }
    };
    const onMouseUp = () => { knobDrag.current.active = false; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  }, [simScreen, isBuilderAtRoot, totalItems, onSimStateChange, setConfig]);

  // -- LIGHTBAR FLASH (3 flashes, 0.5s apart) -------------------------------
  const flashLightbar = useCallback(() => {
    // Explicit timed sequence: off->on->off->on->off->on (3 flashes)
    const T = 250; // ms each half-cycle
    setConfig(c => ({ ...c, lbOn: false }));
    setTimeout(() => setConfig(c => ({ ...c, lbOn: true  })), T * 1);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: false })), T * 2);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: true  })), T * 3);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: false })), T * 4);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: true  })), T * 5);
  }, [setConfig]);

  const fireTrigger = useCallback((entry) => {
    addLog("TR", `TR ${entry.triggerNum}  (${entry.display_txt})`);
    flashLightbar();
  }, [flashLightbar]);

  const onKnobClick = useCallback(() => {
    if (simScreen === "fader") {
      setConfig(c => ({ ...c, simScreen: "menu", simFaderEntry: null }));
      return;
    }
    if (simScreen === "volmute") return;
    if (!menuEnabled) return; // menu not enabled, knob does nothing
    const entry = allEntries[cursorIdx];
    if (!entry) return;
    if (entry.entry_type === "menu" || entry.entry_type === "list" || entry.entry_type === "macro") {
      onBuilderNav({ type:"PUSH", step:{ id: entry.id, label: entry.display_txt } });
    } else if (entry.entry_type === "level") {
      setConfig(c => ({ ...c, simScreen: "fader", simFaderEntry: entry }));
    } else if (entry.entry_type === "action") {
      fireTrigger(entry);
    }
  }, [simScreen, menuEnabled, allEntries, cursorIdx, navPath, onBuilderNav, setConfig, fireTrigger]);

  // -- SIDE BUTTON (back) -----------------------------------------------------
  const onSideButton = useCallback(() => {
    if (simScreen === "fader") {
      setConfig(c => ({ ...c, simScreen: "menu", simFaderEntry: null }));
      return;
    }
    if (simScreen === "volmute") {
      // Can only go to menu if it's enabled
      if (menuEnabled) setConfig(c => ({ ...c, simScreen: "menu" }));
      return;
    }
    // Menu screen: go back one level, or at root toggle to volmute
    if (navPath.length > 0) {
      onBuilderNav({ type:"POP" });
    } else if (volMuteEnabled) {
      // At MAIN MENU root: toggle to Vol/Mute only if it's enabled
      setConfig(c => ({ ...c, simScreen: "volmute" }));
    }
    // If volmute not enabled, side button at root does nothing
  }, [simScreen, navPath, volMuteEnabled, menuEnabled, onBuilderNav, setConfig]);

  // -- DEPTH SQUARES ----------------------------------------------------------
  // Squares represent enabled screens in order: [volmute?][menu?][submenu slots...]
  // Only enabled screens get a square. Current screen/depth gets it filled.
  const DepthSquares = () => {
    // Build the list of "slots" -- what each square represents
    const slots = [];
    if (volMuteEnabled) slots.push("volmute");
    if (menuEnabled) {
      slots.push("menu0"); // MAIN MENU
      slots.push("menu1"); // depth 1 submenu
      slots.push("menu2"); // depth 2+ submenu
    }
    // Clamp to 3 squares max (what the real device shows)
    const visible = slots.slice(0, 3);

    // Which slot index is currently active?
    const activeSlot = (() => {
      if (simScreen === "volmute") return slots.indexOf("volmute");
      if (simScreen === "menu" || simScreen === "fader") {
        const depth = navPath.length; // 0=MAIN MENU, 1=one deep, 2+=deeper
        if (depth === 0) return slots.indexOf("menu0");
        if (depth === 1) return slots.indexOf("menu1");
        return slots.indexOf("menu2");
      }
      return -1;
    })();

    return (
      <div style={{ display:"flex", justifyContent:"space-evenly", width:"100%", padding:"0 14px", marginTop:2 }}>
        {visible.map((slot, i) => (
          <span key={i} style={{
            width:9, height:9, display:"inline-block",
            border:`1px solid ${C.lcd}`,
            background: i === activeSlot ? C.lcd : "transparent",
          }} />
        ))}
      </div>
    );
  };

  // -- LCD --------------------------------------------------------------------
  const lcd = (() => {
    // Which volume value to display depends on current screen
    const faderEntry  = config.simFaderEntry;
    const activeFaderVol = (simScreen === "fader" && faderEntry)
      ? (config.simChannelVols?.[faderEntry.id] ?? faderEntry.level_vol?.minParam ?? -100)
      : simVol;
    const faderMin = (simScreen === "fader" && faderEntry) ? (faderEntry.level_vol?.minParam ?? -100) : -100;
    const faderMax = (simScreen === "fader" && faderEntry) ? (faderEntry.level_vol?.maxParam ?? 20)   : 20;
    const pct = ((activeFaderVol - faderMin) / (faderMax - faderMin)) * 100;

    // VOL/MUTE SCREEN -- full-screen independent root screen
    if (simScreen === "volmute") {
      const title = volMuteScreen.display_txt || "Zone Name";
      return (
        <div style={{ display:"flex", flexDirection:"column", width:"100%", height:"100%", color:C.lcd, fontFamily:MONO, fontSize:10 }}>
          <div style={{ textAlign:"center", flexShrink:0, lineHeight:1.35 }}>
            <div style={{ overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>{title}</div>
            <DepthSquares />
          </div>
          <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
          <div style={{ flex:1, overflow:"hidden", minHeight:0, display:"flex", justifyContent:"center", alignItems:"stretch", padding:"3px 0" }}>
            <div style={{ width:18, border:`1px solid ${C.lcd}`, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
              <div style={{ height:"100%", background:C.lcd, transformOrigin:"bottom", transform:`scaleY(${pct/100})`, transition:"transform .08s" }} />
            </div>
          </div>
          <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
          <div style={{ color:C.lcd, textAlign:"center", fontSize:10, fontFamily:MONO, flexShrink:0, lineHeight:1.5 }}>
            {volStr(simVol)}
          </div>
        </div>
      );
    }

    // Shared header for both menu and fader-footer states
    const titleTxt = navPath.length === 0
      ? "MAIN MENU"
      : (currentMenu?.display_txt || navPath[navPath.length-1]?.label || "MENU");

    // MENU SCREEN -- header + 4 rows + footer
    // Footer is vol number normally; horizontal fader bar when a level is active ("fader" state)
    const showFaderFooter = simScreen === "fader";

    return (
      <div style={{ display:"flex", flexDirection:"column", width:"100%", height:"100%", color:C.lcd, fontFamily:MONO, fontSize:10 }}>
        {/* Header -- always the menu title, never changes */}
        <div style={{ textAlign:"center", flexShrink:0, lineHeight:1.35 }}>
          <div style={{ overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>{titleTxt}</div>
          <DepthSquares />
        </div>
        <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
        {/* 4 rows -- always shown regardless of footer state */}
        <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
          {Array.from({ length: 4 }).map((_, i) => {
            const e        = windowEntries[i];
            const absIdx   = clampedScroll + i;
            const isCursor = absIdx === cursorIdx && !!e;
            const isFirst  = i === 0;
            const isLast   = i === 3;
            const showUp   = isFirst && canScrollUp;
            const showDown = isLast  && canScrollDown;
            const isMenuType = e?.entry_type === "menu" || e?.entry_type === "list" || e?.entry_type === "macro";
            const isAction   = e?.entry_type === "action";
            return (
              <div key={i}
                onClick={() => {
                  if (showUp)        onSimStateChange(s => ({ ...s, scrollOffset: Math.max(0, (s.scrollOffset??0) - 1) }));
                  else if (showDown) onSimStateChange(s => ({ ...s, scrollOffset: Math.min(Math.max(0, totalItems-4), (s.scrollOffset??0) + 1) }));
                  else if (e)        onSimStateChange(s => ({ ...s, cursorIdx: absIdx }));
                }}
                style={{
                  flex:1, display:"flex", alignItems:"center", padding:"0 3px",
                  background: isCursor ? C.lcd : "transparent",
                  color:      isCursor ? "#000" : C.lcd,
                  borderBottom: i < 3 ? `1px solid ${C.lcd}` : "none",
                  cursor:"pointer", overflow:"hidden", minHeight:0,
                }}>
                {e ? (
                  <>
                    <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:9.5, lineHeight:1 }}>
                      {e.display_txt}
                    </span>
                    {showUp    && <span style={{ fontSize:8, flexShrink:0 }}>^</span>}
                    {showDown  && <span style={{ fontSize:8, flexShrink:0 }}>v</span>}
                    {!showUp && !showDown && isMenuType && <span style={{ fontSize:7, flexShrink:0 }}>{'>'}</span>}
                    {!showUp && !showDown && isAction   && <span style={{ fontSize:7, flexShrink:0 }}>!</span>}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
        <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
        {/* Footer: vol number normally, horizontal fader when a level is active */}
        {showFaderFooter ? (
          <div style={{ flexShrink:0, height:13, display:"flex", alignItems:"center", padding:"0 10px" }}>
            <div style={{ flex:1, height:9, border:`1px solid ${C.lcd}`, position:"relative", overflow:"hidden" }}>
              <div style={{ position:"absolute", inset:0, background:C.lcd, transformOrigin:"left", transform:`scaleX(${pct/100})`, transition:"transform .08s" }} />
            </div>
          </div>
        ) : (
          <div style={{ color:C.lcd, textAlign:"center", fontSize:10, fontFamily:MONO,
            flexShrink:0, height:13, display:"flex", alignItems:"center", justifyContent:"center" }}>
            {volStr(activeFaderVol)}
          </div>
        )}
      </div>
    );
  })();

  const lbColor = config.lbOn ? config.lbColor : null;

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
      <div style={{
        width:210, height:340,
        background:"linear-gradient(155deg,#2a2a2a 0%,#1e1e1e 60%,#181818 100%)",
        borderRadius:9,
        boxShadow:"0 2px 4px rgba(0,0,0,.5),0 16px 48px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,0.06)",
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <div style={{
          width:152, borderRadius:5,
          background:"linear-gradient(155deg,#282828 0%,#222 50%,#1e1e1e 100%)",
          border:"1px solid #333", boxShadow:"inset 0 1px 3px rgba(0,0,0,0.5)",
          display:"flex", flexDirection:"column", alignItems:"center", padding:"14px 0 12px",
        }}>
          <div style={{ background:"linear-gradient(150deg,#111 0%,#0a0a0a 100%)", borderRadius:3, boxShadow:"inset 0 1px 3px rgba(0,0,0,.6)" }}>
            <div style={{ width:122, height:122, background:C.lcdBg, padding:"5px 4px", display:"flex", flexDirection:"column", overflow:"hidden" }}>
              {lcd}
            </div>
          </div>
          <div style={{ position:"relative", width:"100%", display:"flex", justifyContent:"center", alignItems:"flex-end", marginTop:24 }}>
            <div
              onMouseDown={onKnobMouseDown}
              onClick={onKnobClick}
              style={{
                width:58, height:58, borderRadius:"50%",
                background:"radial-gradient(circle at 33% 28%,#3a3a3a 0%,#252525 55%,#1c1c1c 100%)",
                border:"1px solid #444",
                boxShadow:"0 3px 8px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,0.06)",
                position:"relative", cursor:"ns-resize", userSelect:"none",
              }}
              title="Drag to navigate / change volume. Click to enter."
            >
              <div style={{ position:"absolute", top:8, left:"50%", transform:"translateX(-50%)", width:3, height:3, borderRadius:"50%", background:"#666" }} />
            </div>
            <div
              onClick={onSideButton}
              title="Back"
              style={{
                position:"absolute", right:12, bottom:7, width:13, height:13, borderRadius:"50%",
                background:"radial-gradient(circle at 35% 30%,#333 0%,#222 100%)",
                border:"1px solid #444", cursor:"pointer",
              }}
            />
          </div>
          <div style={{
            width:82, height:8, borderRadius:99, marginTop:18, flexShrink:0,
            background: lbColor ? lbColor : "#1a1a1a",
            border: `1px solid ${lbColor ? lbColor : "#333"}`,
            boxShadow: lbColor ? `0 0 6px 1px ${lbColor}88,0 0 14px 2px ${lbColor}44` : "none",
            transition:"background .1s,box-shadow .1s",
          }} />
        </div>
      </div>
    </div>
  );
}

// --- MENU TREE ITEM -----------------------------------------------------------

function TreeItem({ entry, depth=0, selected, onSelect, onNavigate, index }) {
  const isMenu    = entry.entry_type === "menu";
  const isLevel   = entry.entry_type === "level";
  const isAction  = entry.entry_type === "action";
  const isSelected = selected?.id === entry.id;

  const icon = isMenu ? ">" : isLevel ? "||" : "!";
  const iconColor = isMenu ? C.orange : isLevel ? C.blue : C.green;

  return (
    <div
      onClick={() => onSelect(entry)}
      onDoubleClick={() => isMenu && onNavigate(entry)}
      style={{
        display:"flex", alignItems:"center", gap:0,
        height:34, width:"100%",
        background: isSelected ? C.orangeDim : "transparent",
        borderLeft: isSelected ? `3px solid ${C.orange}` : "3px solid transparent",
        cursor:"pointer", transition:"background .08s", userSelect:"none",
        paddingRight: 8,
      }}
      onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.background=C.s2; }}
      onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.background="transparent"; }}
    >
      <span style={{ fontSize:10, color:C.dim, minWidth:32, paddingLeft:10,
        fontFamily:MONO, flexShrink:0, textAlign:"right", paddingRight:6 }}>{index+1}</span>
      <span style={{ fontSize:9, color:iconColor, minWidth:18, flexShrink:0, textAlign:"center" }}>{icon}</span>
      <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        fontSize:12, color:isSelected?C.orange:C.text, fontWeight:isSelected?500:400,
        paddingLeft:6 }}>
        {entry.display_txt}
      </span>
      {isMenu   && <span style={{ fontSize:9,  color:isSelected?C.orange:C.dim, flexShrink:0 }}>{'>'}</span>}
      {isLevel  && <span style={{ fontSize:8,  color:C.blue,  flexShrink:0 }}>||</span>}
      {isAction && <span style={{ fontSize:9,  color:C.green, flexShrink:0 }}>!</span>}
    </div>
  );
}

// --- LEVEL CONFIG PANEL -------------------------------------------------------

function LevelConfigPanel({ entry, devices, onChange }) {
  const [tab, setTab]    = useState("Level");
  const [subtab, setSubtab] = useState("Config");

  const vol  = entry.level_vol;
  const mute = entry.level_mute;
  const isLevel = tab === "Level";
  const ctrl = isLevel ? vol : mute;
  const updCtrl = (field, val) => {
    const key = isLevel ? "level_vol" : "level_mute";
    onChange({ ...entry, [key]: { ...ctrl, [field]: val } });
  };

  const devOptions = devices.map(d => d.name);

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",overflow:"hidden" }}>
      <Tabs tabs={["Level","Mute"]} active={tab} onSelect={t=>{ setTab(t); setSubtab("Config"); }} />
      <Tabs tabs={["Config","Set","Query","Async"]} active={subtab} onSelect={setSubtab} />
      <div style={{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,paddingRight:4 }}>

        {subtab === "Config" && (
          <>
            <FieldRow label="Destination">
              <select value={ctrl.set_dev_name} onChange={e=>updCtrl("set_dev_name",e.target.value)} style={{ maxWidth:180 }}>
                {devOptions.map(n=><option key={n}>{n}</option>)}
              </select>
            </FieldRow>
            {(() => {
              const dev = devices.find(d=>d.name===ctrl.set_dev_name);
              if (!dev) return null;
              return (<>
                <FieldRow label="Device"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.name}</span></FieldRow>
                <FieldRow label="IP"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.ip}</span></FieldRow>
                <FieldRow label="Port"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.port}</span></FieldRow>
                <FieldRow label="Type"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>UDP</span></FieldRow>
              </>);
            })()}
            <HR />
            {isLevel && (<>
              <FieldRow label="Type">
                <select value={ctrl.setter_type===1?"Explicit":"Stateless"} onChange={e=>updCtrl("setter_type",e.target.value==="Explicit"?1:0)} style={{ maxWidth:140 }}>
                  <option>Explicit</option>
                  <option>Stateless</option>
                </select>
              </FieldRow>
              <FieldRow label="Min" hint="dB">
                <input type="number" value={ctrl.minParam} onChange={e=>updCtrl("minParam",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              </FieldRow>
              <FieldRow label="Max" hint="dB">
                <input type="number" value={ctrl.maxParam} onChange={e=>updCtrl("maxParam",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              </FieldRow>
              <FieldRow label="Step" hint="dB">
                <input type="number" value={ctrl.stepSize} onChange={e=>updCtrl("stepSize",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              </FieldRow>
              <FieldRow label="Precision">
                <select value={ctrl.paramDecPts} onChange={e=>updCtrl("paramDecPts",Number(e.target.value))} style={{ maxWidth:90 }}>
                  {[0,1,2].map(n=><option key={n}>{n}</option>)}
                </select>
              </FieldRow>
              <FieldRow label="Trim">
                <Toggle value={ctrl.trimEnable} onChange={v=>updCtrl("trimEnable",v)} />
              </FieldRow>
            </>)}
            {!isLevel && (
              <FieldRow label="Type">
                <select value={ctrl.setter_type===1?"Explicit":"Stateless"} onChange={e=>updCtrl("setter_type",e.target.value==="Explicit"?1:0)} style={{ maxWidth:140 }}>
                  <option>Stateless</option>
                  <option>Explicit</option>
                </select>
              </FieldRow>
            )}
          </>
        )}

        {subtab === "Set" && (
          <>
            <FieldRow label="Command">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.setBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="">
              <span style={{ fontSize:11,color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
            </FieldRow>
            {isLevel && (
              <>
                <FieldRow label="ACK required">
                  <Toggle value={ctrl.ackEnable} onChange={v=>updCtrl("ackEnable",v)} />
                </FieldRow>
              </>
            )}
          </>
        )}

        {subtab === "Query" && (
          <>
            <FieldRow label="Enable polling">
              <Toggle value={ctrl.queryEnable} onChange={v=>updCtrl("queryEnable",v)} />
            </FieldRow>
            <FieldRow label="Interval" hint="ms">
              <input type="number" value={ctrl.pollMs} onChange={e=>updCtrl("pollMs",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              <span style={{ fontSize:11,color:C.mid }}>ms</span>
            </FieldRow>
            <FieldRow label="Query">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.queryBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="Response">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.respQueryBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="">
              <span style={{ fontSize:11,color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
            </FieldRow>
          </>
        )}

        {subtab === "Async" && (
          <>
            <FieldRow label="Monitor async">
              <Toggle value={ctrl.asyncEnable} onChange={v=>updCtrl("asyncEnable",v)} />
            </FieldRow>
            {(() => {
              const dev = devices.find(d=>d.name===ctrl.set_dev_name);
              return dev ? (<>
                <FieldRow label="IP"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.asyncIp}</span></FieldRow>
                <FieldRow label="Port"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.asyncPort}</span></FieldRow>
                <FieldRow label="Type"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>UDP</span></FieldRow>
              </>) : null;
            })()}
            <FieldRow label="Async response">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.syncBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="">
              <span style={{ fontSize:11,color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
            </FieldRow>
          </>
        )}
      </div>
    </div>
  );
}

// --- TRIGGER CONFIG PANEL -----------------------------------------------------

function TriggerConfigPanel({ entry, devices, onChange }) {
  const devOptions = devices.map(d=>d.name);
  const upd = (k,v) => onChange({ ...entry, [k]:v });
  return (
    <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
      <div style={{ fontSize:10,color:C.dim,marginBottom:4 }}>Action Configuration</div>
      <FieldRow label="Control mode"><Tag color="orange">3rd Party</Tag></FieldRow>
      <FieldRow label="Destination">
        <select value={entry.dev} onChange={e=>upd("dev",e.target.value)} style={{ maxWidth:180 }}>
          {devOptions.map(n=><option key={n}>{n}</option>)}
        </select>
      </FieldRow>
      {(() => {
        const dev = devices.find(d=>d.name===entry.dev);
        return dev ? (<>
          <FieldRow label="Device"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.name}</span></FieldRow>
          <FieldRow label="IP"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.ip}</span></FieldRow>
          <FieldRow label="Port"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.port}</span></FieldRow>
          <FieldRow label="Type"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>UDP</span></FieldRow>
        </>) : null;
      })()}
      <HR />
      <FieldRow label="Payload">
        <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
          {bytesToStr(entry.bytes)}
        </div>
      </FieldRow>
      <FieldRow label="">
        <div style={{ display:"flex",gap:10 }}>
          <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:12,color:C.mid }}>
            <input type="checkbox" checked={entry.cr||false} onChange={e=>upd("cr",e.target.checked)} />CR
          </label>
          <label style={{ display:"flex",alignItems:"center",gap:5,fontSize:12,color:C.mid }}>
            <input type="checkbox" checked={entry.lf||false} onChange={e=>upd("lf",e.target.checked)} />LF
          </label>
        </div>
      </FieldRow>
    </div>
  );
}

// --- MENU BUILDER -------------------------------------------------------------

function MenuBuilder({ config, setConfig, onSimCursorChange, simState, navState, navigate: navigate_ }) {
  const view    = navState?.view ?? "root";
  const navPath = navState?.path ?? [];

  const [selected, setSelected]       = useState(null);
  const [editingName, setEditingName] = useState(null);
  const [nameVal, setNameVal]         = useState("");

  const devices    = config.devices;
  const defaultDev = devices[0]?.name || "QSC";

  // Resolve current node from navPath within mainMenu
  const resolveNode = useCallback((path, root) => {
    let node = root;
    for (const step of path) {
      const found = node.entries?.find(e => e.id === step.id);
      if (!found) return node;
      node = found;
    }
    return node;
  }, []);

  const currentNode = useMemo(() =>
    resolveNode(navPath, config.mainMenu),
    [navPath, config.mainMenu, resolveNode]);

  // Deep update a node in the tree
  const updateNode = useCallback((root, targetId, updater) => {
    if (root.id === targetId) return updater(root);
    if (!root.entries) return root;
    return { ...root, entries: root.entries.map(e => updateNode(e, targetId, updater)) };
  }, []);

  const updateEntry = useCallback((entry) => {
    if (entry.id === config.volMuteScreen.id) {
      setConfig(c=>({ ...c, volMuteScreen: entry }));
    } else {
      setConfig(c=>({ ...c, mainMenu: updateNode(c.mainMenu, entry.id, ()=>entry) }));
    }
    setSelected(entry);
  }, [config.volMuteScreen.id, setConfig, updateNode]);

  const deleteEntry = useCallback((id) => {
    const parentId = navPath.length ? navPath[navPath.length-1].id : null;
    const removeFrom = (node) => {
      if (!node.entries) return node;
      return { ...node, entries: node.entries.filter(e=>e.id!==id).map(removeFrom) };
    };
    setConfig(c=>({ ...c, mainMenu: removeFrom(c.mainMenu) }));
    if (selected?.id === id) setSelected(null);
  }, [navPath, selected, setConfig]);

  // Next SV channel: count all level entries across tree
  const nextSVChannel = useCallback(() => {
    let count = 1; // vol/mute screen is ch 1
    const walk = (node) => {
      if (node.entry_type==="level") count++;
      (node.entries||[]).forEach(walk);
    };
    walk(config.mainMenu);
    return count;
  }, [config.mainMenu]);

  // Next trigger number
  const nextTrigNum = useCallback(() => {
    let max = 0;
    const walk = (node) => {
      if (node.entry_type==="action" && node.triggerNum) max = Math.max(max, node.triggerNum);
      (node.entries||[]).forEach(walk);
    };
    walk(config.mainMenu);
    return max+1;
  }, [config.mainMenu]);

  const addItem = (type) => {
    const nodeType = currentNode.entry_type || "menu";
    const limit = { menu:8, list:16, macro:16 }[nodeType] || 8;
    if ((currentNode.entries?.length || 0) >= limit) return;

    let newEntry;
    if (type === "menu")    newEntry = { ...mkMenuEntry("New Menu"), entry_type:"menu" };
    if (type === "list")    newEntry = { ...mkMenuEntry("New List"),  entry_type:"list" };
    if (type === "macro")   newEntry = { ...mkMenuEntry("New Macro"), entry_type:"macro" };
    if (type === "level")   { const ch=nextSVChannel(); newEntry = mkLevelEntry(`Channel ${ch}`, ch, defaultDev); }
    if (type === "trigger") { const n=nextTrigNum(); newEntry = mkTriggerEntry(`Trigger ${n}`, n, defaultDev); }
    if (!newEntry) return;

    const targetId = currentNode.id;
    setConfig(c=>({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node=>({ ...node, entries:[...(node.entries||[]),newEntry] }))
    }));
    setSelected(newEntry);
    // Sync sim to the new item (it'll be at end of current entries)
    const newIdx = (currentNode.entries?.length || 0);
    onSimCursorChange?.(newIdx);
  };

  const autoFill = (type, count) => {
    const nodeType = currentNode.entry_type || "menu";
    const limit    = { menu:8, list:16, macro:16 }[nodeType] || 8;
    const current  = currentNode.entries?.length || 0;
    const canAdd   = Math.min(count, limit - current);
    if (canAdd <= 0) return;

    const targetId = currentNode.id;
    const startCh  = nextSVChannel();
    const startTr  = nextTrigNum();
    const newEntries = [];
    for (let i = 0; i < canAdd; i++) {
      if (type === "level")   newEntries.push(mkLevelEntry(`G${startCh+i}`, startCh+i, defaultDev));
      if (type === "trigger") newEntries.push(mkTriggerEntry(`Entry - ${startTr+i}`, startTr+i, defaultDev));
    }
    setConfig(c=>({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node=>({ ...node, entries:[...(node.entries||[]),...newEntries] }))
    }));
  };

  const navigate = (entry) => {
    if (view === "root") {
      navigate_({ type:"MENU" });
    } else if (entry) {
      navigate_({ type:"PUSH", step:{ id:entry.id, label:entry.display_txt } });
    }
    setSelected(null);
  };

  const navBack = () => {
    navigate_({ type:"POP" });
    setSelected(null);
  };

  const navTo = (depthIdx) => {
    if (depthIdx < 0) navigate_({ type:"ROOT" });
    else navigate_({ type:"GOTO", path: navPath.slice(0, depthIdx) });
    setSelected(null);
  };

  // What the tree list shows
  const showRoot     = view === "root";
  const entries      = currentNode.entries || [];
  // Depth squares: 0 = root, 1 = mainMenu, 2+ = submenus
  const currentDepth = view === "root" ? 0 : navPath.length + 1;
  const depthColors  = [C.orange, C.blue, C.green, C.warn];

  // The "active" item in the tree is whichever was explicitly selected,
  // OR the one the sim cursor is pointing at (so knob navigation highlights in builder too)
  const simCursorEntry = (!showRoot && entries.length > 0)
    ? entries[simState?.cursorIdx ?? 0] ?? null
    : null;
  const effectiveSelected = selected ?? simCursorEntry;

  // Inline rename
  const startEdit = (e, entry) => { e.stopPropagation(); setEditingName(entry.id); setNameVal(entry.display_txt); };
  const commitEdit = (entry) => {
    updateEntry({ ...entry, display_txt: nameVal });
    setEditingName(null);
  };

  // Move up/down within current level
  const move = (id, dir) => {
    const targetId = currentNode.id;
    setConfig(c => ({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node => {
        const arr = [...node.entries];
        const idx = arr.findIndex(e => e.id === id);
        if (idx < 0) return node;
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= arr.length) return node;
        [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
        return { ...node, entries: arr };
      })
    }));
  };

  return (
    <div style={{ display:"flex",height:"100%",gap:0 }}>
      {/* Tree pane */}
      <div style={{ width:320,flexShrink:0,display:"flex",flexDirection:"column",borderRight:`1px solid ${C.border}`,height:"100%",overflow:"hidden" }}>
        {/* Single unified toolbar: back + title + depth squares + edit */}
        <div style={{ display:"flex", alignItems:"center", height:36, borderBottom:`1px solid ${C.border}`,
          flexShrink:0, gap:0 }}>
          <button onClick={navBack} disabled={showRoot} style={{
            padding:"0 12px", height:"100%", background:C.s2, border:"none",
            borderRight:`1px solid ${C.border}`,
            color:!showRoot?C.text:C.dim, cursor:!showRoot?"pointer":"not-allowed",
            fontFamily:SANS, fontSize:12, fontWeight:500, flexShrink:0,
          }}>‹</button>
          <div style={{ flex:1, padding:"0 12px", background:C.s1, display:"flex",
            alignItems:"center", gap:8, height:"100%", overflow:"hidden" }}>
            <span style={{ fontSize:12, fontWeight:600, color:C.text, overflow:"hidden",
              textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
              {showRoot ? "Root" : navPath.length === 0 ? "Main menu" : navPath[navPath.length-1].label}
            </span>
            {/* Depth squares inline */}
            <div style={{ display:"flex", gap:5, flexShrink:0 }}>
              {[1,2,3,4].map(i => {
                const isLit = !showRoot && i === currentDepth;
                return (
                  <div key={i}
                    title={i===1?"Main menu":`Depth ${i}`}
                    onClick={() => {
                      if (i===1){ navigate_({type:"MENU"}); setSelected(null); }
                      else navTo(i-2);
                    }}
                    style={{
                      width:8, height:8, borderRadius:2, cursor:"pointer",
                      background: isLit ? depthColors[i-1] : C.s3,
                      border:`1px solid ${isLit ? depthColors[i-1] : C.borderHi}`,
                      transition:"background .12s",
                    }}
                  />
                );
              })}
            </div>
          </div>
          <button onClick={()=>selected&&startEdit({stopPropagation:()=>{}},selected)} style={{
            padding:"0 12px", height:"100%", background:C.s2, border:"none",
            borderLeft:`1px solid ${C.border}`,
            color:C.mid, cursor:"pointer", fontFamily:SANS, fontSize:11, flexShrink:0,
          }}>Edit</button>
        </div>

        {/* Entry list */}
        <div style={{ flex:1,overflowY:"auto" }}>
          {showRoot && (() => {
            const vmSel = effectiveSelected?.id === config.volMuteScreen.id;
            return (
              <div style={{
                display:"flex", alignItems:"center", height:34, width:"100%",
                background: vmSel ? C.orangeDim : "transparent",
                borderLeft: vmSel ? `3px solid ${C.orange}` : "3px solid transparent",
                cursor:"pointer", transition:"background .08s",
                borderBottom:`1px solid ${C.border}18`,
              }}
                onClick={()=>config.volMuteEnabled && setSelected(config.volMuteScreen)}
                onMouseEnter={e=>{ if(!vmSel) e.currentTarget.style.background=C.s2; }}
                onMouseLeave={e=>{ if(!vmSel) e.currentTarget.style.background="transparent"; }}
              >
                <span style={{ minWidth:32, paddingLeft:10, paddingRight:6 }}>
                  <input type="checkbox" checked={config.volMuteEnabled}
                    onClick={e=>e.stopPropagation()}
                    onChange={e=>{ e.stopPropagation(); const enabled = e.target.checked;
                      setConfig(c=>({
                        ...c,
                        volMuteEnabled: enabled,
                        // If we're on volmute and disabling it, jump to menu (or stay on menu if also disabled)
                        simScreen: !enabled && c.simScreen === "volmute"
                          ? (c.menuEnabled ? "menu" : "menu")
                          : c.simScreen,
                      }));
                    }}
                    style={{ width:13,height:13,cursor:"pointer" }} />
                </span>
                <span style={{ fontSize:9, color:C.blue, minWidth:18, textAlign:"center" }}>||</span>
                <span style={{ flex:1, fontSize:12, color:vmSel?C.orange: config.volMuteEnabled ? C.text : C.dim,
                  fontWeight:vmSel?500:400, paddingLeft:6, overflow:"hidden",
                  whiteSpace:"nowrap", textOverflow:"ellipsis" }}>Volume/Mute Screen</span>
                <span style={{ fontSize:9, color:C.blue, paddingRight:8 }}>||</span>
              </div>
            );
          })()}
          {showRoot && (
            <div style={{
              display:"flex", alignItems:"center", height:34, width:"100%",
              background:"transparent", cursor:"pointer", transition:"background .08s",
              borderBottom:`1px solid ${C.border}22`,
            }}
              onClick={e=>{ if(config.menuEnabled) navigate(null); }}
              onMouseEnter={e=>{ e.currentTarget.style.background=C.s2; }}
              onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; }}
            >
              <span style={{ minWidth:32, paddingLeft:10, paddingRight:6 }}>
                <input type="checkbox" checked={config.menuEnabled}
                  onClick={e=>e.stopPropagation()}
                  onChange={e=>{ e.stopPropagation(); const enabled = e.target.checked;
                    setConfig(c=>({
                      ...c,
                      menuEnabled: enabled,
                      // If disabling menu while on menu/fader, jump to volmute (or stay if not available)
                      simScreen: !enabled && (c.simScreen === "menu" || c.simScreen === "fader")
                        ? (c.volMuteEnabled ? "volmute" : "menu")
                        : c.simScreen,
                      simFaderEntry: !enabled ? null : c.simFaderEntry,
                    }));
                    // If disabling menu, navigate builder back to root
                    if (!enabled) navigate_({ type:"ROOT" });
                  }}
                  style={{ width:13,height:13,cursor:"pointer" }} />
              </span>
              <span style={{ fontSize:9, color:C.orange, minWidth:18, textAlign:"center" }}>{'>'}</span>
              <span style={{ flex:1, fontSize:12, color:config.menuEnabled ? C.text : C.dim, paddingLeft:6,
                overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>Menu Screen(s)</span>
              <span style={{ fontSize:9, color:config.menuEnabled ? C.dim : C.border, paddingRight:8 }}>{'>'}</span>
            </div>
          )}
          {!showRoot && entries.map((entry,i)=>(
            <div key={entry.id} style={{ borderBottom:`1px solid ${C.border}11` }}>
              {editingName===entry.id ? (
                <div style={{ padding:"4px 8px",display:"flex",gap:6 }}>
                  <input autoFocus value={nameVal} onChange={e=>setNameVal(e.target.value)}
                    onBlur={()=>commitEdit(entry)} onKeyDown={e=>{ if(e.key==="Enter")commitEdit(entry); if(e.key==="Escape")setEditingName(null); }}
                    style={{ flex:1,height:24 }} />
                </div>
              ) : (
                <div style={{ display:"flex",alignItems:"center",position:"relative" }}
                  onDoubleClick={e=>startEdit(e,entry)}>
                  <TreeItem entry={entry} index={i} selected={effectiveSelected}
                    onSelect={(e) => { setSelected(e); onSimCursorChange?.(i); }}
                    onNavigate={navigate} />
                  {effectiveSelected?.id===entry.id && (
                    <div style={{ position:"absolute",right:28,display:"flex",gap:2 }}>
                      <button onClick={()=>move(entry.id,-1)} style={{ background:C.s3,border:"none",color:C.mid,width:18,height:18,borderRadius:2,fontSize:10,cursor:"pointer" }}>^</button>
                      <button onClick={()=>move(entry.id,1)}  style={{ background:C.s3,border:"none",color:C.mid,width:18,height:18,borderRadius:2,fontSize:10,cursor:"pointer" }}>v</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {!showRoot && entries.length===0 && (
            <div style={{ padding:"20px 12px",fontSize:12,color:C.dim,textAlign:"center" }}>
              Empty menu. Add items below.
            </div>
          )}
        </div>

        {/* Add buttons */}
        {(() => {
          // What type is the current container?
          const nodeType = view === "root" ? "root"
            : (currentNode.entry_type || "menu");

          // Per-node limits
          const LIMITS = { menu: 8, list: 16, macro: 16 };
          const limit  = LIMITS[nodeType] || 8;
          const count  = entries.length;
          const atLimit = !showRoot && count >= limit;

          // What can be added here?
          // Menus: can add Menu (if depth < 4), Level, Trigger
          // Lists/Macros: Trigger only
          // Root: nothing (buttons disabled)
          const canAddMenu    = !showRoot && nodeType === "menu" && currentDepth < 4;
          const canAddLevel   = !showRoot && nodeType === "menu";
          const canAddTrigger = !showRoot && (nodeType === "menu" || nodeType === "list" || nodeType === "macro");
          const canAddList    = !showRoot && nodeType === "menu" && currentDepth < 4;
          const canAddMacro   = !showRoot && nodeType === "menu" && currentDepth < 4;

          const limitTag = atLimit ? (
            <span style={{ fontSize:10, color:C.warn, fontFamily:MONO }}>
              {count}/{limit} max
            </span>
          ) : count > 0 ? (
            <span style={{ fontSize:10, color:C.dim, fontFamily:MONO }}>
              {count}/{limit}
            </span>
          ) : null;

          return (
            <div style={{ borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
              {/* Containers row */}
              <div style={{ padding:"8px 12px 6px", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ fontSize:10, color:C.dim, letterSpacing:"0.08em",
                  textTransform:"uppercase", marginBottom:6 }}>Containers</div>
                <div style={{ display:"flex", gap:4 }}>
                  <Btn small onClick={()=>addItem("menu")}
                    disabled={!canAddMenu || atLimit} style={{ flex:1 }}>
                    Menu
                  </Btn>
                  <Btn small onClick={()=>addItem("list")}
                    disabled={!canAddList || atLimit} style={{ flex:1 }}>
                    List
                  </Btn>
                  <Btn small onClick={()=>addItem("macro")}
                    disabled={!canAddMacro || atLimit} style={{ flex:1 }}>
                    Macro
                  </Btn>
                </div>
              </div>
              {/* Actions row */}
              <div style={{ padding:"8px 12px 6px", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ display:"flex", alignItems:"center", marginBottom:6 }}>
                  <span style={{ fontSize:10, color:C.dim, letterSpacing:"0.08em",
                    textTransform:"uppercase", flex:1 }}>Actions</span>
                  {limitTag}
                </div>
                <div style={{ display:"flex", gap:4 }}>
                  <Btn small onClick={()=>addItem("trigger")}
                    disabled={!canAddTrigger || atLimit}
                    variant={selected?.entry_type==="action"?"primary":"default"}
                    style={{ flex:1 }}>
                    Trigger
                  </Btn>
                  <Btn small onClick={()=>addItem("level")}
                    disabled={!canAddLevel || atLimit}
                    variant={selected?.entry_type==="level"?"primary":"default"}
                    style={{ flex:1 }}>
                    Level
                  </Btn>
                </div>
              </div>
              {/* Auto-fill + remove */}
              {!showRoot && (nodeType === "menu" || nodeType === "list" || nodeType === "macro") && (
                <div style={{ padding:"6px 12px 8px", display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
                  <span style={{ fontSize:10, color:C.dim, marginRight:2, flexShrink:0 }}>Fill:</span>
                  {nodeType === "menu" && (
                    <>
                      <Btn small variant="ghost"
                        disabled={atLimit}
                        onClick={()=>autoFill("level", Math.min(8, limit-count))}>
                        +8 Lvl
                      </Btn>
                      <Btn small variant="ghost"
                        disabled={atLimit}
                        onClick={()=>autoFill("trigger", Math.min(8, limit-count))}>
                        +8 Tr
                      </Btn>
                    </>
                  )}
                  {(nodeType === "list" || nodeType === "macro") && (
                    <Btn small variant="ghost"
                      disabled={atLimit}
                      onClick={()=>autoFill("trigger", Math.min(16, limit-count))}>
                      +{Math.min(16, limit-count)} Triggers
                    </Btn>
                  )}
                  {selected && (
                    <Btn small variant="danger"
                      style={{ marginLeft:"auto" }}
                      onClick={()=>deleteEntry(selected.id)}>
                      Remove
                    </Btn>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Config panel */}
      <div style={{ flex:1,padding:"14px 16px",overflowY:"auto",height:"100%" }}>
        {!selected && (
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:C.dim,fontSize:12 }}>
            Select an item to configure it.
          </div>
        )}
        {selected?.entry_type==="level" && (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
              <span style={{ fontSize:14,fontWeight:600,color:C.text }}>{selected.display_txt}</span>
              <Tag color="blue">Level</Tag>
              <div style={{ marginLeft:"auto" }}>
                <input value={selected.display_txt}
                  onChange={e=>updateEntry({...selected,display_txt:e.target.value})}
                  style={{ width:180,fontSize:13,fontWeight:500 }} />
              </div>
            </div>
            <LevelConfigPanel entry={selected} devices={devices} onChange={updateEntry} />
          </>
        )}
        {selected?.entry_type==="action" && (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
              <span style={{ fontSize:14,fontWeight:600,color:C.text }}>{selected.display_txt}</span>
              <Tag color="green">Trigger</Tag>
              <div style={{ marginLeft:"auto" }}>
                <input value={selected.display_txt}
                  onChange={e=>updateEntry({...selected,display_txt:e.target.value})}
                  style={{ width:180,fontSize:13,fontWeight:500 }} />
              </div>
            </div>
            <TriggerConfigPanel entry={selected} devices={devices} onChange={updateEntry} />
          </>
        )}
        {selected?.entry_type==="menu" && (
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:4 }}>
              <span style={{ fontSize:14,fontWeight:600 }}>{selected.display_txt}</span>
              <Tag color="orange">Menu container</Tag>
            </div>
            <FieldRow label="Name">
              <input value={selected.display_txt} onChange={e=>updateEntry({...selected,display_txt:e.target.value})} style={{ maxWidth:220 }} />
            </FieldRow>
            <FieldRow label="Children"><Tag color="dim">{selected.entries?.length||0} items</Tag></FieldRow>
            <div style={{ marginTop:8 }}>
              <Btn onClick={()=>navigate(selected)}>Open in builder</Btn>
            </div>
          </div>
        )}
        {/* Vol/Mute Screen selected */}
        {selected?.id===config.volMuteScreen.id && (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
              <span style={{ fontSize:14,fontWeight:600 }}>Vol/Mute Screen</span>
              <Tag color="blue">Root level</Tag>
              <div style={{ marginLeft:"auto" }}>
                <input value={selected.display_txt}
                  onChange={e=>updateEntry({...selected,display_txt:e.target.value})}
                  style={{ width:180,fontSize:13,fontWeight:500 }} />
              </div>
            </div>
            <LevelConfigPanel entry={selected} devices={devices} onChange={updateEntry} />
          </>
        )}
      </div>
    </div>
  );
}

// --- DEVICE LIST PANEL --------------------------------------------------------

function DeviceListPanel({ devices, setDevices }) {
  const [sel, setSel] = useState(null);
  const upd = (id, k, v) => setDevices(ds=>ds.map(d=>d.id===id?{...d,[k]:v}:d));

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",overflow:"hidden" }}>
      <div style={{ padding:"10px 12px",borderBottom:`1px solid ${C.border}`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
        <span style={{ fontSize:11,fontWeight:600,color:C.mid,letterSpacing:"0.06em",textTransform:"uppercase" }}>3rd Party Devices</span>
        <Btn small onClick={()=>{ const d=mkDevice("New Device","10.0.0.1"); setDevices(ds=>[...ds,d]); setSel(d.id); }}>+</Btn>
      </div>
      <div style={{ flex:1,overflowY:"auto" }}>
        {devices.map(d=>(
          <div key={d.id}
            onClick={()=>setSel(sel===d.id?null:d.id)}
            style={{
              padding:"8px 12px",cursor:"pointer",borderBottom:`1px solid ${C.border}22`,
              background:sel===d.id?C.s2:"transparent",
            }}>
            <div style={{ display:"flex",alignItems:"center",gap:6 }}>
              <div style={{ width:6,height:6,borderRadius:"50%",background:C.green,flexShrink:0 }} />
              <span style={{ fontSize:12,fontWeight:500,color:sel===d.id?C.text:C.mid }}>{d.name}</span>
            </div>
            <div style={{ fontFamily:MONO,fontSize:10,color:C.dim,marginTop:2 }}>{d.ip}:{d.port}</div>
          </div>
        ))}
      </div>
      {sel && (() => {
        const d = devices.find(x=>x.id===sel);
        if (!d) return null;
        return (
          <div style={{ borderTop:`1px solid ${C.border}`,padding:"12px",flexShrink:0 }}>
            <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
              <FieldRow label="Name"><input value={d.name} onChange={e=>upd(d.id,"name",e.target.value)} /></FieldRow>
              <FieldRow label="IP"><input value={d.ip} onChange={e=>upd(d.id,"ip",e.target.value)} style={{ fontFamily:MONO }} /></FieldRow>
              <FieldRow label="Port"><input type="number" value={d.port} onChange={e=>upd(d.id,"port",Number(e.target.value))} style={{ fontFamily:MONO }} /></FieldRow>
              <FieldRow label="Async IP"><input value={d.asyncIp} onChange={e=>upd(d.id,"asyncIp",e.target.value)} style={{ fontFamily:MONO }} /></FieldRow>
              <FieldRow label="Async Port"><input type="number" value={d.asyncPort} onChange={e=>upd(d.id,"asyncPort",Number(e.target.value))} style={{ fontFamily:MONO }} /></FieldRow>
              <FieldRow label="Proto">
                <select value={d.proto} onChange={e=>upd(d.id,"proto",e.target.value)} style={{ maxWidth:90 }}>
                  <option>UDP</option><option>TCP</option>
                </select>
              </FieldRow>
              <div style={{ display:"flex",justifyContent:"flex-end" }}>
                <Btn small variant="danger" onClick={()=>{ setDevices(ds=>ds.filter(x=>x.id!==sel)); setSel(null); }}>Remove</Btn>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// --- SETTINGS PANEL -----------------------------------------------------------

function SettingsPanel({ config, setConfig }) {
  const upd = (k,v) => {
    setConfig(c=>({...c,[k]:v}));
    // Fire real UDP commands for immediate hardware feedback
    const ip = config.ip;
    if (!ip || ip === "192.168.1.200") return;
    const cmd = (c) => fetch(`/api/device/${ip}/cmd`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cmd:c})}).catch(()=>{});
    if (k === "lbColor") {
      // Convert #rrggbb to R:G:B
      const r = parseInt(v.slice(1,3),16), g = parseInt(v.slice(3,5),16), b = parseInt(v.slice(5,7),16);
      cmd(`SLC ${r}:${g}:${b}`);
    }
    if (k === "lbOn" && !v) cmd("SLC OFF");
    if (k === "displayBrightness") cmd(`SDB ${v}`);
    if (k === "displayTimeout")    cmd(`SDT ${v}`);
    if (k === "displayRotation")   cmd(`SDR ${v}`);
    if (k === "lbBrightness")      cmd(`SLBB ${v}`);
    if (k === "lbTimeout")         cmd(`SLBT ${v}`);
    if (k === "pinEnabled")        cmd(`SLPM ${v ? 1 : 0}`);
    if (k === "pin")               cmd(`SLP ${v}`);
  };
  return (
    <div style={{ padding:"20px 24px",overflowY:"auto",height:"100%",display:"flex",flexDirection:"column",gap:0,maxWidth:680 }}>
      <SectionHead>Device</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="Device name" hint="SDN"><input value={config.deviceName} onChange={e=>upd("deviceName",e.target.value)} style={{ maxWidth:220 }} /></FieldRow>
        <FieldRow label="IP address"><input value={config.ip} onChange={e=>upd("ip",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} /></FieldRow>
        <FieldRow label="Mode">
          <select value={config.mode} onChange={e=>upd("mode",e.target.value)} style={{ maxWidth:220 }}>
            <option value="THIRD_PARTY">Third Party</option>
            <option value="Q-SYS">Q-SYS</option>
          </select>
        </FieldRow>
        <FieldRow label="Firmware"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{config.firmwareVersion}</span></FieldRow>
        <FieldRow label="MAC"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{config.mac}</span></FieldRow>
      </div>
      <HR />
      <SectionHead>Display</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="Brightness" hint="SDB  1-10">
          <input type="range" min={1} max={10} value={config.displayBrightness} onChange={e=>upd("displayBrightness",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:24 }}>{config.displayBrightness}</span>
        </FieldRow>
        <FieldRow label="Timeout" hint="SDT  10-600 s">
          <input type="range" min={10} max={600} step={10} value={config.displayTimeout} onChange={e=>upd("displayTimeout",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:36 }}>{config.displayTimeout}s</span>
        </FieldRow>
        <FieldRow label="Rotation" hint="SDR">
          <Btn small active={config.displayRotation===0} onClick={()=>upd("displayRotation",0)}>Normal</Btn>
          <Btn small active={config.displayRotation===1} onClick={()=>upd("displayRotation",1)}>90deg</Btn>
        </FieldRow>
        <FieldRow label="Lock" hint="SDL -- stub on FW 1.5">
          <Toggle value={config.displayLock===1} onChange={v=>upd("displayLock",v?1:0)} />
          {config.displayLock===1&&<Tag color="warn">NO EFFECT on FW 1.5</Tag>}
        </FieldRow>
      </div>
      <HR />
      <SectionHead>Lightbar</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="State">
          <Toggle value={config.lbOn} onChange={v=>upd("lbOn",v)} />
          <span style={{ fontSize:12,color:C.mid }}>{config.lbOn?"On":"Off"}</span>
        </FieldRow>
        <FieldRow label="Color" hint="SLC -- keepalive req. every ~5 s">
          <input type="color" value={config.lbColor} onChange={e=>upd("lbColor",e.target.value)} style={{ width:40,height:28,padding:2 }} />
          <span style={{ fontFamily:MONO,fontSize:11,color:config.lbColor }}>{config.lbColor}</span>
          {["#ff2020","#3ddc6e","#4a90ff","#ffcc00","#ff8800","#ffffff"].map(col=>(
            <div key={col} onClick={()=>upd("lbColor",col)} style={{ width:16,height:16,borderRadius:2,background:col,cursor:"pointer",
              outline:config.lbColor===col?`2px solid ${C.text}`:"2px solid transparent",outlineOffset:1 }} />
          ))}
        </FieldRow>
        <FieldRow label="Brightness" hint="SLBB  0-10">
          <input type="range" min={0} max={10} value={config.lbBrightness} onChange={e=>upd("lbBrightness",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:24 }}>{config.lbBrightness}</span>
        </FieldRow>
        <FieldRow label="Timeout" hint="SLBT  10-600 s">
          <input type="range" min={10} max={600} step={10} value={config.lbTimeout} onChange={e=>upd("lbTimeout",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:36 }}>{config.lbTimeout}s</span>
        </FieldRow>
        <FieldRow label="Mode" hint="SLCM">
          <Btn small active={config.lbColorMode===0} onClick={()=>upd("lbColorMode",0)}>0 -- Static</Btn>
          <Btn small active={config.lbColorMode===1} onClick={()=>upd("lbColorMode",1)}>1 -- Unknown</Btn>
        </FieldRow>
      </div>
      <HR />
      <SectionHead>Security</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="PIN lock" hint="SLPM"><Toggle value={config.pinEnabled} onChange={v=>upd("pinEnabled",v)} /></FieldRow>
        {config.pinEnabled&&(
          <FieldRow label="PIN" hint="SLP  0000-9999">
            <input value={config.pin} maxLength={4} onChange={e=>upd("pin",e.target.value.replace(/\D/g,"").slice(0,4))}
              style={{ maxWidth:80,fontFamily:MONO,letterSpacing:"0.2em",fontSize:14 }} placeholder="0000" />
          </FieldRow>
        )}
      </div>
      <HR />
      <SectionHead>Network</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="Mode" hint="SSIPC">
          <Btn small active={config.dhcp} onClick={()=>upd("dhcp",true)}>DHCP</Btn>
          <Btn small active={!config.dhcp} onClick={()=>upd("dhcp",false)}>Static</Btn>
        </FieldRow>
        {!config.dhcp&&(<>
          <FieldRow label="Static IP"><input value={config.staticIp} onChange={e=>upd("staticIp",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="192.168.1.100" /></FieldRow>
          <FieldRow label="Subnet mask"><input value={config.staticMask} onChange={e=>upd("staticMask",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="255.255.255.0" /></FieldRow>
          <FieldRow label="Gateway"><input value={config.staticGw} onChange={e=>upd("staticGw",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="192.168.1.1" /></FieldRow>
        </>)}
        <FieldRow label="Dest IP" hint="SV/SM/TR destination"><input value={config.destIp} onChange={e=>upd("destIp",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} /></FieldRow>
        <FieldRow label="Dest port"><input type="number" value={config.destPort} onChange={e=>upd("destPort",Number(e.target.value))} style={{ maxWidth:100,fontFamily:MONO }} /></FieldRow>
      </div>
    </div>
  );
}

// --- PUSH PANEL ---------------------------------------------------------------

function PushPanel({ config, setConfig }) {
  const [lines,setLines] = useState([]);
  const [running,setRunning] = useState(false);
  const [done,setDone] = useState(false);
  const ref = useRef(null);
  const add = msg => { setLines(l=>[...l,msg]); setTimeout(()=>{ if(ref.current) ref.current.scrollTop=ref.current.scrollHeight; },10); };
  const sl  = ms => new Promise(r=>setTimeout(r,ms));

  // Count all items
  const countAll = (root) => {
    let lv=0, tr=0, mu=0;
    const walk = n => {
      if(n.entry_type==="level"){ lv++; mu++; }
      if(n.entry_type==="action") tr++;
      (n.entries||[]).forEach(walk);
    };
    walk(root);
    return { lv, tr, mu };
  };

  const run = async () => {
    setLines([]); setRunning(true); setDone(false);
    const { lv, tr, mu } = countAll(config.mainMenu);
    const totalLv = lv + 1;
    const total   = 1+1+3+Math.ceil(tr/4)+totalLv*6;

    add(`> QUERY\\r`);

    // --- Real push via streaming backend endpoint ---
    try {
      // Find the first destination device to get destIp/destPort
      const destDev = config.devices?.[0];
      const pushBody = {
        destIp:  destDev?.ip       ?? "10.0.0.1",
        destPort: destDev?.port    ?? 49500,
        selfIp:  window.location.hostname,
        devName: destDev?.name     ?? "QSC",
        minDb:   -100, maxDb: 20, step: 2, pollMs: 500,
      };

      // Register device then stream push progress
      await fetch("/api/device", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ip:config.ip}) });

      const resp = await fetch(`/api/device/${config.ip}/push`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(pushBody),
      });

      // Read newline-delimited JSON stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalResult = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.log !== undefined) {
              add(obj.log);
            } else if (obj.result !== undefined) {
              finalResult = obj.result;
            }
          } catch {}
        }
      }

      if (finalResult?.ok) {
        add(`OK  Config committed. Hash: ${finalResult.hash}`);
        setConfig(c=>({...c, configHash: finalResult.hash}));
        addLog("ACK", `Push complete. SMID=${finalResult.hash?.slice(0,12)}...`);
      } else {
        add(`ERROR: ${finalResult?.error ?? "Unknown error"}`);
        addLog("ERR", `Push failed: ${finalResult?.error ?? "Unknown"}`);
      }

    } catch(err) {
      // Offline fallback: simulated sequence for UI testing without a device
      add(`(offline sim) No device at ${config.ip} -- running simulation`);
      add(`> QUERY\\r  ->  ACK QUERY MAC=${config.mac} IP=${config.ip} CM=${config.mode}`);
      add(`> SCM THIRD_PARTY\\r  ->  ACK SCM THIRD_PARTY`);
      await sl(100);
      add(`> GMIID\\r  ->  ACK GMIID discovered items`);
      await sl(80);
      add(`--- Phase 5: JSON push (${total} packets) ---`);
      await sl(100);
      add(`  [  1] MT{ids}                ->  ACK MENU_JSON 1`);
      add(`  [${total}] DL{entries:${config.devices.length}}           ->  ACK MENU_JSON ${total}`);
      await sl(60);
      add(`  [2..4] MI (root+submenus)   ->  OK OK OK`);
      if(tr>0) { add(`  [5] AI{${tr} triggers}          ->  ACK`); await sl(40); }
      for(let i=0;i<totalLv;i++) { add(`  CI/CQ/CA SV ${i+1}               ->  OK`); await sl(25); }
      add(`--- Batch result: all ${total} packets result_ids=0 ---`);
      await sl(140);
      const hash = Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join("");
      add(`> SCM THIRD_PARTY\\r  ->  ACK SCM THIRD_PARTY`);
      add(`> SMID ${hash}\\r  ->  ACK SMID ${hash}`);
      add(`OK  Config committed (sim). Hash: ${hash}`);
      setConfig(c=>({...c,configHash:hash}));
      addLog("ACK",`Push complete (sim). SMID=${hash.slice(0,12)}...`);
    }

    setRunning(false); setDone(true);
  };

  return (
    <div style={{ padding:"20px 24px",overflowY:"auto",height:"100%",maxWidth:700 }}>
      <SectionHead>Push to Device</SectionHead>
      <p style={{ fontSize:12,color:C.mid,lineHeight:1.7,marginBottom:16 }}>
        Sends the full configuration packet sequence to{" "}
        <span style={{ fontFamily:MONO,color:C.mono }}>{config.ip}:49494</span>.
        The device will restart its menu with the new settings after a successful push.
      </p>
      <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:16 }}>
        <Btn variant="primary" onClick={run} disabled={running}>
          {running ? "Pushing..." : "Push to device"}
        </Btn>
        {done&&<Tag color="green">Committed</Tag>}
      </div>
      {lines.length>0&&(
        <div ref={ref} style={{ background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,
          padding:"8px 10px",fontFamily:MONO,fontSize:11,lineHeight:1.85,
          height:280,overflowY:"auto",color:C.mono }}>
          {lines.map((l,i)=>(
            <div key={i} style={{ color:l.startsWith("OK")?C.green:l.startsWith("---")?C.mid:l.startsWith(">")?C.orange:C.mono }}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- LOG PANEL ----------------------------------------------------------------

function LogPanel() {
  const entries = useLog();
  const [filter,setFilter] = useState("ALL");
  const types = ["ALL","SV","SM","TR","ACK","ERR","INFO"];
  const LC = { SV:C.green, SM:C.warn, TR:C.blue, ACK:C.green, ERR:C.danger, INFO:C.dim };
  const filtered = filter==="ALL" ? entries : entries.filter(e=>e.type===filter);
  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",overflow:"hidden" }}>
      <div style={{ display:"flex",gap:4,padding:"8px 10px",borderBottom:`1px solid ${C.border}`,flexShrink:0,flexWrap:"wrap" }}>
        {types.map(t=>(<Btn key={t} small active={filter===t} onClick={()=>setFilter(t)}>{t}</Btn>))}
        <Btn small variant="danger" style={{ marginLeft:"auto" }} onClick={()=>{ LOG.entries=[]; LOG.cbs.forEach(f=>f([])); }}>Clear</Btn>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:"4px 0" }}>
        {filtered.map(e=>(
          <div key={e.id} style={{ display:"flex",gap:8,padding:"1px 10px",fontFamily:MONO,fontSize:11,lineHeight:1.85 }}>
            <span style={{ color:C.dim,flexShrink:0,minWidth:86 }}>{e.time}</span>
            <span style={{ color:LC[e.type]||C.mono,flexShrink:0,minWidth:36 }}>{e.type}</span>
            <span style={{ color:C.mono,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{e.msg}</span>
          </div>
        ))}
        {filtered.length===0&&<div style={{ padding:"20px",color:C.dim,fontSize:12,textAlign:"center" }}>No packets.</div>}
      </div>
    </div>
  );
}

// --- APPLE-STYLE SIDEBAR ------------------------------------------------------
// Section header label
function SbSection({ children }) {
  return (
    <div style={{
      fontSize:10, fontWeight:500, color:C.dim,
      letterSpacing:"0.07em", textTransform:"uppercase",
      padding:"12px 14px 4px", userSelect:"none",
    }}>{children}</div>
  );
}

// Nav row (Builder / Settings / Push)
function SbNavRow({ icon, label, active, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:9,
        padding:"5px 10px", margin:"0 4px", borderRadius:6,
        cursor:"pointer", userSelect:"none",
        background: active ? C.accent : hov ? C.s2 : "transparent",
        transition:"background .1s",
      }}>
      <span style={{ fontSize:15, color: active ? "#0b0d14" : C.mid, width:18, textAlign:"center", flexShrink:0 }}>{icon}</span>
      <span style={{ fontSize:12, color: active ? "#0b0d14" : C.mid, flex:1 }}>{label}</span>
    </div>
  );
}

// Device row (3rd-party targets like QSC)
function SbDeviceRow({ device, active, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"4px 10px", margin:"0 4px", borderRadius:6,
        cursor:"pointer", userSelect:"none",
        background: active ? C.accent : hov ? C.s2 : "transparent",
        transition:"background .1s",
      }}>
      <span style={{ fontSize:14, color: active ? "#0b0d14" : C.dim, width:18, textAlign:"center", flexShrink:0 }}>⬡</span>
      <div style={{ flex:1, overflow:"hidden" }}>
        <div style={{ fontSize:11, fontWeight:500, color: active ? "#0b0d14" : C.mid,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{device.name}</div>
        <div style={{ fontSize:9, color: active ? "rgba(0,0,0,.55)" : C.dim, fontFamily:MONO,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {device.ip}:{device.port}
        </div>
      </div>
      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
        background: active ? "#0b0d14" : C.sage, opacity: active ? 0.5 : 1 }} />
    </div>
  );
}

// C1 unit row
function SbUnitRow({ unit, active, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"4px 10px", margin:"0 4px", borderRadius:6,
        cursor:"pointer", userSelect:"none",
        background: active ? C.accent : hov ? C.s2 : "transparent",
        transition:"background .1s",
      }}>
      <span style={{ fontSize:13, color: active ? "#0b0d14" : C.dim, width:18, textAlign:"center", flexShrink:0 }}>◻</span>
      <div style={{ flex:1, overflow:"hidden" }}>
        <div style={{ fontSize:11, fontWeight:500, color: active ? "#0b0d14" : C.mid,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{unit.name}</div>
        <div style={{ fontSize:9, color: active ? "rgba(0,0,0,.55)" : C.dim, fontFamily:MONO }}>{unit.ip}</div>
      </div>
      <span style={{ fontSize:10, color: active ? "#0b0d14" : C.dim, opacity:.6 }}>›</span>
    </div>
  );
}

// Quiet "add" row
function SbAddRow({ label, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:9,
        padding:"4px 10px", margin:"0 4px", borderRadius:6,
        cursor:"pointer", userSelect:"none", opacity: hov ? 1 : 0.5,
        transition:"opacity .1s",
      }}>
      <span style={{ fontSize:13, color:C.dim, width:18, textAlign:"center", flexShrink:0 }}>+</span>
      <span style={{ fontSize:11, color:C.dim }}>{label}</span>
    </div>
  );
}

// --- ROOT APP -----------------------------------------------------------------

// Build a C1 list entry from a server device object (discovered over network)
const _mkC1FromDevice = (d) => {
  const base = mkC1(d.name || d.ip, d.ip);
  return _applyDeviceInfo(base, d);
};

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

const mkC1 = (name, ip) => ({ id:uid(), name, ip, mac:"--", firmware:"--", online:false, config: mkDefaultConfig() });

export default function App() {
  const [c1List, setC1List]         = useState([]);
  const [selectedC1, setSelectedC1] = useState(null);
  const [tab, setTab]               = useState("builder");
  // Single atomic navigation state -- one object, one setter, always in sync
  const [navState, setNavState] = useState({ view:"root", path:[] });

  // The one function everything calls to navigate. Never call setNavState directly.
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
    // Reset sim cursor/scroll on any navigation
    setSimState(s => ({ ...s, cursorIdx:0, scrollOffset:0 }));
  }, []);
  // Full sim interaction state: cursor position and scroll offset at every nav level
  const [simState, setSimState] = useState({
    navPath: null,      // null=root, []=mainMenu, [{id,label}...]=submenu
    cursorIdx: 0,       // which entry is selected (0-based across all entries)
    scrollOffset: 0,    // which entry is at top of 4-row window
  });

  useEffect(()=>{
    const s = document.createElement("style");
    s.textContent = G;
    document.head.appendChild(s);

    // Grain overlay -- injected separately to avoid template literal parsing issues
    const grain = document.createElement("style");
    const svgNoise = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/></filter><rect width='200' height='200' filter='url(%23g)' opacity='1'/></svg>`;
    grain.textContent = `body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:0.03;background-image:url("data:image/svg+xml,${encodeURIComponent(svgNoise)}")}`;
    document.head.appendChild(grain);

    addLog("INFO","Configurator ready.");
    // Real discovery: register device with backend then QUERY/VERSION/GETMAC
    const initialIp = c1List[0]?.config?.ip;
    if (initialIp && initialIp !== "192.168.1.200") {
      fetch("/api/device", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ip:initialIp}) })
        .then(()=>fetch(`/api/device/${initialIp}/discover`))
        .then(r=>r.json())
        .then(d=>{
          if(d.query)   addLog("ACK","QUERY \u2192 "+d.query);
          if(d.version) addLog("ACK","VERSION \u2192 "+d.version);
          if(d.mac)     addLog("ACK","GETMAC \u2192 "+d.mac);
        })
        .catch(()=>addLog("INFO","Discovery skipped -- no device reachable at "+initialIp));
    } else {
      addLog("INFO","Set device IP in Settings then push to connect.");
    }
    // --- Real WebSocket: stream SV/SM/TR from backend into log + sim ---
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
            // Update simVol (ch1) or per-channel vol
            setC1List(list => list.map(d => {
              if (d.id !== selectedC1) return d;
              const cfg = d.config;
              if (msg.channel === 1) return { ...d, config: { ...cfg, simVol: msg.db } };
              // find level entry by SV channel and update simChannelVols
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
            // Flash lightbar
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
    // Connect WS for initial C1 IP
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

  const [logOpen, setLogOpen] = useState(true);
  const [scanning, setScanning] = useState(false);

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
    addLog("INFO", "Scanning network for Axon C1 devices...");
    try {
      const r = await fetch("/api/scan", { method:"POST" });
      const j = await r.json();
      addLog("INFO", `Scan complete. Found ${j.total} device(s): ${(j.found||[]).join(", ") || "none"}`);
    } catch(e) {
      addLog("ERR", `Scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  };

  // Waiting-for-device shell -- shown while discovery runs and nothing is selected yet
  // Must be AFTER addC1/doScan/scanning are defined (they're used inside)
  // ── Discovery WebSocket with auto-reconnect ────────────────────────────
  useEffect(() => {
    let ws = null;
    let dead = false;
    let retryMs = 500;

    function applyDeviceSynced(device_ip, liveConfig, summary) {
      addLog("ACK", `Synced ${device_ip}: ${summary?.levels ?? 0} levels, ${summary?.triggers ?? 0} triggers, fw=${summary?.firmware ?? "?"}`);
      setC1List(prev => {
        const idx = prev.findIndex(u => u.ip === device_ip);
        if (idx < 0) {
          const newUnit = _mkC1FromDevice({ ip: device_ip, ...liveConfig });
          newUnit.config = { ...newUnit.config, ...liveConfig, devices: newUnit.config?.devices ?? liveConfig.devices };
          setSelectedC1(cur => cur ?? newUnit.id);
          return [...prev, newUnit];
        }
        const next = [...prev];
        const existing = next[idx];
        next[idx] = {
          ...existing,
          name:     liveConfig.deviceName || existing.name,
          mac:      liveConfig.mac        || existing.mac,
          firmware: liveConfig.firmwareVersion || existing.firmware,
          config:   { ...existing.config, ...liveConfig, devices: existing.config?.devices ?? liveConfig.devices },
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
            if (msg.msg?.startsWith("===") || msg.msg?.startsWith("OK")) {
              addLog("INFO", `[${msg.device_ip}] ${msg.msg}`);
            }
          }
        } catch {}
      };

      ws.onclose = () => { if (!dead) { setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 8000); } };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => { dead = true; ws?.close(); };
  }, []);

  // ── Explicit sync when a device is selected that hasn't loaded its config yet ──
  useEffect(() => {
    if (!selectedC1) return;
    const unit = c1List.find(u => u.id === selectedC1);
    if (!unit?.ip || unit.ip === "192.168.1.xxx") return;
    // Already synced if the menu tree contains device-sourced entries (id starts with "dev_")
    const hasDev = (node) => node?.id?.startsWith("dev_") ||
      (node?.entries || []).some(hasDev);
    if (hasDev(unit.config?.mainMenu) || hasDev(unit.config?.volMuteScreen)) return;

    addLog("INFO", `Loading config from ${unit.ip}...`);
    const ip = unit.ip;
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
                    next[idx] = { ...ex, name: liveConfig.deviceName || ex.name,
                      mac: liveConfig.mac || ex.mac, firmware: liveConfig.firmwareVersion || ex.firmware,
                      config: { ...ex.config, ...liveConfig, devices: ex.config?.devices ?? liveConfig.devices } };
                    return next;
                  });
                  addLog("ACK", `Config loaded: ${summary?.levels ?? 0} levels, ${summary?.triggers ?? 0} triggers`);
                } else if (!ok) { addLog("ERR", `Sync failed: ${error}`); }
              }
            } catch {}
          }
        }
      })
      .catch(e => addLog("ERR", `Sync request failed: ${e.message}`));
  }, [selectedC1]);
  // Sim panel -- extracted so it stays mounted regardless of tab
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
                  <Btn key={t.id} small onClick={()=>{
                    addLog("TR",`TR ${t.triggerNum}  (${t.display_txt})`);
                    const T = 250;
                    setC1Config(c=>({...c,lbOn:false}));
                    setTimeout(()=>setC1Config(c=>({...c,lbOn:true })),T*1);
                    setTimeout(()=>setC1Config(c=>({...c,lbOn:false})),T*2);
                    setTimeout(()=>setC1Config(c=>({...c,lbOn:true })),T*3);
                    setTimeout(()=>setC1Config(c=>({...c,lbOn:false})),T*4);
                    setTimeout(()=>setC1Config(c=>({...c,lbOn:true })),T*5);
                  }}>
                    {t.display_txt}
                  </Btn>
                ))}
              </div>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );

  // Selected 3rd-party device for sidebar highlight
  const [selectedDevice, setSelectedDevice] = useState(cfg.devices[0]?.name ?? null);

  // Breadcrumb label for context bar
  const breadcrumb = (() => {
    if (tab !== "builder") return null;
    if (navState.view === "root") return null;
    if (navState.path.length === 0) return [{ label:"Main menu" }];
    return [{ label:"Main menu" }, ...navState.path.map(s=>({ label:s.label }))];
  })();

  return (
    <div style={{ display:"flex", height:"100vh", overflow:"hidden", fontFamily:SANS, background:C.bg }}>

      {/* ── NO DEVICES: waiting for discovery ───────────────────── */}
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
              <button onClick={doScan} disabled={scanning} style={{
                height:28, borderRadius:4, border:`1px solid ${C.borderHi}`,
                background:C.s1, color:scanning?C.accent:C.mid, fontFamily:SANS, fontSize:12,
                cursor:scanning?"not-allowed":"pointer",
              }}>{scanning ? "Scanning..." : "⌕  Scan network"}</button>
              <button onClick={()=>{ const ip=prompt("Enter device IP:"); if(ip?.trim()) addC1(ip.trim()); }} style={{
                height:28, borderRadius:4, border:`1px solid ${C.border}`,
                background:C.s1, color:C.dim, fontFamily:SANS, fontSize:12, cursor:"pointer",
              }}>+  Add by IP</button>
            </div>
          </div>
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:12 }}>
            <div style={{ fontSize:13, color:C.dim }}>{scanning ? "Scanning network..." : "Waiting for device discovery..."}</div>
            <div style={{ fontSize:11, color:C.dim, opacity:.6 }}>Devices appear automatically via mDNS or broadcast scan.</div>
          </div>
        </div>
      )}

      {/* ── APPLE-STYLE SIDEBAR ─────────────────────────────────── */}
      <div style={{
        width:216, flexShrink:0,
        background:C.s0, borderRight:`1px solid ${C.border}`,
        display:"flex", flexDirection:"column", overflow:"hidden",
      }}>
        {/* App header */}
        <div style={{ padding:"16px 14px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:C.text, letterSpacing:"-0.01em" }}>Axon C1</div>
          <div style={{ fontSize:10, color:C.dim, marginTop:2, fontFamily:MONO, letterSpacing:"0.02em" }}>
            configurator v{cfg.firmwareVersion}
          </div>
        </div>

        {/* Scrollable nav body */}
        <div style={{ flex:1, overflowY:"auto", padding:"6px 0" }}>

          {/* Configure section */}
          <SbSection>Configure</SbSection>
          <SbNavRow icon="⊞" label="Menu builder"        active={tab==="builder"}  onClick={()=>setTab("builder")} />
          <SbNavRow icon="⚙" label="Device settings"     active={tab==="settings"} onClick={()=>setTab("settings")} />
          <SbNavRow icon="↑" label="Push to device"      active={tab==="push"}     onClick={()=>setTab("push")} />

          {/* 3rd-party Devices section */}
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
            setTab("devices");
          }} />

          {/* C1 Units section */}
          <SbSection>Units</SbSection>

          {/* Scan button */}
          <div style={{ padding:"4px 14px 6px", display:"flex", gap:6, alignItems:"center" }}>
            <button onClick={doScan} disabled={scanning} style={{
              flex:1, height:24, borderRadius:4, border:`1px solid ${scanning ? C.borderHi : C.border}`,
              background: scanning ? C.s2 : C.s1, color: scanning ? C.accent : C.mid,
              fontFamily:SANS, fontSize:11, cursor: scanning ? "not-allowed" : "pointer",
              display:"flex", alignItems:"center", justifyContent:"center", gap:5,
              transition:"all .12s",
            }}>
              <span style={{ fontSize:10 }}>{scanning ? "⟳" : "⌕"}</span>
              {scanning ? "Scanning..." : "Scan network"}
            </button>
            <button onClick={() => {
              const ip = prompt("Enter device IP address:");
              if (ip?.trim()) addC1(ip.trim());
            }} style={{
              width:24, height:24, borderRadius:4, border:`1px solid ${C.border}`,
              background:C.s1, color:C.mid, fontFamily:SANS, fontSize:14,
              cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
            }} title="Add by IP">+</button>
          </div>

          {c1List.length === 0 && !scanning && (
            <div style={{ padding:"8px 14px", fontSize:11, color:C.dim, lineHeight:1.5 }}>
              No devices found yet.<br/>
              <span style={{ color:C.dim }}>Scan will run automatically on start.</span>
            </div>
          )}

          {c1List.map(unit => (
            <SbUnitRow
              key={unit.id}
              unit={unit}
              active={selectedC1 === unit.id}
              onClick={() => setSelectedC1(unit.id)}
            />
          ))}

        </div>
      </div>

      {/* ── MAIN COLUMN (context bar + content + log) ───────────── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>

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
                  cursor:"pointer", fontFamily:SANS, fontSize:12, padding:"0 4px 0 0",
                }}>‹</button>
              )}
              {breadcrumb.map((b, i) => (
                <span key={i} style={{ display:"flex", alignItems:"center", gap:6 }}>
                  {i > 0 && <span style={{ fontSize:11, color:C.dim }}>›</span>}
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
          {/* Unit firmware tag */}
          <span style={{ fontSize:10, color:C.dim, fontFamily:MONO }}>
            {c1.name}
          </span>
        </div>

        {/* Tab content — display:none keeps all panels mounted */}
        <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>

          {/* Builder */}
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

          {/* 3rd-party devices */}
          <div style={{ display:tab==="devices"?"flex":"none", height:"100%", overflow:"hidden" }}>
            <DeviceListPanel devices={cfg.devices} setDevices={setDevices} />
          </div>

          {/* Settings */}
          <div style={{ display:tab==="settings"?"block":"none", height:"100%", overflow:"hidden" }}>
            <SettingsPanel config={cfg} setConfig={setC1Config} />
          </div>

          {/* Push */}
          <div style={{ display:tab==="push"?"block":"none", height:"100%", overflow:"hidden" }}>
            <PushPanel config={cfg} setConfig={setC1Config} />
          </div>

        </div>

        {/* Activity log — full width, collapsible drawer */}
        <div style={{
          flexShrink:0, borderTop:`1px solid ${C.border}`, background:C.s0,
          display:"grid",
          gridTemplateRows: logOpen ? "32px 1fr" : "32px 0fr",
          transition:"grid-template-rows .18s ease",
          maxHeight: logOpen ? 202 : 32,
        }}>
          <div
            onClick={()=>setLogOpen(o=>!o)}
            style={{
              display:"flex", alignItems:"center", padding:"0 14px", height:32,
              borderBottom: logOpen ? `1px solid ${C.border}` : "none",
              cursor:"pointer", userSelect:"none",
            }}>
            <span style={{ fontSize:10, fontWeight:500, color:C.dim, fontFamily:MONO, flex:1 }}>
              activity.log
            </span>
            <span style={{ fontSize:9, color:C.dim }}>{logOpen ? "[-]" : "[+]"}</span>
          </div>
          <div style={{ overflow:"hidden", minHeight:0 }}>
            {logOpen && <LogPanel />}
          </div>
        </div>

      </div>

      {/* ── PREVIEW RAIL — locked, always visible, original size ── */}
      <div style={{
        width:256, flexShrink:0,
        borderLeft:`1px solid ${C.border}`, background:C.s0,
        display:"flex", flexDirection:"column", overflow:"hidden",
      }}>
        {/* Rail header aligned with context bar */}
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

        {/* Sim panel — original layout, fully interactive */}
        {simPanel}
      </div>

    </div>
  );
}

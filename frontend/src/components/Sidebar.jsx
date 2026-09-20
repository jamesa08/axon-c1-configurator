import React, { useState } from "react";
import { C } from "../tokens.js";
import { LayoutGrid, Settings, Upload, Box, Plus, Smartphone } from "lucide-react";

export function SbSection({ children }) {
  return (
    <div style={{
      fontSize:11, fontWeight:600, color:C.dim,
      letterSpacing:"0.07em", textTransform:"uppercase",
      padding:"12px 14px 4px", userSelect:"none",
    }}>{children}</div>
  );
}

const SEL_BG  = "linear-gradient(to bottom,#69B1E5 0%,#3485D0 100%)";
const SEL_SHD = "0 -1px 0 0 #5CA4DF, inset 0 -1px 0 0 #327AC2, inset 0 1px 0 0 #71B9EA";

export function SbNavRow({ icon, label, active, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:9,
        padding:"5px 12px",
        margin: "1px 0",
        borderRadius: 0,
        cursor:"pointer", userSelect:"none",
        background: active ? SEL_BG : hov ? "rgba(0,0,0,0.06)" : "transparent",
        boxShadow: active ? SEL_SHD : "none",
        transition:"background .1s",
      }}>
      <span style={{ color: active ? "#fff" : C.mid, width:18, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{icon}</span>
      <span style={{ fontSize:13, color: active ? "#fff" : C.mid, flex:1, fontWeight: active ? 600 : 400, textShadow: active ? "0 1px 2px rgba(0,0,0,0.5)" : "0 1px 1px rgba(255,255,255,0.9)" }}>{label}</span>
    </div>
  );
}

export function SbDeviceRow({ device, active, onClick, index=0 }) {
  const [hov, setHov] = useState(false);
  const rowBg = index % 2 === 0 ? "transparent" : "rgba(0,0,0,0.03)";
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"5px 12px",
        margin: "1px 0",
        borderRadius: 0,
        cursor:"pointer", userSelect:"none",
        background: active ? SEL_BG : hov ? "rgba(0,0,0,0.06)" : rowBg,
        boxShadow: active ? SEL_SHD : "none",
        transition:"background .1s",
      }}>
      <span style={{ color: active ? "#fff" : C.dim, width:18, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Box size={13} /></span>
      <div style={{ flex:1, overflow:"hidden" }}>
        <div style={{ fontSize:13, fontWeight: active ? 600 : 500, color: active ? "#fff" : C.mid,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          textShadow: active ? "0 1px 2px rgba(0,0,0,0.5)" : "none" }}>{device.name}</div>
        <div style={{ fontSize:11, color: active ? "rgba(255,255,255,.65)" : C.dim,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {device.ip}:{device.port}
        </div>
      </div>
      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
        background: active ? "rgba(255,255,255,0.7)" : C.sage, opacity: active ? 1 : 1 }} />
    </div>
  );
}

export function SbUnitRow({ unit, active, onClick, index=0 }) {
  const [hov, setHov] = useState(false);
  const online = unit.online;
  const fw = unit.firmware && unit.firmware !== "--" ? unit.firmware : null;
  const rowBg = index % 2 === 0 ? "transparent" : "rgba(0,0,0,0.03)";
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"5px 12px",
        margin: "1px 0",
        borderRadius: 0,
        cursor:"pointer", userSelect:"none",
        background: active ? SEL_BG : hov ? "rgba(0,0,0,0.06)" : rowBg,
        boxShadow: active ? SEL_SHD : "none",
        transition:"background .1s",
      }}>
      <span style={{ color: active ? "#fff" : C.mid, width:18, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
        <Smartphone size={13} />
      </span>
      <div style={{ flex:1, overflow:"hidden" }}>
        <div style={{ fontSize:13, fontWeight: active ? 600 : 500, color: active ? "#fff" : C.mid,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          textShadow: active ? "0 1px 2px rgba(0,0,0,0.5)" : "none" }}>{unit.name}</div>
        <div style={{ fontSize:11, color: active ? "rgba(255,255,255,.65)" : C.dim,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {unit.ip}{fw ? ` · v${fw}` : ""}
        </div>
      </div>
      <div style={{
        width:6, height:6, borderRadius:"50%", flexShrink:0,
        background: active ? "rgba(255,255,255,0.7)" : online ? C.sage : C.dim,
        opacity: active ? 1 : online ? 1 : 0.35,
        boxShadow: (!active && online) ? `0 0 4px ${C.sage}` : "none",
      }} />
    </div>
  );
}

export function SbAddRow({ label, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:9,
        padding:"4px 10px", margin:"0 4px",
        cursor:"pointer", userSelect:"none", opacity: hov ? 1 : 0.5,
        transition:"opacity .1s",
      }}>
      <span style={{ color:C.dim, width:18, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Plus size={13} /></span>
      <span style={{ fontSize:12, color:C.dim }}>{label}</span>
    </div>
  );
}

import React, { useState } from "react";
import { C, MONO, SANS } from "../tokens.js";

export function SbSection({ children }) {
  return (
    <div style={{
      fontSize:10, fontWeight:500, color:C.dim,
      letterSpacing:"0.07em", textTransform:"uppercase",
      padding:"12px 14px 4px", userSelect:"none",
    }}>{children}</div>
  );
}

export function SbNavRow({ icon, label, active, onClick }) {
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

export function SbDeviceRow({ device, active, onClick }) {
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
      <span style={{ fontSize:14, color: active ? "#0b0d14" : C.dim, width:18, textAlign:"center", flexShrink:0 }}>&#11041;</span>
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

export function SbUnitRow({ unit, active, onClick }) {
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
      <span style={{ fontSize:13, color: active ? "#0b0d14" : C.dim, width:18, textAlign:"center", flexShrink:0 }}>&#9723;</span>
      <div style={{ flex:1, overflow:"hidden" }}>
        <div style={{ fontSize:11, fontWeight:500, color: active ? "#0b0d14" : C.mid,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{unit.name}</div>
        <div style={{ fontSize:9, color: active ? "rgba(0,0,0,.55)" : C.dim, fontFamily:MONO }}>{unit.ip}</div>
      </div>
      <span style={{ fontSize:10, color: active ? "#0b0d14" : C.dim, opacity:.6 }}>&#8250;</span>
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
        padding:"4px 10px", margin:"0 4px", borderRadius:6,
        cursor:"pointer", userSelect:"none", opacity: hov ? 1 : 0.5,
        transition:"opacity .1s",
      }}>
      <span style={{ fontSize:13, color:C.dim, width:18, textAlign:"center", flexShrink:0 }}>+</span>
      <span style={{ fontSize:11, color:C.dim }}>{label}</span>
    </div>
  );
}

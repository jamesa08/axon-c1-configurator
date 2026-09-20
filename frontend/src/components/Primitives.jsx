import React, { useState } from "react";
import { C, SANS } from "../tokens.js";

export function Btn({ children, variant="default", onClick, disabled, style, small, active }) {
  const [hov,setHov] = useState(false);
  const [press,setPress] = useState(false);

  // Aqua-style gradients lifted from Mac OS X Lion CSS3 demo
  const AQUA_DEFAULT    = "linear-gradient(to bottom, #ffffff 0%, #f3f3f3 50%, #ececec 50%, #ebebeb 100%)";
  const AQUA_DEFAULT_HV = "linear-gradient(to bottom, #f5f5f5 0%, #ebebeb 50%, #e0e0e0 50%, #dedede 100%)";
  const AQUA_PRIMARY    = "linear-gradient(to bottom, #d4e9fc 0%, #a1d1f9 50%, #87c5fb 50%, #d3f7fd 100%)";
  const AQUA_PRIMARY_PR = "linear-gradient(to bottom, #b8d9f5 0%, #85bef5 50%, #6ab0f3 50%, #b5eefc 100%)";

  const v = {
    default: { bg:AQUA_DEFAULT,  hbg:AQUA_DEFAULT_HV, pbg:AQUA_DEFAULT_HV, color:C.text,   border:"1px solid #9a9a9a", shadow:"inset 0 1px 0 rgba(255,255,255,1), 0 1px 0 rgba(0,0,0,0.09)" },
    primary: { bg:AQUA_PRIMARY,  hbg:AQUA_PRIMARY,    pbg:AQUA_PRIMARY_PR,  color:"#000",   border:"1px solid #56578f", shadow:"inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 0 rgba(0,0,0,0.12)" },
    ghost:   { bg:"transparent", hbg:"rgba(0,0,0,0.04)", pbg:"rgba(0,0,0,0.08)", color:C.dim, border:`1px solid ${C.border}`, shadow:"none" },
    danger:  { bg:AQUA_DEFAULT,  hbg:AQUA_DEFAULT_HV, pbg:AQUA_DEFAULT_HV, color:C.danger, border:`1px solid rgba(192,57,43,0.5)`, shadow:"inset 0 1px 0 rgba(255,255,255,1), 0 1px 0 rgba(0,0,0,0.09)" },
    green:   { bg:AQUA_DEFAULT,  hbg:AQUA_DEFAULT_HV, pbg:AQUA_DEFAULT_HV, color:C.sage,   border:`1px solid rgba(30,140,94,0.5)`, shadow:"inset 0 1px 0 rgba(255,255,255,1), 0 1px 0 rgba(0,0,0,0.09)" },
  }[variant] || {};

  const bg = active ? AQUA_PRIMARY : press ? v.pbg : hov ? v.hbg : v.bg;
  const color = active ? "#000" : v.color;
  const border = active ? "1px solid #56578f" : v.border;

  return (
    <button onClick={onClick} disabled={disabled}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>{ setHov(false); setPress(false); }}
      onMouseDown={()=>setPress(true)} onMouseUp={()=>setPress(false)}
      style={{
        height: small ? 22 : 28,
        padding: small ? "0 10px" : "0 14px",
        borderRadius: 4,
        background: bg,
        color,
        border,
        fontFamily: SANS,
        fontSize: small ? 11 : 13,
        fontWeight: 400,
        opacity: disabled ? 0.35 : 1,
        whiteSpace: "nowrap",
        display: "inline-flex", alignItems: "center", gap: 5,
        letterSpacing: "0.01em",
        boxShadow: disabled ? "none" : v.shadow,
        textShadow: variant === "default" || variant === "danger" || variant === "green" ? "0 1px 0 rgba(255,255,255,0.8)" : "none",
        cursor: disabled ? "default" : "pointer",
        ...style,
      }}>
      {children}
    </button>
  );
}

export function Toggle({ value, onChange, disabled }) {
  return (
    <div onClick={()=>!disabled&&onChange(!value)}
      style={{
        width:32, height:17, borderRadius:8,
        background: value ? C.accent : C.s3,
        border: `1px solid ${value ? C.accentHi : C.borderHi}`,
        position:"relative", cursor:disabled?"not-allowed":"pointer",
        transition:"background .15s, border-color .15s",
        flexShrink:0, opacity:disabled?0.35:1,
      }}>
      <div style={{
        position:"absolute", top:2.5, left:value?16:2.5, width:11, height:11,
        borderRadius:6, background: "#fff",
        transition:"left .15s", boxShadow:"0 1px 2px rgba(0,0,0,0.25)",
      }} />
    </div>
  );
}

export function Tag({ children, color="dim" }) {
  const m = {
    green:  { bg:C.sageDim,   c:C.sage   },
    orange: { bg:C.orangeDim, c:C.orange },
    blue:   { bg:C.blueDim,   c:C.blue   },
    warn:   { bg:C.warnDim,   c:C.warn   },
    danger: { bg:C.dangerDim, c:C.danger },
    dim:    { bg:C.s2,        c:C.dim    },
  };
  const s = m[color]||m.dim;
  return (
    <span style={{
      display:"inline-block", background:s.bg, color:s.c,
      fontFamily:SANS, fontSize:11, fontWeight:500,
      padding:"1px 6px",
      letterSpacing:"0.04em", lineHeight:"17px",
    }}>{children}</span>
  );
}

export function HR() {
  return (
    <div style={{ display:"block", flex:"none", alignSelf:"stretch", margin:"5px 0 4px", pointerEvents:"none" }}>
      <div style={{ height:1, background:C.border }} />
    </div>
  );
}

export function SectionHead({ children }) {
  return (
    <div style={{
      fontSize:11, fontWeight:600, letterSpacing:"0.04em",
      color:C.dim,
      marginBottom:10, paddingBottom:8,
      borderBottom:`1px solid ${C.border}`,
    }}>{children}</div>
  );
}

export function FieldRow({ label, hint, children, style }) {
  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:12, minHeight:28, ...style }}>
      <div style={{ minWidth:140, paddingTop:6, flexShrink:0 }}>
        <div style={{ fontSize:13, color:C.mid }}>{label}</div>
        {hint && <div style={{ fontSize:11, color:C.dim, marginTop:1, lineHeight:1.4, fontFamily:SANS }}>{hint}</div>}
      </div>
      <div style={{ flex:1, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>{children}</div>
    </div>
  );
}

export function Stack({ children, gap=10 }) {
  return <div style={{ display:"flex", flexDirection:"column", gap }}>{children}</div>;
}

export function Row({ children, gap=8 }) {
  return <div style={{ display:"flex", alignItems:"center", gap }}>{children}</div>;
}

export function Tabs({ tabs, active, onSelect }) {
  return (
    <div style={{ display:"flex", borderBottom:`1px solid ${C.border}`, marginBottom:12 }}>
      {tabs.map(t=>(
        <button key={t} onClick={()=>onSelect(t)} style={{
          padding:"6px 14px", fontFamily:SANS, fontSize:13, fontWeight:500,
          background:"transparent", border:"none", cursor:"pointer",
          color: active===t ? C.text : C.dim,
          borderBottom: active===t ? `2px solid ${C.accent}` : "2px solid transparent",
          marginBottom:-1, transition:"color .12s",
        }}>{t}</button>
      ))}
    </div>
  );
}

import React, { useState } from "react";
import { C, MONO, SANS } from "../tokens.js";

export function Btn({ children, variant="default", onClick, disabled, style, small, active }) {
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

export function Toggle({ value, onChange, disabled }) {
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

export function Tag({ children, color="dim" }) {
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

export function HR() { return <div style={{ display:"block", flex:"none", height:"1px", alignSelf:"stretch", background:C.borderHi, margin:"14px 0" }} />; }

export function SectionHead({ children }) {
  return (
    <div style={{
      fontSize:10, fontWeight:600, letterSpacing:"0.08em",
      textTransform:"uppercase", color:C.dim,
      marginBottom:10, paddingBottom:8,
      borderBottom:`1px solid ${C.border}`,
    }}>{children}</div>
  );
}

export function FieldRow({ label, hint, children }) {
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

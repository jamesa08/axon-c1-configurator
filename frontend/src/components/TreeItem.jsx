import React from "react";
import { C, MONO } from "../tokens.js";

export default function TreeItem({ entry, depth=0, selected, onSelect, onNavigate, index }) {
  const isMenu    = entry.entry_type === "menu";
  const isLevel   = entry.entry_type === "level";
  const isAction  = entry.entry_type === "action";
  const isSelected = selected?.id === entry.id;

  const icon = isMenu ? ">" : isLevel ? "||" : "!";
  const iconColor = isMenu ? C.orange : isLevel ? C.blue : C.green;

  return (
    <div
      onClick={() => onSelect(entry)}
      onDoubleClick={e => { e.stopPropagation(); if (isMenu) onNavigate(entry); }}
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

import React from "react";
import { C, MONO } from "../tokens.js";
import { FolderOpen, SlidersHorizontal, Zap } from "lucide-react";

export default function TreeItem({ entry, depth=0, selected, onSelect, onNavigate, index }) {
  const isMenu    = entry.entry_type === "menu";
  const isLevel   = entry.entry_type === "level";
  const isAction  = entry.entry_type === "action";
  const isSelected = selected?.id === entry.id;

  const icon = isMenu ? <FolderOpen size={11} /> : isLevel ? <SlidersHorizontal size={11} /> : <Zap size={11} />;
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
      <span style={{ color:iconColor, minWidth:18, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>{icon}</span>
      <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        fontSize:12, color:isSelected?C.orange:C.text, fontWeight:isSelected?500:400,
        paddingLeft:6 }}>
        {entry.display_txt}
      </span>
      {isMenu   && <span style={{ color:isSelected?C.orange:C.dim, flexShrink:0, display:"flex", alignItems:"center", paddingRight:4 }}><FolderOpen size={10} /></span>}
      {isLevel  && <span style={{ color:C.blue,  flexShrink:0, display:"flex", alignItems:"center", paddingRight:4 }}><SlidersHorizontal size={10} /></span>}
      {isAction && <span style={{ color:C.green, flexShrink:0, display:"flex", alignItems:"center", paddingRight:4 }}><Zap size={10} /></span>}
    </div>
  );
}

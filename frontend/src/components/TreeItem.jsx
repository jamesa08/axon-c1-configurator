import React from "react";
import { C } from "../tokens.js";
import { FolderOpen, SlidersHorizontal, Zap, ChevronRight } from "lucide-react";

export default function TreeItem({ entry, depth=0, selected, onSelect, onNavigate, index }) {
  const isMenu    = entry.entry_type === "menu";
  const isLevel   = entry.entry_type === "level";
  const isAction  = entry.entry_type === "action";
  const isSelected = selected?.id === entry.id;

  const icon = isMenu ? <FolderOpen size={11} /> : isLevel ? <SlidersHorizontal size={11} /> : <Zap size={11} />;
  const iconColor = isMenu ? C.accent : isLevel ? C.blue : C.green;

  return (
    <div
      onClick={() => onSelect(entry)}
      onDoubleClick={e => { e.stopPropagation(); if (isMenu) onNavigate(entry); }}
      style={{
        display:"flex", alignItems:"center", gap:0,
        height:34, flex:1,
        background: "transparent",
        cursor:"pointer", userSelect:"none",
        paddingLeft: 3, paddingRight: 8,
      }}
    >
      <span style={{ fontSize:11, color:C.dim, minWidth:32, paddingLeft:7,
        flexShrink:0, textAlign:"right", paddingRight:6 }}>{index+1}</span>
      <span style={{ color:iconColor, minWidth:18, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>{icon}</span>
      <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        fontSize:12, color:isSelected?C.accentHi:C.text, fontWeight:isSelected?500:400,
        paddingLeft:6 }}>
        {entry.display_txt}
      </span>
      {isMenu && <span style={{ color:isSelected?C.accentHi:C.dim, flexShrink:0, display:"flex", alignItems:"center", paddingRight:4 }}><ChevronRight size={13} /></span>}
    </div>
  );
}

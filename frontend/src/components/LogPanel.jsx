import React, { useState } from "react";
import { C, SANS } from "../tokens.js";
const MONO = "Monaco, 'Fira Code', monospace";

const ANSI = {
  black:   "#555555",
  red:     "#ff5555",
  green:   "#55ff55",
  blue:    "#5555ff",
  magenta: "#ff55ff",
  cyan:    "#55ffff",
  white:   "#ffffff",
};
import { LOG, useLog } from "../helpers.js";
import { Btn } from "./Primitives.jsx";

export default function LogPanel() {
  const entries = useLog();
  const [filter,setFilter] = useState("ALL");
  const types = ["ALL","SYNC","SV","SM","TR","ACK","ERR","INFO"];
  const LC = { SYNC:ANSI.cyan, SV:ANSI.green, SM:ANSI.magenta, TR:ANSI.blue, ACK:ANSI.green, ERR:ANSI.red, INFO:ANSI.white };
  const filtered = filter==="ALL" ? entries : entries.filter(e=>e.type===filter);
  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",overflow:"hidden" }}>
      <div style={{ display:"flex",gap:4,padding:"8px 10px",borderBottom:`1px solid ${C.border}`,flexShrink:0,flexWrap:"wrap" }}>
        {types.map(t=>(<Btn key={t} small active={filter===t} onClick={()=>setFilter(t)}>{t}</Btn>))}
        <Btn small variant="danger" style={{ marginLeft:"auto" }} onClick={()=>{ LOG.entries=[]; LOG.cbs.forEach(f=>f([])); }}>Clear</Btn>
      </div>
      <div style={{ flex:1,overflowY:"auto",background:"#000",padding:"4px 0" }}>
        {filtered.map(e=>(
          <div key={e.id} style={{ display:"flex",gap:8,padding:"1px 10px",fontFamily:MONO,fontWeight:400,fontSize:12,lineHeight:1.85 }}>
            <span style={{ color:ANSI.black,flexShrink:0,minWidth:86 }}>{e.time}</span>
            <strong style={{ color:LC[e.type]||ANSI.white,flexShrink:0,minWidth:36 }}>{e.type}</strong>
            <span style={{ color:ANSI.white,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{e.msg}</span>
          </div>
        ))}
        {filtered.length===0&&<div style={{ padding:"20px",color:"#6b7280",fontSize:12,textAlign:"center",background:"#000" }}>No packets.</div>}
      </div>
    </div>
  );
}

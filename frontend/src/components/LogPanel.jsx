import React, { useState } from "react";
import { C, MONO } from "../tokens.js";
import { LOG, useLog } from "../helpers.js";
import { Btn } from "./Primitives.jsx";

export default function LogPanel() {
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

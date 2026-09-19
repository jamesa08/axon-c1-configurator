import React from "react";
import { C, MONO } from "../tokens.js";
import { bytesToStr } from "../helpers.js";
import { Tag, FieldRow, HR } from "./Primitives.jsx";

export default function TriggerConfigPanel({ entry, devices, onChange }) {
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

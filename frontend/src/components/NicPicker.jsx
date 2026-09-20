import React from "react";
import { C, SANS } from "../tokens.js";
import { Btn } from "./Primitives.jsx";

export default function NicPicker({ value, onChange, compact = false }) {
  const [nics, setNics] = React.useState([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    setLoading(true);
    fetch("/api/interfaces")
      .then(r => r.json())
      .then(list => { setNics(list); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ fontFamily:SANS, fontSize:11, minWidth: compact ? 0 : 180, flex: compact ? 1 : undefined }}
      >
        <option value="">Auto-detect</option>
        {nics.map(n => (
          <option key={n.ip} value={n.ip}>{n.name} {n.ip}</option>
        ))}
      </select>
      {loading && <span style={{ fontSize:11, color:C.dim }}>loading...</span>}
      <Btn small onClick={() => {
        setLoading(true);
        fetch("/api/interfaces").then(r=>r.json()).then(list=>{setNics(list);setLoading(false);}).catch(()=>setLoading(false));
      }} style={{ flexShrink:0, padding:"0 8px" }}>↺</Btn>
    </div>
  );
}

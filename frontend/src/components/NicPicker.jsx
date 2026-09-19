import React from "react";
import { C, MONO } from "../tokens.js";

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
        style={{ fontFamily:MONO, fontSize:11, minWidth: compact ? 0 : 180, flex: compact ? 1 : undefined }}
      >
        <option value="">Auto-detect</option>
        {nics.map(n => (
          <option key={n.ip} value={n.ip}>{n.name} {n.ip}</option>
        ))}
      </select>
      {loading && <span style={{ fontSize:10, color:C.dim }}>loading...</span>}
      <button
        onClick={() => {
          setLoading(true);
          fetch("/api/interfaces").then(r=>r.json()).then(list=>{setNics(list);setLoading(false);}).catch(()=>setLoading(false));
        }}
        style={{ fontSize:10, padding:"2px 6px", cursor:"pointer" }}
      >&#8635;</button>
    </div>
  );
}

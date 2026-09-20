import React, { useState } from "react";
import { C, MONO } from "../tokens.js";
import { bytesToStr } from "../helpers.js";
import { FieldRow, HR, Tabs, Toggle } from "./Primitives.jsx";

function BytesInput({ value, onChange }) {
  const [raw, setRaw] = useState(() => bytesToStr(value));
  const [err, setErr] = useState(false);
  return (
    <div style={{ flex:1 }}>
      <input
        value={raw}
        onChange={e => {
          setRaw(e.target.value);
          const txt = e.target.value;
          const bytes = [];
          let ok = true;
          let i = 0;
          while (i < txt.length) {
            if (txt[i] === "\\") {
              if (txt.slice(i,i+2) === "\\r")  { bytes.push(0x0d); i+=2; }
              else if (txt.slice(i,i+4).match(/\\x[0-9a-fA-F]{2}/)) { bytes.push(parseInt(txt.slice(i+2,i+4),16)); i+=4; }
              else { ok=false; break; }
            } else {
              bytes.push(txt.charCodeAt(i)); i++;
            }
          }
          setErr(!ok);
          if (ok) onChange(bytes);
        }}
        style={{
          width:"100%", fontSize:11, fontFamily:MONO,
          borderColor: err ? C.danger : undefined,
        }}
        placeholder="ASCII or \xHH escapes, \r for CR"
      />
    </div>
  );
}

export default function StartupSyncPanel({ sync, devices, onChange }) {
  const [tab, setTab] = useState("Config");
  const upd = (k, v) => onChange({ ...sync, [k]: v });
  const devOptions = devices.map(d => d.name);
  const selDev = devices.find(d => d.name === sync.destination);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <Tabs tabs={["Config","Query","Async"]} active={tab} onSelect={setTab} />

      {tab === "Config" && (
        <>
          <FieldRow label="Destination">
            <select value={sync.destination || ""} onChange={e => upd("destination", e.target.value)} style={{ maxWidth:200 }}>
              <option value="">(none)</option>
              {devOptions.map(n => <option key={n}>{n}</option>)}
            </select>
          </FieldRow>
          {selDev && (<>
            <FieldRow label="Device"><span style={{ fontFamily:MONO, fontSize:11, color:C.mono }}>{selDev.name}</span></FieldRow>
            <FieldRow label="IP"><span style={{ fontFamily:MONO, fontSize:11, color:C.mono }}>{selDev.ip}</span></FieldRow>
            <FieldRow label="Port"><span style={{ fontFamily:MONO, fontSize:11, color:C.mono }}>{selDev.port}</span></FieldRow>
            <FieldRow label="Type"><span style={{ fontFamily:MONO, fontSize:11, color:C.mono }}>{selDev.proto || "UDP"}</span></FieldRow>
          </>)}
          <FieldRow label="Hex Values">
            <Toggle value={sync.hexValues || false} onChange={v => upd("hexValues", v)} />
            <span style={{ fontSize:11, color:C.dim }}>{sync.hexValues ? "Binary (hex input)" : "ASCII"}</span>
          </FieldRow>
          <HR />
          <div style={{ fontSize:10, fontWeight:600, color:C.dim, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:4 }}>Attributes</div>
          <FieldRow label="Inactive State">
            <BytesInput value={sync.inactiveState || []} onChange={v => upd("inactiveState", v)} />
          </FieldRow>
          <FieldRow label="Active State">
            <BytesInput value={sync.activeState || []} onChange={v => upd("activeState", v)} />
          </FieldRow>
        </>
      )}

      {tab === "Query" && (
        <>
          <FieldRow label="Enable Polling">
            <Toggle value={sync.queryEnable || false} onChange={v => upd("queryEnable", v)} />
          </FieldRow>
          {sync.queryEnable && (<>
            <FieldRow label="Interval (ms)">
              <input type="number" min={100} max={60000} step={100}
                value={sync.queryInterval ?? 500}
                onChange={e => upd("queryInterval", Number(e.target.value))}
                style={{ width:90 }} />
            </FieldRow>
            <FieldRow label="Query">
              <BytesInput value={sync.queryBytes || []} onChange={v => upd("queryBytes", v)} />
            </FieldRow>
            <FieldRow label="">
              <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
                <input type="checkbox" checked={sync.queryCr ?? true} onChange={e => upd("queryCr", e.target.checked)} />CR
              </label>
              <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
                <input type="checkbox" checked={sync.queryLf ?? false} onChange={e => upd("queryLf", e.target.checked)} />LF
              </label>
            </FieldRow>
            <FieldRow label="Response">
              <BytesInput value={sync.queryResponse || []} onChange={v => upd("queryResponse", v)} />
            </FieldRow>
          </>)}
        </>
      )}

      {tab === "Async" && (
        <>
          <FieldRow label="Monitor Async">
            <Toggle value={sync.asyncEnable || false} onChange={v => upd("asyncEnable", v)} />
          </FieldRow>
          {sync.asyncEnable && (<>
            <FieldRow label="IP">
              <input value={sync.asyncIp || ""} onChange={e => upd("asyncIp", e.target.value)} style={{ maxWidth:160 }} placeholder="0.0.0.0" />
            </FieldRow>
            <FieldRow label="Port">
              <input type="number" value={sync.asyncPort ?? 49500} onChange={e => upd("asyncPort", Number(e.target.value))} style={{ width:90 }} />
            </FieldRow>
            <FieldRow label="Type">
              <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
                <input type="radio" checked={sync.asyncType !== "TCP"} onChange={() => upd("asyncType","UDP")} />UDP
              </label>
              <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
                <input type="radio" checked={sync.asyncType === "TCP"} onChange={() => upd("asyncType","TCP")} />TCP
              </label>
            </FieldRow>
            <FieldRow label="Src IP">
              <input value={sync.asyncSrcIp || ""} onChange={e => upd("asyncSrcIp", e.target.value)} style={{ maxWidth:160 }} placeholder="(any)" />
            </FieldRow>
            <FieldRow label="Async Response">
              <BytesInput value={sync.asyncBytes || []} onChange={v => upd("asyncBytes", v)} />
            </FieldRow>
            <FieldRow label="">
              <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
                <input type="checkbox" checked={sync.asyncCr ?? true} onChange={e => upd("asyncCr", e.target.checked)} />CR
              </label>
              <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
                <input type="checkbox" checked={sync.asyncLf ?? false} onChange={e => upd("asyncLf", e.target.checked)} />LF
              </label>
            </FieldRow>
          </>)}
        </>
      )}
    </div>
  );
}

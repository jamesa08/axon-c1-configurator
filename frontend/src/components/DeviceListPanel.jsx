import React from "react";
import { C, SANS } from "../tokens.js";
import { mkDevice } from "../defaultData.js";
import { Btn, FieldRow } from "./Primitives.jsx";
import { Plus } from "lucide-react";

export default function DeviceListPanel({ devices, setDevices, selectedName, onSelectName }) {
  const selId = devices.find(d => d.name === selectedName)?.id ?? null;
  const setSel = (id) => {
    const name = id ? (devices.find(d => d.id === id)?.name ?? null) : null;
    if (onSelectName) onSelectName(name);
  };
  const upd = (id, k, v) => {
    setDevices(ds => ds.map(d => d.id === id ? { ...d, [k]: v } : d));
    if (k === "name" && onSelectName) onSelectName(v);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <div style={{ padding:"10px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontSize:12, fontWeight:600, color:C.mid, letterSpacing:"0.06em", textTransform:"uppercase" }}>3rd Party Devices</span>
        <Btn small disabled={devices.length >= 3} onClick={() => {
          const d = mkDevice("New Device", "10.0.0.1");
          setDevices(ds => [...ds, d]);
          if (onSelectName) onSelectName(d.name);
        }} title="Max 3 devices"><Plus size={12} /></Btn>
      </div>
      <div style={{ flex:1, overflowY:"auto" }}>
        {devices.length === 0 && (
          <div style={{ padding:"16px 14px", fontSize:12, color:C.dim, textAlign:"center" }}>
            No devices yet. Click + to add one.
          </div>
        )}
        {devices.map(d => (
          <div key={d.id}
            onClick={() => setSel(selId === d.id ? null : d.id)}
            style={{
              padding:"8px 12px", cursor:"pointer", borderBottom:`1px solid ${C.border}22`,
              background: selId === d.id ? C.s2 : "transparent",
            }}>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:C.green, flexShrink:0 }} />
              <span style={{ fontSize:12, fontWeight:500, color: selId === d.id ? C.text : C.mid }}>{d.name}</span>
            </div>
            <div style={{ fontFamily:SANS, fontSize:11, color:C.dim, marginTop:2 }}>{d.ip}:{d.port}</div>
          </div>
        ))}
      </div>
      {selId && (() => {
        const d = devices.find(x => x.id === selId);
        if (!d) return null;
        return (
          <div style={{ borderTop:`1px solid ${C.border}`, padding:"12px", flexShrink:0, overflowY:"auto", maxHeight:"55%" }}>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <FieldRow label="Name">
                <input value={d.name} onChange={e => upd(d.id, "name", e.target.value)} />
              </FieldRow>
              <FieldRow label="IP">
                <input value={d.ip} onChange={e => upd(d.id, "ip", e.target.value)} style={{ fontFamily:SANS }} />
              </FieldRow>
              <FieldRow label="Port">
                <input type="number" value={d.port} onChange={e => upd(d.id, "port", Number(e.target.value))} style={{ fontFamily:SANS, width:90 }} />
              </FieldRow>
              <FieldRow label="Async IP">
                <input value={d.asyncIp || ""} onChange={e => upd(d.id, "asyncIp", e.target.value)} style={{ fontFamily:SANS }} />
              </FieldRow>
              <FieldRow label="Async Port">
                <input type="number" value={d.asyncPort} onChange={e => upd(d.id, "asyncPort", Number(e.target.value))} style={{ fontFamily:SANS, width:90 }} />
              </FieldRow>
              <FieldRow label="Proto">
                <select value={d.proto || "UDP"} onChange={e => upd(d.id, "proto", e.target.value)} style={{ maxWidth:90 }}>
                  <option>UDP</option><option>TCP</option>
                </select>
              </FieldRow>
              <div style={{ display:"flex", justifyContent:"flex-end" }}>
                <Btn small variant="danger" onClick={() => {
                  setDevices(ds => ds.filter(x => x.id !== selId));
                  setSel(null);
                }}>Remove</Btn>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

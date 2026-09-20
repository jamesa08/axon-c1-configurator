import React, { useState } from "react";
import { C, SANS } from "../tokens.js";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import { bytesToStr, uid } from "../helpers.js";
import { Btn, FieldRow, HR } from "./Primitives.jsx";
import { mkMacroAction } from "../defaultData.js";

function ActionRow({ action, index, devices, onUpdate, onDelete, onMove, total }) {
  const [expanded, setExpanded] = useState(false);
  const upd = (k, v) => onUpdate({ ...action, [k]: v });
  const devOptions = devices.map(d => d.name);

  return (
    <div style={{
      border:`1px solid ${C.border}`,
      background:C.s1, marginBottom:4,
    }}>
      {/* Header row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", cursor:"pointer" }}
        onClick={() => setExpanded(e => !e)}>
        <span style={{ fontSize:11, color:C.dim, minWidth:16, textAlign:"right" }}>{index+1}</span>
        <span style={{ flex:1, fontSize:12, color:C.mid, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {action.name || "(unnamed)"}
        </span>
        <span style={{ fontSize:11, color:C.dim, fontFamily:SANS }}>
          {action.dev || "—"}
        </span>
        <div style={{ display:"flex", gap:2 }}>
          <button onClick={e=>{e.stopPropagation(); onMove(index,-1);}} disabled={index===0}
            style={{ background:C.s2, border:`1px solid ${C.border}`, color:C.dim, width:18, height:18, borderRadius:2, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><ChevronUp size={11} /></button>
          <button onClick={e=>{e.stopPropagation(); onMove(index,1);}} disabled={index===total-1}
            style={{ background:C.s2, border:`1px solid ${C.border}`, color:C.dim, width:18, height:18, borderRadius:2, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><ChevronDown size={11} /></button>
          <button onClick={e=>{e.stopPropagation(); onDelete(action.id);}}
            style={{ background:C.dangerDim, border:`1px solid rgba(224,85,85,0.3)`, color:C.danger, width:18, height:18, borderRadius:2, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><X size={11} /></button>
        </div>
        <span style={{ color:C.dim, display:"flex", alignItems:"center" }}>{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding:"8px 10px 10px", borderTop:`1px solid ${C.border}`, display:"flex", flexDirection:"column", gap:8 }}>
          <FieldRow label="Name">
            <input value={action.name} onChange={e => upd("name", e.target.value)} style={{ maxWidth:200 }} />
          </FieldRow>
          <FieldRow label="Destination">
            <select value={action.dev || ""} onChange={e => upd("dev", e.target.value)} style={{ maxWidth:180 }}>
              <option value="">(none)</option>
              {devOptions.map(n => <option key={n}>{n}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Command">
            <input
              value={bytesToStr(action.bytes)}
              onChange={e => {
                const txt = e.target.value;
                const bytes = [];
                let i = 0;
                while (i < txt.length) {
                  if (txt[i] === "\\" && txt.slice(i,i+2) === "\\r") { bytes.push(0x0d); i+=2; }
                  else if (txt[i] === "\\" && txt.slice(i,i+4).match(/\\x[0-9a-fA-F]{2}/)) { bytes.push(parseInt(txt.slice(i+2,i+4),16)); i+=4; }
                  else { bytes.push(txt.charCodeAt(i)); i++; }
                }
                upd("bytes", bytes);
              }}
              style={{ flex:1, fontFamily:SANS, fontSize:11 }}
              placeholder="ASCII or \xHH, \r for CR"
            />
          </FieldRow>
          <FieldRow label="">
            <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
              <input type="checkbox" checked={action.cr ?? true} onChange={e => upd("cr", e.target.checked)} />CR
            </label>
            <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
              <input type="checkbox" checked={action.lf ?? false} onChange={e => upd("lf", e.target.checked)} />LF
            </label>
          </FieldRow>
        </div>
      )}
    </div>
  );
}

export default function StartupMacroPanel({ macro, devices, onChange }) {
  const upd = (k, v) => onChange({ ...macro, [k]: v });
  const actions = macro.actions || [];
  const defaultDev = devices[0]?.name || "";

  const updateAction = (updated) => {
    upd("actions", actions.map(a => a.id === updated.id ? updated : a));
  };

  const deleteAction = (id) => {
    upd("actions", actions.filter(a => a.id !== id));
  };

  const addAction = () => {
    upd("actions", [...actions, mkMacroAction(defaultDev)]);
  };

  const moveAction = (idx, dir) => {
    const arr = [...actions];
    const ni = idx + dir;
    if (ni < 0 || ni >= arr.length) return;
    [arr[idx], arr[ni]] = [arr[ni], arr[idx]];
    upd("actions", arr);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <FieldRow label="Macro name">
        <input value={macro.name || ""} onChange={e => upd("name", e.target.value)} style={{ maxWidth:200 }} />
      </FieldRow>
      <HR />
      <div style={{ fontSize:11, fontWeight:600, color:C.dim, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:2 }}>
        Actions  <span style={{ fontWeight:400, color:C.dim }}>({actions.length})</span>
      </div>
      {actions.length === 0 && (
        <div style={{ fontSize:12, color:C.dim, textAlign:"center", padding:"12px 0" }}>No actions yet.</div>
      )}
      {actions.map((action, i) => (
        <ActionRow
          key={action.id}
          action={action}
          index={i}
          total={actions.length}
          devices={devices}
          onUpdate={updateAction}
          onDelete={deleteAction}
          onMove={moveAction}
        />
      ))}
      <Btn small onClick={addAction} style={{ alignSelf:"flex-start" }}>+ Add action</Btn>
    </div>
  );
}

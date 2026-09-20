import React, { useState, useEffect } from "react";
import { C, SANS } from "../tokens.js";
import { bytesToStr, strToBytes } from "../helpers.js";
import { Tag, FieldRow, HR, SectionHead } from "./Primitives.jsx";

export default function TriggerConfigPanel({ entry, devices, onChange }) {
  const devOptions = devices.map(d => d.name);

  const stripCrLf = (bytes, cr, lf) => {
    let b = [...bytes];
    if (b.length && b[b.length - 1] === 0x0a) { lf = true; b.pop(); }
    if (b.length && b[b.length - 1] === 0x0d) { cr = true; b.pop(); }
    return { b, cr, lf };
  };

  const [draft, setDraft] = useState(() => {
    const { b } = stripCrLf(entry.bytes, entry.cr || false, entry.lf || false);
    return bytesToStr(b);
  });

  useEffect(() => {
    const { b, cr, lf } = stripCrLf(entry.bytes, entry.cr || false, entry.lf || false);
    const hadCrLf = b.length !== entry.bytes.length;
    setDraft(bytesToStr(b));
    if (hadCrLf) onChange({ ...entry, bytes: b, cr, lf });
  }, [entry.id]);

  // Device limit: 64 bytes total including the appended CR/LF terminator(s)
  const MAX_BYTES = 64;
  const byteCount = (b, cr, lf) => b.length + (cr ? 1 : 0) + (lf ? 1 : 0);

  const commitPayload = () => {
    let b = strToBytes(draft);
    let cr = entry.cr || false;
    let lf = entry.lf || false;
    // Strip trailing LF then CR, set flags if found
    if (b.length && b[b.length - 1] === 0x0a) { lf = true; b = b.slice(0, -1); }
    if (b.length && b[b.length - 1] === 0x0d) { cr = true; b = b.slice(0, -1); }
    // Clamp to leave room for CR/LF terminator(s)
    const maxBody = MAX_BYTES - (cr ? 1 : 0) - (lf ? 1 : 0);
    if (b.length > maxBody) b = b.slice(0, maxBody);
    // Sync draft back to stripped form
    setDraft(bytesToStr(b));
    onChange({ ...entry, bytes: b, cr, lf });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <SectionHead>Action Configuration</SectionHead>
      <FieldRow label="Control Mode"><span style={{ fontSize:12, fontStyle:"italic", color:C.dim }}>3rd Party</span></FieldRow>
      <FieldRow label="Destination">
        <select value={entry.dev} onChange={e => onChange({ ...entry, dev: e.target.value })} style={{ maxWidth:180 }}>
          {devOptions.map(n => <option key={n}>{n}</option>)}
        </select>
      </FieldRow>
      {(() => {
        const dev = devices.find(d => d.name === entry.dev);
        return dev ? (<>
          <FieldRow label="IP"><span style={{ fontFamily:SANS, fontSize:11, color:C.mono }}>{dev.ip}</span></FieldRow>
          <FieldRow label="Port"><span style={{ fontFamily:SANS, fontSize:11, color:C.mono }}>{dev.port}</span></FieldRow>
        </>) : null;
      })()}
      <HR />
      <FieldRow label="Payload">
        <div style={{ display:"flex", flexDirection:"column", gap:3, width:"100%" }}>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitPayload}
            style={{ fontFamily:SANS, fontSize:11, width:"100%" }}
            spellCheck={false}
            placeholder=""
          />
          {(() => {
            const b = strToBytes(draft);
            const total = byteCount(b, entry.cr || false, entry.lf || false);
            const over = total > MAX_BYTES;
            return (
              <span style={{ fontSize:11, color: over ? C.danger : C.dim, fontFamily:SANS }}>
                {total}/{MAX_BYTES} bytes{over ? " — exceeds device limit" : ""}
              </span>
            );
          })()}
        </div>
      </FieldRow>
      <FieldRow label="">
        <div style={{ display:"flex", gap:10 }}>
          <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
            <input type="checkbox" checked={entry.cr || false} onChange={e => onChange({ ...entry, cr: e.target.checked })} />CR
          </label>
          <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:C.mid }}>
            <input type="checkbox" checked={entry.lf || false} onChange={e => onChange({ ...entry, lf: e.target.checked })} />LF
          </label>
        </div>
      </FieldRow>
    </div>
  );
}

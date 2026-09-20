import React, { useState, useEffect } from "react";
import { C, SANS } from "../tokens.js";
import { bytesToStr, strToBytes } from "../helpers.js";
import { Tabs, Toggle, FieldRow, HR } from "./Primitives.jsx";

const SectionLabel = ({ children }) => (
  <div style={{ fontSize:11, fontWeight:600, color:C.mid, letterSpacing:"0.04em", marginBottom:2, marginTop:2 }}>
    {children}
  </div>
);

// Editable byte field — shows human-readable string, commits on blur
function ByteField({ bytes, onChange }) {
  const [draft, setDraft] = useState(bytesToStr(bytes));
  useEffect(() => { setDraft(bytesToStr(bytes)); }, [bytes]);
  return (
    <input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => onChange(strToBytes(draft))}
      style={{ fontFamily:SANS, fontSize:11, width:"100%" }}
      spellCheck={false}
      placeholder=""
    />
  );
}

export default function LevelConfigPanel({ entry, devices, onChange }) {
  const [tab, setTab] = useState("Level");

  const vol  = entry.level_vol;
  const mute = entry.level_mute;
  const isLevel = tab === "Level";
  const ctrl = isLevel ? vol : mute;
  const updCtrl = (field, val) => {
    const key = isLevel ? "level_vol" : "level_mute";
    onChange({ ...entry, [key]: { ...ctrl, [field]: val } });
  };

  const devOptions = devices.map(d => d.name);
  const dev = devices.find(d => d.name === ctrl.set_dev_name);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <Tabs tabs={["Level","Mute"]} active={tab} onSelect={t => setTab(t)} />
      <div style={{ flex:1, overflowY:"auto", padding:"8px 4px 16px 0", display:"flex", flexDirection:"column", gap:8 }}>

        {/* ── Config ── */}
        <SectionLabel>Config</SectionLabel>
        <FieldRow label="Destination">
          <select value={ctrl.set_dev_name} onChange={e => updCtrl("set_dev_name", e.target.value)} style={{ maxWidth:180 }}>
            {devOptions.map(n => <option key={n}>{n}</option>)}
          </select>
        </FieldRow>
        {dev && (<>
          <FieldRow label="IP"><span style={{ fontFamily:SANS, fontSize:11, color:C.mono }}>{dev.ip}</span></FieldRow>
          <FieldRow label="Port"><span style={{ fontFamily:SANS, fontSize:11, color:C.mono }}>{dev.port}</span></FieldRow>
        </>)}
        <FieldRow label="Pre-Label">
          <input value={ctrl.levelPreStr ?? ""} onChange={e => updCtrl("levelPreStr", e.target.value.slice(0, 7))} maxLength={7} style={{ maxWidth:120, fontFamily:SANS }} placeholder='e.g. ""' />
        </FieldRow>
        <FieldRow label="Post-Label">
          <input value={ctrl.levelPostStr ?? ""} onChange={e => updCtrl("levelPostStr", e.target.value.slice(0, 7))} maxLength={7} style={{ maxWidth:120, fontFamily:SANS }} placeholder='e.g. " dB"' />
        </FieldRow>

        {isLevel && (<>
          <FieldRow label="Type">
            <select value={ctrl.setter_type === 1 ? "Explicit" : "Stateless"} onChange={e => updCtrl("setter_type", e.target.value === "Explicit" ? 1 : 0)} style={{ maxWidth:140 }}>
              <option>Explicit</option>
              <option>Stateless</option>
            </select>
          </FieldRow>
          <FieldRow label="Min" hint="dB">
            <input type="number" value={ctrl.minParam} onChange={e => updCtrl("minParam", Number(e.target.value))} style={{ maxWidth:90, fontFamily:SANS }} />
          </FieldRow>
          <FieldRow label="Max" hint="dB">
            <input type="number" value={ctrl.maxParam} onChange={e => updCtrl("maxParam", Number(e.target.value))} style={{ maxWidth:90, fontFamily:SANS }} />
          </FieldRow>
          <FieldRow label="Step" hint="dB">
            <input type="number" value={ctrl.stepSize} onChange={e => updCtrl("stepSize", Number(e.target.value))} style={{ maxWidth:90, fontFamily:SANS }} />
          </FieldRow>
          <FieldRow label="Precision">
            <select value={ctrl.paramDecPts} onChange={e => updCtrl("paramDecPts", Number(e.target.value))} style={{ maxWidth:90 }}>
              {[0,1,2].map(n => <option key={n}>{n}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Trim">
            <Toggle value={ctrl.trimEnable} onChange={v => updCtrl("trimEnable", v)} />
          </FieldRow>
        </>)}
        {!isLevel && (
          <FieldRow label="Type">
            <select value={ctrl.setter_type === 1 ? "Explicit" : "Stateless"} onChange={e => updCtrl("setter_type", e.target.value === "Explicit" ? 1 : 0)} style={{ maxWidth:140 }}>
              <option>Stateless</option>
              <option>Explicit</option>
            </select>
          </FieldRow>
        )}

        <HR />

        {/* ── Set ── */}
        <SectionLabel>Set</SectionLabel>
        <FieldRow label="Command">
          <ByteField bytes={ctrl.setBytes} onChange={v => updCtrl("setBytes", v)} />
        </FieldRow>
        {isLevel && (
          <FieldRow label="ACK required">
            <Toggle value={ctrl.ackEnable} onChange={v => updCtrl("ackEnable", v)} />
          </FieldRow>
        )}
        <FieldRow label="">
          <span style={{ fontSize:11, color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
        </FieldRow>

        <HR />

        {/* ── Query ── */}
        <SectionLabel>Query</SectionLabel>
        <FieldRow label="Enable polling">
          <Toggle value={ctrl.queryEnable} onChange={v => updCtrl("queryEnable", v)} />
        </FieldRow>
        <FieldRow label="Interval" hint="ms">
          <input type="number" value={ctrl.pollMs} onChange={e => updCtrl("pollMs", Number(e.target.value))} style={{ maxWidth:90, fontFamily:SANS }} />
          <span style={{ fontSize:11, color:C.mid }}>ms</span>
        </FieldRow>
        <FieldRow label="Query">
          <ByteField bytes={ctrl.queryBytes} onChange={v => updCtrl("queryBytes", v)} />
        </FieldRow>
        <FieldRow label="Response">
          <ByteField bytes={ctrl.respQueryBytes} onChange={v => updCtrl("respQueryBytes", v)} />
        </FieldRow>
        <FieldRow label="">
          <span style={{ fontSize:11, color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
        </FieldRow>

        <HR />

        {/* ── Async ── */}
        <SectionLabel>Async</SectionLabel>
        <FieldRow label="Monitor async">
          <Toggle value={ctrl.asyncEnable} onChange={v => updCtrl("asyncEnable", v)} />
        </FieldRow>
        {dev && (<>
          <FieldRow label="Async IP"><span style={{ fontFamily:SANS, fontSize:11, color:C.mono }}>{dev.asyncIp}</span></FieldRow>
          <FieldRow label="Async Port"><span style={{ fontFamily:SANS, fontSize:11, color:C.mono }}>{dev.asyncPort}</span></FieldRow>
        </>)}
        <FieldRow label="Async response">
          <ByteField bytes={ctrl.syncBytes} onChange={v => updCtrl("syncBytes", v)} />
        </FieldRow>
        <FieldRow label="">
          <span style={{ fontSize:11, color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
        </FieldRow>

      </div>
    </div>
  );
}

import React, { useState } from "react";
import { C, MONO } from "../tokens.js";
import { bytesToStr } from "../helpers.js";
import { Tabs, Toggle, FieldRow, HR } from "./Primitives.jsx";

export default function LevelConfigPanel({ entry, devices, onChange }) {
  const [tab, setTab]    = useState("Level");
  const [subtab, setSubtab] = useState("Config");

  const vol  = entry.level_vol;
  const mute = entry.level_mute;
  const isLevel = tab === "Level";
  const ctrl = isLevel ? vol : mute;
  const updCtrl = (field, val) => {
    const key = isLevel ? "level_vol" : "level_mute";
    onChange({ ...entry, [key]: { ...ctrl, [field]: val } });
  };

  const devOptions = devices.map(d => d.name);

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%",overflow:"hidden" }}>
      <Tabs tabs={["Level","Mute"]} active={tab} onSelect={t=>{ setTab(t); setSubtab("Config"); }} />
      <Tabs tabs={["Config","Set","Query","Async"]} active={subtab} onSelect={setSubtab} />
      <div style={{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,paddingRight:4 }}>

        {subtab === "Config" && (
          <>
            <FieldRow label="Destination">
              <select value={ctrl.set_dev_name} onChange={e=>updCtrl("set_dev_name",e.target.value)} style={{ maxWidth:180 }}>
                {devOptions.map(n=><option key={n}>{n}</option>)}
              </select>
            </FieldRow>
            {(() => {
              const dev = devices.find(d=>d.name===ctrl.set_dev_name);
              if (!dev) return null;
              return (<>
                <FieldRow label="Device"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.name}</span></FieldRow>
                <FieldRow label="IP"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.ip}</span></FieldRow>
                <FieldRow label="Port"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.port}</span></FieldRow>
                <FieldRow label="Type"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>UDP</span></FieldRow>
              </>);
            })()}
            <HR />
            {isLevel && (<>
              <FieldRow label="Type">
                <select value={ctrl.setter_type===1?"Explicit":"Stateless"} onChange={e=>updCtrl("setter_type",e.target.value==="Explicit"?1:0)} style={{ maxWidth:140 }}>
                  <option>Explicit</option>
                  <option>Stateless</option>
                </select>
              </FieldRow>
              <FieldRow label="Min" hint="dB">
                <input type="number" value={ctrl.minParam} onChange={e=>updCtrl("minParam",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              </FieldRow>
              <FieldRow label="Max" hint="dB">
                <input type="number" value={ctrl.maxParam} onChange={e=>updCtrl("maxParam",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              </FieldRow>
              <FieldRow label="Step" hint="dB">
                <input type="number" value={ctrl.stepSize} onChange={e=>updCtrl("stepSize",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              </FieldRow>
              <FieldRow label="Precision">
                <select value={ctrl.paramDecPts} onChange={e=>updCtrl("paramDecPts",Number(e.target.value))} style={{ maxWidth:90 }}>
                  {[0,1,2].map(n=><option key={n}>{n}</option>)}
                </select>
              </FieldRow>
              <FieldRow label="Trim">
                <Toggle value={ctrl.trimEnable} onChange={v=>updCtrl("trimEnable",v)} />
              </FieldRow>
            </>)}
            {!isLevel && (
              <FieldRow label="Type">
                <select value={ctrl.setter_type===1?"Explicit":"Stateless"} onChange={e=>updCtrl("setter_type",e.target.value==="Explicit"?1:0)} style={{ maxWidth:140 }}>
                  <option>Stateless</option>
                  <option>Explicit</option>
                </select>
              </FieldRow>
            )}
          </>
        )}

        {subtab === "Set" && (
          <>
            <FieldRow label="Command">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.setBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="">
              <span style={{ fontSize:11,color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
            </FieldRow>
            {isLevel && (
              <>
                <FieldRow label="ACK required">
                  <Toggle value={ctrl.ackEnable} onChange={v=>updCtrl("ackEnable",v)} />
                </FieldRow>
              </>
            )}
          </>
        )}

        {subtab === "Query" && (
          <>
            <FieldRow label="Enable polling">
              <Toggle value={ctrl.queryEnable} onChange={v=>updCtrl("queryEnable",v)} />
            </FieldRow>
            <FieldRow label="Interval" hint="ms">
              <input type="number" value={ctrl.pollMs} onChange={e=>updCtrl("pollMs",Number(e.target.value))} style={{ maxWidth:90,fontFamily:MONO }} />
              <span style={{ fontSize:11,color:C.mid }}>ms</span>
            </FieldRow>
            <FieldRow label="Query">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.queryBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="Response">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.respQueryBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="">
              <span style={{ fontSize:11,color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
            </FieldRow>
          </>
        )}

        {subtab === "Async" && (
          <>
            <FieldRow label="Monitor async">
              <Toggle value={ctrl.asyncEnable} onChange={v=>updCtrl("asyncEnable",v)} />
            </FieldRow>
            {(() => {
              const dev = devices.find(d=>d.name===ctrl.set_dev_name);
              return dev ? (<>
                <FieldRow label="IP"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.asyncIp}</span></FieldRow>
                <FieldRow label="Port"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{dev.asyncPort}</span></FieldRow>
                <FieldRow label="Type"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>UDP</span></FieldRow>
              </>) : null;
            })()}
            <FieldRow label="Async response">
              <div style={{ fontFamily:MONO,fontSize:11,color:C.mono,background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,padding:"4px 8px",width:"100%" }}>
                {bytesToStr(ctrl.syncBytes)||"(none)"}
              </div>
            </FieldRow>
            <FieldRow label="">
              <span style={{ fontSize:11,color:C.dim }}>&#x2609; = Wild &nbsp; &#x2139; = Vol / State</span>
            </FieldRow>
          </>
        )}
      </div>
    </div>
  );
}

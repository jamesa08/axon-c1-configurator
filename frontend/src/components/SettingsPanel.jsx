import React, { useState, useEffect, useRef } from "react";
import { C, MONO } from "../tokens.js";
import { Btn, Toggle, Tag, HR, SectionHead, FieldRow } from "./Primitives.jsx";
import NicPicker from "./NicPicker.jsx";

export default function SettingsPanel({ config, setConfig }) {
  const [draft, setDraft] = useState(config);
  const [status, setStatus] = useState(null); // null | "applying" | "ok" | "err"
  const statusTimer = useRef(null);

  // Re-sync draft when a device sync updates config from outside
  useEffect(() => {
    setDraft(config);
  }, [config]);

  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  async function apply() {
    setStatus("applying");
    const ip = draft.ip;
    const canSend = ip && ip !== "192.168.1.200";
    const cmd = async (c) => {
      if (!canSend) return;
      await fetch(`/api/device/${ip}/cmd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: c }),
      });
    };

    try {
      if (draft.deviceName !== config.deviceName)
        await cmd(`SDN ${draft.deviceName}`);
      if (draft.displayBrightness !== config.displayBrightness)
        await cmd(`SDB ${draft.displayBrightness}`);
      if (draft.displayTimeout !== config.displayTimeout)
        await cmd(`SDT ${draft.displayTimeout}`);
      if (draft.displayRotation !== config.displayRotation)
        await cmd(`SDR ${draft.displayRotation}`);
      if (draft.lbOn !== config.lbOn || draft.lbColor !== config.lbColor) {
        if (!draft.lbOn) {
          await cmd("SLC OFF");
        } else {
          const r = parseInt(draft.lbColor.slice(1,3), 16);
          const g = parseInt(draft.lbColor.slice(3,5), 16);
          const b = parseInt(draft.lbColor.slice(5,7), 16);
          await cmd(`SLC ${r}:${g}:${b}`);
        }
      }
      if (draft.lbBrightness !== config.lbBrightness)
        await cmd(`SLBB ${draft.lbBrightness}`);
      if (draft.lbTimeout !== config.lbTimeout)
        await cmd(`SLBT ${draft.lbTimeout}`);
      if (draft.lbColorMode !== config.lbColorMode)
        await cmd(`SLCM ${draft.lbColorMode}`);
      if (draft.pinEnabled !== config.pinEnabled)
        await cmd(`SLPM ${draft.pinEnabled ? 1 : 0}`);
      if (draft.pin !== config.pin)
        await cmd(`SLP ${draft.pin}`);

      setConfig(draft);
      setStatus("ok");
    } catch {
      setStatus("err");
    }
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 2500);
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      {/* Scrollable fields */}
      <div style={{ flex:1, overflowY:"auto", padding:"20px 24px", display:"flex", flexDirection:"column", gap:0, boxSizing:"border-box" }}>
        <SectionHead>Device</SectionHead>
        <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
          <FieldRow label="Device name" hint="SDN"><input value={draft.deviceName} maxLength={16} onChange={e=>upd("deviceName",e.target.value.replace(/\s/g,"").slice(0,16))} style={{ maxWidth:220 }} /></FieldRow>
          <FieldRow label="IP address"><input value={draft.ip} onChange={e=>upd("ip",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} /></FieldRow>
          <FieldRow label="Mode">
            <select value={draft.mode} onChange={e=>upd("mode",e.target.value)} style={{ maxWidth:220 }}>
              <option value="THIRD_PARTY">Third Party</option>
              <option value="Q-SYS">Q-SYS</option>
            </select>
          </FieldRow>
          <FieldRow label="Firmware"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{config.firmwareVersion}</span></FieldRow>
          <FieldRow label="MAC"><span style={{ fontFamily:MONO,fontSize:11,color:C.mono }}>{config.mac}</span></FieldRow>
        </div>
        <HR />
        <SectionHead>Display</SectionHead>
        <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
          <FieldRow label="Brightness" hint="SDB  1-10">
            <input type="range" min={1} max={10} value={draft.displayBrightness} onChange={e=>upd("displayBrightness",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
            <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:24 }}>{draft.displayBrightness}</span>
          </FieldRow>
          <FieldRow label="Timeout" hint="SDT  10-600 s">
            <input type="range" min={10} max={600} step={10} value={draft.displayTimeout} onChange={e=>upd("displayTimeout",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
            <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:36 }}>{draft.displayTimeout}s</span>
          </FieldRow>
          <FieldRow label="Rotation" hint="SDR">
            <Btn small active={draft.displayRotation===0} onClick={()=>upd("displayRotation",0)}>Normal</Btn>
            <Btn small active={draft.displayRotation===1} onClick={()=>upd("displayRotation",1)}>90deg</Btn>
          </FieldRow>
          <FieldRow label="Lock" hint="SDL -- stub on FW 1.5">
            <Toggle value={draft.displayLock===1} onChange={v=>upd("displayLock",v?1:0)} />
            {draft.displayLock===1&&<Tag color="warn">NO EFFECT on FW 1.5</Tag>}
          </FieldRow>
        </div>
        <HR />
        <SectionHead>Lightbar</SectionHead>
        <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
          <FieldRow label="State">
            <Toggle value={draft.lbOn} onChange={v=>upd("lbOn",v)} />
            <span style={{ fontSize:12,color:C.mid }}>{draft.lbOn?"On":"Off"}</span>
          </FieldRow>
          <FieldRow label="Color" hint="SLC -- keepalive req. every ~5 s">
            <input type="color" value={draft.lbColor} onChange={e=>upd("lbColor",e.target.value)} style={{ width:40,height:28,padding:2 }} />
            <span style={{ fontFamily:MONO,fontSize:11,color:draft.lbColor }}>{draft.lbColor}</span>
            {["#ff2020","#3ddc6e","#4a90ff","#ffcc00","#ff8800","#ffffff"].map(col=>(
              <div key={col} onClick={()=>upd("lbColor",col)} style={{ width:16,height:16,borderRadius:2,background:col,cursor:"pointer",
                outline:draft.lbColor===col?`2px solid ${C.text}`:"2px solid transparent",outlineOffset:1 }} />
            ))}
          </FieldRow>
          <FieldRow label="Brightness" hint="SLBB  0-10">
            <input type="range" min={1} max={10} value={draft.lbBrightness} onChange={e=>upd("lbBrightness",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
            <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:24 }}>{draft.lbBrightness}</span>
          </FieldRow>
          <FieldRow label="Timeout" hint="SLBT  10-600 s">
            <input type="range" min={10} max={600} step={10} value={draft.lbTimeout} onChange={e=>upd("lbTimeout",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
            <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:36 }}>{draft.lbTimeout}s</span>
          </FieldRow>
          <FieldRow label="Mode" hint="SLCM">
            <Btn small active={draft.lbColorMode===0} onClick={()=>upd("lbColorMode",0)}>0 -- Static</Btn>
            <Btn small active={draft.lbColorMode===1} onClick={()=>upd("lbColorMode",1)}>1 -- Unknown</Btn>
          </FieldRow>
        </div>
        <HR />
        <SectionHead>Security</SectionHead>
        <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
          <FieldRow label="PIN lock" hint="SLPM"><Toggle value={draft.pinEnabled} onChange={v=>upd("pinEnabled",v)} /></FieldRow>
          {draft.pinEnabled&&(
            <FieldRow label="PIN" hint="SLP  0000-9999">
              <input value={draft.pin} maxLength={4} onChange={e=>upd("pin",e.target.value.replace(/\D/g,"").slice(0,4))}
                style={{ maxWidth:80,fontFamily:MONO,letterSpacing:"0.2em",fontSize:14 }} placeholder="0000" />
            </FieldRow>
          )}
        </div>
        <HR />
        <SectionHead>Network</SectionHead>
        <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
          <FieldRow label="Mode" hint="SSIPC">
            <Btn small active={draft.dhcp} onClick={()=>upd("dhcp",true)}>DHCP</Btn>
            <Btn small active={!draft.dhcp} onClick={()=>upd("dhcp",false)}>Static</Btn>
          </FieldRow>
          {!draft.dhcp&&(<>
            <FieldRow label="Static IP"><input value={draft.staticIp} onChange={e=>upd("staticIp",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="192.168.1.100" /></FieldRow>
            <FieldRow label="Subnet mask"><input value={draft.staticMask} onChange={e=>upd("staticMask",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="255.255.255.0" /></FieldRow>
            <FieldRow label="Gateway"><input value={draft.staticGw} onChange={e=>upd("staticGw",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="192.168.1.1" /></FieldRow>
          </>)}
          <FieldRow label="Dest IP" hint="SV/SM/TR destination"><input value={draft.destIp} onChange={e=>upd("destIp",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} /></FieldRow>
          <FieldRow label="Dest port"><input type="number" value={draft.destPort} onChange={e=>upd("destPort",Number(e.target.value))} style={{ maxWidth:100,fontFamily:MONO }} /></FieldRow>
          <FieldRow label="Host NIC" hint="Interface for push/async traffic">
            <NicPicker value={draft.selfIp || ""} onChange={v=>upd("selfIp",v)} />
          </FieldRow>
        </div>
      </div>

      {/* Sticky Apply bar */}
      <div style={{
        borderTop: `1px solid ${C.border}`,
        padding: "10px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexShrink: 0,
      }}>
        <Btn variant="primary" disabled={!dirty || status==="applying"} onClick={apply}>
          {status==="applying" ? "Applying…" : "Apply"}
        </Btn>
        {dirty && status === null && (
          <span style={{ fontSize:12, color:C.dim }}>Unsaved changes</span>
        )}
        {status === "ok" && (
          <span style={{ fontSize:12, color:C.sage }}>Applied</span>
        )}
        {status === "err" && (
          <span style={{ fontSize:12, color:C.danger }}>Error sending commands</span>
        )}
      </div>
    </div>
  );
}

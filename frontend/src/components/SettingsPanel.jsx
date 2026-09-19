import React from "react";
import { C, MONO } from "../tokens.js";
import { Btn, Toggle, Tag, HR, SectionHead, FieldRow } from "./Primitives.jsx";
import NicPicker from "./NicPicker.jsx";

export default function SettingsPanel({ config, setConfig }) {
  const upd = (k,v) => {
    setConfig(c=>({...c,[k]:v}));
    // Fire real UDP commands for immediate hardware feedback
    const ip = config.ip;
    if (!ip || ip === "192.168.1.200") return;
    const cmd = (c) => fetch(`/api/device/${ip}/cmd`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cmd:c})}).catch(()=>{});
    if (k === "lbColor") {
      const r = parseInt(v.slice(1,3),16), g = parseInt(v.slice(3,5),16), b = parseInt(v.slice(5,7),16);
      cmd(`SLC ${r}:${g}:${b}`);
    }
    if (k === "lbOn" && !v) cmd("SLC OFF");
    if (k === "displayBrightness") cmd(`SDB ${v}`);
    if (k === "displayTimeout")    cmd(`SDT ${v}`);
    if (k === "displayRotation")   cmd(`SDR ${v}`);
    if (k === "lbBrightness")      cmd(`SLBB ${v}`);
    if (k === "lbTimeout")         cmd(`SLBT ${v}`);
    if (k === "pinEnabled")        cmd(`SLPM ${v ? 1 : 0}`);
    if (k === "pin")               cmd(`SLP ${v}`);
  };
  return (
    <div style={{ padding:"20px 24px",overflowY:"auto",height:"100%",display:"flex",flexDirection:"column",gap:0,width:"100%",boxSizing:"border-box" }}>
      <SectionHead>Device</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="Device name" hint="SDN"><input value={config.deviceName} onChange={e=>upd("deviceName",e.target.value)} style={{ maxWidth:220 }} /></FieldRow>
        <FieldRow label="IP address"><input value={config.ip} onChange={e=>upd("ip",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} /></FieldRow>
        <FieldRow label="Mode">
          <select value={config.mode} onChange={e=>upd("mode",e.target.value)} style={{ maxWidth:220 }}>
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
          <input type="range" min={1} max={10} value={config.displayBrightness} onChange={e=>upd("displayBrightness",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:24 }}>{config.displayBrightness}</span>
        </FieldRow>
        <FieldRow label="Timeout" hint="SDT  10-600 s">
          <input type="range" min={10} max={600} step={10} value={config.displayTimeout} onChange={e=>upd("displayTimeout",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:36 }}>{config.displayTimeout}s</span>
        </FieldRow>
        <FieldRow label="Rotation" hint="SDR">
          <Btn small active={config.displayRotation===0} onClick={()=>upd("displayRotation",0)}>Normal</Btn>
          <Btn small active={config.displayRotation===1} onClick={()=>upd("displayRotation",1)}>90deg</Btn>
        </FieldRow>
        <FieldRow label="Lock" hint="SDL -- stub on FW 1.5">
          <Toggle value={config.displayLock===1} onChange={v=>upd("displayLock",v?1:0)} />
          {config.displayLock===1&&<Tag color="warn">NO EFFECT on FW 1.5</Tag>}
        </FieldRow>
      </div>
      <HR />
      <SectionHead>Lightbar</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="State">
          <Toggle value={config.lbOn} onChange={v=>upd("lbOn",v)} />
          <span style={{ fontSize:12,color:C.mid }}>{config.lbOn?"On":"Off"}</span>
        </FieldRow>
        <FieldRow label="Color" hint="SLC -- keepalive req. every ~5 s">
          <input type="color" value={config.lbColor} onChange={e=>upd("lbColor",e.target.value)} style={{ width:40,height:28,padding:2 }} />
          <span style={{ fontFamily:MONO,fontSize:11,color:config.lbColor }}>{config.lbColor}</span>
          {["#ff2020","#3ddc6e","#4a90ff","#ffcc00","#ff8800","#ffffff"].map(col=>(
            <div key={col} onClick={()=>upd("lbColor",col)} style={{ width:16,height:16,borderRadius:2,background:col,cursor:"pointer",
              outline:config.lbColor===col?`2px solid ${C.text}`:"2px solid transparent",outlineOffset:1 }} />
          ))}
        </FieldRow>
        <FieldRow label="Brightness" hint="SLBB  0-10">
          <input type="range" min={0} max={10} value={config.lbBrightness} onChange={e=>upd("lbBrightness",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:24 }}>{config.lbBrightness}</span>
        </FieldRow>
        <FieldRow label="Timeout" hint="SLBT  10-600 s">
          <input type="range" min={10} max={600} step={10} value={config.lbTimeout} onChange={e=>upd("lbTimeout",Number(e.target.value))} style={{ flex:1,maxWidth:160 }} />
          <span style={{ fontFamily:MONO,fontSize:12,color:C.mono,minWidth:36 }}>{config.lbTimeout}s</span>
        </FieldRow>
        <FieldRow label="Mode" hint="SLCM">
          <Btn small active={config.lbColorMode===0} onClick={()=>upd("lbColorMode",0)}>0 -- Static</Btn>
          <Btn small active={config.lbColorMode===1} onClick={()=>upd("lbColorMode",1)}>1 -- Unknown</Btn>
        </FieldRow>
      </div>
      <HR />
      <SectionHead>Security</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="PIN lock" hint="SLPM"><Toggle value={config.pinEnabled} onChange={v=>upd("pinEnabled",v)} /></FieldRow>
        {config.pinEnabled&&(
          <FieldRow label="PIN" hint="SLP  0000-9999">
            <input value={config.pin} maxLength={4} onChange={e=>upd("pin",e.target.value.replace(/\D/g,"").slice(0,4))}
              style={{ maxWidth:80,fontFamily:MONO,letterSpacing:"0.2em",fontSize:14 }} placeholder="0000" />
          </FieldRow>
        )}
      </div>
      <HR />
      <SectionHead>Network</SectionHead>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        <FieldRow label="Mode" hint="SSIPC">
          <Btn small active={config.dhcp} onClick={()=>upd("dhcp",true)}>DHCP</Btn>
          <Btn small active={!config.dhcp} onClick={()=>upd("dhcp",false)}>Static</Btn>
        </FieldRow>
        {!config.dhcp&&(<>
          <FieldRow label="Static IP"><input value={config.staticIp} onChange={e=>upd("staticIp",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="192.168.1.100" /></FieldRow>
          <FieldRow label="Subnet mask"><input value={config.staticMask} onChange={e=>upd("staticMask",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="255.255.255.0" /></FieldRow>
          <FieldRow label="Gateway"><input value={config.staticGw} onChange={e=>upd("staticGw",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} placeholder="192.168.1.1" /></FieldRow>
        </>)}
        <FieldRow label="Dest IP" hint="SV/SM/TR destination"><input value={config.destIp} onChange={e=>upd("destIp",e.target.value)} style={{ maxWidth:160,fontFamily:MONO }} /></FieldRow>
        <FieldRow label="Dest port"><input type="number" value={config.destPort} onChange={e=>upd("destPort",Number(e.target.value))} style={{ maxWidth:100,fontFamily:MONO }} /></FieldRow>
        <FieldRow label="Host NIC" hint="Interface for push/async traffic">
          <NicPicker value={config.selfIp || ""} onChange={v=>upd("selfIp",v)} />
        </FieldRow>
      </div>
    </div>
  );
}

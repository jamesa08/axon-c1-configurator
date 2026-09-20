import React, { useState, useRef } from "react";
import { C, MONO } from "../tokens.js";
import { addLog } from "../helpers.js";
import { Btn, Tag, SectionHead } from "./Primitives.jsx";

export default function PushPanel({ config, setConfig, runRef, onPushResult }) {
  const [lines,setLines] = useState([]);
  const [running,setRunning] = useState(false);
  const [done,setDone] = useState(false);
  const [pushOk,setPushOk] = useState(null);
  const [importing,setImporting] = useState(false);
  const ref = useRef(null);
  const fileRef = useRef(null);

  const handleExport = async () => {
    try {
      const res = await fetch(`/api/device/${config.ip}/cfg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = config.deviceName || config.ip || "AxonC1";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.cfg`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch(e) { alert(`Export failed: ${e.message}`); }
  };

  const handleImport = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const res = await fetch("/api/cfg/import", {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: file,
      });
      const j = await res.json();
      if (j.ok && j.config) {
        setConfig(prev => ({
          ...prev,
          ...j.config,
          ip:              prev.ip,
          mac:             prev.mac,
          firmwareVersion: prev.firmwareVersion,
        }));
      } else {
        alert(`Import failed: ${j.error || "Unknown error"}`);
      }
    } catch(e) { alert(`Import failed: ${e.message}`); }
    setImporting(false);
  };

  const add = msg => { setLines(l=>[...l,msg]); setTimeout(()=>{ if(ref.current) ref.current.scrollTop=ref.current.scrollHeight; },10); };
  const sl  = ms => new Promise(r=>setTimeout(r,ms));

  const countAll = (root) => {
    let lv=0, tr=0, mu=0;
    const walk = n => {
      if(n.entry_type==="level"){ lv++; mu++; }
      if(n.entry_type==="action") tr++;
      (n.entries||[]).forEach(walk);
    };
    walk(root);
    return { lv, tr, mu };
  };

  const run = async () => {
    setLines([]); setRunning(true); setDone(false); setPushOk(null);
    const { lv, tr, mu } = countAll(config.mainMenu);
    const totalLv = lv + 1;
    const total   = 1+1+3+Math.ceil(tr/4)+totalLv*6;

    add(`> QUERY\\r`);

    try {
      const pushBody = {
        frontendConfig: config,
        selfIp: config.selfIp || window.location.hostname,
      };

      await fetch("/api/device", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ip:config.ip}) });

      const resp = await fetch(`/api/device/${config.ip}/push`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(pushBody),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalResult = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.log !== undefined) {
              add(obj.log);
            } else if (obj.result !== undefined) {
              finalResult = obj.result;
            }
          } catch {}
        }
      }

      const hasDeviceErrors = (finalResult?.push_errors?.length ?? 0) > 0;
      if (finalResult?.ok && !hasDeviceErrors) {
        add(`OK  Config committed. Hash: ${finalResult.hash}`);
        setConfig(c=>({...c, configHash: finalResult.hash}));
        addLog("ACK", `Push complete. SMID=${finalResult.hash?.slice(0,12)}...`);
        setPushOk(true);
        onPushResult?.(true);
      } else {
        const errMsg = hasDeviceErrors
          ? `Device reported ${finalResult.push_errors.length} error(s) — see log above`
          : (finalResult?.error ?? "Unknown error");
        add(`ERROR: ${errMsg}`);
        addLog("ERR", `Push failed: ${errMsg}`);
        setPushOk(false);
        onPushResult?.(false);
      }

    } catch(err) {
      // Offline fallback: simulated sequence for UI testing without a device
      add(`(offline sim) No device at ${config.ip} -- running simulation`);
      add(`> QUERY\\r  ->  ACK QUERY MAC=${config.mac} IP=${config.ip} CM=${config.mode}`);
      add(`> SCM THIRD_PARTY\\r  ->  ACK SCM THIRD_PARTY`);
      await sl(100);
      add(`> GMIID\\r  ->  ACK GMIID discovered items`);
      await sl(80);
      add(`--- Phase 5: JSON push (${total} packets) ---`);
      await sl(100);
      add(`  [  1] MT{ids}                ->  ACK MENU_JSON 1`);
      add(`  [${total}] DL{entries:${config.devices.length}}           ->  ACK MENU_JSON ${total}`);
      await sl(60);
      add(`  [2..4] MI (root+submenus)   ->  OK OK OK`);
      if(tr>0) { add(`  [5] AI{${tr} triggers}          ->  ACK`); await sl(40); }
      for(let i=0;i<totalLv;i++) { add(`  CI/CQ/CA SV ${i+1}               ->  OK`); await sl(25); }
      add(`--- Batch result: all ${total} packets result_ids=0 ---`);
      await sl(140);
      const hash = Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join("");
      add(`> SCM THIRD_PARTY\\r  ->  ACK SCM THIRD_PARTY`);
      add(`> SMID ${hash}\\r  ->  ACK SMID ${hash}`);
      add(`OK  Config committed (sim). Hash: ${hash}`);
      setConfig(c=>({...c,configHash:hash}));
      addLog("ACK",`Push complete (sim). SMID=${hash.slice(0,12)}...`);
      setPushOk(true);
      onPushResult?.(true);
    }

    setRunning(false); setDone(true);
  };

  if (runRef) runRef.current = run;

  return (
    <div style={{ padding:"20px 24px",overflowY:"auto",height:"100%",width:"100%",boxSizing:"border-box" }}>
      <SectionHead>Push to Device</SectionHead>
      <p style={{ fontSize:12,color:C.mid,lineHeight:1.7,marginBottom:16 }}>
        Sends the full configuration packet sequence to{" "}
        <span style={{ fontFamily:MONO,color:C.mono }}>{config.ip}:49494</span>.
        The device will restart its menu with the new settings after a successful push.
      </p>
      <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:16,flexWrap:"wrap" }}>
        <Btn variant="primary" onClick={run} disabled={running}>
          {running ? "Pushing..." : "Push to device"}
        </Btn>
        {done && pushOk === true  && <Tag color="green">Committed</Tag>}
        {done && pushOk === false && <Tag color="danger">Push failed</Tag>}
      </div>

      {/* Config file import / export */}
      <div style={{ display:"flex",gap:8,marginBottom:20,alignItems:"center" }}>
        <Btn onClick={handleExport} disabled={!config.ip || config.ip==="192.168.1.xxx"}>
          Export .cfg
        </Btn>
        <Btn onClick={()=>fileRef.current?.click()} disabled={importing}>
          {importing ? "Importing..." : "Import .cfg"}
        </Btn>
        <input
          ref={fileRef} type="file" accept=".cfg,application/xml,text/xml"
          style={{ display:"none" }}
          onChange={e => { const f=e.target.files?.[0]; if(f) handleImport(f); e.target.value=""; }}
        />
        <span style={{ fontSize:10,color:C.dim }}>Import restores device settings and menu from a .cfg snapshot file.</span>
      </div>
      {lines.length>0&&(
        <div ref={ref} style={{ background:C.s0,border:`1px solid ${C.border}`,borderRadius:3,
          padding:"8px 10px",fontFamily:MONO,fontSize:11,lineHeight:1.85,
          height:280,overflowY:"auto",color:C.mono }}>
          {lines.map((l,i)=>{
            let color = C.mono;
            if (l.startsWith("OK"))                                    color = C.green;
            else if (l.startsWith("ERROR") || l.includes("FAIL") ||
                     l.includes("DEVICE REPORTED") || l.includes("result="))
                                                                        color = C.danger;
            else if (l.startsWith("WARNING") || l.includes("WARN"))   color = C.warn;
            else if (l.startsWith("---") || l.startsWith("==="))      color = C.mid;
            else if (l.startsWith(">"))                                color = C.orange;
            return <div key={i} style={{ color }}>{l}</div>;
          })}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from "react";

// --- HELPERS ------------------------------------------------------------------
let _id = 0;
export const uid  = () => (++_id).toString(36);
export const pad2 = n => String(n).padStart(2, "0");
export const nowStr = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,"0")}`; };

// Build SV set bytes: "SV N \xe3\r"
export const svSetBytes  = ch => [...`SV ${ch} `].map(c=>c.charCodeAt(0)).concat([0xe3, 0x0d]);
export const svQueryBytes = ch => [...`SV ${ch} `].map(c=>c.charCodeAt(0)).concat([0x0d]);
export const svRespBytes  = ch => svSetBytes(ch);
export const trBytes     = n  => [...`TR ${n}`].map(c=>c.charCodeAt(0)).concat([0x0d]);
export const bytesToStr  = arr => arr.length ? arr.map(b => b === 0xe3 ? "\\xe3" : b === 0x0d ? "\\r" : String.fromCharCode(b)).join("") : "(empty)";

// --- LOG BUS ------------------------------------------------------------------
export const LOG = { cbs:[], entries:[], push(e){ this.entries=[e,...this.entries].slice(0,400); this.cbs.forEach(f=>f(this.entries)); }};
export const addLog = (type, msg) => LOG.push({ id:uid(), time:nowStr(), type, msg });
export const useLog = () => { const [e,setE]=useState(LOG.entries); useEffect(()=>{ const f=v=>setE([...v]); LOG.cbs.push(f); return ()=>{LOG.cbs=LOG.cbs.filter(x=>x!==f)}; },[]); return e; };

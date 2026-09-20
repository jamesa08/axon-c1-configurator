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
export const bytesToStr  = arr => arr.length ? arr.map(b => b === 0xe3 ? "\\xe3" : b === 0x0d ? "\\r" : b === 0x00 ? "\\x00" : String.fromCharCode(b)).join("") : "";
export const strToBytes  = str => {
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\") {
      const esc = str.slice(i, i + 4);
      if (/^\\x[0-9a-fA-F]{2}/.test(esc)) { out.push(parseInt(esc.slice(2), 16)); i += 4; continue; }
      if (str[i+1] === "r") { out.push(0x0d); i += 2; continue; }
      if (str[i+1] === "n") { out.push(0x0a); i += 2; continue; }
    }
    out.push(str.charCodeAt(i)); i++;
  }
  return out;
};

// --- LOG BUS ------------------------------------------------------------------
export const LOG = { cbs:[], entries:[], push(e){ this.entries=[e,...this.entries].slice(0,400); this.cbs.forEach(f=>f(this.entries)); }};
export const addLog = (type, msg) => LOG.push({ id:uid(), time:nowStr(), type, msg });
export const useLog = () => { const [e,setE]=useState(LOG.entries); useEffect(()=>{ const f=v=>setE([...v]); LOG.cbs.push(f); return ()=>{LOG.cbs=LOG.cbs.filter(x=>x!==f)}; },[]); return e; };

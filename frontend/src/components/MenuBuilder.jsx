import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { C, SANS } from "../tokens.js";
import { ChevronLeft, ChevronRight, RefreshCw, Play, ChevronUp, ChevronDown, SlidersHorizontal, FolderOpen } from "lucide-react";
import { Btn, Tag, FieldRow, HR, SectionHead } from "./Primitives.jsx";
import TreeItem from "./TreeItem.jsx";
import LevelConfigPanel from "./LevelConfigPanel.jsx";
import TriggerConfigPanel from "./TriggerConfigPanel.jsx";
import { mkLevelEntry, mkTriggerEntry, mkMenuEntry, mkStartupSync, mkStartupMacro } from "../defaultData.js";
import StartupSyncPanel from "./StartupSyncPanel.jsx";
import StartupMacroPanel from "./StartupMacroPanel.jsx";

function EditableTitle({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const ref = useRef(null);
  useEffect(() => { setVal(value); }, [value]);
  const commit = () => { setEditing(false); if (val.trim()) onChange(val.trim().slice(0,16)); else setVal(value); };
  const sharedStyle = { fontSize:14, fontWeight:600, fontFamily:SANS, lineHeight:"20px", height:20, display:"block" };
  return (
    <div style={{ height:20, position:"relative" }}>
      {editing
        ? <input ref={ref} autoFocus value={val}
            onChange={e => setVal(e.target.value.slice(0,16))}
            onBlur={commit}
            onKeyDown={e => { if(e.key==="Enter") commit(); if(e.key==="Escape"){ setEditing(false); setVal(value); }}}
            style={{ ...sharedStyle, color:C.text, background:"transparent", border:"none",
              borderBottom:`1px solid ${C.accent}`, outline:"none", padding:0, minWidth:60, width:"auto" }} />
        : <span style={{ ...sharedStyle, color:C.text, cursor:"text" }}
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename">{value}</span>
      }
    </div>
  );
}

export default function MenuBuilder({ config, setConfig, onSimCursorChange, simState, navState, navigate: navigate_ }) {
  const view    = navState?.view ?? "root";
  const navPath = navState?.path ?? [];

  const [selected, setSelected]       = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [editingName, setEditingName] = useState(null);
  const [nameVal, setNameVal]         = useState("");
  const [dragOver, setDragOver]       = useState(null);
  const dragSrc = useRef(null);

  const devices    = config.devices;
  const defaultDev = devices[0]?.name || "QSC";

  const resolveNode = useCallback((path, root) => {
    let node = root;
    for (const step of path) {
      const found = node.entries?.find(e => e.id === step.id);
      if (!found) return node;
      node = found;
    }
    return node;
  }, []);

  const currentNode = useMemo(() =>
    resolveNode(navPath, config.mainMenu),
    [navPath, config.mainMenu, resolveNode]);

  const updateNode = useCallback((root, targetId, updater) => {
    if (root.id === targetId) return updater(root);
    if (!root.entries) return root;
    return { ...root, entries: root.entries.map(e => updateNode(e, targetId, updater)) };
  }, []);

  const updateEntry = useCallback((entry) => {
    if (entry.id === config.volMuteScreen.id) {
      setConfig(c=>({ ...c, volMuteScreen: entry }));
    } else {
      setConfig(c=>({ ...c, mainMenu: updateNode(c.mainMenu, entry.id, ()=>entry) }));
    }
    setSelected(entry);
  }, [config.volMuteScreen.id, setConfig, updateNode]);

  const deleteEntry = useCallback((id, idsToDelete = null) => {
    const ids = idsToDelete ? new Set(idsToDelete) : new Set([id]);
    const removeFrom = (node) => {
      if (!node.entries) return node;
      return { ...node, entries: node.entries.filter(e=>!ids.has(e.id)).map(removeFrom) };
    };
    const currentEntries = currentNode.entries || [];
    if (ids.has(selected?.id)) {
      const remaining = currentEntries.filter(e => !ids.has(e.id));
      const deletedIdx = currentEntries.findIndex(e => ids.has(e.id));
      const neighbor = remaining[Math.min(deletedIdx, remaining.length - 1)] ?? null;
      setSelected(neighbor);
    }
    setSelectedIds(new Set());
    setConfig(c=>({ ...c, mainMenu: removeFrom(c.mainMenu) }));
  }, [currentNode, selected, setConfig]);

  const nextSVChannel = useCallback(() => {
    let count = 1;
    const walk = (node) => {
      if (node.entry_type==="level") count++;
      (node.entries||[]).forEach(walk);
    };
    walk(config.mainMenu);
    return count;
  }, [config.mainMenu]);

  const nextTrigNum = useCallback(() => {
    let max = 0;
    const walk = (node) => {
      if (node.entry_type==="action" && node.triggerNum) max = Math.max(max, node.triggerNum);
      (node.entries||[]).forEach(walk);
    };
    walk(config.mainMenu);
    return max+1;
  }, [config.mainMenu]);

  const addItem = (type) => {
    const nodeType = currentNode.entry_type || "menu";
    const limit = { menu:8, list:16, macro:16 }[nodeType] || 8;
    if ((currentNode.entries?.length || 0) >= limit) return;

    let newEntry;
    if (type === "menu")    newEntry = { ...mkMenuEntry("New Menu"), entry_type:"menu" };
    if (type === "list")    newEntry = { ...mkMenuEntry("New List"),  entry_type:"list" };
    if (type === "macro")   newEntry = { ...mkMenuEntry("New Macro"), entry_type:"macro" };
    if (type === "level")   { const ch=nextSVChannel(); newEntry = mkLevelEntry(`Channel ${ch}`, ch, defaultDev); }
    if (type === "trigger") { const n=nextTrigNum(); newEntry = mkTriggerEntry(`Trigger ${n}`, n, defaultDev); }
    if (!newEntry) return;

    const targetId = currentNode.id;
    setConfig(c=>({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node=>({ ...node, entries:[...(node.entries||[]),newEntry] }))
    }));
    setSelected(newEntry);
    const newIdx = (currentNode.entries?.length || 0);
    onSimCursorChange?.(newIdx);
  };

  const autoFill = (type, count) => {
    const nodeType = currentNode.entry_type || "menu";
    const limit    = { menu:8, list:16, macro:16 }[nodeType] || 8;
    const current  = currentNode.entries?.length || 0;
    const canAdd   = Math.min(count, limit - current);
    if (canAdd <= 0) return;

    const targetId = currentNode.id;
    const startCh  = nextSVChannel();
    const startTr  = nextTrigNum();
    const newEntries = [];
    for (let i = 0; i < canAdd; i++) {
      if (type === "level")   newEntries.push(mkLevelEntry(`G${startCh+i}`, startCh+i, defaultDev));
      if (type === "trigger") newEntries.push(mkTriggerEntry(`Entry - ${startTr+i}`, startTr+i, defaultDev));
    }
    setConfig(c=>({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node=>({ ...node, entries:[...(node.entries||[]),...newEntries] }))
    }));
  };

  const navigate = (entry) => {
    if (view === "root") {
      navigate_({ type:"MENU" });
    } else if (entry) {
      navigate_({ type:"PUSH", step:{ id:entry.id, label:entry.display_txt } });
    }
    setSelected(null);
  };

  const navBack = () => {
    navigate_({ type:"POP" });
    setSelected(null);
  };

  const navTo = (depthIdx) => {
    if (depthIdx < 0) navigate_({ type:"ROOT" });
    else navigate_({ type:"GOTO", path: navPath.slice(0, depthIdx) });
    setSelected(null);
  };

  const showRoot     = view === "root";
  const entries      = currentNode.entries || [];
  const currentDepth = view === "root" ? 0 : navPath.length + 1;

  useEffect(() => {
    setEditingName(null);
    if (showRoot) { setSelected(null); setSelectedIds(new Set()); return; }
    const ents = currentNode.entries || [];
    if (ents.length === 0) { setSelected(null); setSelectedIds(new Set()); return; }
    const currentBelongs = ents.some(e => e.id === selected?.id);
    if (!currentBelongs) {
      setSelected(ents[0]);
      setSelectedIds(new Set([ents[0].id]));
      onSimCursorChange?.(0);
    }
  }, [currentNode, showRoot]);

  const depthColors  = [C.accent, C.blue, C.green, C.warn];

  const simCursorEntry = (!showRoot && entries.length > 0)
    ? entries[simState?.cursorIdx ?? 0] ?? null
    : null;
  const effectiveSelected = selected ?? simCursorEntry;

  const startEdit = (e, entry) => { e.stopPropagation(); setEditingName(entry.id); setNameVal(entry.display_txt); };
  const commitEdit = (entry) => {
    updateEntry({ ...entry, display_txt: nameVal });
    setEditingName(null);
  };

  const selectOne = (entry, idx, e) => {
    if (e.shiftKey && selected) {
      const entries_ = currentNode.entries || [];
      const fromIdx = entries_.findIndex(en => en.id === selected.id);
      const toIdx   = idx;
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const range = new Set(entries_.slice(lo, hi + 1).map(en => en.id));
      setSelectedIds(range);
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(entry.id)) next.delete(entry.id);
        else next.add(entry.id);
        return next;
      });
      setSelected(entry);
    } else {
      setSelectedIds(new Set([entry.id]));
      setSelected(entry);
    }
  };

  const deleteSelected = () => {
    if (selectedIds.size > 1) {
      deleteEntry(null, [...selectedIds]);
    } else if (selected) {
      deleteEntry(selected.id);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "Escape") setSelectedIds(new Set());
      if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSelectedIds(new Set((currentNode.entries||[]).map(en=>en.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, selectedIds, currentNode]);

  // Count total menu IDs: every node in the tree (root container + D1 menus + leaves)
  const totalMenuIds = useMemo(() => {
    // Count IDs that come from the 64-slot pool.
    // System IDs (0xFFFF top-menu, 0xFFFE vol/mute, 0xFFFD sync, 0xFFFB macro) each consume 1 slot.
    // User content nodes (submenus, levels, actions) inside mainMenu.entries also each consume 1 slot.
    // The mainMenu root container itself IS 0xFFFF — counted separately below, not via walk.
    let count = 0;
    const walk = (node) => {
      count++;
      (node.entries || []).forEach(walk);
    };
    (config.mainMenu.entries || []).forEach(walk);  // user content only (excludes 0xFFFF root)
    count++;  // 0xFFFF top-menu always present
    if (config.volMuteEnabled) count++;             // 0xFFFE
    if (config.startupSyncEnabled) count++;         // 0xFFFD
    if (config.startupMacroEnabled) count++;        // 0xFFFB
    return count;
  }, [config.mainMenu, config.volMuteEnabled, config.startupSyncEnabled, config.startupMacroEnabled]);
  const ID_MAX = 64;
  const idWarning = totalMenuIds >= ID_MAX;
  const idCaution = totalMenuIds >= ID_MAX - 5;

  const reorder = (fromId, toId) => {
    if (fromId === toId) return;
    const targetId = currentNode.id;
    setConfig(c => ({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node => {
        const es   = [...(node.entries || [])];
        const fi   = es.findIndex(e => e.id === fromId);
        const ti   = es.findIndex(e => e.id === toId);
        if (fi < 0 || ti < 0) return node;
        const [item] = es.splice(fi, 1);
        es.splice(ti, 0, item);
        return { ...node, entries: es };
      }),
    }));
  };

  const move = (id, dir) => {
    const targetId = currentNode.id;
    setConfig(c => ({
      ...c,
      mainMenu: updateNode(c.mainMenu, targetId, node => {
        const arr = [...node.entries];
        const idx = arr.findIndex(e => e.id === id);
        if (idx < 0) return node;
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= arr.length) return node;
        [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
        return { ...node, entries: arr };
      })
    }));
  };

  return (
    <div style={{ display:"flex",height:"100%",gap:0 }}>
      {/* Tree pane */}
      <div style={{ width:320,flexShrink:0,display:"flex",flexDirection:"column",borderRight:`1px solid ${C.border}`,height:"100%",overflow:"hidden" }}>
        {/* Unified toolbar */}
        <div style={{ display:"flex", alignItems:"center", height:36, flexShrink:0, gap:0,
          background:"linear-gradient(to bottom,#f2f2f6 0%,#e6e6ec 100%)",
          borderBottom:`1px solid rgba(0,0,0,0.16)`,
          boxShadow:"inset 0 1px 0 rgba(255,255,255,0.7)",
        }}>
          <button onClick={navBack} disabled={showRoot} style={{
            padding:"0 12px", height:"100%", background:"transparent", border:"none",
            borderRight:`1px solid rgba(0,0,0,0.12)`,
            color:!showRoot?C.text:C.dim, cursor:!showRoot?"pointer":"not-allowed",
            fontFamily:SANS, fontSize:12, fontWeight:500, flexShrink:0,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}><ChevronLeft size={16} /></button>
          <div style={{ flex:1, padding:"0 12px", background:"transparent", display:"flex",
            alignItems:"center", gap:8, height:"100%", overflow:"hidden" }}>
            {!showRoot && navPath.length === 0 && editingName === "__mainmenu__" ? (
              <input autoFocus value={nameVal} onChange={e => setNameVal(e.target.value.slice(0,16))} maxLength={16}
                onBlur={() => { setConfig(c=>({...c,mainMenu:{...c.mainMenu,display_txt:nameVal}})); setEditingName(null); }}
                onKeyDown={e => {
                  if (e.key==="Enter") { setConfig(c=>({...c,mainMenu:{...c.mainMenu,display_txt:nameVal}})); setEditingName(null); }
                  if (e.key==="Escape") setEditingName(null);
                }}
                style={{ flex:1, background:"transparent", border:"none", outline:"none",
                  fontSize:12, fontWeight:600, color:C.text, fontFamily:SANS }}
              />
            ) : !showRoot && navPath.length > 0 && editingName === "__currentmenu__" ? (
              <input autoFocus value={nameVal} onChange={e => setNameVal(e.target.value.slice(0,16))} maxLength={16}
                onBlur={() => { updateEntry({...currentNode, display_txt: nameVal}); setEditingName(null); }}
                onKeyDown={e => {
                  if (e.key==="Enter") { updateEntry({...currentNode, display_txt: nameVal}); setEditingName(null); }
                  if (e.key==="Escape") setEditingName(null);
                }}
                style={{ flex:1, background:"transparent", border:"none", outline:"none",
                  fontSize:12, fontWeight:600, color:C.text, fontFamily:SANS }}
              />
            ) : (
              <span
                style={{ fontSize:12, fontWeight:600, color:C.text, overflow:"hidden",
                  textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1,
                  cursor: !showRoot ? "text" : "default" }}
                onDoubleClick={() => {
                  if (!showRoot && navPath.length === 0) {
                    setEditingName("__mainmenu__");
                    setNameVal(config.mainMenu.display_txt || "");
                  } else if (!showRoot && navPath.length > 0) {
                    setEditingName("__currentmenu__");
                    setNameVal(currentNode.display_txt || "");
                  }
                }}
              >
                {showRoot ? "Root" : navPath.length === 0 ? (config.mainMenu.display_txt || "") : navPath[navPath.length-1].label}
              </span>
            )}
            {/* Depth squares inline */}
            <div style={{ display:"flex", gap:5, flexShrink:0 }}>
              {[1,2,3,4].map(i => {
                const isLit = !showRoot && i === currentDepth;
                return (
                  <div key={i}
                    title={i===1?"Main menu":`Depth ${i}`}
                    onClick={() => {
                      if (i===1){ navigate_({type:"MENU"}); setSelected(null); }
                      else navTo(i-2);
                    }}
                    style={{
                      width:8, height:8, cursor:"pointer",
                      background: isLit ? depthColors[i-1] : C.s3,
                      border:`1px solid ${isLit ? depthColors[i-1] : C.borderHi}`,
                      transition:"background .12s",
                    }}
                  />
                );
              })}
            </div>
          </div>
          <button onClick={() => {
            if (!showRoot && navPath.length === 0) {
              setEditingName("__mainmenu__");
              setNameVal(config.mainMenu.display_txt || "");
            } else if (selected) {
              startEdit({stopPropagation:()=>{}}, selected);
            }
          }} style={{
            padding:"0 12px", height:"100%", background:"transparent", border:"none",
            borderLeft:`1px solid rgba(0,0,0,0.12)`,
            color:C.mid, cursor:"pointer", fontFamily:SANS, fontSize:11, flexShrink:0,
          }}>Edit</button>
        </div>

        {/* Entry list */}
        <div style={{ flex:1,overflowY:"auto" }}>
          {showRoot && (() => {
            const vmSel = effectiveSelected?.id === config.volMuteScreen.id;
            return (
              <div style={{
                display:"flex", alignItems:"center", height:34, width:"100%",
                background: vmSel ? C.accentDim : "#ffffff",
                cursor:"pointer", transition:"background .08s",
                borderBottom:`1px solid ${C.border}18`,
              }}
                onClick={()=>config.volMuteEnabled && setSelected(config.volMuteScreen)}
                onMouseEnter={e=>{ if(!vmSel) e.currentTarget.style.background=C.s2; }}
                onMouseLeave={e=>{ if(!vmSel) e.currentTarget.style.background="#ffffff"; }}
              >
                <span style={{ minWidth:32, paddingLeft:10, paddingRight:6 }}>
                  <input type="checkbox" checked={config.volMuteEnabled}
                    onClick={e=>e.stopPropagation()}
                    onChange={e=>{ e.stopPropagation(); const enabled = e.target.checked;
                      setConfig(c=>({
                        ...c,
                        volMuteEnabled: enabled,
                        simScreen: !enabled && c.simScreen === "volmute"
                          ? (c.menuEnabled ? "menu" : "menu")
                          : c.simScreen,
                      }));
                    }}
                    style={{ width:13,height:13,cursor:"pointer" }} />
                </span>
                <span style={{ color:C.blue, minWidth:18, display:"flex", alignItems:"center", justifyContent:"center" }}><SlidersHorizontal size={11} /></span>
                <span style={{ flex:1, fontSize:12, color:vmSel?C.accentHi: config.volMuteEnabled ? C.text : C.dim,
                  fontWeight:vmSel?500:400, paddingLeft:6, overflow:"hidden",
                  whiteSpace:"nowrap", textOverflow:"ellipsis" }}>Volume/Mute Screen</span>
              </div>
            );
          })()}
          {showRoot && (
            <div style={{
              display:"flex", alignItems:"center", height:34, width:"100%",
              background:"#f7f7f8", cursor:"pointer", transition:"background .08s",
              borderBottom:`1px solid ${C.border}22`,
            }}
              onClick={e=>{ if(config.menuEnabled) navigate(null); }}
              onMouseEnter={e=>{ e.currentTarget.style.background=C.s2; }}
              onMouseLeave={e=>{ e.currentTarget.style.background="#f7f7f8"; }}
            >
              <span style={{ minWidth:32, paddingLeft:10, paddingRight:6 }}>
                <input type="checkbox" checked={config.menuEnabled}
                  onClick={e=>e.stopPropagation()}
                  onChange={e=>{ e.stopPropagation(); const enabled = e.target.checked;
                    setConfig(c=>({
                      ...c,
                      menuEnabled: enabled,
                      simScreen: !enabled && (c.simScreen === "menu" || c.simScreen === "fader")
                        ? (c.volMuteEnabled ? "volmute" : "menu")
                        : c.simScreen,
                      simFaderEntry: !enabled ? null : c.simFaderEntry,
                    }));
                    if (!enabled) navigate_({ type:"ROOT" });
                  }}
                  style={{ width:13,height:13,cursor:"pointer" }} />
              </span>
              <span style={{ color:C.accent, minWidth:18, display:"flex", alignItems:"center", justifyContent:"center" }}><FolderOpen size={11} /></span>
              <span style={{ flex:1, fontSize:12, color:config.menuEnabled ? C.text : C.dim, paddingLeft:6,
                overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>Menu Screen(s)</span>
              <span style={{ color:C.dim, paddingRight:8, display:"flex", alignItems:"center" }}><ChevronRight size={13} /></span>
            </div>
          )}
          {showRoot && (() => {
            const syncEnabled = config.startupSyncEnabled ?? !!config.startupSync;
            const sel = effectiveSelected?.id === "__startupSync__";
            const sync = config.startupSync ?? mkStartupSync(config.devices[0]?.name || "");
            return (
              <div style={{
                display:"flex", alignItems:"center", height:34, width:"100%",
                background: sel ? `${C.blue}15` : "#ffffff",
                cursor:"pointer", transition:"background .08s",
                borderBottom:`1px solid ${C.border}18`,
              }}
                onClick={() => setSelected({ id:"__startupSync__", entry_type:"_startup_sync", ...sync })}
                onMouseEnter={e=>{ if(!sel) e.currentTarget.style.background=C.s2; }}
                onMouseLeave={e=>{ if(!sel) e.currentTarget.style.background="#ffffff"; }}
              >
                <span style={{ minWidth:32, paddingLeft:10, paddingRight:6 }}>
                  <input type="checkbox" checked={syncEnabled}
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                      e.stopPropagation();
                      setConfig(c => ({
                        ...c,
                        startupSyncEnabled: e.target.checked,
                        startupSync: c.startupSync ?? mkStartupSync(c.devices[0]?.name || ""),
                      }));
                    }}
                    style={{ width:13, height:13, cursor:"pointer" }} />
                </span>
                <span style={{ color:C.blue, minWidth:18, display:"flex", alignItems:"center", justifyContent:"center" }}><RefreshCw size={11} /></span>
                <span style={{ flex:1, fontSize:12, color:syncEnabled ? C.text : C.dim, paddingLeft:6,
                  overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
                  Startup Synchronization
                </span>
              </div>
            );
          })()}
          {showRoot && (() => {
            const macroEnabled = config.startupMacroEnabled ?? !!config.startupMacro;
            const sel = effectiveSelected?.id === "__startupMacro__";
            const macro = config.startupMacro ?? mkStartupMacro(config.devices[0]?.name || "");
            return (
              <div style={{
                display:"flex", alignItems:"center", height:34, width:"100%",
                background: sel ? `${C.blue}15` : "#f7f7f8",
                cursor:"pointer", transition:"background .08s",
                borderBottom:`1px solid ${C.border}18`,
              }}
                onClick={() => setSelected({ id:"__startupMacro__", entry_type:"_startup_macro", ...macro })}
                onMouseEnter={e=>{ if(!sel) e.currentTarget.style.background=C.s2; }}
                onMouseLeave={e=>{ if(!sel) e.currentTarget.style.background="#f7f7f8"; }}
              >
                <span style={{ minWidth:32, paddingLeft:10, paddingRight:6 }}>
                  <input type="checkbox" checked={macroEnabled}
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                      e.stopPropagation();
                      setConfig(c => ({
                        ...c,
                        startupMacroEnabled: e.target.checked,
                        startupMacro: c.startupMacro ?? mkStartupMacro(c.devices[0]?.name || ""),
                      }));
                    }}
                    style={{ width:13, height:13, cursor:"pointer" }} />
                </span>
                <span style={{ color:C.blue, minWidth:18, display:"flex", alignItems:"center", justifyContent:"center" }}><Play size={11} /></span>
                <span style={{ flex:1, fontSize:12, color:macroEnabled ? C.text : C.dim, paddingLeft:6,
                  overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
                  Initialization Macro
                </span>
              </div>
            );
          })()}
          {!showRoot && entries.map((entry,i)=>{
            const isSelected   = selectedIds.has(entry.id) || effectiveSelected?.id === entry.id;
            const isDropTarget = dragOver === entry.id;
            return (
            <div key={entry.id}
              draggable
              onDragStart={e => { dragSrc.current = entry.id; e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={e  => { e.preventDefault(); setDragOver(entry.id); }}
              onDragLeave={()=> setDragOver(null)}
              onDrop={e      => { e.preventDefault(); setDragOver(null); if(dragSrc.current) reorder(dragSrc.current, entry.id); dragSrc.current=null; }}
              onDragEnd={()  => { setDragOver(null); dragSrc.current=null; }}
              onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.background=C.s2; }}
              onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.background=isSelected?C.accentDim:i%2===0?"#ffffff":"#f7f7f8"; }}
              style={{
                borderBottom:`1px solid ${C.border}11`,
                borderTop: isDropTarget ? `2px solid ${C.accent}` : "2px solid transparent",
                background: isSelected ? C.accentDim : i%2===0 ? "#ffffff" : "#f7f7f8",
                transition:"background .07s",
              }}>
              {editingName===entry.id ? (
                <div style={{ padding:"4px 8px",display:"flex",gap:6 }}>
                  <input autoFocus value={nameVal} onChange={e=>setNameVal(e.target.value.slice(0,16))} maxLength={16}
                    onBlur={()=>commitEdit(entry)} onKeyDown={e=>{ if(e.key==="Enter")commitEdit(entry); if(e.key==="Escape")setEditingName(null); }}
                    style={{ flex:1,height:24 }} />
                </div>
              ) : (
                <div style={{ display:"flex",alignItems:"center",position:"relative" }}
                  onDoubleClick={e=>{ if(entry.entry_type!=="menu") startEdit(e,entry); }}
                  onClick={e=>{ selectOne(entry,i,e); onSimCursorChange?.(i); }}>
                  <div style={{ width:14, flexShrink:0, display:"flex", flexDirection:"column",
                    gap:2, alignItems:"center", paddingLeft:4, cursor:"grab", opacity:.35 }}
                    onMouseDown={e=>e.stopPropagation()}>
                    {[0,1].map(r=><div key={r} style={{ display:"flex",gap:1.5 }}>
                      {[0,1].map(c=><div key={c} style={{ width:2,height:2,background:C.mid }}/>)}
                    </div>)}
                  </div>
                  <TreeItem entry={entry} index={i} selected={effectiveSelected}
                    onSelect={(e) => { selectOne(e,i,{metaKey:false,ctrlKey:false,shiftKey:false}); }}
                    onNavigate={navigate} />
                  {effectiveSelected?.id===entry.id && selectedIds.size <= 1 && (
                    <div style={{ position:"absolute",right:28,display:"flex",gap:2 }}>
                      <button onClick={e=>{e.stopPropagation();move(entry.id,-1);}} style={{ background:C.s3,border:"none",color:C.mid,width:18,height:18,borderRadius:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><ChevronUp size={11} /></button>
                      <button onClick={e=>{e.stopPropagation();move(entry.id, 1);}} style={{ background:C.s3,border:"none",color:C.mid,width:18,height:18,borderRadius:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><ChevronDown size={11} /></button>
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
          {!showRoot && entries.length===0 && (
            <div style={{ padding:"20px 12px",fontSize:12,color:C.dim,textAlign:"center" }}>
              Empty menu. Add items below.
            </div>
          )}
        </div>

        {/* Add buttons */}
        {(() => {
          const nodeType = view === "root" ? "root"
            : (currentNode.entry_type || "menu");
          const LIMITS = { menu: 8, list: 16, macro: 16 };
          const limit  = LIMITS[nodeType] || 8;
          const count  = entries.length;
          const atLimit = !showRoot && count >= limit;
          const canAddMenu    = !showRoot && nodeType === "menu" && currentDepth < 4;
          const canAddLevel   = !showRoot && nodeType === "menu";
          const canAddTrigger = !showRoot && (nodeType === "menu" || nodeType === "list" || nodeType === "macro");
          const canAddList    = !showRoot && nodeType === "menu" && currentDepth < 4;
          const canAddMacro   = !showRoot && nodeType === "menu" && currentDepth < 4;

          const limitTag = atLimit ? (
            <span style={{ fontSize:11, color:C.warn }}>
              {count}/{limit} max
            </span>
          ) : count > 0 ? (
            <span style={{ fontSize:11, color:C.dim }}>
              {count}/{limit}
            </span>
          ) : null;

          return (
            <div style={{ borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
              {/* ID budget counter */}
              <div style={{
                padding:"4px 12px", borderBottom:`1px solid ${C.border}`,
                display:"flex", alignItems:"center", gap:6,
              }}>
                <span style={{ fontSize:11, color:C.dim, flex:1 }}>Menu IDs</span>
                <span style={{
                  fontSize:11,
                  color: idWarning ? C.warn : idCaution ? C.orange : C.dim,
                  fontWeight: idCaution ? 600 : 400,
                }}>
                  {totalMenuIds}/{ID_MAX}
                </span>
                {idWarning && (
                  <span style={{ fontSize:11, color:C.warn, fontWeight:600 }}>LIMIT</span>
                )}
                <div style={{
                  width:60, height:6, borderRadius:100,
                  background:"linear-gradient(to bottom,#eee,#fff)",
                  border:"1px solid #ccc",
                  boxShadow:"inset 0 1px 2px #0002",
                  overflow:"hidden", position:"relative",
                }}>
                  <div style={{
                    position:"absolute", top:0, left:0, bottom:0,
                    width:`${Math.min(100, (totalMenuIds/ID_MAX)*100)}%`,
                    background: idWarning
                      ? "linear-gradient(to bottom,#f88 10%,#fff2 20%,#f88 30%,#faa)"
                      : idCaution
                      ? "linear-gradient(to bottom,#fb8 10%,#fff2 20%,#fb8 30%,#fca)"
                      : "linear-gradient(to bottom,#6af 10%,#fff2 20%,#6af 30%,#9ef)",
                    borderRadius:100,
                    transition:"width .2s",
                  }} />
                </div>
              </div>
              <div style={{ padding:"8px 12px 6px", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ fontSize:11, color:C.dim, letterSpacing:"0.04em",
                  marginBottom:6 }}>Containers</div>
                <div style={{ display:"flex", gap:4 }}>
                  <Btn small onClick={()=>addItem("menu")}
                    disabled={!canAddMenu || atLimit} style={{ flex:1 }}>
                    Menu
                  </Btn>
                  <Btn small onClick={()=>addItem("list")}
                    disabled={!canAddList || atLimit} style={{ flex:1 }}>
                    List
                  </Btn>
                  <Btn small onClick={()=>addItem("macro")}
                    disabled={!canAddMacro || atLimit} style={{ flex:1 }}>
                    Macro
                  </Btn>
                </div>
              </div>
              <div style={{ padding:"8px 12px 6px", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ display:"flex", alignItems:"center", marginBottom:6 }}>
                  <span style={{ fontSize:11, color:C.dim, letterSpacing:"0.04em",
                    flex:1 }}>Actions</span>
                  {limitTag}
                </div>
                <div style={{ display:"flex", gap:4 }}>
                  <Btn small onClick={()=>addItem("trigger")}
                    disabled={!canAddTrigger || atLimit}
                    variant={selected?.entry_type==="action"?"primary":"default"}
                    style={{ flex:1 }}>
                    Trigger
                  </Btn>
                  <Btn small onClick={()=>addItem("level")}
                    disabled={!canAddLevel || atLimit}
                    variant={selected?.entry_type==="level"?"primary":"default"}
                    style={{ flex:1 }}>
                    Level
                  </Btn>
                </div>
              </div>
              {!showRoot && (nodeType === "menu" || nodeType === "list" || nodeType === "macro") && (
                <div style={{ padding:"6px 12px 8px", display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
                  <span style={{ fontSize:11, color:C.dim, marginRight:2, flexShrink:0 }}>Fill:</span>
                  {nodeType === "menu" && (
                    <>
                      <Btn small variant="ghost"
                        disabled={atLimit}
                        onClick={()=>autoFill("level", Math.min(8, limit-count))}>
                        +8 Lvl
                      </Btn>
                      <Btn small variant="ghost"
                        disabled={atLimit}
                        onClick={()=>autoFill("trigger", Math.min(8, limit-count))}>
                        +8 Tr
                      </Btn>
                    </>
                  )}
                  {(nodeType === "list" || nodeType === "macro") && (
                    <Btn small variant="ghost"
                      disabled={atLimit}
                      onClick={()=>autoFill("trigger", Math.min(16, limit-count))}>
                      +{Math.min(16, limit-count)} Triggers
                    </Btn>
                  )}
                  {(selected || selectedIds.size > 0) && (
                    <Btn small variant="danger"
                      style={{ marginLeft:"auto" }}
                      onClick={deleteSelected}>
                      {selectedIds.size > 1 ? `Remove ${selectedIds.size}` : "Remove"}
                    </Btn>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Config panel */}
      <div style={{ flex:1,padding:"14px 16px",overflowY:"auto",height:"100%",position:"relative",background:C.s1stripe }}>
        {selected && (() => {
          const typeLabel =
            selected.entry_type === "level" ? "level" :
            selected.entry_type === "action" ? "trigger" :
            selected.entry_type === "menu" ? "menu" :
            selected.entry_type === "_startup_sync" ? "sync" :
            selected.entry_type === "_startup_macro" ? "macro" :
            selected.id === config.volMuteScreen?.id ? "level" : null;
          return typeLabel ? (
            <div style={{
              position:"absolute", right:8, top:8,
              pointerEvents:"none", overflow:"hidden",
              lineHeight:1, zIndex:0,
            }}>
              <span style={{
                fontSize:90, fontWeight:100, fontStyle:"italic",
                color:C.border, opacity:0.5, lineHeight:1,
                userSelect:"none", whiteSpace:"nowrap", display:"block", height:100,
              }}>{typeLabel}</span>
            </div>
          ) : null;
        })()}
        <div style={{ position:"relative", zIndex:1 }}>
        {!selected && (
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:C.dim,fontSize:12 }}>
            Select an item to configure it.
          </div>
        )}
        {selected?.entry_type==="level" && selected?.id!==config.volMuteScreen.id && (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:22 }}>
              <EditableTitle value={selected.display_txt} onChange={v=>updateEntry({...selected,display_txt:v})} />
            </div>
            <LevelConfigPanel entry={selected} devices={devices} onChange={updateEntry} />
          </>
        )}
        {selected?.entry_type==="action" && (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:22 }}>
              <EditableTitle value={selected.display_txt} onChange={v=>updateEntry({...selected,display_txt:v})} />
            </div>
            <TriggerConfigPanel entry={selected} devices={devices} onChange={updateEntry} />
          </>
        )}
        {selected?.entry_type==="menu" && (
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:34 }}>
              <EditableTitle value={selected.display_txt} onChange={v=>updateEntry({...selected,display_txt:v})} />
            </div>
            <SectionHead />
            <FieldRow label="Children" style={{ alignItems:"baseline" }}><span style={{ fontSize:12, color:C.dim }}>{selected.entries?.length||0} items</span></FieldRow>
            <HR />
            <Btn onClick={()=>navigate(selected)}>Open in builder</Btn>
          </div>
        )}
        {selected?.entry_type==="_startup_sync" && (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:22 }}>
              <span style={{ fontSize:14, fontWeight:600, color:C.text }}>Startup Synchronization</span>
            </div>
            <StartupSyncPanel
              sync={config.startupSync ?? { ...selected }}
              devices={devices}
              onChange={v => setConfig(c => ({ ...c, startupSync: v }))}
            />
          </>
        )}
        {selected?.entry_type==="_startup_macro" && (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:22 }}>
              <span style={{ fontSize:14, fontWeight:600, color:C.text }}>Initialization Macro</span>
            </div>
            <StartupMacroPanel
              macro={config.startupMacro ?? { ...selected }}
              devices={devices}
              onChange={v => setConfig(c => ({ ...c, startupMacro: v }))}
            />
          </>
        )}
        {selected?.id===config.volMuteScreen.id && (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:22 }}>
              <EditableTitle value={selected.display_txt} onChange={v=>updateEntry({...selected,display_txt:v})} />
            </div>
            <LevelConfigPanel entry={selected} devices={devices} onChange={updateEntry} />
          </>
        )}
        </div>
      </div>
    </div>
  );
}

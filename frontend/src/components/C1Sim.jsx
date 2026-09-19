import React, { useState, useEffect, useRef, useCallback } from "react";
import { C, MONO } from "../tokens.js";
import { addLog } from "../helpers.js";

export default function C1Sim({ config, simNavPath, simState, onSimStateChange, onBuilderNav, setConfig }) {
  const { simVol, simScreen, mainMenu, volMuteScreen, volMuteEnabled, menuEnabled } = config;

  const isBuilderAtRoot = simNavPath === null;
  const navPath         = simNavPath || [];
  const cursorIdx       = simState?.cursorIdx ?? 0;
  const scrollOffset    = simState?.scrollOffset ?? 0;

  const volStr = v => v > 0 ? `+${v}` : `${v}`;

  const resolveMenu = useCallback((path) => {
    let node = mainMenu;
    for (const step of path) {
      const found = node.entries?.find(e => e.id === step.id);
      if (!found) return node;
      node = found;
    }
    return node;
  }, [mainMenu]);

  const currentMenu = resolveMenu(navPath);
  const allEntries  = currentMenu?.entries || [];
  const totalItems  = allEntries.length;

  const clampedScroll = Math.min(Math.max(0, scrollOffset), Math.max(0, totalItems - 4));
  const windowEntries = allEntries.slice(clampedScroll, clampedScroll + 4);
  const canScrollUp   = clampedScroll > 0;
  const canScrollDown = clampedScroll + 4 < totalItems;

  // -- KNOB drag --------------------------------------------------------------
  const knobDrag = useRef({ active: false, lastY: 0, accumulated: 0 });

  const onKnobMouseDown = useCallback((e) => {
    e.preventDefault();
    knobDrag.current = { active: true, lastY: e.clientY, accumulated: 0 };
  }, []);

  useEffect(() => {
    const STEP_PX = 12;
    const onMouseMove = (e) => {
      if (!knobDrag.current.active) return;
      const delta = e.clientY - knobDrag.current.lastY;
      knobDrag.current.lastY = e.clientY;
      knobDrag.current.accumulated += delta;

      if (simScreen === "menu" || isBuilderAtRoot) {
        const steps = Math.round(knobDrag.current.accumulated / STEP_PX);
        if (Math.abs(steps) >= 1) {
          knobDrag.current.accumulated = 0;
          onSimStateChange(s => {
            const next = Math.max(0, Math.min(totalItems - 1, (s.cursorIdx ?? 0) + steps));
            const newScr = next < s.scrollOffset ? next
              : next >= s.scrollOffset + 4 ? next - 3
              : s.scrollOffset;
            return { ...s, cursorIdx: next, scrollOffset: Math.max(0, newScr) };
          });
        }
      } else {
        // volmute or fader: drag changes volume (up = louder)
        const steps = -Math.round(knobDrag.current.accumulated / 2);
        if (Math.abs(steps) >= 1) {
          knobDrag.current.accumulated = 0;
          setConfig(c => {
            if (c.simScreen === "fader" && c.simFaderEntry) {
              // Control the per-channel fader, not the zone master
              const entry   = c.simFaderEntry;
              const min     = entry.level_vol?.minParam ?? -100;
              const max     = entry.level_vol?.maxParam ?? 20;
              const step    = entry.level_vol?.stepSize ?? 2;
              const cur     = c.simChannelVols?.[entry.id] ?? min;
              const nv      = Math.max(min, Math.min(max, Math.round((cur + steps) / step) * step));
              const svCh    = entry.level_vol?.channel ?? 2;
              addLog("SV", `SV ${svCh} ${nv}  (${entry.display_txt})`);
              return { ...c, simChannelVols: { ...c.simChannelVols, [entry.id]: nv } };
            } else {
              // Zone master (volmute screen)
              const nv = Math.max(-100, Math.min(20, c.simVol + steps));
              addLog("SV", `SV 1 ${nv}`);
              return { ...c, simVol: nv };
            }
          });
        }
      }
    };
    const onMouseUp = () => { knobDrag.current.active = false; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  }, [simScreen, isBuilderAtRoot, totalItems, onSimStateChange, setConfig]);

  // -- LIGHTBAR FLASH (3 flashes, 0.5s apart) -------------------------------
  const flashLightbar = useCallback(() => {
    // Explicit timed sequence: off->on->off->on->off->on (3 flashes)
    const T = 250; // ms each half-cycle
    setConfig(c => ({ ...c, lbOn: false }));
    setTimeout(() => setConfig(c => ({ ...c, lbOn: true  })), T * 1);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: false })), T * 2);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: true  })), T * 3);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: false })), T * 4);
    setTimeout(() => setConfig(c => ({ ...c, lbOn: true  })), T * 5);
  }, [setConfig]);

  const fireTrigger = useCallback((entry) => {
    addLog("TR", `TR ${entry.triggerNum}  (${entry.display_txt})`);
    flashLightbar();
  }, [flashLightbar]);

  const onKnobClick = useCallback(() => {
    if (simScreen === "fader") {
      setConfig(c => ({ ...c, simScreen: "menu", simFaderEntry: null }));
      return;
    }
    if (simScreen === "volmute") return;
    if (!menuEnabled) return; // menu not enabled, knob does nothing
    const entry = allEntries[cursorIdx];
    if (!entry) return;
    if (entry.entry_type === "menu" || entry.entry_type === "list" || entry.entry_type === "macro") {
      onBuilderNav({ type:"PUSH", step:{ id: entry.id, label: entry.display_txt } });
    } else if (entry.entry_type === "level") {
      setConfig(c => ({ ...c, simScreen: "fader", simFaderEntry: entry }));
    } else if (entry.entry_type === "action") {
      fireTrigger(entry);
    }
  }, [simScreen, menuEnabled, allEntries, cursorIdx, navPath, onBuilderNav, setConfig, fireTrigger]);

  // -- SIDE BUTTON (back) -----------------------------------------------------
  const onSideButton = useCallback(() => {
    if (simScreen === "fader") {
      setConfig(c => ({ ...c, simScreen: "menu", simFaderEntry: null }));
      return;
    }
    if (simScreen === "volmute") {
      // Can only go to menu if it's enabled
      if (menuEnabled) setConfig(c => ({ ...c, simScreen: "menu" }));
      return;
    }
    // Menu screen: go back one level, or at root toggle to volmute
    if (navPath.length > 0) {
      onBuilderNav({ type:"POP" });
    } else if (volMuteEnabled) {
      // At MAIN MENU root: toggle to Vol/Mute only if it's enabled
      setConfig(c => ({ ...c, simScreen: "volmute" }));
    }
    // If volmute not enabled, side button at root does nothing
  }, [simScreen, navPath, volMuteEnabled, menuEnabled, onBuilderNav, setConfig]);

  // -- DEPTH SQUARES ----------------------------------------------------------
  const DepthSquares = () => {
    const slots = [];
    if (volMuteEnabled) slots.push("volmute");
    if (menuEnabled) {
      slots.push("menu0"); // MAIN MENU
      slots.push("menu1"); // depth 1 submenu
      slots.push("menu2"); // depth 2+ submenu
    }
    const visible = slots.slice(0, 3);

    const activeSlot = (() => {
      if (simScreen === "volmute") return slots.indexOf("volmute");
      if (simScreen === "menu" || simScreen === "fader") {
        const depth = navPath.length;
        if (depth === 0) return slots.indexOf("menu0");
        if (depth === 1) return slots.indexOf("menu1");
        return slots.indexOf("menu2");
      }
      return -1;
    })();

    return (
      <div style={{ display:"flex", justifyContent:"space-evenly", width:"100%", padding:"0 14px", marginTop:2 }}>
        {visible.map((slot, i) => (
          <span key={i} style={{
            width:9, height:9, display:"inline-block",
            border:`1px solid ${C.lcd}`,
            background: i === activeSlot ? C.lcd : "transparent",
          }} />
        ))}
      </div>
    );
  };

  // -- LCD --------------------------------------------------------------------
  const lcd = (() => {
    const faderEntry  = config.simFaderEntry;
    const activeFaderVol = (simScreen === "fader" && faderEntry)
      ? (config.simChannelVols?.[faderEntry.id] ?? faderEntry.level_vol?.minParam ?? -100)
      : simVol;
    const faderMin = (simScreen === "fader" && faderEntry) ? (faderEntry.level_vol?.minParam ?? -100) : -100;
    const faderMax = (simScreen === "fader" && faderEntry) ? (faderEntry.level_vol?.maxParam ?? 20)   : 20;
    const pct = ((activeFaderVol - faderMin) / (faderMax - faderMin)) * 100;

    // VOL/MUTE SCREEN -- full-screen independent root screen
    if (simScreen === "volmute") {
      const title = volMuteScreen.display_txt || "Zone Name";
      return (
        <div style={{ display:"flex", flexDirection:"column", width:"100%", height:"100%", color:C.lcd, fontFamily:MONO, fontSize:10 }}>
          <div style={{ textAlign:"center", flexShrink:0, lineHeight:1.35 }}>
            <div style={{ overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>{title}</div>
            <DepthSquares />
          </div>
          <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
          <div style={{ flex:1, overflow:"hidden", minHeight:0, display:"flex", justifyContent:"center", alignItems:"stretch", padding:"3px 0" }}>
            <div style={{ width:18, border:`1px solid ${C.lcd}`, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
              <div style={{ height:"100%", background:C.lcd, transformOrigin:"bottom", transform:`scaleY(${pct/100})`, transition:"transform .08s" }} />
            </div>
          </div>
          <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
          <div style={{ color:C.lcd, textAlign:"center", fontSize:10, fontFamily:MONO, flexShrink:0, lineHeight:1.5 }}>
            {volStr(simVol)}
          </div>
        </div>
      );
    }

    const titleTxt = navPath.length === 0
      ? "MAIN MENU"
      : (currentMenu?.display_txt || navPath[navPath.length-1]?.label || "MENU");

    const showFaderFooter = simScreen === "fader";

    return (
      <div style={{ display:"flex", flexDirection:"column", width:"100%", height:"100%", color:C.lcd, fontFamily:MONO, fontSize:10 }}>
        {/* Header */}
        <div style={{ textAlign:"center", flexShrink:0, lineHeight:1.35 }}>
          <div style={{ overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>{titleTxt}</div>
          <DepthSquares />
        </div>
        <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
        {/* 4 rows */}
        <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
          {Array.from({ length: 4 }).map((_, i) => {
            const e        = windowEntries[i];
            const absIdx   = clampedScroll + i;
            const isCursor = absIdx === cursorIdx && !!e;
            const isFirst  = i === 0;
            const isLast   = i === 3;
            const showUp   = isFirst && canScrollUp;
            const showDown = isLast  && canScrollDown;
            const isMenuType = e?.entry_type === "menu" || e?.entry_type === "list" || e?.entry_type === "macro";
            const isAction   = e?.entry_type === "action";
            return (
              <div key={i}
                onClick={() => {
                  if (showUp)        onSimStateChange(s => ({ ...s, scrollOffset: Math.max(0, (s.scrollOffset??0) - 1) }));
                  else if (showDown) onSimStateChange(s => ({ ...s, scrollOffset: Math.min(Math.max(0, totalItems-4), (s.scrollOffset??0) + 1) }));
                  else if (e)        onSimStateChange(s => ({ ...s, cursorIdx: absIdx }));
                }}
                style={{
                  flex:1, display:"flex", alignItems:"center", padding:"0 3px",
                  background: isCursor ? C.lcd : "transparent",
                  color:      isCursor ? "#000" : C.lcd,
                  borderBottom: i < 3 ? `1px solid ${C.lcd}` : "none",
                  cursor:"pointer", overflow:"hidden", minHeight:0,
                }}>
                {e ? (
                  <>
                    <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:9.5, lineHeight:1 }}>
                      {e.display_txt}
                    </span>
                    {showUp    && <span style={{ fontSize:8, flexShrink:0 }}>^</span>}
                    {showDown  && <span style={{ fontSize:8, flexShrink:0 }}>v</span>}
                    {!showUp && !showDown && isMenuType && <span style={{ fontSize:7, flexShrink:0 }}>{'>'}</span>}
                    {!showUp && !showDown && isAction   && <span style={{ fontSize:7, flexShrink:0 }}>!</span>}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
        <div style={{ height:1, background:C.lcd, flexShrink:0, margin:"1px 0" }} />
        {/* Footer: vol number normally, horizontal fader when a level is active */}
        {showFaderFooter ? (
          <div style={{ flexShrink:0, height:13, display:"flex", alignItems:"center", padding:"0 10px" }}>
            <div style={{ flex:1, height:9, border:`1px solid ${C.lcd}`, position:"relative", overflow:"hidden" }}>
              <div style={{ position:"absolute", inset:0, background:C.lcd, transformOrigin:"left", transform:`scaleX(${pct/100})`, transition:"transform .08s" }} />
            </div>
          </div>
        ) : (
          <div style={{ color:C.lcd, textAlign:"center", fontSize:10, fontFamily:MONO,
            flexShrink:0, height:13, display:"flex", alignItems:"center", justifyContent:"center" }}>
            {volStr(activeFaderVol)}
          </div>
        )}
      </div>
    );
  })();

  const lbColor = config.lbOn ? config.lbColor : null;

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
      <div style={{
        width:210, height:340,
        background:"linear-gradient(155deg,#2a2a2a 0%,#1e1e1e 60%,#181818 100%)",
        borderRadius:9,
        boxShadow:"0 2px 4px rgba(0,0,0,.5),0 16px 48px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,0.06)",
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <div style={{
          width:152, borderRadius:5,
          background:"linear-gradient(155deg,#282828 0%,#222 50%,#1e1e1e 100%)",
          border:"1px solid #333", boxShadow:"inset 0 1px 3px rgba(0,0,0,0.5)",
          display:"flex", flexDirection:"column", alignItems:"center", padding:"14px 0 12px",
        }}>
          <div style={{ background:"linear-gradient(150deg,#111 0%,#0a0a0a 100%)", borderRadius:3, boxShadow:"inset 0 1px 3px rgba(0,0,0,.6)" }}>
            <div style={{ width:122, height:122, background:C.lcdBg, padding:"5px 4px", display:"flex", flexDirection:"column", overflow:"hidden" }}>
              {lcd}
            </div>
          </div>
          <div style={{ position:"relative", width:"100%", display:"flex", justifyContent:"center", alignItems:"flex-end", marginTop:24 }}>
            <div
              onMouseDown={onKnobMouseDown}
              onClick={onKnobClick}
              style={{
                width:58, height:58, borderRadius:"50%",
                background:"radial-gradient(circle at 33% 28%,#3a3a3a 0%,#252525 55%,#1c1c1c 100%)",
                border:"1px solid #444",
                boxShadow:"0 3px 8px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,0.06)",
                position:"relative", cursor:"ns-resize", userSelect:"none",
              }}
              title="Drag to navigate / change volume. Click to enter."
            >
              <div style={{ position:"absolute", top:8, left:"50%", transform:"translateX(-50%)", width:3, height:3, borderRadius:"50%", background:"#666" }} />
            </div>
            <div
              onClick={onSideButton}
              title="Back"
              style={{
                position:"absolute", right:12, bottom:7, width:13, height:13, borderRadius:"50%",
                background:"radial-gradient(circle at 35% 30%,#333 0%,#222 100%)",
                border:"1px solid #444", cursor:"pointer",
              }}
            />
          </div>
          <div style={{
            width:82, height:8, borderRadius:99, marginTop:18, flexShrink:0,
            background: lbColor ? lbColor : "#1a1a1a",
            border: `1px solid ${lbColor ? lbColor : "#333"}`,
            boxShadow: lbColor ? `0 0 6px 1px ${lbColor}88,0 0 14px 2px ${lbColor}44` : "none",
            transition:"background .1s,box-shadow .1s",
          }} />
        </div>
      </div>
    </div>
  );
}

import { uid, trBytes } from "./helpers.js";

// --- DEFAULT DATA -------------------------------------------------------------
export const mkDevice = (name, ip, port, asyncPort) => ({ id:uid(), name, ip, port:port??49500, asyncIp:ip, asyncPort:asyncPort??49500, proto:"UDP", type:"general" });

export const mkLevelVol = (ch, devName) => ({
  setBytes:       [],
  queryBytes:     [],
  respQueryBytes: [],
  syncBytes:      [],
  minParam: -100, maxParam: 20, stepSize: 2, paramDecPts: 0,
  trimEnable: false, pollMs: 500,
  queryEnable: true, asyncEnable: true,
  ackEnable: false, headerText: "",
  levelPreStr: "", levelPostStr: "",
  setter_type: 1,  // 1=explicit
  set_dev_name: devName,
  footerEnable: 1,
  active:[], altActive:[], altInactive:[], inactive:[],
  asyncAltResponse:false, queryAltResponse:false, setAltResponse:false,
});

export const mkLevelMute = (devName) => ({
  setBytes:[], queryBytes:[], respQueryBytes:[], syncBytes:[],
  minParam:0, maxParam:0, stepSize:0, paramDecPts:0,
  trimEnable:false, pollMs:500,
  queryEnable:false, asyncEnable:false,
  ackEnable:false, headerText:"",
  levelPreStr:"", levelPostStr:"",
  setter_type:0,  // 0=stateless
  set_dev_name: devName,
  footerEnable: 0,
  active:[], altActive:[], altInactive:[], inactive:[],
  asyncAltResponse:false, queryAltResponse:false, setAltResponse:false,
});

export const mkLevelEntry = (name, ch, devName) => ({
  id: uid(), entry_type:"level",
  display_txt: name,
  binary: false,
  level_vol:  mkLevelVol(ch, devName),
  level_mute: mkLevelMute(devName),
});

export const mkTriggerEntry = (name, n, devName) => ({
  id: uid(), entry_type:"action",
  display_txt: name,
  binary: false,
  action_type: "3rd_party",
  bytes: trBytes(n),
  dev: devName,
  cr: true, lf: false,
  triggerNum: n,
});

export const mkMenuEntry = (name) => ({ id:uid(), entry_type:"menu", display_txt:name, entries:[] });

export const mkMacroAction = (devName = "") => ({
  id: uid(),
  name: "Action",
  dev: devName,
  bytes: [],
  cr: true,
  lf: false,
});

export const mkStartupMacro = (devName = "") => ({
  enabled: true,
  name: "Init Macro",
  actions: [mkMacroAction(devName)],
});

export const mkStartupSync = (devName = "") => ({
  enabled: true,
  name: "Sync Action",
  // Config tab
  destination: devName,
  hexValues: false,
  inactiveState: [],
  activeState: [],
  // Query tab
  queryEnable: false,
  queryInterval: 500,
  queryBytes: [],
  queryCr: true,
  queryLf: false,
  queryResponse: [],
  // Async tab
  asyncEnable: false,
  asyncIp: "",
  asyncPort: 49500,
  asyncType: "UDP",
  asyncSrcIp: "",
  asyncBytes: [],
  asyncCr: true,
  asyncLf: false,
});

export const mkDefaultConfig = () => {
  const volMuteScreen = mkLevelEntry("Vol/Mute Screen", 1, "");
  volMuteScreen._isRoot = true; // 0xFFFE

  const mainMenu = mkMenuEntry("MAIN MENU");

  return {
    volMuteEnabled: true,
    menuEnabled: true,
    volMuteScreen,
    mainMenu,
    devices: [],
    startupSyncEnabled: false,
    startupSync: null,
    startupMacroEnabled: false,
    startupMacro: null,
    // device settings
    deviceName: "AxonC1-000000",
    ip: "192.168.1.200",
    mac: "00:1c:e2:f0:9c:3a",
    firmwareVersion: "1.5.0",
    configHash: "NONE",
    mode: "THIRD_PARTY",
    displayBrightness: 7,
    displayTimeout: 60,
    displayRotation: 0,
    displayLock: 0,
    lbBrightness: 7,
    lbTimeout: 60,
    lbColor: "#ffffff",
    lbOn: true,
    lbColorMode: 0,
    pinEnabled: false,
    pin: "0000",
    dhcp: true,
    staticIp: "", staticMask: "", staticGw: "",
    destIp: "192.168.1.10",
    selfIp: "",   // host NIC to use for push (empty = auto-detect)
    destPort: 49500,
    // sim state
    simVol: -12,
    simMutes: {},
    simChannelVols: {}, // per-level-entry id -> current dB value
    simScreen: "menu", // "menu" | "volmute" | "fader"
    simFaderEntry: null, // the level entry currently being faded (for "fader" screen)
  };
};

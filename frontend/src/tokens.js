// --- TOKENS (macOS Aqua-inspired light/gray theme) ----------------------------
export const C = {
  // Surface stack — window body is light gray, chrome is slightly darker gray
  bg:        "#f5f5f7",   // window body (macOS light gray)
  s0:        "#e8e8ed",   // sidebar / chrome panels
  s1:        "#ffffff",   // content cards / input backgrounds
  s1stripe:  "repeating-linear-gradient(#fbfbfb, #fbfbfb 1px, #ffffff 1px, #ffffff 3px)",
  s2:        "#ebebef",   // hover state
  s3:        "#dcdce1",   // border-adjacent
  border:    "#d0d0d6",   // normal border
  borderHi:  "#b0b0bc",   // strong border / focus ring base

  // Text
  text:      "#1a1a1e",   // primary
  mid:       "#52525e",   // muted labels
  dim:       "#636373",   // placeholder / disabled — darkened for WCAG AA (4.5:1 on bg + s0)

  // Mono values — slightly blue-tinted dark for readability on white
  mono:      "#3a4a58",

  // Primary accent: macOS Aqua system blue
  accent:    "#0070c9",
  accentDim: "#e0eefa",
  accentHi:  "#005aa0",

  // Secondary: sage (success / ACK / status)
  sage:      "#1e8c5e",
  sageDim:   "#e4f5ed",

  // Danger / warn
  danger:    "#c0392b",
  dangerDim: "#fdf0ef",
  warn:      "#b7791f",
  warnDim:   "#fef3cd",

  // Protocol log colors
  green:     "#1e8c5e",
  greenDim:  "#e4f5ed",
  blue:      "#2563a8",
  blueDim:   "#dbeafe",

  // LCD display (unchanged — the physical device screen is always dark)
  lcd:       "#c8dce8",
  lcdBg:     "#000000",
};

// Warm orange kept as an independent semantic color (tree icons, depth indicators, caution states)
C.orange    = "#c87941";
C.orangeDim = "#fdf0e6";
C.greenMid  = C.sageDim;

// IBM Plex Sans for all UI text; IBM Plex Mono for values, hex, numeric data
export const MONO = "'IBM Plex Mono','Fira Code','Consolas',monospace";
export const SANS = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

export const G = `
@font-face{font-family:'Changeling Neo';src:url('/fonts/Changeling Neo W01 Reg.ttf') format('truetype');font-weight:400;font-style:normal;}
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{
  background:${C.bg};color:${C.text};
  font-family:${SANS};font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;font-weight:400;
  font-variant-numeric:tabular-nums;
}
::-webkit-scrollbar{width:8px;height:8px;background:linear-gradient(to right,#ccc,#fff 20%,#ddd);cursor:default}
::-webkit-scrollbar-track:vertical{
  background:linear-gradient(to right,#eee,#fff);
  border-left:1px solid #ccc;
  border-radius:100px;
  box-shadow:inset 1px 0 2px #0002;
}
::-webkit-scrollbar-track:vertical:window-inactive{box-shadow:inset 1px 0 2px #0031}
::-webkit-scrollbar-track:horizontal{
  background:linear-gradient(to bottom,#eee,#fff);
  border-top:1px solid #ccc;
  border-radius:100px;
  box-shadow:inset 0 1px 2px #0002;
}
::-webkit-scrollbar-track:horizontal:window-inactive{box-shadow:inset 0 1px 2px #0031}
::-webkit-scrollbar-thumb:vertical{
  background:linear-gradient(to right,#6af 10%,#fff2 20%,#6af 30%,#9ef);
  border:1px solid #8bc;box-sizing:border-box;box-shadow:inset 0 0 3px #0042;
  min-height:24px;border-radius:100px;
}
::-webkit-scrollbar-thumb:vertical:window-inactive{
  background:linear-gradient(to right,#ddd 10%,#fff2 20%,#eee 30%,#fff);
  box-shadow:inset 0 0 3px #0033;border-color:#ccc;
}
::-webkit-scrollbar-thumb:horizontal{
  background:linear-gradient(to bottom,#6af 10%,#fff2 20%,#6af 30%,#9ef);
  border:1px solid #8bc;box-sizing:border-box;box-shadow:inset 0 0 3px #0042;
  min-width:24px;border-radius:100px;
}
::-webkit-scrollbar-thumb:horizontal:window-inactive{
  background:linear-gradient(to bottom,#ddd 10%,#fff 20%,#eee 30%,#fff);
  box-shadow:inset 0 0 3px #0033;border-color:#ccc;
}
::-webkit-scrollbar-thumb:active{box-shadow:inset 0 0 5px #004}
::-webkit-scrollbar-corner{background:linear-gradient(to right,#ccc,#fff 20%,#ddd)}
/* Mac OS X Lion selection color */
::-moz-selection{background:rgba(124,196,255,0.7)}
::selection{background:rgba(124,196,255,0.7)}

input,select,textarea{
  background:${C.s1};color:${C.text};
  border:1px solid ${C.borderHi};
  font-family:${SANS};font-size:13px;font-weight:400;
  height:28px;padding:0 8px;outline:none;
  transition:border-color .12s;width:100%;
}
input:focus,select:focus{
  border-color:${C.accent};
  box-shadow:0 0 0 3px ${C.accentDim};
}
input[type=range]{
  -webkit-appearance:none;appearance:none;
  padding:0;height:15px;background:transparent;border:none;
  box-shadow:none;cursor:pointer;width:100%;
}
input[type=range]::-webkit-slider-runnable-track{
  height:4px;border-radius:40px;
  background:linear-gradient(0deg,rgba(255,255,255,0.83) 0%,rgba(0,0,0,0.17) 100%);
  border:1px solid #8e8e8e;
}
input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none;
  width:15px;height:15px;border-radius:50%;margin-top:-6px;
  background:linear-gradient(0deg,#EDEDED 0%,#F3F3F3 50%,#FAFAFA 50%,#FFFFFF 100%);
  border:1px solid #979797;
  box-shadow:0 1px 0 0 rgba(0,0,0,0.14),inset 0 0 0 1px rgba(255,255,255,0.42),inset 0 1px 0 0 rgba(255,255,255,0.53);
  cursor:pointer;
}
input[type=range]:focus::-webkit-slider-thumb{
  border-color:${C.accentHi};
  box-shadow:0 1px 2px rgba(0,0,0,0.14),inset 0 1px 0 rgba(255,255,255,0.53),0 0 0 3px ${C.accentDim};
}
input[type=checkbox]{width:13px;height:13px;cursor:pointer;accent-color:${C.accent}}
input[type=color]{padding:2px;cursor:pointer}
select{cursor:pointer}
/* Lion-style dropdown panel shadow */
select option{background:rgba(255,255,255,0.95);box-shadow:0 6px 12px rgba(0,0,0,0.7)}
button{
  cursor:pointer;font-family:${SANS};border:none;outline:none;
  font-size:13px;font-weight:400;
}
@keyframes syncBar{
  0%{width:0%;margin-left:0}
  50%{width:60%;margin-left:20%}
  100%{width:0%;margin-left:100%}
}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
`;

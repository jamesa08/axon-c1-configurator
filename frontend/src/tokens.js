// --- TOKENS (Warp x ClickHouse remix) -----------------------------------------
// Warp's depth system + ClickHouse's density philosophy + sienna brand accent
export const C = {
  // Surface stack (Warp-derived) -- depth through bg steps, never shadows
  bg:        "#0b0d14",   // deepest bg
  s0:        "#11141d",   // sidebar / panel bg
  s1:        "#161a25",   // card / surface
  s2:        "#1e2331",   // raised / hover
  s3:        "#252b3a",   // border-adjacent
  border:    "#232838",   // normal border
  borderHi:  "#2e3447",   // strong border / focus ring base

  // Text (Warp-derived)
  text:      "#f1f1f4",   // primary
  mid:       "#9aa1b3",   // muted labels
  dim:       "#5f6580",   // placeholder / disabled

  // Mono values -- slightly warmer than pure white
  mono:      "#b8cdd8",

  // Primary accent: sienna (replaces Warp's teal)
  accent:    "#c87941",
  accentDim: "#2a1808",
  accentHi:  "#e0924e",

  // Secondary: sage (success / ACK / status)
  sage:      "#5db897",
  sageDim:   "#0d2820",

  // Danger / warn
  danger:    "#e05555",
  dangerDim: "#2a0d0d",
  warn:      "#d4913a",
  warnDim:   "#2a1a06",

  // Protocol log colors
  green:     "#5db897",
  greenDim:  "#0d2820",
  blue:      "#5c8fcf",
  blueDim:   "#0d1e36",

  // LCD
  lcd:       "#c8dce8",
  lcdBg:     "#000000",
};

// Aliases for compatibility
C.orange    = C.accent;
C.orangeDim = C.accentDim;
C.greenMid  = C.sageDim;

// IBM Plex Sans for UI labels, JetBrains Mono for every value/number/ID (Warp signature)
export const MONO = "'JetBrains Mono','Fira Code','Consolas',monospace";
export const SANS = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

export const G = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{
  background:${C.bg};color:${C.text};
  font-family:${SANS};font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;font-weight:400;
  font-variant-numeric:tabular-nums;
}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${C.borderHi};border-radius:2px}
::selection{background:${C.accentDim};color:${C.accentHi}}

/* Inputs: bg-alt fill, 1px border-strong, 4px radius, mono for values */
input,select,textarea{
  background:${C.s0};color:${C.text};
  border:1px solid ${C.borderHi};
  border-radius:4px;
  font-family:${SANS};font-size:12px;font-weight:400;
  height:28px;padding:0 8px;outline:none;
  transition:border-color .12s;width:100%;
}
input:focus,select:focus{
  border-color:${C.accent};
  box-shadow:0 0 0 2px ${C.accentDim};
}
input[type=range]{
  padding:0;height:auto;background:transparent;border:none;
  box-shadow:none;cursor:pointer;accent-color:${C.accent};
}
input[type=checkbox]{width:13px;height:13px;cursor:pointer;accent-color:${C.accent}}
input[type=color]{padding:2px;cursor:pointer;border-radius:4px}
select{cursor:pointer}
button{
  cursor:pointer;font-family:${SANS};border:none;outline:none;
  font-size:12px;font-weight:400;
}
@keyframes syncBar{
  0%{width:0%;margin-left:0}
  50%{width:60%;margin-left:20%}
  100%{width:0%;margin-left:100%}
}
`;

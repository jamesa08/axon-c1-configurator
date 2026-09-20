import React from "react";

const CN = "'Changeling Neo', sans-serif";

export default function AxonLogo({ scale = 1 }) {
  const w = 76 * scale;
  const h = 38 * scale;
  return (
    <svg width={w} height={h} viewBox="0 0 76 38" xmlns="http://www.w3.org/2000/svg" style={{ display:"block", flexShrink:0 }}>
      {/* AXON */}
      <text
        x="38" y="18"
        textAnchor="middle"
        dominantBaseline="auto"
        fontFamily={CN}
        fontSize="18"
        fill="#1a1a1e"
        letterSpacing="0.5"
      >AXON</text>

      {/* C1 bar */}
      <rect x="0" y="20" width="76" height="18" fill="#1a1a1e" />
      <text
        x="38" y="33"
        textAnchor="middle"
        dominantBaseline="auto"
        fontFamily={CN}
        fontSize="13"
        fill="#ffffff"
        letterSpacing="2"
      >C1</text>
    </svg>
  );
}

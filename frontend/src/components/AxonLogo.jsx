import React from "react";
import { C } from "../tokens.js";

const CN = "'Changeling Neo', sans-serif";

export default function AxonLogo({ scale = 1, muted = false }) {
  const w = 76 * scale;
  const h = 38 * scale;
  const ink = muted ? C.border : "#1a1a1e";
  const chip = muted ? C.border : "#1a1a1e";
  const chipText = muted ? C.s1 : "#ffffff";
  return (
    <svg width={w} height={h} viewBox="0 0 76 38" xmlns="http://www.w3.org/2000/svg" style={{ display:"block", flexShrink:0 }}>
      <text
        x="38" y="18"
        textAnchor="middle"
        dominantBaseline="auto"
        fontFamily={CN}
        fontSize="18"
        fill={ink}
        letterSpacing="0.5"
      >AXON</text>
      <rect x="0" y="20" width="76" height="18" fill={chip} />
      <text
        x="38" y="33"
        textAnchor="middle"
        dominantBaseline="auto"
        fontFamily={CN}
        fontSize="13"
        fill={chipText}
        letterSpacing="2"
      >C1</text>
    </svg>
  );
}

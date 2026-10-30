// Draws a Data Matrix-style symbol for a DMC string (visual stand-in only, not a
// scannable ECC200 encoding): solid "L" finder on the left/bottom edges, alternating
// clock track on the top/right edges, data cells derived from a hash of the code.
import { hashString, mulberry32, esc } from '../core/format.js';

export function dmcSvg(code, { size = 96, modules = 18, failed = false } = {}) {
  const n = modules;
  const rand = mulberry32(hashString(code || 'no-read'));
  let path = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let on;
      if (x === 0 || y === n - 1) on = true;
      else if (y === 0) on = x % 2 === 0;
      else if (x === n - 1) on = y % 2 === 1;
      else on = rand() < 0.48;
      if (on) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  const label = failed ? 'Data Matrix could not be read' : `Data Matrix ${code}`;
  return `<svg class="dmc${failed ? ' dmc-failed' : ''}" viewBox="-1.5 -1.5 ${n + 3} ${n + 3}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
    <rect class="dmc-bg" x="-1.5" y="-1.5" width="${n + 3}" height="${n + 3}" rx="1"/>
    <path class="dmc-fg" d="${path}"/>
    ${failed ? `<path class="dmc-x" d="M-0.5 -0.5L${n + 0.5} ${n + 0.5}M${n + 0.5} -0.5L-0.5 ${n + 0.5}"/>` : ''}
  </svg>`;
}

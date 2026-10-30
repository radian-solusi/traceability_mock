// Formatting helpers shared by every view.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtTime(ts, withSeconds = true) {
  if (ts == null) return '–';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? ':' + pad(d.getSeconds()) : ''}`;
}

export function fmtDate(ts) {
  if (ts == null) return '–';
  const d = new Date(ts);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateTime(ts) {
  if (ts == null) return '–';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? fmtTime(ts) : `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${fmtTime(ts, false)}`;
}

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = ms / 3600000;
  return `${h.toFixed(1)} h`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (ts == null) return '–';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return fmtDate(ts);
}

export function fmtPct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '–';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtNum(v) {
  if (v == null) return '–';
  return Number(v).toLocaleString('en-US');
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Shift calendar assumed for PTCT: 07-15, 15-23, 23-07. */
export function shiftOf(ts = Date.now()) {
  const h = new Date(ts).getHours();
  if (h >= 7 && h < 15) return { id: 1, label: 'Shift 1 · 07:00–15:00' };
  if (h >= 15 && h < 23) return { id: 2, label: 'Shift 2 · 15:00–23:00' };
  return { id: 3, label: 'Shift 3 · 23:00–07:00' };
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

/** Deterministic PRNG so the seeded plant looks the same on every load. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

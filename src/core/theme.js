// Light / dark theme.
// Webix skins: "willow" (light) and "dark" (re-tinted to blue in vite.config.js).
// Preference: auto (follow the OS, or the host page's data-theme attribute) | light | dark.
import webix from '../lib/webix.js';
import willowCss from 'webix/skins/willow.css?inline';
import darkCss from 'webix/skins/dark.css?inline';
import { emit } from './bus.js';
import { env } from '../config/env.js';

const KEY = 'ptct.theme';
let pref = readPref();
let effective = null;
let styleEl = null;
let rebuild = null;

function readPref() {
  if (!env.persist) return 'auto';
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function writePref(v) {
  if (!env.persist) return;
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage unavailable: keep the choice for this session only */
  }
}

export function resolveTheme() {
  if (pref === 'light' || pref === 'dark') return pref;
  const host = document.documentElement.getAttribute('data-theme');
  if (host === 'light' || host === 'dark') return host;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(name) {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'webix-skin';
    document.head.insertBefore(styleEl, document.head.firstChild);
  }
  styleEl.textContent = name === 'dark' ? darkCss : willowCss;
  if (webix.skin && typeof webix.skin.set === 'function') webix.skin.set(name === 'dark' ? 'dark' : 'willow');
  document.body.classList.toggle('theme-dark', name === 'dark');
  document.body.classList.toggle('theme-light', name !== 'dark');
  effective = name;
}

function recheck() {
  const next = resolveTheme();
  if (next === effective) return;
  apply(next);
  emit('theme', { theme: next });
  if (rebuild) rebuild();
}

export function initTheme(onRebuild) {
  rebuild = onRebuild;
  apply(resolveTheme());
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', recheck);
  new MutationObserver(recheck).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function setThemePref(next) {
  pref = next;
  writePref(next);
  recheck();
}

export const themePref = () => pref;
export const currentTheme = () => effective;

/** Read a CSS custom property (for canvas charts that cannot use var()). */
export function cssVar(name, fallback = '#888') {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

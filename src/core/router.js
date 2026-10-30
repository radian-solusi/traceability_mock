// Hash router. Route names use letters, digits and hyphens only (e.g. #station-sea-east).
const pages = new Map();
const PARAM_ROUTES = ['station', 'trace', 'api-sync'];
let handler = null;

export function registerPages(list) {
  list.forEach((p) => pages.set(p.route, p));
}

export function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!raw) return { name: null, param: null };
  for (const prefix of PARAM_ROUTES) {
    if (raw === prefix) return { name: prefix, param: null };
    if (raw.startsWith(`${prefix}-`)) return { name: prefix, param: raw.slice(prefix.length + 1) };
  }
  return { name: raw, param: null };
}

export function navigate(name, param) {
  const target = param ? `${name}-${String(param).toLowerCase()}` : name;
  if (location.hash.replace(/^#/, '') === target) handler && handler();
  else location.hash = target;
}

export function startRouter(fn) {
  handler = fn;
  window.addEventListener('hashchange', () => handler && handler());
}

export const getPage = (name) => pages.get(name);
export const allPages = () => [...pages.values()];

// Audit trail ("logs" table, FR-015) and notifications.
// FR-015 fields: user, timestamp, before value, after value.
// Categories: Login, Logout, Status change, Manual correction, Configuration change (+ Operation, Integration).
import { db, nextId } from './db.js';
import { changed } from './bus.js';

const MAX_AUDIT = 4000;
const MAX_NOTIFICATIONS = 200;

export const SYSTEM = { username: 'system', name: 'System', role: '–' };

export const CATEGORIES = ['Login', 'Logout', 'Status change', 'Manual correction', 'Configuration change', 'Operation', 'Integration'];

function guessCategory(module, action) {
  if (module === 'Auth') return action === 'Logout' ? 'Logout' : 'Login';
  if (module === 'Parameters' || module === 'User access') return 'Configuration change';
  if (module === 'API Sync' || module === 'Simulator') return 'Integration';
  return 'Operation';
}

const fmtValue = (v) => {
  if (v == null || v === '') return '';
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${x ?? '–'}`).join(' · ');
  return String(v);
};

/**
 * opts: { before, after, category, ts, silent }
 * before / after may be strings or flat objects (rendered as "key: value · key: value").
 */
export function audit(actor, module, action, detail, opts = {}) {
  const who = actor || SYSTEM;
  const entry = {
    id: nextId('AU', 7),
    ts: opts.ts ?? Date.now(),
    username: who.username,
    name: who.name,
    role: who.role,
    category: opts.category || guessCategory(module, action),
    module,
    action,
    detail,
    before: fmtValue(opts.before),
    after: fmtValue(opts.after),
  };
  db.audit.unshift(entry);
  if (db.audit.length > MAX_AUDIT) db.audit.length = MAX_AUDIT;
  if (!opts.silent) changed('audit', { entry });
  return entry;
}

/** Describe the fields that differ between two flat objects, for configuration audits. */
export function diff(before, after, keys = Object.keys(after)) {
  const b = {};
  const a = {};
  for (const k of keys) {
    const x = Array.isArray(before[k]) ? before[k].join('/') : before[k];
    const y = Array.isArray(after[k]) ? after[k].join('/') : after[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      b[k] = x;
      a[k] = y;
    }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

/**
 * level: info | success | warning | error
 * route: hash route to open when the notification is clicked
 * toast: show a pop-up toast (false for background/simulator noise)
 */
export function notify(level, text, opts = {}) {
  const n = {
    id: nextId('NT'),
    ts: opts.ts ?? Date.now(),
    level,
    text,
    route: opts.route || null,
    stationId: opts.stationId || null,
    read: !!opts.read,
    toast: opts.toast !== false,
  };
  db.notifications.unshift(n);
  if (db.notifications.length > MAX_NOTIFICATIONS) db.notifications.length = MAX_NOTIFICATIONS;
  if (!opts.silent) changed('notify', { notification: n });
  return n;
}

export function markAllRead() {
  db.notifications.forEach((n) => (n.read = true));
  changed('notify', {});
}

export const unreadCount = () => db.notifications.filter((n) => !n.read).length;

// Alarm & monitoring (FR-014) and exception alerts (FR-006).
// An alarm is keyed (e.g. "scanner:HT-W1-SCN-01"); raising an active key again only updates it.
// States: ACTIVE → ACKNOWLEDGED (by a user) → CLEARED (condition gone). Cleared alarms stay in history.
import { db, nextId, stationName } from './db.js';
import { changed } from './bus.js';
import { audit, notify } from './audit.js';

const MAX_ALARMS = 600;

export const ruleOf = (code) => db.alarmRules.find((r) => r.code === code);

export function raiseAlarm(code, key, message, opts = {}) {
  const rule = ruleOf(code);
  if (rule && rule.enabled === false) return null;
  const ts = opts.ts ?? Date.now();
  const open = db.alarms.find((a) => a.key === key && a.state !== 'CLEARED');
  if (open) {
    open.count += 1;
    open.lastAt = ts;
    open.message = message;
    if (!opts.silent) changed('alarm', { alarmId: open.id });
    return open;
  }
  const alarm = {
    id: nextId('AL', 5),
    code,
    key,
    name: rule?.name || code,
    severity: opts.severity || rule?.severity || 'warning',
    message,
    stationId: opts.stationId || null,
    source: opts.source || (opts.stationId ? stationName(opts.stationId) : 'System'),
    route: opts.route || null,
    raisedAt: ts,
    lastAt: ts,
    count: 1,
    state: 'ACTIVE',
    ackBy: null,
    ackAt: null,
    clearedAt: null,
  };
  db.alarms.unshift(alarm);
  if (db.alarms.length > MAX_ALARMS) db.alarms.length = MAX_ALARMS;
  if (!opts.silent) {
    if (alarm.severity !== 'info') notify(alarm.severity === 'critical' ? 'error' : 'warning', `Alarm · ${alarm.name}: ${message}`, { route: 'alarms', stationId: alarm.stationId, toast: opts.toast });
    changed('alarm', { alarmId: alarm.id });
  }
  return alarm;
}

export function clearAlarm(key, opts = {}) {
  let n = 0;
  for (const a of db.alarms) {
    if (a.key === key && a.state !== 'CLEARED') {
      a.state = 'CLEARED';
      a.clearedAt = opts.ts ?? Date.now();
      n++;
    }
  }
  if (n && !opts.silent) changed('alarm', { key });
  return n;
}

export function ackAlarm(id, actor, opts = {}) {
  const a = db.alarms.find((x) => x.id === id);
  if (!a || a.state !== 'ACTIVE') return false;
  a.state = 'ACKNOWLEDGED';
  a.ackBy = actor?.name || 'System';
  a.ackAt = opts.ts ?? Date.now();
  audit(actor, 'Alarms', 'Alarm acknowledged', `${a.id} · ${a.name} · ${a.source}`, { before: 'ACTIVE', after: 'ACKNOWLEDGED', category: 'Status change', ts: a.ackAt, silent: opts.silent });
  if (!opts.silent) changed('alarm', { alarmId: id });
  return true;
}

export function ackAll(actor) {
  const list = db.alarms.filter((a) => a.state === 'ACTIVE');
  list.forEach((a) => ackAlarm(a.id, actor, { silent: true }));
  if (list.length) changed('alarm', {});
  return list.length;
}

export const activeAlarms = () => db.alarms.filter((a) => a.state !== 'CLEARED');
export const unackedCount = () => db.alarms.filter((a) => a.state === 'ACTIVE').length;
export const stationAlarms = (stationId) => activeAlarms().filter((a) => a.stationId === stationId);

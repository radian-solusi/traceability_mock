// Health / traffic counters for the external interfaces (API Synchronization module).
import { db, runtimeOf } from './db.js';

export function touchIntegration(key, { ts = Date.now(), ok = true, latencyMs = null, count = 1 } = {}) {
  const it = db.integrations[key];
  if (!it) return;
  it.lastAt = ts;
  it.today = (it.today || 0) + count;
  if (!ok) {
    it.errors = (it.errors || 0) + 1;
    it.lastErrorAt = ts;
  }
  if (latencyMs != null) {
    const n = (it.latencySamples = (it.latencySamples || 0) + 1);
    it.latencyMs = Math.round(((it.latencyMs || latencyMs) * (n - 1) + latencyMs) / n);
  }
}

/** Count a message without touching health (e.g. movements published to CT-Track). */
export function countIntegration(key, field, n = 1) {
  const it = db.integrations[key];
  if (it) it[field] = (it[field] || 0) + n;
}

export function integrationHealth(key) {
  const it = db.integrations[key];
  if (!it) return 'UNKNOWN';
  if (key === 'CTTRACK' && db.settings.ctmsOutage) return 'DEGRADED';
  if (key === 'OPC') {
    const down = db.stations.some((s) => s.cameraId && runtimeOf(s.id).plcDown);
    if (down) return 'DEGRADED';
  }
  if (key === 'KEYENCE') {
    const offline = Object.values(db.settings.cameraOffline || {}).filter(Boolean).length;
    const buffering = db.stations.some((s) => runtimeOf(s.id).appLinkDown);
    if (offline || buffering) return 'DEGRADED';
  }
  return it.status || 'ONLINE';
}

// UC-005 Submit Inspection Result to CTMS and Track Status — always through CT-Track.
// FR-010: the traceability application cannot connect to the IT layer directly; it talks to the
// L1 JSON API server (CT-Track) provided by PTCT, which forwards to CTMS and returns CTMS's answer.
// Message types: INSPECTION (UC-004 result), LIMAB_FLAG (FR-003 status flag), CORRECTION / RESEND.
// Status per transaction: PENDING → SUCCESS | FAILED (UC-005 extension 3a). Results stay saved locally.
import { db, getTx, getPipe, getStation, getWo, stationCode } from './db.js';
import { changed } from './bus.js';
import { audit, notify, SYSTEM } from './audit.js';
import { touchIntegration } from './integrations.js';
import { raiseAlarm, clearAlarm } from './alarms.js';

const ERRORS = [
  { httpStatus: 504, message: 'CT-Track: CTMS did not respond within the API timeout' },
  { httpStatus: 503, message: 'CT-Track: CTMS service unavailable (maintenance window)' },
  { httpStatus: 401, message: 'CT-Track: JWT expired; token refreshed, retry scheduled' },
  { httpStatus: 409, message: 'CT-Track: pipe record locked by another CTMS transaction' },
];

const iso = (ts) => (ts ? new Date(ts).toISOString() : null);
export const resultName = (r) => ({ GOOD: 'Good', NC: 'NC', REJECT: 'Reject', PENDING: 'Pending' })[r] || null;
const params = () => db.systemParams || {};

export const TYPE_LABEL = { INSPECTION: 'Inspection result', LIMAB_FLAG: 'Limab status flag', DISPOSITION: 'Supervisor decision', CORRECTION: 'Correction', RESEND: 'Resend' };

export function buildPayload(tx) {
  const pipe = getPipe(tx.pipeId);
  const st = getStation(tx.stationId);
  const wo = getWo(tx.wo);
  return {
    messageType: tx.ctms?.type || 'INSPECTION',
    transactionId: tx.id,
    line: st?.lineId || 'HT',
    workOrder: tx.wo,
    pipeNumber: tx.pn,
    dmc: tx.dmc,
    product: wo ? `${wo.product.od} ${wo.product.weight} ${wo.product.grade} ${wo.product.end}` : null,
    processPoint: st?.code,
    processPointName: st?.name,
    movement: tx.movement,
    direction: tx.direction || null,
    identificationMethod: tx.method,
    inspection: tx.inspection
      ? {
          result: resultName(tx.inspection.result),
          kind: tx.inspection.kind === 'FLAG' ? 'STATUS_FLAG' : 'INSPECTION',
          defectCode: tx.inspection.defectCode || null,
          remarks: tx.inspection.remarks || '',
          inspector: tx.inspection.byUser || null,
          inspectedAt: iso(tx.inspection.ts),
          correction: tx.inspection.corrections?.length ? tx.inspection.corrections[tx.inspection.corrections.length - 1] : null,
        }
      : null,
    pipeStatus: resultName(tx.ctms?.reportStatus || tx.inspection?.result),
    disposition: tx.ctms?.type === 'DISPOSITION' ? { status: resultName(tx.ctms.reportStatus), decidedBy: pipe?.holdDecision?.by || null, decision: pipe?.holdDecision?.action || null } : null,
    recordedAt: iso(tx.ts),
    source: 'PTCT-TRACEABILITY',
    target: 'CTMS via CT-Track',
  };
}

export function enqueueCtms(tx, opts = {}) {
  const ts = opts.ts ?? Date.now();
  const prev = tx.ctms && tx.ctms.status !== 'N/A' ? tx.ctms : null;
  tx.ctms = {
    status: 'PENDING',
    type: opts.type || (tx.inspection?.kind === 'FLAG' ? 'LIMAB_FLAG' : 'INSPECTION'),
    attempts: 0,
    queuedAt: ts,
    lastAttemptAt: null,
    nextAttemptAt: ts,
    autoRetry: false,
    inFlight: false,
    ref: prev?.ref || null,
    response: null,
    reportStatus: opts.status || null,
    history: prev?.history || [],
  };
  if (!opts.silent) changed('ctms:status', { txId: tx.id });
}

function ctmsRef(tx) {
  return `CTMS-INS-${String(880000 + Number(tx.id.replace(/\D/g, '')) * 7).slice(-6)}`;
}

function recordInCtms(tx, ts) {
  const pipe = getPipe(tx.pipeId);
  if (!pipe || !tx.inspection?.result) return;
  const cur = db.ctmsRecords[pipe.id];
  if (cur && cur.ts > ts && cur.txId !== tx.id) return;
  db.ctmsRecords[pipe.id] = { status: tx.ctms.reportStatus || tx.inspection.result, txId: tx.id, station: stationCode(tx.stationId), ts, ref: tx.ctms.ref, source: 'Traceability' };
}

/** Used by the seeder to settle historical submissions instantly. */
export function settleCtms(tx, status, ts, opts = {}) {
  const c = tx.ctms;
  c.attempts = opts.attempts ?? 1;
  c.lastAttemptAt = ts;
  c.inFlight = false;
  if (status === 'SUCCESS') {
    c.status = 'SUCCESS';
    c.ref = ctmsRef(tx);
    c.response = { httpStatus: 200, status: 'Success', message: 'CTMS accepted the message (via CT-Track)', ctmsResult: resultName(tx.inspection?.result), ctmsRef: c.ref, latencyMs: 420 };
    c.nextAttemptAt = null;
    recordInCtms(tx, ts);
  } else {
    const err = opts.error || ERRORS[0];
    c.status = 'FAILED';
    c.ref = null;
    c.response = { httpStatus: err.httpStatus, status: 'Failed', message: err.message, latencyMs: (params().apiTimeoutS || 10) * 1000 };
    c.nextAttemptAt = null;
    c.autoRetry = false;
  }
  c.history.push({ at: ts, attempt: c.attempts, type: c.type, status: c.status, httpStatus: c.response.httpStatus, message: c.response.message });
}

export const ctmsTransactions = () => db.transactions.filter((t) => t.ctms && t.ctms.status !== 'N/A');
export const ctmsOpen = () => db.transactions.filter((t) => t.ctms && (t.ctms.status === 'PENDING' || t.ctms.status === 'FAILED'));

export function processCtmsQueue(nowTs = Date.now()) {
  for (const tx of ctmsOpen()) {
    const c = tx.ctms;
    if (c.inFlight) continue;
    if (c.status === 'PENDING' && c.nextAttemptAt <= nowTs) attempt(tx);
    else if (c.status === 'FAILED' && c.autoRetry && c.nextAttemptAt && c.nextAttemptAt <= nowTs) attempt(tx);
  }
}

function attempt(tx) {
  const c = tx.ctms;
  const p = params();
  const backoff = p.retryBackoffS || [10, 30, 60];
  const maxRetries = p.maxAutoRetries ?? 3;
  c.inFlight = true;
  c.attempts += 1;
  c.lastAttemptAt = Date.now();
  const latency = Math.round(250 + Math.random() * 900);
  changed('ctms:status', { txId: tx.id });
  setTimeout(() => {
    c.inFlight = false;
    const at = Date.now();
    const fail = db.settings.ctmsOutage || Math.random() < db.settings.ctmsFailRate;
    if (!fail) {
      c.status = 'SUCCESS';
      c.ref = c.ref || ctmsRef(tx);
      c.response = { httpStatus: 200, status: 'Success', message: 'CTMS accepted the message (via CT-Track)', ctmsResult: resultName(tx.inspection?.result), ctmsRef: c.ref, latencyMs: latency };
      c.nextAttemptAt = null;
      c.autoRetry = false;
      recordInCtms(tx, at);
    } else {
      const err = db.settings.ctmsOutage ? ERRORS[0] : ERRORS[Math.floor(Math.random() * ERRORS.length)];
      c.status = 'FAILED';
      c.response = { httpStatus: err.httpStatus, status: 'Failed', message: err.message, latencyMs: db.settings.ctmsOutage ? (p.apiTimeoutS || 10) * 1000 : latency };
      if (c.attempts < maxRetries) {
        c.autoRetry = true;
        c.nextAttemptAt = at + backoff[Math.min(c.attempts - 1, backoff.length - 1)] * 1000;
      } else {
        c.autoRetry = false;
        c.nextAttemptAt = null;
        notify('error', `CTMS did not accept ${tx.id} (PN ${tx.pn} · ${tx.wo}) after ${c.attempts} attempts: ${err.message}. Retry it from API synchronization.`, { route: 'api-sync' });
      }
      if (db.settings.ctmsOutage || !c.autoRetry) {
        raiseAlarm('CTMS_NO_RESPONSE', 'ctms', `${failedCount()} submission(s) waiting for CTMS · last error: ${err.message}`, { source: 'CT-Track → CTMS', route: 'api-sync' });
      }
    }
    c.history.push({ at, attempt: c.attempts, type: c.type, status: c.status, httpStatus: c.response.httpStatus, message: c.response.message });
    touchIntegration('CTTRACK', { ts: at, ok: c.status === 'SUCCESS', latencyMs: latency });
    if (c.status === 'SUCCESS' && !db.settings.ctmsOutage && failedCount() === 0) clearAlarm('ctms');
    changed('ctms:status', { txId: tx.id });
  }, latency);
}

const failedCount = () => db.transactions.filter((t) => t.ctms?.status === 'FAILED').length;

export function retryCtms(txId, opts = {}) {
  const tx = getTx(txId);
  if (!tx?.ctms || tx.ctms.status === 'SUCCESS' || tx.ctms.inFlight) return false;
  tx.ctms.status = 'PENDING';
  tx.ctms.nextAttemptAt = Date.now();
  tx.ctms.autoRetry = false;
  if (tx.ctms.attempts >= (params().maxAutoRetries ?? 3)) tx.ctms.attempts = 0;
  audit(opts.actor || SYSTEM, 'API Sync', 'CTMS retry', `${tx.id} · PN ${tx.pn} · ${tx.wo}`, { category: 'Integration' });
  changed('ctms:status', { txId });
  return true;
}

export function retryAllFailed(opts = {}) {
  const failed = ctmsOpen().filter((t) => t.ctms.status === 'FAILED' && !t.ctms.inFlight);
  failed.forEach((t) => {
    t.ctms.status = 'PENDING';
    t.ctms.nextAttemptAt = Date.now();
    t.ctms.autoRetry = false;
    t.ctms.attempts = 0;
  });
  if (failed.length) audit(opts.actor || SYSTEM, 'API Sync', 'CTMS retry all', `${failed.length} failed submissions re-queued`, { category: 'Integration' });
  changed('ctms:status', {});
  return failed.length;
}

/** Re-send the latest result of a pipe (reconciliation action or after a correction). */
export function resendLatest(pipeId, type, opts = {}) {
  const pipe = getPipe(pipeId);
  if (!pipe) return null;
  const tx = [...pipe.history].reverse().map(getTx).find((t) => t?.inspection?.result);
  if (!tx) return null;
  enqueueCtms(tx, { type, ts: opts.ts });
  if (!opts.silent) audit(opts.actor || SYSTEM, 'API Sync', type === 'CORRECTION' ? 'Correction sent to CTMS' : 'Resend to CTMS', `${tx.id} · PN ${tx.pn} · ${tx.wo} · ${resultName(tx.inspection.result)}`, { category: 'Integration' });
  return tx;
}

// ---------------------------------------------------------------------------
// Reconciliation: compare tracking data with CTMS data (Rev 1 requirement 8, FR-010 acceptance)
// ---------------------------------------------------------------------------
export function runReconciliation(opts = {}) {
  const ts = opts.ts ?? Date.now();
  const rows = [];
  for (const pipe of db.pipes) {
    const results = pipe.history.map(getTx).filter((t) => t?.inspection?.result);
    if (!results.length) continue;
    const latest = results[results.length - 1];
    if ((latest.inspection.ts ?? latest.ts) > ts) continue; // recorded after this run (seeded snapshot in the past)
    const rec = db.ctmsRecords[pipe.id];
    const reviewed = db.recon?.reviewed?.[pipe.id];
    let state = 'MATCH';
    let reason = 'Tracking and CTMS agree';
    if (!rec || (rec.txId !== latest.id && latest.ctms?.status !== 'SUCCESS')) {
      state = 'NOT_IN_CTMS';
      reason = latest.ctms?.status === 'FAILED' ? `Latest status not in CTMS: submission failed (${latest.ctms.response?.message || 'no response'})` : 'Latest status not in CTMS yet: submission pending';
    } else if (rec.status !== pipe.status && !(pipe.status === 'PENDING' && !rec.status)) {
      state = 'DIFFERENT';
      reason = rec.source === 'CTMS manual entry' ? 'CTMS value was changed outside the traceability application' : 'CTMS holds a different status';
    }
    if (state !== 'MATCH' && reviewed && reviewed.state === state) {
      state = 'REVIEWED';
      reason = `Reviewed by ${reviewed.by}: ${reviewed.note}`;
    }
    rows.push({
      id: pipe.id,
      wo: pipe.wo,
      pn: pipe.pn,
      dmc: pipe.dmc,
      tracking: pipe.status,
      trackingTx: latest.id,
      trackingStation: stationCode(latest.stationId),
      ctms: rec?.status || null,
      ctmsStation: rec?.station || null,
      ctmsRef: rec?.ref || null,
      state,
      reason,
    });
  }
  const wos = db.workOrders.map((w) => {
    const received = db.pipes.filter((p) => p.wo === w.id).length;
    return { wo: w.id, ctmsQty: w.qty, tracked: received, notMarked: Math.max(0, w.qty - received) };
  });
  const summary = {
    total: rows.length,
    match: rows.filter((r) => r.state === 'MATCH').length,
    notInCtms: rows.filter((r) => r.state === 'NOT_IN_CTMS').length,
    different: rows.filter((r) => r.state === 'DIFFERENT').length,
    reviewed: rows.filter((r) => r.state === 'REVIEWED').length,
  };
  db.recon = { ts, rows, wos, summary, reviewed: db.recon?.reviewed || {}, by: opts.actor?.name || 'Scheduled full sync' };
  const mismatches = summary.notInCtms + summary.different;
  if (summary.different > 0 || (summary.notInCtms > 0 && rows.some((r) => r.state === 'NOT_IN_CTMS' && getTx(r.trackingTx)?.ctms?.status === 'FAILED'))) {
    raiseAlarm('RECON_MISMATCH', 'recon', `${mismatches} pipe(s) differ between tracking and CTMS (${summary.different} different value, ${summary.notInCtms} not in CTMS)`, { source: 'Reconciliation', route: 'api-sync', ts, silent: opts.silent });
  } else clearAlarm('recon', { ts, silent: opts.silent });
  if (!opts.silent) {
    audit(opts.actor || SYSTEM, 'API Sync', 'Reconciliation run', `${summary.total} pipes compared: ${summary.match} match, ${summary.different} different, ${summary.notInCtms} not in CTMS`, { category: 'Integration', ts });
    changed('recon', {});
  }
  return db.recon;
}

export function markReviewed(pipeId, note, actor) {
  const row = db.recon?.rows.find((r) => r.id === pipeId);
  if (!row) return;
  db.recon.reviewed[pipeId] = { state: row.state, by: actor?.name || 'System', note: note || 'Checked with CTMS' };
  audit(actor, 'API Sync', 'Reconciliation reviewed', `${row.wo} PN ${row.pn}: ${row.reason}`, { before: row.state, after: 'REVIEWED', category: 'Status change' });
  runReconciliation({ actor, silent: true });
  changed('recon', {});
}

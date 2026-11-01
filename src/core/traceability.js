// Core traceability logic, organised by the use cases of
// "Traceability System Requirement Rev 1":
//   UC-001 receiveDmcBatch          Manage barcode pipe master data (DMC API)
//   UC-002 ingestEvent / identify   Identify pipe and record movement (AUTO, existing-transaction check)
//   UC-003 resolveManual / operatorTrigger   Resolve pipe identity manually (suggestion, 4a other pipe, 4b manual entry)
//   UC-004 submitInspection         Record pipe inspection result (Good / NC)
//   UC-005 enqueueCtms (ctms.js)    Submit inspection result to CTMS (via CT-Track) and track status
// plus Limab status flag and left / right movement (FR-003, FR-005), FR-006 exceptions,
// supervisor decisions on held pipes and manual corrections (FR-015).
// In the real system this logic lives on the DTAS backend; here it runs in the browser.
import {
  db,
  nextId,
  addEvent,
  addTx,
  addPipe,
  addWorkOrder,
  getStation,
  getRoute,
  getWo,
  getPipe,
  getPipeByDmc,
  getEvent,
  getTx,
  getCamera,
  stationName,
  runtimeOf,
} from './db.js';
import { changed } from './bus.js';
import { audit, notify, SYSTEM } from './audit.js';
import { enqueueCtms, resultName } from './ctms.js';
import { touchIntegration, countIntegration } from './integrations.js';
import { raiseAlarm, clearAlarm, ruleOf } from './alarms.js';
import { pad } from './format.js';

export const STAGE = {
  QUEUED: 'QUEUED',
  IN: 'IN',
  AWAIT: 'AWAIT_INSPECTION',
  HOLD: 'HOLD',
  FINISHED: 'FINISHED',
  REJECTED: 'REJECTED',
};

// FR-006 exceptions (+ route check, assumption B5)
export const REASONS = {
  READ_ERROR: 'DMC unreadable',
  NOT_FOUND: 'DMC not found in CTMS / master data',
  DUPLICATE_DMC: 'Duplicate DMC',
  ROUTE_MISMATCH: 'Pipe not expected at this station',
};

const now = () => Date.now();

export const pipeLabel = (p) => (p ? `PN ${p.pn} · ${p.wo}` : '–');
export const statusLabel = (s) => resultName(s) || s || '–';

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------
export const routeOfPipe = (pipe) => getRoute(getWo(pipe.wo)?.routeId) || db.routes[0];
export const defaultRoute = () => db.routes[0];

export function stepOf(pipe, i = pipe.stepIndex) {
  return routeOfPipe(pipe).steps[i];
}

export function stepIndexOfStation(stationId, route = defaultRoute()) {
  return route.steps.findIndex((s) => s.stations.includes(stationId));
}

/** Next applicable step after step i finished with `result` (skips conditional steps). */
export function nextStepIndex(route, i, result) {
  for (let j = i + 1; j < route.steps.length; j++) {
    const step = route.steps[j];
    if (!step.when) return j;
    if (step.when === 'PREV_NC' && result === 'NC') return j;
  }
  return -1;
}

/** Where the pipes queued for `stationId` come from (for "queue from earlier station"). */
export function previousStepLabel(stationId) {
  const route = defaultRoute();
  const i = stepIndexOfStation(stationId, route);
  if (i <= 0) return null;
  const names = (step) => step.stations.map(stationName).join(' / ');
  const prev = route.steps[i - 1];
  if (route.steps[i].when === 'PREV_NC') return `${names(prev)} (NC only)`;
  if (prev.when === 'PREV_NC' && i >= 2) return `${names(route.steps[i - 2])} or ${names(prev)}`;
  return names(prev);
}

// ---------------------------------------------------------------------------
// Pipe sequence per process point (queue). UC-003 step 2, FR-007 "listing pipe incoming to station"
// ---------------------------------------------------------------------------
const byQueue = (a, b) => a.queuedAt - b.queuedAt || a.wo.localeCompare(b.wo) || a.pn - b.pn;

export function queueForStation(stationId) {
  return db.pipes.filter((p) => p.stage === STAGE.QUEUED && p.targetStationId === stationId).sort(byQueue);
}

/** Pipes at the station: IN recorded, or OUT recorded and waiting for the result / status flag. */
export function atStation(stationId) {
  const list = db.pipes.filter((p) => (p.stage === STAGE.IN || p.stage === STAGE.AWAIT) && p.stationId === stationId);
  if (stationId === 'LIMAB') return list.sort((a, b) => a.markedAt - b.markedAt || a.wo.localeCompare(b.wo) || a.pn - b.pn);
  return list.sort((a, b) => a.inAt - b.inAt);
}

/** Limab sequence: marked pipes still at Limab (IN), in DMC order. */
export const limabSequence = () => atStation('LIMAB').filter((p) => p.stage === STAGE.IN);

function pickTarget(route, i) {
  const options = route.steps[i].stations.filter((id) => getStation(id)?.active !== false);
  if (options.length <= 1) return options[0] || route.steps[i].stations[0];
  let best = options[0];
  let bestLoad = Infinity;
  for (const s of options) {
    const load = queueForStation(s).length + atStation(s).length;
    if (load < bestLoad) {
      best = s;
      bestLoad = load;
    }
  }
  return best;
}

function queueAt(pipe, i, ts, target) {
  pipe.stepIndex = i;
  pipe.stage = STAGE.QUEUED;
  pipe.queuedAt = ts;
  pipe.stationId = null;
  pipe.awaitTxId = null;
  pipe.targetStationId = target || pickTarget(routeOfPipe(pipe), i);
}

/** Candidates offered to the operator when automatic identification fails (UC-003). */
export function suggestionsFor(stationId, movement, limit = 8) {
  if (movement === 'IN') {
    const own = queueForStation(stationId).map((p, i) => ({ pipe: p, why: i === 0 ? 'Next in sequence' : `Sequence position ${i + 1}` }));
    const step = defaultRoute().steps[stepIndexOfStation(stationId)];
    const siblings = (step?.stations || [])
      .filter((s) => s !== stationId)
      .flatMap((s) => queueForStation(s).map((p) => ({ pipe: p, why: `Queued for ${stationName(s)}` })));
    return [...own, ...siblings].slice(0, limit);
  }
  return atStation(stationId)
    .filter((p) => p.stage === STAGE.IN)
    .map((p, i) => ({ pipe: p, why: i === 0 ? 'Entered first (FIFO)' : `At station · #${i + 1}` }))
    .slice(0, limit);
}

export function eligibility(pipe, stationId, movement) {
  if (!pipe) return { ok: false, code: 'NOT_FOUND', reason: 'Pipe identity not found in master data.' };
  const label = pipeLabel(pipe);
  if (pipe.stage === STAGE.REJECTED) return { ok: false, code: 'NOT_ACTIVE', reason: `${label} was rejected and is out of the line.` };
  if (pipe.stage === STAGE.FINISHED) return { ok: false, code: 'NOT_ACTIVE', reason: `${label} has already finished the line.` };
  if (pipe.stage === STAGE.HOLD) return { ok: false, code: 'NOT_ACTIVE', reason: `${label} is on hold for supervisor review.` };
  const elsewhere = (pipe.stage === STAGE.IN || pipe.stage === STAGE.AWAIT) && pipe.stationId !== stationId;
  if (elsewhere) return { ok: false, code: 'DUPLICATE_DMC', reason: `${label} is already recorded at ${stationName(pipe.stationId)}: duplicate DMC, or the pipe was not recorded leaving ${stationName(pipe.stationId)}.` };
  if (movement === 'IN') {
    if (pipe.stationId === stationId && (pipe.stage === STAGE.IN || pipe.stage === STAGE.AWAIT)) return { ok: true, existing: true };
    const step = stepOf(pipe);
    if (!step.stations.includes(stationId)) {
      return { ok: false, code: 'ROUTE_MISMATCH', reason: `${label} is expected at ${step.stations.map(stationName).join(' / ')}, not ${stationName(stationId)}.` };
    }
    return { ok: true };
  }
  if (pipe.stage === STAGE.IN && pipe.stationId === stationId) return { ok: true };
  if (pipe.stage === STAGE.AWAIT && pipe.stationId === stationId) return { ok: true, existing: true };
  return { ok: false, code: 'ROUTE_MISMATCH', reason: `${label} is not at ${stationName(stationId)} (no IN recorded there).` };
}

// ---------------------------------------------------------------------------
// UC-002 step 3: existing transaction for the same pipe, process point and event
// ---------------------------------------------------------------------------
export function existingTx(pipe, stationId, movement) {
  if (!pipe) return null;
  const last = pipe.lastTxId ? getTx(pipe.lastTxId) : null;
  const visit = (pipe.stage === STAGE.IN || pipe.stage === STAGE.AWAIT) && pipe.stationId === stationId;
  if (movement === 'IN' && visit) {
    for (let i = pipe.history.length - 1; i >= 0; i--) {
      const t = getTx(pipe.history[i]);
      if (t.stationId === stationId && t.movement === 'IN') return t;
      if (t.stationId !== stationId) break;
    }
  }
  if (movement === 'OUT') {
    if (visit && pipe.stage === STAGE.AWAIT && pipe.awaitTxId) return getTx(pipe.awaitTxId);
    if (last && last.stationId === stationId && last.movement === 'OUT' && pipe.stage !== STAGE.IN) return last;
  }
  return null;
}

function updateExisting(tx, ev, pipe, method, actor) {
  tx.updates = (tx.updates || 0) + 1;
  tx.updatedAt = ev.ts;
  tx.lastEventId = ev.id;
  ev.txId = tx.id;
  ev.duplicateOf = tx.id;
  ev.identification = { ...(ev.identification || {}), status: method === 'AUTO' ? 'AUTO' : 'RESOLVED', method, pipeId: pipe.id, by: method === 'AUTO' ? 'System' : actor?.name, at: ev.ts, updatedTx: tx.id };
  return tx;
}

// ---------------------------------------------------------------------------
// UC-001 Manage barcode pipe master data (DMC API; pipe information from CTMS via CT-Track)
// ---------------------------------------------------------------------------
/**
 * spec: { woId, salesOrder, product, qty, deadline, routeId, pipes: [{ pn, dmc? }] }  (DMC defaults to WO-PN, assumption B9)
 */
export function receiveDmcBatch(spec, opts = {}) {
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  let wo = getWo(spec.woId);
  if (!wo) {
    wo = addWorkOrder({
      id: spec.woId,
      salesOrder: spec.salesOrder,
      product: spec.product,
      qty: spec.qty,
      lineId: 'HT',
      routeId: spec.routeId || defaultRoute().id,
      deadline: spec.deadline,
      status: 'ACTIVE',
      createdAt: ts,
      completedAt: null,
      source: 'CTMS via CT-Track',
    });
  }
  const batchId = nextId('DMC', 5);
  const created = [];
  const rejected = [];
  for (const p of spec.pipes) {
    const id = `${wo.id}-${pad(p.pn, 3)}`;
    const dmc = p.dmc || `${wo.id}-${pad(p.pn, 3)}`;
    const existing = getPipeByDmc(dmc) || getPipe(id);
    if (existing) {
      // FR-006 duplicate DMC: the code is already registered → exception, pipe not created again
      const ex = { id: nextId('DX', 5), ts, batchId, dmc, pipeId: existing.id, reason: `Duplicate DMC: already registered for ${pipeLabel(existing)}` };
      db.dmcExceptions.unshift(ex);
      rejected.push(ex);
      raiseAlarm('DUPLICATE_DMC', `dmc:${dmc}`, `${ex.reason} (batch ${batchId})`, { source: 'DMC API', route: 'api-sync', ts, silent: opts.silent });
      continue;
    }
    const pipe = addPipe({
      id,
      dmc,
      wo: wo.id,
      pn: p.pn,
      status: 'PENDING',
      limabFlag: null,
      stage: STAGE.QUEUED,
      stepIndex: 0,
      stationId: null,
      targetStationId: 'LIMAB',
      queuedAt: ts,
      inAt: null,
      outAt: null,
      firstInAt: null,
      finishedAt: null,
      markedAt: ts,
      batchId,
      history: [],
      lastTxId: null,
      lastMoveAt: ts,
      awaitTxId: null,
      holdAt: null,
      holdReason: null,
      holdDecision: null,
      concession: null,
      ctmsInfo: true,
    });
    const ev = addEvent({
      id: nextId('EV', 7),
      ts,
      stationId: 'LIMAB',
      source: 'DMC',
      readPath: null,
      readPoint: 'ROBOT',
      movementType: 'IN',
      barcode: dmc,
      readStatus: 'OK',
      plcMsg: null,
      cameraId: null,
      rollStartAt: null,
      readAt: ts,
      identification: { status: 'AUTO', method: 'AUTO', pipeId: id, by: 'DMC API', at: ts },
      txId: null,
    });
    recordTx(ev, pipe, 'AUTO', actor, ts, { ...opts, source: 'DMC', silentMovement: true });
    created.push(pipe);
  }
  const batch = {
    id: batchId,
    ts,
    woId: wo.id,
    count: created.length,
    rejected: rejected.length,
    pipes: created.map((p) => p.id),
    pnRange: created.length ? `PN ${created[0].pn}–${created[created.length - 1].pn}` : '–',
    status: created.length ? (rejected.length ? 'PARTIAL' : 'PROCESSED') : 'DUPLICATE',
    source: 'DMC API (Limab robot) + CTMS pipe data via CT-Track',
    latencyMs: Math.round(120 + Math.random() * 180),
  };
  db.dmcBatches.unshift(batch);
  touchIntegration('DMC', { ts, ok: true, latencyMs: batch.latencyMs });
  touchIntegration('CTTRACK', { ts, ok: true, latencyMs: 180 + Math.round(Math.random() * 120), count: 0 });
  audit(actor, 'API Sync', 'DMC batch received', `${batch.id}: ${batch.count} pipes for ${wo.id} (${batch.pnRange})${rejected.length ? `, ${rejected.length} duplicate DMC rejected` : ''}`, { category: 'Integration', ts, silent: opts.silent });
  if (!opts.silent) {
    notify(rejected.length ? 'warning' : 'info', `DMC batch ${batch.id}: ${batch.count} pipes for ${wo.id} marked at Limab${rejected.length ? ` · ${rejected.length} duplicate DMC rejected` : ''}.`, { route: 'work-orders', toast: opts.toast });
    changed('dmc:batch', { batchId: batch.id });
  }
  return batch;
}

// ---------------------------------------------------------------------------
// UC-002 Identify pipe and record movement
// ---------------------------------------------------------------------------
/**
 * input: { stationId, movementType: 'IN'|'OUT', barcode, readStatus: 'OK'|'NO_READ',
 *          source: 'OPC' (option 1) | 'KEYENCE' (option 2) | 'BUFFER' (stored by the camera), rollStartAt }
 */
export function ingestEvent(input, opts = {}) {
  const ts = opts.ts ?? now();
  const st = getStation(input.stationId);
  if (!st) throw new Error(`Unknown station ${input.stationId}`);
  const rt = runtimeOf(st.id);
  const readStatus = input.readStatus || (input.barcode ? 'OK' : 'NO_READ');
  const source = input.source || (rt.readPath === 'OPT2' ? 'KEYENCE' : 'OPC');
  const ev = addEvent({
    id: nextId('EV', 7),
    ts,
    stationId: st.id,
    source,
    readPath: source === 'OPC' ? 'OPT1' : 'OPT2',
    readPoint: input.movementType === 'IN' ? 'ENTRY' : 'EXIT',
    movementType: input.movementType,
    barcode: readStatus === 'OK' ? input.barcode : null,
    rawRead: input.barcode ?? null,
    readStatus,
    plcMsg: source === 'OPC' ? (input.movementType === 'IN' ? 10 : 20) : null,
    cameraId: st.cameraId,
    tag: st.cameraId ? `${st.cameraId}.ReadCode` : null,
    sensorTag: input.movementType === 'IN' ? st.sensors?.entry : st.sensors?.exit,
    rollStartAt: input.rollStartAt ?? ts - (4 + Math.round(Math.random() * 9)) * 1000,
    readAt: ts,
    bufferedAt: input.bufferedAt || null,
    identification: null,
    txId: null,
  });
  const cam = st.cameraId ? getCamera(st.cameraId) : null;
  if (cam) {
    cam.reads = (cam.reads || 0) + 1;
    if (readStatus !== 'OK') cam.fails = (cam.fails || 0) + 1;
    cam.lastCode = ev.barcode || ev.rawRead;
    cam.lastStatus = readStatus;
    cam.lastTs = ts;
  }
  touchIntegration(source === 'OPC' ? 'OPC' : 'KEYENCE', { ts, ok: true, latencyMs: source === 'OPC' ? 40 + Math.round(Math.random() * 60) : 25 + Math.round(Math.random() * 30) });
  // read-failure streak (FR-014 alarm criterion)
  const known = readStatus === 'OK' && !!getPipeByDmc(ev.barcode);
  if (!known) {
    rt.failStreak += 1;
    const limit = ruleOf('READ_FAIL_STREAK')?.threshold ?? 3;
    if (rt.failStreak >= limit) raiseAlarm('READ_FAIL_STREAK', `streak:${st.id}`, `${rt.failStreak} consecutive failed or unknown reads at ${st.name} (${st.cameraId || 'no scanner'})`, { stationId: st.id, route: `station-${st.slug}`, ts, silent: opts.silent, toast: opts.toast });
  } else {
    rt.failStreak = 0;
    clearAlarm(`streak:${st.id}`, { ts, silent: opts.silent });
  }
  if (!opts.silent) changed('opc:event', { eventId: ev.id, stationId: st.id });
  identify(ev, opts);
  return ev;
}

function identify(ev, opts) {
  const actor = opts.actor || SYSTEM;
  if (ev.readStatus !== 'OK' || !ev.barcode) return requireManual(ev, 'READ_ERROR', opts);
  const pipe = getPipeByDmc(ev.barcode);
  if (!pipe) {
    const cam = getCamera(getStation(ev.stationId).cameraId);
    if (cam) cam.invalid = (cam.invalid || 0) + 1;
    return requireManual(ev, 'NOT_FOUND', opts);
  }
  const existing = existingTx(pipe, ev.stationId, ev.movementType);
  if (existing) {
    const tx = updateExisting(existing, ev, pipe, 'AUTO', actor);
    if (!opts.silent) changed('trace:update', { txId: tx.id, stationId: ev.stationId });
    return tx;
  }
  const check = eligibility(pipe, ev.stationId, ev.movementType);
  if (!check.ok) return requireManual(ev, check.code === 'DUPLICATE_DMC' ? 'DUPLICATE_DMC' : 'ROUTE_MISMATCH', opts, check.reason, pipe.id);
  ev.identification = { status: 'AUTO', method: 'AUTO', pipeId: pipe.id, by: 'System', at: ev.ts };
  return recordTx(ev, pipe, 'AUTO', actor, ev.ts, opts);
}

function requireManual(ev, reason, opts, detail, candidatePipeId) {
  const st = getStation(ev.stationId);
  ev.identification = {
    status: 'REQUIRED',
    reason,
    detail: detail || REASONS[reason],
    candidatePipeId: candidatePipeId || null,
    suggested: suggestionsFor(ev.stationId, ev.movementType).map((s) => s.pipe.id),
    raisedAt: ev.ts,
  };
  if (reason === 'NOT_FOUND') raiseAlarm('DMC_NOT_FOUND', `ex:${ev.id}`, `${st.name} ${ev.movementType}: code ${ev.rawRead || '–'} is not in CTMS / master data`, { stationId: st.id, route: `station-${st.slug}`, ts: ev.ts, silent: opts.silent, toast: false });
  if (reason === 'DUPLICATE_DMC') raiseAlarm('DUPLICATE_DMC', `ex:${ev.id}`, `${st.name} ${ev.movementType}: ${detail}`, { stationId: st.id, route: `station-${st.slug}`, ts: ev.ts, silent: opts.silent, toast: false });
  if (!opts.silent) {
    notify('warning', `${st.name}: confirm pipe identity for ${ev.movementType} (${REASONS[reason].toLowerCase()}).`, { route: `station-${st.slug}`, stationId: st.id, toast: opts.toast });
    changed('identify:required', { eventId: ev.id, stationId: ev.stationId });
  }
  return null;
}

const MODE_LABEL = { SUGGESTION: 'confirmed suggestion', LIST: 'selected another pipe (4a)', INPUT: 'entered identity manually (4b)', TRIGGER: 'operator entry (4b)' };

/** UC-003: operator confirms the suggestion, selects another pipe (4a) or enters the identity (4b). */
export function resolveManual(eventId, pipeId, opts = {}) {
  const ev = getEvent(eventId);
  if (!ev || ev.identification?.status !== 'REQUIRED') throw new Error('This identification task is already closed.');
  const pipe = getPipe(pipeId) || getPipeByDmc(pipeId);
  if (!pipe) throw new Error('Pipe identity not found in master data. Check the DMC code or pipe number.');
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const rank = suggestionsFor(ev.stationId, ev.movementType, 50).findIndex((s) => s.pipe.id === pipe.id);
  const before = ev.readStatus === 'OK' ? `Camera read ${ev.rawRead}` : 'Camera read failed (no DMC)';
  const reason = ev.identification.reason;
  // continue with the existing-transaction check (UC-003 postcondition)
  const existing = existingTx(pipe, ev.stationId, ev.movementType);
  let tx;
  if (existing) {
    ev.identification = { ...ev.identification, mode: opts.mode || 'SUGGESTION', suggestionRank: rank >= 0 ? rank + 1 : null };
    tx = updateExisting(existing, ev, pipe, 'MANUAL', actor);
    ev.identification.status = 'RESOLVED';
  } else {
    const check = eligibility(pipe, ev.stationId, ev.movementType);
    if (!check.ok) throw new Error(check.reason);
    ev.identification = {
      ...ev.identification,
      status: 'RESOLVED',
      method: 'MANUAL',
      pipeId: pipe.id,
      by: actor.name,
      at: ts,
      mode: opts.mode || 'SUGGESTION',
      suggestionRank: rank >= 0 ? rank + 1 : null,
    };
    tx = recordTx(ev, pipe, 'MANUAL', actor, ts, opts);
  }
  clearAlarm(`ex:${ev.id}`, { ts, silent: opts.silent });
  audit(actor, 'Station', 'Manual identification', `${stationName(ev.stationId)} ${ev.movementType}: ${REASONS[reason]} · ${MODE_LABEL[opts.mode] || MODE_LABEL.SUGGESTION}`, {
    before,
    after: `${pipeLabel(pipe)} (${pipe.dmc})`,
    category: 'Manual correction',
    ts,
    silent: opts.silent,
  });
  return tx;
}

export function dismissEvent(eventId, note, opts = {}) {
  const ev = getEvent(eventId);
  if (!ev || ev.identification?.status !== 'REQUIRED') throw new Error('This identification task is already closed.');
  const actor = opts.actor || SYSTEM;
  const ts = opts.ts ?? now();
  ev.identification = { ...ev.identification, status: 'DISMISSED', by: actor.name, at: ts, note: note || 'False trigger' };
  clearAlarm(`ex:${ev.id}`, { ts, silent: opts.silent });
  audit(actor, 'Station', 'Event dismissed', `${stationName(ev.stationId)} ${ev.id}: ${ev.identification.note}`, { before: REASONS[ev.identification.reason], after: 'Dismissed', category: 'Manual correction', ts, silent: opts.silent });
  if (!opts.silent) changed('identify:dismissed', { eventId });
}

/** UC-003 4b at a station without camera (or with the camera offline): operator enters the pipe identity. */
export function operatorTrigger({ stationId, pipeId, movementType }, opts = {}) {
  const pipe = getPipe(pipeId) || getPipeByDmc(pipeId);
  if (!pipe) throw new Error('Pipe identity not found in master data. Check the DMC code or pipe number.');
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const ev = addEvent({
    id: nextId('EV', 7),
    ts,
    stationId,
    source: 'OPERATOR',
    readPath: null,
    readPoint: movementType === 'IN' ? 'ENTRY' : 'EXIT',
    movementType,
    barcode: pipe.dmc,
    rawRead: null,
    readStatus: 'MANUAL',
    plcMsg: null,
    cameraId: null,
    rollStartAt: null,
    readAt: ts,
    identification: { status: 'MANUAL', method: 'MANUAL', pipeId: pipe.id, by: actor.name, at: ts, mode: 'TRIGGER' },
    txId: null,
  });
  const existing = existingTx(pipe, stationId, movementType);
  let tx;
  if (existing) tx = updateExisting(existing, ev, pipe, 'MANUAL', actor);
  else {
    const check = eligibility(pipe, stationId, movementType);
    if (!check.ok) {
      ev.identification = { status: 'DISMISSED', reason: check.code, note: check.reason, by: actor.name, at: ts };
      throw new Error(check.reason);
    }
    tx = recordTx(ev, pipe, 'MANUAL', actor, ts, opts);
  }
  audit(actor, 'Station', 'Operator entry', `${stationName(stationId)} ${movementType}: ${pipeLabel(pipe)}${existing ? ' (existing transaction updated)' : ''}`, { category: 'Operation', ts, silent: opts.silent });
  if (!opts.silent) changed('opc:event', { eventId: ev.id, stationId });
  return tx;
}

// ---------------------------------------------------------------------------
// Record the movement (UC-002 steps 5–8)
// ---------------------------------------------------------------------------
function recordTx(ev, pipe, method, actor, ts, opts = {}) {
  const st = getStation(ev.stationId);
  const tx = addTx({
    id: nextId('TX', 7),
    ts,
    pipeId: pipe.id,
    wo: pipe.wo,
    pn: pipe.pn,
    dmc: pipe.dmc,
    stationId: st.id,
    stepIndex: pipe.stepIndex,
    movement: ev.movementType,
    direction: ev.direction || null,
    method,
    source: opts.source || ev.source,
    readPath: ev.readPath || null,
    operator: method === 'AUTO' ? (ev.source === 'DMC' ? 'DMC API' : ev.source === 'SENSOR' ? 'Limab sensor + sequence' : 'Scanner (auto)') : actor.name,
    operatorUser: method === 'AUTO' ? null : actor.username,
    eventId: ev.id,
    rollStartAt: ev.rollStartAt || null,
    readAt: ev.readAt || ts,
    updates: 0,
    inspection: null,
    ctms: { status: 'N/A' },
  });
  ev.txId = tx.id;
  pipe.history.push(tx.id);
  pipe.lastTxId = tx.id;
  pipe.lastMoveAt = ts;
  countIntegration('CTTRACK', 'movements'); // FR-007: movement information published to CT-Track
  if (ev.movementType === 'IN') {
    pipe.stage = STAGE.IN;
    pipe.stationId = st.id;
    pipe.inAt = ts;
    pipe.targetStationId = null;
    if (pipe.firstInAt == null) pipe.firstInAt = ts;
  } else {
    pipe.outAt = ts;
    if (st.inspection === 'OUT') {
      pipe.stage = STAGE.AWAIT;
      pipe.awaitTxId = tx.id;
      tx.inspection = { required: true, kind: st.id === 'LIMAB' ? 'FLAG' : 'RESULT', result: null };
      if (!opts.silent) changed('inspection:required', { txId: tx.id, stationId: st.id, pipeId: pipe.id });
    } else {
      advance(pipe, 'GOOD', ts, opts);
    }
  }
  if (!opts.silent && !opts.silentMovement) changed('trace:movement', { txId: tx.id, pipeId: pipe.id, stationId: st.id });
  return tx;
}

/** Move a pipe to its next step (or finish) after a passing result. */
function advance(pipe, result, ts, opts) {
  const route = routeOfPipe(pipe);
  const j = nextStepIndex(route, pipe.stepIndex, result);
  if (j < 0) {
    pipe.stage = STAGE.FINISHED;
    pipe.finishedAt = ts;
    pipe.awaitTxId = null;
    checkWoCompletion(pipe.wo, ts, opts);
  } else queueAt(pipe, j, ts);
}

function hold(pipe, ts, reason, opts) {
  pipe.stage = STAGE.HOLD;
  pipe.awaitTxId = null;
  pipe.holdAt = ts;
  pipe.holdReason = reason;
  if (!opts.silent) notify('warning', `${pipeLabel(pipe)} is on hold: ${reason}. Supervisor review needed.`, { route: 'supervisor', toast: opts.toast });
}

function reject(pipe, ts, reason, opts) {
  pipe.status = 'REJECT';
  pipe.stage = STAGE.REJECTED;
  pipe.awaitTxId = null;
  pipe.finishedAt = ts;
  pipe.rejectedAt = ts;
  if (!opts.silent) notify('error', `${pipeLabel(pipe)} rejected: ${reason}.`, { route: 'supervisor', toast: opts.toast });
  checkWoCompletion(pipe.wo, ts, opts);
}

/** Routing after a result / status flag. */
function applyResult(pipe, tx, result, ts, opts) {
  const st = getStation(tx.stationId);
  pipe.awaitTxId = null;
  if (tx.inspection.kind === 'FLAG') {
    // Limab (FR-005): left = continue to the next station, right = out station
    pipe.status = result;
    if (result === 'REJECT') return reject(pipe, ts, `status flag Reject at Limab (${tx.direction === 'LEFT' ? 'moved left: check the pipe' : 'out station'})`, opts);
    if (tx.direction === 'RIGHT') return hold(pipe, ts, `Limab out station (right position) · status ${statusLabel(result)}`, opts);
    return advance(pipe, 'GOOD', ts, opts);
  }
  if (result === 'GOOD') {
    pipe.status = 'GOOD';
    return advance(pipe, 'GOOD', ts, opts);
  }
  pipe.status = 'NC';
  const route = routeOfPipe(pipe);
  const j = nextStepIndex(route, pipe.stepIndex, 'NC');
  if (j >= 0 && route.steps[j].when === 'PREV_NC') return queueAt(pipe, j, ts);
  return hold(pipe, ts, `NC at ${st?.name}`, opts);
}

function checkWoCompletion(woId, ts, opts = {}) {
  const wo = getWo(woId);
  if (!wo || wo.status === 'COMPLETED') return;
  const pipes = db.pipes.filter((p) => p.wo === woId);
  if (pipes.length >= wo.qty && pipes.every((p) => p.stage === STAGE.FINISHED || p.stage === STAGE.REJECTED)) {
    wo.status = 'COMPLETED';
    wo.completedAt = ts;
    if (!opts.silent) notify('success', `Work order ${woId} is complete: all ${pipes.length} pipes processed.`, { route: 'work-orders' });
  }
}

function reopenWo(woId) {
  const wo = getWo(woId);
  if (wo && wo.status === 'COMPLETED') {
    wo.status = 'ACTIVE';
    wo.completedAt = null;
  }
}

// ---------------------------------------------------------------------------
// UC-004 Record pipe inspection result (Good / NC) · Limab status flag (Good / NC / Reject / Pending)
// ---------------------------------------------------------------------------
export function submitInspection(txId, { result, defectCode, remarks }, opts = {}) {
  const tx = getTx(txId);
  if (!tx || !tx.inspection?.required) throw new Error('No inspection result is pending for this movement.');
  if (tx.inspection.result) throw new Error('The result was already submitted.');
  const st = getStation(tx.stationId);
  const options = st.resultOptions || ['GOOD', 'NC'];
  if (!options.includes(result)) throw new Error(`Choose a result: ${options.map(statusLabel).join(', ')}.`);
  if ((result === 'NC' || result === 'REJECT') && !defectCode) throw new Error(`Choose a defect code for ${statusLabel(result)}.`);
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const pipe = getPipe(tx.pipeId);
  const statusBefore = pipe.status;
  tx.inspection = {
    required: true,
    kind: tx.inspection.kind,
    result,
    defectCode: result === 'NC' || result === 'REJECT' ? defectCode : null,
    remarks: remarks || '',
    by: actor.name,
    byUser: actor.username,
    ts,
    statusBefore,
    corrections: [],
  };
  if (tx.inspection.kind === 'FLAG') pipe.limabFlag = null;
  applyResult(pipe, tx, result, ts, opts);
  enqueueCtms(tx, { ts, silent: opts.silent });
  audit(actor, 'Station', tx.inspection.kind === 'FLAG' ? 'Status flag' : 'Inspection result', `${st.name}: ${pipeLabel(pipe)}${tx.direction ? ` · ${tx.direction.toLowerCase()} position` : ''}${tx.inspection.defectCode ? ` · ${tx.inspection.defectCode}` : ''}`, {
    before: statusLabel(statusBefore),
    after: statusLabel(result),
    category: 'Status change',
    ts,
    silent: opts.silent,
  });
  if (!opts.silent) changed('inspection:submitted', { txId, pipeId: pipe.id });
  return tx;
}

// ---------------------------------------------------------------------------
// Limab (FR-003, FR-005): status flag and left / right movement
// ---------------------------------------------------------------------------
/** Operator sets the status flag of a marked pipe before it leaves Limab. */
export function setLimabFlag(pipeId, flag, opts = {}) {
  const pipe = getPipe(pipeId);
  if (!pipe || pipe.stationId !== 'LIMAB' || (pipe.stage !== STAGE.IN && pipe.stage !== STAGE.AWAIT)) throw new Error('This pipe is no longer at Limab.');
  if (!getStation('LIMAB').resultOptions.includes(flag)) throw new Error('Unknown status flag.');
  if (pipe.stage === STAGE.AWAIT && pipe.awaitTxId) return submitInspection(pipe.awaitTxId, { result: flag, defectCode: opts.defectCode, remarks: opts.remarks }, opts);
  if ((flag === 'NC' || flag === 'REJECT') && !opts.defectCode) throw new Error(`Choose a defect code for ${statusLabel(flag)}.`);
  const actor = opts.actor || SYSTEM;
  const before = pipe.limabFlag;
  pipe.limabFlag = flag;
  pipe.limabFlagInfo = { defectCode: opts.defectCode || null, remarks: opts.remarks || '', by: actor.name, ts: opts.ts ?? now() };
  audit(actor, 'Station', 'Status flag prepared', `Limab: ${pipeLabel(pipe)} flagged before leaving (applied when the pipe moves)`, { before: before ? statusLabel(before) : 'No flag', after: statusLabel(flag), category: 'Operation', ts: opts.ts, silent: opts.silent });
  if (!opts.silent) changed('limab:flag', { pipeId });
  return null;
}

/**
 * Pipe leaves Limab. direction LEFT = to the next station, RIGHT = out station (sensor HT-LM-OUT-01).
 * source SENSOR → identity from the Limab sequence (AUTO); OPERATOR → the operator picks the pipe (MANUAL).
 */
export function limabMovement({ direction, pipeId, flag, defectCode, remarks, source = 'SENSOR' }, opts = {}) {
  if (direction !== 'LEFT' && direction !== 'RIGHT') throw new Error('Choose left (next station) or right (out station).');
  const seq = limabSequence();
  const pipe = pipeId ? getPipe(pipeId) : seq[0];
  if (!pipe) throw new Error('No marked pipe is waiting at Limab. Release a DMC batch first.');
  if (pipe.stationId !== 'LIMAB' || pipe.stage !== STAGE.IN) throw new Error(`${pipeLabel(pipe)} is not waiting at Limab.`);
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const auto = source === 'SENSOR';
  const st = getStation('LIMAB');
  const ev = addEvent({
    id: nextId('EV', 7),
    ts,
    stationId: 'LIMAB',
    source: auto ? 'SENSOR' : 'OPERATOR',
    readPath: null,
    readPoint: direction,
    movementType: 'OUT',
    direction,
    barcode: pipe.dmc,
    rawRead: null,
    readStatus: auto ? 'SENSOR' : 'MANUAL',
    plcMsg: null,
    cameraId: null,
    sensorTag: direction === 'RIGHT' ? st.sensors.right : st.sensors.left,
    rollStartAt: ts - 3000,
    readAt: ts,
    identification: { status: auto ? 'AUTO' : 'MANUAL', method: auto ? 'AUTO' : 'MANUAL', pipeId: pipe.id, by: auto ? 'Limab sequence' : actor.name, at: ts, mode: auto ? 'SEQUENCE' : 'TRIGGER' },
    txId: null,
  });
  const tx = recordTx(ev, pipe, auto ? 'AUTO' : 'MANUAL', actor, ts, opts);
  const f = flag || pipe.limabFlag;
  if (f) {
    const info = pipe.limabFlagInfo || {};
    const flagActor = flag ? actor : db.users.find((u) => u.name === info.by) || actor;
    submitInspection(tx.id, { result: f, defectCode: defectCode || info.defectCode, remarks: remarks || info.remarks }, { ...opts, actor: flagActor, ts });
  }
  if (!auto) audit(actor, 'Station', 'Operator entry', `Limab OUT (${direction.toLowerCase()}): ${pipeLabel(pipe)}`, { category: 'Operation', ts, silent: opts.silent });
  return tx;
}

// ---------------------------------------------------------------------------
// Supervisor decisions on held pipes (assumption A4)
// ---------------------------------------------------------------------------
/** A supervisor decision changes the pipe status: report it to CTMS (via CT-Track) on the decided transaction. */
function sendDisposition(pipe, ts, opts) {
  const tx = pipe.holdDecision ? getTx(pipe.holdDecision.txId) : null;
  if (tx?.inspection?.result) enqueueCtms(tx, { type: 'DISPOSITION', status: pipe.status, ts, silent: opts.silent });
}

function holdPipe(pipeId) {
  const pipe = getPipe(pipeId);
  if (!pipe || pipe.stage !== STAGE.HOLD) throw new Error('This pipe is no longer on hold.');
  return pipe;
}

export function releaseHold(pipeId, { note } = {}, opts = {}) {
  const pipe = holdPipe(pipeId);
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const station = stationName(pipe.stationId);
  const before = pipe.status;
  if (pipe.status === 'NC') pipe.status = 'GOOD';
  pipe.concession = { by: actor.name, ts, note: note || 'Released after review', station };
  pipe.holdDecision = { txId: pipe.lastTxId, action: 'RELEASE', by: actor.name, ts };
  pipe.holdReason = null;
  advance(pipe, 'GOOD', ts, opts);
  sendDisposition(pipe, ts, opts);
  audit(actor, 'Supervisor', 'Release hold', `${pipeLabel(pipe)} re-enters the line after review at ${station}. ${note || ''}`.trim(), { before: `${statusLabel(before)} · on hold`, after: `${statusLabel(pipe.status)} · ${pipe.stage === STAGE.FINISHED ? 'finished' : 'queued for ' + stationName(pipe.targetStationId)}`, category: 'Status change', ts, silent: opts.silent });
  if (!opts.silent) changed('trace:hold', { pipeId });
}

export function reinspectHold(pipeId, { note } = {}, opts = {}) {
  const pipe = holdPipe(pipeId);
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const station = pipe.stationId;
  pipe.holdReason = null;
  pipe.holdDecision = { txId: pipe.lastTxId, action: 'REINSPECT', by: actor.name, ts };
  if (station === 'LIMAB') {
    pipe.stage = STAGE.IN;
    pipe.stationId = 'LIMAB';
    pipe.limabFlag = null;
    pipe.inAt = ts;
  } else queueAt(pipe, pipe.stepIndex, ts, station);
  audit(actor, 'Supervisor', 'Send back for re-inspection', `${pipeLabel(pipe)} back to ${stationName(station)}. ${note || ''}`.trim(), { before: `${statusLabel(pipe.status)} · on hold`, after: `${statusLabel(pipe.status)} · re-inspection at ${stationName(station)}`, category: 'Status change', ts, silent: opts.silent });
  if (!opts.silent) changed('trace:hold', { pipeId });
}

export function rejectHold(pipeId, { note } = {}, opts = {}) {
  const pipe = holdPipe(pipeId);
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const station = stationName(pipe.stationId);
  const before = pipe.status;
  pipe.holdReason = null;
  pipe.holdDecision = { txId: pipe.lastTxId, action: 'REJECT', by: actor.name, ts };
  reject(pipe, ts, `supervisor decision after ${station}`, { ...opts, silent: true });
  sendDisposition(pipe, ts, opts);
  audit(actor, 'Supervisor', 'Reject pipe', `${pipeLabel(pipe)} rejected after review at ${station}. ${note || ''}`.trim(), { before: `${statusLabel(before)} · on hold`, after: 'Reject · out of line', category: 'Status change', ts, silent: opts.silent });
  if (!opts.silent) changed('trace:hold', { pipeId });
}

// ---------------------------------------------------------------------------
// Manual correction of a result / status flag (FR-015) — only while the pipe has not moved since
// ---------------------------------------------------------------------------
export function canCorrect(tx) {
  if (!tx?.inspection?.result) return { ok: false, reason: 'No result recorded on this movement.' };
  const pipe = getPipe(tx.pipeId);
  if (pipe.lastTxId !== tx.id) return { ok: false, reason: 'The pipe has moved since; correct it at its current station.' };
  if (pipe.holdDecision && pipe.holdDecision.txId === tx.id) return { ok: false, reason: 'A supervisor decision was already taken on this result.' };
  return { ok: true };
}

export function correctResult(txId, { result, defectCode, reason }, opts = {}) {
  const tx = getTx(txId);
  const check = canCorrect(tx);
  if (!check.ok) throw new Error(check.reason);
  const st = getStation(tx.stationId);
  if (!st.resultOptions.includes(result)) throw new Error(`Choose a result: ${st.resultOptions.map(statusLabel).join(', ')}.`);
  if (result === tx.inspection.result) throw new Error('The new result is the same as the recorded one.');
  if ((result === 'NC' || result === 'REJECT') && !defectCode) throw new Error(`Choose a defect code for ${statusLabel(result)}.`);
  if (!reason || !reason.trim()) throw new Error('Enter the reason for the correction (audit trail).');
  const ts = opts.ts ?? now();
  const actor = opts.actor || SYSTEM;
  const pipe = getPipe(tx.pipeId);
  const before = tx.inspection.result;
  // put the pipe back where it was when the result was entered, then route again
  reopenWo(pipe.wo);
  pipe.stage = STAGE.AWAIT;
  pipe.stationId = tx.stationId;
  pipe.stepIndex = tx.stepIndex;
  pipe.targetStationId = null;
  pipe.finishedAt = null;
  pipe.rejectedAt = null;
  pipe.holdAt = null;
  pipe.holdReason = null;
  pipe.status = tx.inspection.statusBefore;
  tx.inspection.corrections.push({ from: before, to: result, by: actor.name, ts, reason: reason.trim() });
  tx.inspection.result = result;
  tx.inspection.defectCode = result === 'NC' || result === 'REJECT' ? defectCode : null;
  applyResult(pipe, tx, result, ts, opts);
  enqueueCtms(tx, { type: 'CORRECTION', ts, silent: opts.silent });
  audit(actor, 'Supervisor', 'Manual correction', `${tx.id} · ${st.name} · ${pipeLabel(pipe)}. Reason: ${reason.trim()}`, { before: statusLabel(before), after: statusLabel(result), category: 'Manual correction', ts, silent: opts.silent });
  if (!opts.silent) changed('trace:correction', { txId, pipeId: pipe.id });
  return tx;
}

// ---------------------------------------------------------------------------
// Pending work
// ---------------------------------------------------------------------------
export const pendingIdentifications = (stationId) =>
  db.events.filter((e) => e.identification?.status === 'REQUIRED' && (!stationId || e.stationId === stationId)).sort((a, b) => a.ts - b.ts);

export const pendingInspections = (stationId) =>
  db.transactions
    .filter((t) => t.inspection?.required && !t.inspection.result && (!stationId || t.stationId === stationId))
    .sort((a, b) => a.ts - b.ts);

export const heldPipes = () => db.pipes.filter((p) => p.stage === STAGE.HOLD).sort((a, b) => a.holdAt - b.holdAt);

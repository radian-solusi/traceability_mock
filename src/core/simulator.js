// Plant simulator. Replaces everything outside the traceability application:
// PLC sensors, Keyence scanner reads (option 1 through PLC → Kepware, option 2 direct),
// camera store-and-forward, the DMC robot feed, CT-Track / CTMS responses.
// It also plays "virtual operators" at stations nobody is looking at, so dashboards stay alive.
import { db, getStation, getPipe, getCamera, getWo, runtimeOf, stationName, cameraOfStation } from './db.js';
import {
  STAGE,
  ingestEvent,
  queueForStation,
  atStation,
  limabSequence,
  pendingIdentifications,
  pendingInspections,
  heldPipes,
  resolveManual,
  dismissEvent,
  submitInspection,
  limabMovement,
  setLimabFlag,
  operatorTrigger,
  releaseHold,
  rejectHold,
  receiveDmcBatch,
  suggestionsFor,
  pipeLabel,
} from './traceability.js';
import { processCtmsQueue, runReconciliation } from './ctms.js';
import { changed, emit } from './bus.js';
import { audit } from './audit.js';
import { raiseAlarm, clearAlarm, ruleOf } from './alarms.js';
import { touchIntegration } from './integrations.js';
import { drawResult, drawLimabFlag, pickDefect, pipeSpec } from '../data/seed.js';
import { startOfDay } from './format.js';

let tickTimer = null;
let ctmsTimer = null;
let tagTimer = null;
let reconTimer = null;
const watching = { stationId: null, supervisor: false };

/** Stations / screens the human is looking at are left to the human. */
export function setWatching(patch) {
  Object.assign(watching, patch);
}

const virtualOperator = (stationId) =>
  db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.defaultStation === stationId) ||
  db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.stations.includes(stationId)) ||
  db.users.find((u) => u.role === 'Supervisor');

export const odOf = (pipe) => getWo(pipe?.wo)?.product?.od || null;

// ---------------------------------------------------------------------------
// Scanner reads (station simulator bar, demo guide, auto-simulation)
// ---------------------------------------------------------------------------
function pickPipeFor(stationId, movement, pipeId) {
  if (pipeId) return getPipe(pipeId);
  const rt = runtimeOf(stationId);
  const bufferedIn = new Set(rt.buffer.filter((r) => r.movementType === 'IN').map((r) => r.pipeId));
  const bufferedOut = new Set(rt.buffer.filter((r) => r.movementType === 'OUT').map((r) => r.pipeId));
  if (movement === 'IN') return queueForStation(stationId).find((p) => !bufferedIn.has(p.id));
  const atHere = atStation(stationId).find((p) => p.stage === STAGE.IN && !bufferedOut.has(p.id));
  if (atHere) return atHere;
  const inBuffer = rt.buffer.find((r) => r.movementType === 'IN' && !bufferedOut.has(r.pipeId));
  return inBuffer ? getPipe(inBuffer.pipeId) : null;
}

/**
 * Simulate a Keyence read at a station's entry (IN) or exit (OUT).
 * opts: forceError, invalid (garbled code), duplicateDmc, pipeId, respectAlignment, actor
 */
export function simulateCameraRead(stationId, movement, opts = {}) {
  const st = getStation(stationId);
  if (!st.cameraId) throw new Error(`${st.name} has no scanner. Enter the pipe identity on the station display.`);
  if (db.settings.cameraOffline[st.cameraId]) throw new Error(`Scanner ${st.cameraId} is offline. Enter the pipe identity on the station display.`);
  const rt = runtimeOf(stationId);
  const pipe = pickPipeFor(stationId, movement, opts.pipeId);
  if (!pipe && !opts.duplicateDmc) {
    throw new Error(movement === 'IN' ? `No pipe is queued for ${st.name}. Move one out of the previous station first.` : `No pipe is at ${st.name} waiting to leave.`);
  }
  let barcode = pipe?.dmc || null;
  let readStatus = 'OK';
  if (opts.forceError) {
    barcode = null;
    readStatus = 'NO_READ';
  } else if (opts.invalid) {
    barcode = pipe.dmc.replace(/\d(?=\d{2}-)/, '?');
  } else if (opts.duplicateDmc) {
    const other = db.pipes.find((p) => (p.stage === STAGE.IN || p.stage === STAGE.AWAIT) && p.stationId !== stationId && p.stationId !== 'LIMAB');
    if (!other) throw new Error('No pipe is recorded at another station to duplicate.');
    barcode = other.dmc;
  } else if (opts.respectAlignment !== false && pipe) {
    const cam = getCamera(st.cameraId);
    if (cam.alignedOd && odOf(pipe) && cam.alignedOd !== odOf(pipe) && Math.random() < 0.6) {
      barcode = null;
      readStatus = 'NO_READ';
      cam.misreads = (cam.misreads || 0) + 1;
    }
  }
  setTag(st.sensors?.[movement === 'IN' ? 'entry' : 'exit'], 'State', true);
  if (rt.appLinkDown) {
    if (db.systemParams?.cameraStoreForward === false) {
      raiseAlarm('CAMERA_BUFFERING', `buffer:${stationId}`, `${st.cameraId} at ${st.name} cannot reach the application and store-and-forward is off: reads are lost`, { stationId, route: `station-${st.slug}`, severity: 'critical' });
      changed('sim', { lost: stationId });
      return { buffered: false, lost: true, count: 0 };
    }
    // NFR redundancy: the camera stores the read locally until the application is reachable again
    rt.buffer.push({ ts: Date.now(), stationId, movementType: movement, barcode, readStatus, pipeId: pipe?.id || null });
    raiseAlarm('CAMERA_BUFFERING', `buffer:${stationId}`, `${st.cameraId} at ${st.name} cannot reach the application: ${rt.buffer.length} read(s) stored in the camera`, { stationId, route: `station-${st.slug}` });
    changed('sim', { buffered: stationId });
    return { buffered: true, count: rt.buffer.length };
  }
  return ingestEvent({ stationId, movementType: movement, barcode, readStatus, source: rt.readPath === 'OPT2' ? 'KEYENCE' : 'OPC' }, { actor: opts.actor });
}

/** The scanner triggers again on the same pipe: UC-002 3a, the existing transaction is updated. */
export function rereadLast(stationId, opts = {}) {
  const last = [...db.events].reverse().find((e) => e.stationId === stationId && ['OPC', 'KEYENCE', 'BUFFER'].includes(e.source) && e.identification?.pipeId);
  if (!last) throw new Error('No identified read at this station yet.');
  const pipe = getPipe(last.identification.pipeId);
  const rt = runtimeOf(stationId);
  return ingestEvent({ stationId, movementType: last.movementType, barcode: pipe.dmc, readStatus: 'OK', source: rt.readPath === 'OPT2' ? 'KEYENCE' : 'OPC' }, { actor: opts.actor });
}

// ---------------------------------------------------------------------------
// Reading path (FR-001): option 1 through PLC → Kepware OPC; option 2 direct camera read
// ---------------------------------------------------------------------------
function applyReadPath(stationId, opts = {}) {
  const rt = runtimeOf(stationId);
  const st = getStation(stationId);
  const prev = rt.readPath;
  rt.readPath = rt.mode === 'OPT2' || rt.plcDown ? 'OPT2' : 'OPT1';
  if (rt.readPath === 'OPT2' && rt.plcDown) {
    raiseAlarm('OPTION2_ACTIVE', `opt2:${stationId}`, `${st.name}: PLC / OPC path not available, reading ${st.cameraId} directly from the application (option 2)`, { stationId, route: `station-${st.slug}`, silent: opts.silent, ts: opts.ts });
  } else clearAlarm(`opt2:${stationId}`, { silent: opts.silent, ts: opts.ts });
  return prev !== rt.readPath;
}

export function setPlcDown(stationId, down, actor, opts = {}) {
  const rt = runtimeOf(stationId);
  rt.plcDown = !!down;
  applyReadPath(stationId, opts);
  audit(actor, 'Simulator', down ? 'PLC / OPC path down' : 'PLC / OPC path restored', `${stationName(stationId)} → reading via ${rt.readPath === 'OPT2' ? 'option 2 (direct camera)' : 'option 1 (PLC → OPC)'}`, { category: 'Integration', silent: opts.silent, ts: opts.ts });
  if (!opts.silent) changed('sim', { stationId, plcDown: down });
}

/** AUTO = option 1 with automatic switch to option 2; OPT2 = force option 2 (configuration). */
export function setReadMode(stationId, mode, actor) {
  const rt = runtimeOf(stationId);
  const before = rt.mode;
  rt.mode = mode;
  applyReadPath(stationId);
  audit(actor, 'Parameters', 'Reading mode changed', `${stationName(stationId)} (${getStation(stationId).cameraId})`, { before: modeLabel(before), after: modeLabel(mode), category: 'Configuration change' });
  changed('sim', { stationId, mode });
}

export const modeLabel = (m) => (m === 'OPT2' ? 'Option 2 only (direct camera)' : 'Option 1, auto-switch to option 2');

export function setAppLinkDown(stationId, down, actor) {
  const rt = runtimeOf(stationId);
  const st = getStation(stationId);
  rt.appLinkDown = !!down;
  audit(actor, 'Simulator', down ? 'Camera link to application down' : 'Camera link to application restored', `${st.name} · ${st.cameraId}`, { category: 'Integration' });
  if (down) raiseAlarm('CAMERA_BUFFERING', `buffer:${stationId}`, `${st.cameraId} at ${st.name} cannot reach the application: reads are stored in the camera`, { stationId, route: `station-${st.slug}` });
  else {
    const n = flushBuffer(stationId);
    clearAlarm(`buffer:${stationId}`);
    if (n) audit(actor, 'Simulator', 'Buffered reads delivered', `${n} read(s) from ${st.cameraId} processed with their original timestamps`, { category: 'Integration' });
  }
  changed('sim', { stationId, appLinkDown: down });
}

/** Deliver the reads the camera stored while the application was unreachable (in order, original time). */
export function flushBuffer(stationId) {
  const rt = runtimeOf(stationId);
  const list = rt.buffer.splice(0);
  for (const r of list) {
    ingestEvent({ stationId, movementType: r.movementType, barcode: r.barcode, readStatus: r.readStatus, source: 'BUFFER', bufferedAt: r.ts }, { ts: r.ts });
  }
  return list.length;
}

// ---------------------------------------------------------------------------
// Keyence autofocus and alignment (FR-001.3) — run by the operator when the pipe size changes
// ---------------------------------------------------------------------------
export function autofocus(cameraId, { od, actor, ts } = {}) {
  const cam = getCamera(cameraId);
  if (!cam) throw new Error('Unknown scanner.');
  if (db.settings.cameraOffline[cameraId]) throw new Error(`${cameraId} is offline: autofocus needs the scanner online.`);
  const before = { focusMm: cam.focusMm, alignedFor: cam.alignedOd || '–' };
  const target = { '13 3/8"': 350, '9 5/8"': 410, '7"': 455, '4 1/2"': 505, '3 1/2"': 520 }[od] || cam.focusMm;
  cam.focusMm = Math.round(target + (Math.random() * 14 - 7));
  cam.alignedOd = od || cam.alignedOd;
  cam.tuneMargin = Math.round(78 + Math.random() * 18);
  cam.lastTuneAt = ts ?? Date.now();
  cam.misreads = 0;
  audit(actor, 'Station', 'Camera autofocus', `${cameraId} at ${stationName(cam.stationId)} tuned for ${od || 'current pipe'} · read margin ${cam.tuneMargin} %`, { before, after: { focusMm: cam.focusMm, alignedFor: cam.alignedOd }, category: 'Operation', ts: cam.lastTuneAt });
  changed('sim', { cameraId });
  return { focusMm: cam.focusMm, margin: cam.tuneMargin, od: cam.alignedOd };
}

export function setCameraOffline(cameraId, offline, actor) {
  db.settings.cameraOffline[cameraId] = !!offline;
  const cam = getCamera(cameraId);
  if (cam) cam.status = offline ? 'OFFLINE' : cam.stationId ? 'ONLINE' : 'STANDBY';
  if (offline) raiseAlarm('SCANNER_OFFLINE', `scanner:${cameraId}`, `${cameraId}${cam?.stationId ? ' at ' + stationName(cam.stationId) : ''} does not answer on either reading path`, { stationId: cam?.stationId, route: cam?.stationId ? `station-${getStation(cam.stationId).slug}` : 'readers' });
  else clearAlarm(`scanner:${cameraId}`);
  audit(actor, 'Simulator', offline ? 'Scanner offline' : 'Scanner online', cameraId, { category: 'Integration' });
  changed('sim', { cameraId, offline });
}

export function setCtmsOutage(on, actor) {
  db.settings.ctmsOutage = !!on;
  if (on) raiseAlarm('CTMS_NO_RESPONSE', 'ctms', 'CT-Track reports that CTMS is not responding', { source: 'CT-Track → CTMS', route: 'api-sync' });
  else if (!db.transactions.some((t) => t.ctms?.status === 'FAILED')) clearAlarm('ctms');
  audit(actor, 'Simulator', on ? 'CTMS outage started' : 'CTMS outage ended', on ? 'CT-Track cannot reach CTMS: submissions fail and retry' : 'CTMS reachable again through CT-Track', { category: 'Integration' });
  changed('sim', { ctmsOutage: on });
}

/** FR-010 full synchronisation through CT-Track: refresh work orders from CTMS, then reconcile. */
export function runFullSync(actor) {
  const ts = Date.now();
  touchIntegration('CTTRACK', { ts, ok: !db.settings.ctmsOutage, latencyMs: 600 + Math.round(Math.random() * 400), count: 0 });
  if (db.settings.ctmsOutage) throw new Error('Full sync failed: CT-Track cannot reach CTMS. Try again when CTMS is back.');
  db.integrations.CTTRACK.lastFullSync = ts;
  return runReconciliation({ actor, ts });
}

// ---------------------------------------------------------------------------
// DMC batches (Limab robot) and work orders
// ---------------------------------------------------------------------------
export function releaseNextDmcBatch({ count = 6, actor, toast, woId, withDuplicate = false } = {}) {
  if (!db.upcoming) db.upcoming = [];
  let up = woId ? db.upcoming.find((w) => w.id === woId) : db.upcoming[0];
  if (!up) {
    up = generateWorkOrder();
    db.upcoming.push(up);
  }
  const released = db.pipes.filter((p) => p.wo === up.id).length;
  const n = Math.max(0, Math.min(count, up.qty - released));
  const pipes = Array.from({ length: n }, (_, k) => pipeSpec(up.id, up.product, released + k + 1));
  if (withDuplicate) {
    const dup = db.pipes.filter((p) => p.stage !== STAGE.FINISHED).slice(-1)[0];
    if (dup) pipes.push({ pn: 900 + Math.floor(Math.random() * 99), dmc: dup.dmc });
  }
  const deadline = startOfDay() + (up.deadlineDays || 7) * 86400e3 + 17 * 3600e3;
  const batch = receiveDmcBatch({ woId: up.id, salesOrder: up.salesOrder, product: up.product, qty: up.qty, deadline, pipes }, { actor, toast });
  if (released + n >= up.qty) db.upcoming = db.upcoming.filter((w) => w.id !== up.id);
  return batch;
}

const PRODUCTS = [
  { type: 'Casing', od: '7"', weight: '29.0 ppf', grade: 'L80-1', end: 'BTC' },
  { type: 'Casing', od: '9 5/8"', weight: '53.5 ppf', grade: 'P110', end: 'BTC' },
  { type: 'Tubing', od: '3 1/2"', weight: '9.3 ppf', grade: 'L80-1', end: 'EUE' },
  { type: 'Casing', od: '13 3/8"', weight: '72.0 ppf', grade: 'N80-Q', end: 'BTC' },
];

function generateWorkOrder() {
  const all = [...db.workOrders.map((w) => w.id), ...(db.upcoming || []).map((w) => w.id)];
  const max = Math.max(...all.map((id) => Number(id.slice(-3))));
  const seq = max + 1;
  return { id: `WHT26${String(seq).padStart(3, '0')}`, salesOrder: `SO-26-0${450 + seq}`, product: PRODUCTS[seq % PRODUCTS.length], qty: 12 + (seq % 3) * 4, deadlineDays: 7 + (seq % 4) };
}

/** Limab sensor: the pipe at the head of the Limab sequence leaves left or right. */
export function simulateLimabMove(direction, opts = {}) {
  return limabMovement({ direction, source: 'SENSOR' }, opts);
}

export function setAutoSim(on) {
  db.settings.autoSim = !!on;
  changed('sim', { autoSim: on });
  scheduleTick(true);
}

export function updateSettings(patch) {
  Object.assign(db.settings, patch);
  changed('sim', patch);
  if ('simIntervalMs' in patch) scheduleTick(true);
}

// ---------------------------------------------------------------------------
// Auto simulation
// ---------------------------------------------------------------------------
const MIN_DWELL_MS = 7000;

function tick() {
  const s = db.settings;
  if (!s.autoSim) return;
  const nowTs = Date.now();
  const options = [];

  const open = db.pipes.filter((p) => p.stage !== STAGE.FINISHED && p.stage !== STAGE.REJECTED).length;
  if (open < 24) options.push({ w: 3, fn: () => releaseNextDmcBatch({ toast: false }) });

  for (const st of db.stations.filter((x) => x.active !== false)) {
    const rt = runtimeOf(st.id);
    const here = atStation(st.id);
    const ready = here.find((p) => p.stage === STAGE.IN && nowTs - p.inAt > MIN_DWELL_MS);
    const humanHere = watching.stationId === st.id;
    if (st.id === 'LIMAB') {
      const head = limabSequence()[0];
      if (head && nowTs - head.markedAt > MIN_DWELL_MS && s.virtualOperators && !humanHere) options.push({ w: 2, fn: () => virtualLimab(head) });
      continue;
    }
    const camOk = st.cameraId && !s.cameraOffline[st.cameraId] && !rt.appLinkDown;
    const queue = queueForStation(st.id);
    if (camOk) {
      if (queue.length && here.length === 0) options.push({ w: 3, fn: () => autoRead(st, 'IN', humanHere) });
      if (ready) options.push({ w: 3, fn: () => autoRead(st, 'OUT', humanHere) });
    } else if (!st.cameraId || s.cameraOffline[st.cameraId]) {
      if (s.virtualOperators && !humanHere) {
        if (queue.length && here.length === 0) options.push({ w: 2, fn: () => operatorTrigger({ stationId: st.id, pipeId: queue[0].id, movementType: 'IN' }, { actor: virtualOperator(st.id), toast: false }) });
        if (ready) options.push({ w: 2, fn: () => operatorTrigger({ stationId: st.id, pipeId: ready.id, movementType: 'OUT' }, { actor: virtualOperator(st.id), toast: false }) });
      }
    }
  }

  if (s.virtualOperators) {
    for (const ev of pendingIdentifications()) {
      if (ev.stationId !== watching.stationId && nowTs - ev.ts > 6000) options.push({ w: 4, fn: () => virtualResolve(ev) });
    }
    for (const tx of pendingInspections()) {
      if (tx.stationId !== watching.stationId && nowTs - tx.ts > 5000) options.push({ w: 4, fn: () => virtualInspect(tx) });
    }
    if (!watching.supervisor) {
      for (const p of heldPipes()) if (nowTs - p.holdAt > 30000) options.push({ w: 2, fn: () => virtualSupervisor(p) });
    }
  }

  for (let n = 0; n < 2 && options.length; n++) {
    const total = options.reduce((a, o) => a + o.w, 0);
    let r = Math.random() * total;
    const idx = options.findIndex((o) => (r -= o.w) <= 0);
    const [opt] = options.splice(idx < 0 ? 0 : idx, 1);
    try {
      opt.fn();
    } catch (err) {
      console.debug('[sim]', err.message);
    }
  }
}

function virtualLimab(pipe) {
  const actor = virtualOperator('LIMAB');
  const flag = drawLimabFlag();
  const defectCode = flag === 'NC' || flag === 'REJECT' ? pickDefect('MARKING') : null;
  setLimabFlag(pipe.id, flag, { actor, defectCode, toast: false });
  limabMovement({ direction: flag === 'GOOD' ? 'LEFT' : 'RIGHT', source: 'SENSOR' }, { actor, toast: false });
}

function autoRead(st, movement, humanHere) {
  const fail = Math.random() < db.settings.readErrorRate;
  const invalid = !fail && Math.random() < db.settings.readErrorRate * 0.15;
  const cam = getCamera(st.cameraId);
  const pipe = pickPipeFor(st.id, movement);
  // virtual operator re-aligns the camera when the pipe size changed (FR-001.3)
  if (!humanHere && db.settings.virtualOperators && pipe && cam.alignedOd && odOf(pipe) !== cam.alignedOd && (cam.misreads || 0) >= 1) {
    autofocus(cam.id, { od: odOf(pipe), actor: virtualOperator(st.id) });
  }
  simulateCameraRead(st.id, movement, { forceError: fail, invalid });
}

function virtualResolve(ev) {
  const actor = virtualOperator(ev.stationId);
  const sug = suggestionsFor(ev.stationId, ev.movementType);
  if (ev.identification.reason === 'DUPLICATE_DMC' || !sug.length) {
    dismissEvent(ev.id, ev.identification.reason === 'DUPLICATE_DMC' ? 'Duplicate DMC checked: not the pipe at this station' : 'No pipe at the read point (false trigger)', { actor });
    return;
  }
  resolveManual(ev.id, sug[0].pipe.id, { actor, mode: 'SUGGESTION', toast: false });
}

function virtualInspect(tx) {
  const st = getStation(tx.stationId);
  const actor = virtualOperator(st.id);
  if (tx.inspection.kind === 'FLAG') {
    const flag = drawLimabFlag();
    submitInspection(tx.id, { result: flag, defectCode: flag === 'NC' || flag === 'REJECT' ? pickDefect('MARKING') : null }, { actor, toast: false });
    return;
  }
  const result = drawResult(st.processType);
  submitInspection(tx.id, { result, defectCode: result === 'NC' ? pickDefect(st.processType) : null }, { actor, toast: false });
}

function virtualSupervisor(p) {
  const actor = db.users.find((u) => u.username === 'hendra.gunawan');
  if (Math.random() < 0.8) releaseHold(p.id, { note: 'Released after QC re-check (auto-sim)' }, { actor, toast: false });
  else rejectHold(p.id, { note: 'Defect confirmed (auto-sim)' }, { actor, toast: false });
}

function checkDwell(nowTs) {
  const rule = ruleOf('DWELL_EXCEEDED');
  if (!rule || rule.enabled === false) return;
  const limitMs = (rule.threshold || 25) * 60e3;
  const atStations = new Set();
  for (const p of db.pipes) {
    if ((p.stage === STAGE.IN || p.stage === STAGE.AWAIT) && p.stationId !== 'LIMAB') {
      atStations.add(p.id);
      if (nowTs - p.inAt > limitMs) raiseAlarm('DWELL_EXCEEDED', `dwell:${p.id}`, `${pipeLabel(p)} has been at ${stationName(p.stationId)} for ${Math.round((nowTs - p.inAt) / 60e3)} min`, { stationId: p.stationId, route: `station-${getStation(p.stationId).slug}`, silent: true });
    }
  }
  for (const a of db.alarms) {
    if (a.code === 'DWELL_EXCEEDED' && a.state !== 'CLEARED' && !atStations.has(a.key.slice(6))) clearAlarm(a.key, { silent: true });
  }
}

function scheduleTick(reset = false) {
  if (reset) clearTimeout(tickTimer);
  tickTimer = setTimeout(() => {
    tick();
    scheduleTick();
  }, db.settings.simIntervalMs || 3000);
}

// ---------------------------------------------------------------------------
// OPC tag values (what Kepware would expose)
// ---------------------------------------------------------------------------
function setTag(tagName, item, value) {
  if (!tagName) return;
  const tag = db.tags.find((t) => t.tagName === tagName && t.item === item);
  if (tag) {
    tag.value = value;
    tag.ts = Date.now();
    tag.holdUntil = Date.now() + 2500;
  }
}

function updateTags() {
  const nowTs = Date.now();
  const lastByStation = {};
  for (let i = db.events.length - 1; i >= 0; i--) {
    const e = db.events[i];
    if (!lastByStation[e.stationId]) lastByStation[e.stationId] = e;
    if (nowTs - e.ts > 3600e3) break;
  }
  const counts = {};
  db.events.forEach((e) => {
    if (e.source === 'OPC') counts[e.stationId] = (counts[e.stationId] || 0) + 1;
  });
  for (const t of db.tags) {
    const st = getStation(t.stationId);
    const rt = runtimeOf(t.stationId);
    const camOffline = st?.cameraId && db.settings.cameraOffline[st.cameraId];
    const last = lastByStation[t.stationId];
    const held = t.holdUntil && t.holdUntil > nowTs;
    if (!held) {
      if (t.type === 'SENSOR') {
        if (t.stationId === 'LIMAB') t.value = !!last && last.direction === t.readPoint && nowTs - last.ts < 3000;
        else if (t.readPoint === 'ENTRY') t.value = queueForStation(t.stationId).length > 0 && atStation(t.stationId).length === 0;
        else t.value = atStation(t.stationId).some((p) => p.stage === STAGE.AWAIT);
      } else {
        switch (t.item) {
          case 'Heartbeat':
            t.value = (Number(t.value) + 1) % 65536;
            break;
          case 'Trigger':
            t.value = !!last && last.cameraId && nowTs - last.ts < 1500;
            break;
          case 'ReadCode':
            t.value = last?.cameraId ? last.barcode || last.rawRead || '' : t.value;
            break;
          case 'ReadStatus':
            t.value = !last?.cameraId ? t.value : last.readStatus === 'OK' ? 0 : 1;
            break;
          case 'RecordMsg':
            t.value = last?.plcMsg ?? t.value;
            break;
          case 'MovementType':
            t.value = !last ? 0 : last.movementType === 'IN' ? 1 : 2;
            break;
          case 'RollStartTime':
            t.value = last?.rollStartAt ? new Date(last.rollStartAt).toISOString().slice(0, 19) : t.value;
            break;
          case 'EventCounter':
            t.value = counts[t.stationId] || 0;
            break;
          default:
            break;
        }
      }
    }
    t.quality = rt.plcDown && t.stationId !== 'LIMAB' ? 'Bad · PLC path down' : camOffline && t.type === 'CAMERA' ? 'Bad · comm failure' : 'Good';
    t.ts = nowTs;
  }
  emit('opc:tags', {});
}

export function startEngines() {
  stopEngines();
  ctmsTimer = setInterval(() => processCtmsQueue(), 1000);
  tagTimer = setInterval(() => {
    updateTags();
    checkDwell(Date.now());
  }, 1000);
  reconTimer = setInterval(() => {
    if (!db.settings.ctmsOutage) runReconciliation({ silent: true });
  }, 60000);
  updateTags();
  scheduleTick(true);
}

export function stopEngines() {
  clearInterval(ctmsTimer);
  clearInterval(tagTimer);
  clearInterval(reconTimer);
  clearTimeout(tickTimer);
}

export { cameraOfStation };

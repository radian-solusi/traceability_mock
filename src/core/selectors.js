// Read-only views over the in-memory data, shaped for the dashboards and tables.
import { db, getStation, getWo, getPipe, getTx, getEvent, stationName, stationCode, activeStations, runtimeOf, cameraOfStation } from './db.js';
import { STAGE, REASONS, queueForStation, atStation, limabSequence, pendingIdentifications, pendingInspections, heldPipes, routeOfPipe, defaultRoute, previousStepLabel, statusLabel } from './traceability.js';
import { startOfDay } from './format.js';
import { activeAlarms } from './alarms.js';

export const STATUS_META = {
  GOOD: { label: 'Good', tone: 'good' },
  NC: { label: 'NC', tone: 'nc' },
  REJECT: { label: 'Reject', tone: 'reject' },
  PENDING: { label: 'Pending', tone: 'pending' },
};

export const STAGE_META = {
  QUEUED: { label: 'In queue', tone: 'info' },
  IN: { label: 'At station', tone: 'active' },
  AWAIT_INSPECTION: { label: 'Awaiting result', tone: 'warn' },
  HOLD: { label: 'On hold', tone: 'nc' },
  FINISHED: { label: 'Finished', tone: 'good' },
  REJECTED: { label: 'Rejected', tone: 'reject' },
};

/** Text used in "Latest Pipe Movement" / "Status Pipe Movement" columns. */
export function movementLabel(pipe) {
  if (!pipe) return '–';
  const route = routeOfPipe(pipe);
  switch (pipe.stage) {
    case STAGE.QUEUED: {
      const step = route.steps[pipe.stepIndex];
      if (pipe.targetStationId) return `To ${stationName(pipe.targetStationId)}`;
      return `To ${step.label}`;
    }
    case STAGE.IN:
      return pipe.stationId === 'LIMAB' ? `At Limab (marked${pipe.limabFlag ? ', flag ' + statusLabel(pipe.limabFlag) : ''})` : `At ${stationName(pipe.stationId)}`;
    case STAGE.AWAIT:
      return pipe.stationId === 'LIMAB' ? 'Left Limab · status flag needed' : `${stationName(pipe.stationId)} · awaiting result`;
    case STAGE.HOLD:
      return `On hold · ${pipe.holdReason || 'NC at ' + stationName(pipe.stationId)}`;
    case STAGE.FINISHED:
      return route.finishLabel || 'Finished';
    case STAGE.REJECTED:
      return 'Reject to NC';
    default:
      return '–';
  }
}

export function locationStation(pipe) {
  if (!pipe) return null;
  if (pipe.stage === STAGE.QUEUED) return pipe.targetStationId;
  return pipe.stationId;
}

export const pipesOfWo = (woId) => db.pipes.filter((p) => p.wo === woId).sort((a, b) => a.pn - b.pn);

export function woProgress(wo) {
  const pipes = pipesOfWo(wo.id);
  const finished = pipes.filter((p) => p.stage === STAGE.FINISHED).length;
  const rejected = pipes.filter((p) => p.stage === STAGE.REJECTED).length;
  const hold = pipes.filter((p) => p.stage === STAGE.HOLD).length;
  const nc = pipes.filter((p) => p.status === 'NC' && p.stage !== STAGE.FINISHED && p.stage !== STAGE.REJECTED).length;
  const received = pipes.length;
  const inLine = received - finished - rejected;
  const done = finished + rejected;
  return { total: wo.qty, received, finished, rejected, hold, nc, inLine, done, pct: wo.qty ? done / wo.qty : 0 };
}

export const cycleTimeMs = (p) => (p.stage === STAGE.FINISHED && p.firstInAt ? p.finishedAt - p.firstInAt : null);

/** Status counts (FR-009 supervisor view) over pipes active today. */
export function statusCounts(nowTs = Date.now()) {
  const day = startOfDay(nowTs);
  const pipes = db.pipes.filter((p) => p.lastMoveAt >= day);
  const c = { total: pipes.length, GOOD: 0, NC: 0, PENDING: 0, REJECT: 0 };
  pipes.forEach((p) => (c[p.status] = (c[p.status] || 0) + 1));
  return c;
}

export function kpis(nowTs = Date.now()) {
  const day = startOfDay(nowTs);
  const finished = db.pipes.filter((p) => p.stage === STAGE.FINISHED);
  const finishedToday = finished.filter((p) => p.finishedAt >= day);
  const cycle = finished
    .filter((p) => p.finishedAt >= nowTs - 24 * 3600e3)
    .map(cycleTimeMs)
    .filter((v) => v != null);
  const camEvents = db.events.filter((e) => (e.source === 'OPC' || e.source === 'KEYENCE' || e.source === 'BUFFER') && e.ts >= day);
  const okReads = camEvents.filter((e) => e.readStatus === 'OK' && e.identification?.reason !== 'NOT_FOUND').length;
  const manualToday = db.events.filter((e) => e.identification?.status === 'RESOLVED' && e.ts >= day).length;
  const toReview = db.pipes.filter((p) => p.stage === STAGE.HOLD || (p.status === 'NC' && p.stage !== STAGE.FINISHED && p.stage !== STAGE.REJECTED));
  return {
    activeWo: db.workOrders.filter((w) => w.status === 'ACTIVE').length,
    validWo: db.workOrders.filter((w) => w.status === 'COMPLETED').length,
    toReview: toReview.length,
    held: heldPipes().length,
    avgCycleMs: cycle.length ? cycle.reduce((a, b) => a + b, 0) / cycle.length : null,
    inLine: db.pipes.filter((p) => [STAGE.QUEUED, STAGE.IN, STAGE.AWAIT, STAGE.HOLD].includes(p.stage)).length,
    finishedToday: finishedToday.length,
    rejectedToday: db.pipes.filter((p) => p.stage === STAGE.REJECTED && p.rejectedAt >= day).length,
    readRate: camEvents.length ? okReads / camEvents.length : null,
    reads: camEvents.length,
    manualToday,
    pendingIds: pendingIdentifications().length,
    pendingInspections: pendingInspections().length,
    ctmsPending: db.transactions.filter((t) => t.ctms?.status === 'PENDING').length,
    ctmsFailed: db.transactions.filter((t) => t.ctms?.status === 'FAILED').length,
    alarms: activeAlarms().length,
    alarmsUnack: activeAlarms().filter((a) => a.state === 'ACTIVE').length,
  };
}

/** Entry / exit (or Limab left / right) sensor states, as published on the OPC tags. */
export function sensorStatus(stationId) {
  const st = getStation(stationId);
  if (!st?.sensors) return [];
  return Object.entries(st.sensors).map(([role, tagName]) => {
    const tag = db.tags.find((t) => t.tagName === tagName && t.item === 'State');
    const rt = runtimeOf(stationId);
    const fault = rt.plcDown && stationId !== 'LIMAB';
    return { role, tagName, label: { entry: 'Entry', exit: 'Exit', left: 'Left', right: 'Right · out' }[role] || role, on: !!tag?.value, quality: fault ? 'Bad' : tag?.quality || 'Good', official: tag?.official || tagName === 'HT-LM-OUT-01' };
  });
}

export function scannerStatus(stationId) {
  const st = getStation(stationId);
  const cam = st?.cameraId ? db.cameras.find((c) => c.id === st.cameraId) : cameraOfStation(stationId);
  if (!cam) return null;
  const rt = runtimeOf(stationId);
  const offline = db.settings.cameraOffline[cam.id];
  return {
    id: cam.id,
    name: cam.name,
    model: cam.model,
    status: offline ? 'OFFLINE' : rt.appLinkDown ? 'DEGRADED' : 'ONLINE',
    path: offline ? null : rt.readPath,
    buffered: rt.buffer.length,
    plcDown: rt.plcDown,
    appLinkDown: rt.appLinkDown,
    alignedOd: cam.alignedOd || null,
    focusMm: cam.focusMm,
  };
}

/** One entry per route step for the "pipe flow between stations" strip. */
export function flowSteps() {
  const route = defaultRoute();
  return route.steps.map((step, i) => {
    const stations = step.stations.map((id) => {
      const st = getStation(id);
      const here = atStation(id);
      return {
        id,
        name: st.name,
        code: st.code,
        slug: st.slug,
        current: here[0] || null,
        atCount: here.length,
        queue: id === 'LIMAB' ? here.filter((p) => p.stage === STAGE.IN).length : queueForStation(id).length,
        pendingIds: pendingIdentifications(id).length,
        pendingInsp: pendingInspections(id).length,
        alarms: activeAlarms().filter((a) => a.stationId === id).length,
      };
    });
    return { index: i, label: step.label, conditional: step.when === 'PREV_NC', stations };
  });
}

/** FR-009 "current pipe": inside the station (IN), else the one waiting for its result; Limab = head of the sequence. */
export function currentPipeAt(stationId) {
  if (stationId === 'LIMAB') return limabSequence()[0] || null;
  const here = atStation(stationId);
  return here.find((p) => p.stage === STAGE.IN) || here[0] || null;
}

export function stationSnapshot(stationId) {
  const st = getStation(stationId);
  const day = startOfDay();
  const txToday = db.transactions.filter((t) => t.stationId === stationId && t.ts >= day);
  const outs = txToday.filter((t) => t.movement === 'OUT');
  const evs = db.events.filter((e) => e.stationId === stationId && (e.source === 'OPC' || e.source === 'KEYENCE' || e.source === 'BUFFER') && e.ts >= day);
  const ok = evs.filter((e) => e.readStatus === 'OK' && e.identification?.reason !== 'NOT_FOUND').length;
  const results = outs.filter((t) => t.inspection?.result);
  const rejectsToday = db.pipes.filter((p) => p.stage === STAGE.REJECTED && p.rejectedAt >= day && p.stationId === stationId).length;
  const queue = stationId === 'LIMAB' ? [] : queueForStation(stationId);
  const at = atStation(stationId);
  return {
    station: st,
    queue,
    at,
    pendingIds: pendingIdentifications(stationId),
    pendingInsp: pendingInspections(stationId),
    inToday: txToday.filter((t) => t.movement === 'IN').length,
    outToday: outs.length,
    readRate: evs.length ? ok / evs.length : null,
    reads: evs.length,
    good: results.filter((t) => t.inspection.result === 'GOOD').length,
    nc: results.filter((t) => t.inspection.result === 'NC').length,
    reject: rejectsToday,
    pendingFlag: results.filter((t) => t.inspection.result === 'PENDING').length,
    pending: (stationId === 'LIMAB' ? at.filter((p) => p.stage === STAGE.IN).length : queue.length) + at.filter((p) => p.stage === STAGE.AWAIT).length,
    manual: txToday.filter((t) => t.method === 'MANUAL').length,
    lastEvent: [...db.events].reverse().find((e) => e.stationId === stationId) || null,
  };
}

/** FR-009 supervisor table: per station current and pending pipe movement status. */
export function stationStatusRows() {
  return activeStations()
    .filter((s) => s.dashboard)
    .map((s) => {
      const snap = stationSnapshot(s.id);
      const scn = scannerStatus(s.id);
      const sensors = sensorStatus(s.id);
      const current = currentPipeAt(s.id);
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        slug: s.slug,
        current: current?.id || null,
        currentStage: current?.stage || null,
        queue: s.id === 'LIMAB' ? snap.at.filter((p) => p.stage === STAGE.IN).length : snap.queue.length,
        processed: snap.outToday,
        good: snap.good,
        nc: snap.nc,
        pending: snap.pending,
        reject: snap.reject,
        scanner: scn ? scn.status : 'NONE',
        scannerPath: scn?.path || null,
        sensorFault: sensors.some((x) => x.quality !== 'Good'),
        tasks: snap.pendingIds.length + snap.pendingInsp.length,
        alarms: activeAlarms().filter((a) => a.stationId === s.id).length,
      };
    });
}

export function recentTransactions({ stationId, limit = 50, pipeId } = {}) {
  const out = [];
  for (let i = db.transactions.length - 1; i >= 0 && out.length < limit; i--) {
    const t = db.transactions[i];
    if (stationId && t.stationId !== stationId) continue;
    if (pipeId && t.pipeId !== pipeId) continue;
    out.push(t);
  }
  return out;
}

export function recentEvents({ stationId, limit = 50, source, sources } = {}) {
  const out = [];
  for (let i = db.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = db.events[i];
    if (stationId && e.stationId !== stationId) continue;
    if (source && e.source !== source) continue;
    if (sources && !sources.includes(e.source)) continue;
    out.push(e);
  }
  return out;
}

export const CAMERA_SOURCES = ['OPC', 'KEYENCE', 'BUFFER'];

/** Rows for the "Data Matrix Reading Status" table (camera reads, any path). */
export function readingStatusRows(limit = 40, stationId) {
  return recentEvents({ sources: CAMERA_SOURCES, limit, stationId }).map((e) => {
    const pipeId = e.identification?.pipeId;
    const pipe = pipeId ? getPipe(pipeId) : null;
    const tx = e.txId ? getTx(e.txId) : null;
    return {
      id: e.id,
      ts: e.ts,
      stationId: e.stationId,
      station: stationName(e.stationId),
      code: stationCode(e.stationId),
      movement: e.movementType,
      wo: pipe?.wo || '–',
      pn: pipe?.pn ?? null,
      dmc: e.barcode || e.rawRead || null,
      readStatus: e.readStatus,
      readPath: e.readPath,
      source: e.source,
      idStatus: e.identification?.status || '–',
      method: e.duplicateOf ? 'UPDATED' : tx?.method || (e.identification?.status === 'REQUIRED' ? 'PENDING' : '–'),
      rollStartAt: e.rollStartAt,
      readAt: e.readAt,
      loadTs: pipe?.queuedAt ?? null,
    };
  }).sort((a, b) => b.ts - a.ts);
}

/** FR-006 exceptions: identification exceptions + CTMS failures + DMC batch duplicates. */
export function exceptionRows(limit = 400) {
  const rows = [];
  for (let i = db.events.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = db.events[i];
    const id = e.identification;
    if (!id?.reason || !REASONS[id.reason]) continue;
    rows.push({
      id: e.id,
      ts: e.ts,
      type: id.reason,
      label: REASONS[id.reason],
      station: stationName(e.stationId),
      stationId: e.stationId,
      detail: id.reason === 'READ_ERROR' ? `${e.movementType} · no DMC decoded` : id.reason === 'NOT_FOUND' ? `${e.movementType} · read “${e.rawRead}”` : id.detail || '',
      state: id.status === 'REQUIRED' ? 'OPEN' : id.status === 'DISMISSED' ? 'DISMISSED' : 'RESOLVED',
      resolution: id.status === 'REQUIRED' ? 'Waiting for operator' : id.status === 'DISMISSED' ? `Dismissed by ${id.by}: ${id.note}` : `${id.by} → ${getPipe(id.pipeId) ? `PN ${getPipe(id.pipeId).pn} · ${getPipe(id.pipeId).wo}` : '–'}${e.duplicateOf ? ' (existing transaction updated)' : ''}`,
    });
  }
  for (const t of db.transactions) {
    if (t.ctms?.status === 'FAILED' || (t.ctms?.history || []).some((h) => h.status === 'FAILED')) {
      const lastFail = [...t.ctms.history].reverse().find((h) => h.status === 'FAILED');
      rows.push({
        id: `C-${t.id}`,
        ts: lastFail?.at || t.ctms.lastAttemptAt || t.ts,
        type: 'CTMS_NO_RESPONSE',
        label: 'CTMS not responding',
        station: stationName(t.stationId),
        stationId: t.stationId,
        detail: `${t.id} · PN ${t.pn} · ${t.wo} · ${lastFail?.message || ''}`,
        state: t.ctms.status === 'FAILED' ? 'OPEN' : 'RESOLVED',
        resolution: t.ctms.status === 'SUCCESS' ? `Accepted after ${t.ctms.attempts} attempt(s) · ${t.ctms.ref}` : t.ctms.status === 'PENDING' ? 'Retry queued' : 'Retry needed',
      });
    }
  }
  for (const x of db.dmcExceptions) {
    rows.push({ id: x.id, ts: x.ts, type: 'DUPLICATE_DMC', label: 'Duplicate DMC', station: 'DMC API', stationId: null, detail: `${x.dmc} · ${x.reason} (batch ${x.batchId})`, state: 'RESOLVED', resolution: 'Rejected from the batch, existing pipe kept' });
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function pipeTimeline(pipeId) {
  const pipe = getPipe(pipeId);
  if (!pipe) return [];
  const items = [];
  const batch = db.dmcBatches.find((b) => b.id === pipe.batchId);
  items.push({ ts: pipe.markedAt, kind: 'dmc', title: 'DMC printed at Limab', detail: `Master data via DMC API${batch ? ` (${batch.id})` : ''} · pipe information from CTMS via CT-Track`, stationId: 'LIMAB' });
  for (const txId of pipe.history) {
    const t = getTx(txId);
    if (!t) continue;
    const dir = t.direction ? ` (${t.direction === 'LEFT' ? 'left · to next station' : 'right · out station'})` : '';
    const path = t.readPath === 'OPT2' ? ' · option 2 direct camera' : t.readPath === 'OPT1' ? ' · option 1 PLC → OPC' : '';
    items.push({ ts: t.ts, kind: t.movement === 'IN' ? 'in' : 'out', title: `${t.movement} · ${stationName(t.stationId)}${dir}`, detail: `${t.method === 'AUTO' ? 'Automatic' : 'Manual'} identification · ${t.operator}${path}${t.updates ? ` · existing transaction updated ×${t.updates}` : ''}`, tx: t, stationId: t.stationId });
    if (t.inspection?.result) {
      const isFlag = t.inspection.kind === 'FLAG';
      items.push({ ts: t.inspection.ts, kind: 'inspection', title: `${isFlag ? 'Status flag' : 'Inspection result'}: ${STATUS_META[t.inspection.result].label}`, detail: `${t.inspection.defectCode ? t.inspection.defectCode + ' · ' : ''}${t.inspection.by}${t.inspection.remarks ? ' · “' + t.inspection.remarks + '”' : ''}`, tx: t, result: t.inspection.result, stationId: t.stationId });
      for (const c of t.inspection.corrections || []) {
        items.push({ ts: c.ts, kind: 'correction', title: `Corrected ${STATUS_META[c.from].label} → ${STATUS_META[c.to].label}`, detail: `${c.by} · ${c.reason}`, tx: t });
      }
      if (t.ctms && t.ctms.status !== 'N/A') {
        items.push({ ts: t.ctms.lastAttemptAt || t.ctms.queuedAt, kind: 'ctms', title: `CTMS (via CT-Track) ${t.ctms.status.toLowerCase()}`, detail: t.ctms.response ? `${t.ctms.response.httpStatus} · ${t.ctms.response.message}${t.ctms.ref ? ' · ' + t.ctms.ref : ''}` : 'Queued for submission', tx: t, ctms: t.ctms.status });
      }
    }
  }
  if (pipe.holdAt && (pipe.stage === STAGE.HOLD || pipe.holdDecision)) {
    items.push({ ts: pipe.holdAt, kind: 'hold', title: 'Placed on hold', detail: pipe.holdReason || (pipe.concession ? `at ${pipe.concession.station}` : '') });
  }
  if (pipe.holdDecision) items.push({ ts: pipe.holdDecision.ts, kind: pipe.holdDecision.action === 'REJECT' ? 'reject' : 'release', title: { RELEASE: 'Released by supervisor', REINSPECT: 'Sent back for re-inspection', REJECT: 'Rejected by supervisor' }[pipe.holdDecision.action], detail: `${pipe.holdDecision.by}${pipe.concession?.note ? ' · ' + pipe.concession.note : ''}` });
  if (pipe.stage === STAGE.FINISHED) items.push({ ts: pipe.finishedAt, kind: 'finish', title: routeOfPipe(pipe).finishLabel, detail: `Cycle time from Limab: ${(cycleTimeMs(pipe) / 3600e3).toFixed(1)} h` });
  if (pipe.stage === STAGE.REJECTED && !pipe.holdDecision) items.push({ ts: pipe.rejectedAt, kind: 'reject', title: 'Rejected · moved to NC rack', detail: '' });
  return items.sort((a, b) => a.ts - b.ts);
}

export function searchPipes(q, limit = 20) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const pn = s.replace(/^pn\s*/, '');
  return db.pipes
    .filter((p) => p.dmc.toLowerCase().includes(s) || p.id.toLowerCase().includes(s) || p.wo.toLowerCase() === s || String(p.pn) === pn || p.heat.toLowerCase() === s)
    .slice(0, limit);
}

export function cameraStats(cam) {
  const reads = cam.reads || 0;
  const fails = cam.fails || 0;
  const invalid = cam.invalid || 0;
  return { reads, fails, invalid, rate: reads ? (reads - fails - invalid) / reads : null };
}

export const stationsForDashboard = () => activeStations().filter((s) => s.dashboard);
export const woById = (id) => getWo(id);
export const eventById = (id) => getEvent(id);
export { previousStepLabel };

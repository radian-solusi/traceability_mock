// Builds the initial plant state.
// Instead of hand-writing records, it simulates the last ~30 hours of production
// (DMC marking, Limab status flags and left/right movements, station capacity, buffer times,
// read failures, duplicate reads, a PLC outage with option-2 reading, inspection results,
// supervisor decisions, CTMS submissions) and replays every action through the same domain
// functions the UI uses. Same seed → same picture on every load, shifted to "now".
import { db, resetDb, reindex, getStation, getPipe, getTx, getCamera, getWo, runtimeOf } from '../core/db.js';
import {
  LINES,
  STATIONS,
  ROUTES,
  DEFECTS,
  USERS,
  ROLES,
  AD_GROUPS,
  MODULES,
  PLCS,
  CONCENTRATORS,
  CAMERAS,
  SERVERS,
  DESKTOPS,
  INTEGRATIONS,
  SYSTEM_PARAMS,
  ALARM_RULES,
  SEED_WORK_ORDERS,
  UPCOMING_WORK_ORDERS,
  buildTags,
} from './masterData.js';
import { mulberry32, pad, startOfDay } from '../core/format.js';
import {
  receiveDmcBatch,
  ingestEvent,
  resolveManual,
  operatorTrigger,
  submitInspection,
  setLimabFlag,
  limabMovement,
  releaseHold,
  rejectHold,
  nextStepIndex,
  queueForStation,
  atStation,
  pendingIdentifications,
  pendingInspections,
  heldPipes,
  STAGE,
  pipeLabel,
} from '../core/traceability.js';
import { settleCtms, runReconciliation } from '../core/ctms.js';
import { audit, notify } from '../core/audit.js';
import { raiseAlarm, clearAlarm, ackAlarm } from '../core/alarms.js';

const MIN = 60e3;
const clone = (x) => JSON.parse(JSON.stringify(x));

// Good share per process type (production points record Good / NC only, Rev 1)
const GOOD_ODDS = { EMI: 0.89, PROVEUP: 0.9, MEASURE: 0.97, HYDRO: 0.965, UT: 0.955 };
// Limab status flag (FR-005): Good, NC, Pending, Reject
const FLAG_ODDS = [
  ['GOOD', 0.955],
  ['NC', 0.02],
  ['PENDING', 0.015],
  ['REJECT', 0.01],
];

const REMARKS = {
  NC: ['Indication near box end, send to prove-up', 'Re-check requested', 'Marginal reading, second opinion needed', 'Indication 2.1 m from pin end'],
  FLAG: ['Stencil partly missing', 'DMC print grade C', 'Waiting for QC decision', 'Surface mark near pin end'],
};

export function drawResult(processType, rand = Math.random) {
  return rand() < (GOOD_ODDS[processType] ?? 0.95) ? 'GOOD' : 'NC';
}

export function drawLimabFlag(rand = Math.random) {
  let r = rand();
  for (const [flag, p] of FLAG_ODDS) {
    if (r < p) return flag;
    r -= p;
  }
  return 'GOOD';
}

export function pickDefect(processType, rand = Math.random) {
  const list = DEFECTS[processType] || [];
  return list.length ? list[Math.floor(rand() * list.length)].id : null;
}

/** Pipe entry of a DMC batch. Only the pipe number: the documents list no other per-pipe fields. */
export function pipeSpec(woId, product, pn, rand = Math.random) {
  rand(); // keeps the seeded sequence (and so the demo plant) the same as before the field removal
  return { pn };
}

const FOCUS_FOR_OD = { '13 3/8"': 350, '9 5/8"': 410, '7"': 455, '4 1/2"': 505, '3 1/2"': 520 };

export function seedDatabase(nowTs = Date.now()) {
  resetDb();
  db.lines = clone(LINES);
  db.stations = clone(STATIONS);
  db.routes = clone(ROUTES);
  db.defects = clone(DEFECTS);
  db.users = clone(USERS).map((u) => ({ ...u, upn: `${u.username}@ptct.local`, lastLogin: null }));
  db.roles = clone(ROLES);
  db.adGroups = clone(AD_GROUPS);
  db.permissions = Object.fromEntries(MODULES.map((m) => [m.key, { name: m.name, Admin: m.Admin, Supervisor: m.Supervisor, Operator: m.Operator, Reporting: m.Reporting }]));
  db.plcs = clone(PLCS);
  db.concentrators = clone(CONCENTRATORS);
  db.cameras = clone(CAMERAS).map((c) => ({ ...c, reads: 0, fails: 0, invalid: 0, misreads: 0, lastCode: null, lastStatus: null, lastTs: null, alignedOd: null, tuneMargin: null, lastTuneAt: null }));
  db.tags = buildTags(db.stations, db.cameras);
  db.servers = clone(SERVERS);
  db.desktops = clone(DESKTOPS);
  db.integrations = Object.fromEntries(Object.entries(clone(INTEGRATIONS)).map(([k, v]) => [k, { ...v, lastAt: null, today: 0, errors: 0, latencyMs: null }]));
  db.systemParams = clone(SYSTEM_PARAMS);
  db.alarmRules = clone(ALARM_RULES);
  db.upcoming = clone(UPCOMING_WORK_ORDERS);
  db.stations.forEach((s) => runtimeOf(s.id));
  reindex();

  const rand = mulberry32(20261030);
  const plan = buildPlan(nowTs, rand);
  replay(plan, nowTs, rand);
  ensureDemoState(nowTs, rand);
  finalizeCounters(nowTs);
  db.audit.sort((a, b) => b.ts - a.ts);
  db.seededAt = nowTs;
}

// ---------------------------------------------------------------------------
// 1. Plan: discrete simulation of the line with station capacity
// ---------------------------------------------------------------------------
function buildPlan(nowTs, rand) {
  const route = db.routes[0];
  const between = (a, b) => a + rand() * (b - a);
  const actions = [];
  const free = {};
  const sim = [];

  // a PLC / OPC outage at Hydrotest Brandt in the past: reads switch to option 2
  actions.push({ ts: nowTs - 7.2 * 3600e3, type: 'PLC_DOWN', stationId: 'HYD_B' });
  actions.push({ ts: nowTs - 6.5 * 3600e3, type: 'PLC_UP', stationId: 'HYD_B' });
  // a scanner outage at PAUT
  actions.push({ ts: nowTs - 10.4 * 3600e3, type: 'CAM_OFF', cameraId: 'HT-E2-SCN-01' });
  actions.push({ ts: nowTs - 10.0 * 3600e3, type: 'CAM_ON', cameraId: 'HT-E2-SCN-01' });

  for (const wo of SEED_WORK_ORDERS) {
    const start = nowTs - wo.startHoursAgo * 3600e3;
    const deadline = startOfDay(nowTs) + wo.deadlineDays * 86400e3 + 17 * 3600e3;
    let t = start;
    let pn = 1;
    while (pn <= wo.qty) {
      const count = Math.min(6, wo.qty - pn + 1);
      const pipes = [];
      for (let k = 0; k < count; k++, pn++) pipes.push(pipeSpec(wo.id, wo.product, pn, rand));
      actions.push({ ts: t, type: 'DMC', spec: { woId: wo.id, salesOrder: wo.salesOrder, product: wo.product, qty: wo.qty, deadline, pipes } });
      pipes.forEach((p, k) => sim.push({ id: `${wo.id}-${pad(p.pn, 3)}`, readyAt: t, markedAt: t, order: k, step: 0, prev: 'GOOD', alive: true }));
      t += between(20, 28) * MIN;
    }
  }

  for (let i = 0; i < route.steps.length; i++) {
    const step = route.steps[i];
    const candidates = sim.filter((p) => p.alive && p.step === i).sort((a, b) => a.readyAt - b.readyAt || a.order - b.order);
    for (const p of candidates) {
      if (step.when === 'PREV_NC' && p.prev !== 'NC') {
        p.step = i + 1;
        continue;
      }
      if (i === 0) {
        // Limab: status flag, then left (next station) or right (out station)
        const flag = drawLimabFlag(rand);
        const outAt = Math.max(p.markedAt + between(3, 8) * MIN, (free.LIMAB || 0) + between(1.5, 3) * MIN);
        free.LIMAB = outAt;
        const direction = flag === 'GOOD' ? 'LEFT' : 'RIGHT';
        actions.push({ ts: outAt - between(0.5, 2) * MIN, type: 'LIMAB_FLAG', pipeId: p.id, flag, defect: flag === 'NC' || flag === 'REJECT' ? pickDefect('MARKING', rand) : null });
        actions.push({ ts: outAt, type: 'LIMAB_OUT', pipeId: p.id, direction });
        if (flag === 'REJECT') {
          p.alive = false;
          continue;
        }
        if (direction === 'RIGHT') {
          const decideAt = outAt + between(20, 60) * MIN;
          const release = rand() < 0.8;
          actions.push({ ts: decideAt, type: release ? 'RELEASE' : 'REJECT_HOLD', pipeId: p.id });
          if (!release) {
            p.alive = false;
            continue;
          }
          p.readyAt = decideAt;
        } else p.readyAt = outAt;
        p.prev = 'GOOD';
        p.step = 1;
        continue;
      }
      const stationId = step.stations.reduce((best, s) => ((free[s] || 0) < (free[best] || 0) ? s : best), step.stations[0]);
      const st = getStation(stationId);
      const arrive = p.readyAt + between(step.waitMin[0], step.waitMin[1]) * MIN;
      const inAt = Math.max(arrive, (free[stationId] || 0) + between(0.5, 1.5) * MIN);
      const outAt = inAt + between(st.cycleMin[0], st.cycleMin[1]) * MIN;
      free[stationId] = outAt;
      const result = drawResult(st.processType, rand);
      const defect = result === 'NC' ? pickDefect(st.processType, rand) : null;
      const resultAt = outAt + between(0.4, 1.8) * MIN;
      const camera = !!st.cameraId;
      actions.push({ ts: inAt, type: 'MOVE', pipeId: p.id, stationId, movement: 'IN', camera, readFail: camera && rand() < 0.07, invalid: camera && rand() < 0.01, reread: camera && rand() < 0.03 });
      actions.push({ ts: outAt, type: 'MOVE', pipeId: p.id, stationId, movement: 'OUT', camera, readFail: camera && rand() < 0.05, invalid: false, reread: false });
      actions.push({ ts: resultAt, type: 'RESULT', pipeId: p.id, stationId, result, defect });
      if (result === 'NC') {
        const j = nextStepIndex(route, i, 'NC');
        if (j >= 0 && route.steps[j].when === 'PREV_NC') {
          p.prev = 'NC';
          p.step = j;
          p.readyAt = resultAt;
          continue;
        }
        const decideAt = resultAt + between(15, 45) * MIN;
        const release = rand() < 0.85;
        actions.push({ ts: decideAt, type: release ? 'RELEASE' : 'REJECT_HOLD', pipeId: p.id });
        if (!release) {
          p.alive = false;
          continue;
        }
        p.prev = 'GOOD';
        p.step = nextStepIndex(route, i, 'GOOD');
        p.readyAt = decideAt;
        if (p.step < 0) p.alive = false;
        continue;
      }
      p.prev = 'GOOD';
      p.step = nextStepIndex(route, i, 'GOOD');
      p.readyAt = resultAt;
      if (p.step < 0) p.alive = false;
    }
  }

  const order = { PLC_DOWN: 0, PLC_UP: 0, CAM_OFF: 0, CAM_ON: 0, DMC: 1, LIMAB_FLAG: 2, LIMAB_OUT: 3, MOVE: 4, RESULT: 5, RELEASE: 6, REJECT_HOLD: 6 };
  return actions.sort((a, b) => a.ts - b.ts || order[a.type] - order[b.type]);
}

// ---------------------------------------------------------------------------
// 2. Replay the plan up to "now" through the real domain functions
// ---------------------------------------------------------------------------
function replay(actions, nowTs, rand) {
  const operatorFor = (stationId) =>
    db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.defaultStation === stationId) ||
    db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.stations.includes(stationId)) ||
    db.users.find((u) => u.role === 'Supervisor');
  const supervisor = db.users.find((u) => u.username === 'andi.pratama');
  const admin = db.users.find((u) => u.username === 'maria.tan');
  let dupDone = false;

  for (const a of actions) {
    if (a.ts > nowTs) continue;
    const base = { silent: true, ts: a.ts };
    try {
      switch (a.type) {
        case 'PLC_DOWN':
        case 'PLC_UP': {
          const rt = runtimeOf(a.stationId);
          rt.plcDown = a.type === 'PLC_DOWN';
          rt.readPath = rt.plcDown ? 'OPT2' : 'OPT1';
          const st = getStation(a.stationId);
          if (rt.plcDown) raiseAlarm('OPTION2_ACTIVE', `opt2:${a.stationId}`, `${st.name}: PLC / OPC path not available, reading ${st.cameraId} directly from the application (option 2)`, { stationId: a.stationId, ...base });
          else {
            const al = db.alarms.find((x) => x.key === `opt2:${a.stationId}` && x.state === 'ACTIVE');
            if (al) ackAlarm(al.id, supervisor, { ts: a.ts - 20 * MIN, silent: true });
            clearAlarm(`opt2:${a.stationId}`, base);
          }
          audit(null, 'Simulator', rt.plcDown ? 'PLC / OPC path down' : 'PLC / OPC path restored', `${st.name} → reading via ${rt.plcDown ? 'option 2 (direct camera)' : 'option 1 (PLC → OPC)'}`, { category: 'Integration', ...base });
          break;
        }
        case 'CAM_OFF':
        case 'CAM_ON': {
          const cam = getCamera(a.cameraId);
          db.settings.cameraOffline[a.cameraId] = a.type === 'CAM_OFF';
          if (a.type === 'CAM_OFF') raiseAlarm('SCANNER_OFFLINE', `scanner:${a.cameraId}`, `${a.cameraId} at ${getStation(cam.stationId).name} does not answer on either reading path`, { stationId: cam.stationId, ...base });
          else {
            const al = db.alarms.find((x) => x.key === `scanner:${a.cameraId}` && x.state === 'ACTIVE');
            if (al) ackAlarm(al.id, admin, { ts: a.ts - 15 * MIN, silent: true });
            clearAlarm(`scanner:${a.cameraId}`, base);
          }
          break;
        }
        case 'DMC': {
          const spec = { ...a.spec, pipes: [...a.spec.pipes] };
          // one historical re-sent DMC (FR-006 duplicate DMC) in a WHT26119 batch
          if (!dupDone && spec.woId === 'WHT26119') {
            const prev = db.pipes.find((p) => p.wo === 'WHT26118' && p.pn === 12);
            if (prev) {
              spec.pipes.push({ pn: 950, dmc: prev.dmc });
              dupDone = true;
              const batchTs = a.ts;
              receiveDmcBatch(spec, base);
              const al = db.alarms.find((x) => x.key === `dmc:${prev.dmc}`);
              if (al) {
                ackAlarm(al.id, admin, { ts: batchTs + 12 * MIN, silent: true });
                clearAlarm(al.key, { ts: batchTs + 14 * MIN, silent: true });
              }
              break;
            }
          }
          receiveDmcBatch(spec, base);
          break;
        }
        case 'LIMAB_FLAG': {
          const pipe = getPipe(a.pipeId);
          if (!pipe || pipe.stage !== STAGE.IN || pipe.stationId !== 'LIMAB') break;
          setLimabFlag(a.pipeId, a.flag, { ...base, actor: operatorFor('LIMAB'), defectCode: a.defect, remarks: a.flag === 'GOOD' ? '' : pickRemark('FLAG', rand) });
          break;
        }
        case 'LIMAB_OUT': {
          const pipe = getPipe(a.pipeId);
          if (!pipe || pipe.stage !== STAGE.IN || pipe.stationId !== 'LIMAB') break;
          const tx = limabMovement({ direction: a.direction, pipeId: a.pipeId, source: 'SENSOR' }, { ...base, actor: operatorFor('LIMAB') });
          if (nowTs - a.ts > 4 * MIN && tx.ctms?.status === 'PENDING') settleCtms(tx, 'SUCCESS', a.ts + 2500);
          break;
        }
        case 'MOVE': {
          const pipe = getPipe(a.pipeId);
          if (!pipe) break;
          const op = operatorFor(a.stationId);
          const st = getStation(a.stationId);
          const camOffline = st.cameraId && db.settings.cameraOffline[st.cameraId];
          if (!a.camera || camOffline) {
            operatorTrigger({ stationId: a.stationId, pipeId: a.pipeId, movementType: a.movement }, { ...base, actor: op });
            break;
          }
          // camera alignment follows the pipe size (FR-001.3): re-tune when the OD changes
          const cam = getCamera(st.cameraId);
          const od = getWo(pipe.wo)?.product.od;
          if (od && cam.alignedOd !== od) {
            const tuneTs = a.ts - (1 + rand() * 2) * MIN;
            const before = { focusMm: cam.focusMm, alignedFor: cam.alignedOd || '–' };
            cam.focusMm = Math.round((FOCUS_FOR_OD[od] || cam.focusMm) + (rand() * 14 - 7));
            cam.alignedOd = od;
            cam.tuneMargin = Math.round(78 + rand() * 18);
            cam.lastTuneAt = tuneTs;
            if (before.alignedFor !== '–') audit(op, 'Station', 'Camera autofocus', `${cam.id} at ${st.name} tuned for ${od} · read margin ${cam.tuneMargin} %`, { before, after: { focusMm: cam.focusMm, alignedFor: od }, category: 'Operation', silent: true, ts: tuneTs });
          }
          const rt = runtimeOf(a.stationId);
          const barcode = a.readFail ? null : a.invalid ? pipe.dmc.replace(/\d(?=\d{2}-)/, '?') : pipe.dmc;
          const ev = ingestEvent({ stationId: a.stationId, movementType: a.movement, barcode, readStatus: a.readFail ? 'NO_READ' : 'OK', source: rt.readPath === 'OPT2' ? 'KEYENCE' : 'OPC' }, base);
          if (ev.identification?.status === 'REQUIRED') {
            const at = a.ts + (a.movement === 'IN' ? 30 + rand() * 70 : 12 + rand() * 8) * 1000;
            if (at <= nowTs) resolveManual(ev.id, a.pipeId, { silent: true, ts: at, actor: op, mode: rand() < 0.8 ? 'SUGGESTION' : 'LIST' });
          } else if (a.reread && a.ts + 4000 <= nowTs) {
            // the scanner triggers twice on the same pipe → UC-002 3a: existing transaction updated
            ingestEvent({ stationId: a.stationId, movementType: a.movement, barcode: pipe.dmc, readStatus: 'OK', source: rt.readPath === 'OPT2' ? 'KEYENCE' : 'OPC' }, { silent: true, ts: a.ts + 4000 });
          }
          break;
        }
        case 'RESULT': {
          const pipe = getPipe(a.pipeId);
          if (!pipe?.awaitTxId) break;
          const tx = submitInspection(pipe.awaitTxId, { result: a.result, defectCode: a.defect, remarks: a.result === 'GOOD' ? '' : pickRemark('NC', rand) }, { ...base, actor: operatorFor(a.stationId) });
          if (nowTs - a.ts > 4 * MIN) settleCtms(tx, 'SUCCESS', a.ts + 2000 + rand() * 3000);
          break;
        }
        case 'RELEASE':
        case 'REJECT_HOLD': {
          const pipe = getPipe(a.pipeId);
          if (pipe?.stage !== STAGE.HOLD) break;
          if (a.type === 'RELEASE') releaseHold(a.pipeId, { note: 'Reviewed with QC: within acceptance criteria' }, { ...base, actor: supervisor });
          else rejectHold(a.pipeId, { note: 'Defect confirmed by QC' }, { ...base, actor: supervisor });
          const tx = getTx(pipe.holdDecision?.txId);
          if (tx?.ctms?.status === 'PENDING' && nowTs - a.ts > 4 * MIN) settleCtms(tx, 'SUCCESS', a.ts + 2200);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn('[seed] skipped', a.type, a.pipeId || '', err.message);
    }
  }
}

function pickRemark(kind, rand) {
  const list = REMARKS[kind] || [''];
  return list[Math.floor(rand() * list.length)];
}

// ---------------------------------------------------------------------------
// 3. Guarantee there is something to show in every demo screen at start-up
// ---------------------------------------------------------------------------
function ensureDemoState(nowTs, rand) {
  const supervisor = db.users.find((u) => u.username === 'andi.pratama');
  const admin = db.users.find((u) => u.username === 'maria.tan');
  const op = (id) => db.users.find((u) => u.status === 'ACTIVE' && u.defaultStation === id) || db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.stations.includes(id)) || supervisor;

  // a) pending identification (camera read failed) at a camera station
  if (!pendingIdentifications().some((e) => e.source === 'OPC')) {
    const ids = ['WMS', 'PAUT', 'HYD_Y', 'HYD_B', 'SEA_W', 'SEA_E'];
    const target = ids.find((id) => queueForStation(id).length && !atStation(id).length) || ids.find((id) => queueForStation(id).length);
    if (target) ingestEvent({ stationId: target, movementType: 'IN', barcode: null, readStatus: 'NO_READ', source: 'OPC' }, { silent: true, ts: nowTs - 45e3 });
  }

  // b) pending inspection result at a hydrotest
  if (!pendingInspections().some((t) => t.stationId === 'HYD_Y' || t.stationId === 'HYD_B')) {
    for (const id of ['HYD_Y', 'HYD_B']) {
      const pipe = atStation(id).find((p) => p.stage === STAGE.IN && p.inAt < nowTs - 2 * MIN);
      if (pipe) {
        const ts = Math.min(nowTs - 20e3, Math.max(nowTs - 70e3, pipe.inAt + 60e3));
        ingestEvent({ stationId: id, movementType: 'OUT', barcode: pipe.dmc, readStatus: 'OK', source: 'OPC' }, { silent: true, ts });
        break;
      }
    }
  }

  // c) one pipe on hold for supervisor review (NC at a station without prove-up after it)
  if (!heldPipes().some((p) => p.stationId !== 'LIMAB')) {
    for (const id of ['PAUT', 'HYD_B', 'HYD_Y']) {
      let pipe = atStation(id).find((p) => p.stage === STAGE.IN && p.inAt < nowTs - 4 * MIN);
      let outTs = pipe ? Math.min(nowTs - 2 * MIN, Math.max(pipe.inAt + 3 * MIN, nowTs - 9 * MIN)) : null;
      if (!pipe && !atStation(id).length) {
        const q = queueForStation(id).find((p) => p.queuedAt < nowTs - 20 * MIN);
        if (q) {
          ingestEvent({ stationId: id, movementType: 'IN', barcode: q.dmc, readStatus: 'OK', source: 'OPC' }, { silent: true, ts: nowTs - 16 * MIN });
          pipe = q;
          outTs = nowTs - 9 * MIN;
        }
      }
      if (pipe && pipe.stage === STAGE.IN) {
        const out = ingestEvent({ stationId: id, movementType: 'OUT', barcode: pipe.dmc, readStatus: 'OK', source: 'OPC' }, { silent: true, ts: outTs });
        const st = getStation(id);
        submitInspection(out.txId, { result: 'NC', defectCode: pickDefect(st.processType, rand), remarks: 'Marginal reading, second opinion needed' }, { silent: true, ts: outTs + 60e3, actor: op(id) });
        settleCtms(getTx(out.txId), 'SUCCESS', outTs + 63e3);
        break;
      }
    }
  }

  // d) Limab: marked pipes waiting (the robot marked a batch a few minutes ago), one already flagged
  if (!atStation('LIMAB').some((p) => p.stage === STAGE.IN)) {
    const up = db.upcoming.shift();
    if (up) {
      const pipes = Array.from({ length: 4 }, (_, k) => pipeSpec(up.id, up.product, k + 1, rand));
      receiveDmcBatch({ woId: up.id, salesOrder: up.salesOrder, product: up.product, qty: up.qty, deadline: startOfDay(nowTs) + up.deadlineDays * 86400e3 + 17 * 3600e3, pipes }, { silent: true, ts: nowTs - 4 * MIN });
      if (up.qty > 4) db.upcoming.unshift(up);
    }
  }
  const seq = atStation('LIMAB').filter((p) => p.stage === STAGE.IN);
  if (seq.length && !seq.some((p) => p.limabFlag)) setLimabFlag(seq[0].id, 'GOOD', { silent: true, ts: nowTs - 50e3, actor: op('LIMAB') });

  // e) CTMS submissions that failed after automatic retries (retry demo)
  const candidates = db.transactions.filter((t) => t.ctms?.status === 'SUCCESS' && t.inspection?.kind === 'RESULT' && t.ts > nowTs - 90 * MIN && t.ts < nowTs - 10 * MIN);
  candidates.slice(-2).forEach((tx, i) => {
    const pipe = getPipe(tx.pipeId);
    tx.ctms.history = [];
    const first = tx.ctms.queuedAt + 1500;
    const msg = i ? 'CT-Track: CTMS service unavailable (maintenance window)' : 'CT-Track: CTMS did not respond within the API timeout';
    [0, 10, 40].forEach((s, k) => tx.ctms.history.push({ at: first + s * 1000, attempt: k + 1, type: 'INSPECTION', status: 'FAILED', httpStatus: i ? 503 : 504, message: msg }));
    settleCtms(tx, 'FAILED', first + 40e3, { attempts: 3, error: { httpStatus: i ? 503 : 504, message: msg } });
    tx.ctms.history.length = 3;
    // CTMS keeps the previous accepted value for this pipe
    if (db.ctmsRecords[pipe.id]?.txId === tx.id) {
      const prev = [...pipe.history].reverse().map(getTx).find((t) => t.id !== tx.id && t.ctms?.status === 'SUCCESS' && t.inspection?.result);
      if (prev) db.ctmsRecords[pipe.id] = { status: prev.inspection.result, txId: prev.id, station: getStation(prev.stationId).code, ts: prev.ctms.lastAttemptAt, ref: prev.ctms.ref, source: 'Traceability' };
      else delete db.ctmsRecords[pipe.id];
    }
  });
  const failed = db.transactions.filter((t) => t.ctms?.status === 'FAILED');
  if (failed.length) raiseAlarm('CTMS_NO_RESPONSE', 'ctms', `${failed.length} submission(s) waiting for CTMS · last error: ${failed[failed.length - 1].ctms.response.message}`, { source: 'CT-Track → CTMS', route: 'api-sync', silent: true, ts: failed[failed.length - 1].ctms.lastAttemptAt });

  // f) CTMS values changed outside the application (reconciliation demo)
  const finished = db.pipes.filter((p) => p.stage === STAGE.FINISHED && db.ctmsRecords[p.id]?.status === 'GOOD');
  for (const p of [finished[3], finished[11]].filter(Boolean)) {
    db.ctmsRecords[p.id] = { ...db.ctmsRecords[p.id], status: 'NC', source: 'CTMS manual entry', ts: p.finishedAt + 50 * MIN };
  }
  runReconciliation({ silent: true, ts: nowTs - 6 * MIN });

  // g) historical alarm on read failures at WMS (acknowledged and cleared)
  const streak = raiseAlarm('READ_FAIL_STREAK', 'streak:WMS-hist', '3 consecutive failed or unknown reads at WMS (HT-M1-SCN-01)', { stationId: 'WMS', silent: true, ts: nowTs - 5.2 * 3600e3 });
  if (streak) {
    ackAlarm(streak.id, supervisor, { ts: nowTs - 5.1 * 3600e3, silent: true });
    clearAlarm('streak:WMS-hist', { silent: true, ts: nowTs - 4.9 * 3600e3 });
  }

  // h) notifications for the bell
  const pendingId = pendingIdentifications()[0];
  const held = heldPipes()[0];
  if (failed.length) notify('error', `CTMS did not accept ${failed.length} inspection result${failed.length > 1 ? 's' : ''} after 3 attempts. Retry from API synchronization.`, { route: 'api-sync', silent: true, ts: failed[failed.length - 1].ctms.lastAttemptAt, toast: false });
  if (held) notify('warning', `${pipeLabel(held)} is on hold: ${held.holdReason}. Supervisor review needed.`, { route: 'supervisor', silent: true, ts: held.holdAt, toast: false });
  if (pendingId) {
    const st = getStation(pendingId.stationId);
    notify('warning', `${st.name}: confirm pipe identity for ${pendingId.movementType} (DMC unreadable).`, { route: `station-${st.slug}`, silent: true, ts: pendingId.ts, toast: false });
  }
  const lastBatch = db.dmcBatches[0];
  if (lastBatch) notify('info', `DMC batch ${lastBatch.id}: ${lastBatch.count} pipes for ${lastBatch.woId} marked at Limab.`, { route: 'work-orders', silent: true, ts: lastBatch.ts, read: true, toast: false });

  // i) configuration history (FR-015 configuration changes with before / after)
  audit(admin, 'Parameters', 'Alarm criteria changed', 'Consecutive DMC read failures', { before: { threshold: 5 }, after: { threshold: 3 }, category: 'Configuration change', silent: true, ts: nowTs - 26 * 3600e3 });
  audit(admin, 'Parameters', 'Desktop binding changed', 'OPS-SEA-02', { before: { station: 'not bound' }, after: { station: 'SEA West' }, category: 'Configuration change', silent: true, ts: nowTs - 27 * 3600e3 });
  audit(admin, 'User access', 'User changed', 'dewi.lestari', { before: { role: '–' }, after: { role: 'Reporting', group: 'PTCT-TRC-Reporting' }, category: 'Configuration change', silent: true, ts: nowTs - 29 * 3600e3 });

  // j) last logins / logouts
  const shiftStart = (() => {
    const d = new Date(nowTs);
    const h = d.getHours();
    const startH = h >= 7 && h < 15 ? 7 : h >= 15 && h < 23 ? 15 : 23;
    d.setHours(startH, 0, 0, 0);
    if (d.getTime() > nowTs) d.setDate(d.getDate() - 1);
    return d.getTime();
  })();
  db.users.forEach((u, i) => {
    if (u.status !== 'ACTIVE') {
      u.lastLogin = nowTs - 21 * 86400e3;
      return;
    }
    u.lastLogin = shiftStart + (i * 3 + 2) * MIN;
    if (u.role === 'Operator') audit(u, 'Auth', 'Logout', 'End of previous shift', { category: 'Logout', silent: true, ts: shiftStart - (5 + i) * MIN });
    audit(u, 'Auth', 'Login', `AD (LDAP/Kerberos) OK · ${u.adGroup} → ${u.role}${u.defaultStation ? ` · ${getStation(u.defaultStation).name}` : ''}`, { category: 'Login', silent: true, ts: u.lastLogin });
  });
}

function finalizeCounters(nowTs) {
  const day = startOfDay(nowTs);
  const it = db.integrations;
  it.DMC.today = db.dmcBatches.filter((b) => b.ts >= day).length;
  it.DMC.lastAt = db.dmcBatches[0]?.ts ?? null;
  const evToday = db.events.filter((e) => e.ts >= day);
  const opc = evToday.filter((e) => e.source === 'OPC');
  const key = evToday.filter((e) => e.source === 'KEYENCE' || e.source === 'BUFFER');
  it.OPC.today = opc.length;
  it.OPC.lastAt = opc[opc.length - 1]?.ts ?? null;
  it.KEYENCE.today = key.length;
  it.KEYENCE.lastAt = key[key.length - 1]?.ts ?? db.events.filter((e) => e.source === 'KEYENCE').pop()?.ts ?? null;
  const ctmsToday = db.transactions.filter((t) => t.ctms && t.ctms.status !== 'N/A' && t.ts >= day);
  it.CTTRACK.today = ctmsToday.reduce((n, t) => n + Math.max(1, t.ctms.attempts || 0), 0);
  it.CTTRACK.errors = ctmsToday.reduce((n, t) => n + t.ctms.history.filter((h) => h.status === 'FAILED').length, 0);
  it.CTTRACK.lastAt = ctmsToday[ctmsToday.length - 1]?.ctms.lastAttemptAt ?? null;
  it.CTTRACK.movements = db.transactions.filter((t) => t.ts >= day).length;
  it.CTTRACK.lastFullSync = nowTs - 6 * MIN;
  it.CTTRACK.latencyMs = 410;
  it.LDAP.today = db.users.filter((u) => u.lastLogin >= day).length;
  it.LDAP.lastAt = Math.max(...db.users.map((u) => u.lastLogin || 0));
  it.LDAP.latencyMs = 35;
  it.OPC.latencyMs = 64;
  it.KEYENCE.latencyMs = 38;
  it.DMC.latencyMs = 210;
  it.OPC.errors = 0;
  it.KEYENCE.errors = 0;
  it.DMC.errors = db.dmcExceptions.filter((x) => x.ts >= day).length;
  it.LDAP.errors = 0;
}

// Station display (traceability station display on the operator PC at each process point).
// FR-009: current pipe, pipe queue, last scan, scanner status and sensor status.
// UC-002 identify and record movement (incl. the existing-transaction update)
// UC-003 resolve the identity manually: confirm the suggestion, select another pipe (4a), enter it (4b)
// UC-004 inspection result: Good / NC at production points
// Limab: status flag (Good / NC / Reject / Pending) and left / right movement (FR-003, FR-005)
// FR-001: reading path (option 1 PLC → Kepware, option 2 direct) and Keyence autofocus.
import webix from '../../lib/webix.js';
import { db, getStation, getStationBySlug, getPipe, getEvent, getTx, getWo, getCamera, stationName } from '../../core/db.js';
import { STATUS_MARKING } from '../../data/masterData.js';
import {
  STAGE,
  REASONS,
  queueForStation,
  atStation,
  limabSequence,
  pendingIdentifications,
  pendingInspections,
  suggestionsFor,
  resolveManual,
  dismissEvent,
  operatorTrigger,
  submitInspection,
  setLimabFlag,
  limabMovement,
  pipeLabel,
  statusLabel,
  stepIndexOfStation,
  defaultRoute,
  previousStepLabel,
} from '../../core/traceability.js';
import { recentTransactions, sensorStatus, scannerStatus, currentPipeAt } from '../../core/selectors.js';
import { simulateCameraRead, rereadLast, setCameraOffline, setPlcDown, setAppLinkDown, autofocus, odOf, simulateLimabMove, releaseNextDmcBatch, setWatching } from '../../core/simulator.js';
import { stationAlarms } from '../../core/alarms.js';
import { currentUser, allowedStations, setSessionStation, can } from '../../core/session.js';
import { esc, fmtTime, fmtAgo, fmtDuration, shiftOf, hashString, mulberry32 } from '../../core/format.js';
import { card, pill, stagePill, methodBadge, moveBadge, readBadge, ctmsBadge, pathBadge, severityBadge, health, mono, timeCell, pipeChip, infoNote, emptyState, sectionTitle, toast, attempt } from '../../ui/components.js';
import { dmcSvg } from '../../ui/dmc.js';
import { syncTable } from '../../ui/table.js';
import { openPipeDetail } from '../common/pipeDetail.js';

let st = null; // current station
let focus = null; // { type: 'identify' | 'inspect' | 'flagtx' | 'flag', id }
let shownKey = '';
let hint = null; // task to open first (set by the demo guide)
let flagSel = null; // flag picked in the Limab status-flag panel
let flagHead = '';
let ctxRef = null;

/** Ask the next station display to open a specific task first. */
export function focusTask(type, id) {
  hint = { type, id };
}

const isLimab = () => st?.id === 'LIMAB';
const FLAGS = ['GOOD', 'NC', 'REJECT', 'PENDING'];
const SHORT_REASON = { READ_ERROR: 'DMC unreadable', NOT_FOUND: 'DMC not found', DUPLICATE_DMC: 'duplicate DMC', ROUTE_MISMATCH: 'route check' };
const SOURCE_LABEL = {
  OPC: 'Scanner via PLC → Kepware OPC · option 1',
  KEYENCE: 'Scanner read directly by the application · option 2',
  BUFFER: 'Stored in the camera, delivered when the link came back',
  DMC: 'DMC API · robot marking',
  SENSOR: 'Out-station sensor + DMC sequence',
  OPERATOR: 'Operator entry',
};

const dirShort = (d) =>
  d === 'LEFT'
    ? '<span class="move move-out" title="Left position: to the next station"><i class="mdi mdi-arrow-left-bold"></i>Left</span>'
    : d === 'RIGHT'
      ? '<span class="move move-right" title="Right position: out station (HT-LM-OUT-01)"><i class="mdi mdi-arrow-right-bold"></i>Right</span>'
      : '';

// ---------------------------------------------------------------------------
// Mock machine data shown next to the inspection form (comes from the station PLC in reality)
// ---------------------------------------------------------------------------
function machineData(station, pipe) {
  const r = mulberry32(hashString(pipe.id + station.id));
  switch (station.processType) {
    case 'HYDRO':
      return [['Test pressure', `${4800 + Math.round(r() * 900)} psi`], ['Hold time', `${10 + Math.round(r() * 5)} s`], ['Pressure drop', `${(r() * 0.6).toFixed(2)} %`]];
    case 'UT':
      return [['Coverage', `${(99 + r()).toFixed(1)} %`], ['Max indication', `${Math.round(18 + r() * 45)} % FSH`], ['Couplant', r() < 0.95 ? 'OK' : 'Low']];
    case 'EMI':
      return [['Max signal', `${Math.round(15 + r() * 70)} % of ref.`], ['Min wall', `${(0.45 + r() * 0.05).toFixed(3)} in`], ['Line speed', `${(0.6 + r() * 0.3).toFixed(2)} m/s`]];
    case 'PROVEUP':
      return [['SEA indication', `${Math.round(40 + r() * 50)} % of ref.`], ['Check method', r() < 0.5 ? 'MPI' : 'UT spot check'], ['Location', `${(r() * 12).toFixed(1)} m from pin end`]];
    case 'MEASURE':
      return [['Length', `${pipe.lengthM.toFixed(2)} m`], ['Weight', `${pipe.weightKg} kg`], ['Straightness', `${(r() * 1.2).toFixed(2)} mm/m`]];
    default:
      return [];
  }
}

function lastEvent() {
  for (let i = db.events.length - 1; i >= 0; i--) if (db.events[i].stationId === st.id) return db.events[i];
  return null;
}

// ---------------------------------------------------------------------------
// Header (scanner status, sensor status), alarm banner, last scan, current pipe
// ---------------------------------------------------------------------------
function sensorChips() {
  const list = sensorStatus(st.id);
  if (!list.length) return '<span class="muted">none</span>';
  return list
    .map((s) => `<span class="sensor ${s.quality !== 'Good' ? 'bad' : s.on ? 'on' : ''}" title="${esc(s.tagName)} · ${s.on ? 'pipe detected' : 'clear'} · quality ${esc(s.quality)}"><i></i>${esc(s.label)}</span>`)
    .join(' ');
}

function headerHtml() {
  const scn = scannerStatus(st.id);
  const conc = st.concentratorId ? db.concentrators.find((c) => c.id === st.concentratorId) : null;
  const user = currentUser();
  const idMode = isLimab() ? 'IN from the DMC API · OUT from the out-station sensors' : st.cameraId ? 'Keyence scanner · operator confirms failed reads' : 'No scanner · operator records the pipe';
  const scanner = scn
    ? `${esc(scn.id)} ${health(scn.status)} ${scn.status !== 'OFFLINE' ? pathBadge(scn.path) : ''}${scn.buffered ? ` <span class="chip chip-warn">${scn.buffered} stored</span>` : ''}`
    : '<span class="muted">none</span>';
  return `<div class="st-head">
    <div style="min-width:0"><div class="st-head-name">${esc(st.name)} <span class="st-code">${esc(st.code)}</span></div><div class="st-head-proc">${esc(st.process)} · ${esc(idMode)}</div></div>
    <div class="st-head-devs">
      <div class="dev">Scanner<b>${scanner}</b></div>
      <div class="dev">Sensors<b>${sensorChips()}</b></div>
      ${conc ? `<div class="dev dev-opt">PLC concentrator<b>${esc(conc.model)}</b></div>` : ''}
      <div class="dev dev-opt">Operator<b>${esc(user.name)}</b></div>
      <div class="dev dev-opt">Shift<b>${esc(shiftOf().label)}</b></div>
    </div>
  </div>`;
}

function alarmBannerHtml() {
  const list = stationAlarms(st.id);
  if (!list.length) return '';
  const rank = { critical: 0, warning: 1, info: 2 };
  const top = [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || b.lastAt - a.lastAt)[0];
  return `<div class="alarm-banner ${top.severity === 'critical' ? '' : 'warn'}" title="${can('alarms') ? 'Open Alarms & exceptions' : ''}">${severityBadge(top.severity)}<b>${esc(top.name)}</b><span class="grow">${esc(top.message)}</span>${list.length > 1 ? `<span class="chip chip-muted">+${list.length - 1} more</span>` : ''}<span class="muted">${esc(fmtAgo(top.lastAt))}</span></div>`;
}

function lastScanHtml() {
  const ev = lastEvent();
  if (!ev) return emptyState('mdi-barcode-off', 'No events yet at this station');
  const pipe = ev.identification?.pipeId ? getPipe(ev.identification.pipeId) : null;
  const failed = ev.readStatus === 'NO_READ';
  const tx = ev.txId ? getTx(ev.txId) : null;
  const code = ev.barcode || ev.rawRead;
  const idState = ev.identification?.status;
  const idText =
    idState === 'REQUIRED'
      ? '<span class="tag tag-pending"><i class="mdi mdi-help-circle-outline"></i>WAITING FOR OPERATOR</span>'
      : idState === 'DISMISSED'
        ? '<span class="chip chip-muted">Dismissed</span>'
        : ev.duplicateOf
          ? methodBadge('UPDATED')
          : methodBadge(tx?.method || ev.identification?.method);
  const readAt = ev.readAt || ev.ts;
  const times = ev.rollStartAt
    ? `<span title="Pipe start rolling time (entry sensor)">Rolling start <b class="mono">${fmtTime(ev.rollStartAt)}</b></span><span title="Data Matrix read time">${ev.source === 'SENSOR' ? 'Sensor' : 'DMC read'} <b class="mono">${fmtTime(readAt)}</b> (+${Math.max(0, Math.round((readAt - ev.rollStartAt) / 1000))} s)</span>`
    : `<span>Recorded <b class="mono">${fmtTime(ev.ts)}</b></span>`;
  const srcChip = ev.source === 'BUFFER' ? `<span class="chip chip-warn" title="Read at ${fmtTime(ev.bufferedAt || ev.ts)}, stored in the camera while the network was down">Stored in camera</span>` : ev.source === 'DMC' ? '<span class="chip chip-info" title="DMC API · robot marking">DMC API</span>' : '';
  return `<div class="readout compact" title="${esc(SOURCE_LABEL[ev.source] || ev.source)}">
    ${dmcSvg(code || 'none', { size: 84, failed: failed || !code })}
    <div class="readout-body">
      <div class="readout-code ${failed ? 'fail' : ''}">${failed ? 'NO READ' : esc(code || '–')}</div>
      <div class="readout-line">${moveBadge(ev.movementType)}${ev.direction ? dirShort(ev.direction) : ''} ${readBadge(ev.readStatus)} ${ev.readPath ? pathBadge(ev.readPath) : ''} ${srcChip} ${idText}</div>
      <div class="readout-line">${times} <span>· ${esc(fmtAgo(ev.ts))}</span></div>
      <div class="readout-line">${pipe ? `${pipeChip(pipe, { size: 'sm' })} <b>${esc(pipeLabel(pipe))}</b>` : '<span>Pipe not identified yet</span>'}</div>
    </div>
  </div>`;
}

function currentPipeHtml() {
  const p = currentPipeAt(st.id);
  if (!p) {
    return emptyState(
      'mdi-pipe-disconnected',
      isLimab() ? 'No marked pipe at Limab' : 'No pipe at the station',
      isLimab() ? 'Pipes appear when the robot marks them (DMC API).' : queueForStation(st.id).length ? 'The next pipe in the queue is listed on the right.' : 'The queue is empty.'
    );
  }
  const wo = getWo(p.wo);
  const since = isLimab() ? p.markedAt : p.inAt;
  return `<div class="current-pipe">
    <div style="display:flex;gap:12px;align-items:center;min-width:0">${pipeChip(p, { size: 'lg' })}<div class="sugg-meta"><b>${esc(pipeLabel(p))}</b><span class="mono">${esc(p.dmc)}</span></div></div>
    <div class="trace-facts">
      <div class="fact"><span>Stage</span><b>${stagePill(p.stage)}</b></div>
      <div class="fact"><span>${isLimab() ? 'Status flag' : 'Pipe status'}</span><b>${isLimab() ? (p.limabFlag ? pill(p.limabFlag) : '<span class="muted">not set</span>') : pill(p.status)}</b></div>
      <div class="fact"><span>${isLimab() ? 'Marked' : 'IN at'}</span><b class="mono">${fmtTime(since)} · ${esc(fmtDuration(Date.now() - since))}</b></div>
      <div class="fact"><span>Product</span><b>${esc(wo ? `${wo.product.od} ${wo.product.weight} ${wo.product.grade}` : '–')}</b></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Task queue (identifications, inspection results, Limab flags) and the action panel
// ---------------------------------------------------------------------------
function tasks() {
  const ids = pendingIdentifications(st.id).map((e) => ({ type: 'identify', id: e.id, ts: e.ts, label: `${e.movementType} · ${SHORT_REASON[e.identification.reason] || e.identification.reason}` }));
  const insp = pendingInspections(st.id).map((t) => ({ type: t.inspection.kind === 'FLAG' ? 'flagtx' : 'inspect', id: t.id, ts: t.ts, label: `${t.inspection.kind === 'FLAG' ? 'Status flag' : 'Result'} · PN ${t.pn}` }));
  return [...ids, ...insp];
}

function pickFocus() {
  const list = tasks();
  if (focus?.type === 'flag' && limabSequence().some((p) => p.id === focus.id)) return;
  if (focus && list.some((t) => t.type === focus.type && t.id === focus.id)) return;
  if (list[0]) {
    focus = { type: list[0].type, id: list[0].id };
    return;
  }
  if (isLimab()) {
    const next = limabSequence().find((p) => !p.limabFlag) || limabSequence()[0];
    focus = next ? { type: 'flag', id: next.id } : null;
    return;
  }
  focus = null;
}

function taskStripHtml() {
  const list = tasks();
  if (!list.length) {
    const text = isLimab() ? 'No open tasks · set the status flag of each pipe before it leaves Limab' : 'No open tasks at this station';
    return `<div class="mini-row muted" style="padding:0 14px;height:100%"><i class="mdi mdi-check-circle-outline" style="color:var(--ok)"></i> ${text}</div>`;
  }
  return `<div style="display:flex;gap:6px;align-items:center;height:100%;padding:0 14px;overflow-x:auto">${list
    .map((t) => {
      const active = focus && focus.type === t.type && focus.id === t.id;
      const icon = t.type === 'identify' ? 'mdi-help-circle-outline' : t.type === 'flagtx' ? 'mdi-flag-outline' : 'mdi-clipboard-edit-outline';
      return `<span class="chip ${t.type === 'identify' ? 'chip-warn' : 'chip-info'} task-chip" data-type="${t.type}" data-id="${t.id}" style="cursor:pointer;${active ? 'background:var(--accent-soft);' : ''}"><i class="mdi ${icon}" style="margin-right:4px"></i>${esc(t.label)} · ${fmtTime(t.ts, false)}</span>`;
    })
    .join('')}</div>`;
}

function identifyHeadHtml(ev) {
  const reason = ev.identification.reason;
  const cand = ev.identification.candidatePipeId ? getPipe(ev.identification.candidatePipeId) : null;
  let note = '';
  if (reason === 'NOT_FOUND') note = infoNote(`The scanner decoded <span class="mono">${esc(ev.rawRead)}</span>, which is not in CTMS / the pipe master data (damaged or dirty marking).`, 'warn');
  if (reason === 'DUPLICATE_DMC') note = infoNote(`${esc(ev.identification.detail)} Check the DMC printed on the pipe in front of you: pick the correct pipe, or dismiss and tell the supervisor.`, 'warn');
  if (reason === 'ROUTE_MISMATCH') note = infoNote(`${esc(ev.identification.detail)}${cand ? ` The scanner read ${esc(pipeLabel(cand))}.` : ''} Pick the correct pipe, or dismiss and tell the supervisor.`, 'warn');
  return `<div class="task"><div class="task-head"><span class="task-icon warn"><i class="mdi mdi-barcode-off"></i></span>
    <div><div class="task-title">Confirm pipe identity · ${ev.movementType}</div><div class="task-sub">${esc(REASONS[reason])} at ${fmtTime(ev.ts)} (${ev.movementType === 'IN' ? 'entry read point' : 'exit read point'}). Confirm the suggested pipe from the sequence, select another pipe, or enter the identity.</div></div></div>
    ${note}
  </div>`;
}

function suggestionRows(ev) {
  return suggestionsFor(ev.stationId, ev.movementType, 8).map((s, i) => ({ id: s.pipe.id, why: s.why, top: i === 0 }));
}

function suggTemplate(o) {
  const p = getPipe(o.id);
  if (!p) return '';
  return `<div class="sugg ${o.top ? 'top' : ''}">${pipeChip(p)}<div class="sugg-meta"><b>${esc(pipeLabel(p))}</b><span class="mono">${esc(p.dmc)}</span></div><span class="sugg-why">${o.top ? '<i class="mdi mdi-star-outline"></i> Suggested · ' : ''}${esc(o.why)}</span></div>`;
}

function inspectHeadHtml(tx) {
  const p = getPipe(tx.pipeId);
  const wo = getWo(p.wo);
  const data = machineData(st, p);
  return `<div class="task"><div class="task-head"><span class="task-icon info"><i class="mdi mdi-clipboard-edit-outline"></i></span>
    <div><div class="task-title">Record ${esc(st.resultLabel)}</div><div class="task-sub">OUT recorded at ${fmtTime(tx.ts)} by ${tx.method === 'AUTO' ? 'the scanner' : esc(tx.operator)} · Good or NC · sent to CTMS through CT-Track after you submit</div></div></div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">${pipeChip(p, { size: 'lg' })}<div class="sugg-meta"><b>${esc(pipeLabel(p))}</b><span class="mono">${esc(p.dmc)}</span></div><span class="muted" style="font-size:12px">${esc(wo ? `${wo.product.od} ${wo.product.weight} ${wo.product.grade}` : '')} · heat <span class="mono">${esc(p.heat)}</span></span></div>
    ${data.length ? `<div class="machine-data"><div class="muted" style="font-size:11px;margin-bottom:6px">Machine data from the station PLC (simulated)</div><div class="trace-facts">${data.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b class="mono">${esc(v)}</b></div>`).join('')}</div></div>` : ''}
  </div>`;
}

function idleHtml() {
  const scn = scannerStatus(st.id);
  let title = 'Waiting for the next pipe';
  let text;
  if (isLimab()) {
    title = 'No marked pipe at Limab';
    text = 'Pipes appear in the Limab sequence as soon as the robot prints the DMC (DMC API). Set each pipe’s status flag before it leaves: left position = next station, right position = out station.';
  } else if (!st.cameraId) text = 'This station has no scanner. Record <b>IN</b> when a pipe arrives and <b>OUT</b> when it leaves: pick the pipe from the queue or type its DMC.';
  else if (scn?.status === 'OFFLINE') text = '<b>The scanner is offline.</b> Record each movement with the manual trigger until it is back.';
  else if (scn?.appLinkDown) text = `<b>The network between ${esc(st.cameraId)} and the application is down.</b> The camera stores each read and sends it with its original time when the link is back${scn.buffered ? ` (${scn.buffered} stored now)` : ''}.`;
  else text = `Movements are recorded automatically when the Keyence scanner reads the Data Matrix (${scn?.path === 'OPT2' ? 'option 2: the application reads the camera directly because the PLC / OPC path is down' : 'option 1: through the PLC and Kepware OPC'}). You act only when a read fails, the code is unknown or duplicated, or a result is needed.`;
  return `<div class="task" style="align-items:flex-start"><div class="task-head"><span class="task-icon good"><i class="mdi mdi-timer-sand"></i></span><div><div class="task-title">${title}</div><div class="task-sub" style="max-width:70ch">${text}</div></div></div></div>`;
}

function flagHeadHtml() {
  if (focus?.type === 'flagtx') {
    const tx = getTx(focus.id);
    const p = getPipe(tx.pipeId);
    return `<div class="task"><div class="task-head"><span class="task-icon warn"><i class="mdi mdi-flag-outline"></i></span><div><div class="task-title">Status flag needed · ${esc(pipeLabel(p))}</div><div class="task-sub">The pipe left Limab (${tx.direction === 'RIGHT' ? 'right position · out station' : 'left position · next station'}) at ${fmtTime(tx.ts)} without a status flag. Enter the flag marked on the pipe; it goes to CTMS through CT-Track.</div></div></div></div>`;
  }
  const p = focus?.type === 'flag' ? getPipe(focus.id) : null;
  if (!p) return '';
  const pos = limabSequence().findIndex((x) => x.id === p.id);
  return `<div class="task"><div class="task-head"><span class="task-icon info"><i class="mdi mdi-flag-outline"></i></span><div><div class="task-title">Status flag · ${esc(pipeLabel(p))}</div><div class="task-sub">${pos === 0 ? 'Next pipe to leave Limab' : `Position ${pos + 1} in the Limab sequence`} · <span class="mono">${esc(p.dmc)}</span> · ${p.limabFlag ? `prepared: <b>${esc(statusLabel(p.limabFlag))}</b>` : 'no flag yet'}. Mark the pipe, save the flag, and it is applied when the out-station sensor records the movement.</div></div></div></div>`;
}

function flagGridHtml() {
  return `<div style="padding:0 16px"><div class="flag-grid">${FLAGS.map(
    (f) => `<div role="button" tabindex="0" class="flag-btn ${flagSel === f ? 'sel' : ''}" data-flag="${f}" title="Mark the pipe: ${esc(STATUS_MARKING[f])}"><b>${esc(statusLabel(f))}</b><span class="flag-line ${f}"></span><small>${esc(STATUS_MARKING[f])}</small></div>`
  ).join('')}</div></div>`;
}

function syncFlagDefect() {
  const d = webix.$$('st-flag-defect');
  if (!d) return;
  if (flagSel === 'NC' || flagSel === 'REJECT') d.enable();
  else {
    d.setValue('');
    d.disable();
  }
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------
function pipeOptions(movement) {
  if (movement === 'IN') {
    const route = defaultRoute();
    const step = route.steps[stepIndexOfStation(st.id)];
    const pipes = db.pipes.filter((p) => p.stage === STAGE.QUEUED && step?.stations.includes(p.targetStationId));
    return pipes.map((p) => ({ id: p.id, value: `${pipeLabel(p)} · ${p.dmc}${p.targetStationId !== st.id ? ` (queued for ${stationName(p.targetStationId)})` : ''}` }));
  }
  return atStation(st.id)
    .filter((p) => p.stage === STAGE.IN)
    .map((p) => ({ id: p.id, value: `${pipeLabel(p)} · ${p.dmc}` }));
}

function openTriggerPopup(ctx, preset = {}) {
  webix.$$('trigger-win')?.destructor();
  const movement = preset.movement || 'IN';
  const win = webix.ui({
    view: 'window',
    id: 'trigger-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(540, window.innerWidth - 24),
    head: esc(`${st.name} · record movement manually`),
    body: {
      view: 'form',
      id: 'trigger-form',
      padding: 18,
      elements: [
        { view: 'template', borderless: true, autoheight: true, template: infoNote('Use this when the scanner is offline, the station has no scanner, or the pipe cannot be read (UC-003 4b). The movement is stored with identification method <b>MANUAL</b> and your name. If the pipe already has a transaction for this movement here, it is updated instead.') },
        {
          view: 'segmented',
          name: 'movement',
          label: 'Movement',
          labelWidth: 110,
          value: movement,
          options: [
            { id: 'IN', value: 'IN · pipe arrives' },
            { id: 'OUT', value: 'OUT · pipe leaves' },
          ],
          on: {
            onChange(v) {
              const combo = webix.$$('trigger-pipe');
              combo.define('options', pipeOptions(v));
              combo.setValue(pipeOptions(v)[0]?.id || '');
              combo.refresh();
            },
          },
        },
        { view: 'combo', id: 'trigger-pipe', name: 'pipe', label: 'Pipe', labelWidth: 110, placeholder: 'Pick a pipe or type its DMC', options: pipeOptions(movement), value: preset.pipeId || pipeOptions(movement)[0]?.id || '' },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Record movement',
              css: 'webix_primary',
              autowidth: true,
              hotkey: 'enter',
              click: () => {
                const v = webix.$$('trigger-form').getValues();
                const typed = webix.$$('trigger-pipe').getText?.() || '';
                const pipeId = v.pipe || typed.trim();
                const tx = attempt(() => operatorTrigger({ stationId: st.id, pipeId, movementType: v.movement }, { actor: currentUser() }), (t) => `${v.movement} recorded for ${pipeLabel(getPipe(t.pipeId))} · MANUAL${t.updates ? ' (existing transaction updated)' : ''}`);
                if (tx) {
                  win.close();
                  if (tx.inspection?.required && !tx.inspection.result) focus = { type: 'inspect', id: tx.id };
                  refreshAll();
                }
              },
            },
          ],
        },
      ],
    },
  });
  ctx.track(win);
  win.show();
}

function openManualIdentity(ctx, ev) {
  if (!ev) return;
  webix.$$('manual-id-win')?.destructor();
  const options = pipeOptions(ev.movementType);
  const win = webix.ui({
    view: 'window',
    id: 'manual-id-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(560, window.innerWidth - 24),
    head: 'Enter pipe identity manually',
    body: {
      view: 'form',
      id: 'manual-id-form',
      padding: 18,
      elements: [
        { view: 'template', borderless: true, autoheight: true, template: infoNote('The suggestion list does not show the pipe in front of you (UC-003 4b). Pick any pipe that can be at this point, or type the DMC printed on the pipe.') },
        { view: 'combo', id: 'manual-id-pipe', name: 'pipe', label: 'Pipe', labelWidth: 80, options, placeholder: 'Work order, PN or DMC' },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Confirm identity',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const id = webix.$$('manual-id-pipe').getValue() || webix.$$('manual-id-pipe').getText().trim();
                const tx = attempt(() => resolveManual(ev.id, id, { actor: currentUser(), mode: 'INPUT' }), (t) => `${ev.movementType} recorded for ${pipeLabel(getPipe(t.pipeId))} · MANUAL${ev.duplicateOf ? ' (existing transaction updated)' : ''}`);
                if (tx) {
                  win.close();
                  focus = tx.inspection?.required && !tx.inspection.result ? { type: 'inspect', id: tx.id } : null;
                  refreshAll();
                }
              },
            },
          ],
        },
      ],
    },
  });
  ctx.track(win);
  win.show();
}

function openLimabMovePopup(ctx, preset = {}) {
  const options = limabSequence().map((p) => ({ id: p.id, value: `${pipeLabel(p)} · ${p.limabFlag ? 'flag ' + statusLabel(p.limabFlag) : 'no flag yet'}` }));
  if (!options.length) {
    toast('No marked pipe is waiting at Limab.', 'warning');
    return;
  }
  webix.$$('limab-win')?.destructor();
  const win = webix.ui({
    view: 'window',
    id: 'limab-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(580, window.innerWidth - 24),
    head: 'Limab · record movement manually',
    body: {
      view: 'form',
      id: 'limab-form',
      padding: 18,
      elements: [
        { view: 'template', borderless: true, autoheight: true, template: infoNote('Use this when the out-station sensors did not register the pipe. The movement is stored with identification method <b>MANUAL</b> and your name.') },
        { view: 'combo', name: 'pipe', label: 'Pipe', labelWidth: 110, options, value: preset.pipeId && options.some((o) => o.id === preset.pipeId) ? preset.pipeId : options[0].id },
        {
          view: 'segmented',
          name: 'direction',
          label: 'Direction',
          labelWidth: 110,
          value: preset.direction || 'LEFT',
          options: [
            { id: 'LEFT', value: '← Left · next station' },
            { id: 'RIGHT', value: 'Right · out station →' },
          ],
        },
        {
          view: 'richselect',
          name: 'flag',
          label: 'Status flag',
          labelWidth: 110,
          value: '',
          options: [{ id: '', value: 'Use the prepared flag, or enter it later' }, ...FLAGS.map((f) => ({ id: f, value: `${statusLabel(f)} · ${STATUS_MARKING[f]}` }))],
          on: { onChange: (v) => (v === 'NC' || v === 'REJECT' ? webix.$$('limab-defect').enable() : webix.$$('limab-defect').disable()) },
        },
        { view: 'richselect', id: 'limab-defect', name: 'defectCode', label: 'Defect code', labelWidth: 110, options: db.defects.MARKING, disabled: true, placeholder: 'Required for NC / Reject' },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Record movement',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const v = webix.$$('limab-form').getValues();
                const tx = attempt(
                  () => limabMovement({ direction: v.direction, pipeId: v.pipe, flag: v.flag || undefined, defectCode: v.defectCode, source: 'OPERATOR' }, { actor: currentUser() }),
                  (t) => `${pipeLabel(getPipe(t.pipeId))} left Limab (${v.direction === 'LEFT' ? 'left · next station' : 'right · out station'}) · MANUAL`
                );
                if (tx) {
                  win.close();
                  if (tx.inspection?.required && !tx.inspection.result) focus = { type: 'flagtx', id: tx.id };
                  refreshAll();
                }
              },
            },
          ],
        },
      ],
    },
  });
  ctx.track(win);
  win.show();
}

function openAutofocus(ctx) {
  const cam = st.cameraId ? getCamera(st.cameraId) : null;
  if (!cam) return;
  const target = currentPipeAt(st.id) || queueForStation(st.id)[0] || null;
  const od = odOf(target);
  webix.$$('af-win')?.destructor();
  const info = () => `<div style="padding:16px 18px 6px;display:flex;flex-direction:column;gap:12px">
    <div class="trace-facts">
      <div class="fact"><span>Scanner</span><b>${esc(cam.id)} · ${esc(cam.model)}</b></div>
      <div class="fact"><span>Focus distance</span><b class="mono">${cam.focusMm} mm</b></div>
      <div class="fact"><span>Aligned for</span><b>${esc(cam.alignedOd || 'not tuned')}</b></div>
      <div class="fact"><span>Read margin</span><b>${cam.tuneMargin != null ? cam.tuneMargin + ' %' : '–'}</b></div>
      <div class="fact"><span>Last tune</span><b>${cam.lastTuneAt ? `${fmtTime(cam.lastTuneAt)} · ${esc(fmtAgo(cam.lastTuneAt))}` : '–'}</b></div>
      <div class="fact"><span>Pipe at the scanner</span><b>${target ? `PN ${target.pn} · ${esc(od || '–')}` : '–'}</b></div>
    </div>
    ${cam.alignedOd && od && cam.alignedOd !== od ? infoNote(`The pipe is ${esc(od)} but the scanner is aligned for ${esc(cam.alignedOd)}: reads may fail until you run autofocus (FR-001.3).`, 'warn') : infoNote('Run autofocus when the pipe size changes. The scanner adjusts its focus distance and checks the read margin on the next pipe.')}
  </div>`;
  const win = webix.ui({
    view: 'window',
    id: 'af-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(560, window.innerWidth - 24),
    head: esc(`${cam.id} · autofocus & alignment`),
    body: {
      rows: [
        { view: 'template', id: 'af-info', borderless: true, autoheight: true, template: info },
        {
          view: 'toolbar',
          paddingX: 14,
          height: 56,
          elements: [
            {},
            { view: 'button', value: 'Close', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: od ? `Run autofocus for ${od}` : 'Run autofocus',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const r = attempt(() => autofocus(cam.id, { od, actor: currentUser() }), (x) => `${cam.id} focused at ${x.focusMm} mm for ${x.od || 'the current pipe'} · read margin ${x.margin} %`);
                if (r) {
                  webix.$$('af-info').refresh();
                  webix.$$('af-info').resize();
                  refreshAll();
                }
              },
            },
          ],
        },
      ],
    },
  });
  ctx.track(win);
  win.show();
}

function faultsNote() {
  const scn = scannerStatus(st.id);
  if (!scn) return '';
  const path = scn.status === 'OFFLINE' ? 'no reading path (scanner offline)' : scn.path === 'OPT2' ? 'option 2 · the application reads the camera directly' : 'option 1 · scanner → PLC → Kepware OPC';
  return `<div class="muted" style="font-size:12px;line-height:1.5;padding:2px 2px 4px">Reading now: <b>${esc(path)}</b>${scn.buffered ? `<br>${scn.buffered} read(s) stored in the camera` : ''}</div>`;
}

function syncFaults() {
  if (!st?.cameraId || !webix.$$('st-faults')) return;
  const rt = scannerStatus(st.id);
  const set = (id, v) => {
    const sw = webix.$$(id);
    if (!sw || !!sw.getValue() === !!v) return;
    sw.blockEvent();
    sw.setValue(v ? 1 : 0);
    sw.unblockEvent();
  };
  set('flt-offline', db.settings.cameraOffline[st.cameraId]);
  set('flt-plc', rt?.plcDown);
  set('flt-net', rt?.appLinkDown);
  webix.$$('flt-note')?.refresh();
}

function openFaults(node) {
  let pop = webix.$$('st-faults');
  if (!pop) {
    pop = webix.ui({
      view: 'popup',
      id: 'st-faults',
      width: 380,
      body: {
        view: 'form',
        id: 'st-faults-form',
        padding: 14,
        margin: 6,
        elements: [
          { view: 'template', borderless: true, height: 40, template: sectionTitle('Simulate faults', 'FR-001 redundancy · FR-006') },
          {
            view: 'switch',
            id: 'flt-offline',
            labelRight: 'Scanner offline',
            labelWidth: 0,
            on: {
              onChange: (v) => {
                setCameraOffline(st.cameraId, !!v, currentUser());
                refreshAll();
              },
            },
          },
          {
            view: 'switch',
            id: 'flt-plc',
            labelRight: 'PLC / OPC path down → option 2',
            labelWidth: 0,
            on: {
              onChange: (v) => {
                setPlcDown(st.id, !!v, currentUser());
                toast(v ? `${st.name}: PLC / OPC path down. Reading switched to option 2 (direct camera).` : `${st.name}: back on option 1 (PLC → Kepware OPC).`, v ? 'warning' : 'success');
                refreshAll();
              },
            },
          },
          {
            view: 'switch',
            id: 'flt-net',
            labelRight: 'Network down → camera stores reads',
            labelWidth: 0,
            on: {
              onChange: (v) => {
                const n = scannerStatus(st.id)?.buffered || 0;
                setAppLinkDown(st.id, !!v, currentUser());
                toast(v ? `${st.cameraId} cannot reach the application: reads are stored in the camera.` : `Link restored${n ? `: ${n} stored read(s) delivered with their original time` : ''}.`, v ? 'warning' : 'success');
                refreshAll();
              },
            },
          },
          { view: 'template', id: 'flt-note', borderless: true, autoheight: true, template: () => (st ? faultsNote() : '') },
          {
            view: 'button',
            value: 'Next IN read: duplicate DMC',
            css: 'btn-ghost',
            click: () => {
              pop.hide();
              simRead('IN', { duplicateDmc: true });
            },
          },
        ],
      },
    });
    ctxRef.track(pop);
  }
  syncFaults();
  pop.show(node, { pos: 'bottom' });
}

// ---------------------------------------------------------------------------
// Simulator actions
// ---------------------------------------------------------------------------
function handleRead(res, movement) {
  if (!res) return;
  if (res.lost) {
    toast(`Network to the application is down and camera store-and-forward is off (System parameters): the read is lost. Record the pipe manually.`, 'error');
    refreshAll();
    return;
  }
  if (res.buffered) {
    toast(`Network to the application is down: read stored in ${st.cameraId} (${res.count} waiting)`, 'warning');
    refreshAll();
    return;
  }
  const ev = res;
  if (ev.duplicateOf) {
    toast(`Same pipe, same process point and movement: existing transaction ${ev.duplicateOf} updated (UC-002 3a)`, 'info');
  } else if (ev.identification?.status === 'AUTO') {
    const tx = getTx(ev.txId);
    toast(`${movement} · ${pipeLabel(getPipe(tx.pipeId))} identified automatically (${ev.readPath === 'OPT2' ? 'option 2, direct' : 'option 1, PLC → OPC'})`, 'success');
    if (tx.inspection?.required && !tx.inspection.result) focus = { type: 'inspect', id: tx.id };
  } else if (ev.identification?.status === 'REQUIRED') {
    toast(`${REASONS[ev.identification.reason]}: confirm the pipe identity`, 'warning');
    focus = { type: 'identify', id: ev.id };
  }
  refreshAll();
}

function simRead(movement, opts = {}) {
  const fail = webix.$$('sim-fail');
  const garble = webix.$$('sim-garble');
  const res = attempt(() => simulateCameraRead(st.id, movement, { forceError: !!fail?.getValue(), invalid: !!garble?.getValue(), actor: currentUser(), ...opts }));
  fail?.setValue(0);
  garble?.setValue(0);
  handleRead(res, movement);
}

function simReread() {
  const res = attempt(() => rereadLast(st.id, { actor: currentUser() }));
  if (res) handleRead(res, res.movementType);
}

function limabMove(direction) {
  if (!limabSequence().length) {
    toast('No marked pipe is waiting at Limab. Let the robot mark a batch first.', 'warning');
    return;
  }
  const tx = attempt(() => simulateLimabMove(direction, { actor: currentUser() }));
  if (!tx) return;
  const p = getPipe(tx.pipeId);
  const where = direction === 'LEFT' ? '← left · next station' : 'right → out station';
  if (tx.inspection?.result) toast(`${pipeLabel(p)} left Limab ${where} · flag ${statusLabel(tx.inspection.result)}`, tx.inspection.result === 'REJECT' ? 'warning' : 'success');
  else {
    toast(`${pipeLabel(p)} left Limab ${where} without a status flag: enter it now`, 'warning');
    focus = { type: 'flagtx', id: tx.id };
  }
  refreshAll();
}

function robotBatch() {
  attempt(() => releaseNextDmcBatch({ count: 4, actor: currentUser() }), (b) => `Robot marked ${b.count} pipes for ${b.woId} (DMC batch ${b.id})`);
  refreshAll();
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
function queueRows() {
  return queueForStation(st.id).map((p, i) => ({ id: p.id, seq: i + 1, wo: p.wo, pn: p.pn, dmc: p.dmc, queuedAt: p.queuedAt, status: p.status, next: i === 0 }));
}

function limabRows() {
  return limabSequence().map((p, i) => ({ id: p.id, seq: i + 1, wo: p.wo, pn: p.pn, dmc: p.dmc, markedAt: p.markedAt, flag: p.limabFlag || '', next: i === 0 }));
}

function atRows() {
  return atStation(st.id).map((p) => ({ id: p.id, wo: p.wo, pn: p.pn, stage: p.stage, inAt: p.inAt, status: p.status }));
}

function recentRows() {
  return recentTransactions({ stationId: st.id, limit: 40 }).map((t) => ({
    id: t.id,
    ts: t.ts,
    pipeId: t.pipeId,
    movement: t.movement,
    direction: t.direction || '',
    method: t.method,
    updates: t.updates || 0,
    result: t.inspection?.result || (t.inspection?.required ? 'AWAIT' : null),
    ctms: t.ctms?.status || 'N/A',
    operator: t.operator,
  }));
}

function showAction() {
  pickFocus();
  const key = focus ? `${focus.type}:${focus.id}` : 'idle';
  if (!webix.$$('st-act')) return;
  if (key !== shownKey) {
    shownKey = key;
    if (!focus) {
      webix.$$('st-idle-text').refresh();
      webix.$$('st-idle').show();
    } else if (focus.type === 'identify') {
      const ev = getEvent(focus.id);
      webix.$$('st-id-head').setHTML(identifyHeadHtml(ev));
      webix.$$('st-id-head').resize();
      const list = webix.$$('st-sugg');
      list.clearAll();
      list.parse(suggestionRows(ev));
      if (list.count()) list.select(list.getFirstId());
      webix.$$('st-identify').show();
    } else if (focus.type === 'inspect') {
      const tx = getTx(focus.id);
      webix.$$('st-insp-head').setHTML(inspectHeadHtml(tx));
      webix.$$('st-insp-head').resize();
      const form = webix.$$('st-insp-form');
      form.clear();
      form.setValues({ result: 'GOOD', defectCode: '', remarks: '' });
      webix.$$('st-defect').define('options', db.defects[st.processType] || []);
      webix.$$('st-defect').refresh();
      webix.$$('st-defect').disable();
      webix.$$('st-inspect').show();
    } else {
      const pipe = focus.type === 'flag' ? getPipe(focus.id) : getPipe(getTx(focus.id)?.pipeId);
      flagSel = focus.type === 'flag' ? pipe?.limabFlag || null : null;
      flagHead = flagHeadHtml();
      webix.$$('st-flag-head').setHTML(flagHead);
      webix.$$('st-flag-head').resize();
      webix.$$('st-flag-grid').refresh();
      webix.$$('st-flag-form').setValues({ defectCode: (focus.type === 'flag' && pipe?.limabFlagInfo?.defectCode) || '', remarks: (focus.type === 'flag' && pipe?.limabFlagInfo?.remarks) || '' });
      webix.$$('st-flag-save').setValue(focus.type === 'flag' ? 'Save status flag' : 'Submit status flag');
      const mv = webix.$$('st-flag-move');
      if (focus.type === 'flag') mv.show();
      else mv.hide();
      syncFlagDefect();
      webix.$$('st-flag').show();
    }
  } else if (focus?.type === 'identify') {
    const ev = getEvent(focus.id);
    const list = webix.$$('st-sugg');
    const sel = list.getSelectedId();
    const rows = suggestionRows(ev);
    const same = rows.length === list.count() && rows.every((r, i) => list.getIdByIndex(i) === r.id);
    if (!same) {
      list.clearAll();
      list.parse(rows);
      if (sel && list.exists(sel)) list.select(sel);
      else if (list.count()) list.select(list.getFirstId());
    }
  } else if (focus?.type === 'flag') {
    const html = flagHeadHtml();
    if (html !== flagHead) {
      flagHead = html;
      webix.$$('st-flag-head').setHTML(html);
      webix.$$('st-flag-head').resize();
    }
  }
  if (!focus) webix.$$('st-idle-text')?.refresh();
}

function refreshBanner() {
  const b = webix.$$('st-banner');
  if (!b) return;
  const html = alarmBannerHtml();
  if (html) {
    b.setHTML(html);
    if (!b.isVisible()) b.show();
  } else if (b.isVisible()) b.hide();
}

function refreshAll() {
  if (!st || !webix.$$('st-head')) return;
  webix.$$('st-head').refresh();
  refreshBanner();
  webix.$$('st-readout').refresh();
  webix.$$('st-current').refresh();
  pickFocus();
  webix.$$('st-tasks').refresh();
  showAction();
  if (isLimab()) {
    syncTable('st-seq', limabRows());
    const seq = webix.$$('st-seq');
    const sel = seq?.getSelectedId();
    const selId = sel ? String(sel.row ?? sel) : null;
    if (seq && focus?.type === 'flag' && seq.exists(focus.id) && selId !== focus.id) {
      seq.blockEvent();
      seq.select(focus.id);
      seq.unblockEvent();
    } else if (seq && focus?.type !== 'flag' && selId) seq.unselectAll();
  } else {
    syncTable('st-queue', queueRows());
    syncTable('st-at', atRows());
  }
  syncTable('st-recent', recentRows());
  syncFaults();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default {
  route: 'station',
  title: (ctx) => `${getStationBySlug(ctx.param)?.name || 'Station'} · station display`,
  subtitle: (ctx) => {
    const s = getStationBySlug(ctx.param);
    return s ? `${s.code} · ${s.fullName}` : '';
  },
  perm: 'station',
  nav: { group: 'grp-station', label: 'Station display', icon: 'mdi-monitor', order: 10 },

  ui(ctx) {
    st = getStationBySlug(ctx.param);
    focus = hint;
    hint = null;
    shownKey = '';
    flagSel = null;
    flagHead = '';
    ctxRef = ctx;
    const user = currentUser();
    const stationOptions = allowedStations(user).map((id) => ({ id: getStation(id).slug, value: `${getStation(id).code} · ${getStation(id).name}` }));
    const camera = !!st.cameraId;
    const limab = isLimab();
    const narrow = window.innerWidth < 1280;
    const phone = window.innerWidth < 600;
    const wrapSimbar = (bar) => (narrow ? { view: 'scrollview', scroll: 'x', height: 74, css: 'page', body: { ...bar, width: 1240 } } : bar);
    const btnRow = (items, opts = {}) => (narrow ? { rows: items.filter((i) => i.view), margin: 8, ...opts } : { cols: items, margin: 10, ...opts });
    const mainLayout = (columns) =>
      narrow
        ? { view: 'scrollview', scroll: 'y', css: 'page', body: { type: 'clean', css: 'page', margin: 12, rows: columns.map((c) => ({ ...c, gravity: 1, minWidth: 0 })) } }
        : { type: 'clean', css: 'page', margin: 12, cols: columns };
    const topRow = (cards) => (narrow ? { rows: cards, margin: 12 } : { cols: cards, margin: 12, height: 214 });

    const simLabel = { view: 'label', width: 104, label: '<span class="simbar-label"><i class="mdi mdi-flask-outline"></i>Simulator</span>', tooltip: 'Stands in for the PLC sensors, Keyence scanner, Kepware OPC and the Limab robot' };
    const simElements = limab
      ? [
          simLabel,
          { view: 'button', type: 'icon', icon: 'mdi mdi-arrow-left-bold', label: 'Pipe moves left · next station', css: 'btn-sim', autowidth: true, click: () => limabMove('LEFT') },
          { view: 'button', type: 'icon', icon: 'mdi mdi-arrow-right-bold', label: 'Pipe moves right · out station', css: 'btn-sim', autowidth: true, click: () => limabMove('RIGHT') },
          { view: 'button', type: 'icon', icon: 'mdi mdi-robot-industrial', label: 'Robot marks 4 pipes', css: 'btn-sim', autowidth: true, tooltip: 'The Limab robot prints the DMC on 4 pipes and the DMC API sends their unique numbers', click: robotBatch },
          {},
        ]
      : camera
        ? [
            simLabel,
            { view: 'button', type: 'icon', icon: 'mdi mdi-barcode-scan', label: 'Pipe arrives · read IN', css: 'btn-sim', autowidth: true, click: () => simRead('IN') },
            { view: 'button', type: 'icon', icon: 'mdi mdi-exit-run', label: 'Pipe leaves · read OUT', css: 'btn-sim', autowidth: true, click: () => simRead('OUT') },
            { view: 'button', type: 'icon', icon: 'mdi mdi-restore', label: 'Re-read', css: 'btn-sim', autowidth: true, tooltip: 'The scanner reads the same pipe again: the existing transaction is updated (UC-002 3a)', click: simReread },
            { view: 'checkbox', id: 'sim-fail', labelRight: 'Next read fails', labelWidth: 0, width: 134, tooltip: 'The next simulated read returns no Data Matrix (DMC unreadable)' },
            { view: 'checkbox', id: 'sim-garble', labelRight: 'Garbled code', labelWidth: 0, width: 124, tooltip: 'The next simulated read decodes a code that is not in CTMS / master data' },
            {},
            {
              view: 'button',
              type: 'icon',
              icon: 'mdi mdi-lightning-bolt-outline',
              label: 'Faults…',
              css: 'btn-sim',
              autowidth: true,
              tooltip: 'Scanner offline, PLC / OPC path down (option 2), network down (camera stores reads), duplicate DMC',
              click() {
                openFaults(this.$view);
              },
            },
          ]
        : [simLabel, { view: 'label', label: '<span class="muted" style="font-size:12.5px">No scanner at this station: the operator records IN and OUT with the buttons in the action panel.</span>' }];

    const idleButtons = limab
      ? [{ view: 'button', value: 'Record movement manually', css: 'btn-ghost btn-xl', height: 46, width: narrow ? 0 : 260, click: () => openLimabMovePopup(ctx) }, {}]
      : [
          { view: 'button', value: camera ? 'Manual entry · IN' : 'Record IN · pipe arrived', css: camera ? 'btn-ghost btn-xl' : 'webix_primary btn-xl', height: 46, width: narrow ? 0 : 230, click: () => openTriggerPopup(ctx, { movement: 'IN' }) },
          { view: 'button', value: camera ? 'Manual entry · OUT' : 'Record OUT · pipe leaves', css: camera ? 'btn-ghost btn-xl' : 'webix_primary btn-xl', height: 46, width: narrow ? 0 : 240, click: () => openTriggerPopup(ctx, { movement: 'OUT' }) },
          {},
        ];

    const resultSeg = {
      view: 'segmented',
      name: 'result',
      id: 'st-result',
      css: 'result-seg',
      height: 44,
      label: 'Result',
      labelWidth: 96,
      options: (st.resultOptions || ['GOOD', 'NC']).map((r) => ({ id: r, value: statusLabel(r) })),
      on: {
        onChange(v) {
          const d = webix.$$('st-defect');
          if (v === 'GOOD') {
            d.setValue('');
            d.disable();
          } else d.enable();
        },
      },
    };

    const leftColumn = {
      gravity: 3,
      minWidth: 460,
      rows: [
        topRow([
          card({
            title: limab ? 'Last event' : 'Last scan',
            sub: limab ? 'DMC marking and out-station sensors' : camera ? 'Scanner read, reading path and times' : 'Latest movement at this station',
            gravity: 1.35,
            actions: camera ? [{ view: 'button', type: 'icon', icon: 'mdi mdi-crosshairs-gps', label: 'Autofocus', css: 'btn-ghost', autowidth: true, tooltip: 'Keyence autofocus when the pipe size changes (FR-001.3)', click: () => openAutofocus(ctx) }] : [],
            body: { view: 'template', id: 'st-readout', borderless: true, autoheight: narrow, template: lastScanHtml },
          }),
          card({
            title: 'Current pipe',
            sub: limab ? 'Head of the Limab sequence' : 'At the station now',
            gravity: 1,
            body: { view: 'template', id: 'st-current', borderless: true, autoheight: narrow, template: currentPipeHtml, onClick: { pipe: (e, id, node) => openPipeDetail(node.getAttribute('data-pipe'), ctx) } },
          }),
        ]),
        { height: 12 },
        card({
          title: limab ? 'Operator action · status flag' : 'Operator action',
          sub: 'Open tasks at this station, oldest first',
          minHeight: narrow ? 580 : 0,
          actions: [
            {
              view: 'button',
              type: 'icon',
              icon: 'mdi mdi-gesture-tap',
              label: limab ? 'Record movement manually' : 'Manual entry',
              css: 'btn-ghost',
              autowidth: true,
              click: () => (limab ? openLimabMovePopup(ctx, focus?.type === 'flag' ? { pipeId: focus.id } : {}) : openTriggerPopup(ctx)),
            },
          ],
          body: {
            rows: [
              {
                view: 'template',
                id: 'st-tasks',
                borderless: true,
                height: 44,
                css: 'task-strip',
                template: taskStripHtml,
                onClick: {
                  'task-chip': function (e, id, node) {
                    focus = { type: node.getAttribute('data-type'), id: node.getAttribute('data-id') };
                    showAction();
                    webix.$$('st-tasks').refresh();
                  },
                },
              },
              {
                view: 'multiview',
                id: 'st-act',
                animate: false,
                cells: [
                  {
                    id: 'st-idle',
                    rows: [{ view: 'template', id: 'st-idle-text', borderless: true, autoheight: true, template: idleHtml }, btnRow(idleButtons, { padding: { left: 16, right: 16, bottom: 12 } }), {}],
                  },
                  {
                    id: 'st-identify',
                    rows: [
                      { view: 'template', id: 'st-id-head', borderless: true, autoheight: true, template: '' },
                      { view: 'list', id: 'st-sugg', css: 'sugg-list', borderless: true, select: true, type: { height: 70 }, template: suggTemplate, on: { onItemDblClick: () => confirmSelected() } },
                      btnRow(
                        [
                          { view: 'button', value: 'Confirm selected pipe', css: 'webix_primary btn-xl', height: 46, width: narrow ? 0 : 206, click: () => confirmSelected() },
                          { view: 'button', value: 'Not in list? Enter identity', css: 'btn-ghost btn-xl', height: 46, width: narrow ? 0 : 236, click: () => openManualIdentity(ctx, getEvent(focus?.id)) },
                          {},
                          {
                            view: 'button',
                            value: 'Dismiss',
                            tooltip: 'No pipe at the read point (false trigger), or a duplicate DMC that is not at this station',
                            css: 'btn-ghost',
                            height: 46,
                            autowidth: !narrow,
                            click: () => {
                              const id = focus?.id;
                              if (!id) return;
                              webix
                                .confirm({ title: 'Dismiss this event?', text: 'Use this only for a false trigger (no pipe at the read point) or a duplicate DMC that is not at this station. The event stays in the log as dismissed.', ok: 'Dismiss event', cancel: 'Keep' })
                                .then(() => {
                                  attempt(() => dismissEvent(id, 'False trigger: no pipe at read point', { actor: currentUser() }), 'Event dismissed');
                                  focus = null;
                                  refreshAll();
                                })
                                .catch(() => {});
                            },
                          },
                        ],
                        { padding: { left: 16, right: 16, bottom: 14, top: 6 } }
                      ),
                    ],
                  },
                  {
                    id: 'st-inspect',
                    view: 'scrollview',
                    scroll: 'y',
                    borderless: true,
                    body: {
                      rows: [
                        { view: 'template', id: 'st-insp-head', borderless: true, autoheight: true, template: '' },
                        {
                          view: 'form',
                          id: 'st-insp-form',
                          borderless: true,
                          padding: { left: 16, right: 16, top: 0, bottom: 12 },
                          margin: 8,
                          elements: [
                            resultSeg,
                            { view: 'richselect', id: 'st-defect', name: 'defectCode', label: 'Defect code', labelWidth: 96, placeholder: 'Required for NC', options: [], disabled: true },
                            { view: 'textarea', name: 'remarks', label: 'Remarks', labelWidth: 96, height: 44, placeholder: 'Optional: location of the indication, re-test notes…' },
                            {
                              cols: [
                                { width: 96 },
                                {
                                  view: 'button',
                                  value: 'Submit result',
                                  css: 'webix_primary btn-xl',
                                  height: 46,
                                  width: 210,
                                  click: () => {
                                    const v = webix.$$('st-insp-form').getValues();
                                    const txId = focus?.id;
                                    const tx = attempt(
                                      () => submitInspection(txId, { result: v.result, defectCode: v.defectCode, remarks: v.remarks }, { actor: currentUser() }),
                                      (t) => `${pipeLabel(getPipe(t.pipeId))}: ${statusLabel(v.result)} saved · queued for CTMS via CT-Track`
                                    );
                                    if (tx) {
                                      focus = null;
                                      refreshAll();
                                    }
                                  },
                                },
                                {},
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    id: 'st-flag',
                    view: 'scrollview',
                    scroll: 'y',
                    borderless: true,
                    body: {
                      rows: [
                        { view: 'template', id: 'st-flag-head', borderless: true, autoheight: true, template: '' },
                        {
                          view: 'template',
                          id: 'st-flag-grid',
                          borderless: true,
                          autoheight: true,
                          template: flagGridHtml,
                          onClick: {
                            'flag-btn': function (e, id, node) {
                              flagSel = node.getAttribute('data-flag');
                              webix.$$('st-flag-grid').refresh();
                              syncFlagDefect();
                            },
                          },
                        },
                        {
                          view: 'form',
                          id: 'st-flag-form',
                          borderless: true,
                          padding: { left: 16, right: 16, top: 10, bottom: 12 },
                          margin: 8,
                          elements: [
                            { view: 'richselect', id: 'st-flag-defect', name: 'defectCode', label: 'Defect code', labelWidth: 96, options: db.defects.MARKING, placeholder: 'Required for NC or Reject', disabled: true },
                            { view: 'textarea', name: 'remarks', label: 'Remarks', labelWidth: 96, height: 44, placeholder: 'Optional' },
                            btnRow([{ width: narrow ? 0 : 96 }, { view: 'button', id: 'st-flag-save', value: 'Save status flag', css: 'webix_primary btn-xl', height: 46, width: narrow ? 0 : 210, click: () => saveFlag() }, { view: 'button', id: 'st-flag-move', value: 'Record movement manually', css: 'btn-ghost btn-xl', height: 46, width: narrow ? 0 : 250, click: () => openLimabMovePopup(ctx, focus?.type === 'flag' ? { pipeId: focus.id } : {}) }, {}]),
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        }),
      ],
    };

    const queueSource = previousStepLabel(st.id);
    const rightColumn = limab
      ? {
          gravity: 2,
          minWidth: 380,
          rows: [
            card({
              title: 'Limab sequence',
              sub: 'Marked pipes in DMC order · click one to set its flag',
              gravity: 1.15,
              minHeight: narrow ? 300 : 0,
              body: {
                view: 'datatable',
                id: 'st-seq',
                borderless: true,
                select: 'row',
                scheme: { $change: (o) => (o.$css = o.next ? 'row-next' : '') },
                columns: [
                  { id: 'seq', header: '#', width: 40 },
                  { id: 'pn', header: 'Pipe', width: 88, template: (o) => pipeChip(getPipe(o.id), { size: 'sm' }) },
                  { id: 'wo', header: 'Work order', width: 100, template: (o) => mono(o.wo) },
                  { id: 'markedAt', header: 'Marked', width: 80, template: (o) => timeCell(o.markedAt) },
                  { id: 'flag', header: 'Status flag', fillspace: 1, minWidth: 96, template: (o) => (o.flag ? pill(o.flag) : '<span class="muted">not set</span>') },
                ],
                on: {
                  onItemClick(id) {
                    focus = { type: 'flag', id: String(id.row) };
                    refreshAll();
                  },
                  onItemDblClick: (id) => openPipeDetail(id.row, ctx),
                },
              },
            }),
            { height: 12 },
            recentCard(ctx, narrow),
          ],
        }
      : {
          gravity: 2,
          minWidth: 380,
          rows: [
            card({
              title: 'Queue',
              sub: queueSource ? `From ${queueSource} · expected order` : 'Expected order at the entry read point',
              height: narrow ? 260 : 0,
              body: {
                view: 'datatable',
                id: 'st-queue',
                borderless: true,
                scheme: { $change: (o) => (o.$css = o.next ? 'row-next' : '') },
                columns: [
                  { id: 'seq', header: '#', width: 40 },
                  { id: 'pn', header: 'Pipe', width: 88, template: (o) => pipeChip(getPipe(o.id), { size: 'sm' }) },
                  { id: 'wo', header: 'Work order', width: 100, template: (o) => mono(o.wo) },
                  { id: 'queuedAt', header: 'Since', fillspace: 1, minWidth: 80, template: (o) => timeCell(o.queuedAt) },
                ],
                on: {
                  onItemDblClick: (id) => openPipeDetail(id.row, ctx),
                  onAfterRender() {
                    if (!this.count()) this.showOverlay?.('<div class="empty" style="min-height:0;padding:18px"><div class="empty-text">No pipe in the queue</div></div>');
                    else this.hideOverlay?.();
                  },
                },
              },
            }),
            { height: 12 },
            card({
              title: 'At station',
              sub: 'IN recorded; OUT or result still open',
              height: 168,
              body: {
                view: 'datatable',
                id: 'st-at',
                borderless: true,
                columns: [
                  { id: 'pn', header: 'Pipe', width: 88, template: (o) => pipeChip(getPipe(o.id), { size: 'sm', pulse: o.stage === STAGE.AWAIT }) },
                  { id: 'stage', header: 'Stage', width: 130, template: (o) => stagePill(o.stage) },
                  { id: 'inAt', header: 'IN at', fillspace: 1, template: (o) => timeCell(o.inAt) },
                ],
                on: { onItemClick: (id) => openPipeDetail(id.row, ctx) },
              },
            }),
            { height: 12 },
            recentCard(ctx, narrow),
          ],
        };

    return {
      type: 'space',
      css: 'page',
      rows: [
        {
          css: 'card',
          height: 70,
          cols: [
            { view: 'template', id: 'st-head', borderless: true, template: headerHtml },
            {
              width: phone ? 170 : 250,
              rows: [
                {},
                {
                  view: 'richselect',
                  id: 'st-switch',
                  height: 38,
                  width: phone ? 170 : 250,
                  label: phone ? '' : 'Station',
                  labelWidth: phone ? 0 : 62,
                  value: st.slug,
                  options: stationOptions,
                  css: 'st-switch',
                  on: {
                    onChange(v) {
                      const target = getStationBySlug(v);
                      if (user.role === 'Operator') setSessionStation(target.id);
                      ctx.go('station', v);
                    },
                  },
                },
                {},
              ],
            },
            { width: 12 },
          ],
        },
        {
          view: 'template',
          id: 'st-banner',
          hidden: true,
          height: 42,
          borderless: true,
          css: 'banner-host',
          template: '',
          onClick: { 'alarm-banner': () => can('alarms') && ctx.go('alarms') },
        },
        wrapSimbar({ view: 'toolbar', id: 'st-simbar', css: 'simbar', height: 56, paddingX: 12, elements: simElements }),
        mainLayout([leftColumn, rightColumn]),
      ],
    };

    function confirmSelected() {
      const list = webix.$$('st-sugg');
      const id = list.getSelectedId();
      if (!id) {
        toast('Select the pipe in front of you first.', 'warning');
        return;
      }
      const ev = getEvent(focus.id);
      const tx = attempt(
        () => resolveManual(ev.id, id, { actor: currentUser(), mode: list.getIndexById(id) === 0 ? 'SUGGESTION' : 'LIST' }),
        (t) => `${ev.movementType} recorded for ${pipeLabel(getPipe(t.pipeId))} · MANUAL${ev.duplicateOf ? ' (existing transaction updated)' : ''}`
      );
      if (tx) {
        focus = tx.inspection?.required && !tx.inspection.result ? { type: 'inspect', id: tx.id } : null;
        refreshAll();
      }
    }

    function saveFlag() {
      if (!flagSel) {
        toast('Choose a status flag first.', 'warning');
        return;
      }
      const v = webix.$$('st-flag-form').getValues();
      const chosen = flagSel;
      if (focus?.type === 'flagtx') {
        const tx = attempt(
          () => submitInspection(focus.id, { result: chosen, defectCode: v.defectCode, remarks: v.remarks }, { actor: currentUser() }),
          (t) => `${pipeLabel(getPipe(t.pipeId))}: status flag ${statusLabel(chosen)} saved · queued for CTMS via CT-Track`
        );
        if (tx) {
          focus = null;
          refreshAll();
        }
        return;
      }
      if (focus?.type !== 'flag') return;
      const pipeId = focus.id;
      const ok = attempt(
        () => {
          setLimabFlag(pipeId, chosen, { actor: currentUser(), defectCode: v.defectCode, remarks: v.remarks });
          return true;
        },
        `${pipeLabel(getPipe(pipeId))}: flag ${statusLabel(chosen)} saved · applied when the pipe moves`
      );
      if (ok) {
        const next = limabSequence().find((p) => !p.limabFlag);
        focus = next ? { type: 'flag', id: next.id } : { type: 'flag', id: pipeId };
        shownKey = '';
        refreshAll();
      }
    }
  },

  init(ctx) {
    setWatching({ stationId: st.id });
    refreshAll();
    ctx.live(refreshAll, 500);
    ctx.on('opc:tags', () => webix.$$('st-head')?.refresh());
    ctx.every(5000, () => {
      webix.$$('st-readout')?.refresh();
      webix.$$('st-current')?.refresh();
    });
  },

  destroy() {
    setWatching({ stationId: null });
    st = null;
    focus = null;
    ctxRef = null;
  },
};

function recentCard(ctx, narrow) {
  return card({
    title: 'Recent movements',
    sub: 'Saved transactions here and their CTMS status',
    minHeight: narrow ? 320 : 200,
    gravity: 1.3,
    body: {
      view: 'datatable',
      id: 'st-recent',
      borderless: true,
      columns: [
        { id: 'ts', header: 'Time', width: 72, template: (o) => timeCell(o.ts) },
        { id: 'pipeId', header: 'Pipe', width: 80, template: (o) => pipeChip(getPipe(o.pipeId), { size: 'sm' }) },
        { id: 'movement', header: 'Move', width: 66, template: (o) => (o.direction ? dirShort(o.direction) : moveBadge(o.movement)) },
        { id: 'method', header: 'ID', width: 90, template: (o) => `${methodBadge(o.method)}${o.updates ? ` <span class="tag tag-updated" title="Existing transaction updated ${o.updates}× (UC-002 3a)">×${o.updates}</span>` : ''}` },
        { id: 'result', header: 'Result', width: 78, template: (o) => (o.result === 'AWAIT' ? '<span class="chip chip-warn">Pending</span>' : o.result ? pill(o.result) : '<span class="muted">–</span>') },
        { id: 'ctms', header: 'CTMS', fillspace: 1, minWidth: 84, template: (o) => ctmsBadge(getTx(o.id)?.ctms) },
      ],
      on: {
        onItemDblClick(id) {
          const tx = getTx(id.row);
          if (tx) openPipeDetail(tx.pipeId, ctx);
        },
      },
    },
  });
}

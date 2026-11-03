// Report module (FR-011: traceability report with status, quantity, NC, scanner readability and station
// performance; FR-013 traceability history; Rev 1 requirement 12: data extraction for analysis).
// Each report = filters → rows (+ optional chart) → CSV export or JSON extraction.
import webix from '../lib/webix.js';
import { db, getPipe, getTx, getStation, stationName, activeStations } from '../core/db.js';
import { woProgress, pipesOfWo, cycleTimeMs, exceptionRows, CAMERA_SOURCES } from '../core/selectors.js';
import { REASONS } from '../core/traceability.js';
import { TYPE_LABEL } from '../core/ctms.js';
import { cssVar } from '../core/theme.js';
import { esc, fmtDateTime, fmtDuration, fmtPct, startOfDay } from '../core/format.js';
import { card, pill, methodBadge, moveBadge, ctmsBadge, pathBadge, mono, iconButton, exportCsv, downloadText, infoNote, toast } from '../ui/components.js';

const state = { report: 'traceability', range: 'today', station: 'all', wo: 'all' };

function since() {
  const now = Date.now();
  if (state.range === 'today') return startOfDay(now);
  if (state.range === 'shift') return now - 8 * 3600e3;
  if (state.range === '24h') return now - 24 * 3600e3;
  return 0;
}

const inScope = (t) => t.ts >= since() && (state.station === 'all' || t.stationId === state.station) && (state.wo === 'all' || t.wo === state.wo);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

/** Time between IN and OUT per pipe visit at a station (in scope). */
function dwellTimes(stationId) {
  const out = [];
  for (const t of db.transactions) {
    if (t.stationId !== stationId || t.movement !== 'OUT' || !inScope(t)) continue;
    const pipe = getPipe(t.pipeId);
    const idx = pipe.history.indexOf(t.id);
    for (let i = idx - 1; i >= 0; i--) {
      const prev = getTx(pipe.history[i]);
      if (prev.stationId === stationId && prev.movement === 'IN') {
        out.push(t.ts - prev.ts);
        break;
      }
      if (prev.stationId !== stationId) break;
    }
  }
  return out;
}

const REPORTS = {
  traceability: {
    name: 'Traceability report',
    icon: 'mdi-clipboard-list-outline',
    note: 'FR-011: status and quantities per work order (Good, NC, Pending, Reject), progress and cycle time from Limab to Finish HT Cold.',
    chart: () => ({ type: 'stackedBar', barWidth: 26, xAxis: { template: '#id#', lines: false }, yAxis: { start: 0, lines: true }, legend: { values: [{ text: 'Good', color: cssVar('--good') }, { text: 'NC', color: cssVar('--nc') }, { text: 'Pending', color: cssVar('--pending') }, { text: 'Reject', color: cssVar('--reject') }], valign: 'top', align: 'right', layout: 'x' }, series: [{ value: '#good#', color: cssVar('--good'), tooltip: { template: '#id#: #good# good' } }, { value: '#nc#', color: cssVar('--nc'), tooltip: { template: '#id#: #nc# NC' } }, { value: '#pending#', color: cssVar('--pending'), tooltip: { template: '#id#: #pending# pending' } }, { value: '#reject#', color: cssVar('--reject'), tooltip: { template: '#id#: #reject# rejected' } }], padding: { top: 34, left: 40, right: 12, bottom: 34 } }),
    columns: [
      { id: 'id', header: 'Work order', width: 116, template: (o) => mono(o.id) },
      { id: 'product', header: 'Product', fillspace: 1, minWidth: 150 },
      { id: 'qty', header: 'Qty', width: 52, css: 'num' },
      { id: 'received', header: 'Marked', width: 70, css: 'num' },
      { id: 'good', header: 'Good', width: 64, css: 'num' },
      { id: 'nc', header: 'NC', width: 56, css: 'num' },
      { id: 'pending', header: 'Pending', width: 72, css: 'num' },
      { id: 'reject', header: 'Reject', width: 64, css: 'num' },
      { id: 'finished', header: 'Finished', width: 76, css: 'num' },
      { id: 'avg', header: 'Avg cycle', width: 86, template: (o) => fmtDuration(o.avg) },
      { id: 'status', header: 'Status', width: 84, template: (o) => (o.status === 'COMPLETED' ? '<span class="chip chip-good">Valid</span>' : '<span class="chip chip-active">Active</span>') },
    ],
    rows: () =>
      db.workOrders
        .filter((w) => state.wo === 'all' || w.id === state.wo)
        .map((w) => {
          const pr = woProgress(w);
          const pipes = pipesOfWo(w.id);
          const count = (s) => pipes.filter((p) => p.status === s).length;
          return { id: w.id, product: `${w.product.type} ${w.product.od} ${w.product.weight} ${w.product.grade} ${w.product.end}`, qty: w.qty, received: pr.received, good: count('GOOD'), nc: count('NC'), pending: count('PENDING'), reject: count('REJECT'), finished: pr.finished, avg: avg(pipes.map(cycleTimeMs).filter(Boolean)), status: w.status };
        }),
  },
  stations: {
    name: 'Station performance',
    icon: 'mdi-chart-bar',
    note: 'FR-011: pipes in and out per process point, Good / NC, first-pass yield, automatic identification share and average time at the station.',
    chart: () => ({ type: 'bar', barWidth: 16, radius: 2, xAxis: { template: '#code#', lines: false }, yAxis: { start: 0, lines: true }, legend: { values: [{ text: 'IN', color: cssVar('--ok') }, { text: 'OUT', color: cssVar('--accent') }], valign: 'top', align: 'right', layout: 'x' }, series: [{ value: '#in#', color: cssVar('--ok'), tooltip: { template: '#name#: #in# IN' } }, { value: '#out#', color: cssVar('--accent'), tooltip: { template: '#name#: #out# OUT' } }], padding: { top: 34, left: 40, right: 12, bottom: 34 } }),
    columns: [
      { id: 'code', header: 'Code', width: 70, template: (o) => mono(o.code) },
      { id: 'name', header: 'Station', fillspace: 1, minWidth: 150 },
      { id: 'in', header: 'IN', width: 64, css: 'num' },
      { id: 'out', header: 'OUT', width: 64, css: 'num' },
      { id: 'good', header: 'Good', width: 64, css: 'num' },
      { id: 'nc', header: 'NC', width: 56, css: 'num' },
      { id: 'yield', header: 'Yield', width: 76, template: (o) => fmtPct(o.yield) },
      { id: 'autoPct', header: 'Auto ID', width: 80, template: (o) => fmtPct(o.autoPct) },
      { id: 'dwell', header: 'Avg time at station', width: 140, template: (o) => fmtDuration(o.dwell) },
    ],
    rows: () =>
      activeStations()
        .filter((s) => state.station === 'all' || s.id === state.station)
        .map((s) => {
          const tx = db.transactions.filter((t) => t.stationId === s.id && inScope(t));
          const auto = tx.filter((t) => t.method === 'AUTO').length;
          const res = tx.filter((t) => t.inspection?.result);
          const good = res.filter((t) => t.inspection.result === 'GOOD').length;
          return { id: s.id, code: s.code, name: s.name, in: tx.filter((t) => t.movement === 'IN').length, out: tx.filter((t) => t.movement === 'OUT').length, good, nc: res.filter((t) => t.inspection.result === 'NC').length, yield: res.length ? good / res.length : null, autoPct: tx.length ? auto / tx.length : null, dwell: s.id === 'LIMAB' ? null : avg(dwellTimes(s.id)) };
        }),
  },
  reads: {
    name: 'Scanner readability',
    icon: 'mdi-barcode-scan',
    note: 'FR-011: Keyence scanner results per station and reading path. Every failed, unknown or duplicate read is resolved by an operator (UC-003).',
    chart: () => ({ type: 'bar', value: '#ratePct#', barWidth: 26, radius: 3, color: cssVar('--good'), xAxis: { template: '#code#', lines: false }, yAxis: { start: 80, end: 100, step: 5, lines: true }, tooltip: { template: '#name#: #ratePct#%' }, padding: { top: 14, left: 40, right: 12, bottom: 34 } }),
    columns: [
      { id: 'camera', header: 'Scanner', width: 120, template: (o) => mono(o.camera) },
      { id: 'name', header: 'Station', fillspace: 1, minWidth: 140 },
      { id: 'reads', header: 'Reads', width: 70, css: 'num' },
      { id: 'ok', header: 'OK', width: 60, css: 'num' },
      { id: 'noread', header: 'Unreadable', width: 90, css: 'num' },
      { id: 'unknown', header: 'Not found', width: 84, css: 'num' },
      { id: 'opt2', header: 'Option 2', width: 80, css: 'num' },
      { id: 'buffered', header: 'Stored', width: 70, css: 'num' },
      { id: 'updated', header: 'Re-reads', width: 80, css: 'num' },
      { id: 'rate', header: 'Read rate', width: 90, template: (o) => fmtPct(o.rate) },
    ],
    rows: () =>
      activeStations()
        .filter((s) => s.cameraId && (state.station === 'all' || s.id === state.station))
        .map((s) => {
          const ev = db.events.filter((e) => e.stationId === s.id && CAMERA_SOURCES.includes(e.source) && e.ts >= since());
          const ok = ev.filter((e) => e.readStatus === 'OK').length;
          const unknown = ev.filter((e) => e.identification?.reason === 'NOT_FOUND').length;
          const rate = ev.length ? (ok - unknown) / ev.length : null;
          return { id: s.id, camera: s.cameraId, name: s.name, code: s.code, reads: ev.length, ok, noread: ev.length - ok, unknown, opt2: ev.filter((e) => e.readPath === 'OPT2').length, buffered: ev.filter((e) => e.source === 'BUFFER').length, updated: ev.filter((e) => e.duplicateOf).length, rate, ratePct: rate != null ? Math.round(rate * 1000) / 10 : 0 };
        }),
  },
  inspection: {
    name: 'Inspection results & defects',
    icon: 'mdi-clipboard-check-outline',
    note: 'Good / NC entered by operators per process point (UC-004). NC after SEA goes to EMI prove-up; NC elsewhere is held for the supervisor.',
    columns: [
      { id: 'code', header: 'Code', width: 70, template: (o) => mono(o.code) },
      { id: 'name', header: 'Station', fillspace: 1, minWidth: 150 },
      { id: 'good', header: 'Good', width: 70, css: 'num' },
      { id: 'nc', header: 'NC', width: 64, css: 'num' },
      { id: 'yield', header: 'First-pass yield', width: 130, template: (o) => fmtPct(o.yield) },
      { id: 'corrected', header: 'Corrected', width: 90, css: 'num' },
      { id: 'top', header: 'Most frequent defect', width: 240, template: (o) => mono(o.top || '–') },
    ],
    rows: () =>
      activeStations()
        .filter((s) => s.inspection === 'OUT' && s.id !== 'LIMAB' && (state.station === 'all' || s.id === state.station))
        .map((s) => {
          const res = db.transactions.filter((t) => t.stationId === s.id && t.inspection?.result && inScope(t));
          const count = (r) => res.filter((t) => t.inspection.result === r).length;
          const defects = {};
          res.forEach((t) => t.inspection.defectCode && (defects[t.inspection.defectCode] = (defects[t.inspection.defectCode] || 0) + 1));
          const top = Object.entries(defects).sort((a, b) => b[1] - a[1])[0];
          return { id: s.id, code: s.code, name: s.name, good: count('GOOD'), nc: count('NC'), yield: res.length ? count('GOOD') / res.length : null, corrected: res.filter((t) => t.inspection.corrections?.length).length, top: top ? `${top[0]} × ${top[1]}` : '' };
        }),
  },
  limab: {
    name: 'Limab status flags',
    icon: 'mdi-flag-outline',
    note: 'FR-003 / FR-005: status flag per pipe leaving Limab, the direction (left = next station, right = out station) and who set it.',
    columns: [
      { id: 'ts', header: 'Left Limab', width: 120, template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
      { id: 'wo', header: 'Work order', width: 110, template: (o) => mono(o.wo) },
      { id: 'pn', header: 'PN', width: 60, css: 'num' },
      { id: 'flag', header: 'Status flag', width: 100, template: (o) => (o.flag ? pill(o.flag) : '<span class="chip chip-warn">Missing</span>') },
      { id: 'direction', header: 'Direction', width: 150, template: (o) => (o.direction === 'LEFT' ? '← Left · next station' : 'Right · out station →') },
      { id: 'defect', header: 'Defect', width: 70, template: (o) => mono(o.defect || '–') },
      { id: 'by', header: 'Flag by', width: 140 },
      { id: 'method', header: 'Movement', width: 96, template: (o) => methodBadge(o.method) },
      { id: 'ctms', header: 'CTMS', fillspace: 1, minWidth: 110, template: (o) => ctmsBadge(getTx(o.id).ctms) },
    ],
    rows: () =>
      db.transactions
        .filter((t) => t.stationId === 'LIMAB' && t.movement === 'OUT' && t.ts >= since() && (state.wo === 'all' || t.wo === state.wo))
        .slice(-1000)
        .reverse()
        .map((t) => ({ id: t.id, ts: t.ts, wo: t.wo, pn: t.pn, flag: t.inspection?.result || '', direction: t.direction, defect: t.inspection?.defectCode || '', by: t.inspection?.by || '–', method: t.method })),
  },
  movements: {
    name: 'Pipe movement history',
    icon: 'mdi-swap-horizontal',
    note: 'FR-013 traceability history: every IN / OUT record with identification method, reading path, rolling start and read time, operator and result.',
    columns: [
      { id: 'ts', header: 'Time', width: 112, sort: 'int', template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
      { id: 'station', header: 'Station', width: 130, sort: 'string' },
      { id: 'wo', header: 'Work order', width: 104, sort: 'string', template: (o) => mono(o.wo) },
      { id: 'pn', header: 'PN', width: 56, sort: 'int' },
      { id: 'movement', header: 'Move', width: 70, template: (o) => moveBadge(o.movement) },
      { id: 'method', header: 'ID', width: 96, sort: 'string', template: (o) => methodBadge(o.updates ? 'UPDATED' : o.method) },
      { id: 'path', header: 'Path', width: 100, template: (o) => (o.path ? pathBadge(o.path) : '<span class="muted">–</span>') },
      { id: 'roll', header: 'Rolling start', width: 104, template: (o) => (o.roll ? `<span class="mono">${fmtDateTime(o.roll)}</span>` : '<span class="muted">–</span>') },
      { id: 'operator', header: 'Operator', width: 130, sort: 'string' },
      { id: 'result', header: 'Result', width: 80, template: (o) => (o.result ? pill(o.result) : '<span class="muted">–</span>') },
      { id: 'ctms', header: 'CTMS', fillspace: 1, minWidth: 100, template: (o) => ctmsBadge(getTx(o.id).ctms) },
    ],
    rows: () =>
      db.transactions
        .filter(inScope)
        .slice(-1500)
        .reverse()
        .map((t) => ({ id: t.id, ts: t.ts, station: stationName(t.stationId), wo: t.wo, pn: t.pn, movement: t.movement, method: t.method, updates: t.updates || 0, path: t.readPath || '', roll: t.rollStartAt || null, operator: t.operator, result: t.inspection?.result || '' })),
  },
  manual: {
    name: 'Manual identifications',
    icon: 'mdi-hand-back-right-outline',
    note: 'UC-003: events where automatic identification failed and an operator confirmed the suggestion, selected another pipe (4a) or entered the identity (4b).',
    columns: [
      { id: 'ts', header: 'Event time', width: 112, template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
      { id: 'station', header: 'Station', width: 130 },
      { id: 'movement', header: 'Move', width: 70, template: (o) => moveBadge(o.movement) },
      { id: 'reason', header: 'Reason', fillspace: 1, minWidth: 200 },
      { id: 'pipe', header: 'Confirmed pipe', width: 170, template: (o) => mono(o.pipe) },
      { id: 'mode', header: 'How', width: 160 },
      { id: 'rank', header: 'Suggestion #', width: 104, css: 'num' },
      { id: 'by', header: 'Operator', width: 130 },
      { id: 'delay', header: 'Response', width: 86, template: (o) => fmtDuration(o.delay) },
    ],
    rows: () =>
      db.events
        .filter((e) => e.identification && ['RESOLVED', 'DISMISSED'].includes(e.identification.status) && e.identification.reason && e.ts >= since() && (state.station === 'all' || e.stationId === state.station))
        .slice(-800)
        .reverse()
        .map((e) => ({
          id: e.id,
          ts: e.ts,
          station: stationName(e.stationId),
          movement: e.movementType,
          reason: REASONS[e.identification.reason] || e.identification.reason,
          pipe: e.identification.status === 'DISMISSED' ? 'dismissed' : getPipe(e.identification.pipeId)?.dmc || '–',
          mode: { SUGGESTION: 'Confirmed suggestion', LIST: 'Selected another pipe', INPUT: 'Entered identity' }[e.identification.mode] || (e.identification.status === 'DISMISSED' ? 'Dismissed' : '–'),
          rank: e.identification.suggestionRank ?? '–',
          by: e.identification.by || '–',
          delay: e.identification.at ? e.identification.at - e.ts : null,
        })),
  },
  exceptions: {
    name: 'Exceptions',
    icon: 'mdi-alert-circle-outline',
    note: 'FR-006: DMC unreadable, DMC not found in CTMS, duplicate DMC, CTMS not responding, with their resolution.',
    columns: [
      { id: 'ts', header: 'Time', width: 112, template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
      { id: 'label', header: 'Exception', width: 210 },
      { id: 'station', header: 'Where', width: 140 },
      { id: 'detail', header: 'Detail', fillspace: 1, minWidth: 220 },
      { id: 'state', header: 'State', width: 96 },
      { id: 'resolution', header: 'Resolution', width: 280 },
    ],
    rows: () => exceptionRows(2000).filter((r) => r.ts >= since() && (state.station === 'all' || r.stationId === state.station)),
  },
  ctms: {
    name: 'CTMS integration log',
    icon: 'mdi-cloud-sync-outline',
    note: 'UC-005: messages sent to CTMS through CT-Track (inspection results, Limab flags, supervisor decisions, corrections) with the latest response.',
    columns: [
      { id: 'id', header: 'Transaction', width: 108, template: (o) => mono(o.id) },
      { id: 'ts', header: 'Queued', width: 112, template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
      { id: 'type', header: 'Message', width: 140 },
      { id: 'pipe', header: 'Pipe', width: 170, template: (o) => mono(o.pipe) },
      { id: 'station', header: 'Station', width: 130 },
      { id: 'result', header: 'Status', width: 80, template: (o) => pill(o.result) },
      { id: 'attempts', header: 'Tries', width: 56, css: 'num' },
      { id: 'status', header: 'CTMS', width: 120, template: (o) => ctmsBadge(getTx(o.id).ctms) },
      { id: 'response', header: 'Response', fillspace: 1, minWidth: 200 },
    ],
    rows: () =>
      db.transactions
        .filter((t) => t.ctms && t.ctms.status !== 'N/A' && inScope(t))
        .slice(-1000)
        .reverse()
        .map((t) => ({ id: t.id, ts: t.ctms.queuedAt, type: TYPE_LABEL[t.ctms.type] || t.ctms.type, pipe: t.dmc, station: stationName(t.stationId), result: t.ctms.reportStatus || t.inspection?.result, attempts: t.ctms.attempts, status: t.ctms.status, response: t.ctms.response ? `${t.ctms.response.httpStatus} · ${t.ctms.response.message}` : 'Queued' })),
  },
};

let currentRows = [];

function contentConfig() {
  const r = REPORTS[state.report];
  const rows = [];
  rows.push({ view: 'template', borderless: true, autoheight: true, template: () => `<div style="padding:10px 14px 4px">${infoNote(esc(r.note))}</div>` });
  if (r.chart) rows.push({ view: 'chart', id: 'rep-chart', height: 230, ...r.chart() });
  rows.push({ view: 'datatable', id: 'rep-table', borderless: true, columns: r.columns, data: [] });
  return { id: 'rep-content', rows };
}

function renderReport() {
  const r = REPORTS[state.report];
  const holder = webix.$$('rep-content');
  if (holder) webix.ui(contentConfig(), holder);
  currentRows = r.rows();
  webix.$$('rep-table')?.parse(currentRows);
  const ch = webix.$$('rep-chart');
  if (ch) ch.parse(currentRows);
  const head = webix.$$('rep-head');
  if (head) head.setValue(`<div class="sec-title"><span class="sec-name">${esc(r.name)}</span><span class="sec-sub">${currentRows.length} rows · ${{ today: 'today', shift: 'last 8 hours', '24h': 'last 24 hours', all: 'all data in the mock' }[state.range]}${state.station !== 'all' ? ' · ' + esc(stationName(state.station)) : ''}${state.wo !== 'all' ? ' · ' + esc(state.wo) : ''}</span></div>`);
}

/** Rev 1 requirement 12: data extraction for analysis (JSON with the filters used). */
function extractJson() {
  const r = REPORTS[state.report];
  const payload = { report: r.name, extractedAt: new Date().toISOString(), filters: { range: state.range, station: state.station === 'all' ? null : getStation(state.station)?.code, workOrder: state.wo === 'all' ? null : state.wo }, rows: currentRows };
  try {
    downloadText(JSON.stringify(payload, null, 2), `extract-${state.report}.json`, 'application/json');
    toast(`Extracted ${currentRows.length} rows to extract-${state.report}.json`, 'success');
  } catch (err) {
    toast(`Extraction failed: ${err.message}`, 'error');
  }
}

export default {
  route: 'reports',
  title: 'Reports',
  subtitle: 'Traceability report, station performance, scanner readability, results, Limab flags, history, manual IDs, exceptions, CTMS log',
  perm: 'reports',
  nav: { label: 'Reports', icon: 'mdi-file-chart-outline', order: 22 },

  ui() {
    const stations = [{ id: 'all', value: 'All stations' }, ...activeStations().map((s) => ({ id: s.id, value: `${s.code} · ${s.name}` }))];
    const wos = [{ id: 'all', value: 'All work orders' }, ...db.workOrders.map((w) => ({ id: w.id, value: w.id }))];
    return {
      type: 'space',
      css: 'page',
      cols: [
        card({
          title: 'Reports',
          sub: 'Pick a report',
          width: 244,
          body: {
            view: 'list',
            id: 'rep-list',
            borderless: true,
            select: true,
            type: { height: 46 },
            template: (o) => `<i class="mdi ${o.icon}" style="font-size:18px;color:var(--accent-strong);margin-right:8px;vertical-align:-2px"></i>${esc(o.name)}`,
            data: Object.entries(REPORTS).map(([id, r]) => ({ id, name: r.name, icon: r.icon })),
            on: {
              onAfterSelect(id) {
                state.report = id;
                renderReport();
              },
            },
          },
        }),
        {
          css: 'card',
          gravity: 1,
          rows: [
            {
              view: 'toolbar',
              css: 'card-head',
              height: 58,
              paddingX: 14,
              elements: [
                { view: 'label', id: 'rep-head', label: '' },
                {
                  view: 'richselect',
                  width: 132,
                  value: state.range,
                  options: [
                    { id: 'today', value: 'Today' },
                    { id: 'shift', value: 'Last 8 hours' },
                    { id: '24h', value: 'Last 24 hours' },
                    { id: 'all', value: 'All data' },
                  ],
                  on: { onChange: (v) => { state.range = v; renderReport(); } },
                },
                { view: 'richselect', width: 176, value: state.station, options: stations, on: { onChange: (v) => { state.station = v; renderReport(); } } },
                { view: 'richselect', width: 150, value: state.wo, options: wos, on: { onChange: (v) => { state.wo = v; renderReport(); } } },
                iconButton('mdi-export', 'CSV', () => exportCsv('rep-table', `report-${state.report}`), { tooltip: 'Export the table as CSV' }),
                iconButton('mdi-code-json', 'JSON', () => extractJson(), { tooltip: 'Data extraction for analysis (JSON, with the filters used)' }),
              ],
            },
            { id: 'rep-content', template: '' },
          ],
        },
      ],
    };
  },

  init() {
    const list = webix.$$('rep-list');
    if (!REPORTS[state.report]) state.report = 'traceability';
    list.select(state.report);
    renderReport();
  },
};

// Dashboard · Supervisor view (FR-009 supervisor view, FR-014 alarms).
// Totals by status (Total processed, Good, NC, Pending, Reject), current and pending status per station,
// pipes to review (decisions are audited and reported to CTMS through CT-Track), open operator tasks,
// active alarms, the "Pipe queue status" table from the mockup, and throughput / result / read-rate charts.
import webix from '../../lib/webix.js';
import { db, getStation, getPipe, getTx, getWo, stationName } from '../../core/db.js';
import { kpis, statusCounts, movementLabel, stationSnapshot, stationsForDashboard, stationStatusRows } from '../../core/selectors.js';
import { STAGE, heldPipes, pendingIdentifications, pendingInspections, releaseHold, reinspectHold, rejectHold, pipeLabel } from '../../core/traceability.js';
import { retryAllFailed } from '../../core/ctms.js';
import { activeAlarms, ackAlarm } from '../../core/alarms.js';
import { setWatching } from '../../core/simulator.js';
import { currentUser, can } from '../../core/session.js';
import { cssVar } from '../../core/theme.js';
import { fmtDate, fmtTime, fmtAgo, esc } from '../../core/format.js';
import { card, kpiTile, pill, stagePill, mono, timeCell, pipeChip, iconButton, exportCsv, infoNote, attempt, toast, health, pathBadge, severityBadge, alarmState } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';
import { openPipeDetail } from '../common/pipeDetail.js';

const SHORT_REASON = { READ_ERROR: 'DMC unreadable', NOT_FOUND: 'DMC not found in CTMS', DUPLICATE_DMC: 'duplicate DMC', ROUTE_MISMATCH: 'route check' };
const SEV_RANK = { critical: 0, warning: 1, info: 2 };

function kpiHtml() {
  const c = statusCounts();
  const k = kpis();
  const pct = (n) => (c.total ? `${Math.round((n / c.total) * 100)} % of today` : '–');
  return `<div class="kpi-row">
    ${kpiTile({ label: 'Total processed', value: c.total, sub: 'Pipes tracked today', icon: 'mdi-pipe' })}
    ${kpiTile({ label: 'Good', value: c.GOOD, sub: pct(c.GOOD), icon: 'mdi-check-circle-outline', tone: 'good' })}
    ${kpiTile({ label: 'NC', value: c.NC, sub: pct(c.NC), icon: 'mdi-alert-circle-outline', tone: c.NC ? 'nc' : '' })}
    ${kpiTile({ label: 'Pending', value: c.PENDING, sub: 'No result yet, or flagged Pending', icon: 'mdi-progress-question' })}
    ${kpiTile({ label: 'Reject', value: c.REJECT, sub: pct(c.REJECT), icon: 'mdi-close-octagon-outline', tone: c.REJECT ? 'bad' : '' })}
    ${kpiTile({ label: 'Avg cycle time', value: k.avgCycleMs ? `${(k.avgCycleMs / 3600e3).toFixed(1)}<small>h</small>` : '–', sub: 'Limab to finish, last 24 h', icon: 'mdi-timer-outline' })}
  </div>`;
}

function stationRows() {
  return stationStatusRows().map((r) => ({ ...r, currentPipe: r.current || '' }));
}

function reviewRows() {
  return heldPipes().map((p) => {
    const tx = p.lastTxId ? getTx(p.lastTxId) : null;
    return { id: p.id, wo: p.wo, pn: p.pn, station: stationName(p.stationId), status: p.status, reason: p.holdReason || '', defect: tx?.inspection?.defectCode || '–', remarks: tx?.inspection?.remarks || '', since: p.holdAt };
  });
}

function taskRows() {
  const rows = [];
  for (const e of pendingIdentifications()) rows.push({ id: e.id, kind: 'Identity', stationId: e.stationId, station: stationName(e.stationId), detail: `${e.movementType} · ${SHORT_REASON[e.identification.reason] || e.identification.reason}`, ts: e.ts });
  for (const t of pendingInspections()) {
    const flag = t.inspection.kind === 'FLAG';
    rows.push({ id: t.id, kind: flag ? 'Flag' : 'Result', stationId: t.stationId, station: stationName(t.stationId), detail: `${pipeLabel(getPipe(t.pipeId))} waiting for ${flag ? 'the status flag' : getStation(t.stationId).resultLabel}`, ts: t.ts });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

function alarmRows() {
  return activeAlarms()
    .sort((a, b) => (a.state === 'ACTIVE' ? 0 : 1) - (b.state === 'ACTIVE' ? 0 : 1) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.lastAt - a.lastAt)
    .map((a) => ({ id: a.id, severity: a.severity, name: a.name, message: a.message, source: a.source, lastAt: a.lastAt, count: a.count, state: a.state, route: a.route }));
}

function chartData() {
  return stationsForDashboard().map((s) => {
    const snap = stationSnapshot(s.id);
    return { id: s.id, name: s.name, short: s.code, out: snap.outToday, good: snap.good, nc: snap.nc, reject: snap.reject, pending: snap.pendingFlag, rate: snap.readRate != null ? Math.round(snap.readRate * 1000) / 10 : 0, hasCam: !!s.cameraId };
  });
}

function decide(action, pipeId) {
  const pipe = getPipe(pipeId);
  if (!pipe) return;
  const titles = { release: 'Release pipe to the next step?', reinspect: 'Send back for re-inspection?', reject: 'Reject this pipe?' };
  const texts = {
    release: `${pipeLabel(pipe)} continues to the next process point${pipe.status === 'NC' ? ' with status Good (concession)' : ''}. The decision is recorded with your name and sent to CTMS through CT-Track.`,
    reinspect: `${pipeLabel(pipe)} goes back to ${stationName(pipe.stationId)} for a new ${pipe.stationId === 'LIMAB' ? 'status flag' : 'inspection'}.`,
    reject: `${pipeLabel(pipe)} leaves the line and moves to the NC rack. The Reject status is sent to CTMS through CT-Track.`,
  };
  webix
    .confirm({ title: titles[action], text: texts[action], ok: { release: 'Release', reinspect: 'Re-inspect', reject: 'Reject pipe' }[action], cancel: 'Cancel', css: action === 'reject' ? 'confirm-danger' : '' })
    .then(() => {
      const actor = currentUser();
      const fn = { release: releaseHold, reinspect: reinspectHold, reject: rejectHold }[action];
      attempt(() => fn(pipeId, { note: `Decision by ${actor.name}` }, { actor }), { release: 'Pipe released · decision sent to CTMS', reinspect: 'Pipe sent back for re-inspection', reject: 'Pipe rejected · status sent to CTMS' }[action]);
    })
    .catch(() => {});
}

function overlay(table, html) {
  if (!table.count()) table.showOverlay?.(html);
  else table.hideOverlay?.();
}

export default {
  route: 'supervisor',
  title: 'Pipe Tracking & Movement Dashboard',
  subtitle: 'Supervisor view · status totals, stations, pipes to review, alarms and CTMS status',
  perm: 'supervisor',
  nav: { group: 'grp-dash', label: 'Supervisor view', icon: 'mdi-account-tie-outline', order: 2 },

  ui(ctx) {
    const canEdit = can('supervisor', 'edit');
    const canAck = can('alarms', 'edit');
    const good = cssVar('--good', '#2c5fd4');
    const nc = cssVar('--nc', '#f0bd16');
    const reject = cssVar('--reject', '#d23c3c');
    const pending = cssVar('--pending', '#8a94a6');
    const accent = cssVar('--accent', '#37a9ef');
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          { view: 'template', id: 'sup-kpis', css: 'page', borderless: true, autoheight: true, template: kpiHtml },
          card({
            title: 'Stations',
            sub: 'Current and pending pipe movement status per process point, today',
            height: 404,
            actions: [iconButton('mdi-export', 'Export', () => exportCsv('sup-stations', 'station-status'))],
            body: {
              view: 'datatable',
              id: 'sup-stations',
              borderless: true,
              columns: [
                { id: 'code', header: 'Code', width: 70, template: (o) => mono(o.code) },
                { id: 'name', header: 'Station', fillspace: 1, minWidth: 140, template: (o) => `<span class="cell-link">${esc(o.name)}</span>` },
                { id: 'currentPipe', header: 'Current pipe', width: 104, template: (o) => (o.current ? pipeChip(getPipe(o.current), { size: 'sm', pulse: o.currentStage === STAGE.AWAIT }) : '<span class="muted">–</span>') },
                { id: 'queue', header: 'Queue', width: 64, css: 'num' },
                { id: 'processed', header: 'Processed', width: 86, css: 'num' },
                { id: 'good', header: 'Good', width: 60, css: 'num' },
                { id: 'nc', header: 'NC', width: 52, css: 'num', template: (o) => (o.nc ? `<b style="color:var(--nc-deep)">${o.nc}</b>` : '0') },
                { id: 'pending', header: 'Pending', width: 72, css: 'num' },
                { id: 'reject', header: 'Reject', width: 64, css: 'num', template: (o) => (o.reject ? `<b style="color:var(--reject)">${o.reject}</b>` : '0') },
                { id: 'scanner', header: 'Scanner', width: 176, template: (o) => (o.scanner === 'NONE' ? '<span class="muted">none</span>' : `${health(o.scanner)} ${o.scanner !== 'OFFLINE' ? pathBadge(o.scannerPath) : ''}`) },
                { id: 'sensorFault', header: 'Sensors', width: 78, template: (o) => (o.sensorFault ? '<span class="chip chip-reject">Fault</span>' : '<span class="chip chip-good">OK</span>') },
                { id: 'tasks', header: 'Tasks', width: 60, css: 'num', template: (o) => (o.tasks ? `<span class="chip chip-warn">${o.tasks}</span>` : '<span class="muted">0</span>') },
                { id: 'alarms', header: 'Alarms', width: 66, css: 'num', template: (o) => (o.alarms ? `<span class="chip chip-reject">${o.alarms}</span>` : '<span class="muted">0</span>') },
              ],
              on: { onItemClick: (id) => can('station') && ctx.go('station', webix.$$('sup-stations').getItem(id.row).slug) },
            },
          }),
          {
            view: 'flexlayout',
            css: 'page',
            cols: [
              card({
                id: 'sup-review-card',
                title: 'Pipes to review',
                sub: 'On hold: NC without prove-up, or Limab out station',
                minWidth: 690,
                gravity: 1.5,
                height: 330,
                body: {
                  view: 'datatable',
                  id: 'sup-review',
                  borderless: true,
                  rowHeight: 46,
                  columns: [
                    { id: 'pn', header: 'Pipe', width: 140, template: (o) => `${pipeChip(getPipe(o.id), { size: 'sm' })}<span class="mono muted" style="font-size:11.5px">${esc(o.wo)}</span>` },
                    { id: 'station', header: 'Held at', fillspace: 1, minWidth: 90, template: (o) => `<span title="${esc(o.reason)}">${esc(o.station)}</span>` },
                    { id: 'status', header: 'Status', width: 70, template: (o) => pill(o.status) },
                    { id: 'defect', header: 'Defect', width: 58, template: (o) => `<span class="mono" title="${esc(o.remarks)}">${esc(o.defect)}</span>` },
                    { id: 'since', header: 'Held', width: 54, template: (o) => `<span title="${esc(fmtAgo(o.since))}">${fmtTime(o.since, false)}</span>` },
                    {
                      id: 'actions',
                      header: 'Decision',
                      width: 262,
                      template: () =>
                        canEdit
                          ? '<div class="cell-actions"><span class="act act-good act-release"><i class="mdi mdi-check"></i>Release</span><span class="act act-reinspect"><i class="mdi mdi-restore"></i>Re-inspect</span><span class="act act-bad act-reject"><i class="mdi mdi-close"></i>Reject</span></div>'
                          : '<span class="muted">View only</span>',
                    },
                  ],
                  onClick: {
                    'act-release': (e, id) => decide('release', id.row),
                    'act-reinspect': (e, id) => decide('reinspect', id.row),
                    'act-reject': (e, id) => decide('reject', id.row),
                  },
                  on: {
                    onItemDblClick: (id) => openPipeDetail(id.row, ctx),
                    onAfterRender() {
                      overlay(this, '<div class="empty" style="min-height:0"><i class="mdi mdi-check-decagram-outline"></i><div class="empty-title">No pipes on hold</div></div>');
                    },
                  },
                },
              }),
              card({
                title: 'Active alarms',
                sub: 'Exceptions and monitoring alerts (FR-006, FR-014)',
                minWidth: 420,
                height: 330,
                actions: can('alarms') ? [iconButton('mdi-arrow-right', 'All alarms', () => ctx.go('alarms'))] : [],
                body: {
                  view: 'datatable',
                  id: 'sup-alarms',
                  borderless: true,
                  rowHeight: 40,
                  columns: [
                    { id: 'severity', header: 'Severity', width: 96, template: (o) => severityBadge(o.severity) },
                    { id: 'name', header: 'Alarm', fillspace: 1, minWidth: 150, template: (o) => `<span title="${esc(o.message)}">${esc(o.name)}${o.count > 1 ? ` <span class="muted">×${o.count}</span>` : ''}</span>` },
                    { id: 'lastAt', header: 'Last', width: 58, template: (o) => `<span title="${esc(fmtAgo(o.lastAt))}">${fmtTime(o.lastAt, false)}</span>` },
                    { id: 'state', header: 'State', width: 128, template: (o) => (o.state === 'ACTIVE' && canAck ? '<span class="act act-ack"><i class="mdi mdi-check"></i>Acknowledge</span>' : alarmState(o.state)) },
                  ],
                  onClick: {
                    'act-ack': (e, id) => {
                      ackAlarm(id.row, currentUser());
                      return false;
                    },
                  },
                  on: {
                    onItemDblClick(id) {
                      const a = db.alarms.find((x) => x.id === id.row);
                      if (!a?.route) return;
                      const [name, ...rest] = a.route.split('-');
                      if (name === 'station') ctx.go('station', rest.join('-'));
                      else ctx.go(a.route);
                    },
                    onAfterRender() {
                      overlay(this, '<div class="empty" style="min-height:0"><i class="mdi mdi-bell-check-outline"></i><div class="empty-title">No active alarms</div></div>');
                    },
                  },
                },
              }),
              card({
                title: 'Open operator tasks',
                sub: 'Identity confirmations, results and status flags waiting at station displays',
                minWidth: 380,
                height: 330,
                body: {
                  view: 'datatable',
                  id: 'sup-tasks',
                  borderless: true,
                  columns: [
                    { id: 'ts', header: 'Since', width: 80, template: (o) => timeCell(o.ts) },
                    { id: 'station', header: 'Station', width: 140, template: (o) => `<span class="cell-link">${esc(o.station)}</span>` },
                    { id: 'kind', header: 'Task', width: 76, template: (o) => `<span class="chip ${o.kind === 'Identity' ? 'chip-warn' : 'chip-info'}">${o.kind}</span>` },
                    { id: 'detail', header: 'Detail', fillspace: 1, minWidth: 160 },
                  ],
                  on: {
                    onItemClick: (id) => can('station') && ctx.go('station', getStation(webix.$$('sup-tasks').getItem(id.row).stationId).slug),
                    onAfterRender() {
                      overlay(this, '<div class="empty" style="min-height:0"><i class="mdi mdi-check-circle-outline"></i><div class="empty-title">No open tasks</div></div>');
                    },
                  },
                },
              }),
            ],
          },
          card({
            title: 'Pipe queue status',
            sub: 'Latest pipe movement per pipe for active work orders',
            height: 460,
            actions: [
              { view: 'search', id: 'sup-q-search', width: 220, placeholder: 'Search work order or PN', on: { onTimedKeyPress: () => applyFilter() } },
              {
                view: 'richselect',
                id: 'sup-q-status',
                width: 170,
                value: 'all',
                options: [
                  { id: 'all', value: 'All statuses' },
                  { id: 'GOOD', value: 'Good' },
                  { id: 'NC', value: 'NC' },
                  { id: 'REJECT', value: 'Reject' },
                  { id: 'PENDING', value: 'Pending' },
                ],
                on: { onChange: () => applyFilter() },
              },
              iconButton('mdi-export', 'Export', () => exportCsv('sup-queue', 'pipe-queue-status')),
            ],
            body: {
              rows: [
                { view: 'template', borderless: true, autoheight: true, template: () => `<div style="padding:10px 14px 4px">${infoNote('<b>Latest pipe movement</b> is the last known position of the pipe, from the station where it was last tracked.')}</div>` },
                {
                  view: 'datatable',
                  id: 'sup-queue',
                  borderless: true,
                  scheme: { $change: (o) => (o.$css = o.stage === STAGE.HOLD ? 'row-attn' : o.stage === STAGE.REJECTED ? 'row-bad' : '') },
                  columns: [
                    { id: 'wo', header: 'Work order', width: 120, sort: 'string', template: (o) => mono(o.wo) },
                    { id: 'pn', header: 'Pipe number', width: 110, sort: 'int', template: (o) => `PN ${o.pn}` },
                    { id: 'deadline', header: 'Deadline', width: 120, sort: 'int', template: (o) => fmtDate(o.deadline) },
                    { id: 'operator', header: 'Operator name', width: 160, sort: 'string' },
                    { id: 'movement', header: 'Latest pipe movement', fillspace: 1, minWidth: 220, sort: 'string' },
                    { id: 'stage', header: 'Stage', width: 140, template: (o) => stagePill(o.stage) },
                    { id: 'status', header: 'Status', width: 100, sort: 'string', template: (o) => pill(o.status) },
                  ],
                  on: { onItemClick: (id) => openPipeDetail(id.row, ctx) },
                },
              ],
            },
          }),
          {
            view: 'flexlayout',
            css: 'page',
            cols: [
              card({
                title: 'Throughput today',
                sub: 'Pipes leaving each process point (OUT)',
                minWidth: 340,
                height: 300,
                body: { view: 'chart', id: 'sup-ch-out', type: 'bar', value: '#out#', barWidth: 22, radius: 3, color: accent, padding: { top: 14, left: 40, right: 12, bottom: 40 }, xAxis: { template: '#short#', lines: false }, yAxis: { start: 0, lines: true }, tooltip: { template: '#name#: #out# pipes' } },
              }),
              card({
                title: 'Results today',
                sub: 'Good / NC by station · Limab flags incl. Pending and Reject',
                minWidth: 340,
                height: 300,
                body: {
                  view: 'chart',
                  id: 'sup-ch-res',
                  type: 'stackedBar',
                  barWidth: 22,
                  padding: { top: 34, left: 40, right: 12, bottom: 40 },
                  xAxis: { template: '#short#', lines: false },
                  yAxis: { start: 0, lines: true },
                  legend: { values: [{ text: 'Good', color: good }, { text: 'NC', color: nc }, { text: 'Pending', color: pending }, { text: 'Reject', color: reject }], valign: 'top', align: 'right', layout: 'x', margin: 4, padding: 4 },
                  series: [
                    { value: '#good#', color: good, tooltip: { template: '#name#: #good# good' } },
                    { value: '#nc#', color: nc, tooltip: { template: '#name#: #nc# NC' } },
                    { value: '#pending#', color: pending, tooltip: { template: '#name#: #pending# pending' } },
                    { value: '#reject#', color: reject, tooltip: { template: '#name#: #reject# rejected' } },
                  ],
                },
              }),
              card({
                title: 'DMC read rate today',
                sub: 'Successful scanner reads per station',
                minWidth: 340,
                height: 300,
                actions: can('apisync', 'edit') ? [iconButton('mdi-cloud-refresh-outline', 'Retry CTMS', () => toast(`${retryAllFailed({ actor: currentUser() })} failed CTMS submissions re-queued`, 'success'))] : [],
                body: { view: 'chart', id: 'sup-ch-rate', type: 'bar', value: '#rate#', barWidth: 22, radius: 3, color: good, padding: { top: 14, left: 40, right: 12, bottom: 40 }, xAxis: { template: '#short#', lines: false }, yAxis: { start: 80, end: 100, step: 5, lines: true }, tooltip: { template: '#name#: #rate#%' } },
              }),
            ],
          },
        ],
      },
    };

    function applyFilter() {
      const t = webix.$$('sup-queue');
      if (!t) return;
      const q = (webix.$$('sup-q-search')?.getValue() || '').trim().toLowerCase().replace(/^pn\s*/, '');
      const status = webix.$$('sup-q-status')?.getValue() || 'all';
      t.filter((o) => (status === 'all' || o.status === status) && (!q || o.wo.toLowerCase().includes(q) || String(o.pn) === q));
    }
  },

  init(ctx) {
    setWatching({ supervisor: true });
    const refreshCharts = () => {
      const data = chartData();
      for (const [id, rows] of [
        ['sup-ch-out', data],
        ['sup-ch-res', data.filter((d) => getStation(d.id).inspection === 'OUT')],
        ['sup-ch-rate', data.filter((d) => d.hasCam)],
      ]) {
        const ch = webix.$$(id);
        if (ch) {
          ch.clearAll();
          ch.parse(rows);
        }
      }
    };
    const queueStatusRows = () => {
      const activeWos = new Set(db.workOrders.filter((w) => w.status === 'ACTIVE' || w.completedAt > Date.now() - 12 * 3600e3).map((w) => w.id));
      return db.pipes
        .filter((p) => activeWos.has(p.wo))
        .sort((a, b) => a.wo.localeCompare(b.wo) || a.pn - b.pn)
        .map((p) => {
          const tx = p.lastTxId ? getTx(p.lastTxId) : null;
          const wo = getWo(p.wo);
          return { id: p.id, wo: p.wo, pn: p.pn, deadline: wo.deadline, operator: tx ? tx.inspection?.by || tx.operator : '–', movement: movementLabel(p), stage: p.stage, status: p.status, updated: p.lastMoveAt };
        });
    };
    const refresh = () => {
      webix.$$('sup-kpis')?.refresh();
      syncTable('sup-stations', stationRows());
      syncTable('sup-review', reviewRows());
      syncTable('sup-alarms', alarmRows());
      syncTable('sup-tasks', taskRows());
      syncTable('sup-queue', queueStatusRows());
      const t = webix.$$('sup-queue');
      if (t) {
        const q = (webix.$$('sup-q-search')?.getValue() || '').trim().toLowerCase().replace(/^pn\s*/, '');
        const status = webix.$$('sup-q-status')?.getValue() || 'all';
        if (q || status !== 'all') t.filter((o) => (status === 'all' || o.status === status) && (!q || o.wo.toLowerCase().includes(q) || String(o.pn) === q));
      }
    };
    refresh();
    refreshCharts();
    ctx.live(refresh, 700);
    ctx.every(10000, refreshCharts);
  },

  destroy() {
    setWatching({ supervisor: false });
  },
};

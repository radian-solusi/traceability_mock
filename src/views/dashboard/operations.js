// Dashboard · General operations / tracking (operator view).
// Mirrors the "HT Pipe Tracking" operator mockup: KPI tiles, flow between stations,
// pipe queue per station, Data Matrix reading status (with rolling start / read time and reading
// path, FR-007 / FR-001) and pipe tracking status, plus an alarm banner (FR-014).
import webix from '../../lib/webix.js';
import { db, getStation, getPipe } from '../../core/db.js';
import { kpis, flowSteps, readingStatusRows, movementLabel } from '../../core/selectors.js';
import { queueForStation, limabSequence, STAGE } from '../../core/traceability.js';
import { activeAlarms } from '../../core/alarms.js';
import { can } from '../../core/session.js';
import { fmtPct, fmtAgo, esc } from '../../core/format.js';
import { card, kpiTile, pill, stagePill, methodBadge, moveBadge, readBadge, pathBadge, severityBadge, mono, timeCell, infoNote, iconButton, exportCsv, pipeChip } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';
import { openPipeDetail } from '../common/pipeDetail.js';

let queueStation = 'SEA_E';

function refreshTracking() {
  const filter = webix.$$('ops-track-filter')?.getValue() || 'all';
  syncTable('ops-track', trackingRows(filter));
  applyTrackFilter();
}

function applyTrackFilter() {
  const q = (webix.$$('ops-track-search')?.getValue() || '').trim().toLowerCase();
  const t = webix.$$('ops-track');
  if (!t) return;
  if (!q) {
    t.filter();
    return;
  }
  const pn = q.replace(/^pn\s*/, '');
  t.filter((o) => o.wo.toLowerCase().includes(q) || String(o.pn) === pn || getPipe(o.id).dmc.toLowerCase().includes(q));
}

export function kpiStripHtml() {
  const k = kpis();
  return `<div class="kpi-row">
    ${kpiTile({ label: 'Active work orders', value: k.activeWo, sub: 'In process on the HT line', icon: 'mdi-clipboard-text-clock-outline' })}
    ${kpiTile({ label: 'Valid work orders', value: k.validWo, sub: 'All pipes processed', icon: 'mdi-clipboard-check-outline', tone: 'good' })}
    ${kpiTile({ label: 'Pipes to review', value: k.toReview, sub: `${k.held} on hold · ${k.toReview - k.held} NC at prove-up`, icon: 'mdi-alert-decagram-outline', tone: k.toReview ? 'nc' : '' })}
    ${kpiTile({ label: 'Avg cycle time', value: k.avgCycleMs ? `${(k.avgCycleMs / 3600e3).toFixed(1)}<small>h</small>` : '–', sub: 'First station to Finish, last 24 h', icon: 'mdi-timer-outline' })}
    ${kpiTile({ label: 'DMC read rate', value: k.readRate != null ? fmtPct(k.readRate) : '–', sub: `${k.reads} camera reads today · ${k.manualToday} manual IDs`, icon: 'mdi-barcode-scan', tone: k.readRate != null && k.readRate < 0.9 ? 'warn' : '' })}
    ${kpiTile({ label: 'Pipes in line', value: k.inLine, sub: `${k.finishedToday} finished · ${k.rejectedToday} rejected today`, icon: 'mdi-pipe' })}
  </div>`;
}

export function flowHtml() {
  const steps = flowSteps();
  const node = (s) => {
    const attn = s.pendingIds + s.pendingInsp;
    const cls = attn ? 'attn' : s.atCount ? 'busy' : '';
    return `<div class="flow-node ${cls}" data-slug="${s.slug}" title="Open the ${esc(s.name)} station display">
      <div class="flow-node-name">${esc(s.name)}${s.alarms ? ` <i class="mdi mdi-alarm-light" style="color:var(--reject)" title="${s.alarms} active alarm(s)"></i>` : ''}</div>
      <div>${s.current ? pipeChip(s.current, { size: 'sm', pulse: s.current.stage === STAGE.AWAIT }) : '<span class="muted" style="font-size:12px">idle</span>'}</div>
      <div class="flow-node-meta"><span class="mono">${esc(s.code)}</span><span>${s.id === 'LIMAB' ? 'Marked' : 'Queue'} <b>${s.queue}</b></span>${attn ? `<span style="color:var(--warn)"><i class="mdi mdi-alert"></i> <b style="color:var(--warn)">${attn}</b> to confirm</span>` : ''}</div>
    </div>`;
  };
  const html = steps
    .map((step, i) => {
      const nodes = step.stations.map(node).join('');
      return `${i ? '<div class="flow-arrow"><i class="mdi mdi-arrow-right"></i></div>' : ''}<div class="flow-step">
        <div class="flow-step-label">${esc(step.label)}${step.conditional ? '<span class="opt">· only if NC</span>' : ''}</div>
        <div class="flow-alt">${nodes}</div></div>`;
    })
    .join('');
  const finished = db.pipes.filter((p) => p.stage === STAGE.FINISHED).sort((a, b) => b.finishedAt - a.finishedAt);
  const last = finished[0];
  return `<div class="flow">${html}<div class="flow-arrow"><i class="mdi mdi-arrow-right"></i></div>
    <div class="flow-step flow-finish"><div class="flow-step-label">Finish HT Cold</div><div class="flow-node"><div class="flow-node-name">Finished</div><div>${last ? pipeChip(last, { size: 'sm' }) : ''}</div><div class="flow-node-meta"><span>Total <b>${finished.length}</b></span></div></div></div></div>`;
}

function alarmBannerHtml() {
  const list = activeAlarms();
  if (!list.length) return '';
  const rank = { critical: 0, warning: 1, info: 2 };
  const top = [...list].sort((a, b) => (a.state === 'ACTIVE' ? 0 : 1) - (b.state === 'ACTIVE' ? 0 : 1) || rank[a.severity] - rank[b.severity] || b.lastAt - a.lastAt)[0];
  const unack = list.filter((a) => a.state === 'ACTIVE').length;
  return `<div class="alarm-banner ${top.severity === 'critical' ? '' : 'warn'}">${severityBadge(top.severity)}<b>${esc(top.name)}</b><span class="grow">${esc(top.message)}</span><span class="chip chip-muted">${list.length} active${unack ? ` · ${unack} unacknowledged` : ''}</span><span class="muted">${esc(fmtAgo(top.lastAt))}</span></div>`;
}

function queueRows() {
  const list = queueStation === 'LIMAB' ? limabSequence() : queueForStation(queueStation);
  return list.map((p, i) => ({
    id: p.id,
    seq: i + 1,
    wo: p.wo,
    pn: p.pn,
    dmc: p.dmc,
    status: p.status,
    queuedAt: p.queuedAt,
    next: i === 0,
  }));
}

function trackingRows(filter) {
  const since = Date.now() - 3 * 3600e3;
  return db.pipes
    .filter((p) => {
      if (filter === 'line') return [STAGE.QUEUED, STAGE.IN, STAGE.AWAIT].includes(p.stage);
      if (filter === 'hold') return p.stage === STAGE.HOLD || p.status === 'NC';
      if (filter === 'done') return p.stage === STAGE.FINISHED || p.stage === STAGE.REJECTED;
      return p.stage !== STAGE.FINISHED && p.stage !== STAGE.REJECTED ? true : p.finishedAt > since;
    })
    .sort((a, b) => b.lastMoveAt - a.lastMoveAt)
    .slice(0, 300)
    .map((p) => ({ id: p.id, wo: p.wo, pn: p.pn, stage: p.stage, movement: movementLabel(p), status: p.status, lastMoveAt: p.lastMoveAt }));
}

export default {
  route: 'operations',
  title: 'Pipe Tracking & Movement Dashboard',
  subtitle: 'Real-time pipe movement across stations · general operations view',
  perm: 'dashboard',
  nav: { group: 'grp-dash', label: 'Operations / tracking', icon: 'mdi-view-dashboard-outline', order: 1 },

  ui(ctx) {
    const stationOptions = db.stations.filter((s) => s.active !== false && s.dashboard).map((s) => ({ id: s.id, value: `${s.code} · ${s.name}` }));
    return {
      view: 'scrollview',
      css: 'page',
      scroll: 'y',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          {
            view: 'template',
            id: 'ops-banner',
            hidden: true,
            height: 42,
            borderless: true,
            css: 'banner-host',
            template: '',
            onClick: { 'alarm-banner': () => can('alarms') && ctx.go('alarms') },
          },
          { view: 'template', id: 'ops-kpis', css: 'page', borderless: true, autoheight: true, template: kpiStripHtml },
          card({
            title: 'Pipe movement between stations',
            sub: 'Latest pipe at each process point and the queue waiting for it. Click a station to open its display.',
            body: {
              view: 'template',
              id: 'ops-flow',
              borderless: true,
              height: 252,
              template: flowHtml,
              onClick: {
                'flow-node': function (e, id, node) {
                  const slug = node.getAttribute('data-slug');
                  if (slug) ctx.go('station', slug);
                },
              },
            },
          }),
          card({
            title: 'Data Matrix reading status',
            sub: 'Latest scanner reads: option 1 through PLC → Kepware OPC, option 2 direct, or stored in the camera',
            height: 380,
            actions: [iconButton('mdi-export', 'Export', () => exportCsv('ops-reads', 'dmc-reading-status'))],
            body: {
              view: 'datatable',
              id: 'ops-reads',
              borderless: true,
              scheme: { $change: (o) => (o.$css = o.readStatus !== 'OK' || o.method === 'PENDING' ? 'row-attn' : '') },
              columns: [
                { id: 'readAt', header: 'DMC read time', width: 108, template: (o) => timeCell(o.readAt) },
                { id: 'rollStartAt', header: 'Rolling start', width: 100, template: (o) => timeCell(o.rollStartAt) },
                { id: 'station', header: 'Station · point', fillspace: 1, minWidth: 190, template: (o) => `<span class="mono muted">${esc(o.code)}</span> ${esc(o.station)} ${moveBadge(o.movement)}` },
                { id: 'pn', header: 'On process', width: 160, template: (o) => (o.pn != null ? `<b>PN ${o.pn}</b> <span class="mono muted">${esc(o.wo)}</span>` : '<span class="muted">unknown pipe</span>') },
                { id: 'dmc', header: 'Data Matrix', width: 200, template: (o) => mono(o.dmc || '–') },
                { id: 'readStatus', header: 'Reading', width: 112, template: (o) => readBadge(o.readStatus) },
                { id: 'readPath', header: 'Path', width: 104, template: (o) => (o.source === 'BUFFER' ? `${pathBadge(o.readPath)} <i class="mdi mdi-database-clock-outline muted" title="Stored in the camera during a network outage"></i>` : pathBadge(o.readPath)) },
                { id: 'method', header: 'Identity', width: 104, template: (o) => methodBadge(o.method) },
                { id: 'loadTs', header: 'Pipe load', width: 84, template: (o) => timeCell(o.loadTs) },
              ],
              on: {
                onItemClick(id) {
                  const row = this.getItem(id.row);
                  if (row.method === 'PENDING' && can('station')) ctx.go('station', getStation(row.stationId).slug);
                },
              },
            },
          }),
          {
            view: 'flexlayout',
            css: 'page',
            cols: [
              card({
                title: 'Pipe queue status',
                sub: 'Pipes waiting before the scanner position (Limab: marked pipes in DMC order)',
                minWidth: 400,
                height: 420,
                actions: [
                  {
                    view: 'richselect',
                    id: 'ops-q-station',
                    width: 200,
                    value: queueStation,
                    options: stationOptions,
                    on: {
                      onChange(v) {
                        queueStation = v;
                        syncTable('ops-queue', queueRows());
                      },
                    },
                  },
                  iconButton('mdi-export', 'Export', () => exportCsv('ops-queue', `pipe-queue-${queueStation}`)),
                ],
                body: {
                  rows: [
                    { view: 'template', borderless: true, autoheight: true, css: 'pad-note', template: () => `<div style="padding:10px 14px 4px">${infoNote('Order comes from the DMC sequence minus pipes already processed at this point. The first row is the pipe the operator should expect next (the suggestion when a read fails).')}</div>` },
                    {
                      view: 'datatable',
                      id: 'ops-queue',
                      borderless: true,
                      scheme: { $change: (o) => (o.$css = o.next ? 'row-next' : '') },
                      columns: [
                        { id: 'seq', header: '#', width: 46, css: 'num' },
                        { id: 'wo', header: 'Work order', width: 110, template: (o) => mono(o.wo) },
                        { id: 'pn', header: 'Pipe', width: 90, template: (o) => pipeChip(getPipe(o.id), { size: 'sm' }) },
                        { id: 'dmc', header: 'DMC', fillspace: 1, minWidth: 170, template: (o) => mono(o.dmc) },
                        { id: 'queuedAt', header: 'Queued', width: 86, template: (o) => timeCell(o.queuedAt) },
                      ],
                      on: { onItemDblClick: (id) => openPipeDetail(id.row, ctx) },
                    },
                  ],
                },
              }),
              card({
                title: 'Pipe tracking status',
                sub: 'Latest movement of every pipe in the line (and finished in the last 3 h)',
                minWidth: 620,
                height: 420,
                actions: [
                  { view: 'search', id: 'ops-track-search', width: 200, placeholder: 'Work order, PN or DMC', on: { onTimedKeyPress: () => applyTrackFilter() } },
                  {
                    view: 'segmented',
                    id: 'ops-track-filter',
                    width: 300,
                    value: 'all',
                    options: [
                      { id: 'all', value: 'All' },
                      { id: 'line', value: 'In line' },
                      { id: 'hold', value: 'NC / hold' },
                      { id: 'done', value: 'Done' },
                    ],
                    on: { onChange: () => refreshTracking() },
                  },
                  iconButton('mdi-export', 'Export', () => exportCsv('ops-track', 'pipe-tracking-status')),
                ],
                body: {
                  view: 'datatable',
                  id: 'ops-track',
                  borderless: true,
                  scheme: { $change: (o) => (o.$css = o.stage === STAGE.HOLD ? 'row-attn' : o.stage === STAGE.REJECTED ? 'row-bad' : '') },
                  columns: [
                    { id: 'wo', header: 'Work order', width: 110, sort: 'string', template: (o) => mono(o.wo) },
                    { id: 'pn', header: 'Pipe', width: 90, sort: 'int', template: (o) => pipeChip(getPipe(o.id), { size: 'sm' }) },
                    { id: 'stage', header: 'Stage', width: 130, template: (o) => stagePill(o.stage) },
                    { id: 'movement', header: 'Status pipe movement', fillspace: 1, minWidth: 200 },
                    { id: 'status', header: 'Status', width: 90, template: (o) => pill(o.status) },
                    { id: 'lastMoveAt', header: 'Last update', width: 100, sort: 'int', template: (o) => timeCell(o.lastMoveAt) },
                  ],
                  on: { onItemClick: (id) => openPipeDetail(id.row, ctx) },
                },
              }),
            ],
          },
        ],
      },
    };
  },

  init(ctx) {
    const refresh = () => {
      const banner = webix.$$('ops-banner');
      if (banner) {
        const html = alarmBannerHtml();
        if (html) {
          banner.setHTML(html);
          if (!banner.isVisible()) banner.show();
        } else if (banner.isVisible()) banner.hide();
      }
      webix.$$('ops-kpis')?.refresh();
      webix.$$('ops-flow')?.refresh();
      syncTable('ops-queue', queueRows());
      syncTable('ops-reads', readingStatusRows(40));
      refreshTracking();
    };
    refresh();
    ctx.live(refresh, 600);
  },
};

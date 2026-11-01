// API Synchronization module.
// FR-010: the application never calls the IT layer directly; every message to and from CTMS goes
// through CT-Track (PTCT's L1 JSON API). This screen shows the health of each interface, the
// CT-Track → CTMS message queue (UC-005), the reconciliation of tracking data against CTMS
// (Rev 1 requirement 8), DMC batches from the Limab robot (UC-001) and the raw reading events (UC-002).
import webix from '../../lib/webix.js';
import { db, getTx, stationName, stationCode } from '../../core/db.js';
import { ctmsTransactions, retryCtms, retryAllFailed, buildPayload, resendLatest, markReviewed, TYPE_LABEL } from '../../core/ctms.js';
import { integrationHealth } from '../../core/integrations.js';
import { releaseNextDmcBatch, setCtmsOutage, runFullSync } from '../../core/simulator.js';
import { recentEvents } from '../../core/selectors.js';
import { currentUser, can } from '../../core/session.js';
import { esc, fmtTime, fmtAgo, fmtDateTime, fmtNum } from '../../core/format.js';
import { pill, health, mono, timeCell, moveBadge, readBadge, ctmsBadge, pathBadge, iconButton, exportCsv, toast, attempt, infoNote } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';
import { env } from '../../config/env.js';

let ctmsFilter = 'open';
let reconFilter = 'diff';

const SOURCE_NAME = { OPC: 'OPC (opt 1)', KEYENCE: 'Direct (opt 2)', BUFFER: 'Camera buffer', DMC: 'DMC API', SENSOR: 'Limab sensor', OPERATOR: 'Operator' };
const RECON_META = {
  MATCH: { label: 'Match', css: 'chip-good' },
  DIFFERENT: { label: 'Different', css: 'chip-reject' },
  NOT_IN_CTMS: { label: 'Not in CTMS', css: 'chip-warn' },
  REVIEWED: { label: 'Reviewed', css: 'chip-muted' },
};

function cardsHtml() {
  const order = ['DMC', 'OPC', 'KEYENCE', 'CTTRACK', 'LDAP'];
  return `<div class="int-grid">${order
    .map((k) => {
      const it = db.integrations[k];
      const extra =
        k === 'CTTRACK'
          ? `<div class="muted" style="font-size:11.5px">${fmtNum(it.movements || 0)} movements published · full sync ${it.lastFullSync ? fmtAgo(it.lastFullSync) : '–'}</div>`
          : `<div class="muted" style="font-size:11.5px">Last message ${it.lastAt ? `${fmtTime(it.lastAt)} · ${fmtAgo(it.lastAt)}` : '–'}</div>`;
      return `<div class="int-card"><div class="int-top"><span class="int-name">${esc(it.name)}</span>${health(integrationHealth(k))}</div>
        <div class="int-dir">${esc(it.direction)} · <span class="mono" style="text-transform:none;letter-spacing:0">${esc(it.host)}</span></div>
        <div class="int-purpose">${esc(it.purpose)}<br><span class="mono" style="font-size:11px">${esc(it.protocol)}</span></div>
        <div class="int-stats"><div><b>${fmtNum(it.today || 0)}</b>today</div><div><b style="${it.errors ? 'color:var(--reject)' : ''}">${fmtNum(it.errors || 0)}</b>errors</div><div><b>${it.latencyMs != null ? it.latencyMs + ' ms' : '–'}</b>latency</div></div>
        ${extra}</div>`;
    })
    .join('')}</div>`;
}

function ctmsRows() {
  return ctmsTransactions()
    .filter((t) => (ctmsFilter === 'all' ? true : ctmsFilter === 'open' ? t.ctms.status !== 'SUCCESS' : t.ctms.status === ctmsFilter))
    .sort((a, b) => b.ctms.queuedAt - a.ctms.queuedAt)
    .slice(0, 400)
    .map((t) => ({
      id: t.id,
      queuedAt: t.ctms.queuedAt,
      type: t.ctms.type || 'INSPECTION',
      wo: t.wo,
      pn: t.pn,
      station: stationName(t.stationId),
      result: t.ctms.reportStatus || t.inspection?.result,
      attempts: t.ctms.attempts,
      status: t.ctms.status,
      http: t.ctms.response?.httpStatus ?? '–',
      message: t.ctms.response?.message || (t.ctms.inFlight ? 'Sending…' : 'Queued'),
      ref: t.ctms.ref || '',
      next: t.ctms.autoRetry && t.ctms.nextAttemptAt ? t.ctms.nextAttemptAt : null,
    }));
}

function reconRows() {
  const rows = db.recon?.rows || [];
  return rows
    .filter((r) => (reconFilter === 'all' ? true : r.state !== 'MATCH'))
    .map((r) => ({ ...r }))
    .sort((a, b) => (a.state === b.state ? a.wo.localeCompare(b.wo) || a.pn - b.pn : a.state === 'DIFFERENT' ? -1 : b.state === 'DIFFERENT' ? 1 : a.state === 'NOT_IN_CTMS' ? -1 : 1));
}

function reconSummaryHtml() {
  const r = db.recon;
  if (!r) return '<div class="recon-sum">No reconciliation run yet.</div>';
  const s = r.summary;
  return `<div class="recon-sum" style="padding:0 10px"><span>Last run <b class="mono" style="font-size:13px">${fmtTime(r.ts)}</b> · ${esc(fmtAgo(r.ts))} · ${esc(r.by)}</span><span><b>${s.total}</b> compared</span><span><b style="color:var(--ok)">${s.match}</b> match</span><span><b style="color:var(--reject)">${s.different}</b> different</span><span><b style="color:var(--warn)">${s.notInCtms}</b> not in CTMS</span><span><b>${s.reviewed}</b> reviewed</span></div>`;
}

function woRows() {
  return (db.recon?.wos || []).map((w) => ({ id: w.wo, ...w }));
}

function dmcRows() {
  return db.dmcBatches.slice(0, 200).map((b) => ({ id: b.id, ts: b.ts, wo: b.woId, count: b.count, rejected: b.rejected || 0, range: b.pnRange, status: b.status, latency: b.latencyMs, source: b.source }));
}

function eventRows() {
  return recentEvents({ limit: 250 }).map((e) => ({
    id: e.id,
    ts: e.ts,
    code: stationCode(e.stationId),
    station: stationName(e.stationId),
    source: e.source,
    path: e.readPath || '',
    movement: e.movementType,
    direction: e.direction || '',
    plc: e.plcMsg ?? '–',
    dmc: e.barcode || e.rawRead || '',
    read: e.readStatus,
    roll: e.rollStartAt || null,
    readAt: e.readAt || e.ts,
    ident: e.duplicateOf ? 'UPDATED' : e.identification?.status || '–',
    tx: e.txId || '',
  }));
}

function openPayload(txId) {
  const tx = getTx(txId);
  if (!tx) return;
  webix.$$('payload-win')?.destructor();
  const request = {
    method: 'POST',
    url: 'https://ptct-cttrack01/api/v1/ctms/inspection-results',
    headers: { Authorization: 'Bearer eyJhbGciOi… (service JWT)', 'Content-Type': 'application/json', 'X-Idempotency-Key': `${tx.id}-${tx.ctms.type || 'INSPECTION'}` },
    body: buildPayload(tx),
  };
  const win = webix.ui({
    view: 'window',
    id: 'payload-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(760, window.innerWidth - 24),
    height: Math.min(640, window.innerHeight - 24),
    head: esc(`${tx.id} · ${TYPE_LABEL[tx.ctms.type] || 'message'} to CTMS via CT-Track`),
    body: {
      view: 'tabview',
      cells: [
        { header: 'Request to CT-Track', body: { view: 'template', borderless: true, scroll: 'auto', template: `<pre class="json">${esc(JSON.stringify(request, null, 2))}</pre>` } },
        { header: 'Response', body: { view: 'template', borderless: true, scroll: 'auto', template: `<pre class="json">${esc(JSON.stringify(tx.ctms.response || { status: 'Pending', message: 'Not sent yet' }, null, 2))}</pre>` } },
        { header: `Attempts (${tx.ctms.history.length})`, body: { view: 'template', borderless: true, scroll: 'auto', template: `<pre class="json">${esc(JSON.stringify(tx.ctms.history.map((h) => ({ ...h, at: new Date(h.at).toISOString() })), null, 2))}</pre>` } },
      ],
    },
  });
  win.show();
}

function reviewPrompt(row) {
  webix
    .prompt({ width: 480, title: `Mark ${row.wo} PN ${row.pn} as reviewed?`, text: `${row.reason}. Note what was checked with CTMS:`, ok: 'Mark reviewed', cancel: 'Cancel', input: { required: true, placeholder: 'e.g. CTMS corrected by QA, value confirmed' } })
    .then((note) => {
      markReviewed(row.id, note, currentUser());
      toast(`${row.wo} PN ${row.pn} marked as reviewed`, 'success');
    })
    .catch(() => {});
}

const CONTRACT = `<div class="prose">
<p>The mock runs in the browser, but every screen reads and writes through the shapes the Dashboard Traceability Application Server (DTAS, <span class="mono">${esc(env.apiBaseUrl || 'https://ptct-dtas01:3000/api/v1')}</span>) would expose. CT-Track endpoints belong to PTCT; the names below are placeholders for the integration workshop, not agreed contracts.</p>
<h4>Inbound · DMC API → DTAS (UC-001)</h4>
<pre class="json">POST /api/v1/dmc/batches            Authorization: Bearer &lt;JWT&gt;
{ "batchId": "DMC-00017", "workOrder": "WHT26121", "markedAt": "2026-10-29T09:12:00Z",
  "pipes": [ { "pipeNumber": 1, "dmc": "WHT26121-001" } ] }
→ 200 { "accepted": 6, "rejected": [ { "dmc": "…", "reason": "DUPLICATE_DMC" } ] }</pre>
<h4>Reading · option 1: scanner → PLC → Kepware OPC UA (FR-001, main path)</h4>
<pre class="json">subscribe ns=2;s=Siemens_TCPIP.SEA_CONC.HT_W1_SCN_01.ReadCode     (String, 100 ms)
          ns=2;s=Siemens_TCPIP.SEA_CONC.HT_W1_IN_01.State        (Boolean, entry sensor)
          ns=2;s=Siemens_TCPIP.SEA_CONC.HT_01_PLC.RollStartTime  (DateTime)
tag names follow the FR tag table (HT-W1-SCN-01 → item HT_W1_SCN_01)</pre>
<h4>Reading · option 2: direct camera read (FR-001, redundancy)</h4>
<pre class="json">Keyence SR-2000W over TCP from DTAS, used automatically while the PLC / OPC path is down
camera store-and-forward: reads kept in the camera while the network is down, sent with the original time</pre>
<h4>Station display ↔ DTAS</h4>
<pre class="json">GET  /api/v1/stations/{code}/queue          pipe sequence for a process point (UC-003 suggestion)
POST /api/v1/events/{id}/identify           UC-003 { "pipeId", "mode": "SUGGESTION|LIST|INPUT" }
POST /api/v1/movements                      UC-002 / UC-003 4b { "station", "pipeId", "movement" }
                                            same pipe + process point + movement → existing record updated
POST /api/v1/movements/{id}/inspection      UC-004 { "result": "GOOD|NC", "defectCode", "remarks" }
POST /api/v1/limab/pipes/{id}/flag          FR-005 { "flag": "GOOD|NC|REJECT|PENDING" }
WSS  ${esc(env.wsUrl || 'wss://ptct-dtas01:3000/ws')}  topics: trace.event, trace.movement, identify.required,
                                            inspection.required, ctms.status, dmc.batch, alarm</pre>
<h4>DTAS ↔ CT-Track ↔ CTMS (FR-008, FR-010, UC-005)</h4>
<pre class="json">GET  https://ptct-cttrack01/api/v1/ctms/work-orders?line=HT        pipe information from CTMS
POST https://ptct-cttrack01/api/v1/ctms/movements                   movement information
POST https://ptct-cttrack01/api/v1/ctms/inspection-results          results, status flags, decisions
GET  https://ptct-cttrack01/api/v1/ctms/pipes?workOrder=…           full sync / reconciliation
200 { "status": "Success", "ctmsRef": "CTMS-INS-884213" }          → SUCCESS
4xx / 5xx / timeout                                                → FAILED, retried (System parameters)</pre>
</div>`;

export default {
  route: 'api-sync',
  title: 'API Synchronization',
  subtitle: 'DMC API in, scanner reads in, CT-Track ↔ CTMS out, reconciliation',
  perm: 'apisync',
  nav: { group: 'grp-int', label: 'API synchronization', icon: 'mdi-sync', order: 30 },

  ui(ctx) {
    const canEdit = can('apisync', 'edit');
    const startTab = ctx.param === 'recon' ? 'api-recon' : 'api-ctms';
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          { view: 'template', id: 'api-cards', css: 'page', borderless: true, autoheight: true, template: cardsHtml },
          {
            css: 'card',
            height: 600,
            rows: [
              {
                view: 'tabbar',
                id: 'api-tabs',
                multiview: true,
                height: 46,
                value: startTab,
                options: [
                  { id: 'api-ctms', value: 'CT-Track → CTMS' },
                  { id: 'api-recon', value: 'Reconciliation' },
                  { id: 'api-dmc', value: 'DMC inbound' },
                  { id: 'api-opc', value: 'Reading events' },
                  { id: 'api-contract', value: 'API contract' },
                ],
              },
              {
                cells: [
                  {
                    id: 'api-ctms',
                    rows: [
                      {
                        view: 'toolbar',
                        paddingX: 12,
                        height: 52,
                        elements: [
                          {
                            view: 'segmented',
                            id: 'api-ctms-filter',
                            width: 420,
                            value: ctmsFilter,
                            options: [
                              { id: 'open', value: 'Open' },
                              { id: 'FAILED', value: 'Failed' },
                              { id: 'PENDING', value: 'Pending' },
                              { id: 'SUCCESS', value: 'Success' },
                              { id: 'all', value: 'All' },
                            ],
                            on: {
                              onChange(v) {
                                ctmsFilter = v;
                                syncTable('api-ctms-table', ctmsRows());
                              },
                            },
                          },
                          {},
                          canEdit
                            ? {
                                view: 'switch',
                                id: 'api-outage',
                                width: 210,
                                labelRight: 'Simulate CTMS outage',
                                labelWidth: 0,
                                value: db.settings.ctmsOutage ? 1 : 0,
                                on: { onChange: (v) => setCtmsOutage(!!v, currentUser()) },
                              }
                            : { width: 1 },
                          canEdit ? iconButton('mdi-cloud-refresh-outline', 'Retry all failed', () => toast(`${retryAllFailed({ actor: currentUser() })} failed submissions re-queued`, 'success')) : { width: 1 },
                          iconButton('mdi-export', 'Export', () => exportCsv('api-ctms-table', 'ctms-messages')),
                        ],
                      },
                      {
                        view: 'datatable',
                        id: 'api-ctms-table',
                        borderless: true,
                        scheme: { $change: (o) => (o.$css = o.status === 'FAILED' ? 'row-bad' : '') },
                        columns: [
                          { id: 'id', header: 'Transaction', width: 106, template: (o) => mono(o.id) },
                          { id: 'queuedAt', header: 'Queued', width: 76, template: (o) => timeCell(o.queuedAt) },
                          { id: 'type', header: 'Message', width: 140, template: (o) => esc(TYPE_LABEL[o.type] || o.type) },
                          { id: 'wo', header: 'Pipe', width: 140, template: (o) => `PN ${o.pn} <span class="mono muted">${esc(o.wo)}</span>` },
                          { id: 'station', header: 'Station', width: 124 },
                          { id: 'result', header: 'Status', width: 80, template: (o) => pill(o.result) },
                          { id: 'attempts', header: 'Tries', width: 52, css: 'num' },
                          { id: 'status', header: 'CTMS', width: 116, template: (o) => ctmsBadge(getTx(o.id).ctms) },
                          { id: 'message', header: 'Last response', fillspace: 1, minWidth: 200, template: (o) => `<span class="mono">${esc(o.http)}</span> ${esc(o.message)}${o.next ? ` <span class="muted">· retry ${fmtTime(o.next)}</span>` : ''}` },
                          { id: 'ref', header: 'CTMS ref', width: 124, template: (o) => mono(o.ref || '–') },
                          {
                            id: 'actions',
                            header: '',
                            width: 156,
                            template: (o) => `<div class="cell-actions"><span class="act act-payload"><i class="mdi mdi-code-json"></i>Payload</span>${canEdit && o.status === 'FAILED' ? '<span class="act act-retry"><i class="mdi mdi-refresh"></i>Retry</span>' : ''}</div>`,
                          },
                        ],
                        onClick: {
                          'act-payload': (e, id) => openPayload(id.row),
                          'act-retry': (e, id) => {
                            if (retryCtms(id.row, { actor: currentUser() })) toast(`${id.row} re-queued for CTMS`, 'success');
                          },
                        },
                      },
                    ],
                  },
                  {
                    id: 'api-recon',
                    rows: [
                      { view: 'template', id: 'api-recon-sum', borderless: true, height: 40, template: reconSummaryHtml, css: 'recon-host' },
                      {
                        view: 'toolbar',
                        paddingX: 12,
                        height: 50,
                        elements: [
                          { view: 'label', label: '<span class="muted" style="font-size:12.5px">Latest status per pipe in tracking vs the value CTMS holds (Rev 1 requirement 8, FR-010)</span>' },
                          {
                            view: 'segmented',
                            id: 'api-recon-filter',
                            width: 230,
                            value: reconFilter,
                            options: [
                              { id: 'diff', value: 'Differences' },
                              { id: 'all', value: 'All pipes' },
                            ],
                            on: {
                              onChange(v) {
                                reconFilter = v;
                                syncTable('api-recon-table', reconRows());
                              },
                            },
                          },
                          canEdit
                            ? iconButton('mdi-database-sync-outline', 'Full sync now', () => {
                                const r = attempt(() => runFullSync(currentUser()));
                                if (r) toast(`${r.summary.total} pipes compared: ${r.summary.match} match, ${r.summary.different} different, ${r.summary.notInCtms} not in CTMS`, r.summary.different ? 'warning' : 'success');
                              })
                            : { width: 1 },
                          iconButton('mdi-export', 'Export', () => exportCsv('api-recon-table', 'reconciliation')),
                        ],
                      },
                      {
                        type: 'clean',
                        cols: [
                          {
                            view: 'datatable',
                            id: 'api-recon-table',
                            borderless: true,
                            scheme: { $change: (o) => (o.$css = o.state === 'DIFFERENT' ? 'row-bad' : o.state === 'NOT_IN_CTMS' ? 'row-attn' : '') },
                            columns: [
                              { id: 'wo', header: 'Pipe', width: 140, template: (o) => `PN ${o.pn} <span class="mono muted">${esc(o.wo)}</span>` },
                              { id: 'tracking', header: 'Tracking', width: 124, template: (o) => `${pill(o.tracking)} <span class="mono muted">${esc(o.trackingStation)}</span>` },
                              { id: 'ctms', header: 'CTMS', width: 124, template: (o) => (o.ctms ? `${pill(o.ctms)} <span class="mono muted">${esc(o.ctmsStation || '')}</span>` : '<span class="muted">no record</span>') },
                              { id: 'state', header: 'Check', width: 106, template: (o) => `<span class="chip ${RECON_META[o.state].css}">${RECON_META[o.state].label}</span>` },
                              { id: 'reason', header: 'Reason', fillspace: 1, minWidth: 160, template: (o) => `<span title="${esc(o.reason)}">${esc(o.reason)}</span>` },
                              {
                                id: 'actions',
                                header: '',
                                width: 192,
                                template: (o) => (canEdit && (o.state === 'DIFFERENT' || o.state === 'NOT_IN_CTMS') ? '<div class="cell-actions"><span class="act act-resend"><i class="mdi mdi-send-outline"></i>Resend</span><span class="act act-review"><i class="mdi mdi-check"></i>Reviewed</span></div>' : ''),
                              },
                            ],
                            onClick: {
                              'act-resend': (e, id) => {
                                const tx = resendLatest(id.row, 'RESEND', { actor: currentUser() });
                                if (tx) toast(`${tx.id} re-sent to CTMS via CT-Track`, 'success');
                              },
                              'act-review': (e, id) => reviewPrompt(webix.$$('api-recon-table').getItem(id.row)),
                            },
                            on: {
                              onAfterRender() {
                                if (!this.count()) this.showOverlay?.('<div class="empty" style="min-height:0"><i class="mdi mdi-check-all"></i><div class="empty-title">Tracking and CTMS agree</div></div>');
                                else this.hideOverlay?.();
                              },
                            },
                          },
                          { view: 'resizer' },
                          {
                            width: 300,
                            rows: [
                              { view: 'template', borderless: true, height: 50, template: '<div class="sec-title" style="padding:8px 12px"><span class="sec-name" style="font-size:14px">Work orders</span><span class="sec-sub">CTMS quantity vs pipes marked</span></div>' },
                              {
                                view: 'datatable',
                                id: 'api-recon-wo',
                                borderless: true,
                                columns: [
                                  { id: 'wo', header: 'Work order', width: 98, template: (o) => mono(o.wo) },
                                  { id: 'ctmsQty', header: 'CTMS qty', width: 72, css: 'num' },
                                  { id: 'tracked', header: 'Marked', width: 64, css: 'num' },
                                  { id: 'notMarked', header: 'To mark', fillspace: 1, css: 'num', template: (o) => (o.notMarked ? `<span class="chip chip-warn">${o.notMarked}</span>` : '<span class="chip chip-good">0</span>') },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    id: 'api-dmc',
                    rows: [
                      {
                        view: 'toolbar',
                        paddingX: 12,
                        height: 52,
                        elements: [
                          { view: 'label', label: `<span class="muted">Released in CTMS, not marked yet: ${(db.upcoming || []).map((u) => `<span class="mono">${esc(u.id)}</span> (${u.qty})`).join(', ') || 'none'}</span>`, id: 'api-upcoming' },
                          {},
                          canEdit
                            ? iconButton('mdi-robot-industrial', 'Robot marks a batch', () => {
                                const b = attempt(() => releaseNextDmcBatch({ actor: currentUser() }));
                                if (b) toast(`DMC batch ${b.id}: ${b.count} pipes for ${b.woId}`, 'success');
                              })
                            : { width: 1 },
                          canEdit
                            ? iconButton('mdi-content-duplicate', 'Batch with a duplicate DMC', () => {
                                const b = attempt(() => releaseNextDmcBatch({ count: 3, actor: currentUser(), withDuplicate: true }));
                                if (b) toast(`DMC batch ${b.id}: ${b.count} pipes accepted, ${b.rejected} duplicate DMC rejected`, b.rejected ? 'warning' : 'success');
                              })
                            : { width: 1 },
                          iconButton('mdi-export', 'Export', () => exportCsv('api-dmc-table', 'dmc-batches')),
                        ],
                      },
                      {
                        view: 'datatable',
                        id: 'api-dmc-table',
                        borderless: true,
                        columns: [
                          { id: 'id', header: 'Batch', width: 110, template: (o) => mono(o.id) },
                          { id: 'ts', header: 'Received', width: 130, template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
                          { id: 'wo', header: 'Work order', width: 120, template: (o) => mono(o.wo) },
                          { id: 'count', header: 'Pipes', width: 70, css: 'num' },
                          { id: 'rejected', header: 'Rejected', width: 80, css: 'num', template: (o) => (o.rejected ? `<span class="chip chip-warn" title="Duplicate DMC (FR-006)">${o.rejected}</span>` : '0') },
                          { id: 'range', header: 'Pipe numbers', width: 130 },
                          { id: 'source', header: 'Source', fillspace: 1, minWidth: 200 },
                          { id: 'latency', header: 'Latency', width: 90, template: (o) => `${o.latency} ms` },
                          { id: 'status', header: 'Status', width: 120, template: (o) => `<span class="chip ${o.status === 'PROCESSED' ? 'chip-good' : o.status === 'PARTIAL' ? 'chip-warn' : 'chip-muted'}">${o.status === 'PROCESSED' ? 'Processed' : o.status === 'PARTIAL' ? 'Partial' : 'Duplicate'}</span>` },
                        ],
                      },
                    ],
                  },
                  {
                    id: 'api-opc',
                    rows: [
                      { view: 'template', borderless: true, autoheight: true, template: () => `<div style="padding:10px 12px 6px">${infoNote('Raw events before and after identification: scanner reads through PLC → Kepware OPC (option 1), direct camera reads (option 2), reads stored in the camera during a network outage, Limab sensors, DMC batches and operator entries. PLC message 10 = start record (entry), 20 = stop record (exit).')}</div>` },
                      {
                        view: 'datatable',
                        id: 'api-opc-table',
                        borderless: true,
                        scheme: { $change: (o) => (o.$css = o.ident === 'REQUIRED' ? 'row-attn' : '') },
                        columns: [
                          { id: 'id', header: 'Event', width: 112, template: (o) => mono(o.id) },
                          { id: 'ts', header: 'Time', width: 80, template: (o) => timeCell(o.ts) },
                          { id: 'station', header: 'Station', width: 150, template: (o) => `<span class="mono muted">${esc(o.code)}</span> ${esc(o.station)}` },
                          { id: 'source', header: 'Source', width: 112, template: (o) => esc(SOURCE_NAME[o.source] || o.source) },
                          { id: 'path', header: 'Path', width: 98, template: (o) => (o.path ? pathBadge(o.path) : '<span class="muted">–</span>') },
                          { id: 'movement', header: 'Point', width: 70, template: (o) => moveBadge(o.movement) },
                          { id: 'plc', header: 'PLC', width: 52, css: 'num' },
                          { id: 'dmc', header: 'Data Matrix', fillspace: 1, minWidth: 190, template: (o) => mono(o.dmc || '–') },
                          { id: 'read', header: 'Read', width: 112, template: (o) => readBadge(o.read) },
                          { id: 'roll', header: 'Rolling start', width: 96, template: (o) => timeCell(o.roll) },
                          { id: 'readAt', header: 'Read time', width: 84, template: (o) => timeCell(o.readAt) },
                          { id: 'ident', header: 'Identification', width: 118, template: (o) => `<span class="chip ${o.ident === 'REQUIRED' ? 'chip-warn' : o.ident === 'AUTO' ? 'chip-info' : 'chip-muted'}" title="${esc(o.tx)}">${esc(o.ident)}</span>` },
                        ],
                      },
                    ],
                  },
                  { id: 'api-contract', view: 'scrollview', scroll: 'y', body: { view: 'template', borderless: true, autoheight: true, template: CONTRACT } },
                ],
              },
            ],
          },
        ],
      },
    };
  },

  init(ctx) {
    const refresh = () => {
      webix.$$('api-cards')?.refresh();
      syncTable('api-ctms-table', ctmsRows());
      syncTable('api-recon-table', reconRows());
      syncTable('api-recon-wo', woRows());
      webix.$$('api-recon-sum')?.refresh();
      syncTable('api-dmc-table', dmcRows());
      syncTable('api-opc-table', eventRows());
      const sw = webix.$$('api-outage');
      if (sw && !!sw.getValue() !== !!db.settings.ctmsOutage) {
        sw.blockEvent();
        sw.setValue(db.settings.ctmsOutage ? 1 : 0);
        sw.unblockEvent();
      }
      const up = webix.$$('api-upcoming');
      if (up) up.setValue(`<span class="muted">Released in CTMS, not marked yet: ${(db.upcoming || []).map((u) => `<span class="mono">${esc(u.id)}</span> (${u.qty})`).join(', ') || 'none'}</span>`);
    };
    refresh();
    ctx.live(refresh, 700);
    ctx.every(2000, () => webix.$$('api-cards')?.refresh());
  },
};

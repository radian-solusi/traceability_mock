// Work Order Pipe Information module (UC-001): work orders and pipe information from CTMS through
// CT-Track, unique numbers from the DMC API (Limab robot), status flag indicator per pipe (FR-003).
import webix from '../lib/webix.js';
import { db, getWo, getPipe, getTx } from '../core/db.js';
import { STATUS_MARKING } from '../data/masterData.js';
import { woProgress, pipesOfWo, movementLabel, cycleTimeMs } from '../core/selectors.js';
import { STAGE } from '../core/traceability.js';
import { releaseNextDmcBatch } from '../core/simulator.js';
import { currentUser, can } from '../core/session.js';
import { esc, fmtDate, fmtDuration, fmtDateTime } from '../core/format.js';
import { card, pill, methodBadge, mono, timeCell, pipeChip, progressBar, iconButton, exportCsv, toast, attempt, infoNote } from '../ui/components.js';
import { syncTable } from '../ui/table.js';
import { openPipeDetail } from './common/pipeDetail.js';

let selectedWo = null;

const productText = (p) => (p ? `${p.od} · ${p.weight} · ${p.grade} · ${p.end}` : '–');

function woRows() {
  const rows = db.workOrders.map((w) => {
    const pr = woProgress(w);
    return { id: w.id, salesOrder: w.salesOrder, product: productText(w.product), type: w.product.type, qty: w.qty, received: pr.received, done: pr.done, pct: pr.pct, status: w.status, deadline: w.deadline, createdAt: w.createdAt };
  });
  for (const u of db.upcoming || []) {
    rows.push({ id: u.id, salesOrder: u.salesOrder, product: productText(u.product), type: u.product.type, qty: u.qty, received: 0, done: 0, pct: 0, status: 'RELEASED', deadline: null, createdAt: null });
  }
  return rows.sort((a, b) => b.id.localeCompare(a.id));
}

function woStatus(s) {
  if (s === 'ACTIVE') return '<span class="chip chip-active">Active</span>';
  if (s === 'COMPLETED') return '<span class="chip chip-good">Valid · completed</span>';
  if (s === 'RELEASED') return '<span class="chip chip-muted">Released · waiting for Limab</span>';
  return esc(s);
}

function woStatusShort(s) {
  if (s === 'ACTIVE') return '<span class="chip chip-active">Active</span>';
  if (s === 'COMPLETED') return '<span class="chip chip-good" title="All pipes processed">Valid</span>';
  if (s === 'RELEASED') return '<span class="chip chip-muted" title="Released in CTMS, waiting for marking at Limab">Released</span>';
  return esc(s);
}

function detailHtml() {
  if (!selectedWo) return `<div class="empty"><i class="mdi mdi-clipboard-text-search-outline"></i><div class="empty-title">Select a work order</div></div>`;
  const w = getWo(selectedWo);
  const up = (db.upcoming || []).find((u) => u.id === selectedWo);
  if (!w && up) {
    return `<div style="padding:16px;display:flex;flex-direction:column;gap:10px">${infoNote(`<b>${esc(up.id)}</b> is released in CTMS (${esc(up.salesOrder)}, ${up.qty} pipes, ${esc(productText(up.product))}) but no pipe has been marked at Limab yet. Pipes appear here when the robot marks them and the DMC API sends their unique numbers.`)}</div>`;
  }
  const pr = woProgress(w);
  const finished = pipesOfWo(w.id).filter((p) => p.stage === STAGE.FINISHED);
  const cts = finished.map(cycleTimeMs).filter(Boolean);
  const avg = cts.length ? cts.reduce((a, b) => a + b, 0) / cts.length : null;
  return `<div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="sec-name" style="font-size:22px">${esc(w.id)}</span>${woStatus(w.status)}<span class="muted">${esc(w.salesOrder)} · ${esc(w.product.type)} ${esc(productText(w.product))}</span></div>
    <div class="trace-facts">
      <div class="fact"><span>Quantity</span><b>${w.qty} pipes</b></div>
      <div class="fact"><span>Marked (DMC)</span><b>${pr.received} / ${w.qty}</b></div>
      <div class="fact"><span>Finished</span><b style="color:var(--good)">${pr.finished}</b></div>
      <div class="fact"><span>Rejected</span><b style="color:var(--reject)">${pr.rejected}</b></div>
      <div class="fact"><span>In line / on hold</span><b>${pr.inLine} / ${pr.hold}</b></div>
      <div class="fact"><span>Avg cycle time</span><b>${avg ? fmtDuration(avg) : '–'}</b></div>
      <div class="fact"><span>Deadline</span><b>${fmtDate(w.deadline)}</b></div>
      <div class="fact"><span>First marked</span><b>${fmtDateTime(w.createdAt)}</b></div>
      <div class="fact"><span>Source</span><b>CTMS via CT-Track · DMC API</b></div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">${progressBar(pr.pct, 'good')}<span class="mono" style="white-space:nowrap">${Math.round(pr.pct * 100)}% done</span></div>
  </div>`;
}

function pipeRows() {
  if (!selectedWo) return [];
  return pipesOfWo(selectedWo).map((p) => {
    const tx = p.lastTxId ? getTx(p.lastTxId) : null;
    const limab = p.history.map(getTx).find((t) => t?.stationId === 'LIMAB' && t.movement === 'OUT');
    return { id: p.id, pn: p.pn, dmc: p.dmc, heat: p.heat, lengthM: p.lengthM, weightKg: p.weightKg, flag: limab?.inspection?.result || p.limabFlag || '', flagDir: limab?.direction || '', movement: movementLabel(p), stage: p.stage, status: p.status, method: tx?.updates ? 'UPDATED' : tx?.method || '–', updated: p.lastMoveAt };
  });
}

function refreshDetail() {
  webix.$$('wo-detail')?.refresh();
  webix.$$('wo-detail')?.resize();
  syncTable('wo-pipes', pipeRows());
}

export default {
  route: 'work-orders',
  title: 'Work Orders & Pipes',
  subtitle: 'Work orders and pipe information from CTMS (through CT-Track) and the DMC unique numbers from the Limab robot',
  perm: 'workorders',
  nav: { label: 'Work orders & pipes', icon: 'mdi-clipboard-list-outline', order: 20 },

  ui(ctx) {
    const canEdit = can('workorders', 'edit') || can('apisync', 'edit');
    if (!selectedWo) selectedWo = db.workOrders.find((w) => w.status === 'ACTIVE')?.id || db.workOrders[0]?.id;
    return {
      type: 'space',
      css: 'page',
      cols: [
        card({
          title: 'Work orders',
          sub: 'From CTMS through CT-Track',
          gravity: 1.1,
          minWidth: 480,
          actions: [
            { view: 'search', id: 'wo-search', width: 150, placeholder: 'Search', on: { onTimedKeyPress: () => filterWo() } },
            canEdit
              ? iconButton('mdi-robot-industrial', 'DMC batch', () => {
                  const b = attempt(() => releaseNextDmcBatch({ actor: currentUser() }));
                  if (b) {
                    toast(`DMC batch ${b.id}: ${b.count} pipes for ${b.woId} marked at Limab`, 'success');
                    selectedWo = b.woId;
                    refreshAll();
                  }
                }, { tooltip: 'Simulate the Limab robot marking the next 6 pipes (DMC API push)' })
              : { width: 1 },
          ],
          body: {
            view: 'datatable',
            id: 'wo-list',
            borderless: true,
            select: 'row',
            rowHeight: 58,
            columns: [
              { id: 'id', header: 'Work order', width: 104, template: (o) => `<div style="line-height:1.35;padding-top:8px"><span class="mono" style="font-weight:600">${esc(o.id)}</span><br><span class="muted" style="font-size:11.5px">${esc(o.salesOrder)}</span></div>` },
              { id: 'product', header: 'Product', fillspace: 1, minWidth: 150, template: (o) => `<div style="line-height:1.35;padding-top:8px">${esc(o.type)}<br><span class="muted" style="font-size:11.5px">${esc(o.product)}</span></div>` },
              { id: 'pct', header: 'Progress', width: 118, template: (o) => `<div style="padding-top:14px;line-height:1.2">${progressBar(o.pct, 'good')}<div class="muted" style="font-size:11.5px;margin-top:4px">${o.done}/${o.qty} done</div></div>` },
              { id: 'status', header: 'Status', width: 98, template: (o) => `<div style="padding-top:17px">${woStatusShort(o.status)}</div>` },
            ],
            on: {
              onAfterSelect(id) {
                selectedWo = id.row;
                refreshDetail();
              },
            },
          },
        }),
        {
          gravity: 1.6,
          minWidth: 520,
          rows: [
            card({ title: 'Work order detail', sub: 'Progress through the HT finishing line', body: { view: 'template', id: 'wo-detail', borderless: true, autoheight: true, template: detailHtml } }),
            { height: 12 },
            card({
              title: 'Pipes',
              sub: 'DMC unique numbers, Limab status flag and current position. Click a pipe for its record.',
              actions: [iconButton('mdi-export', 'Export', () => exportCsv('wo-pipes', `pipes-${selectedWo}`))],
              body: {
                view: 'datatable',
                id: 'wo-pipes',
                borderless: true,
                scheme: { $change: (o) => (o.$css = o.stage === STAGE.HOLD ? 'row-attn' : o.stage === STAGE.REJECTED ? 'row-bad' : '') },
                columns: [
                  { id: 'pn', header: 'Pipe', width: 90, sort: 'int', template: (o) => pipeChip(getPipe(o.id), { size: 'sm' }) },
                  { id: 'dmc', header: 'DMC', width: 190, template: (o) => mono(o.dmc) },
                  { id: 'heat', header: 'Heat', width: 80, template: (o) => mono(o.heat) },
                  { id: 'flag', header: 'Limab flag', width: 104, template: (o) => (o.flag ? `<span title="${esc(STATUS_MARKING[o.flag])}${o.flagDir ? (o.flagDir === 'LEFT' ? ' · left' : ' · right (out station)') : ' · prepared'}">${pill(o.flag)}</span>` : '<span class="muted">–</span>') },
                  { id: 'lengthM', header: 'Length', width: 70, template: (o) => `${o.lengthM.toFixed(2)} m` },
                  { id: 'movement', header: 'Location', fillspace: 1, minWidth: 170 },
                  { id: 'status', header: 'Status', width: 92, template: (o) => pill(o.status) },
                  { id: 'method', header: 'Last ID', width: 98, template: (o) => methodBadge(o.method) },
                  { id: 'updated', header: 'Updated', width: 84, template: (o) => timeCell(o.updated) },
                ],
                on: { onItemClick: (id) => openPipeDetail(id.row, ctx) },
              },
            }),
          ],
        },
      ],
    };

    function filterWo() {
      const q = (webix.$$('wo-search')?.getValue() || '').trim().toLowerCase();
      webix.$$('wo-list')?.filter((o) => !q || o.id.toLowerCase().includes(q) || o.salesOrder.toLowerCase().includes(q) || o.product.toLowerCase().includes(q));
    }
  },

  init(ctx) {
    refreshAll();
    ctx.live(refreshAll, 800);
  },
};

function refreshAll() {
  syncTable('wo-list', woRows());
  const list = webix.$$('wo-list');
  if (list && selectedWo && list.exists(selectedWo) && list.getSelectedId()?.row !== selectedWo) {
    list.blockEvent();
    list.select(selectedWo);
    list.unblockEvent();
  }
  refreshDetail();
}

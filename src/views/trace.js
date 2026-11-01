// Pipe trace (FR-013 traceability history, TRC-005): full genealogy of one pipe
// (DMC → status flag → every station → results → CTMS) and manual corrections (FR-015).
import webix from '../lib/webix.js';
import { db, getPipe, getTx, getEvent, getStation, stationName } from '../core/db.js';
import { searchPipes, recentTransactions } from '../core/selectors.js';
import { pipeLabel, statusLabel, REASONS, canCorrect, correctResult } from '../core/traceability.js';
import { currentUser, can } from '../core/session.js';
import { esc, fmtDateTime } from '../core/format.js';
import { card, pill, methodBadge, moveBadge, ctmsBadge, pathBadge, pipeChip, iconButton, exportCsv, emptyState, infoNote, attempt } from '../ui/components.js';
import { pipeHeaderHtml, pipeTimelineHtml } from './common/timeline.js';
import { syncTable } from '../ui/table.js';

let pipeId = null;

function recentPicks() {
  const seen = new Set();
  const picks = [];
  for (const t of recentTransactions({ limit: 80 })) {
    if (seen.has(t.pipeId)) continue;
    seen.add(t.pipeId);
    picks.push(getPipe(t.pipeId));
    if (picks.length >= 12) break;
  }
  return picks;
}

function introHtml() {
  const picks = recentPicks();
  return `<div style="padding:18px;display:flex;flex-direction:column;gap:14px">
    ${emptyState('mdi-timeline-text-outline', 'Find a pipe', 'Search by DMC code, or work order + pipe number (e.g. WHT26119 PN 12). Or pick a pipe that moved recently:')}
    <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">${picks.map((p) => `<span class="trace-pick" data-id="${esc(p.id)}" style="cursor:pointer">${pipeChip(p)}<span class="mono muted" style="font-size:11.5px">${esc(p.wo)}</span></span>`).join('')}</div>
  </div>`;
}

function txRows() {
  const p = getPipe(pipeId);
  if (!p) return [];
  return p.history.map((id) => {
    const t = getTx(id);
    const ev = getEvent(t.eventId);
    return {
      id: t.id,
      ts: t.ts,
      station: stationName(t.stationId),
      movement: t.movement,
      direction: t.direction || '',
      method: t.method,
      updates: t.updates || 0,
      path: t.readPath || '',
      operator: t.operator,
      source: t.source,
      corrected: t.inspection?.corrections?.length || 0,
      correctable: canCorrect(t).ok ? 1 : 0,
      read: ev?.readStatus || '–',
      reason: ev?.identification?.reason ? REASONS[ev.identification.reason] : '',
      result: t.inspection?.result || '',
      defect: t.inspection?.defectCode || '',
      ctms: t.ctms?.status || 'N/A',
      ctmsRef: t.ctms?.ref || '',
    };
  });
}

function openCorrection(txId) {
  const tx = getTx(txId);
  const check = canCorrect(tx);
  if (!check.ok) {
    webix.message({ type: 'error', text: esc(check.reason) });
    return;
  }
  const st = getStation(tx.stationId);
  const options = st.resultOptions.filter((r) => r !== tx.inspection.result).map((r) => ({ id: r, value: statusLabel(r) }));
  const defects = db.defects[st.processType] || [];
  webix.$$('corr-win')?.destructor();
  const win = webix.ui({
    view: 'window',
    id: 'corr-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(560, window.innerWidth - 24),
    head: esc(`Correct ${tx.inspection.kind === 'FLAG' ? 'status flag' : 'result'} · ${tx.id}`),
    body: {
      view: 'form',
      id: 'corr-form',
      elementsConfig: { labelWidth: 130 },
      elements: [
        { view: 'template', borderless: true, autoheight: true, template: () => infoNote(`${esc(pipeLabel(getPipe(tx.pipeId)))} at ${esc(st.name)}: recorded <b>${esc(statusLabel(tx.inspection.result))}</b> by ${esc(tx.inspection.by)}. The correction re-routes the pipe from this station, is sent to CTMS through CT-Track, and is written to the audit trail with the before and after values (FR-015).`) },
        { view: 'richselect', name: 'result', label: 'Correct to', options, value: options[0]?.id, on: { onChange: (v) => (v === 'NC' || v === 'REJECT' ? webix.$$('corr-defect').enable() : webix.$$('corr-defect').disable()) } },
        { view: 'richselect', id: 'corr-defect', name: 'defectCode', label: 'Defect code', options: defects, disabled: !(options[0]?.id === 'NC' || options[0]?.id === 'REJECT'), placeholder: 'Required for NC / Reject' },
        { view: 'textarea', name: 'reason', label: 'Reason', height: 70, placeholder: 'Why is the recorded value wrong? (required)' },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Save correction',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const v = webix.$$('corr-form').getValues();
                const ok = attempt(() => correctResult(tx.id, { result: v.result, defectCode: v.defectCode, reason: v.reason }, { actor: currentUser() }), `${tx.id} corrected to ${statusLabel(v.result)} · sent to CTMS`);
                if (ok) win.close();
              },
            },
          ],
        },
      ],
    },
  });
  win.show();
}

function findPipe(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const direct = getPipe(s.toUpperCase());
  if (direct) return direct;
  const m = s.match(/(WHT\d{5}).*?(?:PN)?\s*(\d{1,3})$/i);
  if (m) {
    const p = db.pipes.find((x) => x.wo === m[1].toUpperCase() && x.pn === Number(m[2]));
    if (p) return p;
  }
  return searchPipes(s, 1)[0] || null;
}

export default {
  route: 'trace',
  title: 'Pipe Trace',
  subtitle: 'Complete history of one pipe: DMC marking, every station, inspection results and CTMS submissions',
  perm: 'trace',
  nav: { label: 'Pipe trace', icon: 'mdi-timeline-text-outline', order: 21 },

  ui(ctx) {
    pipeId = ctx.param ? getPipe(ctx.param.toUpperCase())?.id || null : null;
    const canFix = can('supervisor', 'edit');
    const go = () => {
      const p = findPipe(webix.$$('trace-q').getValue());
      if (!p) {
        webix.message({ type: 'error', text: 'No pipe matches. Try a DMC code like WHT26119-012, or “WHT26119 12”.' });
        return;
      }
      ctx.go('trace', p.id);
    };
    const body = pipeId
      ? {
          type: 'clean',
          css: 'page',
          margin: 12,
          cols: [
            card({
              title: pipeLabel(getPipe(pipeId)),
              sub: 'Genealogy, oldest first',
              gravity: 1,
              minWidth: 400,
              body: {
                rows: [
                  { view: 'template', borderless: true, autoheight: true, template: () => pipeHeaderHtml(pipeId) },
                  { view: 'scrollview', scroll: 'y', borderless: true, body: { view: 'template', id: 'trace-tl', borderless: true, autoheight: true, template: () => pipeTimelineHtml(pipeId) } },
                ],
              },
            }),
            card({
              title: 'Movement records',
              sub: canFix ? 'One row per IN / OUT transaction · correct a result with the pencil while the pipe has not moved' : 'One row per IN / OUT transaction (records table)',
              gravity: 1.9,
              minWidth: 520,
              actions: [iconButton('mdi-export', 'Export', () => exportCsv('trace-tx', `trace-${pipeId}`))],
              body: {
                view: 'datatable',
                id: 'trace-tx',
                borderless: true,
                tooltip: true,
                columns: [
                  { id: 'ts', header: 'Time', width: 112, template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
                  { id: 'station', header: 'Station', width: 110 },
                  { id: 'movement', header: 'Move', width: 66, template: (o) => (o.direction ? `${moveBadge(o.movement)}<span class="muted" style="font-size:11px">${o.direction === 'LEFT' ? ' ←' : ' →'}</span>` : moveBadge(o.movement)) },
                  { id: 'method', header: 'ID', width: 88, template: (o) => `${methodBadge(o.method)}${o.updates ? ` <span class="tag tag-updated" title="Existing transaction updated ${o.updates}×">×${o.updates}</span>` : ''}`, tooltip: (o) => (o.reason ? `Manual because: ${o.reason}` : '') },
                  { id: 'path', header: 'Path', width: 88, template: (o) => (o.path ? pathBadge(o.path) : '<span class="muted">–</span>') },
                  { id: 'operator', header: 'By', fillspace: 1, minWidth: 90 },
                  { id: 'result', header: 'Result', width: 112, template: (o) => (o.result ? `<span title="${esc(o.defect ? 'Defect ' + o.defect : '')}">${pill(o.result)}</span>${o.corrected ? ' <i class="mdi mdi-history muted" title="Corrected before"></i>' : ''}${canFix && o.correctable ? ' <span class="act act-correct" title="Correct this result (FR-015)"><i class="mdi mdi-pencil-outline"></i></span>' : ''}` : '<span class="muted">–</span>') },
                  { id: 'ctms', header: 'CTMS', width: 104, template: (o) => `<span title="${esc(o.ctmsRef ? 'CTMS ref ' + o.ctmsRef : '')}">${ctmsBadge(getTx(o.id).ctms)}</span>` },
                ],
                onClick: {
                  'act-correct': (e, id) => {
                    openCorrection(id.row);
                    return false;
                  },
                },
              },
            }),
          ],
        }
      : card({ title: 'Recently moved pipes', sub: 'Pick one to see its trace', body: { view: 'template', id: 'trace-intro', borderless: true, template: introHtml, onClick: { 'trace-pick': (e, id, node) => ctx.go('trace', node.getAttribute('data-id')) } } });

    return {
      type: 'space',
      css: 'page',
      rows: [
        {
          view: 'toolbar',
          css: 'card',
          height: 60,
          paddingX: 14,
          elements: [
            { view: 'search', id: 'trace-q', placeholder: 'DMC code or “WHT26119 12”', width: 420, value: pipeId ? getPipe(pipeId).dmc : '', on: { onEnter: go, onSearchIconClick: go } },
            { view: 'button', value: 'Trace pipe', css: 'webix_primary', width: 120, click: go },
            {},
            pipeId ? { view: 'label', label: `<span class="muted">Record id <span class="mono">${esc(pipeId)}</span></span>`, autowidth: true } : { width: 1 },
          ],
        },
        body,
      ],
    };
  },

  init(ctx) {
    if (!pipeId) {
      ctx.live(() => webix.$$('trace-intro')?.refresh(), 2000);
      return;
    }
    const refresh = () => {
      const tl = webix.$$('trace-tl');
      if (tl) {
        tl.refresh();
        tl.resize();
      }
      syncTable('trace-tx', txRows());
    };
    refresh();
    ctx.live(refresh, 800);
  },
};

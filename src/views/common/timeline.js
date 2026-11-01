// Pipe genealogy rendering shared by the pipe detail window and the Pipe trace page.
import { getPipe, getWo, getTx } from '../../core/db.js';
import { pipeTimeline, movementLabel, cycleTimeMs } from '../../core/selectors.js';
import { esc, fmtTime, fmtDate, fmtDuration } from '../../core/format.js';
import { pill, stagePill, pipeChip, ctmsBadge } from '../../ui/components.js';
import { dmcSvg } from '../../ui/dmc.js';

const ICON = {
  dmc: 'mdi-printer-3d-nozzle-outline',
  in: 'mdi-arrow-collapse-right',
  out: 'mdi-arrow-expand-right',
  inspection: 'mdi-clipboard-check-outline',
  ctms: 'mdi-cloud-upload-outline',
  hold: 'mdi-hand-back-left-outline',
  release: 'mdi-check',
  finish: 'mdi-flag-checkered',
  reject: 'mdi-close',
  correction: 'mdi-pencil-outline',
};

export function pipeHeaderHtml(pipeId) {
  const p = getPipe(pipeId);
  if (!p) return '';
  const wo = getWo(p.wo);
  const ct = cycleTimeMs(p);
  const limab = p.history.map(getTx).find((t) => t?.stationId === 'LIMAB' && t.movement === 'OUT');
  const flag = limab?.inspection?.result || p.limabFlag;
  return `<div class="trace-head">
    ${dmcSvg(p.dmc, { size: 92 })}
    <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${pipeChip(p, { size: 'lg' })}${pill(p.status)}${stagePill(p.stage)}<span class="muted" style="font-size:12.5px">${esc(movementLabel(p))}</span></div>
      <div class="trace-facts">
        <div class="fact"><span>DMC</span><b class="mono">${esc(p.dmc)}</b></div>
        <div class="fact"><span>Work order</span><b class="mono">${esc(p.wo)}</b></div>
        <div class="fact"><span>Product</span><b>${esc(wo ? `${wo.product.od} ${wo.product.weight} ${wo.product.grade} ${wo.product.end}` : '–')}</b></div>
        <div class="fact"><span>Limab status flag</span><b>${flag ? `${pill(flag)}${limab?.direction ? ` <span class="muted" style="font-size:12px">${limab.direction === 'LEFT' ? '← left' : 'right →'}</span>` : ' <span class="muted" style="font-size:12px">prepared</span>'}` : '<span class="muted">not set</span>'}</b></div>
        <div class="fact"><span>${ct ? 'Cycle time' : 'Marked at Limab'}</span><b>${ct ? fmtDuration(ct) : `${fmtDate(p.markedAt)} ${fmtTime(p.markedAt, false)}`}</b></div>
      </div>
    </div>
  </div>`;
}

export function pipeTimelineHtml(pipeId) {
  const items = pipeTimeline(pipeId);
  if (!items.length) return '<div class="empty">No history</div>';
  let lastDay = '';
  return `<div class="tl">${items
    .map((it) => {
      const day = fmtDate(it.ts);
      const dayRow = day !== lastDay ? `<div class="tl-item"><div class="tl-time" style="font-weight:600;color:var(--text)">${day}</div><div></div><div></div></div>` : '';
      lastDay = day;
      const extra = it.kind === 'inspection' ? ` ${pill(it.result)}` : it.kind === 'ctms' ? ` ${ctmsBadge(it.tx.ctms)}` : '';
      return `${dayRow}<div class="tl-item"><div class="tl-time">${fmtTime(it.ts)}</div><div class="tl-dot k-${it.kind}"><i class="mdi ${ICON[it.kind] || 'mdi-circle-small'}"></i></div><div><div class="tl-title">${esc(it.title)}${extra}</div><div class="tl-detail">${esc(it.detail || '')}</div></div></div>`;
    })
    .join('')}</div>`;
}

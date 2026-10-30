// Dashboard · HT plant layout ("HT PIPE TRACKING" mockup).
// Schematic of the finishing line with live pipe positions, flow numbers, scanner zones
// (FR tag table W1 … E2), IN / OUT racks incl. the Limab out station (right position, FR-005)
// and a status card per station. Colours: Good blue, NC yellow, Reject red, Pending grey
// (dashboard legend from the client mockup; the physical marking on the pipe differs, see legend).
import webix from '../../lib/webix.js';
import { db, getStation, getPipe } from '../../core/db.js';
import { STAGE, queueForStation, atStation, heldPipes, pipeLabel } from '../../core/traceability.js';
import { STATUS_META, stationSnapshot, scannerStatus } from '../../core/selectors.js';
import { stationAlarms } from '../../core/alarms.js';
import { esc, fmtTime } from '../../core/format.js';
import { card, pill, pipeChip } from '../../ui/components.js';
import { openPipeDetail } from '../common/pipeDetail.js';

// Station boxes on the schematic (x, y = top-left; w, h)
// qx/qy/dir = where the queue for the station is drawn
const LAYOUT = {
  LIMAB: { x: 60, y: 92, w: 128, h: 60, label: 'Robotic · Limab', no: 1 },
  SEA_E: { x: 250, y: 46, w: 116, h: 56, label: 'SEA East', no: 2, qx: 196, qy: 52, dir: 'up' },
  SEA_W: { x: 250, y: 196, w: 116, h: 56, label: 'SEA West', no: 3, qx: 196, qy: 204, dir: 'down' },
  EMI: { x: 420, y: 252, w: 124, h: 56, label: 'EMI Prove-up', no: 4, qx: 424, qy: 314, dir: 'down', max: 1 },
  WMS: { x: 590, y: 92, w: 110, h: 60, label: 'WMS', no: 5, qx: 534, qy: 116, dir: 'up' },
  HYD_Y: { x: 760, y: 46, w: 140, h: 56, label: 'Hydrotest Yamasui', no: 6, qx: 706, qy: 52, dir: 'up' },
  HYD_B: { x: 760, y: 196, w: 140, h: 56, label: 'Hydrotest Brandt', no: 7, qx: 706, qy: 204, dir: 'down' },
  PAUT: { x: 958, y: 92, w: 104, h: 60, label: 'PAUT', no: 8, qx: 906, qy: 162, dir: 'down' },
};
const LINE_Y = 150;
const W = 1240;
const H = 380;

function chipSvg(p, x, y, { await: awaiting = false } = {}) {
  const tone = (STATUS_META[p.status] || STATUS_META.PENDING).tone;
  return `<g class="pchip tone-${tone}${awaiting ? ' await' : ''}" data-pipe="${esc(p.id)}" transform="translate(${x},${y})" style="cursor:pointer">
    <title>${esc(pipeLabel(p))} · ${esc(STATUS_META[p.status]?.label || p.status)}</title>
    <rect class="body" width="44" height="13" rx="2.5"/><ellipse cx="44" cy="6.5" rx="3.2" ry="6.5"/>
    <text x="20" y="10" text-anchor="middle">PN${p.pn}</text></g>`;
}

function stack(pipes, x, y, dir = 'down', max = 4, opts = {}) {
  let out = '';
  pipes.slice(0, max).forEach((p, i) => {
    const dy = dir === 'down' ? i * 16 : -i * 16;
    out += chipSvg(p, x, y + dy, opts);
  });
  if (opts.more !== false && pipes.length > max) out += `<text class="more" x="${x}" y="${y + (dir === 'down' ? max * 16 + 9 : -max * 16 + 10)}">+${pipes.length - max} more</text>`;
  return out;
}

function rack(x, y, label) {
  return `<g class="rack" transform="translate(${x},${y})">${[0, 6, 12, 18].map((d) => `<line x1="0" y1="${d}" x2="54" y2="${d}"/>`).join('')}<text x="27" y="32" text-anchor="middle">${label}</text></g>`;
}

function plantSvg() {
  const parts = [];
  parts.push(`<rect class="floor" x="10" y="12" width="${W - 20}" height="${H - 44}" rx="10"/>`);
  for (let i = 0; i <= 20; i++) {
    const x = 30 + i * ((W - 60) / 20);
    parts.push(`<line class="grid-line" x1="${x}" y1="18" x2="${x}" y2="${H - 38}"/>`);
    parts.push(`<circle cx="${x}" cy="${H - 20}" r="9" fill="none" stroke="var(--line-strong)"/><text class="grid-label" x="${x}" y="${H - 16.5}" text-anchor="middle">${i + 1}</text>`);
  }
  // roll table (main line) + parallel branches
  parts.push(`<line class="rolltable" x1="40" y1="${LINE_Y}" x2="${W - 60}" y2="${LINE_Y}"/>`);
  for (let x = 48; x < W - 60; x += 16) parts.push(`<line class="roller" x1="${x}" y1="${LINE_Y - 5}" x2="${x}" y2="${LINE_Y + 5}"/>`);
  parts.push(`<path class="rolltable" d="M220 ${LINE_Y} V74 H250 M220 ${LINE_Y} V224 H250 M366 74 H396 V${LINE_Y} M366 224 H396 V${LINE_Y}" fill="none" style="stroke-width:6"/>`);
  parts.push(`<path class="rolltable" d="M730 ${LINE_Y} V74 H760 M730 ${LINE_Y} V224 H760 M900 74 H930 V${LINE_Y} M900 224 H930 V${LINE_Y}" fill="none" style="stroke-width:6"/>`);
  parts.push(`<path class="rolltable" d="M396 ${LINE_Y} V280 H420 M544 280 H566 V${LINE_Y}" fill="none" style="stroke-width:4;stroke-dasharray:6 4"/>`);

  // flow path through station centres
  const order = Object.entries(LAYOUT).sort((a, b) => a[1].no - b[1].no);
  const pts = order.map(([, b]) => `${b.x + b.w / 2},${b.y + b.h / 2}`);
  parts.push(`<polyline class="flow-path" points="${pts.join(' ')} ${W - 120},${LINE_Y}"/>`);

  // racks
  parts.push(rack(78, 262, 'IN RACK'));
  parts.push(rack(150, 262, 'OUT · RIGHT'));
  parts.push(rack(600, 262, 'BUFFER'));
  parts.push(rack(1110, 44, 'OUT · FINISH'));
  parts.push(rack(1110, 226, 'NC / HOLD RACK'));

  for (const [id, b] of order) {
    const st = getStation(id);
    if (!st || st.active === false) continue;
    const snap = stationSnapshot(id);
    const attn = snap.pendingIds.length + snap.pendingInsp.length;
    const busy = snap.at.length > 0;
    parts.push(`<g class="station ${attn ? 'attn' : busy ? 'busy' : ''}" data-slug="${st.slug}">
      <title>${esc(st.name)}: ${snap.queue.length} in queue, ${snap.at.length} at station${attn ? `, ${attn} open task(s)` : ''}. Click to open the station display.</title>
      <rect class="box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/>
      <text class="st-name" x="${b.x + 8}" y="${b.y + 17}">${esc(b.label)}</text>
      <text class="st-meta" x="${b.x + 8}" y="${b.y + 31}">${esc(st.code)} · ${id === 'LIMAB' ? `Marked ${snap.at.filter((p) => p.stage === STAGE.IN).length}` : `Queue ${snap.queue.length}`}</text>
      <g class="flowno" transform="translate(${b.x + b.w - 2},${b.y - 2})"><circle r="10"/><text text-anchor="middle" y="4">${b.no}</text></g>
    </g>`);
    const scn = scannerStatus(id);
    if (scn && st.zone) {
      const tone = scn.status === 'OFFLINE' ? 'off' : scn.status === 'DEGRADED' || scn.path === 'OPT2' ? 'warn' : 'ok';
      parts.push(`<g class="scn scn-${tone}" transform="translate(${b.x + b.w - 44},${b.y + b.h + 5})"><title>${esc(scn.id)} · ${esc(scn.status.toLowerCase())}${scn.status !== 'OFFLINE' ? ` · ${scn.path === 'OPT2' ? 'option 2, direct read' : 'option 1, PLC → OPC'}` : ''}${scn.buffered ? ` · ${scn.buffered} stored` : ''}</title><rect width="42" height="14" rx="3"/><text x="21" y="10.5" text-anchor="middle">SCN ${esc(st.zone)}</text></g>`);
    }
    if (stationAlarms(id).length) parts.push(`<g class="alarm-dot" transform="translate(${b.x + 2},${b.y + 2})"><title>${stationAlarms(id).length} active alarm(s)</title><circle r="6"/></g>`);
    // pipes at station (inside the box)
    parts.push(stack(snap.at, b.x + 8, b.y + b.h - 19, 'up', 1, { await: snap.at[0]?.stage === STAGE.AWAIT, more: false }));
    if (snap.at.length > 1 && id !== 'LIMAB') parts.push(`<text class="more" x="${b.x + 60}" y="${b.y + b.h - 9}">+${snap.at.length - 1} at station</text>`);
    // queue just before the station
    if (b.qx != null) parts.push(stack(queueForStation(id), b.qx, b.qy, b.dir, b.max || 3));
  }

  // Limab: freshly marked pipes waiting in the IN rack; pipes sent right (out station) on the OUT rack
  const marked = atStation('LIMAB').filter((p) => p.stage === STAGE.IN);
  parts.push(stack(marked.slice(1), 82, 240, 'up', 3));
  const limabOut = heldPipes().filter((p) => p.stationId === 'LIMAB');
  parts.push(stack(limabOut, 154, 240, 'up', 3));
  // finished and NC rack
  const finished = db.pipes.filter((p) => p.stage === STAGE.FINISHED).sort((a, b) => b.finishedAt - a.finishedAt);
  parts.push(stack(finished, 1114, 78, 'down', 4, { more: false }));
  parts.push(`<text class="more" x="1112" y="${78 + 4 * 16 + 9}">${finished.length} finished</text>`);
  const ncRack = [...heldPipes().filter((p) => p.stationId !== 'LIMAB'), ...db.pipes.filter((p) => p.stage === STAGE.REJECTED).sort((a, b) => b.rejectedAt - a.rejectedAt)];
  parts.push(stack(ncRack, 1114, 266, 'down', 3));

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="HT finishing line with live pipe positions">${parts.join('')}</svg>`;
}

function stationCardsHtml() {
  const groups = [
    { title: 'Limab station pipe status · HT-LM', ids: ['LIMAB'] },
    { title: 'SEA East / West · HT-01 / 02', ids: ['SEA_E', 'SEA_W'] },
    { title: 'EMI prove-up · HT-03', ids: ['EMI'] },
    { title: 'WMS · HT-04', ids: ['WMS'] },
    { title: 'Hydrotest Yam / Brandt · HT-05 / 06', ids: ['HYD_Y', 'HYD_B'] },
    { title: 'PAUT · HT-07', ids: ['PAUT'] },
  ];
  return `<div class="station-cards">${groups
    .map((g) => {
      const rows = [];
      for (const id of g.ids) {
        for (const p of atStation(id)) rows.push({ p, label: p.stage === STAGE.AWAIT ? (id === 'LIMAB' ? 'Flag?' : 'Result?') : fmtTime(id === 'LIMAB' ? p.markedAt : p.inAt, false) });
        const recent = db.transactions.filter((t) => t.stationId === id && t.inspection?.result).slice(-3).reverse();
        for (const t of recent) rows.push({ p: getPipe(t.pipeId), result: t.inspection.result, ts: t.inspection.ts, dir: t.direction });
      }
      const body = rows.length
        ? rows
            .slice(0, 5)
            .map((r) => `<div class="st-card-row">${pipeChip(r.p, { size: 'sm', pulse: !r.result && r.p.stage === STAGE.AWAIT })}<span class="muted">${r.ts ? fmtTime(r.ts, false) : esc(r.label)}${r.dir ? (r.dir === 'LEFT' ? ' · ← left' : ' · right →') : ''}</span>${r.result ? pill(r.result) : r.p.stationId === 'LIMAB' && r.p.limabFlag ? `<span title="Status flag prepared">${pill(r.p.limabFlag)}</span>` : `<span class="chip chip-active" style="margin-left:auto">${r.p.stationId === 'LIMAB' ? 'Marked' : 'In process'}</span>`}</div>`)
            .join('')
        : '<div class="st-card-empty">No pipes at this station yet today.</div>';
      return `<div class="st-card"><div class="st-card-title">${esc(g.title)}</div>${body}</div>`;
    })
    .join('')}</div>`;
}

const legendHtml = () =>
  `<div class="legend" style="padding:10px 16px"><span title="Physical marking: no colour line"><i class="sw sw-good"></i>Good · blue</span><span title="Physical marking: yellow line"><i class="sw sw-nc"></i>NC · yellow</span><span title="Physical marking: red line"><i class="sw sw-reject"></i>Reject · red</span><span title="Physical marking: grey / blue line"><i class="sw sw-pending"></i>Pending · grey</span><span><svg width="14" height="14"><circle cx="7" cy="7" r="6" fill="var(--reject)"/></svg> Flow sequence</span><span><svg width="26" height="12"><rect width="26" height="12" rx="3" fill="none" stroke="var(--accent-strong)"/></svg> Scanner zone (W / M / E)</span><span style="margin-left:auto">Dashboard colours; the pipe itself carries the marking from the Limab status flag. Click a station or a pipe.</span></div>`;

export default {
  route: 'plant-layout',
  title: 'HT Pipe Tracking',
  subtitle: 'Plant layout · live pipe position and status on the HT finishing line',
  perm: 'dashboard',
  nav: { group: 'grp-dash', label: 'HT plant layout', icon: 'mdi-floor-plan', order: 3 },

  ui() {
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          card({
            title: 'HT pipe tracking',
            sub: 'Schematic of the line (not to scale). Positions update from movement events.',
            height: 470,
            body: {
              rows: [
                { view: 'template', id: 'plant-svg', css: 'plant-host', borderless: true, template: () => `<div class="plant">${plantSvg()}</div>` },
                { view: 'template', borderless: true, height: 44, template: legendHtml },
              ],
            },
          }),
          card({ title: 'Station pipe status', sub: 'Pipes at each station and the latest results', body: { view: 'template', id: 'plant-cards', borderless: true, autoheight: true, template: stationCardsHtml } }),
        ],
      },
    };
  },

  init(ctx, view) {
    const host = view.$view;
    const onClick = (e) => {
      const pipeEl = e.target.closest('[data-pipe]');
      if (pipeEl) {
        openPipeDetail(pipeEl.getAttribute('data-pipe'), ctx);
        return;
      }
      const stEl = e.target.closest('[data-slug]');
      if (stEl) ctx.go('station', stEl.getAttribute('data-slug'));
    };
    host.addEventListener('click', onClick);
    ctx.on('theme', () => {});
    const refresh = () => {
      webix.$$('plant-svg')?.refresh();
      const cards = webix.$$('plant-cards');
      if (cards) {
        cards.refresh();
        cards.resize();
      }
    };
    ctx.live(refresh, 800);
    this._off = () => host.removeEventListener('click', onClick);
  },

  destroy() {
    this._off?.();
  },
};

// Keyence autofocus DMC reader module (8th core module in 7061).
// FR-001: option 1 (main) = scanner → PLC → Kepware OPC → application; option 2 (redundancy) =
// the application reads the camera directly; automatic switch when the PLC path fails.
// FR-001.3: autofocus when the pipe size changes. Scanner names follow the FR tag table.
import webix from '../../lib/webix.js';
import { db, getCamera, getStation, stationName, runtimeOf } from '../../core/db.js';
import { cameraStats, recentEvents, currentPipeAt, CAMERA_SOURCES } from '../../core/selectors.js';
import { setCameraOffline, setReadMode, autofocus, odOf } from '../../core/simulator.js';
import { currentUser, can } from '../../core/session.js';
import { queueForStation } from '../../core/traceability.js';
import { esc, fmtAgo, fmtPct } from '../../core/format.js';
import { card, health, mono, timeCell, readBadge, moveBadge, methodBadge, pathBadge, infoNote, toast, attempt } from '../../ui/components.js';
import { dmcSvg } from '../../ui/dmc.js';
import { syncTable } from '../../ui/table.js';

let selected = 'HT-W1-SCN-01';

function camStatus(c) {
  if (db.settings.cameraOffline[c.id]) return 'OFFLINE';
  if (!c.stationId) return 'STANDBY';
  return runtimeOf(c.stationId).appLinkDown ? 'DEGRADED' : 'ONLINE';
}

function readerTemplate(o) {
  const c = getCamera(o.id);
  const s = cameraStats(c);
  const status = camStatus(c);
  const st = c.stationId ? getStation(c.stationId) : null;
  const rt = st ? runtimeOf(st.id) : null;
  return `<div class="reader">
    ${dmcSvg(c.lastCode || c.id, { size: 84, failed: c.lastStatus === 'NO_READ' || !c.lastCode })}
    <div class="reader-meta">
      <div class="reader-title">${esc(c.id)} ${health(status)}</div>
      <div>${esc(c.name)} · ${esc(c.camera)} · <b>${esc(c.model)}</b></div>
      <div>${st ? `<span class="mono">${esc(st.code)}</span> ${esc(st.name)} · ${status !== 'OFFLINE' ? pathBadge(rt.readPath) : ''}${rt.buffer.length ? ` <span class="chip chip-warn">${rt.buffer.length} stored</span>` : ''}` : esc(c.note || 'Spare')}</div>
      <div>Focus <b>${c.focusMm} mm</b> · aligned for <b>${esc(c.alignedOd || '–')}</b>${c.tuneMargin != null ? ` · margin ${c.tuneMargin} %` : ''}</div>
      <div>Reads <b>${s.reads}</b> · fails <b style="${s.fails ? 'color:var(--reject)' : ''}">${s.fails}</b> · rate <b>${s.rate != null ? fmtPct(s.rate) : '–'}</b></div>
      <div class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.lastCode ? esc(c.lastCode) : c.lastStatus === 'NO_READ' ? 'last: NO READ' : '–'} ${c.lastTs ? `<span class="muted">· ${fmtAgo(c.lastTs)}</span>` : ''}</div>
    </div>
  </div>`;
}

function historyRows() {
  const cam = getCamera(selected);
  if (!cam?.stationId) return [];
  return recentEvents({ stationId: cam.stationId, sources: CAMERA_SOURCES, limit: 120 }).map((e) => ({
    id: e.id,
    ts: e.ts,
    roll: e.rollStartAt,
    movement: e.movementType,
    code: e.barcode || e.rawRead || '',
    read: e.readStatus,
    path: e.readPath,
    buffered: e.source === 'BUFFER',
    ident: e.duplicateOf ? 'UPDATED' : e.identification?.status === 'REQUIRED' ? 'PENDING' : e.identification?.status === 'AUTO' ? 'AUTO' : e.identification?.status === 'RESOLVED' ? 'MANUAL' : '–',
    pipe: e.identification?.pipeId || '',
  }));
}

function historyTitle() {
  const cam = getCamera(selected);
  const st = cam?.stationId ? getStation(cam.stationId) : null;
  return `<div class="sec-title"><span class="sec-name">Read history · ${esc(selected)}</span><span class="sec-sub">${esc(st ? `${st.code} ${st.name}` : 'spare reader')}</span></div>`;
}

export default {
  route: 'readers',
  title: 'Keyence DMC Readers',
  subtitle: 'Autofocus Data Matrix scanners per process point: status, reading path, alignment, read rate and history',
  perm: 'readers',
  nav: { group: 'grp-int', label: 'Keyence DMC readers', icon: 'mdi-camera-iris', order: 32 },

  ui() {
    const canEdit = can('readers', 'edit');
    const selCam = () => getCamera(selected);
    return {
      type: 'space',
      css: 'page',
      rows: [
        {
          view: 'template',
          borderless: true,
          autoheight: true,
          css: 'page',
          template: () =>
            infoNote('<b>Option 1 (main):</b> the scanner result goes through the PLC to Kepware and the application reads the OPC tags. <b>Option 2 (redundancy):</b> when the PLC path fails, the application reads the camera directly and switches back automatically. While the network to the application is down, the camera stores reads and sends them later. Run <b>autofocus</b> when the pipe size changes. The Keyence SDK / driver is proprietary and supplied separately; the mock simulates the reads.'),
        },
        card({
          title: 'Scanners',
          sub: 'Names from the FR tag table · click a scanner to see its read history',
          height: 380,
          actions: canEdit
            ? [
                {
                  view: 'button',
                  type: 'icon',
                  icon: 'mdi mdi-barcode-scan',
                  label: 'Test read',
                  css: 'btn-ghost',
                  autowidth: true,
                  click: () => {
                    const cam = selCam();
                    if (!cam.stationId) return toast(`${cam.id} is a spare reader: connect it to a station first.`, 'warning');
                    if (db.settings.cameraOffline[cam.id]) return toast(`${cam.id} is offline: no response to the test trigger.`, 'error');
                    const next = currentPipeAt(cam.stationId) || queueForStation(cam.stationId)[0];
                    toast(`Test read on ${cam.id}: ${next ? next.dmc : 'no pipe in the field of view'} · not published as an event`, next ? 'success' : 'warning');
                  },
                },
                {
                  view: 'button',
                  type: 'icon',
                  icon: 'mdi mdi-crosshairs-gps',
                  label: 'Autofocus',
                  css: 'btn-ghost',
                  autowidth: true,
                  click: () => {
                    const cam = selCam();
                    if (!cam.stationId) return toast(`${cam.id} is a spare reader.`, 'warning');
                    const pipe = currentPipeAt(cam.stationId) || queueForStation(cam.stationId)[0];
                    const od = odOf(pipe) || cam.alignedOd;
                    attempt(() => autofocus(cam.id, { od, actor: currentUser() }), (r) => `${cam.id}: focus ${r.focusMm} mm for ${r.od || 'current pipe'} · read margin ${r.margin} %`);
                    webix.$$('rd-cards').refresh();
                  },
                },
                {
                  view: 'button',
                  type: 'icon',
                  icon: 'mdi mdi-swap-horizontal',
                  label: 'Reading path',
                  css: 'btn-ghost',
                  autowidth: true,
                  tooltip: 'Switch between option 1 with automatic fallback and forced option 2',
                  click: () => {
                    const cam = selCam();
                    if (!cam.stationId) return;
                    const rt = runtimeOf(cam.stationId);
                    const next = rt.mode === 'OPT2' ? 'AUTO' : 'OPT2';
                    setReadMode(cam.stationId, next, currentUser());
                    toast(`${stationName(cam.stationId)}: ${next === 'OPT2' ? 'forced to option 2 (direct camera)' : 'option 1 with automatic switch to option 2'}`, 'success');
                    webix.$$('rd-cards').refresh();
                  },
                },
                {
                  view: 'button',
                  type: 'icon',
                  icon: 'mdi mdi-power',
                  label: 'Toggle offline',
                  css: 'btn-ghost',
                  autowidth: true,
                  click: () => {
                    const cam = selCam();
                    if (!cam.stationId) return;
                    setCameraOffline(cam.id, !db.settings.cameraOffline[cam.id], currentUser());
                    webix.$$('rd-cards').refresh();
                  },
                },
              ]
            : [],
          body: {
            view: 'dataview',
            id: 'rd-cards',
            borderless: true,
            select: true,
            type: { width: 420, height: 150, template: readerTemplate },
            data: db.cameras.map((c) => ({ id: c.id })),
            on: {
              onAfterSelect(id) {
                selected = id;
                syncTable('rd-history', historyRows());
                webix.$$('rd-history-title')?.setValue(historyTitle());
              },
            },
          },
        }),
        {
          css: 'card',
          rows: [
            { view: 'toolbar', css: 'card-head', height: 54, paddingX: 14, elements: [{ view: 'label', id: 'rd-history-title', label: historyTitle() }] },
            {
              view: 'datatable',
              id: 'rd-history',
              borderless: true,
              scheme: { $change: (o) => (o.$css = o.read !== 'OK' ? 'row-attn' : '') },
              columns: [
                { id: 'ts', header: 'Read time', width: 90, template: (o) => timeCell(o.ts) },
                { id: 'roll', header: 'Rolling start', width: 100, template: (o) => timeCell(o.roll) },
                { id: 'movement', header: 'Point', width: 80, template: (o) => moveBadge(o.movement) },
                { id: 'code', header: 'Decoded content', fillspace: 1, minWidth: 220, template: (o) => mono(o.code || '–') },
                { id: 'read', header: 'Read', width: 120, template: (o) => readBadge(o.read) },
                { id: 'path', header: 'Path', width: 110, template: (o) => `${pathBadge(o.path)}${o.buffered ? ' <i class="mdi mdi-database-clock-outline muted" title="Stored in the camera, delivered later"></i>' : ''}` },
                { id: 'ident', header: 'Identification', width: 120, template: (o) => methodBadge(o.ident) },
                { id: 'pipe', header: 'Pipe', width: 150, template: (o) => mono(o.pipe || '–') },
              ],
            },
          ],
        },
      ],
    };
  },

  init(ctx) {
    const dv = webix.$$('rd-cards');
    if (dv.exists(selected)) dv.select(selected);
    const refresh = () => {
      dv.refresh();
      syncTable('rd-history', historyRows());
    };
    refresh();
    ctx.live(refresh, 1000);
  },
};

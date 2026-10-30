// OPC Kepware module: OPC UA session, channels/devices, live tags, PLC device chain.
// Reading option 1 (FR-001): scanner → PLC → Kepware → application. Tag names follow the FR tag table.
import webix from '../../lib/webix.js';
import { db, getStation, stationName, runtimeOf } from '../../core/db.js';
import { integrationHealth } from '../../core/integrations.js';
import { env } from '../../config/env.js';
import { esc, fmtTime } from '../../core/format.js';
import { card, health, mono, infoNote, iconButton, exportCsv } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';

let selected = 'all';

function sessionHtml() {
  const down = db.stations.filter((st) => st.cameraId && runtimeOf(st.id).plcDown);
  return `<div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
    <div class="trace-facts">
      <div class="fact"><span>Endpoint</span><b class="mono">${esc(env.opcEndpoint)}</b></div>
      <div class="fact"><span>Server</span><b>Kepware KEPServerEX (Windows Server VM)</b></div>
      <div class="fact"><span>Security</span><b>Basic256Sha256 · Sign &amp; Encrypt</b></div>
      <div class="fact"><span>Certificate</span><b class="mono">SHA1 7C:2E:91:…:4A · valid to 2028-03</b></div>
      <div class="fact"><span>User</span><b class="mono">${esc(env.ldapDomain)}\\svc-trc-opc (LDAP)</b></div>
      <div class="fact"><span>Session</span><b>${health(integrationHealth('OPC'))}</b></div>
      <div class="fact"><span>Subscription</span><b>Publishing 250 ms · sampling 100 ms</b></div>
      <div class="fact"><span>Licences · perpetual</span><b>OPC Connectivity Suite · Siemens Suite · Allen-Bradley Suite</b></div>
      <div class="fact"><span>Licence holder</span><b>Registered to PT Citra Tubindo Tbk</b></div>
    </div>
    ${down.length ? infoNote(`PLC / OPC path down at <b>${down.map((st) => esc(st.name)).join(', ')}</b>: those stations read their scanner directly (option 2) until the path is back.`, 'warn') : ''}
  </div>`;
}

function treeData() {
  const channels = {};
  for (const c of db.concentrators) {
    if (!channels[c.channel]) channels[c.channel] = { id: c.channel, value: c.channel === 'Siemens_TCPIP' ? 'Siemens TCP/IP Ethernet' : 'Allen-Bradley ControlLogix Ethernet', icon: 'mdi-lan', open: true, data: [] };
    const offline = c.stations.some((s) => db.settings.cameraOffline[getStation(s)?.cameraId] || runtimeOf(s).plcDown);
    channels[c.channel].data.push({ id: c.device, value: `${c.device} · ${c.model.replace(/^Siemens |^Allen-Bradley /, '')}`, sub: c.stations.map(stationName).join(', '), status: offline ? 'DEGRADED' : 'ONLINE', icon: 'mdi-chip' });
  }
  channels.Siemens_TCPIP?.data.push({ id: 'LIMAB_PLC', value: 'LIMAB_PLC · Limab sensors', sub: 'Limab left / right (out station) sensors · device assumed', status: 'ONLINE', icon: 'mdi-chip' });
  return [{ id: 'all', value: 'All devices', icon: 'mdi-server', open: true, data: Object.values(channels) }];
}

function tagRows() {
  let stationIds = null;
  if (selected !== 'all') {
    const concs = db.concentrators.filter((c) => c.device === selected || c.channel === selected);
    stationIds = new Set(concs.flatMap((c) => c.stations));
    if (selected === 'LIMAB_PLC' || selected === 'Siemens_TCPIP') stationIds.add('LIMAB');
  }
  return db.tags
    .filter((t) => !stationIds || stationIds.has(t.stationId))
    .map((t) => ({ id: t.id, name: t.name, official: t.official ? 1 : 0, path: t.path, address: t.address, type: t.dataType, value: t.value, quality: t.quality, ts: t.ts, station: stationName(t.stationId), kind: t.type }));
}

function chainRows() {
  return db.plcs.map((p) => {
    const conc = db.concentrators.find((c) => c.id === p.concentratorId);
    const st = db.stations.find((s) => s.plcId === p.id);
    const cam = st?.cameraId ? db.cameras.find((c) => c.id === st.cameraId) : null;
    return { id: p.id, area: p.area, brand: p.brand, model: p.model, conc: conc ? conc.model : '–', device: conc ? `${conc.channel}.${conc.device}` : '–', camera: cam ? `${cam.id} · ${cam.model}` : '–', station: st ? `${st.code} ${st.name}` : '–', remark: p.remark };
  }).concat([{ id: 'LIMAB', area: 'Limab', brand: '–', model: 'Not in the device list', conc: '–', device: 'Siemens_TCPIP.LIMAB_PLC (assumed)', camera: '– (DMC from the robot)', station: 'HT-LM Limab', remark: 'Out-station sensor HT-LM-OUT-01 is in the FR tag table' }]);
}

const valueCell = (o) => {
  if (o.type === 'Boolean') return `<span class="chip ${o.value ? 'chip-active' : 'chip-muted'}">${o.value ? 'TRUE' : 'false'}</span>`;
  return mono(o.value === '' ? '""' : o.value);
};

export default {
  route: 'opc',
  title: 'OPC Kepware',
  subtitle: 'OPC UA session, PLC channels and devices, live tag values published to the traceability application',
  perm: 'opc',
  nav: { group: 'grp-int', label: 'OPC Kepware', icon: 'mdi-chip', order: 31 },

  ui() {
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          card({ title: 'OPC UA session', sub: 'Traceability application → Kepware (OT network)', body: { view: 'template', id: 'opc-session', borderless: true, autoheight: true, template: sessionHtml } }),
          {
            height: 470,
            type: 'clean',
            css: 'page',
            margin: 12,
            cols: [
              card({
                title: 'Channels & devices',
                sub: 'Concentrator PLCs',
                width: 380,
                body: {
                  view: 'tree',
                  id: 'opc-tree',
                  borderless: true,
                  select: true,
                  type: { height: 38 },
                  template: (o, common) =>
                    `<span title="${esc(o.sub || '')}">${common.icon(o, common)}<i class="mdi ${o.icon}" style="margin:0 6px;color:var(--accent-strong)"></i>${esc(o.value)}${o.status ? ` ${health(o.status)}` : ''}</span>`,
                  data: treeData(),
                  on: {
                    onAfterSelect(id) {
                      selected = id;
                      syncTable('opc-tags', tagRows());
                    },
                  },
                },
              }),
              card({
                title: 'Tags',
                sub: 'Live values (1 s refresh). PLC, sensor and camera tags mapped to process points.',
                gravity: 1,
                actions: [iconButton('mdi-export', 'Export', () => exportCsv('opc-tags', 'opc-tags'))],
                body: {
                  view: 'datatable',
                  id: 'opc-tags',
                  borderless: true,
                  scheme: { $change: (o) => (o.$css = o.quality !== 'Good' ? 'row-bad' : '') },
                  columns: [
                    { id: 'name', header: ['Tag', { content: 'textFilter' }], fillspace: 1, minWidth: 250, template: (o) => `<span class="mono" title="${esc(o.path)}">${esc(o.name)}</span>${o.official ? ' <i class="mdi mdi-check-decagram" style="color:var(--ok)" title="Name from the FR tag table"></i>' : ''}` },
                    { id: 'station', header: ['Station', { content: 'selectFilter' }], width: 140 },
                    { id: 'kind', header: ['Kind', { content: 'selectFilter' }], width: 92 },
                    { id: 'address', header: 'Address', width: 200, template: (o) => mono(o.address) },
                    { id: 'type', header: 'Type', width: 80 },
                    { id: 'value', header: 'Value', width: 200, template: valueCell },
                    { id: 'quality', header: 'Quality', width: 140, template: (o) => `<span style="color:${o.quality === 'Good' ? 'var(--ok)' : 'var(--reject)'}">${esc(o.quality)}</span>` },
                    { id: 'ts', header: 'Timestamp', width: 90, template: (o) => `<span class="mono">${o.ts ? fmtTime(o.ts) : '–'}</span>` },
                  ],
                },
              }),
            ],
          },
          card({
            title: 'PLC device chain',
            sub: 'From the “PLC Device and DMC Reader” slide: line PLC → concentrator → Kepware → camera',
            height: 330,
            body: {
              rows: [
                { view: 'template', borderless: true, autoheight: true, template: () => `<div style="padding:10px 14px 4px">${infoNote('Each area’s existing PLC talks to a Siemens S7-1200 concentrator (programmed in TIA Portal V19), except WMS whose CompactLogix publishes directly. SEA COIL3 shares the SEA COIL1 concentrator. EMI prove-up has no PLC or scanner. Limab is not in the device list, but its out-station sensor is in the FR tag table.')}</div>` },
                {
                  view: 'datatable',
                  id: 'opc-chain',
                  borderless: true,
                  columns: [
                    { id: 'area', header: 'Area', width: 150 },
                    { id: 'brand', header: 'Brand', width: 120 },
                    { id: 'model', header: 'Existing PLC', width: 230 },
                    { id: 'conc', header: 'Concentrator', width: 250 },
                    { id: 'device', header: 'Kepware device', width: 230, template: (o) => mono(o.device) },
                    { id: 'camera', header: 'Scanner', width: 190 },
                    { id: 'remark', header: 'Remark', fillspace: 1, minWidth: 160 },
                  ],
                  data: chainRows(),
                },
              ],
            },
          }),
        ],
      },
    };
  },

  init(ctx) {
    ctx.on('sim', () => {
      const tree = webix.$$('opc-tree');
      if (!tree) return;
      const sel = tree.getSelectedId();
      tree.clearAll();
      tree.parse(treeData());
      if (sel && tree.exists(sel)) tree.select(sel);
    });
    const tree = webix.$$('opc-tree');
    tree.select(selected === 'all' ? 'all' : selected);
    syncTable('opc-tags', tagRows());
    ctx.on('opc:tags', () => syncTable('opc-tags', tagRows()));
    ctx.on('sim', () => webix.$$('opc-session')?.refresh());
  },
};

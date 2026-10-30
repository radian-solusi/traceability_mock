// Parameter module · stations & process points (Administrator: "configures production lines,
// process points, processes"). Codes HT-01 … HT-07 follow the FR station table; Limab is HT-LM (assumed).
import webix from '../../lib/webix.js';
import { db, reindex, getStation, stationName, runtimeOf } from '../../core/db.js';
import { changed } from '../../core/bus.js';
import { audit, diff } from '../../core/audit.js';
import { currentUser } from '../../core/session.js';
import { setReadMode, modeLabel } from '../../core/simulator.js';
import { buildTags } from '../../data/masterData.js';
import { esc } from '../../core/format.js';
import { card, mono, iconButton, exportCsv, toast, infoNote, pathBadge } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';

const PROCESS_TYPES = [
  { id: 'MARKING', value: 'Marking (DMC / stencil robot)' },
  { id: 'EMI', value: 'SEA / EMI inspection' },
  { id: 'PROVEUP', value: 'Prove-up (manual verification)' },
  { id: 'MEASURE', value: 'WMS / measurement' },
  { id: 'HYDRO', value: 'Hydrostatic test' },
  { id: 'UT', value: 'Ultrasonic test (PAUT)' },
];
const ID_MODES = [
  { id: 'CAMERA', value: 'Keyence scanner (auto)' },
  { id: 'OPERATOR', value: 'Operator selects / enters' },
  { id: 'DMC', value: 'DMC API (robot)' },
  { id: 'SEQUENCE', value: 'Out sensor + DMC sequence' },
];
const RESULT_SETS = [
  { id: 'GOOD,NC', value: 'Good / NC (production point)' },
  { id: 'GOOD,NC,REJECT,PENDING', value: 'Good / NC / Reject / Pending (status flag)' },
  { id: '', value: 'No result (movement only)' },
];
const idModeName = (m) => ID_MODES.find((x) => x.id === m)?.value || m;
const ID_SHORT = { CAMERA: 'Scanner', OPERATOR: 'Operator', DMC: 'DMC API', SEQUENCE: 'Sensor + sequence' };
const lineName = (id) => db.lines.find((l) => l.id === id)?.name || id;

function rows() {
  return [...db.stations]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      id: s.id,
      order: s.order,
      line: s.lineId || 'HT',
      code: s.code,
      name: s.name,
      area: s.area,
      process: s.process,
      results: s.inspection === 'OUT' ? (s.resultOptions || ['GOOD', 'NC']).join(' / ') : '',
      idIn: s.idMode.IN,
      idOut: s.idMode.OUT,
      camera: s.cameraId || '',
      readMode: s.cameraId ? runtimeOf(s.id).mode : '',
      readPath: s.cameraId ? runtimeOf(s.id).readPath : '',
      sensors: Object.values(s.sensors || {}).join(' · '),
      dashboard: s.dashboard ? 1 : 0,
      active: s.active !== false ? 1 : 0,
    }));
}

function routeStepOptions(lineId = 'HT') {
  const route = db.routes.find((r) => r.lineId === lineId) || db.routes[0];
  return [
    { id: 'none', value: 'Not in the route yet' },
    ...route.steps.map((st, i) => ({ id: `alt-${i}`, value: `Alternative to step ${i + 1} · ${st.label}` })),
    ...route.steps.map((st, i) => ({ id: `after-${i}`, value: `New step after ${i + 1} · ${st.label}` })),
  ];
}

function nextCode() {
  const nums = db.stations.map((s) => Number((s.code.match(/^HT-(\d+)$/) || [])[1] || 0));
  return `HT-${String(Math.max(...nums) + 1).padStart(2, '0')}`;
}

function openEditor(stationId) {
  const st = stationId ? getStation(stationId) : null;
  webix.$$('station-win')?.destructor();
  const cams = [{ id: '', value: 'No scanner' }, ...db.cameras.map((c) => ({ id: c.id, value: `${c.id} · ${c.model}${c.stationId && c.stationId !== stationId ? ` (used by ${stationName(c.stationId)})` : ''}` }))];
  const concs = [{ id: '', value: 'No PLC' }, ...db.concentrators.map((c) => ({ id: c.id, value: `${c.device} · ${c.model}` }))];
  const lines = db.lines.map((l) => ({ id: l.id, value: `${l.id} · ${l.name}${l.status !== 'ACTIVE' ? ' (planned)' : ''}` }));
  const win = webix.ui({
    view: 'window',
    id: 'station-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(660, window.innerWidth - 24),
    height: Math.min(760, window.innerHeight - 24),
    head: st ? esc(`Edit ${st.code} · ${st.name}`) : 'Add process point',
    body: {
      view: 'scrollview',
      scroll: 'y',
      body: {
        view: 'form',
        id: 'station-form',
        elementsConfig: { labelWidth: 180 },
        elements: [
          { view: 'richselect', name: 'lineId', label: 'Production line', options: lines, value: 'HT', disabled: !!st },
          { view: 'text', name: 'code', label: 'Process point code', placeholder: 'e.g. HT-08', disabled: !!st, required: true },
          { view: 'text', name: 'name', label: 'Station name', placeholder: 'e.g. Drift test', required: true },
          { view: 'text', name: 'area', label: 'Area', placeholder: 'e.g. Drift bench 2' },
          { view: 'text', name: 'process', label: 'Process description', placeholder: 'e.g. Full-length drift test' },
          { view: 'richselect', name: 'processType', label: 'Process type', options: PROCESS_TYPES, value: 'UT' },
          { view: 'richselect', name: 'results', label: 'Result at OUT', options: RESULT_SETS, value: 'GOOD,NC' },
          { view: 'richselect', name: 'idIn', label: 'Identification IN', options: ID_MODES, value: 'CAMERA' },
          { view: 'richselect', name: 'idOut', label: 'Identification OUT', options: ID_MODES, value: 'CAMERA' },
          { view: 'richselect', name: 'cameraId', label: 'Keyence scanner', options: cams, value: '' },
          {
            view: 'richselect',
            name: 'readMode',
            label: 'Reading path',
            options: [
              { id: 'AUTO', value: modeLabel('AUTO') },
              { id: 'OPT2', value: modeLabel('OPT2') },
            ],
            value: 'AUTO',
          },
          { view: 'richselect', name: 'concentratorId', label: 'PLC concentrator', options: concs, value: '' },
          { view: 'text', name: 'sensorIn', label: 'Entry sensor tag', placeholder: 'e.g. HT-08-IN-01' },
          { view: 'text', name: 'sensorOut', label: 'Exit sensor tag', placeholder: 'e.g. HT-08-OUT-01' },
          st ? { view: 'template', borderless: true, height: 1, template: '' } : { view: 'richselect', name: 'routeStep', label: 'Place in route', options: routeStepOptions(), value: 'none' },
          { view: 'counter', name: 'order', label: 'Display order', min: 1, max: 99, value: db.stations.length + 1 },
          { view: 'switch', name: 'dashboard', label: 'Show on dashboards', value: 1 },
          { view: 'switch', name: 'active', label: 'Active', value: 1 },
          { view: 'template', borderless: true, autoheight: true, template: () => infoNote('A scanner station with a PLC gets its sensor, scanner and PLC tags generated under the official names (Parameters → PLC / sensor / camera tags). Reading path “option 1, auto-switch” reads through the PLC and Kepware and falls back to the direct camera read when the PLC path fails (FR-001). The plant layout drawing is a fixed schematic.') },
          {
            cols: [
              {},
              { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
              { view: 'button', value: st ? 'Save changes' : 'Add process point', css: 'webix_primary', autowidth: true, click: () => save(st, win) },
            ],
          },
        ],
        rules: { code: webix.rules.isNotEmpty, name: webix.rules.isNotEmpty },
      },
    },
  });
  if (st) {
    webix.$$('station-form').setValues({
      lineId: st.lineId || 'HT',
      code: st.code,
      name: st.name,
      area: st.area,
      process: st.process,
      processType: st.processType,
      results: st.inspection === 'OUT' ? (st.resultOptions || ['GOOD', 'NC']).join(',') : '',
      idIn: st.idMode.IN,
      idOut: st.idMode.OUT,
      cameraId: st.cameraId || '',
      readMode: runtimeOf(st.id).mode,
      concentratorId: st.concentratorId || '',
      sensorIn: st.sensors?.entry || st.sensors?.left || '',
      sensorOut: st.sensors?.exit || st.sensors?.right || '',
      order: st.order,
      dashboard: st.dashboard ? 1 : 0,
      active: st.active !== false ? 1 : 0,
    });
  } else {
    const code = nextCode();
    webix.$$('station-form').setValues({ code, sensorIn: `${code}-IN-01`, sensorOut: `${code}-OUT-01` }, true);
  }
  win.show();
}

function save(st, win) {
  const form = webix.$$('station-form');
  if (!form.validate()) {
    toast('Code and station name are required.', 'error');
    return;
  }
  const v = form.getValues();
  const actor = currentUser();
  const resultOptions = v.results ? v.results.split(',') : [];
  if (!st) {
    const code = v.code.trim().toUpperCase();
    if (db.stations.some((s) => s.code === code)) {
      toast(`Code ${code} is already used by another process point.`, 'error');
      return;
    }
    const id = code.replace(/[^A-Z0-9]/g, '_');
    const slug = v.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (db.stations.some((s) => s.slug === slug)) {
      toast('Another station already has this name.', 'error');
      return;
    }
    const station = {
      id,
      slug,
      code,
      name: v.name.trim(),
      fullName: `${v.name.trim()}${v.area ? ' · ' + v.area : ''}`,
      area: v.area || v.name,
      lineId: v.lineId || 'HT',
      process: v.process || v.name,
      processType: v.processType,
      inspection: resultOptions.length ? 'OUT' : 'NONE',
      resultOptions: resultOptions.length ? resultOptions : ['GOOD', 'NC'],
      resultLabel: `${v.name.trim()} result`,
      idMode: { IN: v.idIn, OUT: v.idOut },
      cameraId: v.cameraId || null,
      plcId: null,
      concentratorId: v.concentratorId || null,
      sensors: v.sensorIn || v.sensorOut ? { entry: v.sensorIn || `${code}-IN-01`, exit: v.sensorOut || `${code}-OUT-01` } : {},
      zone: null,
      dashboard: !!v.dashboard,
      order: Number(v.order),
      active: !!v.active,
      cycleMin: [5, 8],
    };
    db.stations.push(station);
    runtimeOf(station.id).mode = v.readMode || 'AUTO';
    if (station.cameraId && station.concentratorId) db.tags.push(...buildTags([station], db.cameras));
    if (station.cameraId) {
      const cam = db.cameras.find((c) => c.id === station.cameraId);
      if (cam && !cam.stationId) {
        cam.stationId = station.id;
        cam.status = 'ONLINE';
      }
    }
    const route = db.routes.find((r) => r.lineId === station.lineId);
    if (route && v.routeStep?.startsWith('alt-')) route.steps[Number(v.routeStep.slice(4))].stations.push(station.id);
    if (route && v.routeStep?.startsWith('after-')) {
      const i = Number(v.routeStep.slice(6));
      route.steps.splice(i + 1, 0, { stations: [station.id], label: station.name, waitMin: [10, 30] });
      toast('Route step inserted. Pipes already in the line keep their route position; check Lines & routes.', 'warning');
    }
    audit(actor, 'Parameters', 'Process point added', `${station.code} · ${station.name} · line ${station.lineId}`, { before: 'not configured', after: { process: station.processType, results: resultOptions.join('/') || 'none', scanner: station.cameraId || 'none' }, category: 'Configuration change' });
  } else {
    const before = { name: st.name, area: st.area, process: st.process, processType: st.processType, results: st.inspection === 'OUT' ? (st.resultOptions || []).join('/') : 'none', idIn: st.idMode.IN, idOut: st.idMode.OUT, scanner: st.cameraId || 'none', plc: st.concentratorId || 'none', order: st.order, dashboard: st.dashboard, active: st.active !== false };
    const sensors = st.id === 'LIMAB' ? st.sensors : v.sensorIn || v.sensorOut ? { entry: v.sensorIn, exit: v.sensorOut } : st.sensors;
    Object.assign(st, {
      name: v.name.trim(),
      area: v.area,
      process: v.process,
      processType: v.processType,
      inspection: resultOptions.length ? 'OUT' : 'NONE',
      resultOptions: resultOptions.length ? resultOptions : st.resultOptions,
      idMode: { IN: v.idIn, OUT: v.idOut },
      cameraId: v.cameraId || null,
      concentratorId: v.concentratorId || null,
      sensors,
      order: Number(v.order),
      dashboard: !!v.dashboard,
      active: !!v.active,
    });
    const after = { name: st.name, area: st.area, process: st.process, processType: st.processType, results: st.inspection === 'OUT' ? st.resultOptions.join('/') : 'none', idIn: st.idMode.IN, idOut: st.idMode.OUT, scanner: st.cameraId || 'none', plc: st.concentratorId || 'none', order: st.order, dashboard: st.dashboard, active: st.active !== false };
    const d = diff(before, after);
    if (d.changed.length) audit(actor, 'Parameters', 'Process point changed', `${st.code} · ${st.name}`, { before: d.before, after: d.after, category: 'Configuration change' });
    if (st.cameraId && v.readMode && runtimeOf(st.id).mode !== v.readMode) setReadMode(st.id, v.readMode, actor);
  }
  reindex();
  changed('config', {});
  win.close();
  toast('Saved. Menus and dashboards are updated.', 'success');
  setTimeout(() => window.dispatchEvent(new CustomEvent('ptct:rerender')), 300);
}

export default {
  route: 'param-stations',
  title: 'Stations & Process Points',
  subtitle: 'Process points per production line: identification, result type, scanner and reading path, sensors, dashboard visibility',
  perm: 'parameters',
  nav: { group: 'grp-param', label: 'Stations & processes', icon: 'mdi-factory', order: 40 },

  ui() {
    return {
      type: 'space',
      css: 'page',
      rows: [
        card({
          title: 'Stations & process points',
          sub: 'Click a row to edit. Changes apply immediately in the mock and are written to the audit trail.',
          actions: [iconButton('mdi-plus', 'Add process point', () => openEditor(null), { css: 'btn-ghost' }), iconButton('mdi-export', 'Export', () => exportCsv('ps-table', 'stations'))],
          body: {
            view: 'datatable',
            id: 'ps-table',
            borderless: true,
            select: 'row',
            rowHeight: 40,
            columns: [
              { id: 'order', header: '#', width: 40, sort: 'int' },
              { id: 'line', header: 'Line', width: 52, template: (o) => `<span title="${esc(lineName(o.line))}">${mono(o.line)}</span>` },
              { id: 'code', header: 'Code', width: 70, template: (o) => mono(o.code) },
              { id: 'name', header: 'Station', width: 140, template: (o) => `<b>${esc(o.name)}</b>` },
              { id: 'process', header: 'Process', fillspace: 1, minWidth: 110, template: (o) => `<span title="${esc(o.area)}">${esc(o.process)}</span>` },
              { id: 'results', header: 'Result at OUT', width: 124, template: (o) => (!o.results ? '<span class="chip chip-muted">None</span>' : o.results.includes('REJECT') ? `<span class="chip chip-info" title="${esc(o.results.replace(/GOOD/g, 'Good').replace(/REJECT/g, 'Reject').replace(/PENDING/g, 'Pending'))}">Status flag · 4</span>` : '<span class="chip chip-info">Good / NC</span>') },
              { id: 'idIn', header: 'ID · IN', width: 104, template: (o) => `<span title="${esc(idModeName(o.idIn))}">${esc(ID_SHORT[o.idIn] || o.idIn)}</span>` },
              { id: 'idOut', header: 'ID · OUT', width: 104, template: (o) => `<span title="${esc(idModeName(o.idOut))}">${esc(ID_SHORT[o.idOut] || o.idOut)}</span>` },
              { id: 'camera', header: 'Scanner', width: 116, template: (o) => mono(o.camera || '–') },
              { id: 'readPath', header: 'Reading', width: 100, template: (o) => (o.camera ? `${pathBadge(o.readPath)}${o.readMode === 'OPT2' ? ' <i class="mdi mdi-lock-outline muted" title="Forced to option 2"></i>' : ''}` : '<span class="muted">–</span>') },
              { id: 'sensors', header: 'Sensors', width: 172, template: (o) => `<span class="mono" style="font-size:11.5px">${esc(o.sensors || '–')}</span>` },
              { id: 'active', header: 'Status', width: 70, template: (o) => `${o.active ? '<i class="mdi mdi-check-circle" style="color:var(--ok)" title="Active"></i>' : '<i class="mdi mdi-minus-circle-outline muted" title="Inactive"></i>'} ${o.dashboard ? '<i class="mdi mdi-eye-outline" style="color:var(--ok)" title="Shown on dashboards"></i>' : '<i class="mdi mdi-eye-off-outline muted" title="Hidden from dashboards"></i>'}` },
            ],
            on: { onItemClick: (id) => openEditor(id.row) },
          },
        }),
      ],
    };
  },

  init(ctx) {
    syncTable('ps-table', rows());
    ctx.on('config', () => syncTable('ps-table', rows()));
    ctx.on('sim', () => syncTable('ps-table', rows()));
  },
};

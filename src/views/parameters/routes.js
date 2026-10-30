// Parameter module · production lines and process routes.
// Rev 1 operational requirement 9: support multiple production lines through configuration.
// A route orders the process points of a line; stations in one step are alternatives; a step can be
// conditional ("only if the previous result is NC", like EMI prove-up after SEA).
import webix from '../../lib/webix.js';
import { db, stationName, reindex } from '../../core/db.js';
import { changed } from '../../core/bus.js';
import { audit } from '../../core/audit.js';
import { currentUser } from '../../core/session.js';
import { esc } from '../../core/format.js';
import { card, toast, infoNote, iconButton, mono } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';

let draft = null;

const activeRoute = () => db.routes.find((r) => r.lineId === 'HT') || db.routes[0];

function cloneRoute() {
  draft = JSON.parse(JSON.stringify(activeRoute()));
}

function chainHtml() {
  const steps = draft.steps
    .map((s, i) => `<div class="flow-step" style="flex:0 0 auto;min-width:128px"><div class="flow-step-label">Step ${i + 1}${s.when === 'PREV_NC' ? '<span class="opt">· only if NC</span>' : ''}</div><div class="flow-alt">${s.stations.map((id) => `<div class="flow-node" style="min-height:0;cursor:default"><div class="flow-node-name">${esc(stationName(id))}</div><div class="muted mono" style="font-size:11px">${esc(db.stations.find((x) => x.id === id)?.code || '')}</div></div>`).join('')}</div></div>`)
    .join('<div class="flow-arrow"><i class="mdi mdi-arrow-right"></i></div>');
  return `<div class="flow" style="padding:12px 14px">${steps}<div class="flow-arrow"><i class="mdi mdi-arrow-right"></i></div><div class="flow-step flow-finish" style="flex:0 0 auto;min-width:120px"><div class="flow-step-label">End</div><div class="flow-node" style="min-height:0"><div class="flow-node-name">${esc(draft.finishLabel)}</div></div></div></div>`;
}

function rows() {
  return draft.steps.map((s, i) => ({ id: String(i), no: i + 1, label: s.label, stations: s.stations.join(','), when: s.when || 'ALWAYS' }));
}

function lineRows() {
  return db.lines.map((l) => {
    const route = db.routes.find((r) => r.lineId === l.id);
    const points = db.stations.filter((s) => (s.lineId || 'HT') === l.id);
    return { id: l.id, name: l.name, description: l.description, status: l.status, route: route?.id || '', points: points.length, scanners: points.filter((s) => s.cameraId).length };
  });
}

function refresh() {
  webix.$$('rt-chain')?.refresh();
  const t = webix.$$('rt-table');
  if (t) {
    t.clearAll();
    t.parse(rows());
  }
  const head = webix.$$('rt-version');
  if (head) head.setValue(`<span class="muted">Editing <b class="mono">${esc(draft.id)}</b> · ${draft.steps.length} steps</span>`);
  syncTable('ln-table', lineRows());
}

function move(delta) {
  const t = webix.$$('rt-table');
  const id = t.getSelectedId(false, true);
  if (id == null) return toast('Select a step first.', 'warning');
  const i = Number(id);
  const j = i + delta;
  if (j < 0 || j >= draft.steps.length) return;
  const [s] = draft.steps.splice(i, 1);
  draft.steps.splice(j, 0, s);
  refresh();
  t.select(String(j));
}

function openLineEditor() {
  webix.$$('line-win')?.destructor();
  const win = webix.ui({
    view: 'window',
    id: 'line-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(560, window.innerWidth - 24),
    head: 'Add production line',
    body: {
      view: 'form',
      id: 'line-form',
      elementsConfig: { labelWidth: 130 },
      elements: [
        { view: 'text', name: 'id', label: 'Line code', placeholder: 'e.g. UPS', required: true },
        { view: 'text', name: 'name', label: 'Name', placeholder: 'e.g. Upsetting line', required: true },
        { view: 'textarea', name: 'description', label: 'Description', height: 70 },
        { view: 'template', borderless: true, autoheight: true, template: () => infoNote('A new line starts as <b>Planned</b>. Add its process points in Stations & processes, then build its route. Dashboards show a line once it is active.') },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Add line',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const form = webix.$$('line-form');
                if (!form.validate()) return toast('Line code and name are required.', 'error');
                const v = form.getValues();
                const id = v.id.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                if (db.lines.some((l) => l.id === id)) return toast(`Line ${id} already exists.`, 'error');
                db.lines.push({ id, name: v.name.trim(), description: v.description || '', status: 'PLANNED', routeId: null });
                audit(currentUser(), 'Parameters', 'Production line added', `${id} · ${v.name.trim()}`, { before: 'not configured', after: { status: 'PLANNED' }, category: 'Configuration change' });
                changed('config', {});
                win.close();
                refresh();
                toast(`Line ${id} added as planned.`, 'success');
              },
            },
          ],
        },
      ],
      rules: { id: webix.rules.isNotEmpty, name: webix.rules.isNotEmpty },
    },
  });
  win.show();
}

export default {
  route: 'param-routes',
  title: 'Production Lines & Routes',
  subtitle: 'Production lines, order of process points, parallel alternatives and conditional steps',
  perm: 'parameters',
  nav: { group: 'grp-param', label: 'Lines & routes', icon: 'mdi-transit-connection-variant', order: 41 },

  ui() {
    cloneRoute();
    const stationOptions = db.stations.filter((s) => s.active !== false && (s.lineId || 'HT') === 'HT').map((s) => ({ id: s.id, value: `${s.code} · ${s.name}` }));
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          card({
            title: 'Production lines',
            sub: 'Lines are configured, not coded (Rev 1 requirement 9)',
            height: 220,
            actions: [iconButton('mdi-plus', 'Add line', () => openLineEditor())],
            body: {
              view: 'datatable',
              id: 'ln-table',
              borderless: true,
              columns: [
                { id: 'id', header: 'Line', width: 70, template: (o) => mono(o.id) },
                { id: 'name', header: 'Name', width: 190, template: (o) => `<b>${esc(o.name)}</b>` },
                { id: 'description', header: 'Description', fillspace: 1, minWidth: 260 },
                { id: 'points', header: 'Process points', width: 120, css: 'num' },
                { id: 'scanners', header: 'Scanners', width: 90, css: 'num' },
                { id: 'route', header: 'Route', width: 110, template: (o) => (o.route ? mono(o.route) : '<span class="muted">none yet</span>') },
                { id: 'status', header: 'Status', width: 100, template: (o) => (o.status === 'ACTIVE' ? '<span class="chip chip-good">Active</span>' : '<span class="chip chip-muted">Planned</span>') },
              ],
            },
          }),
          card({ title: activeRoute().name, sub: activeRoute().description, height: 230, body: { view: 'template', id: 'rt-chain', borderless: true, template: chainHtml } }),
          card({
            title: 'Route steps · HT line',
            sub: 'Edit cells directly. Stations in one step are alternatives (a pipe visits one of them).',
            height: 460,
            actions: [
              { view: 'label', id: 'rt-version', label: '', width: 230, align: 'right' },
              iconButton('mdi-arrow-up', 'Up', () => move(-1)),
              iconButton('mdi-arrow-down', 'Down', () => move(1)),
              iconButton('mdi-plus', 'Add step', () => {
                draft.steps.push({ stations: [stationOptions[0].id], label: 'New step', waitMin: [10, 30] });
                refresh();
              }),
              iconButton('mdi-delete-outline', 'Remove', () => {
                const id = webix.$$('rt-table').getSelectedId(false, true);
                if (id == null) return toast('Select a step first.', 'warning');
                if (draft.steps.length <= 1) return toast('A route needs at least one step.', 'error');
                draft.steps.splice(Number(id), 1);
                refresh();
              }),
              {
                view: 'button',
                value: 'Save as new version',
                css: 'webix_primary',
                autowidth: true,
                click: () => {
                  const cur = activeRoute();
                  const base = cur.id.replace(/-v\d+$/, '');
                  const n = db.routes.filter((r) => r.id.startsWith(base)).length + 1;
                  const route = { ...draft, id: `${base}-v${n}`, description: draft.steps.map((s) => s.stations.map(stationName).join('/') + (s.when ? ' (if NC)' : '')).join(' → ') + ` → ${draft.finishLabel}` };
                  db.routes.unshift(route);
                  reindex();
                  audit(currentUser(), 'Parameters', 'Route version saved', `Line HT · ${route.id}`, { before: { route: cur.id, steps: cur.steps.length }, after: { route: route.id, steps: route.steps.length }, category: 'Configuration change' });
                  changed('config', {});
                  toast(`Route ${route.id} saved. New work orders use it; pipes already in the line keep their version.`, 'success');
                  cloneRoute();
                  refresh();
                },
              },
            ],
            body: {
              rows: [
                { view: 'template', borderless: true, autoheight: true, template: () => `<div style="padding:10px 14px 4px">${infoNote('Saving creates a new route version for work orders released afterwards. “Only if previous result is NC” makes a step conditional, like EMI prove-up after SEA.')}</div>` },
                {
                  view: 'datatable',
                  id: 'rt-table',
                  borderless: true,
                  editable: true,
                  editaction: 'click',
                  select: 'row',
                  rowHeight: 40,
                  columns: [
                    { id: 'no', header: 'Step', width: 70 },
                    { id: 'label', header: 'Label', width: 220, editor: 'text' },
                    { id: 'stations', header: 'Stations (alternatives)', fillspace: 1, minWidth: 260, editor: 'multiselect', optionslist: true, options: stationOptions, template: (o) => o.stations.split(',').filter(Boolean).map((id) => `<span class="chip chip-info" style="margin-right:4px">${esc(stationName(id))}</span>`).join('') },
                    { id: 'when', header: 'Condition', width: 260, editor: 'richselect', options: [{ id: 'ALWAYS', value: 'Always' }, { id: 'PREV_NC', value: 'Only if previous result is NC' }], template: (o) => (o.when === 'PREV_NC' ? 'Only if previous result is NC' : 'Always') },
                  ],
                  on: {
                    onAfterEditStop(state, editor) {
                      const i = Number(editor.row);
                      const step = draft.steps[i];
                      if (editor.column === 'label') step.label = state.value;
                      if (editor.column === 'stations') {
                        const ids = String(state.value || '').split(',').filter(Boolean);
                        if (!ids.length) {
                          toast('A step needs at least one station.', 'error');
                        } else step.stations = ids;
                      }
                      if (editor.column === 'when') {
                        if (state.value === 'PREV_NC') step.when = 'PREV_NC';
                        else delete step.when;
                      }
                      webix.$$('rt-chain').refresh();
                      const head = webix.$$('rt-version');
                      if (head) head.setValue('<span style="color:var(--warn)">Unsaved changes</span>');
                    },
                  },
                },
              ],
            },
          }),
        ],
      },
    };
  },

  init() {
    refresh();
  },
};

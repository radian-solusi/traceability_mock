// Parameter module · PLC, sensor and camera tags (Kepware tag mapping per process point) and the
// tagging master data (TRC-001 … TRC-007) from the FR document.
// Official tag names come from the FR tag table (HT-W1-SCN-01, HT-LM-OUT-01, …); Kepware item names
// cannot contain hyphens, so HT-W1-SCN-01 becomes the item HT_W1_SCN_01 in the OPC path.
import webix from '../../lib/webix.js';
import { db, stationName } from '../../core/db.js';
import { changed } from '../../core/bus.js';
import { audit } from '../../core/audit.js';
import { currentUser } from '../../core/session.js';
import { TAGGING_MASTER, opcItem } from '../../data/masterData.js';
import { esc } from '../../core/format.js';
import { mono, iconButton, exportCsv, toast, infoNote } from '../../ui/components.js';
import { syncTable } from '../../ui/table.js';

let kind = 'CAMERA';

const KIND_TEXT = {
  PLC: 'PLC tags: record messages (10 start / 20 stop), movement type, pipe rolling start time, counters and watchdog.',
  SENSOR: 'Sensor tags: photo-eyes at the entry and exit read points, and the Limab left / right (out station) sensors. HT-LM-OUT-01 is in the FR tag table; the other sensor names follow the same pattern (assumption).',
  CAMERA: 'Scanner tags under the official names of the FR tag table: read trigger (camera ON / OFF from the PLC), decoded Data Matrix and read status.',
  MASTER: 'Tagging master data from the FR document: each traceability requirement and where the mock shows it.',
};

function rows() {
  return db.tags
    .filter((t) => t.type === kind)
    .map((t) => ({ id: t.id, station: stationName(t.stationId), stationId: t.stationId, tagName: t.tagName, item: t.item, official: t.official ? 1 : 0, path: t.path, nodeId: t.nodeId, address: t.address, dataType: t.dataType, readPoint: t.readPoint || '–', scanMs: t.scanMs, description: t.description }));
}

function masterRows() {
  return TAGGING_MASTER.map((m) => ({ id: m.req, ...m }));
}

function openEditor(tagId) {
  const tag = tagId ? db.tags.find((t) => t.id === tagId) : null;
  webix.$$('tag-win')?.destructor();
  const stations = db.stations.filter((s) => s.concentratorId || s.id === 'LIMAB').map((s) => ({ id: s.id, value: `${s.code} · ${s.name}` }));
  const win = webix.ui({
    view: 'window',
    id: 'tag-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(620, window.innerWidth - 24),
    head: tag ? esc(`Edit tag ${tag.name}`) : `Add ${kind.toLowerCase()} tag`,
    body: {
      view: 'form',
      id: 'tag-form',
      elementsConfig: { labelWidth: 140 },
      elements: [
        { view: 'richselect', name: 'stationId', label: 'Process point', options: stations, value: tag?.stationId || stations[0]?.id },
        { view: 'richselect', name: 'type', label: 'Tag kind', value: tag?.type || kind, options: [{ id: 'PLC', value: 'PLC tag' }, { id: 'SENSOR', value: 'Sensor tag' }, { id: 'CAMERA', value: 'Scanner tag' }] },
        { view: 'text', name: 'tagName', label: 'Tag name', value: tag?.tagName || '', placeholder: 'e.g. HT-08-IN-01' },
        { view: 'text', name: 'item', label: 'Item', value: tag?.item || 'State', placeholder: 'e.g. State, ReadCode' },
        { view: 'text', name: 'address', label: 'PLC address', value: tag?.address || '', placeholder: 'e.g. DB10.DBX0.0' },
        { view: 'richselect', name: 'dataType', label: 'Data type', value: tag?.dataType || 'Boolean', options: ['Boolean', 'Word', 'DWord', 'String', 'DateTime', 'Float'] },
        { view: 'richselect', name: 'readPoint', label: 'Read point', value: tag?.readPoint || '', options: [{ id: '', value: '–' }, { id: 'ENTRY', value: 'Entry (IN)' }, { id: 'EXIT', value: 'Exit (OUT)' }, { id: 'LEFT', value: 'Limab left' }, { id: 'RIGHT', value: 'Limab right (out station)' }] },
        { view: 'counter', name: 'scanMs', label: 'Scan rate (ms)', value: tag?.scanMs || 250, step: 50, min: 50, max: 5000 },
        { view: 'textarea', name: 'description', label: 'Description', height: 60, value: tag?.description || '' },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Save tag',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const v = webix.$$('tag-form').getValues();
                if (!v.tagName || !v.item || !v.address) return toast('Tag name, item and PLC address are required.', 'error');
                const st = db.stations.find((s) => s.id === v.stationId);
                const conc = db.concentrators.find((c) => c.id === st.concentratorId);
                const base = st.id === 'LIMAB' ? 'Siemens_TCPIP.LIMAB_PLC' : `${conc?.channel || 'Channel'}.${conc?.device || 'Device'}`;
                const path = `${base}.${opcItem(v.tagName.trim())}.${v.item.trim()}`;
                const data = { stationId: v.stationId, type: v.type, tagName: v.tagName.trim(), item: v.item.trim(), name: `${v.tagName.trim()}.${v.item.trim()}`, address: v.address, dataType: v.dataType, readPoint: v.readPoint, scanMs: Number(v.scanMs), description: v.description, path, nodeId: `ns=2;s=${path}` };
                const before = tag ? { tag: tag.name, address: tag.address, scanMs: tag.scanMs } : 'new tag';
                if (tag) Object.assign(tag, data);
                else db.tags.push({ id: data.name, value: v.dataType === 'Boolean' ? false : 0, quality: 'Good', ts: null, official: false, ...data });
                audit(currentUser(), 'Parameters', tag ? 'Tag changed' : 'Tag added', path, { before, after: { tag: data.name, address: data.address, scanMs: data.scanMs }, category: 'Configuration change' });
                changed('config', {});
                win.close();
                toast('Tag saved', 'success');
              },
            },
          ],
        },
      ],
    },
  });
  win.show();
}

export default {
  route: 'param-tags',
  title: 'PLC, Sensor & Camera Tags',
  subtitle: 'Kepware tag mapping per process point (FR tag table names, OPC UA node ids, PLC addresses) and tagging master data',
  perm: 'parameters',
  nav: { group: 'grp-param', label: 'PLC / sensor / camera tags', icon: 'mdi-tag-multiple-outline', order: 42 },

  ui() {
    return {
      type: 'space',
      css: 'page',
      rows: [
        {
          css: 'card',
          rows: [
            {
              view: 'toolbar',
              css: 'card-head',
              height: 54,
              paddingX: 14,
              elements: [
                {
                  view: 'segmented',
                  id: 'tg-kind',
                  width: 560,
                  value: kind,
                  options: [
                    { id: 'PLC', value: 'PLC tags' },
                    { id: 'SENSOR', value: 'Sensor tags' },
                    { id: 'CAMERA', value: 'Scanner tags' },
                    { id: 'MASTER', value: 'Tagging master data' },
                  ],
                  on: {
                    onChange(v) {
                      kind = v;
                      if (v === 'MASTER') webix.$$('tg-master').show();
                      else {
                        webix.$$('tg-table').show();
                        syncTable('tg-table', rows());
                      }
                      webix.$$('tg-note').refresh();
                      webix.$$('tg-add')?.[v === 'MASTER' ? 'hide' : 'show']();
                    },
                  },
                },
                {},
                iconButton('mdi-plus', 'Add tag', () => openEditor(null), { id: 'tg-add', hidden: kind === 'MASTER' }),
                iconButton('mdi-export', 'Export', () => (kind === 'MASTER' ? exportCsv('tg-master', 'tagging-master-data') : exportCsv('tg-table', `tags-${kind.toLowerCase()}`))),
              ],
            },
            { view: 'template', id: 'tg-note', borderless: true, autoheight: true, template: () => `<div style="padding:10px 14px 4px">${infoNote(esc(KIND_TEXT[kind]) + (kind === 'MASTER' ? '' : ' Siemens addresses use TIA Portal data blocks on the S7-1200 concentrators; WMS uses CompactLogix program tags.'))}</div>` },
            {
              view: 'multiview',
              animate: false,
              keepViews: true,
              value: kind === 'MASTER' ? 'tg-master' : 'tg-table',
              cells: [
                {
                  view: 'datatable',
                  id: 'tg-table',
                  borderless: true,
                  select: 'row',
                  columns: [
                    { id: 'station', header: ['Process point', { content: 'selectFilter' }], width: 150, sort: 'string' },
                    { id: 'tagName', header: ['Tag name', { content: 'textFilter' }], width: 150, template: (o) => `${mono(o.tagName)}${o.official ? ' <i class="mdi mdi-check-decagram" style="color:var(--ok)" title="Name from the FR tag table"></i>' : ''}` },
                    { id: 'item', header: 'Item', width: 116, template: (o) => mono(o.item) },
                    { id: 'address', header: 'PLC address', width: 240, template: (o) => mono(o.address) },
                    { id: 'dataType', header: 'Type', width: 84 },
                    { id: 'readPoint', header: 'Read point', width: 90 },
                    { id: 'scanMs', header: 'Scan', width: 70, template: (o) => `${o.scanMs} ms` },
                    { id: 'nodeId', header: 'OPC UA node id', width: 380, template: (o) => mono(o.nodeId) },
                    { id: 'description', header: 'Description', fillspace: 1, minWidth: 240 },
                  ],
                  on: { onItemClick: (id) => openEditor(id.row) },
                },
                {
                  view: 'datatable',
                  id: 'tg-master',
                  borderless: true,
                  data: masterRows(),
                  rowHeight: 40,
                  columns: [
                    { id: 'req', header: 'Requirement', width: 120, template: (o) => mono(o.req) },
                    { id: 'tag', header: 'Tag', width: 130, template: (o) => mono(o.tag) },
                    { id: 'name', header: 'Name', width: 240, template: (o) => `<b>${esc(o.name)}</b>` },
                    { id: 'where', header: 'Where in the application', fillspace: 1, minWidth: 300 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  },

  init(ctx) {
    if (kind !== 'MASTER') syncTable('tg-table', rows());
    ctx.on('config', () => kind !== 'MASTER' && syncTable('tg-table', rows()));
  },
};

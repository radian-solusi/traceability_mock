// Audit trail ("logs" table, FR-015): user, timestamp, before value, after value.
// Categories: Login, Logout, Status change, Manual correction, Configuration change (+ Operation, Integration).
import webix from '../lib/webix.js';
import { db } from '../core/db.js';
import { CATEGORIES } from '../core/audit.js';
import { esc, fmtDateTime } from '../core/format.js';
import { card, iconButton, exportCsv } from '../ui/components.js';

let shown = -1;
let category = 'all';

const CAT_CHIP = { Login: 'chip-info', Logout: 'chip-muted', 'Status change': 'chip-nc', 'Manual correction': 'chip-reject', 'Configuration change': 'chip-active', Operation: 'chip-muted', Integration: 'chip-warn' };

function rows() {
  return db.audit
    .filter((a) => category === 'all' || a.category === category)
    .slice(0, 2500)
    .map((a) => ({ id: a.id, ts: a.ts, name: a.name, username: a.username, role: a.role, category: a.category, module: a.module, action: a.action, detail: a.detail, before: a.before || '', after: a.after || '' }));
}

const valueCell = (v, tone) => (v ? `<span class="audit-val ${tone}" title="${esc(v)}">${esc(v)}</span>` : '<span class="muted">–</span>');

export default {
  route: 'audit',
  title: 'Audit Trail',
  subtitle: 'Logins and logouts, status changes, manual corrections and configuration changes, with before and after values',
  perm: 'audit',
  nav: { label: 'Audit trail', icon: 'mdi-history', order: 61 },

  ui() {
    shown = -1;
    return {
      type: 'space',
      css: 'page',
      rows: [
        card({
          title: 'Audit trail',
          sub: 'Newest first · kept with the traceability history (5 years) · filter with the column headers',
          actions: [
            {
              view: 'richselect',
              id: 'au-cat',
              width: 230,
              value: category,
              options: [{ id: 'all', value: 'All categories' }, ...CATEGORIES.map((c) => ({ id: c, value: c }))],
              on: {
                onChange(v) {
                  category = v;
                  shown = -1;
                  webix.$$('au-table')?.callEvent('onRefreshAudit', []);
                },
              },
            },
            iconButton('mdi-export', 'Export', () => exportCsv('au-table', 'audit-trail')),
          ],
          body: {
            view: 'datatable',
            id: 'au-table',
            borderless: true,
            columns: [
              { id: 'ts', header: 'Time', width: 120, sort: 'int', template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
              { id: 'name', header: ['User', { content: 'selectFilter' }], width: 150, sort: 'string' },
              { id: 'category', header: 'Category', width: 160, template: (o) => `<span class="chip ${CAT_CHIP[o.category] || 'chip-muted'}">${esc(o.category)}</span>` },
              { id: 'action', header: ['Action', { content: 'selectFilter' }], width: 190 },
              { id: 'detail', header: ['Detail', { content: 'textFilter' }], fillspace: 1, minWidth: 260, template: (o) => `<span title="${esc(o.detail)}">${esc(o.detail)}</span>` },
              { id: 'before', header: 'Before', width: 200, template: (o) => valueCell(o.before, 'before') },
              { id: 'after', header: 'After', width: 200, template: (o) => valueCell(o.after, 'after') },
              { id: 'module', header: ['Module', { content: 'selectFilter' }], width: 110 },
            ],
          },
        }),
      ],
    };
  },

  init(ctx) {
    const refresh = () => {
      const key = `${category}:${db.audit.length}`;
      if (key === shown) return;
      shown = key;
      const t = webix.$$('au-table');
      if (!t) return;
      const state = t.getState ? t.getState() : null;
      t.clearAll();
      t.parse(rows());
      if (state?.filter) t.setState({ filter: state.filter });
      t.filterByAll();
    };
    webix.$$('au-table')?.attachEvent('onRefreshAudit', refresh);
    refresh();
    ctx.every(2500, refresh);
  },
};

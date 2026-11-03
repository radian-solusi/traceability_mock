// Alarms & exceptions (FR-014 alarm & monitoring, FR-006 exception handling).
// Alarms: scanner offline, reading switched to option 2, consecutive read failures, DMC not found,
// duplicate DMC, CTMS not responding, camera storing reads, dwell time exceeded, reconciliation differences.
// Exceptions: the FR-006 list (DMC unreadable, CTMS not responding, duplicate DMC, DMC not found) with resolution.
import webix from '../lib/webix.js';
import { db } from '../core/db.js';
import { ackAlarm, ackAll, activeAlarms } from '../core/alarms.js';
import { exceptionRows } from '../core/selectors.js';
import { currentUser, can } from '../core/session.js';
import { esc, fmtDateTime, fmtAgo, startOfDay } from '../core/format.js';
import { kpiTile, severityBadge, alarmState, iconButton, exportCsv, toast } from '../ui/components.js';
import { syncTable } from '../ui/table.js';

let scope = 'open';
let exScope = 'open';

const EX_STATE = { OPEN: 'chip-warn', RESOLVED: 'chip-good', DISMISSED: 'chip-muted' };

function kpiHtml() {
  const day = startOfDay();
  const open = activeAlarms();
  const unack = open.filter((a) => a.state === 'ACTIVE').length;
  const critical = open.filter((a) => a.severity === 'critical').length;
  const today = db.alarms.filter((a) => a.raisedAt >= day);
  const exOpen = exceptionRows().filter((r) => r.state === 'OPEN').length;
  return `<div class="kpi-row">
    ${kpiTile({ label: 'Unacknowledged', value: unack, sub: 'Waiting for a look', icon: 'mdi-alarm-light-outline', tone: unack ? 'bad' : '' })}
    ${kpiTile({ label: 'Acknowledged', value: open.length - unack, sub: 'Seen; condition still present', icon: 'mdi-alarm-check' })}
    ${kpiTile({ label: 'Critical open', value: critical, sub: 'Scanner offline, CTMS not responding', icon: 'mdi-alert-octagon-outline', tone: critical ? 'bad' : '' })}
    ${kpiTile({ label: 'Raised today', value: today.length, sub: `${today.filter((a) => a.state === 'CLEARED').length} already cleared`, icon: 'mdi-history' })}
    ${kpiTile({ label: 'Open exceptions', value: exOpen, sub: 'Waiting for an operator or a retry', icon: 'mdi-alert-circle-outline', tone: exOpen ? 'warn' : '' })}
  </div>`;
}

const SEV_RANK = { critical: 0, warning: 1, info: 2 };

function alarmRows() {
  const list = scope === 'open' ? [...activeAlarms()].sort((a, b) => (a.state === 'ACTIVE' ? 0 : 1) - (b.state === 'ACTIVE' ? 0 : 1) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.lastAt - a.lastAt) : [...db.alarms].sort((a, b) => b.raisedAt - a.raisedAt);
  return list.map((a) => ({
    id: a.id,
    severity: a.severity,
    name: a.name,
    message: a.message,
    source: a.source,
    raisedAt: a.raisedAt,
    lastAt: a.lastAt,
    count: a.count,
    state: a.state,
    ack: a.ackBy ? `${a.ackBy} · ${fmtDateTime(a.ackAt)}` : '',
    cleared: a.clearedAt,
    route: a.route || '',
  }));
}

function exRows() {
  return exceptionRows().filter((r) => (exScope === 'open' ? r.state === 'OPEN' : true));
}

function ruleRows() {
  return db.alarmRules.map((r) => ({ id: r.code, ...r, open: activeAlarms().filter((a) => a.code === r.code).length }));
}

function openRoute(ctx, route) {
  if (!route) return;
  const [name, ...rest] = route.split('-');
  if (name === 'station') {
    if (can('station')) ctx.go('station', rest.join('-'));
  } else ctx.go(route);
}

export default {
  route: 'alarms',
  title: 'Alarms & Exceptions',
  subtitle: 'FR-014 alarm monitoring and FR-006 exception handling across the line and the interfaces',
  perm: 'alarms',
  nav: { group: 'grp-dash', label: 'Alarms & exceptions', icon: 'mdi-alarm-light-outline', order: 4 },

  ui(ctx) {
    const canAck = can('alarms', 'edit');
    return {
      type: 'space',
      css: 'page',
      rows: [
        { view: 'template', id: 'al-kpis', css: 'page', borderless: true, autoheight: true, template: kpiHtml },
        {
          css: 'card',
          rows: [
            {
              view: 'tabbar',
              id: 'al-tabs',
              multiview: true,
              height: 46,
              value: 'al-alarms',
              options: [
                { id: 'al-alarms', value: 'Alarms' },
                { id: 'al-ex', value: 'Exceptions (FR-006)' },
                { id: 'al-rules', value: 'Alarm criteria' },
              ],
            },
            {
              cells: [
                {
                  id: 'al-alarms',
                  rows: [
                    {
                      view: 'toolbar',
                      paddingX: 12,
                      height: 52,
                      elements: [
                        {
                          view: 'segmented',
                          id: 'al-scope',
                          width: 360,
                          value: scope,
                          options: [
                            { id: 'open', value: 'Active & acknowledged' },
                            { id: 'all', value: 'History' },
                          ],
                          on: {
                            onChange(v) {
                              scope = v;
                              syncTable('al-table', alarmRows());
                            },
                          },
                        },
                        {},
                        canAck
                          ? iconButton('mdi-check-all', 'Acknowledge all', () => {
                              const n = ackAll(currentUser());
                              toast(n ? `${n} alarm(s) acknowledged` : 'No unacknowledged alarms', n ? 'success' : 'info');
                            })
                          : { width: 1 },
                        iconButton('mdi-export', 'Export', () => exportCsv('al-table', 'alarms')),
                      ],
                    },
                    {
                      view: 'datatable',
                      id: 'al-table',
                      borderless: true,
                      rowHeight: 40,
                      scheme: { $change: (o) => (o.$css = o.state === 'ACTIVE' && o.severity === 'critical' ? 'row-bad' : o.state === 'ACTIVE' ? 'row-attn' : '') },
                      columns: [
                        { id: 'severity', header: ['Severity', { content: 'selectFilter' }], width: 110, template: (o) => severityBadge(o.severity) },
                        { id: 'name', header: ['Alarm', { content: 'selectFilter' }], width: 230, template: (o) => `<b>${esc(o.name)}</b>${o.count > 1 ? ` <span class="muted">×${o.count}</span>` : ''}` },
                        { id: 'message', header: ['Detail', { content: 'textFilter' }], fillspace: 1, minWidth: 260, template: (o) => `<span title="${esc(o.message)}">${esc(o.message)}</span>` },
                        { id: 'source', header: ['Source', { content: 'selectFilter' }], width: 150 },
                        { id: 'raisedAt', header: 'Raised', width: 110, sort: 'int', template: (o) => `<span class="mono" title="${esc(fmtAgo(o.raisedAt))}">${fmtDateTime(o.raisedAt)}</span>` },
                        { id: 'state', header: 'State', width: 130, exportAs: (o) => alarmState(o.state), template: (o) => (o.state === 'ACTIVE' && canAck ? '<span class="act act-ack"><i class="mdi mdi-check"></i>Acknowledge</span>' : alarmState(o.state)) },
                        { id: 'ack', header: 'Acknowledged by', width: 190, template: (o) => (o.ack ? esc(o.ack) : '<span class="muted">–</span>') },
                        { id: 'route', header: '', width: 70, template: (o) => (o.route ? '<span class="act act-open"><i class="mdi mdi-open-in-app"></i>Open</span>' : '') },
                      ],
                      onClick: {
                        'act-ack': (e, id) => {
                          ackAlarm(id.row, currentUser());
                          return false;
                        },
                        'act-open': (e, id) => {
                          openRoute(ctx, webix.$$('al-table').getItem(id.row).route);
                          return false;
                        },
                      },
                      on: {
                        onAfterRender() {
                          if (!this.count()) this.showOverlay?.('<div class="empty" style="min-height:0"><i class="mdi mdi-bell-check-outline"></i><div class="empty-title">No alarms</div></div>');
                          else this.hideOverlay?.();
                        },
                      },
                    },
                  ],
                },
                {
                  id: 'al-ex',
                  rows: [
                    {
                      view: 'toolbar',
                      paddingX: 12,
                      height: 52,
                      elements: [
                        {
                          view: 'segmented',
                          id: 'al-ex-scope',
                          width: 240,
                          value: exScope,
                          options: [
                            { id: 'open', value: 'Open' },
                            { id: 'all', value: 'All' },
                          ],
                          on: {
                            onChange(v) {
                              exScope = v;
                              syncTable('al-ex-table', exRows());
                            },
                          },
                        },
                        { view: 'label', label: '<span class="muted" style="font-size:12.5px">DMC unreadable and DMC not found go to the operator (UC-003); CTMS failures are retried; duplicate DMC from the robot is rejected from the batch.</span>' },
                        iconButton('mdi-export', 'Export', () => exportCsv('al-ex-table', 'exceptions')),
                      ],
                    },
                    {
                      view: 'datatable',
                      id: 'al-ex-table',
                      borderless: true,
                      columns: [
                        { id: 'ts', header: 'Time', width: 110, sort: 'int', template: (o) => `<span class="mono">${fmtDateTime(o.ts)}</span>` },
                        { id: 'label', header: ['Exception', { content: 'selectFilter' }], width: 220 },
                        { id: 'station', header: ['Where', { content: 'selectFilter' }], width: 150 },
                        { id: 'detail', header: ['Detail', { content: 'textFilter' }], fillspace: 1, minWidth: 240, template: (o) => `<span title="${esc(o.detail)}">${esc(o.detail)}</span>` },
                        { id: 'state', header: 'State', width: 100, template: (o) => `<span class="chip ${EX_STATE[o.state]}">${o.state === 'OPEN' ? 'Open' : o.state === 'DISMISSED' ? 'Dismissed' : 'Resolved'}</span>` },
                        { id: 'resolution', header: 'Resolution', width: 300, template: (o) => `<span title="${esc(o.resolution)}">${esc(o.resolution)}</span>` },
                      ],
                      on: {
                        onItemDblClick(id) {
                          const row = this.getItem(id.row);
                          if (row.type === 'CTMS_NO_RESPONSE') {
                            if (can('apisync')) ctx.go('api-sync');
                          } else if (row.stationId && can('station')) ctx.go('station', db.stations.find((s) => s.id === row.stationId).slug);
                        },
                      },
                    },
                  ],
                },
                {
                  id: 'al-rules',
                  rows: [
                    { view: 'template', borderless: true, autoheight: true, template: '<div style="padding:12px 14px 6px" class="muted">FR-014 says the alert criteria will be defined with the process owner. These rules and thresholds are placeholders; administrators change them in <b>Parameters → System parameters</b>.</div>' },
                    {
                      view: 'datatable',
                      id: 'al-rules-table',
                      borderless: true,
                      columns: [
                        { id: 'name', header: 'Alarm', width: 260, template: (o) => `<b>${esc(o.name)}</b><div class="muted mono" style="font-size:11px">${esc(o.code)}</div>` },
                        { id: 'severity', header: 'Severity', width: 110, template: (o) => severityBadge(o.severity) },
                        { id: 'threshold', header: 'Threshold', width: 150, template: (o) => (o.threshold != null ? `${o.threshold} ${esc(o.unit)}` : '<span class="muted">on occurrence</span>') },
                        { id: 'description', header: 'Raised when', fillspace: 1, minWidth: 260 },
                        { id: 'enabled', header: 'Enabled', width: 90, template: (o) => (o.enabled ? '<span class="chip chip-good">On</span>' : '<span class="chip chip-muted">Off</span>') },
                        { id: 'open', header: 'Open now', width: 90, css: 'num' },
                      ],
                      rowHeight: 48,
                    },
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
    const refresh = () => {
      webix.$$('al-kpis')?.refresh();
      syncTable('al-table', alarmRows());
      syncTable('al-ex-table', exRows());
      syncTable('al-rules-table', ruleRows());
    };
    refresh();
    ctx.live(refresh, 800);
  },
};

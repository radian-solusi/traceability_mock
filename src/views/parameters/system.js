// Parameter module · system parameters (Administrator, Rev 1) and alarm criteria (FR-014).
// Values are the NFR targets where the documents give one; the rest are placeholders (docs/ASSUMPTIONS.md).
import webix from '../../lib/webix.js';
import { db } from '../../core/db.js';
import { changed } from '../../core/bus.js';
import { audit, diff } from '../../core/audit.js';
import { currentUser, can } from '../../core/session.js';
import { modeLabel } from '../../core/simulator.js';
import { esc } from '../../core/format.js';
import { card, infoNote, severityBadge, toast } from '../../ui/components.js';

const FIELDS = ['apiTimeoutS', 'retryBackoffS', 'maxAutoRetries', 'dashboardTargetS', 'uptimeTarget', 'retentionYears', 'backupTime', 'backupEnabled', 'cameraStoreForward', 'fullSyncEveryMin', 'readMode'];

function formValues() {
  const p = db.systemParams;
  return { ...p, retryBackoffS: (p.retryBackoffS || []).join(', '), backupEnabled: p.backupEnabled ? 1 : 0, cameraStoreForward: p.cameraStoreForward ? 1 : 0 };
}

function save() {
  const v = { ...webix.$$('sys-form').getValues(), ...webix.$$('sys-form-2').getValues() };
  const backoff = String(v.retryBackoffS || '')
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => n > 0);
  if (!backoff.length) return toast('Enter at least one retry interval in seconds, e.g. 10, 30, 60.', 'error');
  const next = {
    apiTimeoutS: Number(v.apiTimeoutS),
    retryBackoffS: backoff,
    maxAutoRetries: Number(v.maxAutoRetries),
    dashboardTargetS: Number(v.dashboardTargetS),
    uptimeTarget: db.systemParams.uptimeTarget,
    retentionYears: Number(v.retentionYears),
    backupTime: v.backupTime,
    backupEnabled: !!v.backupEnabled,
    cameraStoreForward: !!v.cameraStoreForward,
    fullSyncEveryMin: Number(v.fullSyncEveryMin),
    readMode: v.readMode,
  };
  const d = diff(db.systemParams, next, FIELDS);
  if (!d.changed.length) return toast('No changes to save.', 'info');
  Object.assign(db.systemParams, next);
  audit(currentUser(), 'Parameters', 'System parameters changed', d.changed.join(', '), { before: d.before, after: d.after, category: 'Configuration change' });
  changed('config', {});
  toast(`Saved: ${d.changed.join(', ')}`, 'success');
}

function ruleRows() {
  return db.alarmRules.map((r) => ({ id: r.code, ...r, enabled: r.enabled ? 1 : 0 }));
}

export default {
  route: 'param-system',
  title: 'System Parameters',
  subtitle: 'Interface timeouts and retries, data retention and backup, store-and-forward, reading path default, alarm criteria',
  perm: 'parameters',
  nav: { group: 'grp-param', label: 'System parameters', icon: 'mdi-cog-outline', order: 44 },

  ui() {
    const canEdit = can('parameters', 'edit');
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          {
            view: 'flexlayout',
            css: 'page',
            cols: [
              card({
                title: 'Interfaces & retries',
                sub: 'CT-Track / CTMS submissions (UC-005), full synchronization (FR-010)',
                minWidth: 420,
                height: 470,
                body: {
                  view: 'form',
                  id: 'sys-form',
                  borderless: true,
                  elementsConfig: { labelWidth: 210 },
                  elements: [
                    { view: 'counter', name: 'apiTimeoutS', label: 'API timeout (s)', min: 1, max: 120 },
                    { view: 'text', name: 'retryBackoffS', label: 'Retry intervals (s)', placeholder: '10, 30, 60' },
                    { view: 'counter', name: 'maxAutoRetries', label: 'Automatic retries', min: 0, max: 10 },
                    { view: 'counter', name: 'fullSyncEveryMin', label: 'Full sync every (min)', min: 5, max: 1440, step: 5 },
                    {
                      view: 'richselect',
                      name: 'readMode',
                      label: 'Default reading path',
                      options: [
                        { id: 'AUTO', value: modeLabel('AUTO') },
                        { id: 'OPT2', value: modeLabel('OPT2') },
                      ],
                    },
                    { view: 'switch', name: 'cameraStoreForward', label: 'Camera store-and-forward' },
                    { view: 'template', borderless: true, autoheight: true, template: () => infoNote('Failed submissions stay saved and are retried at these intervals; after the last automatic retry they wait for a manual retry in API synchronization. Store-and-forward keeps scanner reads in the camera while the network to the application is down.') },
                  ],
                },
              }),
              card({
                title: 'Data & availability',
                sub: 'Non-functional requirements',
                minWidth: 420,
                height: 470,
                body: {
                  view: 'form',
                  id: 'sys-form-2',
                  borderless: true,
                  elementsConfig: { labelWidth: 210 },
                  elements: [
                    { view: 'counter', name: 'dashboardTargetS', label: 'Dashboard update target (s)', min: 1, max: 30 },
                    { view: 'text', name: 'uptimeTarget', label: 'Availability target', readonly: true },
                    { view: 'counter', name: 'retentionYears', label: 'Keep history (years)', min: 1, max: 20 },
                    { view: 'switch', name: 'backupEnabled', label: 'Daily backup' },
                    { view: 'text', name: 'backupTime', label: 'Backup time', placeholder: '02:00' },
                    { view: 'template', borderless: true, autoheight: true, template: () => infoNote('NFR targets: dashboard data within 3 seconds, 99.5 % availability, 5 years of traceability history, daily backup. In the mock these values are stored and audited; the real server enforces them.') },
                    {},
                    {
                      cols: [
                        {},
                        canEdit
                          ? {
                              view: 'button',
                              value: 'Save parameters',
                              css: 'webix_primary',
                              autowidth: true,
                              click: () => save(),
                            }
                          : { view: 'label', label: '<span class="muted">View only</span>', autowidth: true },
                      ],
                    },
                  ],
                },
              }),
            ],
          },
          card({
            title: 'Alarm criteria',
            sub: 'FR-014: criteria to be agreed with the process owner. Edit severity, threshold and on / off directly.',
            height: 470,
            body: {
              view: 'datatable',
              id: 'sys-rules',
              borderless: true,
              editable: canEdit,
              editaction: 'click',
              rowHeight: 48,
              columns: [
                { id: 'name', header: 'Alarm', width: 270, template: (o) => `<b>${esc(o.name)}</b><div class="muted mono" style="font-size:11px">${esc(o.code)}</div>` },
                {
                  id: 'severity',
                  header: 'Severity',
                  width: 130,
                  editor: 'richselect',
                  options: [
                    { id: 'critical', value: 'Critical' },
                    { id: 'warning', value: 'Warning' },
                    { id: 'info', value: 'Info' },
                  ],
                  template: (o) => severityBadge(o.severity),
                },
                { id: 'threshold', header: 'Threshold', width: 120, editor: 'text', template: (o) => (o.threshold != null && o.threshold !== '' ? `${esc(o.threshold)} ${esc(o.unit)}` : '<span class="muted">on occurrence</span>') },
                { id: 'description', header: 'Raised when', fillspace: 1, minWidth: 300 },
                { id: 'enabled', header: 'Enabled', width: 90, template: (o, common, value, config) => (canEdit ? common.checkbox(o, common, value, config) : o.enabled ? 'On' : 'Off'), checkValue: 1, uncheckValue: 0 },
              ],
              on: {
                onAfterEditStop(state, editor) {
                  if (state.value === state.old) return;
                  const rule = db.alarmRules.find((r) => r.code === editor.row);
                  const key = editor.column;
                  if (key === 'threshold' && rule.threshold == null) {
                    toast('This alarm is raised on every occurrence; it has no threshold.', 'warning');
                    this.updateItem(editor.row, { threshold: null });
                    return;
                  }
                  const value = key === 'threshold' ? Number(state.value) : state.value;
                  if (key === 'threshold' && !(value > 0)) {
                    toast('Enter a positive number.', 'error');
                    this.updateItem(editor.row, { threshold: rule.threshold });
                    return;
                  }
                  const before = rule[key];
                  rule[key] = value;
                  audit(currentUser(), 'Parameters', 'Alarm criteria changed', rule.name, { before: { [key]: before }, after: { [key]: value }, category: 'Configuration change' });
                  changed('config', {});
                },
                onCheck(rowId, colId, state) {
                  const rule = db.alarmRules.find((r) => r.code === rowId);
                  const before = rule.enabled;
                  rule.enabled = !!state;
                  audit(currentUser(), 'Parameters', 'Alarm criteria changed', rule.name, { before: { enabled: before }, after: { enabled: rule.enabled }, category: 'Configuration change' });
                  changed('config', {});
                },
              },
            },
          }),
        ],
      },
    };
  },

  init() {
    const v = formValues();
    // each form only gets its own fields (Webix keeps unknown keys in getValues)
    for (const id of ['sys-form', 'sys-form-2']) {
      const form = webix.$$(id);
      if (form) form.setValues(Object.fromEntries(Object.keys(form.elements).map((k) => [k, v[k]])));
    }
    const t = webix.$$('sys-rules');
    if (t) t.parse(ruleRows());
  },
};

// Parameter module · server and desktop settings (+ environment configuration).
// Desktops are bound to a process point and carry the Windows user used for single sign-on (FR-004).
import webix from '../../lib/webix.js';
import { db, stationName } from '../../core/db.js';
import { audit } from '../../core/audit.js';
import { changed } from '../../core/bus.js';
import { currentUser } from '../../core/session.js';
import { integrationHealth } from '../../core/integrations.js';
import { env } from '../../config/env.js';
import { esc } from '../../core/format.js';
import { card, health, mono, infoNote } from '../../ui/components.js';

function envHtml() {
  const rows = [
    ['VITE_APP_ENV', env.appEnv],
    ['VITE_USE_MOCK', String(env.useMock)],
    ['VITE_API_BASE_URL', env.apiBaseUrl],
    ['VITE_WS_URL', env.wsUrl],
    ['VITE_OPC_ENDPOINT', env.opcEndpoint],
    ['VITE_LDAP_DOMAIN', env.ldapDomain],
    ['App version', env.version],
  ];
  return `<div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
    ${infoNote('Values come from <span class="mono">.env.development</span> / <span class="mono">.env.production</span> (override locally with <span class="mono">.env.local</span>). Hostnames are placeholders until the PTCT network plan is confirmed.')}
    <div class="trace-facts">${rows.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b class="mono">${esc(v || '–')}</b></div>`).join('')}</div></div>`;
}

function serverStatus(o) {
  if (o.id === 'CTMS' && db.settings.ctmsOutage) return 'OFFLINE';
  if (o.id === 'CTTRACK') return integrationHealth('CTTRACK');
  if (o.id === 'OPC') return integrationHealth('OPC');
  return o.status;
}

export default {
  route: 'param-infra',
  title: 'Servers & Desktops',
  subtitle: 'Server roles from the topology diagram and the operator PCs bound to each process point',
  perm: 'parameters',
  nav: { group: 'grp-param', label: 'Servers & desktops', icon: 'mdi-server-network', order: 43 },

  ui() {
    const stationOptions = [{ id: '', value: 'Not bound' }, ...db.stations.map((s) => ({ id: s.id, value: `${s.code} · ${s.name}` }))];
    const userOptions = [{ id: '', value: 'None (sign in with username)' }, ...db.users.filter((u) => u.status === 'ACTIVE').map((u) => ({ id: u.username, value: `${u.name} (${u.username})` }))];
    const userName = (username) => db.users.find((u) => u.username === username)?.name || username;
    return {
      view: 'scrollview',
      scroll: 'y',
      css: 'page',
      body: {
        type: 'space',
        css: 'page',
        rows: [
          card({
            title: 'Servers',
            sub: 'Numbers refer to the topology diagram · CTMS is reached only through CT-Track (FR-010)',
            height: 340,
            body: {
              view: 'datatable',
              id: 'inf-servers',
              borderless: true,
              data: db.servers.map((s) => ({ ...s })),
              columns: [
                { id: 'no', header: 'No.', width: 56, template: (o) => (o.no ? `<span class="guide-no" style="width:24px;height:24px;font-size:13px;background:var(--reject);color:#fff">${o.no}</span>` : '–') },
                { id: 'name', header: 'Role', fillspace: 1, minWidth: 280 },
                { id: 'host', header: 'Host', width: 150, template: (o) => mono(o.host) },
                { id: 'network', header: 'Network', width: 100 },
                { id: 'os', header: 'OS', width: 160 },
                { id: 'stack', header: 'Stack', width: 330 },
                { id: 'ports', header: 'Ports', width: 190 },
                { id: 'status', header: 'Status', width: 110, template: (o) => health(serverStatus(o)) },
              ],
            },
          }),
          card({
            title: 'Operator desktops',
            sub: 'Station display PCs (Windows 11, Microsoft Edge). Click “Bound station” or “Windows user” to change them.',
            height: 470,
            body: {
              view: 'datatable',
              id: 'inf-desk',
              borderless: true,
              editable: true,
              editaction: 'click',
              data: db.desktops.map((d) => ({ id: d.host, ...d, defaultUser: d.defaultUser || '' })),
              columns: [
                { id: 'host', header: 'Hostname', width: 150, template: (o) => mono(o.host) },
                { id: 'stationId', header: 'Bound station', width: 190, editor: 'richselect', options: stationOptions, template: (o) => (o.stationId ? esc(stationName(o.stationId)) : '<span class="muted">Not bound</span>') },
                { id: 'defaultUser', header: 'Windows user (SSO)', width: 200, editor: 'richselect', options: userOptions, template: (o) => (o.defaultUser ? esc(userName(o.defaultUser)) : '<span class="muted">none</span>') },
                { id: 'use', header: 'Use', fillspace: 1, minWidth: 170 },
                { id: 'os', header: 'OS', width: 110 },
                { id: 'browser', header: 'Browser', width: 180 },
                { id: 'screen', header: 'Screen', width: 100 },
                { id: 'status', header: 'Status', width: 110, template: (o) => health(o.status) },
              ],
              on: {
                onAfterEditStop(state, editor) {
                  if (state.value === state.old) return;
                  const d = db.desktops.find((x) => x.host === editor.row);
                  if (editor.column === 'stationId') {
                    const before = d.stationId ? stationName(d.stationId) : 'not bound';
                    d.stationId = state.value || null;
                    audit(currentUser(), 'Parameters', 'Desktop binding changed', d.host, { before: { station: before }, after: { station: d.stationId ? stationName(d.stationId) : 'not bound' }, category: 'Configuration change' });
                  }
                  if (editor.column === 'defaultUser') {
                    const before = d.defaultUser || 'none';
                    d.defaultUser = state.value || null;
                    audit(currentUser(), 'Parameters', 'Desktop SSO user changed', d.host, { before: { windowsUser: before }, after: { windowsUser: d.defaultUser || 'none' }, category: 'Configuration change' });
                  }
                  changed('config', {});
                },
              },
            },
          }),
          card({ title: 'Environment configuration', sub: 'Build-time settings of this front end', body: { view: 'template', borderless: true, autoheight: true, template: envHtml } }),
        ],
      },
    };
  },

  init(ctx) {
    ctx.every(3000, () => webix.$$('inf-servers')?.refresh());
  },
};

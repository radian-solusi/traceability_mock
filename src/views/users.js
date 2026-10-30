// User Access & Authorization module: AD accounts, roles, permission matrix, AD group mapping.
// FR-004: Microsoft Active Directory (LDAP / Kerberos), single sign-on, no password stored.
// Roles from Rev 1: Administrator, Supervisor, Operator, Reporting user.
import webix from '../lib/webix.js';
import { db, getUser, reindex, stationName } from '../core/db.js';
import { audit } from '../core/audit.js';
import { changed } from '../core/bus.js';
import { currentUser } from '../core/session.js';
import { env } from '../config/env.js';
import { esc, fmtDateTime } from '../core/format.js';
import { mono, iconButton, exportCsv, toast, infoNote } from '../ui/components.js';
import { syncTable } from '../ui/table.js';

const ROLE_GROUP = { Admin: 'PTCT-TRC-Admins', Supervisor: 'PTCT-TRC-Supervisors', Operator: 'PTCT-TRC-Operators', Reporting: 'PTCT-TRC-Reporting' };
const ROLE_IDS = ['Admin', 'Supervisor', 'Operator', 'Reporting'];
const ROLE_CHIP = { Admin: 'chip-reject', Supervisor: 'chip-info', Operator: 'chip-muted', Reporting: 'chip-active' };

function userRows() {
  return db.users.map((u) => ({
    id: u.username,
    username: u.username,
    name: u.name,
    title: u.title,
    department: u.department || '',
    role: u.role,
    adGroup: u.adGroup,
    stations: u.stations.includes('*') ? 'All stations' : u.stations.length ? u.stations.map(stationName).join(', ') : 'No station display',
    status: u.status,
    lastLogin: u.lastLogin,
  }));
}

function permRows() {
  return Object.entries(db.permissions).map(([key, p]) => ({ id: key, key, name: p.name, Admin: p.Admin, Supervisor: p.Supervisor, Operator: p.Operator, Reporting: p.Reporting }));
}

const permCell = (v) => `<span class="perm perm-${v}"><i class="mdi ${v === 'edit' ? 'mdi-pencil' : v === 'view' ? 'mdi-eye-outline' : 'mdi-cancel'}"></i>${v === 'edit' ? 'Edit' : v === 'view' ? 'View' : 'No access'}</span>`;

function openUser(username) {
  const u = getUser(username);
  if (!u) return;
  webix.$$('user-win')?.destructor();
  const stationOptions = db.stations.map((s) => ({ id: s.id, value: s.name }));
  const win = webix.ui({
    view: 'window',
    id: 'user-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(580, window.innerWidth - 24),
    head: esc(`${u.name} · ${env.ldapDomain}\\${u.username}`),
    body: {
      view: 'form',
      id: 'user-form',
      elementsConfig: { labelWidth: 130 },
      elements: [
        { view: 'template', borderless: true, autoheight: true, template: () => infoNote('Name, title and password live in Active Directory. Here you manage the role (through the AD group) and the process points the user may operate. Reporting users have no station display.') },
        { view: 'richselect', name: 'role', label: 'Role', options: ROLE_IDS.map((r) => ({ id: r, value: db.roles.find((x) => x.id === r)?.name || r })), value: u.role },
        { view: 'multiselect', name: 'stations', label: 'Stations', options: stationOptions, value: u.stations.includes('*') ? db.stations.map((s) => s.id).join(',') : u.stations.join(','), placeholder: 'Process points' },
        { view: 'switch', name: 'active', label: 'Account active', value: u.status === 'ACTIVE' ? 1 : 0 },
        {
          cols: [
            {},
            { view: 'button', value: 'Cancel', css: 'btn-ghost', autowidth: true, click: () => win.close() },
            {
              view: 'button',
              value: 'Save',
              css: 'webix_primary',
              autowidth: true,
              click: () => {
                const v = webix.$$('user-form').getValues();
                const all = db.stations.map((s) => s.id);
                const picked = String(v.stations || '').split(',').filter(Boolean);
                if (u.username === currentUser().username && v.role !== 'Admin') return toast('You cannot remove your own Admin role.', 'error');
                const before = { role: u.role, group: u.adGroup, stations: u.stations.includes('*') ? 'all' : u.stations.join('/') || 'none', status: u.status };
                u.role = v.role;
                u.adGroup = ROLE_GROUP[v.role];
                u.stations = v.role === 'Reporting' ? [] : v.role !== 'Operator' || picked.length === all.length ? ['*'] : picked;
                u.status = v.active ? 'ACTIVE' : 'DISABLED';
                if (u.stations.length && u.stations[0] !== '*' && !u.stations.includes(u.defaultStation)) u.defaultStation = u.stations[0];
                const after = { role: u.role, group: u.adGroup, stations: u.stations.includes('*') ? 'all' : u.stations.join('/') || 'none', status: u.status };
                audit(currentUser(), 'User access', 'User changed', u.username, { before, after, category: 'Configuration change' });
                reindex();
                changed('config', {});
                win.close();
                toast('User saved', 'success');
              },
            },
          ],
        },
      ],
    },
  });
  win.show();
}

const policyHtml = () => `<div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
  <div class="trace-facts">
    <div class="fact"><span>Directory</span><b class="mono">${esc(env.ldapDomain)} · ldaps://ptct-dc01:636</b></div>
    <div class="fact"><span>Bind account</span><b class="mono">${esc(env.ldapDomain)}\\svc-trc-ldap</b></div>
    <div class="fact"><span>Single sign-on</span><b>Kerberos (Windows account of the workstation)</b></div>
    <div class="fact"><span>Token</span><b>JWT (RS256), 8 h, refreshed on activity</b></div>
    <div class="fact"><span>Idle lock</span><b>30 min on station displays</b></div>
    <div class="fact"><span>Passwords</span><b>Never stored by the application</b></div>
    <div class="fact"><span>Audit</span><b>Login, logout, status changes, manual corrections, configuration changes</b></div>
  </div>
  ${infoNote('Role resolution: the first matching group wins (Admins → Supervisors → Operators → Reporting). A user in none of the groups cannot sign in.')}
</div>`;

export default {
  route: 'users',
  title: 'User Access & Authorization',
  subtitle: 'Active Directory accounts, roles, station assignment and module permissions',
  perm: 'users',
  nav: { label: 'User access', icon: 'mdi-shield-account-outline', order: 60 },

  ui() {
    return {
      type: 'space',
      css: 'page',
      rows: [
        {
          css: 'card',
          rows: [
            {
              view: 'tabbar',
              multiview: true,
              height: 46,
              value: 'us-users',
              options: [
                { id: 'us-users', value: 'Users' },
                { id: 'us-perms', value: 'Roles & permissions' },
                { id: 'us-ad', value: 'AD groups & session policy' },
              ],
            },
            {
              cells: [
                {
                  id: 'us-users',
                  rows: [
                    {
                      view: 'toolbar',
                      height: 52,
                      paddingX: 12,
                      elements: [
                        { view: 'search', id: 'us-search', width: 240, placeholder: 'Search name or username', on: { onTimedKeyPress: () => { const q = webix.$$('us-search').getValue().toLowerCase(); webix.$$('us-table').filter((o) => !q || o.name.toLowerCase().includes(q) || o.username.includes(q)); } } },
                        {},
                        iconButton('mdi-account-sync-outline', 'Sync from Active Directory', () => {
                          if (getUser('dimas.saputra')) return toast('Directory is in sync: no new accounts in the traceability groups.', 'success');
                          db.users.push({ username: 'dimas.saputra', name: 'Dimas Saputra', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · PAUT (new)', department: 'Production HT', upn: 'dimas.saputra@ptct.local', stations: ['PAUT'], defaultStation: 'PAUT', status: 'ACTIVE', lastLogin: null });
                          reindex();
                          audit(currentUser(), 'User access', 'AD sync', '1 new account: dimas.saputra (PTCT-TRC-Operators)', { before: 'not in the application', after: { role: 'Operator', stations: 'PAUT' }, category: 'Configuration change' });
                          syncTable('us-table', userRows());
                          toast('1 new account found in PTCT-TRC-Operators: Dimas Saputra', 'success');
                        }),
                        iconButton('mdi-export', 'Export', () => exportCsv('us-table', 'users')),
                      ],
                    },
                    {
                      view: 'datatable',
                      id: 'us-table',
                      borderless: true,
                      select: 'row',
                      columns: [
                        { id: 'username', header: 'Account', width: 160, template: (o) => mono(`${env.ldapDomain}\\${o.username}`) },
                        { id: 'name', header: 'Name', width: 150 },
                        { id: 'title', header: 'Title', width: 190, template: (o) => `<span title="${esc(o.department)}">${esc(o.title)}</span>` },
                        { id: 'role', header: 'Role', width: 104, template: (o) => `<span class="chip ${ROLE_CHIP[o.role] || 'chip-muted'}">${o.role}</span>` },
                        { id: 'adGroup', header: 'AD group', width: 182, template: (o) => mono(o.adGroup) },
                        { id: 'stations', header: 'Stations', fillspace: 1, minWidth: 160 },
                        { id: 'status', header: 'Status', width: 92, template: (o) => (o.status === 'ACTIVE' ? '<span class="chip chip-good">Active</span>' : '<span class="chip chip-muted">Disabled</span>') },
                        { id: 'lastLogin', header: 'Last login', width: 120, template: (o) => `<span class="mono">${o.lastLogin ? fmtDateTime(o.lastLogin) : '–'}</span>` },
                      ],
                      on: { onItemClick: (id) => openUser(id.row) },
                    },
                  ],
                },
                {
                  id: 'us-perms',
                  rows: [
                    { view: 'template', borderless: true, autoheight: true, template: () => `<div style="padding:10px 12px 4px">${infoNote('Click a cell to change what a role may do in a module. The navigation menu follows these permissions after “Apply to menus”.')}</div>` },
                    {
                      view: 'datatable',
                      id: 'us-perm-table',
                      borderless: true,
                      editable: true,
                      editaction: 'click',
                      columns: [
                        { id: 'name', header: 'Module', fillspace: 1, minWidth: 300 },
                        ...ROLE_IDS.map((role) => ({
                          id: role,
                          header: role,
                          width: 130,
                          editor: 'richselect',
                          options: [
                            { id: 'edit', value: 'Edit' },
                            { id: 'view', value: 'View' },
                            { id: 'none', value: 'No access' },
                          ],
                          template: (o) => permCell(o[role]),
                        })),
                      ],
                      on: {
                        onAfterEditStop(state, editor) {
                          if (state.value === state.old) return;
                          if (editor.row === 'users' && editor.column === 'Admin' && state.value !== 'edit') {
                            toast('Admins must keep edit access to User access.', 'error');
                            this.updateItem(editor.row, { Admin: 'edit' });
                            return;
                          }
                          db.permissions[editor.row][editor.column] = state.value;
                          audit(currentUser(), 'User access', 'Permission changed', `${db.permissions[editor.row].name} · ${editor.column}`, { before: state.old, after: state.value, category: 'Configuration change' });
                        },
                      },
                    },
                    {
                      view: 'toolbar',
                      height: 52,
                      paddingX: 12,
                      elements: [{}, { view: 'button', value: 'Apply to menus', css: 'webix_primary', autowidth: true, click: () => window.dispatchEvent(new CustomEvent('ptct:rerender')) }],
                    },
                  ],
                },
                {
                  id: 'us-ad',
                  view: 'scrollview',
                  scroll: 'y',
                  body: {
                    rows: [
                      {
                        view: 'datatable',
                        borderless: true,
                        autoheight: true,
                        data: db.adGroups.map((g) => ({ id: g.group, ...g, members: db.users.filter((u) => u.adGroup === g.group).length })),
                        columns: [
                          { id: 'group', header: 'AD group', width: 220, template: (o) => mono(o.group) },
                          { id: 'role', header: 'Role', width: 120 },
                          { id: 'members', header: 'Members', width: 100 },
                          { id: 'dn', header: 'Distinguished name', fillspace: 1, minWidth: 360, template: (o) => mono(o.dn) },
                        ],
                      },
                      { view: 'template', borderless: true, autoheight: true, template: policyHtml },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  },

  init(ctx) {
    syncTable('us-table', userRows());
    webix.$$('us-perm-table').parse(permRows());
    ctx.on('config', () => syncTable('us-table', userRows()));
  },
};

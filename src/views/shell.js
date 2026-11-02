// Application shell: navigation rail, live header, page host.
import webix from '../lib/webix.js';
import { db, getStation, getStationBySlug } from '../core/db.js';
import { on } from '../core/bus.js';
import { currentUser, can, allowedStations, logout } from '../core/session.js';
import { parseHash, navigate, getPage, allPages } from '../core/router.js';
import { setThemePref, themePref, currentTheme } from '../core/theme.js';
import { setAutoSim, setWatching } from '../core/simulator.js';
import { unreadCount, markAllRead } from '../core/audit.js';
import { unackedCount, activeAlarms } from '../core/alarms.js';
import { integrationHealth } from '../core/integrations.js';
import { esc, fmtTime, fmtAgo, initials, shiftOf } from '../core/format.js';
import { env } from '../config/env.js';
import logoUrl from '../assets/ptct-logo.png';
import emblemUrl from '../assets/ptct-emblem.png';

const NAV_GROUPS = [
  { id: 'grp-dash', value: 'Dashboards', icon: 'mdi mdi-view-dashboard-outline' },
  { id: 'grp-station', value: 'Station display', icon: 'mdi mdi-monitor-dashboard' },
  { id: 'grp-int', value: 'Integration', icon: 'mdi mdi-lan-connect' },
  { id: 'grp-param', value: 'Parameters', icon: 'mdi mdi-tune-variant' },
];

let current = null; // { page, viewId, ctx }
let seq = 0;
const shellSubs = [];
let clockTimer = null;
let resizeHandler = null;

// ---------------------------------------------------------------------------
// Page context: subscriptions and timers that are cleaned up on navigation
// ---------------------------------------------------------------------------
function createCtx(param) {
  const offs = [];
  const timers = [];
  const views = [];
  const ctx = {
    param,
    user: currentUser(),
    on(topic, fn) {
      offs.push(on(topic, fn));
    },
    /** Call fn on every state change, at most once per `ms`. */
    live(fn, ms = 450) {
      let last = 0;
      let pending = null;
      const run = () => {
        pending = null;
        last = Date.now();
        try {
          fn();
        } catch (err) {
          console.error('[page refresh]', err);
        }
      };
      offs.push(
        on('state', () => {
          if (pending) return;
          pending = setTimeout(run, Math.max(0, ms - (Date.now() - last)));
        })
      );
      offs.push(() => pending && clearTimeout(pending));
    },
    every(ms, fn) {
      const t = setInterval(fn, ms);
      timers.push(t);
      return t;
    },
    later(ms, fn) {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    },
    track(view) {
      views.push(view);
      return view;
    },
    go: navigate,
    dispose() {
      offs.forEach((off) => off());
      timers.forEach((t) => {
        clearTimeout(t);
        clearInterval(t);
      });
      views.forEach((v) => {
        try {
          if (v && v.destructor && webix.$$(v.config.id)) v.destructor();
        } catch {
          /* already gone */
        }
      });
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Navigation menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const user = currentUser();
  const pages = allPages().filter((p) => p.nav && can(p.perm));
  const items = [];
  const groups = Object.fromEntries(NAV_GROUPS.map((g) => [g.id, { ...g, data: [] }]));

  for (const p of pages.sort((a, b) => a.nav.order - b.nav.order)) {
    if (p.route === 'station') continue;
    const item = { id: p.route, value: p.nav.label, icon: `mdi ${p.nav.icon}`, route: p.route };
    if (p.nav.group && groups[p.nav.group]) groups[p.nav.group].data.push(item);
    else items.push({ ...item, order: p.nav.order });
  }
  if (can('station')) {
    for (const id of allowedStations(user)) {
      const st = getStation(id);
      groups['grp-station'].data.push({ id: `station:${st.slug}`, value: st.name, icon: `mdi ${st.cameraId ? 'mdi-barcode-scan' : 'mdi-gesture-tap'}`, route: 'station', param: st.slug });
    }
  }
  const ordered = [];
  const pushGroup = (gid) => groups[gid].data.length && ordered.push(groups[gid]);
  pushGroup('grp-dash');
  pushGroup('grp-station');
  items.filter((i) => i.order < 50).forEach((i) => ordered.push(i));
  pushGroup('grp-int');
  pushGroup('grp-param');
  items.filter((i) => i.order >= 50).forEach((i) => ordered.push(i));
  return ordered;
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------
function statusHtml() {
  const ints = [
    ['OPC', 'OPC'],
    ['KEYENCE', 'Scanners'],
    ['DMC', 'DMC'],
    ['CTTRACK', 'CT-Track'],
    ['LDAP', 'AD'],
  ];
  const dots = ints
    .map(([k, label]) => {
      const h = integrationHealth(k).toLowerCase();
      return `<span class="hdr-int ${h}" title="${esc(db.integrations[k]?.name || k)}: ${h}"><i></i>${label}</span>`;
    })
    .join('');
  return `<div class="hdr-strip">${dots}<span class="clock" title="${esc(shiftOf().label)}"><i></i>${fmtTime(Date.now())}</span></div>`;
}

function userHtml() {
  const u = currentUser();
  if (!u) return '';
  const st = u.stationId ? getStation(u.stationId)?.name : null;
  return `<div class="user-btn webix_user_btn"><span class="avatar">${initials(u.name)}</span><span class="user-meta"><span class="user-name">${esc(u.name)}</span><span class="user-role">${esc(u.role)}${st && u.role === 'Operator' ? ' · ' + esc(st) : ''}</span></span><i class="mdi mdi-chevron-down muted"></i></div>`;
}

function brandHtml(collapsed) {
  if (collapsed) return `<div class="brand brand-collapsed"><span class="brand-plate"><img src="${emblemUrl}" alt="PT Citra Tubindo Tbk"></span></div>`;
  return `<div class="brand"><span class="brand-plate wide"><img src="${logoUrl}" alt="PT Citra Tubindo Tbk · Vallourec Group"></span></div>`;
}

function footHtml(collapsed) {
  if (collapsed) return '<div class="nav-foot-inner"><span class="mock-badge" title="Mock data">M</span></div>';
  return `<div class="nav-foot-inner"><span class="mock-badge"><i class="mdi mdi-flask-outline"></i>Mock · simulated data</span><span>v${esc(env.version)} · ${esc(env.appEnv)} · Webix ${esc(webix.version)}</span></div>`;
}

const themeIcon = () => ({ auto: 'mdi mdi-theme-light-dark', light: 'mdi mdi-white-balance-sunny', dark: 'mdi mdi-weather-night' })[themePref()];

function notifTemplate(n) {
  const icon = { info: 'mdi-information-outline', success: 'mdi-check-circle-outline', warning: 'mdi-alert-outline', error: 'mdi-alert-octagon-outline' }[n.level];
  return `<div class="notif ${n.read ? '' : 'unread'}"><i class="mdi ${icon} lvl-${n.level}"></i><div><div>${esc(n.text)}</div><div class="notif-time">${fmtAgo(n.ts)}${n.route ? ' · open' : ''}</div></div></div>`;
}

function buildPopups() {
  webix.ui({
    view: 'popup',
    id: 'notif-popup',
    width: 400,
    height: 460,
    body: {
      rows: [
        {
          view: 'toolbar',
          paddingX: 10,
          elements: [
            { view: 'label', label: '<b>Notifications</b>' },
            {},
            {
              view: 'button',
              value: 'Mark all read',
              css: 'btn-ghost',
              autowidth: true,
              click: () => {
                markAllRead();
                refreshNotifications();
              },
            },
          ],
        },
        {
          view: 'list',
          id: 'notif-list',
          type: { height: 'auto' },
          select: true,
          template: notifTemplate,
          on: {
            onItemClick(id) {
              const n = db.notifications.find((x) => x.id === id);
              if (!n) return;
              n.read = true;
              webix.$$('notif-popup').hide();
              refreshNotifications();
              if (n.route) {
                const [name, ...rest] = n.route.split('-');
                if (name === 'station') navigate('station', rest.join('-'));
                else navigate(n.route);
              }
            },
          },
        },
      ],
    },
  });

  webix.ui({
    view: 'popup',
    id: 'user-popup',
    width: 320,
    body: {
      rows: [
        { view: 'template', id: 'user-card', autoheight: true, borderless: true, template: userCardHtml },
        {
          view: 'toolbar',
          borderless: true,
          paddingX: 14,
          elements: [
            {},
            {
              view: 'button',
              value: 'Sign out',
              css: 'btn-ghost',
              autowidth: true,
              click: () => {
                webix.$$('user-popup').hide();
                logout();
                location.hash = '';
                window.dispatchEvent(new CustomEvent('ptct:rerender'));
              },
            },
          ],
        },
      ],
    },
  });
}

function userCardHtml() {
  const u = currentUser();
  if (!u) return '';
  const st = u.stationId ? getStation(u.stationId)?.name : '–';
  const stations = u.stations.includes('*') ? 'All stations' : u.stations.length ? u.stations.map((s) => getStation(s)?.name).join(', ') : 'None (no station display)';
  return `<div class="user-card"><div><b>${esc(u.name)}</b><div class="muted">${esc(u.title || '')} · ${esc(u.department || '')}</div></div>
  <dl><dt>Account</dt><dd class="mono">${esc(env.ldapDomain)}\\${esc(u.username)}</dd>
  <dt>UPN</dt><dd class="mono">${esc(u.upn || '')}</dd>
  <dt>AD group</dt><dd>${esc(u.adGroup)}</dd>
  <dt>Role</dt><dd>${esc(db.roles.find((r) => r.id === u.role)?.name || u.role)}</dd>
  <dt>Sign-in</dt><dd>${esc(u.method || 'LDAP bind')} · password not stored</dd>
  <dt>Stations</dt><dd>${esc(stations)}</dd>
  <dt>Workstation</dt><dd>${esc(u.desktop || 'not bound')}${u.desktop ? ` · ${esc(st)}` : ''}</dd>
  <dt>Signed in</dt><dd>${fmtTime(u.loginAt)} · ${esc(shiftOf(u.loginAt).label)}</dd>
  <dt>JWT</dt><dd class="mono" title="${esc(u.token)}">${esc(u.token.slice(0, 26))}…</dd></dl></div>`;
}

function refreshNotifications() {
  const list = webix.$$('notif-list');
  if (list) {
    list.clearAll();
    list.parse(db.notifications.slice(0, 60));
  }
  const bell = webix.$$('hdr-bell');
  if (bell) {
    bell.config.badge = unreadCount() || null;
    bell.refresh();
  }
}

function refreshAlarmIcon() {
  const icon = webix.$$('hdr-alarm');
  if (!icon) return;
  const n = unackedCount();
  icon.config.badge = n || null;
  icon.refresh();
  if (icon.$view) icon.$view.classList.toggle('alarm-on', activeAlarms().some((a) => a.state === 'ACTIVE' && a.severity === 'critical'));
}

function refreshSimIcon() {
  const icon = webix.$$('hdr-sim');
  if (!icon) return;
  icon.config.icon = db.settings.autoSim ? 'mdi mdi-pause-circle-outline' : 'mdi mdi-play-circle-outline';
  icon.config.css = db.settings.autoSim ? 'sim-on' : '';
  icon.config.tooltip = db.settings.autoSim ? 'Auto-simulation running: pause' : 'Start auto-simulation (virtual plant)';
  icon.refresh();
  if (icon.$view) icon.$view.classList.toggle('sim-on', !!db.settings.autoSim);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
export function renderShell() {
  const menu = buildMenu();
  webix.ui({
    id: 'app-root',
    css: 'app-root',
    cols: [
      {
        id: 'nav-col',
        css: 'nav-col',
        rows: [
          { view: 'template', id: 'nav-brand', css: 'nav-brand', height: 64, borderless: true, template: () => brandHtml(webix.$$('nav')?.config.collapsed) },
          {
            view: 'sidebar',
            id: 'nav',
            css: currentTheme() === 'dark' ? 'nav webix_dark' : 'nav',
            width: 240,
            collapsedWidth: 56,
            data: menu,
            on: {
              onAfterSelect(id) {
                const item = this.getItem(id);
                if (!item || item.data) return;
                if (item.route) navigate(item.route, item.param);
              },
            },
          },
          { view: 'template', id: 'nav-foot', css: 'nav-foot', height: 58, borderless: true, template: () => footHtml(webix.$$('nav')?.config.collapsed) },
        ],
      },
      {
        rows: [
          {
            view: 'toolbar',
            id: 'hdr',
            css: 'app-header',
            height: 60,
            paddingX: 10,
            elements: [
              { view: 'icon', icon: 'mdi mdi-menu', tooltip: 'Collapse or expand the menu', click: toggleNav },
              { view: 'template', id: 'hdr-title', css: 'hdr-title', borderless: true, minWidth: 110, data: { title: '', subtitle: '' }, template: (o) => `<div class="hdr-t">${esc(o.title || '')}</div><div class="hdr-s">${esc(o.subtitle || '')}</div>` },
              { view: 'template', id: 'hdr-status', css: 'hdr-status', borderless: true, width: 400, template: statusHtml },
              { view: 'icon', id: 'hdr-sim', icon: 'mdi mdi-play-circle-outline', tooltip: 'Start auto-simulation', click: () => setAutoSim(!db.settings.autoSim) },
              {
                view: 'icon',
                id: 'hdr-theme',
                icon: themeIcon(),
                tooltip: 'Theme: auto / light / dark',
                click: () => {
                  const next = { auto: 'light', light: 'dark', dark: 'auto' }[themePref()];
                  setThemePref(next);
                  const t = webix.$$('hdr-theme');
                  if (t) {
                    t.config.icon = themeIcon();
                    t.refresh();
                  }
                  webix.message({ text: `Theme: ${next}`, expire: 1500 });
                },
              },
              { view: 'icon', id: 'hdr-alarm', icon: 'mdi mdi-alarm-light-outline', tooltip: 'Alarms & exceptions', badge: unackedCount() || null, click: () => can('alarms') && navigate('alarms') },
              { view: 'icon', id: 'hdr-bell', icon: 'mdi mdi-bell-outline', tooltip: 'Notifications', badge: unreadCount() || null, popup: 'notif-popup' },
              { view: 'template', id: 'hdr-user', css: 'hdr-user', borderless: true, width: 206, template: userHtml, onClick: { webix_user_btn: () => webix.$$('user-popup').show(webix.$$('hdr-user').$view, { pos: 'bottom', x: -110 }) } },
            ],
          },
          { id: 'page-host', css: 'page-host', rows: [{ id: 'page-0', template: '' }] },
        ],
      },
    ],
  });
  current = { page: null, viewId: 'page-0', ctx: null };
  buildPopups();
  refreshNotifications();
  refreshSimIcon();
  refreshAlarmIcon();

  shellSubs.push(on('notify', refreshNotifications));
  shellSubs.push(on('alarm', refreshAlarmIcon));
  shellSubs.push(on('sim', refreshSimIcon));
  shellSubs.push(on('session', () => webix.$$('hdr-user')?.refresh()));
  clockTimer = setInterval(() => webix.$$('hdr-status')?.refresh(), 1000);

  resizeHandler = () => adapt();
  window.addEventListener('resize', resizeHandler);
  adapt();
}

function adapt() {
  const w = window.innerWidth;
  const nav = webix.$$('nav');
  if (nav && w < 1200 && !nav.config.collapsed) toggleNav();
  const status = webix.$$('hdr-status');
  if (status) {
    if (w < 1280 && status.isVisible()) status.hide();
    else if (w >= 1280 && !status.isVisible()) status.show();
  }
  for (const id of ['hdr-sim', 'hdr-theme']) {
    const v = webix.$$(id);
    if (!v) continue;
    if (w < 560 && v.isVisible()) v.hide();
    else if (w >= 560 && !v.isVisible()) v.show();
  }
  const user = webix.$$('hdr-user');
  if (user) {
    if (w < 720 && user.config.width !== 46) {
      user.define('width', 46);
      user.resize();
    } else if (w >= 720 && user.config.width !== 206) {
      user.define('width', 206);
      user.resize();
    }
  }
}

function toggleNav() {
  const nav = webix.$$('nav');
  if (!nav) return;
  nav.toggle();
  webix.$$('nav-brand')?.refresh();
  webix.$$('nav-foot')?.refresh();
}

export function destroyShell() {
  unmountPage();
  shellSubs.splice(0).forEach((off) => off());
  clearInterval(clockTimer);
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  ['notif-popup', 'user-popup'].forEach((id) => webix.$$(id)?.destructor());
}

function unmountPage() {
  if (!current?.page) return;
  try {
    current.page.destroy?.(current.ctx);
  } catch (err) {
    console.error(err);
  }
  current.ctx?.dispose();
  setWatching({ stationId: null, supervisor: false });
}

export function defaultRoute(user = currentUser()) {
  if (!user) return { name: null };
  if (user.role === 'Operator') {
    const st = getStation(user.stationId || allowedStations(user)[0]);
    return { name: 'station', param: st?.slug };
  }
  if (user.role === 'Supervisor') return { name: 'supervisor' };
  if (user.role === 'Reporting') return { name: 'reports' };
  return { name: 'operations' };
}

/** Mount the page that matches the current hash. */
export function showRoute() {
  const host = webix.$$('page-host');
  if (!host) return;
  let { name, param } = parseHash();
  let page = name ? getPage(name) : null;
  if (!page || !can(page.perm)) {
    if (name && page) {
      const title = typeof page.title === 'function' ? page.title({ param }) : page.title;
      webix.message({ type: 'error', text: `Your role (${esc(currentUser().role)}) cannot open “${esc(title)}”.` });
    }
    const d = defaultRoute();
    navigate(d.name, d.param);
    return;
  }
  if (page.route === 'station') {
    const allowed = allowedStations();
    const st = param ? getStationBySlug(param) : null;
    if (!st || !allowed.includes(st.id)) {
      const fallback = getStation(currentUser().stationId) && allowed.includes(currentUser().stationId) ? getStation(currentUser().stationId) : getStation(allowed[0]);
      if (st && !allowed.includes(st.id)) webix.message({ type: 'error', text: `You are not assigned to ${esc(st.name)}.` });
      navigate('station', fallback.slug);
      return;
    }
  }

  unmountPage();
  const ctx = createCtx(param);
  let cfg;
  try {
    cfg = page.ui(ctx);
  } catch (err) {
    console.error(err);
    cfg = { template: `<div class="empty"><i class="mdi mdi-alert"></i><div class="empty-title">This screen failed to load</div><div class="empty-text">${esc(err.message)}</div></div>` };
  }
  const viewId = `page-${++seq}`;
  cfg = { ...cfg, id: viewId };
  // Remove the old page before building the new one: pages reuse fixed inner ids.
  const swapId = `page-swap-${seq}`;
  host.addView({ id: swapId, template: '' });
  if (current?.viewId && webix.$$(current.viewId)) host.removeView(current.viewId);
  try {
    host.addView(cfg);
  } catch (err) {
    console.error(err);
    host.addView({ id: viewId, template: `<div class="empty"><i class="mdi mdi-alert"></i><div class="empty-title">This screen failed to render</div><div class="empty-text">${esc(err.message)}</div></div>` });
  }
  host.removeView(swapId);
  current = { page, viewId, ctx };
  try {
    page.init?.(ctx, webix.$$(viewId));
  } catch (err) {
    console.error(err);
    webix.message({ type: 'error', text: `Screen error: ${esc(err.message)}` });
  }

  const title = typeof page.title === 'function' ? page.title(ctx) : page.title;
  const subtitle = typeof page.subtitle === 'function' ? page.subtitle(ctx) : page.subtitle;
  webix.$$('hdr-title')?.setValues({ title, subtitle });
  document.title = `${title} · PipeTrack`;

  const nav = webix.$$('nav');
  const navId = page.route === 'station' ? `station:${param}` : page.route;
  if (nav && nav.exists(navId)) {
    const parent = nav.getParentId(navId);
    if (parent && !nav.config.collapsed) nav.open(parent);
    nav.blockEvent();
    nav.select(navId);
    nav.unblockEvent();
  }
}

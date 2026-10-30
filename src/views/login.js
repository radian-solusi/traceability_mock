// Login screen (mock LDAP / Active Directory).
import webix from '../lib/webix.js';
import { db, getStation } from '../core/db.js';
import { login } from '../core/session.js';
import { esc } from '../core/format.js';
import { env } from '../config/env.js';

const DEMO = [
  { username: 'budi.santoso', desktop: 'OPS-SEA-01', label: 'Operator', who: 'Budi Santoso · SEA East display' },
  { username: 'andi.pratama', desktop: 'SUP-HT-01', label: 'Supervisor', who: 'Andi Pratama · HT line' },
  { username: 'maria.tan', desktop: 'SUP-HT-01', label: 'Admin', who: 'Maria Tan · application admin' },
  { username: 'dewi.lestari', desktop: 'QA-RPT-01', label: 'Reporting', who: 'Dewi Lestari · reports & data' },
];

let resizeHandler = null;

function brandPanel() {
  return `<div class="lb">
    <div class="lb-top">
      <div class="brand" style="padding:0"><span class="brand-mark"><i class="mdi mdi-pipe"></i></span><span><div class="brand-name">PipeTrack</div><div class="brand-sub">${esc(env.plant)}</div></span></div>
      <div class="lb-title">Every pipe, every station, <span>one record.</span></div>
      <div class="lb-text">Data Matrix identification at each process point of the HT finishing line: scanner reads through PLC and Kepware OPC (or directly when the PLC path fails), operator confirmation when a read fails, Good / NC results sent to CTMS through CT-Track.</div>
      <div class="lb-flow"><span>Limab</span><i class="mdi mdi-chevron-right"></i><span>SEA E/W</span><i class="mdi mdi-chevron-right"></i><span>EMI prove-up</span><i class="mdi mdi-chevron-right"></i><span>WMS</span><i class="mdi mdi-chevron-right"></i><span>Hydrotest</span><i class="mdi mdi-chevron-right"></i><span>PAUT</span><i class="mdi mdi-chevron-right"></i><span>Finish</span></div>
    </div>
    <div class="lb-foot"><span>Front-end mock · simulated data, no backend</span><span>v${esc(env.version)}</span></div>
  </div>`;
}

export function renderLogin({ onLogin }) {
  const desktops = db.desktops.map((d) => ({ id: d.host, value: `${d.host} · ${d.stationId ? getStation(d.stationId).name : d.use}` }));

  const submit = (sso = false) => {
    const form = webix.$$('login-form');
    const v = form.getValues();
    const err = webix.$$('login-error');
    try {
      login({ username: v.username, password: v.password, desktop: v.desktop, sso });
      onLogin();
    } catch (e) {
      err.setHTML(`<div class="lf-error"><i class="mdi mdi-alert-circle-outline"></i> ${esc(e.message)}</div>`);
      err.show();
    }
  };

  webix.ui({
    id: 'app-root',
    css: 'login-root',
    cols: [
      { view: 'template', id: 'login-brand', css: 'login-brand', borderless: true, template: brandPanel, gravity: 1.1, minWidth: 380 },
      {
        css: 'login-side',
        gravity: 1,
        rows: [
          {},
          {
            cols: [
              {},
              {
                view: 'form',
                id: 'login-form',
                css: 'login-form',
                width: 420,
                padding: 26,
                margin: 12,
                elements: [
                  { view: 'template', borderless: true, height: 64, template: `<div class="lf-head"><div class="lf-title">Sign in</div><div class="lf-sub">${esc(env.ldapDomain)} Active Directory account · the application never stores your password</div></div>` },
                  { view: 'text', name: 'username', id: 'login-user', label: 'Username', labelPosition: 'top', placeholder: `${env.ldapDomain}\\username` },
                  { view: 'text', name: 'password', type: 'password', label: 'Password', labelPosition: 'top', placeholder: 'Any password works in the mock' },
                  { view: 'richselect', name: 'desktop', label: 'Workstation', labelPosition: 'top', value: 'OPS-SEA-01', options: desktops, tooltip: 'Station display PCs are bound to a process point (Parameters → Servers & desktops)' },
                  { view: 'template', id: 'login-error', hidden: true, borderless: true, autoheight: true, template: '' },
                  {
                    cols: [
                      { view: 'button', value: 'Sign in', css: 'webix_primary btn-xl', height: 42, hotkey: 'enter', click: () => submit(false) },
                      { width: 10 },
                      { view: 'button', type: 'icon', icon: 'mdi mdi-microsoft-windows', label: 'Windows sign-in', css: 'btn-ghost', height: 42, width: 168, tooltip: 'Single sign-on with the Windows (Kerberos) account of this workstation', click: () => submit(true) },
                    ],
                  },
                  { view: 'template', borderless: true, height: 30, template: '<div class="lf-divider">Demo accounts · one click</div>' },
                  ...DEMO.map((d) => ({
                    view: 'button',
                    css: 'btn-ghost demo-acc',
                    height: 40,
                    label: `<b>${d.label}</b> · ${esc(d.who)}`,
                    click: () => {
                      webix.$$('login-form').setValues({ username: d.username, password: 'demo', desktop: d.desktop });
                      submit(false);
                    },
                  })),
                ],
              },
              {},
            ],
          },
          {},
        ],
      },
    ],
  });
  webix.$$('login-user')?.focus();
  resizeHandler = () => {
    const brand = webix.$$('login-brand');
    if (!brand) return;
    if (window.innerWidth < 860 && brand.isVisible()) brand.hide();
    else if (window.innerWidth >= 860 && !brand.isVisible()) brand.show();
  };
  window.addEventListener('resize', resizeHandler);
  resizeHandler();
}

export function destroyLogin() {
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  resizeHandler = null;
}

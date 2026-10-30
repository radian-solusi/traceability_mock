// App lifecycle: seed data, start the simulated plant, render login or shell.
import webix from './lib/webix.js';
import { seedDatabase } from './data/seed.js';
import { startEngines } from './core/simulator.js';
import { initTheme } from './core/theme.js';
import { restoreSession, currentUser } from './core/session.js';
import { startRouter, registerPages } from './core/router.js';
import { renderLogin, destroyLogin } from './views/login.js';
import { renderShell, showRoute, destroyShell } from './views/shell.js';
import { PAGES } from './views/index.js';
import { db } from './core/db.js';

function destroyRoot() {
  destroyLogin();
  destroyShell();
  const root = webix.$$('app-root');
  if (root) root.destructor();
}

function render() {
  destroyRoot();
  if (!currentUser()) {
    renderLogin({ onLogin: render });
    return;
  }
  renderShell();
  showRoute();
}

export function boot() {
  registerPages(PAGES);
  seedDatabase();
  startEngines();
  restoreSession();
  initTheme(render);
  startRouter(() => {
    if (!currentUser()) render();
    else if (webix.$$('page-host')) showRoute();
    else render();
  });
  if (import.meta.env.DEV) window.__ptct = { db, webix }; // debug handle for the browser console (dev server only)
  window.addEventListener('ptct:rerender', render);
  window.addEventListener('ptct:reseed', reseed);
  render();
}

/** Used by "Reset demo data". */
export function reseed() {
  seedDatabase();
  render();
}

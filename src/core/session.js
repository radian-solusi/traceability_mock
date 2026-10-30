// Mock LDAP / Active Directory login and role-based authorization.
// Real system: DTAS binds to AD (LDAPS), maps AD groups to roles and issues a JWT.
import { db, getUser } from './db.js';
import { audit } from './audit.js';
import { changed } from './bus.js';
import { env } from '../config/env.js';

const KEY = 'ptct.session';
let current = null;

const b64url = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function issueToken(user) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: 'dtas-mock' };
  const payload = { iss: 'ptct-dtas01', sub: user.username, name: user.name, role: user.role, groups: [user.adGroup], stations: user.stations, iat, exp: iat + 8 * 3600 };
  return `${b64url(header)}.${b64url(payload)}.mock-signature`;
}

function persist() {
  if (!env.persist) return;
  try {
    if (current) sessionStorage.setItem(KEY, JSON.stringify({ username: current.username, stationId: current.stationId, desktop: current.desktop, loginAt: current.loginAt, token: current.token }));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lasts until reload */
  }
}

export function restoreSession() {
  if (!env.persist) return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const u = getUser(s.username);
    if (u && u.status === 'ACTIVE') current = { ...u, stationId: s.stationId, desktop: s.desktop, loginAt: s.loginAt, token: s.token };
  } catch {
    current = null;
  }
  return current;
}

/**
 * FR-004: authenticate against Microsoft Active Directory (LDAP / Kerberos).
 * sso = Windows single sign-on: the Kerberos ticket of the user logged on to the workstation.
 * The application never stores the password.
 */
export function login({ username, password, desktop, sso = false }) {
  const desk = db.desktops.find((d) => d.host === desktop);
  let name = String(username || '')
    .trim()
    .replace(new RegExp(`^${env.ldapDomain}\\\\`, 'i'), '')
    .replace(/@ptct\.local$/i, '')
    .toLowerCase();
  if (sso) {
    if (!desk?.defaultUser) throw new Error(`No Windows user is signed in on ${desk?.host || 'this workstation'}. Sign in with your username and password.`);
    name = desk.defaultUser;
  }
  if (!name) throw new Error('Enter your Active Directory username.');
  const u = getUser(name);
  if (!u) throw new Error(`No Active Directory account “${name}” in the ${env.ldapDomain} domain. Check the spelling.`);
  if (!sso && !password) throw new Error('Enter your password.');
  if (u.status !== 'ACTIVE') throw new Error('This account is disabled in Active Directory. Ask the system administrator to enable it.');
  let stationId = desk?.stationId || u.defaultStation || null;
  if (stationId && !u.stations.includes('*') && !u.stations.includes(stationId)) stationId = u.defaultStation || u.stations[0] || null;
  current = { ...u, stationId, desktop: desk?.host || null, loginAt: Date.now(), token: issueToken(u), method: sso ? 'Kerberos SSO' : 'LDAP bind' };
  u.lastLogin = current.loginAt;
  persist();
  audit(current, 'Auth', 'Login', `${current.method} OK · ${u.adGroup} → ${u.role}${desk ? ` · ${desk.host}` : ''}`, { category: 'Login' });
  return current;
}

export function logout() {
  if (current) audit(current, 'Auth', 'Logout', 'User signed out', { category: 'Logout' });
  current = null;
  persist();
}

export const currentUser = () => current;

export function can(moduleKey, level = 'view') {
  if (!current) return false;
  const p = db.permissions[moduleKey]?.[current.role] || 'none';
  return level === 'edit' ? p === 'edit' : p === 'edit' || p === 'view';
}

export function allowedStations(user = current) {
  if (!user || !can('station')) return [];
  if (user.stations.includes('*')) return db.stations.filter((s) => s.active !== false).map((s) => s.id);
  return user.stations.filter((id) => db.stations.some((s) => s.id === id && s.active !== false));
}

export function setSessionStation(stationId) {
  if (!current) return;
  current.stationId = stationId;
  persist();
  changed('session', { stationId });
}

// In-memory "database" for the mock.
// It mirrors what the real DTAS would keep in PostgreSQL 18
// (users, wo, records, logs + configuration + integration state). Nothing is persisted:
// reloading the page or pressing "Reset demo data" re-seeds it.

function createEmpty() {
  return {
    // configuration (Parameter module)
    lines: [],
    stations: [],
    routes: [],
    defects: {},
    cameras: [],
    plcs: [],
    concentrators: [],
    tags: [],
    servers: [],
    desktops: [],
    integrations: {},
    systemParams: {},
    alarmRules: [],
    // security (User Access & Authorization module)
    users: [],
    roles: [],
    permissions: {},
    adGroups: [],
    // operational data
    workOrders: [],
    upcoming: [],
    pipes: [],
    events: [], // raw sensor / OPC / camera / operator events
    transactions: [], // movement records ("records" table)
    dmcBatches: [],
    dmcExceptions: [],
    audit: [], // "logs" table (FR-015 audit trail)
    notifications: [],
    alarms: [], // FR-014 alarm & monitoring
    ctmsRecords: {}, // what CTMS holds per pipe (for reconciliation)
    recon: null, // last reconciliation result
    runtime: {}, // per station: reading path, PLC link, app link, buffered reads, read-failure streak
    // simulator + demo settings
    settings: {
      autoSim: false,
      simIntervalMs: 3000,
      readErrorRate: 0.08,
      ctmsFailRate: 0.05,
      ctmsOutage: false,
      virtualOperators: true,
      cameraOffline: {},
      theme: 'auto',
    },
    counters: {},
    seededAt: null,
  };
}

export const db = createEmpty();

export const idx = {
  station: new Map(),
  slug: new Map(),
  route: new Map(),
  wo: new Map(),
  pipe: new Map(),
  dmc: new Map(),
  event: new Map(),
  tx: new Map(),
  user: new Map(),
  camera: new Map(),
};

export function resetDb() {
  const fresh = createEmpty();
  for (const key of Object.keys(db)) delete db[key];
  Object.assign(db, fresh);
  for (const map of Object.values(idx)) map.clear();
}

export function nextId(prefix, width = 6) {
  const n = (db.counters[prefix] = (db.counters[prefix] || 0) + 1);
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

export function reindex() {
  for (const map of Object.values(idx)) map.clear();
  db.stations.forEach((s) => {
    idx.station.set(s.id, s);
    idx.slug.set(s.slug, s);
  });
  db.routes.forEach((r) => idx.route.set(r.id, r));
  db.workOrders.forEach((w) => idx.wo.set(w.id, w));
  db.pipes.forEach((p) => {
    idx.pipe.set(p.id, p);
    idx.dmc.set(p.dmc, p);
  });
  db.events.forEach((e) => idx.event.set(e.id, e));
  db.transactions.forEach((t) => idx.tx.set(t.id, t));
  db.users.forEach((u) => idx.user.set(u.username, u));
  db.cameras.forEach((c) => idx.camera.set(c.id, c));
}

export const addWorkOrder = (w) => {
  db.workOrders.push(w);
  idx.wo.set(w.id, w);
  return w;
};
export const addPipe = (p) => {
  db.pipes.push(p);
  idx.pipe.set(p.id, p);
  idx.dmc.set(p.dmc, p);
  return p;
};
export const addEvent = (e) => {
  db.events.push(e);
  idx.event.set(e.id, e);
  return e;
};
export const addTx = (t) => {
  db.transactions.push(t);
  idx.tx.set(t.id, t);
  return t;
};

export const getStation = (id) => idx.station.get(id);
export const getStationBySlug = (slug) => idx.slug.get(slug);
export const getRoute = (id) => idx.route.get(id);
export const getWo = (id) => idx.wo.get(id);
export const getPipe = (id) => idx.pipe.get(id);
export const getPipeByDmc = (code) => idx.dmc.get(code);
export const getEvent = (id) => idx.event.get(id);
export const getTx = (id) => idx.tx.get(id);
export const getUser = (username) => idx.user.get(username);
export const getCamera = (id) => idx.camera.get(id);
export const cameraOfStation = (stationId) => db.cameras.find((c) => c.stationId === stationId) || null;

export const stationName = (id) => getStation(id)?.name ?? id ?? '–';
export const stationCode = (id) => getStation(id)?.code ?? id ?? '–';
export const activeStations = () => db.stations.filter((s) => s.active !== false).sort((a, b) => a.order - b.order);

/** Runtime state of a station (reading path, link faults, buffered reads). */
export function runtimeOf(stationId) {
  if (!db.runtime[stationId]) db.runtime[stationId] = { plcDown: false, appLinkDown: false, buffer: [], readPath: 'OPT1', failStreak: 0, mode: 'AUTO' };
  return db.runtime[stationId];
}

// Page registry. Each page: { route, title, subtitle, perm, nav, ui(ctx), init(ctx, view), destroy(ctx) }
// perm = module key in the permission matrix (User access → Roles & permissions).
import operations from './dashboard/operations.js';
import supervisor from './dashboard/supervisor.js';
import plantLayout from './dashboard/plantLayout.js';
import alarms from './alarms.js';
import station from './station/terminal.js';
import workOrders from './workOrders.js';
import trace from './trace.js';
import reports from './reports.js';
import apiSync from './integration/apiSync.js';
import opc from './integration/opc.js';
import readers from './integration/readers.js';
import paramStations from './parameters/stations.js';
import paramRoutes from './parameters/routes.js';
import paramTags from './parameters/tags.js';
import paramInfra from './parameters/infra.js';
import paramSystem from './parameters/system.js';
import users from './users.js';
import audit from './audit.js';
import guide from './guide.js';

export const PAGES = [
  operations,
  supervisor,
  plantLayout,
  alarms,
  station,
  workOrders,
  trace,
  reports,
  apiSync,
  opc,
  readers,
  paramStations,
  paramRoutes,
  paramTags,
  paramInfra,
  paramSystem,
  users,
  audit,
  guide,
];

// Master / configuration data for the mock.
// Sources (newest first):
//   • Functional and Non Functional Requirement (FR-001 … FR-016, NFR, station and tag tables)
//   • Traceability System Requirement Rev 1 (UC-001 … UC-005, actors, operational requirements)
//   • Traceability Application 7061 (scope of work, core modules, PLC/camera table, topology)
//   • RFQ and the VDIS deck
// Anything not stated in those documents is an assumption, listed in docs/ASSUMPTIONS.md.

export const STATUS = ['GOOD', 'NC', 'REJECT', 'PENDING'];

// ---------------------------------------------------------------------------
// Production lines (Rev 1 operational requirement 9: multiple lines through configuration)
// ---------------------------------------------------------------------------
export const LINES = [
  { id: 'HT', name: 'HT finishing line', description: 'Heat treatment · HT Cold: Limab stencil marking to PAUT', status: 'ACTIVE', routeId: 'HT-FIN' },
  { id: 'THR', name: 'Threading line', description: 'Planned: tracking across threading (7061 objectives). No process points configured yet.', status: 'PLANNED', routeId: null },
];

// ---------------------------------------------------------------------------
// Stations / process points. Codes HT-01 … HT-07 come from the FR station table.
// idMode: how the pipe is identified per movement
//   DMC       identity from the DMC API (robot marking at Limab)
//   SEQUENCE  Limab out sensor + DMC sequence (FR-003: "pipe unique number record from PLC sensor trigger")
//   CAMERA    Keyence scanner: option 1 through PLC → Kepware OPC, option 2 direct from the application (FR-001)
//   OPERATOR  operator selects or enters the pipe identity (UC-003 4b)
// resultOptions: Good / NC at production points (Rev 1 §1.1); Limab status flag adds Reject and Pending (FR-005)
// sensors: tag names; scanner zone W/M/E from the FR tag table (mapping to stations is assumption B11)
// ---------------------------------------------------------------------------
export const STATIONS = [
  {
    id: 'LIMAB',
    slug: 'limab',
    code: 'HT-LM',
    name: 'Limab',
    fullName: 'Limab · robotic stencil / DMC marking',
    area: 'Limab',
    lineId: 'HT',
    process: 'Stencil marking robot · DMC data starts here',
    processType: 'MARKING',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC', 'REJECT', 'PENDING'],
    resultLabel: 'Pipe status flag',
    idMode: { IN: 'DMC', OUT: 'SEQUENCE' },
    cameraId: null,
    plcId: null,
    concentratorId: null,
    sensors: { left: 'HT-LM-LFT-01', right: 'HT-LM-OUT-01' },
    zone: 'LM',
    dashboard: true,
    order: 1,
    active: true,
    cycleMin: [3, 8],
  },
  {
    id: 'SEA_E',
    slug: 'sea-east',
    code: 'HT-01',
    name: 'SEA East',
    fullName: 'SEA East · Coil 1',
    area: 'SEA COIL1',
    lineId: 'HT',
    process: 'SEA inspection (EMI coil)',
    processType: 'EMI',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'SEA inspection result',
    idMode: { IN: 'CAMERA', OUT: 'CAMERA' },
    cameraId: 'HT-W1-SCN-01',
    plcId: 'PLC-SEA-C1',
    concentratorId: 'CONC-SEA',
    sensors: { entry: 'HT-W1-IN-01', exit: 'HT-W1-OUT-01' },
    zone: 'W1',
    dashboard: true,
    order: 2,
    active: true,
    cycleMin: [6, 9],
  },
  {
    id: 'SEA_W',
    slug: 'sea-west',
    code: 'HT-02',
    name: 'SEA West',
    fullName: 'SEA West · Coil 3',
    area: 'SEA COIL3',
    lineId: 'HT',
    process: 'SEA inspection (EMI coil)',
    processType: 'EMI',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'SEA inspection result',
    idMode: { IN: 'CAMERA', OUT: 'CAMERA' },
    cameraId: 'HT-W2-SCN-01',
    plcId: 'PLC-SEA-C3',
    concentratorId: 'CONC-SEA',
    sensors: { entry: 'HT-W2-IN-01', exit: 'HT-W2-OUT-01' },
    zone: 'W2',
    dashboard: true,
    order: 3,
    active: true,
    cycleMin: [6, 9],
  },
  {
    id: 'EMI',
    slug: 'emi-proveup',
    code: 'HT-03',
    name: 'EMI Prove-up',
    fullName: 'EMI Prove-up · manual verification',
    area: 'EMI Prove-up',
    lineId: 'HT',
    process: 'Prove-up of SEA/EMI indications',
    processType: 'PROVEUP',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'Prove-up result',
    idMode: { IN: 'OPERATOR', OUT: 'OPERATOR' },
    cameraId: null,
    plcId: null,
    concentratorId: null,
    sensors: {},
    zone: null,
    dashboard: true,
    order: 4,
    active: true,
    cycleMin: [10, 18],
  },
  {
    id: 'WMS',
    slug: 'wms',
    code: 'HT-04',
    name: 'WMS',
    fullName: 'WMS',
    area: 'WMS',
    lineId: 'HT',
    process: 'WMS station',
    processType: 'MEASURE',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'WMS result',
    idMode: { IN: 'CAMERA', OUT: 'CAMERA' },
    cameraId: 'HT-M1-SCN-01',
    plcId: 'PLC-WMS',
    concentratorId: 'PLC-WMS',
    sensors: { entry: 'HT-M1-IN-01', exit: 'HT-M1-OUT-01' },
    zone: 'M1',
    dashboard: true,
    order: 5,
    active: true,
    cycleMin: [3, 5],
  },
  {
    id: 'HYD_Y',
    slug: 'hydro-yamasui',
    code: 'HT-05',
    name: 'Hydrotest Yamasui',
    fullName: 'Hydrotest Yamasui',
    area: 'Hydrotest Yamasui',
    lineId: 'HT',
    process: 'Hydrostatic test',
    processType: 'HYDRO',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'Hydrotest result',
    idMode: { IN: 'CAMERA', OUT: 'CAMERA' },
    cameraId: 'HT-M2-SCN-01',
    plcId: 'PLC-HYD-Y',
    concentratorId: 'CONC-HYD-Y',
    sensors: { entry: 'HT-M2-IN-01', exit: 'HT-M2-OUT-01' },
    zone: 'M2',
    dashboard: true,
    order: 6,
    active: true,
    cycleMin: [8, 12],
  },
  {
    id: 'HYD_B',
    slug: 'hydro-brandt',
    code: 'HT-06',
    name: 'Hydrotest Brandt',
    fullName: 'Hydrotest Brandt',
    area: 'Hydrotest Brandt',
    lineId: 'HT',
    process: 'Hydrostatic test',
    processType: 'HYDRO',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'Hydrotest result',
    idMode: { IN: 'CAMERA', OUT: 'CAMERA' },
    cameraId: 'HT-E1-SCN-01',
    plcId: 'PLC-HYD-B',
    concentratorId: 'CONC-HYD-B',
    sensors: { entry: 'HT-E1-IN-01', exit: 'HT-E1-OUT-01' },
    zone: 'E1',
    dashboard: true,
    order: 7,
    active: true,
    cycleMin: [8, 12],
  },
  {
    id: 'PAUT',
    slug: 'paut',
    code: 'HT-07',
    name: 'PAUT',
    fullName: 'PAUT · phased-array UT',
    area: 'PAUT',
    lineId: 'HT',
    process: 'Phased-array ultrasonic testing',
    processType: 'UT',
    inspection: 'OUT',
    resultOptions: ['GOOD', 'NC'],
    resultLabel: 'PAUT result',
    idMode: { IN: 'CAMERA', OUT: 'CAMERA' },
    cameraId: 'HT-E2-SCN-01',
    plcId: 'PLC-PAUT',
    concentratorId: 'CONC-PAUT',
    sensors: { entry: 'HT-E2-IN-01', exit: 'HT-E2-OUT-01' },
    zone: 'E2',
    dashboard: true,
    order: 8,
    active: true,
    cycleMin: [4, 6],
  },
];

// ---------------------------------------------------------------------------
// Process route of the HT line. A step lists alternative stations; when: 'PREV_NC' = only after an NC.
// ---------------------------------------------------------------------------
export const ROUTES = [
  {
    id: 'HT-FIN',
    lineId: 'HT',
    name: 'HT finishing line',
    description: 'Limab marking → SEA East/West → EMI prove-up (only if NC) → WMS → Hydrotest Yamasui/Brandt → PAUT → Finish HT Cold',
    finishLabel: 'Finish HT Cold',
    steps: [
      { stations: ['LIMAB'], label: 'Limab marking', waitMin: [0, 0] },
      { stations: ['SEA_E', 'SEA_W'], label: 'SEA inspection', waitMin: [10, 40] },
      { stations: ['EMI'], label: 'EMI prove-up', when: 'PREV_NC', waitMin: [5, 20] },
      { stations: ['WMS'], label: 'WMS', waitMin: [15, 45] },
      { stations: ['HYD_Y', 'HYD_B'], label: 'Hydrotest', waitMin: [30, 80] },
      { stations: ['PAUT'], label: 'PAUT', waitMin: [20, 60] },
    ],
  },
];

// Physical marking made by the operator at Limab (FR-005). Dashboard colours follow the deck legend.
export const STATUS_MARKING = {
  GOOD: 'No colour line',
  NC: 'Yellow line',
  REJECT: 'Red line',
  PENDING: 'Grey / blue line',
};

// Defect / reason codes per process type (placeholders, assumption C3)
export const DEFECTS = {
  MARKING: [
    { id: 'MK01', value: 'MK01 · DMC print unreadable' },
    { id: 'MK02', value: 'MK02 · Stencil misaligned' },
    { id: 'VI01', value: 'VI01 · Visual surface defect' },
    { id: 'DM01', value: 'DM01 · Dimension out of tolerance' },
  ],
  EMI: [
    { id: 'EM01', value: 'EM01 · Longitudinal indication' },
    { id: 'EM02', value: 'EM02 · Transverse indication' },
    { id: 'EM03', value: 'EM03 · Wall thickness deviation' },
    { id: 'EM04', value: 'EM04 · Grade / hardness mismatch' },
  ],
  PROVEUP: [
    { id: 'PU01', value: 'PU01 · Indication confirmed (crack)' },
    { id: 'PU02', value: 'PU02 · Indication confirmed (lamination)' },
    { id: 'PU03', value: 'PU03 · Grind-out below minimum wall' },
    { id: 'PU04', value: 'PU04 · Indication not cleared' },
  ],
  MEASURE: [
    { id: 'WM01', value: 'WM01 · Length out of tolerance' },
    { id: 'WM02', value: 'WM02 · Weight out of tolerance' },
  ],
  HYDRO: [
    { id: 'HY01', value: 'HY01 · Leak at pipe body' },
    { id: 'HY02', value: 'HY02 · Leak at end / seal' },
    { id: 'HY03', value: 'HY03 · Test pressure not reached' },
    { id: 'HY04', value: 'HY04 · Hold time not met' },
  ],
  UT: [
    { id: 'UT01', value: 'UT01 · Lamination' },
    { id: 'UT02', value: 'UT02 · Longitudinal flaw' },
    { id: 'UT03', value: 'UT03 · Transverse flaw' },
    { id: 'UT04', value: 'UT04 · Coupling loss, re-scan needed' },
  ],
};

// ---------------------------------------------------------------------------
// Users (mirror Active Directory accounts; names are fictional). Roles from Rev 1 actors.
// ---------------------------------------------------------------------------
export const USERS = [
  { username: 'maria.tan', name: 'Maria Tan', role: 'Admin', adGroup: 'PTCT-TRC-Admins', title: 'OT/IT application administrator', department: 'IT / OT', stations: ['*'], status: 'ACTIVE' },
  { username: 'andi.pratama', name: 'Andi Pratama', role: 'Supervisor', adGroup: 'PTCT-TRC-Supervisors', title: 'Production supervisor · HT line', department: 'Production HT', stations: ['*'], status: 'ACTIVE' },
  { username: 'hendra.gunawan', name: 'Hendra Gunawan', role: 'Supervisor', adGroup: 'PTCT-TRC-Supervisors', title: 'QC supervisor', department: 'Quality', stations: ['*'], status: 'ACTIVE' },
  { username: 'dewi.lestari', name: 'Dewi Lestari', role: 'Reporting', adGroup: 'PTCT-TRC-Reporting', title: 'QA data analyst', department: 'Quality', stations: [], status: 'ACTIVE' },
  { username: 'budi.santoso', name: 'Budi Santoso', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · SEA / EMI', department: 'Production HT', stations: ['SEA_E', 'SEA_W', 'EMI'], defaultStation: 'SEA_E', status: 'ACTIVE' },
  { username: 'siti.aminah', name: 'Siti Aminah', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · Limab', department: 'Production HT', stations: ['LIMAB'], defaultStation: 'LIMAB', status: 'ACTIVE' },
  { username: 'yusuf.maulana', name: 'Yusuf Maulana', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · EMI prove-up', department: 'Production HT', stations: ['EMI', 'SEA_E', 'SEA_W'], defaultStation: 'EMI', status: 'ACTIVE' },
  { username: 'eko.prasetyo', name: 'Eko Prasetyo', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · WMS', department: 'Production HT', stations: ['WMS', 'HYD_Y', 'HYD_B'], defaultStation: 'WMS', status: 'ACTIVE' },
  { username: 'fajar.nugroho', name: 'Fajar Nugroho', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · Hydrotest', department: 'Production HT', stations: ['HYD_Y', 'HYD_B'], defaultStation: 'HYD_Y', status: 'ACTIVE' },
  { username: 'rina.wulandari', name: 'Rina Wulandari', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · PAUT', department: 'Production HT', stations: ['PAUT'], defaultStation: 'PAUT', status: 'ACTIVE' },
  { username: 'agus.setiawan', name: 'Agus Setiawan', role: 'Operator', adGroup: 'PTCT-TRC-Operators', title: 'Operator · Limab (transferred)', department: 'Production HT', stations: ['LIMAB'], defaultStation: 'LIMAB', status: 'DISABLED' },
];

export const ROLES = [
  { id: 'Admin', name: 'Administrator', description: 'Configures production lines, process points, processes, users and system parameters.' },
  { id: 'Supervisor', name: 'Supervisor', description: 'Monitors production and exceptions: alarms, held pipes, CTMS status, corrections.' },
  { id: 'Operator', name: 'Operator', description: 'Reviews suggested pipes when automatic identification fails, confirms or enters the identity, enters inspection results.' },
  { id: 'Reporting', name: 'Reporting user', description: 'Views reports and dashboards and extracts data.' },
];

export const AD_GROUPS = [
  { group: 'PTCT-TRC-Admins', role: 'Admin', dn: 'CN=PTCT-TRC-Admins,OU=Traceability,OU=Groups,DC=ptct,DC=local' },
  { group: 'PTCT-TRC-Supervisors', role: 'Supervisor', dn: 'CN=PTCT-TRC-Supervisors,OU=Traceability,OU=Groups,DC=ptct,DC=local' },
  { group: 'PTCT-TRC-Operators', role: 'Operator', dn: 'CN=PTCT-TRC-Operators,OU=Traceability,OU=Groups,DC=ptct,DC=local' },
  { group: 'PTCT-TRC-Reporting', role: 'Reporting', dn: 'CN=PTCT-TRC-Reporting,OU=Traceability,OU=Groups,DC=ptct,DC=local' },
];

// Module permissions: edit | view | none
export const MODULES = [
  { key: 'dashboard', name: 'Dashboard (operations, plant layout)', Admin: 'edit', Supervisor: 'view', Operator: 'view', Reporting: 'view' },
  { key: 'supervisor', name: 'Dashboard (supervisor view, decisions, corrections)', Admin: 'edit', Supervisor: 'edit', Operator: 'none', Reporting: 'view' },
  { key: 'station', name: 'Station display (identification, movement, inspection, autofocus)', Admin: 'edit', Supervisor: 'edit', Operator: 'edit', Reporting: 'none' },
  { key: 'alarms', name: 'Alarms & exceptions', Admin: 'edit', Supervisor: 'edit', Operator: 'view', Reporting: 'view' },
  { key: 'workorders', name: 'Work order & pipe information', Admin: 'edit', Supervisor: 'view', Operator: 'view', Reporting: 'view' },
  { key: 'trace', name: 'Traceability history (pipe trace)', Admin: 'view', Supervisor: 'view', Operator: 'view', Reporting: 'view' },
  { key: 'reports', name: 'Reports & data extraction', Admin: 'view', Supervisor: 'view', Operator: 'none', Reporting: 'view' },
  { key: 'apisync', name: 'API synchronization (DMC, CT-Track / CTMS, reconciliation)', Admin: 'edit', Supervisor: 'edit', Operator: 'none', Reporting: 'none' },
  { key: 'opc', name: 'OPC Kepware', Admin: 'edit', Supervisor: 'view', Operator: 'none', Reporting: 'none' },
  { key: 'readers', name: 'Keyence autofocus DMC reader', Admin: 'edit', Supervisor: 'view', Operator: 'none', Reporting: 'none' },
  { key: 'parameters', name: 'Parameters (lines, stations, routes, tags, servers & desktops, system)', Admin: 'edit', Supervisor: 'none', Operator: 'none', Reporting: 'none' },
  { key: 'users', name: 'User access & authorization', Admin: 'edit', Supervisor: 'none', Operator: 'none', Reporting: 'none' },
  { key: 'audit', name: 'Audit trail', Admin: 'view', Supervisor: 'view', Operator: 'none', Reporting: 'none' },
  { key: 'guide', name: 'Demo guide & simulator', Admin: 'edit', Supervisor: 'edit', Operator: 'edit', Reporting: 'none' },
];

// ---------------------------------------------------------------------------
// Devices (deck "PLC Device and DMC Reader" / 7061 Fig. 8) and scanners (FR tag table)
// ---------------------------------------------------------------------------
export const PLCS = [
  { id: 'PLC-SEA-C1', area: 'SEA COIL1', brand: 'Schneider', model: 'Twido TWDLCAE40DRF', concentratorId: 'CONC-SEA', remark: '' },
  { id: 'PLC-SEA-C3', area: 'SEA COIL3', brand: 'Schneider', model: 'Twido TWDLCAE40DRF', concentratorId: 'CONC-SEA', remark: 'Uses SEA COIL1 concentrator' },
  { id: 'PLC-HYD-Y', area: 'Hydrotest Yamasui', brand: 'Allen-Bradley', model: 'SLC 500 (1747-L553)', concentratorId: 'CONC-HYD-Y', remark: '' },
  { id: 'PLC-HYD-B', area: 'Hydrotest Brandt', brand: 'Allen-Bradley', model: 'ControlLogix 5561 (1756-L61B)', concentratorId: 'CONC-HYD-B', remark: '' },
  { id: 'PLC-WMS', area: 'WMS', brand: 'Allen-Bradley', model: 'CompactLogix 5000 (1769-L36ERM)', concentratorId: 'PLC-WMS', remark: 'Acts as its own concentrator' },
  { id: 'PLC-PAUT', area: 'PAUT', brand: 'Schneider', model: 'Modicon M340 (BMXP342020)', concentratorId: 'CONC-PAUT', remark: 'Programmed in Unity Pro XL' },
];

export const CONCENTRATORS = [
  { id: 'CONC-SEA', model: 'Siemens S7-1200', host: 'plc-conc-sea', channel: 'Siemens_TCPIP', device: 'SEA_CONC', stations: ['SEA_E', 'SEA_W'], status: 'ONLINE' },
  { id: 'CONC-HYD-Y', model: 'Siemens S7-1200', host: 'plc-conc-hydy', channel: 'Siemens_TCPIP', device: 'HYDY_CONC', stations: ['HYD_Y'], status: 'ONLINE' },
  { id: 'CONC-HYD-B', model: 'Siemens S7-1200', host: 'plc-conc-hydb', channel: 'Siemens_TCPIP', device: 'HYDB_CONC', stations: ['HYD_B'], status: 'ONLINE' },
  { id: 'CONC-PAUT', model: 'Siemens S7-1200', host: 'plc-conc-paut', channel: 'Siemens_TCPIP', device: 'PAUT_CONC', stations: ['PAUT'], status: 'ONLINE' },
  { id: 'PLC-WMS', model: 'Allen-Bradley CompactLogix 1769-L36ERM', host: 'plc-wms', channel: 'AB_ControlLogix', device: 'WMS_CLX', stations: ['WMS'], status: 'ONLINE' },
];

// Scanner tag names and descriptions from the FR tag table. Station assignment = assumption B11.
export const CAMERAS = [
  { id: 'HT-W1-SCN-01', name: 'Scanner West 1', camera: 'Keyence Camera 1', zone: 'West', model: 'SR-2000W', stationId: 'SEA_E', host: 'scn-w1', firmware: '3.12', focusMm: 410, status: 'ONLINE' },
  { id: 'HT-W2-SCN-01', name: 'Scanner West 2', camera: 'Keyence Camera 2', zone: 'West', model: 'SR-2000W', stationId: 'SEA_W', host: 'scn-w2', firmware: '3.12', focusMm: 395, status: 'ONLINE' },
  { id: 'HT-M1-SCN-01', name: 'Scanner Middle 1', camera: 'Keyence Camera 1', zone: 'Middle', model: 'SR-2000W', stationId: 'WMS', host: 'scn-m1', firmware: '3.12', focusMm: 520, status: 'ONLINE' },
  { id: 'HT-M2-SCN-01', name: 'Scanner Middle 2', camera: 'Keyence Camera 2', zone: 'Middle', model: 'SR-2000W', stationId: 'HYD_Y', host: 'scn-m2', firmware: '3.10', focusMm: 460, status: 'ONLINE' },
  { id: 'HT-E1-SCN-01', name: 'Scanner East 1', camera: 'Keyence Camera 1', zone: 'East', model: 'SR-2000W', stationId: 'HYD_B', host: 'scn-e1', firmware: '3.10', focusMm: 455, status: 'ONLINE' },
  { id: 'HT-E2-SCN-01', name: 'Scanner East 2', camera: 'Keyence Camera 2', zone: 'East', model: 'SR-2000W', stationId: 'PAUT', host: 'scn-e2', firmware: '3.12', focusMm: 380, status: 'ONLINE' },
  { id: 'SPARE-SCN-01', name: 'Spare reader', camera: 'Keyence handheld', zone: '–', model: 'SR-X300W', stationId: null, host: 'scn-spare', firmware: '1.40', focusMm: 300, status: 'STANDBY', note: 'Spare SR-X300W from the deck device list' },
];

// Servers (numbers refer to the topology diagram)
export const SERVERS = [
  { id: 'DTAS', no: 5, name: 'Dashboard Traceability Application Server (DTAS)', host: 'ptct-dtas01', network: 'Intranet', os: 'Ubuntu Server', stack: 'Apache 2.4 · PHP (CodeIgniter) or Go · PostgreSQL 18', ports: '443 HTTPS · 3000 REST API', status: 'ONLINE' },
  { id: 'OPC', no: 4, name: 'OPC server (Kepware) + PostgreSQL', host: 'ptct-opc01', network: 'OT', os: 'Windows Server (VM)', stack: 'Kepware KEPServerEX · PostgreSQL', ports: '4840 OPC UA', status: 'ONLINE' },
  { id: 'CTTRACK', no: 3, name: 'CT-Track · L1 JSON API server (provided by PTCT)', host: 'ptct-cttrack01', network: 'OT / L1', stack: 'REST JSON API · JWT · only route to the IT layer (CTMS)', os: 'Linux', ports: '443 HTTPS', status: 'ONLINE' },
  { id: 'DMC', no: null, name: 'DMC database & API (Limab robot)', host: 'ptct-dmc01', network: 'OT', os: '–', stack: 'DMC DB · REST API', ports: '443 HTTPS', status: 'ONLINE' },
  { id: 'LDAP', no: 7, name: 'Active Directory (LDAP / Kerberos)', host: 'ptct-dc01', network: 'Intranet', os: 'Windows Server (VM)', stack: 'AD DS · LDAPS · Kerberos SSO', ports: '636 LDAPS · 88 Kerberos', status: 'ONLINE' },
  { id: 'CTMS', no: 9, name: 'CTMS (MES / L3) · reached only through CT-Track', host: 'ctms-app01', network: 'IT', os: 'Ubuntu', stack: 'CTMS', ports: '–', status: 'ONLINE' },
];

export const DESKTOPS = [
  { host: 'OPS-LIMAB-01', stationId: 'LIMAB', use: 'Station display', defaultUser: 'siti.aminah', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-SEA-01', stationId: 'SEA_E', use: 'Station display', defaultUser: 'budi.santoso', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-SEA-02', stationId: 'SEA_W', use: 'Station display', defaultUser: 'budi.santoso', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-EMI-01', stationId: 'EMI', use: 'Station display', defaultUser: 'yusuf.maulana', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-WMS-01', stationId: 'WMS', use: 'Station display', defaultUser: 'eko.prasetyo', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-HYD-01', stationId: 'HYD_Y', use: 'Station display', defaultUser: 'fajar.nugroho', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-HYD-02', stationId: 'HYD_B', use: 'Station display', defaultUser: 'fajar.nugroho', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'OPS-PAUT-01', stationId: 'PAUT', use: 'Station display', defaultUser: 'rina.wulandari', os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '24" touch', status: 'ONLINE' },
  { host: 'SUP-HT-01', stationId: null, use: 'Supervisor office', defaultUser: 'andi.pratama', os: 'Windows 11', browser: 'Microsoft Edge', screen: '2 × 27"', status: 'ONLINE' },
  { host: 'QA-RPT-01', stationId: null, use: 'Reporting / QA office', defaultUser: 'dewi.lestari', os: 'Windows 11', browser: 'Microsoft Edge', screen: '27"', status: 'ONLINE' },
  { host: 'DASH-HT-WALL', stationId: null, use: 'Wall display (plant layout)', defaultUser: null, os: 'Windows 11', browser: 'Microsoft Edge (kiosk)', screen: '55" TV', status: 'ONLINE' },
];

// External interfaces. CTMS is never called directly: everything to the IT layer goes through CT-Track (FR-010).
export const INTEGRATIONS = {
  DMC: { key: 'DMC', name: 'DMC API', direction: 'Inbound', purpose: 'DMC unique number from the Limab stencil robot (UC-001, FR-005)', protocol: 'REST · HTTPS 443 · JWT', host: 'ptct-dmc01', status: 'ONLINE' },
  OPC: { key: 'OPC', name: 'OPC UA · Kepware', direction: 'Inbound · option 1', purpose: 'PLC sensor and Keyence read signals, main reading path (FR-001)', protocol: 'OPC UA 4840 · Basic256Sha256 · LDAP user', host: 'ptct-opc01', status: 'ONLINE' },
  KEYENCE: { key: 'KEYENCE', name: 'Keyence direct (SDK)', direction: 'Inbound · option 2', purpose: 'Direct camera reading when the PLC path fails; autofocus and alignment (FR-001)', protocol: 'Keyence SDK / TCP', host: 'scanners HT-*-SCN-01', status: 'ONLINE' },
  CTTRACK: { key: 'CTTRACK', name: 'CT-Track → CTMS', direction: 'In / out', purpose: 'Only route to the IT layer: pipe data from CTMS, movements, status flags and results to CTMS (FR-008, FR-010)', protocol: 'REST JSON · HTTPS 443 · JWT', host: 'ptct-cttrack01', status: 'ONLINE' },
  LDAP: { key: 'LDAP', name: 'Active Directory', direction: 'Auth', purpose: 'Login, SSO and role groups; no password stored (FR-004)', protocol: 'LDAPS 636 · Kerberos', host: 'ptct-dc01', status: 'ONLINE' },
};

// System parameters (Administrator, Rev 1). Values = NFR targets or assumptions.
export const SYSTEM_PARAMS = {
  apiTimeoutS: 10,
  retryBackoffS: [10, 30, 60],
  maxAutoRetries: 3,
  dashboardTargetS: 3,
  uptimeTarget: '99.5 %',
  retentionYears: 5,
  backupTime: '02:00',
  backupEnabled: true,
  cameraStoreForward: true,
  fullSyncEveryMin: 60,
  readMode: 'AUTO',
};

// Alarm criteria (FR-014: "alert criteria will be defined with the process owner" → placeholders)
export const ALARM_RULES = [
  { code: 'SCANNER_OFFLINE', name: 'Scanner offline', severity: 'critical', threshold: null, unit: '', enabled: true, description: 'Keyence scanner does not answer on either reading path.' },
  { code: 'OPTION2_ACTIVE', name: 'Reading switched to option 2', severity: 'warning', threshold: null, unit: '', enabled: true, description: 'PLC / OPC path not available; the application reads the camera directly (FR-001).' },
  { code: 'READ_FAIL_STREAK', name: 'Consecutive DMC read failures', severity: 'warning', threshold: 3, unit: 'reads', enabled: true, description: 'Same station, consecutive failed or unknown reads.' },
  { code: 'DMC_NOT_FOUND', name: 'DMC not found in CTMS / master data', severity: 'warning', threshold: null, unit: '', enabled: true, description: 'FR-006 exception. Operator resolves the identity (UC-003).' },
  { code: 'DUPLICATE_DMC', name: 'Duplicate DMC', severity: 'warning', threshold: null, unit: '', enabled: true, description: 'FR-006 exception: DMC already registered or already recorded at another station.' },
  { code: 'CTMS_NO_RESPONSE', name: 'CTMS not responding (via CT-Track)', severity: 'critical', threshold: 1, unit: 'failed submissions', enabled: true, description: 'FR-006 exception. Results stay saved and are retried.' },
  { code: 'CAMERA_BUFFERING', name: 'Camera storing reads locally', severity: 'warning', threshold: null, unit: '', enabled: true, description: 'Link to the application down; reads are sent when it is back (NFR redundancy).' },
  { code: 'DWELL_EXCEEDED', name: 'Pipe dwell time exceeded', severity: 'info', threshold: 25, unit: 'min', enabled: true, description: 'A pipe stays at a station longer than the limit.' },
  { code: 'RECON_MISMATCH', name: 'Tracking differs from CTMS', severity: 'info', threshold: null, unit: '', enabled: true, description: 'Reconciliation found differences (Rev 1 requirement 8).' },
];

// Tagging master data (FR "Tagging Master Data Requirement")
export const TAGGING_MASTER = [
  { req: 'TRC-001', tag: 'TRC-MAT-001', name: 'Receive Material Data', where: 'DMC API inbound, Work orders & pipes' },
  { req: 'TRC-002', tag: 'TRC-BC-001', name: 'Barcode Generation', where: 'Limab stencil robot (DMC), outside the application' },
  { req: 'TRC-003', tag: 'TRC-SCN-001', name: 'Barcode Scanning', where: 'Keyence scanners HT-*-SCN-01, station displays' },
  { req: 'TRC-004', tag: 'TRC-POS-001', name: 'Position Tracking', where: 'IN / OUT movements, plant layout, pipe queue' },
  { req: 'TRC-005', tag: 'TRC-HIS-001', name: 'Traceability History', where: 'Pipe trace' },
  { req: 'TRC-006', tag: 'TRC-RPT-001', name: 'Reporting Dashboard', where: 'Dashboards, Reports' },
  { req: 'TRC-007', tag: 'TRC-TAG-001', name: 'Tagging address and Process', where: 'Parameters → PLC / sensor / camera tags, OPC Kepware' },
];

// Work orders used to seed the plant (WHT + yy + seq, as in the mockups)
export const SEED_WORK_ORDERS = [
  { id: 'WHT26117', salesOrder: 'SO-26-0412', product: { type: 'Casing', od: '9 5/8"', weight: '47.0 ppf', grade: 'L80-1', end: 'BTC' }, qty: 20, startHoursAgo: 30, deadlineDays: -1 },
  { id: 'WHT26118', salesOrder: 'SO-26-0418', product: { type: 'Casing', od: '7"', weight: '29.0 ppf', grade: 'P110', end: 'LTC' }, qty: 30, startHoursAgo: 9.5, deadlineDays: 1 },
  { id: 'WHT26119', salesOrder: 'SO-26-0421', product: { type: 'Casing', od: '13 3/8"', weight: '68.0 ppf', grade: 'N80-Q', end: 'BTC' }, qty: 24, startHoursAgo: 4.6, deadlineDays: 3 },
  { id: 'WHT26120', salesOrder: 'SO-26-0425', product: { type: 'Casing', od: '9 5/8"', weight: '53.5 ppf', grade: 'L80-1', end: 'BTC' }, qty: 18, startHoursAgo: 1.05, deadlineDays: 5 },
];

// Work orders released in CTMS but not yet marked at Limab (DMC batches arrive during the demo)
export const UPCOMING_WORK_ORDERS = [
  { id: 'WHT26121', salesOrder: 'SO-26-0431', product: { type: 'Tubing', od: '4 1/2"', weight: '12.6 ppf', grade: 'L80-1', end: 'EUE' }, qty: 12, deadlineDays: 6 },
  { id: 'WHT26122', salesOrder: 'SO-26-0433', product: { type: 'Casing', od: '7"', weight: '26.0 ppf', grade: 'K55', end: 'LTC' }, qty: 16, deadlineDays: 7 },
  { id: 'WHT26123', salesOrder: 'SO-26-0440', product: { type: 'Casing', od: '9 5/8"', weight: '47.0 ppf', grade: 'P110', end: 'BTC' }, qty: 20, deadlineDays: 8 },
  { id: 'WHT26124', salesOrder: 'SO-26-0446', product: { type: 'Tubing', od: '3 1/2"', weight: '9.3 ppf', grade: 'J55', end: 'EUE' }, qty: 14, deadlineDays: 9 },
];

/** Kepware item names cannot contain hyphens, so the official tag name maps to an underscore item name. */
export const opcItem = (tagName) => tagName.replace(/-/g, '_');

/**
 * Build the tag list: PLC tags per station, sensor tags (entry / exit, Limab left / right) and
 * camera tags under the official scanner names.
 */
export function buildTags(stations, cameras = CAMERAS) {
  const tags = [];
  let db = 10;
  const add = (t) =>
    tags.push({
      value: t.dataType === 'Boolean' ? false : t.dataType === 'String' ? '' : 0,
      quality: 'Good',
      ts: null,
      scanMs: t.dataType === 'String' ? 100 : 250,
      readPoint: '',
      ...t,
      id: `${t.tagName}.${t.item}`,
      nodeId: `ns=2;s=${t.path}`,
    });
  for (const s of stations) {
    if (s.id === 'LIMAB') {
      for (const [side, tagName] of Object.entries(s.sensors)) {
        add({
          type: 'SENSOR',
          stationId: s.id,
          tagName,
          item: 'State',
          name: `${tagName}.State`,
          path: `Siemens_TCPIP.LIMAB_PLC.${opcItem(tagName)}.State`,
          address: side === 'right' ? 'DB20.DBX0.0' : 'DB20.DBX0.1',
          dataType: 'Boolean',
          description: side === 'right' ? 'Limab OUT [right position] · Sensor Out 1 (FR tag table)' : 'Limab left position · pipe moves to next station (assumed tag)',
          readPoint: side.toUpperCase(),
          official: side === 'right',
        });
      }
      continue;
    }
    if (!s.cameraId || !s.concentratorId) continue;
    const cam = cameras.find((c) => c.id === s.cameraId);
    const conc = CONCENTRATORS.find((c) => c.id === s.concentratorId);
    const isAB = conc.channel === 'AB_ControlLogix';
    const addr = (siemens, ab) => (isAB ? ab : siemens);
    const base = `${conc.channel}.${conc.device}`;
    const scn = cam.id;
    const sensorIn = s.sensors.entry;
    const sensorOut = s.sensors.exit;
    add({ type: 'SENSOR', stationId: s.id, tagName: sensorIn, item: 'State', name: `${sensorIn}.State`, path: `${base}.${opcItem(sensorIn)}.State`, address: addr(`DB${db}.DBX0.0`, 'Program:Traceability.EntrySensor'), dataType: 'Boolean', description: 'Entry photo-eye: pipe starts rolling into the station', readPoint: 'ENTRY' });
    add({ type: 'SENSOR', stationId: s.id, tagName: sensorOut, item: 'State', name: `${sensorOut}.State`, path: `${base}.${opcItem(sensorOut)}.State`, address: addr(`DB${db}.DBX0.1`, 'Program:Traceability.ExitSensor'), dataType: 'Boolean', description: 'Exit photo-eye: pipe leaves the station', readPoint: 'EXIT' });
    add({ type: 'CAMERA', stationId: s.id, tagName: scn, item: 'Trigger', name: `${scn}.Trigger`, path: `${base}.${opcItem(scn)}.Trigger`, address: addr(`DB${db}.DBX0.2`, 'Program:Traceability.CameraTrigger'), dataType: 'Boolean', description: 'Camera ON / OFF (read trigger) programmed at PLC level (FR-001)', readPoint: 'ENTRY', official: true });
    add({ type: 'CAMERA', stationId: s.id, tagName: scn, item: 'ReadCode', name: `${scn}.ReadCode`, path: `${base}.${opcItem(scn)}.ReadCode`, address: addr(`DB${db}.STRING10.40`, 'Program:Traceability.ReadCode'), dataType: 'String', description: 'Decoded Data Matrix (DMC data reading signal)', readPoint: 'ENTRY', official: true });
    add({ type: 'CAMERA', stationId: s.id, tagName: scn, item: 'ReadStatus', name: `${scn}.ReadStatus`, path: `${base}.${opcItem(scn)}.ReadStatus`, address: addr(`DB${db}.DBW52`, 'Program:Traceability.ReadStatus'), dataType: 'Word', description: '0 = OK, 1 = no read, 2 = bad quality', readPoint: 'ENTRY', official: true });
    add({ type: 'PLC', stationId: s.id, tagName: `${s.code}-PLC`, item: 'RecordMsg', name: `${s.code}-PLC.RecordMsg`, path: `${base}.${opcItem(s.code)}_PLC.RecordMsg`, address: addr(`DB${db}.DBW54`, 'Program:Traceability.RecordMsg'), dataType: 'Word', description: 'PLC message: 10 = start record, 20 = stop record' });
    add({ type: 'PLC', stationId: s.id, tagName: `${s.code}-PLC`, item: 'MovementType', name: `${s.code}-PLC.MovementType`, path: `${base}.${opcItem(s.code)}_PLC.MovementType`, address: addr(`DB${db}.DBW56`, 'Program:Traceability.MovementType'), dataType: 'Word', description: '1 = IN (entry read point), 2 = OUT (exit read point)' });
    add({ type: 'PLC', stationId: s.id, tagName: `${s.code}-PLC`, item: 'RollStartTime', name: `${s.code}-PLC.RollStartTime`, path: `${base}.${opcItem(s.code)}_PLC.RollStartTime`, address: addr(`DB${db}.DTL60`, 'Program:Traceability.RollStartTime'), dataType: 'DateTime', description: 'Pipe start rolling time from the entry sensor (FR-007, RFQ “pipe entry time”)' });
    add({ type: 'PLC', stationId: s.id, tagName: `${s.code}-PLC`, item: 'EventCounter', name: `${s.code}-PLC.EventCounter`, path: `${base}.${opcItem(s.code)}_PLC.EventCounter`, address: addr(`DB${db}.DBD72`, 'Program:Traceability.EventCounter'), dataType: 'DWord', description: 'Increments on every published event' });
    add({ type: 'PLC', stationId: s.id, tagName: `${s.code}-PLC`, item: 'Heartbeat', name: `${s.code}-PLC.Heartbeat`, path: `${base}.${opcItem(s.code)}_PLC.Heartbeat`, address: addr(`DB${db}.DBW76`, 'Program:Traceability.Heartbeat'), dataType: 'Word', description: 'Watchdog, increments every second' });
    if (!isAB) db += 1;
  }
  return tags;
}

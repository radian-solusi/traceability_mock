// Demo guide: a scripted end-to-end walk-through of one pipe, plus the plant simulator controls.
// Steps follow the latest documents: UC-001 … UC-005 (Rev 1), FR-001 / 003 / 005 / 006 / 010 and the NFR redundancy.
import webix from '../lib/webix.js';
import { db, getPipe, getStation, getTx, getCamera, stationName, runtimeOf } from '../core/db.js';
import { STAGE, operatorTrigger, submitInspection, resolveManual, setLimabFlag, limabMovement, releaseHold, pipeLabel, stepOf } from '../core/traceability.js';
import { retryAllFailed } from '../core/ctms.js';
import { releaseNextDmcBatch, simulateCameraRead, setAutoSim, setCtmsOutage, setCameraOffline, setPlcDown, setAppLinkDown, autofocus, odOf, runFullSync, updateSettings } from '../core/simulator.js';
import { currentUser, can } from '../core/session.js';
import { esc } from '../core/format.js';
import { card, pipeChip, pill, toast, infoNote } from '../ui/components.js';
import { focusTask } from './station/terminal.js';

const guide = { pipeId: null, done: new Set(), startedAt: null };

const operatorFor = (stationId) =>
  db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.defaultStation === stationId) ||
  db.users.find((u) => u.role === 'Operator' && u.status === 'ACTIVE' && u.stations.includes(stationId)) ||
  currentUser();

const supervisorActor = () => (currentUser().role === 'Supervisor' || currentUser().role === 'Admin' ? currentUser() : db.users.find((u) => u.username === 'andi.pratama'));

function pipe() {
  const p = guide.pipeId ? getPipe(guide.pipeId) : null;
  if (!p) throw new Error('Start with step 1: the robot marks a new batch of pipes.');
  return p;
}

function requireStage(p, stage, stationIds, hint) {
  const where = stage === STAGE.QUEUED ? stepOf(p)?.stations.find((s) => stationIds?.includes(s)) && p.targetStationId : p.stationId;
  const ok = p.stage === stage && (!stationIds || stationIds.includes(where));
  if (!ok) {
    const now = p.stage === STAGE.QUEUED ? `queued for ${stationName(p.targetStationId)}` : `${p.stage.toLowerCase().replace('_', ' ')}${p.stationId ? ' at ' + stationName(p.stationId) : ''}`;
    throw new Error(`${pipeLabel(p)} is ${now}, so this step does not apply now. ${hint} If you already did it on the station display, continue with the next step.`);
  }
}

/** FR-001.3: re-focus the scanner when the pipe size differs from its alignment, so the guide reads are clean. */
function alignFor(stationId, p) {
  const cam = getStation(stationId)?.cameraId ? getCamera(getStation(stationId).cameraId) : null;
  const od = odOf(p);
  if (!cam || !od || cam.alignedOd === od) return '';
  autofocus(cam.id, { od, actor: operatorFor(stationId) });
  return ` · ${cam.id} autofocused for ${od}`;
}

function restoreWms() {
  if (runtimeOf('WMS').plcDown) setPlcDown('WMS', false, currentUser());
}

const read = (stationId, movement, p, extra = {}) => simulateCameraRead(stationId, movement, { pipeId: p.id, respectAlignment: false, actor: currentUser(), ...extra });

function awaitTx(p) {
  return p.awaitTxId ? getTx(p.awaitTxId) : null;
}

/** Steps the demo pipe has already been through (also when done by hand on the station displays). */
function progressDone() {
  const done = new Set();
  const p = guide.pipeId ? getPipe(guide.pipeId) : null;
  if (!p) return done;
  const txs = p.history.map(getTx);
  const has = (fn) => txs.some(fn);
  const result = (ids) => has((t) => ids.includes(t.stationId) && t.inspection?.result);
  const moved = (ids, m) => has((t) => ids.includes(t.stationId) && t.movement === m);
  done.add(0);
  if (p.limabFlag || result(['LIMAB'])) done.add(1);
  if (moved(['LIMAB'], 'OUT')) done.add(2);
  if (moved(['SEA_E', 'SEA_W'], 'IN')) done.add(3);
  if (result(['SEA_E', 'SEA_W'])) done.add(4);
  if (result(['EMI'])) done.add(5);
  if (moved(['WMS'], 'IN')) done.add(6);
  if (result(['WMS'])) done.add(7);
  if (moved(['HYD_Y', 'HYD_B'], 'IN')) done.add(8);
  if (result(['HYD_Y', 'HYD_B'])) done.add(9);
  if (done.has(9) && !txs.some((t) => t.ctms?.status === 'FAILED' || t.ctms?.status === 'PENDING')) done.add(10);
  if (result(['PAUT'])) done.add(11);
  if (p.holdDecision || p.stage === STAGE.FINISHED) done.add(12);
  if (db.recon && guide.startedAt && db.recon.ts > guide.startedAt && done.has(12)) done.add(13);
  return done;
}

const STEPS = [
  {
    ref: 'UC-001',
    title: 'CTMS releases a work order and the Limab robot marks the pipes',
    text: 'The robot prints a Data Matrix on each pipe and the DMC API sends the unique numbers; pipe information comes from CTMS through CT-Track. The pipes join the Limab sequence in DMC order. The first pipe of the batch becomes the demo pipe.',
    prepare() {
      const b = releaseNextDmcBatch({ count: 6, actor: currentUser() });
      if (!b.count) throw new Error('No pipes were released. Try again.');
      guide.pipeId = b.pipes[0];
      guide.startedAt = Date.now();
      guide.done.clear();
      focusTask('flag', guide.pipeId);
      return { route: 'station', param: 'limab', msg: `${b.count} pipes of ${b.woId} marked. Demo pipe: ${pipeLabel(getPipe(guide.pipeId))}` };
    },
  },
  {
    ref: 'FR-005',
    title: 'Limab: the operator sets the pipe status flag',
    text: 'On the Limab display, the demo pipe is selected in the status-flag panel. Choose Good (no colour line on the pipe) and save. The flag is applied when the pipe leaves Limab.',
    completeLabel: 'Set flag Good',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['LIMAB'], 'Run step 1 first.');
      focusTask('flag', p.id);
      return { route: 'station', param: 'limab', msg: `Choose Good for ${pipeLabel(p)} and save the flag` };
    },
    complete() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['LIMAB'], 'Run step 1 first.');
      setLimabFlag(p.id, 'GOOD', { actor: operatorFor('LIMAB') });
      return { route: 'station', param: 'limab', msg: `${pipeLabel(p)}: status flag Good prepared` };
    },
  },
  {
    ref: 'FR-003 · FR-005',
    title: 'Limab: the pipe moves left and the out-station sensor records it',
    text: 'Left position = next station, right position = out station (sensor HT-LM-OUT-01). The PLC sensor triggers the OUT record, the identity comes from the DMC sequence, and the status flag is sent to CTMS through CT-Track. The pipe is queued for SEA East or West.',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['LIMAB'], 'Run step 1 first.');
      let note = '';
      if (!p.limabFlag) {
        setLimabFlag(p.id, 'GOOD', { actor: operatorFor('LIMAB') });
        note = ' (flag Good set first)';
      }
      limabMovement({ direction: 'LEFT', pipeId: p.id, source: 'SENSOR' }, { actor: operatorFor('LIMAB') });
      return { route: 'station', param: getStation(p.targetStationId).slug, msg: `${pipeLabel(p)} left Limab ← left${note}; queued for ${stationName(p.targetStationId)}` };
    },
  },
  {
    ref: 'UC-002 · FR-001',
    title: 'SEA: the scanner reads the pipe at the entry point (option 1)',
    text: 'The entry sensor starts the record, the Keyence scanner decodes the Data Matrix and the read reaches the application through the PLC and Kepware OPC (option 1). The code is in the master data, so IN is recorded automatically with the rolling start and read times. Then read the same pipe again: the existing transaction is updated instead of creating a second one (UC-002 3a).',
    completeLabel: 'Read the same pipe again',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.QUEUED, ['SEA_E', 'SEA_W'], 'Finish step 3 first.');
      const target = p.targetStationId;
      const tuned = alignFor(target, p);
      read(target, 'IN', p);
      return { route: 'station', param: getStation(target).slug, msg: `${pipeLabel(p)} IN at ${stationName(target)} · AUTO via option 1${tuned}` };
    },
    complete() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['SEA_E', 'SEA_W'], 'Run this step first.');
      const ev = read(p.stationId, 'IN', p);
      return { route: 'station', param: getStation(p.stationId).slug, msg: ev.duplicateOf ? `Same pipe read again: transaction ${ev.duplicateOf} updated, no duplicate record` : 'Read recorded' };
    },
  },
  {
    ref: 'UC-004',
    title: 'SEA: exit read, then the operator records NC',
    text: 'The exit read records OUT and opens the inspection form (Good / NC). Choose NC, defect EM01 and submit. The route has an EMI prove-up step after an NC at SEA, so the pipe is queued for prove-up instead of being held.',
    completeLabel: 'Enter NC · EM01',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['SEA_E', 'SEA_W'], 'Run step 4 first.');
      read(p.stationId, 'OUT', p);
      if (p.awaitTxId) focusTask('inspect', p.awaitTxId);
      return { route: 'station', param: getStation(p.stationId).slug, msg: 'Enter the SEA inspection result: NC · EM01' };
    },
    complete() {
      const p = pipe();
      const tx = awaitTx(p);
      if (!tx) throw new Error('Run this step first: the exit read opens the inspection task.');
      submitInspection(tx.id, { result: 'NC', defectCode: 'EM01', remarks: 'Indication 2.1 m from pin end' }, { actor: operatorFor(tx.stationId) });
      return { route: 'station', param: getStation(tx.stationId).slug, msg: `${pipeLabel(p)}: NC saved, queued for EMI prove-up` };
    },
  },
  {
    ref: 'UC-003 4b',
    title: 'EMI prove-up: no scanner, the operator records the pipe',
    text: 'On the EMI Prove-up display click “Record IN”, pick the pipe, then “Record OUT” and enter the prove-up result Good. Both movements are stored with method MANUAL and the operator’s name.',
    prepare() {
      requireStage(pipe(), STAGE.QUEUED, ['EMI'], 'Finish step 5 with an NC result first.');
      return { route: 'station', param: 'emi-proveup', msg: 'Record IN, then OUT and the prove-up result' };
    },
    complete() {
      const p = pipe();
      const actor = operatorFor('EMI');
      if (p.stage === STAGE.QUEUED && p.targetStationId === 'EMI') operatorTrigger({ stationId: 'EMI', pipeId: p.id, movementType: 'IN' }, { actor });
      if (p.stage === STAGE.IN && p.stationId === 'EMI') operatorTrigger({ stationId: 'EMI', pipeId: p.id, movementType: 'OUT' }, { actor });
      const tx = awaitTx(p);
      if (tx && tx.stationId === 'EMI') submitInspection(tx.id, { result: 'GOOD', remarks: 'Indication ground out, wall OK' }, { actor });
      if (p.stage !== STAGE.QUEUED) throw new Error(`${pipeLabel(p)} is not at EMI prove-up.`);
      return { route: 'station', param: 'emi-proveup', msg: `${pipeLabel(p)} cleared at prove-up, queued for WMS` };
    },
  },
  {
    ref: 'UC-003',
    title: 'WMS: the DMC is unreadable, the operator confirms the pipe',
    text: 'The entry read fails, so the system suggests pipes from the WMS sequence (expected pipe first). Pick the demo pipe (4a, select another pipe) or use “Not in list? Enter identity” (4b) and confirm. The movement is stored as MANUAL with the operator’s name.',
    completeLabel: 'Confirm the pipe',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.QUEUED, ['WMS'], 'Finish step 6 first.');
      const ev = read('WMS', 'IN', p, { forceError: true });
      focusTask('identify', ev.id);
      return { route: 'station', param: 'wms', msg: `DMC unreadable. Pick ${pipeLabel(p)} in the list, or enter it` };
    },
    complete() {
      const p = pipe();
      const ev = db.events.filter((e) => e.stationId === 'WMS' && e.identification?.status === 'REQUIRED').pop();
      if (!ev) throw new Error('Run this step first to create the failed read.');
      resolveManual(ev.id, p.id, { actor: operatorFor('WMS'), mode: 'LIST' });
      return { route: 'station', param: 'wms', msg: `${pipeLabel(p)} confirmed manually at WMS` };
    },
  },
  {
    ref: 'FR-001 · FR-014',
    title: 'WMS: the PLC / OPC path fails, the application reads the scanner directly',
    text: 'The PLC path at WMS goes down. The application switches to option 2 and reads HT-M1-SCN-01 directly, so the exit read is still recorded automatically and an alarm “Reading switched to option 2” is raised. Enter the WMS result Good; the PLC path is then restored.',
    completeLabel: 'Enter Good',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['WMS'], 'Finish step 7 first.');
      setPlcDown('WMS', true, currentUser());
      read('WMS', 'OUT', p);
      if (p.awaitTxId) focusTask('inspect', p.awaitTxId);
      return { route: 'station', param: 'wms', msg: 'Option 2 active at WMS. Enter the WMS result Good' };
    },
    complete() {
      const p = pipe();
      const tx = awaitTx(p);
      if (!tx || tx.stationId !== 'WMS') throw new Error('Run this step first: the exit read opens the result task.');
      submitInspection(tx.id, { result: 'GOOD' }, { actor: operatorFor('WMS') });
      restoreWms();
      return { route: 'station', param: 'wms', msg: `${pipeLabel(p)}: WMS Good · PLC path restored (option 1)` };
    },
  },
  {
    ref: 'NFR redundancy',
    title: 'Hydrotest: the network to the application drops, the camera stores the read',
    text: 'The link between the scanner and the application is down when the pipe arrives. The camera keeps the read (shown as “stored” on the station display) and sends it when the link is back, with its original time. Restore the link to deliver it.',
    completeLabel: 'Restore the link',
    prepare() {
      restoreWms();
      const p = pipe();
      requireStage(p, STAGE.QUEUED, ['HYD_Y', 'HYD_B'], 'Finish step 8 first.');
      const target = p.targetStationId;
      const tuned = alignFor(target, p);
      setAppLinkDown(target, true, currentUser());
      const res = read(target, 'IN', p);
      return { route: 'station', param: getStation(target).slug, msg: `Link down at ${stationName(target)}: ${res.count || 1} read stored in ${getStation(target).cameraId}${tuned}` };
    },
    complete() {
      const p = pipe();
      const entry = Object.entries(db.runtime).find(([, rt]) => rt.buffer.some((r) => r.pipeId === p.id)) || Object.entries(db.runtime).find(([, rt]) => rt.appLinkDown);
      if (!entry) throw new Error('No camera is storing reads. Run this step first.');
      const [stationId] = entry;
      setAppLinkDown(stationId, false, currentUser());
      return { route: 'station', param: getStation(stationId).slug, msg: `Link restored: stored read delivered, ${pipeLabel(p)} IN at ${stationName(stationId)}` };
    },
  },
  {
    ref: 'UC-005 · FR-006',
    title: 'Hydrotest during a CTMS outage',
    text: 'CT-Track cannot reach CTMS. The exit read opens the hydrotest result: submit Good. The result is saved locally, the submission fails and retries automatically, and the alarm “CTMS not responding” is raised.',
    completeLabel: 'Enter Good',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.IN, ['HYD_Y', 'HYD_B'], 'Finish step 9 first.');
      setCtmsOutage(true, currentUser());
      read(p.stationId, 'OUT', p);
      if (p.awaitTxId) focusTask('inspect', p.awaitTxId);
      return { route: 'station', param: getStation(p.stationId).slug, msg: 'CTMS is down. Submit the hydrotest result Good' };
    },
    complete() {
      const p = pipe();
      const tx = awaitTx(p);
      if (!tx) throw new Error('Run this step first.');
      submitInspection(tx.id, { result: 'GOOD' }, { actor: operatorFor(tx.stationId) });
      return { route: can('apisync') ? 'api-sync' : 'station', param: can('apisync') ? undefined : getStation(tx.stationId).slug, msg: 'Result saved; the CTMS submission is failing and will retry' };
    },
  },
  {
    ref: 'UC-005 3a',
    title: 'CTMS is back: retry the failed submissions',
    text: 'API synchronization lists the failed submission with its HTTP error and attempts. The outage ends and the submissions are retried: the status turns Success with a CTMS reference.',
    prepare() {
      setCtmsOutage(false, currentUser());
      const n = retryAllFailed({ actor: currentUser() });
      return { route: can('apisync') ? 'api-sync' : 'operations', msg: `CTMS reachable again · ${n} submission(s) re-queued` };
    },
  },
  {
    ref: 'UC-004 · FR-006',
    title: 'PAUT: the last station records NC, the pipe goes on hold',
    text: 'IN and OUT reads at PAUT, then enter NC with defect UT04 (coupling loss). No prove-up step follows PAUT, so the pipe is held for a supervisor decision.',
    completeLabel: 'Enter NC · UT04',
    prepare() {
      const p = pipe();
      requireStage(p, STAGE.QUEUED, ['PAUT'], 'Finish steps 10 and 11 first.');
      const tuned = alignFor('PAUT', p);
      read('PAUT', 'IN', p);
      read('PAUT', 'OUT', p);
      if (p.awaitTxId) focusTask('inspect', p.awaitTxId);
      return { route: 'station', param: 'paut', msg: `Enter the PAUT result NC · UT04${tuned}` };
    },
    complete() {
      const p = pipe();
      const tx = awaitTx(p);
      if (!tx) throw new Error('Run this step first.');
      submitInspection(tx.id, { result: 'NC', defectCode: 'UT04', remarks: 'Coupling loss, re-scan needed' }, { actor: operatorFor('PAUT') });
      return { route: can('supervisor') ? 'supervisor' : 'station', param: can('supervisor') ? undefined : 'paut', msg: `${pipeLabel(p)} is on hold for review` };
    },
  },
  {
    ref: 'Supervisor',
    title: 'Supervisor: release the held pipe',
    text: 'In the supervisor view, the demo pipe is under “Pipes to review”. Release it after the re-scan (or send it back, or reject it). The decision is audited and sent to CTMS through CT-Track; the pipe reaches Finish HT Cold.',
    completeLabel: 'Release the pipe',
    prepare() {
      if (!can('supervisor')) throw new Error('Sign in as Supervisor or Admin to open the supervisor view.');
      requireStage(pipe(), STAGE.HOLD, null, 'Finish step 12 first.');
      return { route: 'supervisor', msg: 'Release, re-inspect or reject the demo pipe' };
    },
    complete() {
      if (!can('supervisor', 'edit')) throw new Error('Sign in as Supervisor or Admin to take the decision.');
      const p = pipe();
      requireStage(p, STAGE.HOLD, null, 'Finish step 12 first.');
      releaseHold(p.id, { note: 'Re-scan OK after coupling check' }, { actor: supervisorActor() });
      return { route: 'supervisor', msg: `${pipeLabel(p)} released and finished · decision sent to CTMS` };
    },
  },
  {
    ref: 'FR-010',
    title: 'Reconciliation: compare tracking data with CTMS',
    text: 'A full synchronization through CT-Track refreshes the CTMS data and compares every pipe’s latest status with what CTMS holds. Differences (value changed in CTMS, submission not accepted) are listed for review.',
    prepare() {
      if (!can('apisync')) throw new Error('Sign in as Supervisor or Admin to run the reconciliation.');
      const r = runFullSync(currentUser());
      return { route: 'api-sync', param: 'recon', msg: `${r.summary.total} pipes compared: ${r.summary.match} match, ${r.summary.different} different, ${r.summary.notInCtms} not in CTMS` };
    },
  },
  {
    ref: 'TRC-005',
    title: 'Open the pipe trace',
    text: 'Every event of the demo pipe in one place: DMC marking, status flag, IN / OUT per station with AUTO / MANUAL / UPDATED, reading path, operator names, results, CTMS attempts and references, the hold and the supervisor decision. A supervisor can correct a result here while the pipe has not moved; the audit trail keeps the before and after values.',
    prepare() {
      return { route: 'trace', param: pipe().id, msg: 'Full genealogy of the demo pipe' };
    },
  },
];

function stepsHtml() {
  const p = guide.pipeId ? getPipe(guide.pipeId) : null;
  const doneSet = new Set([...guide.done, ...progressDone()]);
  const head = p
    ? `<div class="note" style="margin:10px 0">${pipeChip(p)} <div><b>Demo pipe ${esc(pipeLabel(p))}</b> · <span class="mono">${esc(p.dmc)}</span> · ${pill(p.status)} <span class="muted">${esc(p.stage.toLowerCase().replace('_', ' '))}${p.stationId && p.stage !== STAGE.QUEUED ? ' at ' + esc(stationName(p.stationId)) : p.targetStationId ? ' · next: ' + esc(stationName(p.targetStationId)) : ''}</span></div></div>`
    : `<div style="margin:10px 0">${infoNote('Run the steps in order. Each step does the machine side (robot, sensors, scanners, PLC / OPC, CT-Track, CTMS) and opens the screen where the operator acts. The second button does the operator part for you. Sign in as <b>Supervisor</b> or <b>Admin</b> for the full walk-through: operators only see their own stations.')}</div>`;
  return `<div style="padding:4px 14px 10px">${head}
  ${STEPS.map(
    (s, i) => `<div class="guide-step ${doneSet.has(i) ? 'done' : ''}"><div class="guide-no">${doneSet.has(i) ? '<i class="mdi mdi-check"></i>' : i + 1}</div><div><div class="guide-title">${esc(s.title)}<span class="guide-uc">${esc(s.ref)}</span></div><div class="guide-text">${esc(s.text)}</div>
    <div class="guide-actions"><span class="act guide-run" data-i="${i}"><i class="mdi mdi-play"></i>Run step</span>${s.complete ? `<span class="act guide-auto" data-i="${i}"><i class="mdi mdi-robot-outline"></i>${esc(s.completeLabel || 'Do operator part')}</span>` : ''}</div></div></div>`
  ).join('')}</div>`;
}

function runStep(i, kind, ctx) {
  const step = STEPS[i];
  try {
    const res = kind === 'auto' ? step.complete() : step.prepare();
    if (kind === 'auto' || !step.complete) guide.done.add(i);
    toast(res.msg, 'success');
    webix.$$('guide-steps')?.refresh();
    if (res.route) ctx.later(250, () => ctx.go(res.route, res.param));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function aboutHtml() {
  return `<div class="prose" style="padding-top:6px">
  <h4>What is real and what is simulated</h4>
  <ul>
    <li><b>Real in this mock:</b> screens, navigation, roles, and the traceability rules: DMC sequence, automatic and manual identification, existing-transaction updates, IN / OUT, Good / NC results, Limab status flags and left / right movement, routing to prove-up or hold, CTMS status, reconciliation, alarms, audit trail.</li>
    <li><b>Simulated in the browser:</b> PLC sensors, Keyence scanners (both reading paths), Kepware OPC, the DMC API, CT-Track and CTMS, Active Directory sign-in and the PostgreSQL database.</li>
    <li>Data resets when you reload the page. Nothing leaves your browser.</li>
  </ul>
  <h4>Sources and assumptions</h4>
  <p>Built from the Functional and Non Functional Requirement, Traceability System Requirement Rev 1, Traceability Application 7061, the RFQ and the VDIS deck. Anything those documents leave open is listed in <span class="mono">docs/ASSUMPTIONS.md</span>, and <span class="mono">docs/REQUIREMENTS-TRACE.md</span> maps each requirement to the screen that shows it.</p></div>`;
}

export default {
  route: 'guide',
  title: 'Demo Guide',
  subtitle: 'Walk one pipe through the whole line, and control the simulated plant',
  perm: 'guide',
  nav: { label: 'Demo guide', icon: 'mdi-map-marker-path', order: 62 },

  ui(ctx) {
    const s = db.settings;
    const camSwitches = db.cameras
      .filter((c) => c.stationId)
      .map((c) => ({
        view: 'switch',
        id: `g-cam-${c.id}`,
        labelRight: `${c.id} · ${stationName(c.stationId)} offline`,
        labelWidth: 0,
        value: s.cameraOffline[c.id] ? 1 : 0,
        on: { onChange: (v) => setCameraOffline(c.id, !!v, currentUser()) },
      }));
    return {
      type: 'space',
      css: 'page',
      cols: [
        card({
          title: 'End-to-end walk-through',
          sub: 'One pipe from the DMC marking to Finish HT Cold',
          gravity: 1.5,
          minWidth: 460,
          actions: [
            {
              view: 'button',
              type: 'icon',
              icon: 'mdi mdi-restart',
              label: 'Restart guide',
              css: 'btn-ghost',
              autowidth: true,
              click: () => {
                guide.pipeId = null;
                guide.startedAt = null;
                guide.done.clear();
                webix.$$('guide-steps').refresh();
              },
            },
          ],
          body: {
            view: 'scrollview',
            scroll: 'y',
            body: {
              view: 'template',
              id: 'guide-steps',
              borderless: true,
              autoheight: true,
              template: stepsHtml,
              onClick: {
                'guide-run': (e, id, node) => runStep(Number(node.getAttribute('data-i')), 'run', ctx),
                'guide-auto': (e, id, node) => runStep(Number(node.getAttribute('data-i')), 'auto', ctx),
              },
            },
          },
        }),
        {
          gravity: 1,
          minWidth: 360,
          rows: [
            card({
              title: 'Plant simulator',
              sub: 'Stands in for the PLCs, scanners, OPC, DMC API, CT-Track and CTMS',
              body: {
                view: 'scrollview',
                scroll: 'y',
                body: {
                  view: 'form',
                  id: 'g-sim-form',
                  borderless: true,
                  elementsConfig: { labelWidth: 170 },
                  elements: [
                    { view: 'switch', id: 'g-auto', label: 'Auto-simulation', value: s.autoSim ? 1 : 0, on: { onChange: (v) => setAutoSim(!!v) } },
                    { view: 'slider', id: 'g-interval', label: 'Event interval', min: 1, max: 8, step: 0.5, value: s.simIntervalMs / 1000, title: (o) => `${o.value} s`, on: { onChange: (v) => updateSettings({ simIntervalMs: v * 1000 }) } },
                    { view: 'slider', id: 'g-readerr', label: 'DMC read failures', min: 0, max: 40, step: 1, value: Math.round(s.readErrorRate * 100), title: (o) => `${o.value} %`, on: { onChange: (v) => updateSettings({ readErrorRate: v / 100 }) } },
                    { view: 'slider', id: 'g-ctmserr', label: 'CTMS failures', min: 0, max: 50, step: 1, value: Math.round(s.ctmsFailRate * 100), title: (o) => `${o.value} %`, on: { onChange: (v) => updateSettings({ ctmsFailRate: v / 100 }) } },
                    { view: 'switch', id: 'g-virtual', label: 'Virtual operators', value: s.virtualOperators ? 1 : 0, on: { onChange: (v) => updateSettings({ virtualOperators: !!v }) } },
                    { view: 'switch', id: 'g-outage', label: 'CTMS outage', value: s.ctmsOutage ? 1 : 0, on: { onChange: (v) => setCtmsOutage(!!v, currentUser()) } },
                    { template: '<div class="muted" style="font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding-top:6px">Scanners</div>', borderless: true, height: 30 },
                    ...camSwitches,
                    { template: '<div class="muted" style="font-size:12px;line-height:1.45">PLC / OPC path and network faults per station: <b>Faults…</b> on each station display.</div>', borderless: true, autoheight: true },
                    {
                      margin: 8,
                      cols: [
                        {
                          view: 'button',
                          value: 'Robot marks a batch',
                          css: 'btn-ghost',
                          click: () => {
                            const b = releaseNextDmcBatch({ actor: currentUser() });
                            toast(`DMC batch ${b.id}: ${b.count} pipes for ${b.woId}`, 'success');
                          },
                        },
                        {
                          view: 'button',
                          value: 'Reset demo data',
                          css: 'btn-ghost',
                          click: () =>
                            webix
                              .confirm({ title: 'Reset demo data?', text: 'All movements you recorded are discarded and the plant is re-seeded.', ok: 'Reset', cancel: 'Cancel' })
                              .then(() => {
                                guide.pipeId = null;
                                guide.startedAt = null;
                                guide.done.clear();
                                window.dispatchEvent(new CustomEvent('ptct:reseed'));
                              })
                              .catch(() => {}),
                        },
                      ],
                    },
                    {},
                  ],
                },
              },
            }),
            { height: 12 },
            card({ title: 'About this mock', height: 300, body: { view: 'scrollview', scroll: 'y', body: { view: 'template', borderless: true, autoheight: true, template: aboutHtml } } }),
          ],
        },
      ],
    };
  },

  init(ctx) {
    ctx.live(() => webix.$$('guide-steps')?.refresh(), 800);
    ctx.on('sim', () => {
      const pairs = [
        ['g-auto', db.settings.autoSim],
        ['g-outage', db.settings.ctmsOutage],
        ...db.cameras.filter((c) => c.stationId).map((c) => [`g-cam-${c.id}`, db.settings.cameraOffline[c.id]]),
      ];
      for (const [id, val] of pairs) {
        const v = webix.$$(id);
        if (v && !!v.getValue() !== !!val) {
          v.blockEvent();
          v.setValue(val ? 1 : 0);
          v.unblockEvent();
        }
      }
    });
  },
};

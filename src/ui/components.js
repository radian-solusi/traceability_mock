// HTML snippets and small Webix config builders shared by the views.
import webix from '../lib/webix.js';
import { esc, fmtTime, fmtAgo } from '../core/format.js';
import { STATUS_META, STAGE_META } from '../core/selectors.js';

// ---------------------------------------------------------------------------
// Inline badges
// ---------------------------------------------------------------------------
export function pill(status) {
  const m = STATUS_META[status] || { label: status || '–', tone: 'muted' };
  return `<span class="pill pill-${m.tone}">${esc(m.label)}</span>`;
}

export function stagePill(stage) {
  const m = STAGE_META[stage] || { label: stage || '–', tone: 'muted' };
  return `<span class="chip chip-${m.tone}">${esc(m.label)}</span>`;
}

export function methodBadge(method) {
  if (method === 'AUTO') return '<span class="tag tag-auto" title="Identified automatically from the Data Matrix read"><i class="mdi mdi-barcode-scan"></i>AUTO</span>';
  if (method === 'MANUAL') return '<span class="tag tag-manual" title="Identified by the operator"><i class="mdi mdi-hand-back-right-outline"></i>MANUAL</span>';
  if (method === 'PENDING') return '<span class="tag tag-pending"><i class="mdi mdi-help-circle-outline"></i>CONFIRM</span>';
  if (method === 'UPDATED') return '<span class="tag tag-updated" title="Same pipe, process point and event: the existing transaction was updated (UC-002 3a)"><i class="mdi mdi-update"></i>UPDATED</span>';
  return '<span class="muted">–</span>';
}

export function moveBadge(m) {
  if (m === 'IN') return '<span class="move move-in"><i class="mdi mdi-arrow-collapse-right"></i>IN</span>';
  if (m === 'OUT') return '<span class="move move-out"><i class="mdi mdi-arrow-expand-right"></i>OUT</span>';
  return '<span class="muted">–</span>';
}

export function readBadge(status) {
  if (status === 'OK') return '<span class="read read-ok"><i class="mdi mdi-check-circle"></i>Read OK</span>';
  if (status === 'NO_READ') return '<span class="read read-fail"><i class="mdi mdi-close-circle"></i>Fail reading</span>';
  if (status === 'MANUAL') return '<span class="read read-manual"><i class="mdi mdi-gesture-tap"></i>Operator</span>';
  if (status === 'SENSOR') return '<span class="read read-manual"><i class="mdi mdi-motion-sensor"></i>Sensor</span>';
  return '<span class="muted">–</span>';
}

export function ctmsBadge(ctms) {
  const s = ctms?.status || 'N/A';
  if (s === 'SUCCESS') return '<span class="ctms ctms-ok" title="Accepted by CTMS"><i class="mdi mdi-cloud-check-outline"></i>Success</span>';
  if (s === 'PENDING') return `<span class="ctms ctms-pending" title="Queued for CTMS"><i class="mdi ${ctms.inFlight ? 'mdi-loading mdi-spin' : 'mdi-cloud-upload-outline'}"></i>${ctms.inFlight ? 'Sending' : 'Pending'}</span>`;
  if (s === 'FAILED') return `<span class="ctms ctms-fail" title="${esc(ctms.response?.message || '')}"><i class="mdi mdi-cloud-alert-outline"></i>Failed${ctms.autoRetry ? ' · retrying' : ''}</span>`;
  return '<span class="muted" title="Movement only: no CTMS submission">–</span>';
}

export function pathBadge(path) {
  if (path === 'OPT1') return '<span class="path path-1" title="Option 1: scanner read through PLC → Kepware OPC (main)">OPT 1 · PLC</span>';
  if (path === 'OPT2') return '<span class="path path-2" title="Option 2: direct camera read from the application (redundancy)">OPT 2 · direct</span>';
  return '<span class="muted">–</span>';
}

export function severityBadge(sev) {
  const label = { critical: 'Critical', warning: 'Warning', info: 'Info' }[sev] || sev;
  return `<span class="sev sev-${sev}"><i class="mdi ${sev === 'critical' ? 'mdi-alert-octagon' : sev === 'warning' ? 'mdi-alert' : 'mdi-information'}"></i>${label}</span>`;
}

export function alarmState(state) {
  if (state === 'ACTIVE') return '<span class="chip chip-reject">Active</span>';
  if (state === 'ACKNOWLEDGED') return '<span class="chip chip-warn">Acknowledged</span>';
  return '<span class="chip chip-muted">Cleared</span>';
}

export function directionBadge(dir) {
  if (dir === 'LEFT') return '<span class="move move-out" title="Left position: to the next station"><i class="mdi mdi-arrow-left-bold-outline"></i>Left · next station</span>';
  if (dir === 'RIGHT') return '<span class="move move-right" title="Right position: out station (sensor HT-LM-OUT-01)"><i class="mdi mdi-arrow-right-bold-outline"></i>Right · out station</span>';
  return '';
}

export function health(status) {
  const s = String(status || 'UNKNOWN').toUpperCase();
  const label = { ONLINE: 'Online', DEGRADED: 'Degraded', OFFLINE: 'Offline', STANDBY: 'Standby', UNKNOWN: 'Unknown' }[s] || s;
  return `<span class="health health-${s.toLowerCase()}"><i></i>${label}</span>`;
}

/** A pipe drawn as a short tube with its pipe number, coloured by status. */
export function pipeChip(pipe, { size = 'md', label, title, pulse = false } = {}) {
  if (!pipe) return '';
  const tone = (STATUS_META[pipe.status] || STATUS_META.PENDING).tone;
  const text = label ?? `PN${pipe.pn}`;
  const tip = title ?? `${pipe.wo} · PN ${pipe.pn} · ${STATUS_META[pipe.status]?.label || pipe.status}`;
  return `<span class="pipe pipe-${tone} pipe-${size}${pulse ? ' pipe-pulse' : ''}" title="${esc(tip)}" data-pipe="${esc(pipe.id)}"><span class="pipe-label">${esc(text)}</span></span>`;
}

export const mono = (v) => `<span class="mono">${esc(v ?? '–')}</span>`;
export const timeCell = (ts) => (ts ? `<span class="mono" title="${esc(fmtAgo(ts))}">${fmtTime(ts)}</span>` : '<span class="muted">–</span>');

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------
export function sectionTitle(title, sub) {
  return `<div class="sec-title"><span class="sec-name">${esc(title)}</span>${sub ? `<span class="sec-sub">${esc(sub)}</span>` : ''}</div>`;
}

export function infoNote(html, tone = 'info') {
  return `<div class="note note-${tone}"><i class="mdi ${tone === 'warn' ? 'mdi-alert-outline' : 'mdi-information-outline'}"></i><div>${html}</div></div>`;
}

export function emptyState(icon, title, text = '') {
  return `<div class="empty"><i class="mdi ${icon}"></i><div class="empty-title">${esc(title)}</div>${text ? `<div class="empty-text">${text}</div>` : ''}</div>`;
}

export function kpiTile({ label, value, sub = '', tone = '', icon = '' }) {
  return `<div class="kpi ${tone ? 'kpi-' + tone : ''}">
    <div class="kpi-label" title="${esc(label)}">${icon ? `<i class="mdi ${icon}"></i>` : ''}${esc(label)}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

export function progressBar(pct, tone = 'accent') {
  const v = Math.max(0, Math.min(100, Math.round(pct * 100)));
  return `<div class="bar bar-${tone}" title="${v}%"><span style="width:${v}%"></span></div>`;
}

// ---------------------------------------------------------------------------
// Webix config helpers
// ---------------------------------------------------------------------------
/** A titled panel: header toolbar (title, subtitle, actions) above a body view. */
export function card({ id, title, sub, actions = [], body, height, minHeight, css = '', gravity, minWidth, width, headerHeight = 54 }) {
  const cfg = {
    css: `card ${css}`.trim(),
    rows: [
      {
        view: 'toolbar',
        css: 'card-head',
        height: headerHeight,
        borderless: true,
        paddingX: 14,
        elements: [{ view: 'label', label: sectionTitle(title, sub), css: 'card-title-label' }, ...actions],
      },
      body,
    ],
  };
  if (id) cfg.id = id;
  if (height) cfg.height = height;
  if (minHeight) cfg.minHeight = minHeight;
  if (gravity) cfg.gravity = gravity;
  if (minWidth) cfg.minWidth = minWidth;
  if (width) cfg.width = width;
  return cfg;
}

export function iconButton(icon, label, click, opts = {}) {
  return { view: 'button', type: 'icon', icon: `mdi ${icon}`, label, autowidth: true, css: opts.css || 'btn-ghost', click, tooltip: opts.tooltip, id: opts.id, disabled: opts.disabled, hidden: opts.hidden };
}

export function primaryButton(label, click, opts = {}) {
  return { view: 'button', value: label, css: `webix_primary ${opts.css || ''}`.trim(), autowidth: !opts.width, width: opts.width, click, id: opts.id, disabled: opts.disabled, hotkey: opts.hotkey };
}

export function toast(text, type = 'info') {
  const t = type === 'warning' ? 'debug' : type;
  webix.message({ text: esc(text), type: t, expire: type === 'error' ? 6500 : 3500 });
}

/** Run an action and report errors to the operator instead of throwing. */
export function attempt(fn, successText) {
  try {
    const result = fn();
    if (successText) toast(typeof successText === 'function' ? successText(result) : successText, 'success');
    return result;
  } catch (err) {
    toast(err.message || String(err), 'error');
    return undefined;
  }
}

export function confirmBox({ title, text, ok = 'Confirm', cancel = 'Cancel', danger = false }) {
  return webix.confirm({ title, text, ok, cancel, css: danger ? 'confirm-danger' : '' });
}

// ---------------------------------------------------------------------------
// CSV export
// Comma-separated values per RFC 4180: "," between fields, fields that contain
// a comma, a double quote or a line break are wrapped in double quotes (inner
// quotes doubled), CRLF line ends. UTF-8 with a byte-order mark so Excel keeps
// characters such as · and →. (webix.toCSV is not used: it writes tabs.)
// ---------------------------------------------------------------------------
export const CSV_DELIMITER = ',';
let textTpl = null;

/** Plain text of a rendered cell: tags out, entities decoded, action buttons left out. */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  if (!/[<&]/.test(value)) return value.replace(/\s+/g, ' ').trim();
  textTpl = textTpl || document.createElement('template');
  textTpl.innerHTML = value.replace(/<br\s*\/?>/gi, ' · ');
  const root = textTpl.content;
  root.querySelectorAll('.act').forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => el.append(' ')); // keeps "PN8" and "WHT26120" in two spans apart
  return root.textContent.replace(/\s+/g, ' ').trim();
}

/** One CSV field, quoted when it holds the delimiter, a quote, a line break or edge spaces. */
export function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (arrays of values) to CSV text. */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(CSV_DELIMITER)).join('\r\n') + '\r\n';
}

/** Column title for the export: header text without the filter row; '' for unlabelled (button) columns. */
function exportHeader(col) {
  if (col.exportHeader) return col.exportHeader;
  return []
    .concat(col.header ?? '')
    .filter((h) => h !== null && h !== undefined && (typeof h !== 'object' || !h.content))
    .map((h) => cellText(typeof h === 'object' ? h.text : h))
    .filter(Boolean)
    .join(' · ');
}

/**
 * What a datatable shows, as rows of plain values (header row first): visible
 * columns, rows in the current sort and filter. Action columns (id "actions",
 * no header, or noExport) are left out; a column can set exportAs(item) when
 * its cell is icons or buttons.
 */
export function tableRows(table) {
  const cols = table.config.columns.filter((c) => c.id !== 'actions' && !c.noExport && table.isColumnVisible(c.id) && exportHeader(c));
  const rows = [cols.map(exportHeader)];
  let index = 0;
  table.data.each((item) => {
    rows.push(
      cols.map((c) => {
        if (c.exportAs) return cellText(c.exportAs(item));
        if (typeof c.template === 'function') return cellText(c.template(item, table.type, item[c.id], c, index));
        return cellText(c.format ? c.format(item[c.id]) : item[c.id]);
      })
    );
    index += 1;
  });
  return rows;
}

/** Save text as a file through the browser download (works from disk too). */
export function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Export a datatable to a comma-separated CSV file (works offline). */
export function exportCsv(tableId, filename) {
  const table = webix.$$(tableId);
  if (!table) return;
  const name = `${String(filename || 'export').replace(/[/?\\<>:*|"]/g, '')}.csv`;
  try {
    downloadText('﻿' + toCsv(tableRows(table)), name, 'text/csv;charset=utf-8');
    toast(`Exported ${name}`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  }
}

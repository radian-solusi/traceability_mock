// Refresh a Webix datatable in place without losing scroll position, selection or filters.
import webix from '../lib/webix.js';

function sameRow(a, b) {
  for (const k of Object.keys(b)) {
    if (k[0] === '$') continue;
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    if (typeof vb === 'object' && vb !== null && JSON.stringify(va) === JSON.stringify(vb)) continue;
    return false;
  }
  return true;
}

export function syncTable(tableOrId, rows) {
  const table = typeof tableOrId === 'string' ? webix.$$(tableOrId) : tableOrId;
  if (!table || !table.$view || !document.body.contains(table.$view)) return;
  const order = table.data.order ? Array.from(table.data.order) : [];
  const sameShape = table.count() === rows.length && order.length === rows.length && rows.every((r, i) => String(order[i]) === String(r.id));
  if (sameShape) {
    rows.forEach((r) => {
      const cur = table.getItem(r.id);
      if (cur && !sameRow(cur, r)) table.updateItem(r.id, { ...r });
    });
    return;
  }
  const scroll = table.getScrollState ? table.getScrollState() : null;
  const selected = table.getSelectedId ? table.getSelectedId(false, true) : null;
  table.blockEvent();
  table.clearAll();
  table.parse(rows.map((r) => ({ ...r })));
  if (table.filterByAll) table.filterByAll();
  if (selected && table.exists(selected)) table.select(selected);
  table.unblockEvent();
  if (table.refresh) table.refresh();
  if (scroll) table.scrollTo(scroll.x, scroll.y);
}

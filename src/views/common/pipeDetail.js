// Quick-look window for a pipe (opened from any table).
import webix from '../../lib/webix.js';
import { getPipe } from '../../core/db.js';
import { pipeLabel } from '../../core/traceability.js';
import { pipeHeaderHtml, pipeTimelineHtml } from './timeline.js';
import { esc } from '../../core/format.js';

export function openPipeDetail(pipeId, ctx) {
  const pipe = getPipe(pipeId);
  if (!pipe) return;
  webix.$$('pipe-detail-win')?.destructor();
  const win = webix.ui({
    view: 'window',
    id: 'pipe-detail-win',
    modal: true,
    move: true,
    close: true,
    position: 'center',
    width: Math.min(720, window.innerWidth - 24),
    height: Math.min(720, window.innerHeight - 24),
    head: esc(`${pipeLabel(pipe)} · traceability record`),
    body: {
      rows: [
        { view: 'template', borderless: true, autoheight: true, template: () => pipeHeaderHtml(pipeId) },
        { view: 'scrollview', scroll: 'y', borderless: true, body: { view: 'template', borderless: true, autoheight: true, template: () => pipeTimelineHtml(pipeId) } },
        {
          view: 'toolbar',
          paddingX: 12,
          elements: [
            {},
            {
              view: 'button',
              value: 'Open full trace',
              css: 'btn-ghost',
              autowidth: true,
              click: () => {
                win.close();
                if (ctx) ctx.go('trace', pipeId);
                else location.hash = `trace-${pipeId.toLowerCase()}`;
              },
            },
            { view: 'button', value: 'Close', css: 'webix_primary', autowidth: true, click: () => win.close() },
          ],
        },
      ],
    },
  });
  if (ctx) ctx.track(win);
  win.show();
  return win;
}

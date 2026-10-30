import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const WEBIX_VERSION = pkg.dependencies.webix;

/**
 * Webix "dark" skin ships with a purple accent. Re-tint it to the same blue family
 * as the light (willow) skin so both themes share one identity.
 */
const DARK_SKIN_TINT = {
  '#7A67EB': '#2E8FD8',
  '#7a67eb': '#2E8FD8',
  '#6a55e9': '#2584CD',
  '#624ce7': '#2381CB',
  '#5a43e6': '#1F78BE',
  '#5643C7': '#1D6FAF',
  '#474678': '#24476A',
  '#423d66': '#1E3A57',
  '#3a3559': '#1C324B',
  'rgba(122, 103, 235, 0.6)': 'rgba(46, 143, 216, 0.6)',
  // neutral greys -> slightly navy greys of the same lightness (matches the app palette)
  '#2B343B': '#242F40',
  '#384047': '#2F3A4D',
  '#2A2B2D': '#1F2531',
  '#20262B': '#191F2A',
  '#2f363c': '#28313F',
  '#343b41': '#2C3645',
  '#262b30': '#1E242F',
  '#343d44': '#2C3848',
  '#24292d': '#1C222C',
  '#212223': '#1A1E26',
  '#111213': '#0D1016',
  '#1e1e20': '#171A21',
  '#252628': '#1D2029',
};

function webixDarkSkinTint() {
  return {
    name: 'ptct:webix-dark-skin-tint',
    enforce: 'pre',
    transform(code, id) {
      if (!/webix[\\/]skins[\\/]dark(\.min)?\.css/.test(id)) return null;
      let out = code;
      for (const [from, to] of Object.entries(DARK_SKIN_TINT)) out = out.split(from).join(to);
      return { code: out, map: null };
    },
  };
}

/**
 * @mdi/font references eot/woff/ttf/woff2. Every evergreen browser (incl. MS Edge on
 * the operator PCs) reads woff2, so drop the other formats to keep the bundle small.
 */
function mdiWoff2Only() {
  return {
    name: 'ptct:mdi-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/@mdi[\\/]font[\\/]css[\\/]materialdesignicons(\.min)?\.css/.test(id)) return null;
      const out = code.replace(
        /@font-face\s*{[^}]*}/,
        '@font-face{font-family:"Material Design Icons";src:url("../fonts/materialdesignicons-webfont.woff2?v=7.4.47") format("woff2");font-weight:normal;font-style:normal;font-display:block}'
      );
      return { code: out, map: null };
    },
  };
}

/**
 * `npm run build:demo` produces ONE self-contained HTML file (JS, CSS, fonts inlined)
 * that can be opened from disk or e-mailed to reviewers.
 */
function singleFile() {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    name: 'ptct:single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const htmlName of Object.keys(bundle).filter((f) => f.endsWith('.html'))) {
        const htmlAsset = bundle[htmlName];
        let html = String(htmlAsset.source);
        for (const [name, item] of Object.entries(bundle)) {
          if (item.type === 'chunk' && name.endsWith('.js')) {
            const re = new RegExp(`<script[^>]*src="[^"]*${escapeRe(name)}"[^>]*></script>`);
            if (re.test(html)) {
              const code = item.code.replace(/<\/script/gi, '<\\/script');
              html = html.replace(re, () => `<script type="module">\n${code}\n</script>`);
              delete bundle[name];
            }
          } else if (item.type === 'asset' && name.endsWith('.css')) {
            const re = new RegExp(`<link[^>]*href="[^"]*${escapeRe(name)}"[^>]*>`);
            if (re.test(html)) {
              html = html.replace(re, () => `<style>\n${String(item.source)}\n</style>`);
              delete bundle[name];
            }
          }
        }
        html = html.replace(/<link rel="modulepreload"[^>]*>\s*/g, '');
        htmlAsset.source = html;
      }
    },
  };
}

/**
 * Optional: load Webix from the jsDelivr CDN instead of bundling it
 * (set WEBIX_CDN=1). Used only for hosted previews; the real on-premise
 * deployment bundles everything because plant PCs may have no internet.
 */
function webixFromCdn() {
  return {
    name: 'ptct:webix-cdn',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { src: `https://cdn.jsdelivr.net/npm/webix@${WEBIX_VERSION}/webix.min.js` },
          injectTo: 'head',
        },
      ];
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const demo = mode === 'demo';
  const cdn = process.env.WEBIX_CDN === '1';
  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [webixDarkSkinTint(), mdiWoff2Only(), demo && singleFile(), cdn && webixFromCdn()].filter(Boolean),
    resolve: {
      alias: [
        cdn
          ? { find: /^webix$/, replacement: fileURLToPath(new URL('./src/lib/webix-global.js', import.meta.url)) }
          : // dev server: readable debug build of Webix; builds: the minified build (no debug warnings)
            { find: /^webix$/, replacement: command === 'serve' ? 'webix/webix.js' : 'webix/webix.min.js' },
      ],
    },
    server: { port: 5173, host: true },
    preview: { port: 4173, host: true },
    build: demo
      ? {
          outDir: 'dist-demo',
          assetsInlineLimit: () => true,
          cssCodeSplit: false,
          modulePreload: false,
          chunkSizeWarningLimit: 5000,
        }
      : {
          outDir: 'dist',
          chunkSizeWarningLimit: 2500,
        },
  };
});

import { defineConfig } from 'vite';

// Public address of the deployed site, used only for social-card tags (Open Graph needs absolute URLs).
// Override at build time: SITE_URL=https://example.com/busapp/ npm run build
const SITE_URL = (process.env.SITE_URL || 'https://alignmentlab.com/busapp/').replace(/\/?$/, '/');

// Optional live-arrivals proxy (Cloudflare Worker). Build with VITE_ARRIVALS_URL=https://... to turn it on.
const ARRIVALS_ORIGIN = process.env.VITE_ARRIVALS_URL ? new URL(process.env.VITE_ARRIVALS_URL).origin : '';

// Strict Content-Security-Policy for the production build: the page may only talk to the
// public data APIs, the map tile host and (if configured) BUNI's own arrivals proxy.
// Not applied in dev (Vite's HMR needs inline scripts).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://images.data.gov.sg",
  "font-src 'self' data:",
  `connect-src 'self' https://api-open.data.gov.sg https://api.data.gov.sg https://tiles.openfreemap.org${ARRIVALS_ORIGIN ? ' ' + ARRIVALS_ORIGIN : ''}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
  build: { target: 'es2022', chunkSizeWarningLimit: 3000, sourcemap: false, assetsInlineLimit: 0 },
  plugins: [
    {
      name: 'buni-html',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          html = html.replaceAll('%SITE_URL%', SITE_URL);
          if (!ctx.server) html = html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
          return html;
        },
      },
    },
  ],
});

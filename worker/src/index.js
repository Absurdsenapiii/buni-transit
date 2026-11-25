// BUNI Transit arrivals proxy (Cloudflare Worker).
// Holds the LTA DataMall AccountKey as the secret DATAMALL_KEY and answers
//   GET /arrivals?stop=01012   live bus arrivals for one stop (cached 20 s)
//   GET /health                whether the key is configured (never the key itself)
// The key never leaves this worker: it is not logged, returned or sent anywhere but DataMall.
import { shapeArrivals } from './arrivals.js';

const ALLOWED = [
  'https://absurdsenapiii.github.io',
  'http://localhost:4174', 'http://localhost:4186', 'http://localhost:5173', 'http://localhost:5186',
];
const TTL_MS = 20_000;
const memo = new Map(); // per-isolate cache: stop -> { at, body }

function headers(origin, extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}
const json = (obj, status, origin, extra) => new Response(JSON.stringify(obj), { status, headers: headers(origin, extra) });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    if (origin && !ALLOWED.includes(origin)) return json({ error: 'Origin not allowed' }, 403, origin);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) });
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin);

    if (url.pathname === '/health') return json({ ok: true, keyConfigured: !!env.DATAMALL_KEY }, 200, origin, { 'Cache-Control': 'no-store' });
    if (url.pathname !== '/arrivals') return json({ error: 'Not found' }, 404, origin);

    const stop = url.searchParams.get('stop') || '';
    if (!/^\d{5}$/.test(stop)) return json({ error: 'stop must be a 5-digit bus stop code' }, 400, origin);
    if (!env.DATAMALL_KEY) return json({ error: 'Arrivals are not configured yet' }, 503, origin);

    const now = Date.now();
    const hit = memo.get(stop);
    if (hit && now - hit.at < TTL_MS) {
      return new Response(hit.body, { status: 200, headers: headers(origin, { 'Cache-Control': 'public, max-age=20', 'X-Cache': 'HIT' }) });
    }

    let r;
    try {
      r = await fetch(`https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${stop}`, {
        headers: { AccountKey: env.DATAMALL_KEY, accept: 'application/json' },
        cf: { cacheTtl: 15, cacheEverything: true },
      });
    } catch {
      return json({ error: 'DataMall unreachable' }, 502, origin);
    }
    if (r.status === 401 || r.status === 403) return json({ error: 'DataMall rejected the configured key' }, 502, origin);
    if (!r.ok) return json({ error: `DataMall answered HTTP ${r.status}` }, 502, origin);

    const body = JSON.stringify(shapeArrivals(await r.json(), now));
    memo.set(stop, { at: now, body });
    if (memo.size > 600) memo.delete(memo.keys().next().value);
    return new Response(body, { status: 200, headers: headers(origin, { 'Cache-Control': 'public, max-age=20', 'X-Cache': 'MISS' }) });
  },
};

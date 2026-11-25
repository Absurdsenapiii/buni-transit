// Downloads the official LTA Bus Stop dataset from data.gov.sg and writes a compact copy
// for the app: public/data/stops.json = { updated, source, count, stops: [[code, lon, lat], ...] }
// Run: npm run data
import fs from 'node:fs/promises';

const DATASET = 'd_3f172c6feb3f4f92a2f47d93eed2908a';
const out = new URL('../public/data/stops.json', import.meta.url);

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

const meta = await getJson(`https://api-production.data.gov.sg/v2/public/api/datasets/${DATASET}/metadata`).catch(() => null);
const poll = await getJson(`https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET}/poll-download`);
if (!poll?.data?.url) throw new Error('data.gov.sg did not return a download link');
const geo = await getJson(poll.data.url);
if (geo.type !== 'FeatureCollection' || !geo.features?.length) throw new Error('Unexpected stops payload');

const stops = [];
for (const f of geo.features) {
  const [lon, lat] = f.geometry?.coordinates ?? [];
  const code = String(f.properties?.BUS_STOP_NUM ?? '').trim();
  if (!code || !(lat > 1.1 && lat < 1.5 && lon > 103.5 && lon < 104.2)) continue;
  stops.push([code, +lon.toFixed(6), +lat.toFixed(6)]);
}
stops.sort((a, b) => a[0].localeCompare(b[0]));

const updated = meta?.data?.lastUpdatedAt ?? meta?.data?.lastUpdated ?? null;
await fs.mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
await fs.writeFile(out, JSON.stringify({
  dataset: DATASET,
  source: `https://data.gov.sg/datasets/${DATASET}/view`,
  publisher: 'Land Transport Authority via data.gov.sg',
  datasetUpdated: updated,
  downloadedAt: new Date().toISOString(),
  count: stops.length,
  stops,
}));
console.log(`Wrote ${stops.length} of ${geo.features.length} stops; dataset updated ${updated ?? 'unknown'}`);

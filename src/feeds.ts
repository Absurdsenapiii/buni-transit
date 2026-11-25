// Live public feeds. Every request goes straight from the viewer's browser to the official API.
// No keys, no proxy, no server. A per-host queue keeps requests well under the published
// keyless limit, backs off on HTTP 429, and pauses while the tab is hidden.
import type { LonLat } from './geo.ts';
import type { ForecastArea, Gauge, RainFrame, Strike } from './analysis.ts';

export type FeedId = 'rain' | 'taxis' | 'lightning' | 'forecast' | 'temp' | 'cams';
export type FeedState = 'loading' | 'live' | 'stale' | 'error';

export interface FeedMeta {
  id: FeedId;
  label: string;
  publisher: string;
  endpoint: string;
  every: number;      // ms between refreshes while visible
  staleAfter: number; // ms after the observation time before we call it stale
  what: string;
}

const OPEN = 'https://api-open.data.gov.sg/v2/real-time/api';
const V1 = 'https://api.data.gov.sg/v1';
const MIN = 60_000;

export const FEEDS: Record<FeedId, FeedMeta> = {
  rain: { id: 'rain', label: 'Rainfall', publisher: 'Meteorological Service Singapore (NEA)', endpoint: `${OPEN}/rainfall`, every: 5 * MIN, staleAfter: 15 * MIN, what: 'Five-minute rain totals at about 87 gauges; the last two hours are loaded for replay.' },
  taxis: { id: 'taxis', label: 'Taxi availability', publisher: 'Land Transport Authority', endpoint: `${V1}/transport/taxi-availability`, every: 1 * MIN, staleAfter: 6 * MIN, what: 'GPS positions of every taxi currently free for hire.' },
  lightning: { id: 'lightning', label: 'Lightning', publisher: 'Meteorological Service Singapore (NEA)', endpoint: `${OPEN}/weather?api=lightning`, every: 5 * MIN, staleAfter: 20 * MIN, what: 'Located strikes in the latest observation, cloud-to-ground or cloud-to-cloud.' },
  forecast: { id: 'forecast', label: '2-hour forecast', publisher: 'Meteorological Service Singapore (NEA)', endpoint: `${OPEN}/two-hr-forecast`, every: 15 * MIN, staleAfter: 150 * MIN, what: 'Nowcast for 47 named areas, issued every half hour.' },
  temp: { id: 'temp', label: 'Air temperature', publisher: 'Meteorological Service Singapore (NEA)', endpoint: `${OPEN}/air-temperature`, every: 10 * MIN, staleAfter: 20 * MIN, what: 'Readings from about 17 weather stations.' },
  cams: { id: 'cams', label: 'Traffic cameras', publisher: 'Land Transport Authority', endpoint: `${V1}/transport/traffic-images`, every: 2 * MIN, staleAfter: 10 * MIN, what: 'Latest still from each expressway camera that is reporting.' },
};

export const FEED_ORDER: FeedId[] = ['rain', 'taxis', 'forecast', 'lightning', 'temp', 'cams'];

/* ---------------- payload types ---------------- */
export interface RainData { gauges: Gauge[]; frames: RainFrame[] }
export interface TaxiData { t: string; count: number; pos: LonLat[] }
export interface LightningData { t: string; strikes: Strike[] }
export interface ForecastData { t: string; issued: string; validText: string; validEnd: string; areas: ForecastArea[]; forecast: Map<string, string> }
export interface TempStation { id: string; name: string; pos: LonLat; value: number }
export interface TempData { t: string; stations: TempStation[] }
export interface Camera { id: string; pos: LonLat; image: string; t: string; w: number; h: number }
export interface CamData { t: string; cams: Camera[] }

export interface FeedPayloads {
  rain: RainData; taxis: TaxiData; lightning: LightningData; forecast: ForecastData; temp: TempData; cams: CamData;
}

export interface FeedStatus {
  state: FeedState;
  observedAt: string | null; // the source's own timestamp
  fetchedAt: number | null;  // when this browser last succeeded
  error: string | null;
  nextAt: number | null;
  latencyMs: number | null; // round trip of the last successful load
  requests: number;         // loads attempted this session
}

/* ---------------- request queue ---------------- */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RateLimited extends Error {}

class HostQueue {
  gap: number;
  last = 0;
  cooldownUntil = 0;
  chain: Promise<unknown> = Promise.resolve();
  constructor(gap: number) { this.gap = gap; }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const wait = Math.max(this.last + this.gap, this.cooldownUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    });
    this.chain = p.catch(() => undefined);
    return p;
  }
}

const queues = { open: new HostQueue(2200), v1: new HostQueue(1200) };

/** Network round trip (request to parsed JSON) of the last call to each endpoint, in ms. */
const fetchMs = new Map<string, number>();

async function getJson(url: string): Promise<any> {
  const q = url.startsWith(OPEN) ? queues.open : queues.v1;
  return q.run(async () => {
    const t0 = performance.now();
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
    if (r.status === 429) {
      q.cooldownUntil = Date.now() + 20000;
      throw new RateLimited('Rate limited by the source; retrying shortly');
    }
    if (!r.ok) throw new Error(`Source answered HTTP ${r.status}`);
    const j = await r.json();
    fetchMs.set(url.replace(/[?&]date=[^&]*/, ''), Math.round(performance.now() - t0));
    return j;
  });
}

/* ---------------- time helpers ---------------- */
export function sgtDate(ms: number): string {
  // YYYY-MM-DD in Singapore time (UTC+8, no daylight saving)
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const okPos = (lon: number, lat: number) => Number.isFinite(lon) && Number.isFinite(lat) && lat > 0.5 && lat < 2.5 && lon > 102.5 && lon < 105.5;

/* ---------------- parsers ---------------- */
function parseRainPage(j: any): RainData {
  const d = j?.data;
  if (!d || !Array.isArray(d.stations) || !Array.isArray(d.readings)) throw new Error('Unexpected rainfall payload');
  const gauges: Gauge[] = [];
  for (const s of d.stations) {
    const lon = num(s?.location?.longitude), lat = num(s?.location?.latitude);
    if (s?.id && okPos(lon, lat)) gauges.push({ id: String(s.id), name: String(s.name ?? s.id), pos: [lon, lat] });
  }
  const frames: RainFrame[] = [];
  for (const r of d.readings) {
    const ms = Date.parse(r?.timestamp);
    if (!Number.isFinite(ms) || !Array.isArray(r.data)) continue;
    const values = new Map<string, number>();
    for (const x of r.data) { const v = num(x?.value); if (x?.stationId && Number.isFinite(v) && v >= 0) values.set(String(x.stationId), v); }
    frames.push({ t: r.timestamp, ms, values });
  }
  return { gauges, frames };
}

async function loadRain(): Promise<RainData> {
  const now = Date.now();
  // Just after midnight (SGT) today's page is empty or short, and may even be refused:
  // fall back to and top up from yesterday so the replay keeps two hours.
  let today: RainData | null = null;
  let todayErr: unknown = null;
  try { today = parseRainPage(await getJson(`${OPEN}/rainfall?date=${sgtDate(now)}`)); } catch (e) { todayErr = e; }
  let frames = today?.frames ?? [];
  let gauges = today?.gauges ?? [];
  // The newest five-minute window fills in over a few minutes as stations report. A window counts
  // only once it holds at least 60% of the usual number of gauges (never fewer than 24 of ~88).
  const complete = (fs: RainFrame[]) => {
    const sizes = fs.map((f) => f.values.size).sort((a, b) => a - b);
    const usual = Math.max(sizes[Math.floor(sizes.length / 2)] ?? 0, 40);
    return fs.filter((f) => f.values.size >= usual * 0.6);
  };
  if (complete(frames).length < 13) {
    try {
      const prev = parseRainPage(await getJson(`${OPEN}/rainfall?date=${sgtDate(now - 86400_000)}`));
      frames = frames.concat(prev.frames);
      const seen = new Set(gauges.map((g) => g.id));
      gauges = gauges.concat(prev.gauges.filter((g) => !seen.has(g.id)));
    } catch (e) {
      // Without yesterday, carry on only if today already has a complete window; otherwise retry.
      if (!complete(frames).length) throw todayErr ?? e;
    }
  }
  const byT = new Map<number, RainFrame>();
  for (const f of frames) if (!byT.has(f.ms)) byT.set(f.ms, f);
  frames = complete([...byT.values()].sort((a, b) => a.ms - b.ms)).slice(-25);
  if (!frames.length || !gauges.length) throw new Error('Rainfall window still filling; retrying');
  return { gauges, frames };
}

async function loadTaxis(): Promise<TaxiData> {
  const j = await getJson(`${V1}/transport/taxi-availability`);
  const f = j?.features?.[0];
  const coords = f?.geometry?.coordinates;
  if (!Array.isArray(coords)) throw new Error('Unexpected taxi payload');
  const pos: LonLat[] = [];
  for (const c of coords) { const lon = num(c?.[0]), lat = num(c?.[1]); if (okPos(lon, lat)) pos.push([lon, lat]); }
  const t = f?.properties?.timestamp;
  if (!t) throw new Error('Taxi payload has no timestamp');
  return { t, count: pos.length, pos };
}

async function loadLightning(): Promise<LightningData> {
  const j = await getJson(`${OPEN}/weather?api=lightning`);
  const recs = j?.data?.records;
  if (!Array.isArray(recs)) throw new Error('Unexpected lightning payload');
  const strikes: Strike[] = [];
  let t = '';
  for (const rec of recs) {
    if (rec?.datetime && (!t || Date.parse(rec.datetime) > Date.parse(t))) t = rec.datetime;
    for (const r of rec?.item?.readings ?? []) {
      const lon = num(r?.location?.longitude), lat = num(r?.location?.latitude);
      if (!okPos(lon, lat)) continue;
      strikes.push({ pos: [lon, lat], kind: r.type === 'G' ? 'ground' : 'cloud', t: r.datetime ?? rec.datetime });
    }
  }
  if (!t) throw new Error('Lightning payload has no observation time');
  return { t, strikes };
}

async function loadForecast(): Promise<ForecastData> {
  const j = await getJson(`${OPEN}/two-hr-forecast`);
  const d = j?.data;
  const item = d?.items?.[0];
  if (!Array.isArray(d?.area_metadata) || !item) throw new Error('Unexpected forecast payload');
  const areas: ForecastArea[] = [];
  for (const a of d.area_metadata) {
    const lon = num(a?.label_location?.longitude), lat = num(a?.label_location?.latitude);
    if (a?.name && okPos(lon, lat)) areas.push({ name: a.name, pos: [lon, lat] });
  }
  const forecast = new Map<string, string>();
  for (const f of item.forecasts ?? []) if (f?.area) forecast.set(f.area, String(f.forecast ?? ''));
  return {
    t: item.update_timestamp ?? item.timestamp,
    issued: item.timestamp,
    validText: item.valid_period?.text ?? '',
    validEnd: item.valid_period?.end ?? '',
    areas,
    forecast,
  };
}

async function loadTemp(): Promise<TempData> {
  const j = await getJson(`${OPEN}/air-temperature`);
  const d = j?.data;
  const reading = [...(d?.readings ?? [])].sort((a: any, b: any) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (!Array.isArray(d?.stations) || !reading) throw new Error('Unexpected temperature payload');
  const values = new Map<string, number>();
  for (const x of reading.data ?? []) { const v = num(x?.value); if (Number.isFinite(v)) values.set(String(x.stationId), v); }
  const stations: TempStation[] = [];
  for (const s of d.stations) {
    const lon = num(s?.location?.longitude), lat = num(s?.location?.latitude);
    const v = values.get(String(s.id));
    if (okPos(lon, lat) && v !== undefined && v > 10 && v < 45) stations.push({ id: String(s.id), name: String(s.name ?? s.id), pos: [lon, lat], value: v });
  }
  return { t: reading.timestamp, stations };
}

async function loadCams(): Promise<CamData> {
  const j = await getJson(`${V1}/transport/traffic-images`);
  const item = j?.items?.[0];
  if (!item || !Array.isArray(item.cameras)) throw new Error('Unexpected camera payload');
  const cams: Camera[] = [];
  for (const c of item.cameras) {
    const lon = num(c?.location?.longitude), lat = num(c?.location?.latitude);
    if (!okPos(lon, lat) || typeof c?.image !== 'string' || !c.image.startsWith('https://images.data.gov.sg/')) continue;
    cams.push({ id: String(c.camera_id), pos: [lon, lat], image: c.image, t: c.timestamp, w: c.image_metadata?.width ?? 0, h: c.image_metadata?.height ?? 0 });
  }
  return { t: item.timestamp, cams };
}

const LOADERS: { [K in FeedId]: () => Promise<FeedPayloads[K]> } = {
  rain: loadRain, taxis: loadTaxis, lightning: loadLightning, forecast: loadForecast, temp: loadTemp, cams: loadCams,
};

/** Source timestamp of a payload, for staleness. */
function observedAtOf<K extends FeedId>(id: K, p: FeedPayloads[K]): string {
  if (id === 'rain') { const r = p as RainData; return r.frames[r.frames.length - 1].t; }
  return (p as { t: string }).t;
}

/* ---------------- feed manager ---------------- */
type Listener = (id: FeedId) => void;

export class FeedHub {
  data: Partial<FeedPayloads> = {};
  status: Record<FeedId, FeedStatus>;
  private timers = new Map<FeedId, number>();
  private failures = new Map<FeedId, number>();
  private listeners = new Set<Listener>();
  private running = new Set<FeedId>();

  constructor() {
    this.status = Object.fromEntries(FEED_ORDER.map((id) => [id, { state: 'loading', observedAt: null, fetchedAt: null, error: null, nextAt: null, latencyMs: null, requests: 0 }])) as Record<FeedId, FeedStatus>;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // Catch up on anything that fell due while hidden.
      for (const id of FEED_ORDER) { const s = this.status[id]; if (!s.nextAt || s.nextAt <= Date.now()) this.refresh(id); }
    });
    setInterval(() => this.recomputeStaleness(), 30_000);
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(id: FeedId) { for (const fn of this.listeners) fn(id); }

  start() { for (const id of FEED_ORDER) this.refresh(id); }

  private schedule(id: FeedId, delay: number) {
    clearTimeout(this.timers.get(id));
    this.status[id].nextAt = Date.now() + delay;
    this.timers.set(id, window.setTimeout(() => {
      if (document.hidden) { this.status[id].nextAt = Date.now(); return; } // resumes on visibilitychange
      this.refresh(id);
    }, delay));
  }

  async refresh(id: FeedId) {
    if (this.running.has(id)) return;
    this.running.add(id);
    const meta = FEEDS[id];
    this.status[id].requests++;
    try {
      const payload = await (LOADERS[id] as () => Promise<any>)();
      (this.data as any)[id] = payload;
      const s = this.status[id];
      s.latencyMs = fetchMs.get(meta.endpoint) ?? null;
      s.observedAt = observedAtOf(id, payload);
      s.fetchedAt = Date.now();
      s.error = null;
      s.state = Date.now() - Date.parse(s.observedAt) > meta.staleAfter ? 'stale' : 'live';
      this.failures.set(id, 0);
      this.schedule(id, meta.every);
    } catch (e) {
      const n = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, n);
      const s = this.status[id];
      s.error = e instanceof Error ? e.message : String(e);
      // Keep showing the last good data (marked stale) rather than inventing anything.
      s.state = this.data[id] ? 'stale' : 'error';
      const backoff = Math.min(meta.every, e instanceof RateLimited ? 25_000 * n : 15_000 * 2 ** Math.min(n, 4));
      this.schedule(id, backoff);
    } finally {
      this.running.delete(id);
      this.emit(id);
    }
  }

  private recomputeStaleness() {
    for (const id of FEED_ORDER) {
      const s = this.status[id];
      if (!s.observedAt || s.state === 'error') continue;
      const stale = Date.now() - Date.parse(s.observedAt) > FEEDS[id].staleAfter;
      const next: FeedState = stale ? 'stale' : s.error ? 'stale' : 'live';
      if (next !== s.state) { s.state = next; this.emit(id); }
    }
  }
}

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { FeedHub, FEEDS, FEED_ORDER, type FeedId, type FeedState } from './feeds.ts';
import { TransitMap, PRESETS, webglOK, timeSGT, esc, type Preset, type Scene, type LinkLine, type ViewInfo, type BusMark } from './map.ts';
import { ARRIVALS_URL, fetchArrivals, minsUntil, type Arrivals } from './arrivals.ts';
import { GridIndex, haversine, bearing, compass, quantile, geohash, dms, type LonLat } from './geo.ts';
import {
  BANDS, linkStopsToGauges, exposureFor, summariseExposure, nearestAreaIndex, isWetForecast, forecastTone, mmPerHour, rainBand,
  fmtDistance, areaStats, conditionLevel, type Exposure, type StopGaugeLinks, type RainFrame, type Gauge, type RainBand, type Level, type AreaStat,
} from './analysis.ts';
import { rainSignals, mergeSignals, RANK, type Signal, type SigKind, type Sev } from './events.ts';
import { BAND_LABEL, BAND_RGBA, C, css, type Lens, type LayerKey, type Selection } from './state.ts';
import { buildShell, icon, sparkline, bars, linkGraph, toast, fmtInt, countTo, type Refs } from './ui.ts';

declare const __BUILD__: string;
const VERSION = '1.2.0';
const REPO = 'https://github.com/Absurdsenapiii/buni-transit';
const CENTRE: LonLat = [103.8198, 1.3521];
const TAXI_NEAR = 500;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const stillMode = new URLSearchParams(location.search).has('still');
const HEX = { cyan: '#2fe0ff', green: '#35f2a1', amber: '#ffb020', red: '#ff4d4d', violet: '#b28cff', white: '#e6fcff', dim: '#56707a' };

/* ---------------- boot ---------------- */
const root = document.getElementById('app')!;
const refs: Refs = buildShell(root, Object.entries(PRESETS).map(([key, p]) => ({ key, code: p.code, label: p.label })));
root.dataset.mtab = 'sitrep';

interface StopsFile { datasetUpdated: string | null; downloadedAt: string; count: number; source: string; stops: [string, number, number][] }
const stopsFile: StopsFile = await fetch('./data/stops.json').then((r) => r.json());
const codes = stopsFile.stops.map((s) => s[0]);
const stops: LonLat[] = stopsFile.stops.map((s) => [s[1], s[2]]);
const codeToIdx = new Map(codes.map((c, i) => [c, i]));
const stopGrid = new GridIndex(stops, 600);

const hub = new FeedHub();
const has3D = webglOK();
let tmap: TransitMap | null = null;

const st = {
  lens: 'pulse' as Lens,
  on: { stops: true, rain: true, taxis: true, lightning: true, cams: true, forecast: true, grid: true } as Record<LayerKey, boolean>,
  links: null as StopGaugeLinks | null,
  gaugesKey: '',
  nearest1km: 0,
  nearestMedian: NaN,
  frameIdx: -1, // -1 means "latest"
  exposure: null as Exposure | null,
  liveExposure: null as Exposure | null,
  exposureVersion: 0,
  frameStats: [] as { wetGauges: number; wetStops: number; max: number }[],
  stopArea: null as Uint8Array | null,
  taxiArea: null as Uint8Array | null,
  areasKey: '',
  taxiGrid: null as GridIndex | null,
  hist: { taxis: [] as [number, number][], lightning: [] as [number, number][], temp: [] as [number, number][] },
  areaTaxiHist: [] as { t: number; counts: Map<string, number> }[],
  bolt: { any: null as null | { strike: number; stop: number; d: number }, ground: null as null | { strike: number; stop: number; d: number } },
  selection: null as Selection | null,
  playing: false,
  playTimer: 0,
  lastState: {} as Partial<Record<FeedId, FeedState>>,
  signals: [] as Signal[],
  sigSeen: new Set<string>(),
  sigFilter: 'all' as SigKind | 'all',
  rightTab: 'areas' as 'entity' | 'areas' | 'feeds',
  areaSort: { key: 'wet' as keyof AreaRow, dir: -1 },
  level: { level: 'nominal' as Level, reasons: [] as string[] },
  prevForecast: null as Map<string, string> | null,
  view: null as ViewInfo | null,
  cursor: null as LonLat | null,
  arr: null as null | { stop: string; data: Arrivals | null; error: string | null; loading: boolean },
  arrTimer: 0,
  arrStats: { ok: 0, fail: 0, lastAt: null as number | null, lastError: null as string | null },
};
interface AreaRow extends AreaStat { wetPct: number; d10: number | null }

/* ---------------- derived data ---------------- */
const rain = () => hub.data.rain;
const frames = (): RainFrame[] => rain()?.frames ?? [];
const gauges = (): Gauge[] => rain()?.gauges ?? [];
const liveIdx = () => frames().length - 1;
const frameIndex = () => (st.frameIdx < 0 ? liveIdx() : Math.min(st.frameIdx, liveIdx()));
const currentFrame = (): RainFrame | null => frames()[frameIndex()] ?? null;
const liveFrame = (): RainFrame | null => frames()[liveIdx()] ?? null;
const isLive = () => st.frameIdx < 0 || st.frameIdx >= liveIdx();
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const shortName = (s: string) => s.replace(/\bStreet\b/g, 'St').replace(/\bAvenue\b/g, 'Ave').replace(/\bRoad\b/g, 'Rd').replace(/\bDrive\b/g, 'Dr');
const up = (s: string) => s.toUpperCase();

function recomputeRain() {
  const g = gauges();
  const key = g.map((x) => x.id).join(',');
  if (key !== st.gaugesKey) {
    st.gaugesKey = key;
    st.links = linkStopsToGauges(stops, g, 4);
    const d: number[] = [];
    let n1 = 0;
    for (let s = 0; s < stops.length; s++) { const v = st.links.dist[s * st.links.k]; d.push(v); if (v <= 1000) n1++; }
    d.sort((a, b) => a - b);
    st.nearest1km = n1;
    st.nearestMedian = quantile(d, 0.5);
  }
  st.frameStats = frames().map((f) => {
    const e = exposureFor(st.links!, g, f, stops.length);
    let wetGauges = 0, max = 0;
    for (const v of f.values.values()) { if (v > 0) wetGauges++; if (v > max) max = v; }
    return { wetGauges, wetStops: summariseExposure(e).wetStops, max };
  });
  st.liveExposure = exposureFor(st.links!, g, liveFrame(), stops.length);
  updateExposure();
}

function updateExposure() {
  if (!st.links) return;
  st.exposure = exposureFor(st.links, gauges(), currentFrame(), stops.length);
  st.exposureVersion++;
}

function recomputeAreas() {
  const f = hub.data.forecast;
  if (!f) return;
  const key = f.areas.map((a) => a.name).join('|');
  if (key !== st.areasKey) { st.areasKey = key; st.stopArea = nearestAreaIndex(stops, f.areas); }
  if (hub.data.taxis) st.taxiArea = nearestAreaIndex(hub.data.taxis.pos, f.areas);
}

/** Nearest bus stop to a point, using the grid first and brute force only when far away. */
function nearestStop(p: LonLat): { i: number; d: number } {
  for (const r of [400, 1500, 5000]) {
    const c = stopGrid.within(p, r);
    if (c.length) { let best = { i: c[0], d: Infinity }; for (const i of c) { const d = haversine(p, stops[i]); if (d < best.d) best = { i, d }; } return best; }
  }
  let best = { i: 0, d: Infinity };
  for (let i = 0; i < stops.length; i++) { const d = haversine(p, stops[i]); if (d < best.d) best = { i, d }; }
  return best;
}

function recomputeLightning() {
  const strikes = hub.data.lightning?.strikes ?? [];
  const best = (subset: number[]) => {
    let b: { strike: number; stop: number; d: number } | null = null;
    for (const i of subset.sort((x, y) => haversine(CENTRE, strikes[x].pos) - haversine(CENTRE, strikes[y].pos)).slice(0, 30)) {
      const n = nearestStop(strikes[i].pos);
      if (!b || n.d < b.d) b = { strike: i, stop: n.i, d: n.d };
    }
    return b;
  };
  st.bolt.any = best(strikes.map((_, i) => i));
  st.bolt.ground = best(strikes.map((s, i) => (s.kind === 'ground' ? i : -1)).filter((i) => i >= 0));
}

function recomputeLevel() {
  const f = liveFrame();
  let maxBand: RainBand = 'dry';
  if (f) for (const v of f.values.values()) { const b = rainBand(v); if (RANK[b] > RANK[maxBand]) maxBand = b; }
  const fc = hub.data.forecast;
  const tones = fc ? fc.areas.map((a) => forecastTone(fc.forecast.get(a.name))) : [];
  const next = conditionLevel({
    maxBand,
    groundStrikeKm: st.bolt.ground ? st.bolt.ground.d / 1000 : null,
    anyStrikeKm: st.bolt.any ? st.bolt.any.d / 1000 : null,
    thunderAreas: tones.filter((t) => t === 'storm').length,
    wetAreas: tones.filter((t) => t === 'rain' || t === 'storm').length,
  });
  if (next.level !== st.level.level && (hub.data.rain || hub.data.lightning)) {
    signal([{ id: `lvl:${next.level}:${Date.now()}`, t: Date.now(), kind: 'sys', sev: next.level === 'alert' ? 'alert' : next.level === 'watch' ? 'watch' : 'info', title: `CONDITION LEVEL → ${up(next.level)}`, detail: next.reasons.join(' · ') || 'No rule triggered' }]);
  }
  st.level = next;
}

const pushHist = (arr: [number, number][], t: string, v: number) => {
  const ms = Date.parse(t);
  if (!arr.length || arr[arr.length - 1][0] !== ms) arr.push([ms, v]);
  if (arr.length > 240) arr.shift();
};

function signal(list: Signal[]) { if (mergeSignals(st.signals, st.sigSeen, list)) invalidate(); }

/* ---------------- feed events → signals ---------------- */
hub.on((id) => {
  const d = hub.data;
  const s = hub.status[id];
  const prev = st.lastState[id];
  const now = Date.now();

  if (id === 'rain' && d.rain) {
    recomputeRain();
    signal(rainSignals(d.rain.gauges, d.rain.frames));
    recomputeLevel();
  }
  if (id === 'forecast' && d.forecast) {
    recomputeAreas();
    const fc = d.forecast;
    const issued = Date.parse(fc.issued);
    if (!st.prevForecast) {
      const wet = fc.areas.filter((a) => isWetForecast(fc.forecast.get(a.name)));
      signal([{ id: `fcst:issued:${issued}`, t: issued, kind: 'fcst', sev: wet.some((a) => forecastTone(fc.forecast.get(a.name)) === 'storm') ? 'watch' : 'info', title: `2H FORECAST · ${wet.length}/${fc.areas.length} AREAS RAIN`, detail: wet.length ? `${wet.slice(0, 4).map((a) => a.name).join(', ')}${wet.length > 4 ? ' …' : ''} · ${fc.validText}` : `No rain expected · ${fc.validText}` }]);
    } else {
      const changes: Signal[] = [];
      for (const a of fc.areas) {
        const was = st.prevForecast.get(a.name), is = fc.forecast.get(a.name) ?? '';
        if (was !== undefined && was !== is) changes.push({ id: `fcst:${a.name}:${issued}`, t: issued, kind: 'fcst', sev: forecastTone(is) === 'storm' ? 'watch' : 'info', title: `FORECAST CHANGE · ${up(a.name)}`, detail: `${was} → ${is}`, pos: a.pos, area: a.name });
      }
      signal(changes);
    }
    st.prevForecast = new Map(fc.forecast);
    recomputeLevel();
  }
  if (id === 'taxis' && d.taxis) {
    st.taxiGrid = new GridIndex(d.taxis.pos, 400);
    pushHist(st.hist.taxis, d.taxis.t, d.taxis.count);
    recomputeAreas();
    const ms = Date.parse(d.taxis.t);
    if (st.taxiArea && d.forecast) {
      const counts = new Map<string, number>();
      for (let i = 0; i < st.taxiArea.length; i++) { const n = d.forecast.areas[st.taxiArea[i]]?.name; if (n) counts.set(n, (counts.get(n) ?? 0) + 1); }
      st.areaTaxiHist.push({ t: ms, counts });
      if (st.areaTaxiHist.length > 60) st.areaTaxiHist.shift();
    }
    const h = st.hist.taxis;
    if (h.length === 1) signal([{ id: `taxi:init`, t: ms, kind: 'taxi', sev: 'info', title: `TAXI FLEET · ${fmtInt(d.taxis.count)} AVAILABLE`, detail: 'Live GPS of every taxi free for hire (LTA)' }]);
    const ref = h.find((x) => ms - x[0] >= 9 * 60000 && ms - x[0] <= 15 * 60000);
    if (ref) {
      const pct = ((d.taxis.count - ref[1]) / ref[1]) * 100;
      const bucket = Math.floor(ms / 600000);
      if (Math.abs(pct) >= 3) signal([{ id: `taxi:delta:${bucket}`, t: ms, kind: 'taxi', sev: 'watch', title: `TAXI SUPPLY ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% / 10 MIN`, detail: `${fmtInt(ref[1])} → ${fmtInt(d.taxis.count)} available` }]);
      const old = st.areaTaxiHist.find((x) => ms - x.t >= 9 * 60000 && ms - x.t <= 15 * 60000);
      const cur = st.areaTaxiHist[st.areaTaxiHist.length - 1];
      if (old && cur && d.forecast) {
        const drops: Signal[] = [];
        for (const a of d.forecast.areas) {
          const o = old.counts.get(a.name) ?? 0, c = cur.counts.get(a.name) ?? 0;
          if (o >= 15 && c <= o * 0.6) drops.push({ id: `taxi:area:${a.name}:${bucket}`, t: ms, kind: 'taxi', sev: 'watch', title: `SUPPLY DROP · ${up(a.name)}`, detail: `${o} → ${c} free taxis in 10 min`, pos: a.pos, area: a.name });
        }
        signal(drops);
      }
    }
  }
  if (id === 'lightning' && d.lightning) {
    pushHist(st.hist.lightning, d.lightning.t, d.lightning.strikes.length);
    recomputeLightning();
    const L = d.lightning;
    const ms = Date.parse(L.t);
    const n = L.strikes.length;
    const prevN = st.hist.lightning.length > 1 ? st.hist.lightning[st.hist.lightning.length - 2][1] : -1;
    if (n) {
      const g = L.strikes.filter((k) => k.kind === 'ground').length;
      const a = st.bolt.any!;
      const sev: Sev = st.bolt.ground && st.bolt.ground.d <= 10000 ? 'alert' : a.d <= 30000 ? 'watch' : 'info';
      signal([{ id: `bolt:${ms}`, t: ms, kind: 'bolt', sev, title: `LIGHTNING · ${n} STRIKE${n > 1 ? 'S' : ''} LOCATED`, detail: `${g} cloud-to-ground · nearest ${fmtDistance(a.d)} ${compass(bearing(stops[a.stop], L.strikes[a.strike].pos))} of stop ${codes[a.stop]}`, pos: L.strikes[a.strike].pos }]);
      const near: Signal[] = [];
      L.strikes.forEach((k) => {
        if (k.kind !== 'ground') return;
        const ns = nearestStop(k.pos);
        if (ns.d <= 15000) near.push({ id: `bolt:g:${ms}:${k.pos[0].toFixed(4)},${k.pos[1].toFixed(4)}`, t: Date.parse(k.t) || ms, kind: 'bolt', sev: ns.d <= 10000 ? 'alert' : 'watch', title: `CLOUD-TO-GROUND · ${fmtDistance(ns.d)} FROM STOP ${codes[ns.i]}`, detail: `${k.pos[1].toFixed(4)}°N ${k.pos[0].toFixed(4)}°E`, pos: k.pos });
      });
      signal(near.slice(0, 12));
    } else if (prevN !== 0) {
      signal([{ id: `bolt:clear:${ms}`, t: ms, kind: 'bolt', sev: 'info', title: 'LIGHTNING · NONE LOCATED', detail: `Latest NEA observation ${timeSGT(L.t)}` }]);
    }
    recomputeLevel();
  }
  if (id === 'temp' && d.temp && d.temp.stations.length) {
    const v = d.temp.stations.map((x) => x.value);
    pushHist(st.hist.temp, d.temp.t, avg(v));
    const hot = d.temp.stations.reduce((a, b) => (b.value > a.value ? b : a));
    const ms = Date.parse(d.temp.t);
    signal([{ id: `temp:${Math.floor(ms / 3600000)}`, t: ms, kind: 'temp', sev: 'info', title: `AIR TEMP · MEAN ${avg(v).toFixed(1)}°C`, detail: `Max ${hot.value.toFixed(1)}°C at ${hot.name} · ${v.length} stations`, pos: hot.pos }]);
  }
  if (id === 'cams' && d.cams) {
    signal([{ id: `cams:${d.cams.cams.length}`, t: Date.parse(d.cams.t) || now, kind: 'cam', sev: 'info', title: `CAMERA NETWORK · ${d.cams.cams.length} ONLINE`, detail: 'LTA expressway cameras reporting a still' }]);
  }

  // Uplink and health signals.
  if (s.state === 'live' && !prev) {
    signal([{ id: `sys:up:${id}`, t: now, kind: 'sys', sev: 'info', title: `UPLINK · ${up(FEEDS[id].label)} OK`, detail: `${feedSummary(id)}${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''}` }]);
  }
  if (prev && prev !== s.state && (s.state === 'error' || (s.state === 'stale' && s.error))) {
    signal([{ id: `sys:${id}:${now}`, t: now, kind: 'sys', sev: 'watch', title: `FEED DEGRADED · ${up(FEEDS[id].label)}`, detail: `${s.error ?? 'Source is late'}. ${d[id] ? 'Holding last good reading.' : 'Retrying.'}` }]);
  }
  if (prev && (prev === 'error' || prev === 'stale') && s.state === 'live') {
    signal([{ id: `sys:back:${id}:${now}`, t: now, kind: 'sys', sev: 'info', title: `FEED RESTORED · ${up(FEEDS[id].label)}`, detail: feedSummary(id) }]);
  }
  st.lastState[id] = s.state;
  invalidate();
});

function feedSummary(id: FeedId): string {
  const d = hub.data;
  switch (id) {
    case 'rain': return d.rain ? `${d.rain.gauges.length} stations · ${d.rain.frames.length} frames` : '';
    case 'taxis': return d.taxis ? `${fmtInt(d.taxis.count)} units` : '';
    case 'forecast': return d.forecast ? `${d.forecast.areas.length} areas` : '';
    case 'lightning': return d.lightning ? `${d.lightning.strikes.length} events` : '';
    case 'temp': return d.temp ? `${d.temp.stations.length} stations` : '';
    case 'cams': return d.cams ? `${d.cams.cams.length} online` : '';
  }
}

/* ---------------- map ---------------- */
if (has3D) {
  tmap = new TransitMap(refs.map, {
    onSelect: (s) => select(s, false),
    onUserMove: () => setOrbitUI(false),
    onView: (v) => { st.view = v; hudView(); },
    onCursor: (p) => { st.cursor = p; hudReadout(); },
  });
  // Development-only handle for testing (stripped from production builds).
  if (import.meta.env.DEV) (window as any).__buni = { tmap, hub, st, recomputeRain: () => recomputeRain(), setFrame: (i: number) => setFrame(i), invalidate: () => invalidate() };
} else {
  refs.map.innerHTML = `<div class="nogl"><b>3D VIEW UNAVAILABLE</b><p>WebGL 2 is turned off on this device, so the map can't be drawn. Signals, indicators, areas and the camera wall still work.</p></div>`;
}

function sceneNow(): Scene {
  const d = hub.data;
  return {
    lens: st.lens, on: st.on, stops, codes,
    exposure: st.exposure, exposureVersion: st.exposureVersion,
    gauges: gauges(), frame: currentFrame(),
    taxis: d.taxis?.pos ?? [], strikes: d.lightning?.strikes ?? [], cams: d.cams?.cams ?? [],
    areas: d.forecast?.areas ?? [], forecast: d.forecast?.forecast ?? null,
    selection: st.selection, focus: focusFor(st.selection),
  };
}

/** Link analysis for the selected asset: what it is connected to, drawn as arcs on the map. */
function focusFor(s: Selection | null): Scene['focus'] {
  if (!s) return null;
  const d = hub.data;
  const links: LinkLine[] = [];
  const area = (p: LonLat) => { const fc = d.forecast; if (!fc || !fc.areas.length) return null; let b = fc.areas[0], bd = Infinity; for (const a of fc.areas) { const x = haversine(p, a.pos); if (x < bd) { bd = x; b = a; } } return b; };
  const cam = (p: LonLat, max: number) => { const cs = d.cams?.cams ?? []; let b = null as null | { c: (typeof cs)[0]; d: number }; for (const c of cs) { const x = haversine(p, c.pos); if (x <= max && (!b || x < b.d)) b = { c, d: x }; } return b; };
  const addArea = (p: LonLat) => { const a = area(p); if (a) links.push({ to: a.pos, color: C.area, label: `AREA ${up(a.name)}` }); };
  const addCam = (p: LonLat, max = 8000) => { const c = cam(p, max); if (c) links.push({ to: c.c.pos, color: C.cam, label: `CAM ${c.c.id} · ${fmtDistance(c.d)}` }); };
  if (s.kind === 'stop') {
    const at = stops[s.i];
    const e = st.exposure;
    const gi = e ? e.gauge[s.i] : -1;
    if (gi >= 0) { const g = gauges()[gi]; links.push({ to: g.pos, color: BAND_RGBA[BANDS[e!.band[s.i]]].slice(0, 3).concat(255) as any, label: `GAUGE ${g.id} · ${fmtDistance(e!.dist[s.i])}` }); }
    addArea(at); addCam(at);
    const strikes = d.lightning?.strikes ?? [];
    let bs: { k: (typeof strikes)[0]; d: number } | null = null;
    for (const k of strikes) { const x = haversine(at, k.pos); if (x <= 60000 && (!bs || x < bs.d)) bs = { k, d: x }; }
    if (bs) links.push({ to: bs.k.pos, color: C.ground, label: `STRIKE · ${fmtDistance(bs.d)}` });
    const buses: BusMark[] = [];
    if (st.arr?.stop === codes[s.i] && st.arr.data) {
      for (const svc of st.arr.data.services) for (const b of svc.buses) {
        if (!b.pos || b.visit > 1) continue;
        const m = minsUntil(b.eta);
        buses.push({ pos: b.pos, label: `${svc.no} · ${m <= 0 ? 'ARR' : m + 'M'}`, monitored: b.monitored, load: b.load });
      }
    }
    return { at, ring: TAXI_NEAR, links, buses };
  }
  if (s.kind === 'gauge') {
    const g = gauges().find((x) => x.id === s.id);
    if (!g) return null;
    stopGrid.within(g.pos, 1500).map((i) => ({ i, d: haversine(g.pos, stops[i]) })).sort((a, b) => a.d - b.d).slice(0, 3)
      .forEach((n) => links.push({ to: stops[n.i], color: C.select, label: `STOP ${codes[n.i]}` }));
    addArea(g.pos); addCam(g.pos, 10000);
    return { at: g.pos, links };
  }
  if (s.kind === 'cam') {
    const c = d.cams?.cams.find((x) => x.id === s.id);
    if (!c) return null;
    stopGrid.within(c.pos, 1200).map((i) => ({ i, d: haversine(c.pos, stops[i]) })).sort((a, b) => a.d - b.d).slice(0, 3)
      .forEach((n) => links.push({ to: stops[n.i], color: C.select, label: `STOP ${codes[n.i]} · ${fmtDistance(n.d)}` }));
    addArea(c.pos);
    return { at: c.pos, links };
  }
  if (s.kind === 'strike') {
    const k = d.lightning?.strikes[s.i];
    if (!k) return null;
    const n = nearestStop(k.pos);
    links.push({ to: stops[n.i], color: C.select, label: `STOP ${codes[n.i]} · ${fmtDistance(n.d)}` });
    return { at: k.pos, links };
  }
  const a = d.forecast?.areas.find((x) => x.name === s.name);
  if (!a) return null;
  gauges().map((g) => ({ g, d: haversine(a.pos, g.pos) })).sort((x, y) => x.d - y.d).slice(0, 3).forEach((n) => {
    const v = liveFrame()?.values.get(n.g.id);
    links.push({ to: n.g.pos, color: BAND_RGBA[rainBand(v)].slice(0, 3).concat(255) as any, label: `GAUGE ${n.g.id} · ${v === undefined ? 'N/A' : v.toFixed(1) + 'MM'}` });
  });
  addCam(a.pos, 10000);
  return { at: a.pos, ring: 1500, links };
}

/* ---------------- rendering ---------------- */
// Render on the next frame, with a timer fallback for webviews that pause animation frames.
let raf = 0;
let rafTimer = 0;
function invalidate() {
  if (raf) return;
  const run = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    clearTimeout(rafTimer);
    raf = 0;
    renderAll();
  };
  raf = requestAnimationFrame(run);
  rafTimer = window.setTimeout(run, 300);
}

function renderAll() {
  tmap?.render(sceneNow());
  renderSys();
  renderTicker();
  renderSitrep();
  renderMetrics();
  renderSignals();
  renderRight();
  renderTimeline();
  renderCams();
  renderBoot();
  if (!refs.page.hidden && currentPage === 'sources') renderPage('sources');
}

const setHTML = (el: HTMLElement, html: string) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const stateOf = (id: FeedId): FeedState => hub.status[id].state;

function renderSys() {
  const lv = st.level.level;
  refs.level.dataset.level = lv;
  refs.level.querySelector('b')!.textContent = up(lv);
  refs.level.title = st.level.reasons.join(' · ') || 'No rule triggered';
  const live = FEED_ORDER.filter((id) => stateOf(id) === 'live').length;
  refs.feedsCount.textContent = `${live}/${FEED_ORDER.length}`;
  refs.feedsCount.parentElement!.dataset.ok = String(live === FEED_ORDER.length);
  refs.reqCount.textContent = String(FEED_ORDER.reduce((a, id) => a + hub.status[id].requests, 0));
}

let tickerKey = '';
function renderTicker() {
  const top = st.signals.slice(0, 16);
  const key = top.map((s) => s.id).join('|');
  if (key === tickerKey || !top.length) return;
  tickerKey = key;
  const items = top.map((s) => `<span class="tk-i sev-${s.sev}"><time>${timeSGT(s.t)}</time><b>${esc(s.title)}</b><span>${esc(s.detail)}</span></span>`).join('<i class="tk-sep">◆</i>');
  refs.ticker.innerHTML = `<div class="tk-run">${items}<i class="tk-sep">◆</i></div><div class="tk-run" aria-hidden="true">${items}<i class="tk-sep">◆</i></div>`;
  const len = top.reduce((a, s) => a + s.title.length + s.detail.length, 0);
  refs.ticker.style.setProperty('--dur', `${Math.max(40, len / 7)}s`);
}

function renderSitrep() {
  const d = hub.data;
  const f = liveFrame();
  refs.sitrepT.textContent = `${timeSGT(Date.now())} SGT`;
  if (!d.rain && !d.taxis) return;
  const li = (k: string, html: string, cls = '') => `<li class="${cls}"><span class="k">${k}</span><span>${html}</span></li>`;
  const out: string[] = [];
  if (d.rain && f) {
    const wet = gauges().filter((g) => (f.values.get(g.id) ?? 0) > 0).sort((a, b) => f.values.get(b.id)! - f.values.get(a.id)!);
    const rep = gauges().filter((g) => f.values.has(g.id)).length;
    out.push(li('WX', wet.length ? `Rain at <b>${wet.length}/${rep}</b> gauges. Heaviest <b>${esc(up(shortName(wet[0].name)))}</b> ${mmPerHour(f.values.get(wet[0].id)!).toFixed(1)} mm/h (${BAND_LABEL[rainBand(f.values.get(wet[0].id))].toLowerCase()}).` : `No rain at <b>${rep}</b> reporting gauges, five minutes to ${timeSGT(f.t)}.`));
    if (st.liveExposure) {
      const sum = summariseExposure(st.liveExposure);
      out.push(li('NET', `<b>${fmtInt(sum.wetStops)}</b> of ${fmtInt(stops.length)} stops under rain by nearest gauge (median ${fmtDistance(st.nearestMedian)} away).`));
    }
  }
  if (d.forecast) {
    const wet = d.forecast.areas.filter((a) => isWetForecast(d.forecast!.forecast.get(a.name)));
    out.push(li('FCST', wet.length ? `<b>${wet.length}/${d.forecast.areas.length}</b> areas expect rain, ${esc(d.forecast.validText)}: ${wet.slice(0, 3).map((a) => esc(up(a.name))).join(', ')}${wet.length > 3 ? ' …' : ''}.` : `No area expects rain, ${esc(d.forecast.validText)}.`));
  }
  if (d.lightning) {
    const n = d.lightning.strikes.length, a = st.bolt.any;
    out.push(li('LTG', n && a ? `<b>${n}</b> strike${n > 1 ? 's' : ''} located; nearest <b>${fmtDistance(a.d)}</b> ${compass(bearing(stops[a.stop], d.lightning.strikes[a.strike].pos))} of stop ${codes[a.stop]}.` : 'No lightning located in the latest observation.'));
  }
  if (d.taxis) {
    const h = st.hist.taxis;
    const delta = h.length > 1 ? ((h[h.length - 1][1] - h[0][1]) / h[0][1]) * 100 : null;
    out.push(li('TAXI', `<b>${fmtInt(d.taxis.count)}</b> free for hire${delta !== null ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% this session` : ''}.`));
  }
  out.push(ARRIVALS_URL
    ? li('BUS', 'Live arrivals on demand: lock any stop for LTA arrival times and estimated bus positions. No delays are inferred.')
    : li('BUS', `Live arrivals unfinished: built, not yet connected. Open source, <a href="${REPO}" target="_blank" rel="noopener">help finish it</a>.`, 'off'));
  const lv = st.level;
  setHTML(refs.sitrep, `<div class="sr-head"><span class="lvl-tag" data-level="${lv.level}">${up(lv.level)}</span><span class="sr-why">${lv.reasons.length ? esc(lv.reasons.join(' · ')) : 'No condition rule triggered'}</span></div><ul class="sr">${out.join('')}</ul>`);
}

/* Indicators are built once, then updated in place so numbers can count up. */
const MET = [
  { k: 'rain', label: 'GAUGES WET', color: HEX.cyan, feed: 'rain' },
  { k: 'stops', label: 'STOPS UNDER RAIN', color: '#2fa8ff', feed: 'rain' },
  { k: 'taxis', label: 'TAXIS FREE', color: HEX.amber, feed: 'taxis' },
  { k: 'bolt', label: 'LIGHTNING', color: HEX.red, feed: 'lightning' },
  { k: 'fcst', label: 'AREAS RAIN FCST', color: HEX.violet, feed: 'forecast' },
  { k: 'temp', label: 'AIR TEMP °C', color: '#ff8a3d', feed: 'temp' },
] as const;
refs.metrics.innerHTML = MET.map((m) => `<div class="met is-loading" data-k="${m.k}" style="--mc:${m.color}"><div class="m-top"><span>${m.label}</span><i class="st"></i></div><div class="m-val"><b class="num">—</b><small class="unit"></small></div><div class="m-foot">&nbsp;</div><div class="m-spark"></div></div>`).join('');
const met = (k: string) => {
  const el = refs.metrics.querySelector(`[data-k="${k}"]`) as HTMLElement;
  return { el, num: el.querySelector('.num') as HTMLElement, unit: el.querySelector('.unit') as HTMLElement, foot: el.querySelector('.m-foot') as HTMLElement, spark: el.querySelector('.m-spark') as HTMLElement, st: el.querySelector('.st') as HTMLElement };
};
function metStatus(m: ReturnType<typeof met>, id: FeedId, replay = false) {
  const s = hub.status[id];
  m.el.classList.toggle('is-loading', s.state === 'loading');
  m.st.className = `st is-${replay ? 'replay' : s.state}`;
  m.st.title = replay ? 'Replayed reading' : `${up(s.state)} · observed ${timeSGT(s.observedAt, true)}`;
}

function renderMetrics() {
  const d = hub.data;
  const fi = frameIndex(), replay = !isLive(), f = currentFrame();
  let m = met('rain');
  metStatus(m, 'rain', replay);
  if (d.rain && f) {
    const stat = st.frameStats[fi];
    countTo(m.num, stat?.wetGauges ?? 0, fmtInt);
    m.unit.textContent = `/${gauges().filter((g) => f.values.has(g.id)).length}`;
    const ago = st.frameStats[Math.max(0, fi - 6)];
    m.foot.innerHTML = replay ? `<span class="rp">REPLAY ${timeSGT(f.t)}</span>` : `Δ30M ${fmtSigned((stat?.wetGauges ?? 0) - (ago?.wetGauges ?? 0))} · PEAK ${(stat?.max ?? 0).toFixed(1)}MM`;
    m.spark.innerHTML = sparkline(st.frameStats.map((x) => x.wetGauges), HEX.cyan, { marker: fi });
  }
  m = met('stops');
  metStatus(m, 'rain', replay);
  if (st.exposure && f) {
    const sum = summariseExposure(st.exposure);
    countTo(m.num, sum.wetStops, fmtInt);
    m.unit.textContent = `/${fmtInt(stops.length)}`;
    m.foot.textContent = `HEAVY+ ${fmtInt(sum.byBand.heavy + sum.byBand.violent)} · MED GAUGE ${fmtDistance(st.nearestMedian).toUpperCase()}`;
    m.spark.innerHTML = sparkline(st.frameStats.map((x) => x.wetStops), '#2fa8ff', { marker: fi });
  }
  m = met('taxis');
  metStatus(m, 'taxis');
  if (d.taxis) {
    countTo(m.num, d.taxis.count, fmtInt);
    const h = st.hist.taxis;
    m.foot.textContent = h.length > 1 ? `Δ SESSION ${fmtSigned(h[h.length - 1][1] - h[0][1])} · ${timeSGT(d.taxis.t, true)}` : `GPS · ${timeSGT(d.taxis.t, true)}`;
    m.spark.innerHTML = sparkline(h.map((x) => x[1]), HEX.amber, { marker: h.length - 1 });
  }
  m = met('bolt');
  metStatus(m, 'lightning');
  if (d.lightning) {
    const n = d.lightning.strikes.length;
    countTo(m.num, n, fmtInt);
    m.unit.textContent = n ? `${d.lightning.strikes.filter((k) => k.kind === 'ground').length} CG` : '';
    m.foot.textContent = st.bolt.any ? `NEAREST STOP ${fmtDistance(st.bolt.any.d).toUpperCase()}` : `NONE · ${timeSGT(d.lightning.t)}`;
    m.spark.innerHTML = sparkline(st.hist.lightning.map((x) => x[1]), HEX.red, { marker: st.hist.lightning.length - 1 });
  }
  m = met('fcst');
  metStatus(m, 'forecast');
  if (d.forecast) {
    const wet = d.forecast.areas.filter((a) => isWetForecast(d.forecast!.forecast.get(a.name)));
    countTo(m.num, wet.length, fmtInt);
    m.unit.textContent = `/${d.forecast.areas.length}`;
    m.foot.textContent = `VALID ${up(d.forecast.validText)}`;
    m.spark.innerHTML = forecastStrip(d.forecast.areas.map((a) => d.forecast!.forecast.get(a.name)));
  }
  m = met('temp');
  metStatus(m, 'temp');
  if (d.temp && d.temp.stations.length) {
    const v = d.temp.stations.map((s) => s.value);
    countTo(m.num, avg(v), (x) => x.toFixed(1));
    m.foot.textContent = `RANGE ${Math.min(...v).toFixed(1)}–${Math.max(...v).toFixed(1)} · ${v.length} STN`;
    m.spark.innerHTML = sparkline(st.hist.temp.map((x) => x[1]), '#ff8a3d', { marker: st.hist.temp.length - 1 });
  }
}
const fmtSigned = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtInt(Math.abs(n))}`;

function forecastStrip(texts: (string | undefined)[]) {
  const col: Record<string, string> = { storm: HEX.violet, rain: '#2fa8ff', cloud: '#1d3a42', fair: '#2a5560', haze: '#6b5a2e', unknown: '#122127' };
  const w = 120, h = 26, n = texts.length || 1, bw = w / n;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${texts.map((t, i) => { const tone = forecastTone(t); const bh = tone === 'storm' ? 24 : tone === 'rain' ? 17 : 5; return `<rect x="${(i * bw).toFixed(2)}" y="${h - bh}" width="${Math.max(0.6, bw - 0.6).toFixed(2)}" height="${bh}" fill="${col[tone]}"/>`; }).join('')}</svg>`;
}

const KIND_LABEL: Record<SigKind, string> = { rain: 'RAIN', bolt: 'LTG', taxi: 'TAXI', fcst: 'FCST', temp: 'TEMP', cam: 'CAM', sys: 'SYS' };
function renderSignals() {
  const list = st.signals.filter((s) => st.sigFilter === 'all' || s.kind === st.sigFilter || (st.sigFilter === 'sys' && (s.kind === 'sys' || s.kind === 'cam' || s.kind === 'temp')));
  refs.sigCount.textContent = String(st.signals.length);
  setHTML(refs.sigList, list.length
    ? list.slice(0, 150).map((s) => `<li class="sig sev-${s.sev}${s.pos || s.gauge || s.area ? ' act' : ''}" data-id="${esc(s.id)}"><time>${timeSGT(s.t, true)}</time><span class="sk k-${s.kind}">${KIND_LABEL[s.kind]}</span><div class="sb"><b>${esc(s.title)}</b><small>${esc(s.detail)}</small></div></li>`).join('')
    : '<li class="sig-empty">No signals yet.</li>');
}
refs.sigList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li[data-id]') as HTMLElement | null;
  const s = li ? st.signals.find((x) => x.id === li.dataset.id) : null;
  if (!s) return;
  if (s.gauge) select({ kind: 'gauge', id: s.gauge }, true);
  else if (s.area) select({ kind: 'area', name: s.area }, true);
  else if (s.pos && tmap) { setOrbitUI(false); tmap.focus(s.pos, 12.8); }
});
refs.sigFilters.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b?.dataset.f) return;
  st.sigFilter = b.dataset.f as any;
  refs.sigFilters.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  invalidate();
});

/* ---------------- right column: entity / areas / feeds ---------------- */
function setRightTab(t: typeof st.rightTab) {
  st.rightTab = t;
  refs.rtabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.rtab === t)));
  invalidate();
}
refs.rtabs.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b?.dataset.rtab) setRightTab(b.dataset.rtab as any); });

function renderRight() {
  const html = st.rightTab === 'entity' ? entityHTML() : st.rightTab === 'areas' ? areasHTML() : feedsHTML();
  setHTML(refs.rbody, html);
}

function areaRows(): AreaRow[] {
  const fc = hub.data.forecast;
  if (!fc) return [];
  const stats = areaStats(fc.areas, fc.forecast, st.stopArea, st.exposure, st.taxiArea);
  const now = st.areaTaxiHist[st.areaTaxiHist.length - 1];
  const old = now ? st.areaTaxiHist.find((x) => now.t - x.t >= 9 * 60000) : undefined;
  return stats.map((a) => ({ ...a, wetPct: a.stops ? a.wetStops / a.stops : 0, d10: old ? (now!.counts.get(a.name) ?? 0) - (old.counts.get(a.name) ?? 0) : null }));
}

function areasHTML(): string {
  const rows = areaRows();
  if (!rows.length) return '<p class="empty">Loading forecast areas…</p>';
  const k = st.areaSort.key, dir = st.areaSort.dir;
  rows.sort((a, b) => {
    const x = a[k] as any, y = b[k] as any;
    if (k === 'wetPct' || k === 'wetStops') { const c = (a.wetStops - b.wetStops) * dir; if (c) return c; return (a.stops - b.stops) * dir; }
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    return ((x ?? -1e9) - (y ?? -1e9)) * dir;
  });
  const maxTaxi = Math.max(1, ...rows.map((r) => r.taxis));
  const th = (key: keyof AreaRow, label: string, cls = '') => `<th class="${cls}" data-sort="${key}" aria-sort="${k === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const sel = st.selection?.kind === 'area' ? st.selection.name : '';
  return `<div class="pane-h"><span>AREA MATRIX · ${rows.length} FORECAST AREAS</span><span class="dim">${isLive() ? 'LIVE' : 'REPLAY ' + timeSGT(currentFrame()?.t ?? null)}</span></div>
  <div class="tblw"><table class="mtx"><thead><tr>${th('name', 'AREA')}${th('forecast', 'FCST')}${th('stops', 'STOPS', 'n')}${th('wetStops', 'WET', 'n')}${th('taxis', 'TAXI', 'n')}${th('d10', 'Δ10M', 'n')}</tr></thead><tbody>
  ${rows.map((r) => {
    const tone = forecastTone(r.forecast);
    return `<tr data-area="${esc(r.name)}" class="${r.name === sel ? 'sel' : ''}">
      <td class="an">${esc(up(r.name))}</td>
      <td><span class="fc fc-${tone}" title="${esc(r.forecast)}">${esc(fcShort(r.forecast))}</span></td>
      <td class="n">${r.stops}</td>
      <td class="n ${r.wetStops ? 'hot' : ''}">${r.wetStops ? `${r.wetStops}<small>${Math.round(r.wetPct * 100)}%</small>` : '·'}</td>
      <td class="n"><span class="tb" style="--w:${((r.taxis / maxTaxi) * 100).toFixed(0)}%"></span>${r.taxis}</td>
      <td class="n ${r.d10 !== null && r.d10 < 0 ? 'neg' : r.d10 ? 'pos' : ''}">${r.d10 === null ? '—' : fmtSigned(r.d10)}</td></tr>`;
  }).join('')}</tbody></table></div>
  <p class="note">Stops and taxis count toward the nearest area label point. Δ10M needs ten minutes of this session.</p>`;
}
const fcShort = (t: string) => up(t).replace('PARTLY CLOUDY', 'PTLY CLDY').replace('THUNDERY SHOWERS', 'T-STORM').replace('HEAVY THUNDERY SHOWERS WITH GUSTY WINDS', 'HVY T-STORM').replace(/\s*\((DAY|NIGHT)\)/, '').replace('LIGHT SHOWERS', 'LT SHWR').replace('SHOWERS', 'SHWR').replace('CLOUDY', 'CLDY') || '—';

refs.rbody.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const th = t.closest('th[data-sort]') as HTMLElement | null;
  if (th) { const k = th.dataset.sort as keyof AreaRow; st.areaSort = { key: k, dir: st.areaSort.key === k ? -st.areaSort.dir : (k === 'name' || k === 'forecast' ? 1 : -1) }; invalidate(); return; }
  const tr = t.closest('tr[data-area]') as HTMLElement | null;
  if (tr) { select({ kind: 'area', name: tr.dataset.area! }, true); return; }
  const b = t.closest('button') as HTMLButtonElement | null;
  if (!b) return;
  if (b.dataset.act === 'close') select(null, false);
  if (b.dataset.act === 'copy') {
    const s = st.selection;
    const hash = s?.kind === 'stop' ? `#/stop/${codes[s.i]}` : s?.kind === 'area' ? `#/area/${encodeURIComponent(s.name)}` : '';
    if (!hash) return;
    const url = `${location.href.split('#')[0]}${hash}`;
    try { await navigator.clipboard.writeText(url); toast(refs, 'LINK COPIED'); } catch { toast(refs, url); }
  }
  if (b.dataset.stop) select({ kind: 'stop', i: Number(b.dataset.stop) }, true);
  if (b.dataset.gauge) select({ kind: 'gauge', id: b.dataset.gauge }, true);
});

function feedsHTML(): string {
  const now = Date.now();
  return `<div class="pane-h"><span>FEED HEALTH · ${FEED_ORDER.length} SOURCES</span><span class="dim">KEYLESS · DIRECT</span></div>
  ${FEED_ORDER.map((id) => {
    const s = hub.status[id], m = FEEDS[id];
    const age = s.observedAt ? Math.round((now - Date.parse(s.observedAt)) / 60000) : null;
    const next = s.nextAt ? Math.max(0, Math.round((s.nextAt - now) / 1000)) : null;
    return `<div class="feed f-${s.state}">
      <div class="fh"><i></i><b>${up(m.label)}</b><span class="fs">${up(s.state)}</span></div>
      <dl class="fkv"><dt>OBS</dt><dd>${s.observedAt ? timeSGT(s.observedAt, true) : '—'}${age !== null ? ` · ${age}M AGO` : ''}</dd>
      <dt>RTT</dt><dd>${s.latencyMs !== null ? `${s.latencyMs} MS` : '—'}</dd>
      <dt>NEXT</dt><dd>${next !== null ? `${next}S` : '—'}</dd>
      <dt>REQ</dt><dd>${s.requests}</dd>
      <dt>DATA</dt><dd>${esc(up(feedSummary(id) || '—'))}</dd></dl>
      ${s.error ? `<p class="ferr">${esc(s.error)}</p>` : ''}
      <a class="fep" href="${m.endpoint}" target="_blank" rel="noopener">${m.endpoint.replace('https://', '')} ${icon('ext')}</a>
    </div>`;
  }).join('')}`;
}

/* ---------------- entity dossiers ---------------- */
const kv = (rows: [string, string][]) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const coordRows = (p: LonLat): [string, string][] => [
  ['LAT', `${p[1].toFixed(6)}° · ${dms(p[1], 'N', 'S')}`],
  ['LON', `${p[0].toFixed(6)}° · ${dms(p[0], 'E', 'W')}`],
  ['GEOHASH', geohash(p[1], p[0], 9)],
];
const dosHead = (kind: string, title: string, copy = false) => `<div class="dos-h"><span class="dos-k"><i></i>ASSET LOCK · ${kind}</span><span class="dos-a">${copy ? `<button class="ibtn" data-act="copy" aria-label="Copy link" title="Copy link">${icon('link')}</button>` : ''}<button class="ibtn" data-act="close" aria-label="Release asset">${icon('close')}</button></span></div><h2 class="dos-t">${title}</h2>`;
const sh = (t: string, extra = '') => `<h4 class="sh"><span>${t}</span>${extra}</h4>`;
const gaugeSeries = (id: string) => frames().map((f) => (f.values.has(id) ? f.values.get(id)! : null));
const bandColor = (v: number | null) => css(BAND_RGBA[rainBand(v)], 1);
const axis = () => { const fr = frames(); return fr.length ? `<p class="axis"><span>${timeSGT(fr[0].t)}</span><span>${timeSGT(fr[fr.length - 1].t)} SGT</span></p>` : ''; };
const replayChip = () => (isLive() ? '' : `<span class="rp">REPLAY ${timeSGT(currentFrame()?.t ?? null)}</span>`);
const areaOfStop = (i: number) => (hub.data.forecast && st.stopArea ? hub.data.forecast.areas[st.stopArea[i]] : null);

function entityHTML(): string {
  const s = st.selection;
  if (!s) return `<div class="nolock"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="22"/><path d="M40 6v20M40 54v20M6 40h20M54 40h20"/></svg><b>NO ASSET LOCKED</b><p>Select a bus stop, rain gauge, camera, lightning strike or area on the map, in the signal log, the area matrix or the camera wall. Search a stop by the five digits on its pole.</p></div>`;
  const graphNodes = (focus: Scene['focus']) => (focus?.links ?? []).map((l) => ({ label: l.label.split(' · ')[0], sub: l.label.split(' · ')[1] ?? '', color: css(l.color, 1) }));
  const focus = focusFor(s);
  if (s.kind === 'stop') {
    const p = stops[s.i], e = st.exposure, d = hub.data;
    const area = areaOfStop(s.i);
    const gi = e ? e.gauge[s.i] : -1;
    const g = gi >= 0 ? gauges()[gi] : null;
    const v = g && e ? e.mm5[s.i] : NaN;
    const band = e ? BANDS[e.band[s.i]] : 'unknown';
    let h = dosHead('BUS STOP', `STOP <b>${codes[s.i]}</b>`, true) + kv([['CLASS', 'LTA BUS STOP POLE'], ['AREA', area ? esc(up(area.name)) : '—'], ...coordRows(p), ['REGISTRY', `LTA · ${fmtDate(stopsFile.datasetUpdated)}`]]);
    if (ARRIVALS_URL) h += arrivalsHTML(codes[s.i]);
    h += sh('LINK ANALYSIS') + linkGraph({ label: `STOP ${codes[s.i]}`, color: HEX.white }, graphNodes(focus));
    h += sh('RAIN · NEAREST GAUGE', replayChip());
    h += g ? `<div class="big"><span class="band" style="--c:${css(BAND_RGBA[band], 1)}">${up(BAND_LABEL[band])}</span><b>${Number.isFinite(v) ? mmPerHour(v).toFixed(1) : '—'}</b><small>MM/H</small></div>
      <p class="meta">GAUGE <button class="lnk" data-gauge="${esc(g.id)}">${esc(g.id)}</button> ${esc(up(g.name))} · ${fmtDistance(e!.dist[s.i]).toUpperCase()} ${compass(bearing(p, g.pos))} · ${Number.isFinite(v) ? v.toFixed(1) : '—'} MM / 5 MIN</p>${bars(gaugeSeries(g.id), bandColor, { active: frameIndex() })}${axis()}` : `<p class="meta">${d.rain ? 'No nearby gauge reported in this window.' : 'Loading rainfall…'}</p>`;
    if (d.forecast && area) h += sh('2H FORECAST') + `<p class="meta strong"><span class="fc fc-${forecastTone(d.forecast.forecast.get(area.name))}">${esc(up(d.forecast.forecast.get(area.name) ?? '—'))}</span> ${esc(up(area.name))} · ${esc(up(d.forecast.validText))}</p>`;
    if (d.taxis && st.taxiGrid) h += sh('TAXI DENSITY') + `<div class="tiles"><div><b>${st.taxiGrid.count(p, 300)}</b><small>≤300 M</small></div><div><b>${st.taxiGrid.count(p, TAXI_NEAR)}</b><small>≤500 M</small></div><div><b>${st.taxiGrid.count(p, 1000)}</b><small>≤1 KM</small></div></div>`;
    if (d.lightning) {
      let ns: { d: number; k: (typeof d.lightning.strikes)[0] } | null = null;
      for (const k of d.lightning.strikes) { const x = haversine(p, k.pos); if (!ns || x < ns.d) ns = { d: x, k }; }
      h += sh('LIGHTNING') + `<p class="meta strong">${ns ? `NEAREST <b>${fmtDistance(ns.d).toUpperCase()}</b> ${compass(bearing(p, ns.k.pos))} · ${ns.k.kind === 'ground' ? 'CLOUD-TO-GROUND' : 'CLOUD-TO-CLOUD'} · ${timeSGT(ns.k.t, true)}` : 'NONE IN LATEST OBSERVATION'}</p>`;
    }
    const cams = d.cams?.cams ?? [];
    if (cams.length) {
      const nc = cams.map((c) => ({ c, d: haversine(p, c.pos) })).sort((a, b) => a.d - b.d)[0];
      h += sh('NEAREST CAMERA') + (nc.d <= 6000 ? camFigure(nc.c, `CAM ${nc.c.id} · ${fmtDistance(nc.d).toUpperCase()}`) : `<p class="meta">CAM ${esc(nc.c.id)} IS THE CLOSEST REPORTING · ${fmtDistance(nc.d).toUpperCase()}</p>`);
    }
    if (!ARRIVALS_URL) h += arrivalsHTML(codes[s.i]);
    return `<div class="dos">${h}</div>`;
  }
  if (s.kind === 'gauge') {
    const g = gauges().find((x) => x.id === s.id);
    if (!g) return `<div class="dos">${dosHead('RAIN GAUGE', 'NOT REPORTING')}</div>`;
    const f = currentFrame(), v = f?.values.get(g.id), series = gaugeSeries(g.id);
    const total = series.reduce<number>((a, b) => a + (b ?? 0), 0), peak = Math.max(0, ...series.map((x) => x ?? 0));
    let users = 0; const dd: number[] = [];
    if (st.exposure) for (let i = 0; i < stops.length; i++) if (st.exposure.gauge[i] >= 0 && gauges()[st.exposure.gauge[i]].id === g.id) { users++; dd.push(st.exposure.dist[i]); }
    dd.sort((a, b) => a - b);
    const band = rainBand(v);
    return `<div class="dos">${dosHead('RAIN GAUGE', `GAUGE <b>${esc(g.id)}</b>`)}${kv([['NAME', esc(up(g.name))], ['OPERATOR', 'NEA · METEOROLOGICAL SERVICE SG'], ...coordRows(g.pos)])}
      ${sh('LINK ANALYSIS')}${linkGraph({ label: `GAUGE ${g.id}`, color: HEX.cyan }, graphNodes(focus))}
      ${sh('FIVE-MINUTE TOTAL', replayChip())}<div class="big"><span class="band" style="--c:${css(BAND_RGBA[band], 1)}">${up(BAND_LABEL[band])}</span><b>${v === undefined ? '—' : v.toFixed(1)}</b><small>MM · ${v === undefined ? '—' : mmPerHour(v).toFixed(1)} MM/H</small></div>${bars(series, bandColor, { active: frameIndex() })}${axis()}
      ${sh('COVERAGE')}<div class="tiles"><div><b>${total.toFixed(1)}</b><small>MM · 2H</small></div><div><b>${peak.toFixed(1)}</b><small>PEAK / 5M</small></div><div><b>${fmtInt(users)}</b><small>STOPS READ</small></div></div>
      <p class="meta">Stops reading this gauge sit a median ${fmtDistance(quantile(dd, 0.5)).toUpperCase()} away.</p></div>`;
  }
  if (s.kind === 'cam') {
    const c = hub.data.cams?.cams.find((x) => x.id === s.id);
    if (!c) return `<div class="dos">${dosHead('CAMERA', 'NOT REPORTING')}</div>`;
    return `<div class="dos">${dosHead('TRAFFIC CAMERA', `CAM <b>${esc(c.id)}</b>`)}${camFigure(c, `FRAME ${timeSGT(c.t, true)} SGT · ${c.w}×${c.h}`, true)}
      ${kv([['OPERATOR', 'LTA · EXPRESSWAY'], ...coordRows(c.pos)])}${sh('LINK ANALYSIS')}${linkGraph({ label: `CAM ${c.id}`, color: HEX.green }, graphNodes(focus))}</div>`;
  }
  if (s.kind === 'strike') {
    const k = hub.data.lightning?.strikes[s.i];
    if (!k) return `<div class="dos">${dosHead('LIGHTNING', 'NO LONGER IN FEED')}</div>`;
    const n = nearestStop(k.pos);
    return `<div class="dos">${dosHead('LIGHTNING', k.kind === 'ground' ? 'CLOUD-TO-GROUND' : 'CLOUD-TO-CLOUD')}${kv([['LOCATED', `${timeSGT(k.t, true)} SGT`], ['SOURCE', 'NEA LIGHTNING OBSERVATION'], ...coordRows(k.pos), ['FROM CENTRE', fmtDistance(haversine(CENTRE, k.pos)).toUpperCase()]])}
      ${sh('LINK ANALYSIS')}${linkGraph({ label: 'STRIKE', color: HEX.red }, graphNodes(focus))}
      <div class="chips2"><button class="chip" data-stop="${n.i}">NEAREST STOP ${codes[n.i]} · ${fmtDistance(n.d).toUpperCase()}</button></div></div>`;
  }
  const fc = hub.data.forecast;
  const a = fc?.areas.find((x) => x.name === s.name);
  if (!a || !fc) return `<div class="dos">${dosHead('AREA', 'UNKNOWN')}</div>`;
  const row = areaRows().find((r) => r.name === a.name);
  const near = gauges().map((g) => ({ g, d: haversine(a.pos, g.pos) })).sort((x, y) => x.d - y.d).slice(0, 4);
  return `<div class="dos">${dosHead('FORECAST AREA', `<b>${esc(up(a.name))}</b>`, true)}${kv([['2H FCST', `<span class="fc fc-${forecastTone(fc.forecast.get(a.name))}">${esc(up(fc.forecast.get(a.name) ?? '—'))}</span>`], ['VALID', esc(up(fc.validText))], ...coordRows(a.pos).slice(0, 2)])}
    ${sh('LINK ANALYSIS')}${linkGraph({ label: up(a.name), color: HEX.violet }, graphNodes(focus))}
    ${sh('AREA COUNTS', replayChip())}<div class="tiles"><div><b>${row?.stops ?? '—'}</b><small>STOPS</small></div><div><b>${row?.wetStops ?? '—'}</b><small>UNDER RAIN</small></div><div><b>${row?.taxis ?? '—'}</b><small>FREE TAXIS</small></div></div>
    ${sh('NEAREST GAUGES')}<div class="glist">${near.map((n) => { const v = liveFrame()?.values.get(n.g.id); return `<button class="grow" data-gauge="${esc(n.g.id)}"><i style="background:${bandColor(v ?? null)}"></i><b>${esc(n.g.id)}</b><span>${esc(up(shortName(n.g.name)))}</span><em>${v === undefined ? '—' : v.toFixed(1) + ' MM'}</em><small>${fmtDistance(n.d).toUpperCase()}</small></button>`; }).join('')}</div>
    <p class="note">Area figures count stops and taxis whose nearest forecast label point is this area.</p></div>`;
}

const LOAD_LABEL: Record<string, string> = { SEA: 'Seats available', SDA: 'Standing available', LSD: 'Limited standing' };
const WAB_ICON = '<svg class="wab" viewBox="0 0 24 24" aria-label="wheelchair accessible" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="4" r="1.8" fill="currentColor" stroke="none"/><path d="M11 7.5v6h5.5l2.5 6"/><path d="M8.5 10.8a5.6 5.6 0 1 0 7.6 7.2"/></svg>';
function arrivalsHTML(code: string): string {
  if (!ARRIVALS_URL) return sh('BUS ARRIVALS', '<span class="rp off">UNFINISHED</span>') + `<p class="meta">Live arrivals are built but not yet connected. They need an LTA DataMall key behind a small proxy. BUNI Transit is open source: <a href="${REPO}" target="_blank" rel="noopener">help finish it on GitHub</a>.</p>`;
  const a = st.arr && st.arr.stop === code ? st.arr : null;
  const live = a?.data ? `<span class="rp live">LTA · ${timeSGT(a.data.fetchedAt, true)}</span>` : '';
  let h = sh('BUS ARRIVALS', live);
  if (!a || (a.loading && !a.data)) return h + '<p class="meta">Querying LTA DataMall…</p>';
  if (!a.data) return h + `<p class="meta bad">${esc(a.error ?? 'Arrivals unavailable')}. Retrying every 30 s.</p>`;
  const svc = a.data.services;
  if (!svc.length) return h + '<p class="meta">No services reported for this stop right now.</p>';
  h += `<div class="arrs">${svc.map((s) => {
    const chips = s.buses.length
      ? s.buses.map((b) => {
        const m = minsUntil(b.eta);
        const t = m <= 0 ? 'ARR' : String(m);
        const tip = `${m <= 0 ? 'Arriving' : `${m} min`} · ${b.load ? LOAD_LABEL[b.load] : 'load unknown'} · ${b.type === 'DD' ? 'double deck' : b.type === 'BD' ? 'bendy' : 'single deck'}${b.wab ? ' · wheelchair accessible' : ''} · ${b.monitored ? 'live-tracked by LTA' : 'timetable estimate'}`;
        return `<span class="eta ld-${b.load ?? 'na'}${b.monitored ? '' : ' sch'}" title="${esc(tip)}"><b>${t}</b>${m > 0 ? '<i>M</i>' : ''}${b.type === 'DD' ? '<em>DD</em>' : b.type === 'BD' ? '<em>BD</em>' : ''}${b.wab ? WAB_ICON : ''}</span>`;
      }).join('')
      : '<span class="eta none">NOT IN OPERATION</span>';
    return `<div class="arr"><b class="svc">${esc(s.no)}</b><span class="op">${esc(s.op ?? '')}</span><div class="etas">${chips}</div></div>`;
  }).join('')}</div>
  <p class="legend2"><i class="ld-SEA"></i>SEATS <i class="ld-SDA"></i>STANDING <i class="ld-LSD"></i>LIMITED · <span class="sch">ITALIC</span> = TIMETABLE, NOT LIVE-TRACKED · MAP POSITIONS ESTIMATED BY LTA</p>`;
  if (a.error) h += `<p class="meta bad">Last refresh failed: ${esc(a.error)}. Showing ${timeSGT(a.data.fetchedAt, true)}.</p>`;
  return h;
}

function camFigure(c: { id: string; image: string; t: string }, caption: string, big = false) {
  return `<figure class="camf ${big ? 'big' : ''}"><img src="${esc(c.image)}" alt="Live still from LTA traffic camera ${esc(c.id)}" referrerpolicy="no-referrer" decoding="async"/><span class="cf-live">● LIVE</span><span class="cf-id">CAM ${esc(c.id)}</span><figcaption>${esc(caption)}</figcaption></figure>`;
}

const fmtDate = (iso: string | null) => (iso ? up(new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' })) : 'DATE UNKNOWN');

/* ---------------- selection ---------------- */
/* ---------------- live arrivals (via BUNI's Cloudflare Worker) ---------------- */
async function loadArrivals(code: string) {
  if (!ARRIVALS_URL || document.hidden) return;
  if (!st.arr || st.arr.stop !== code) st.arr = { stop: code, data: null, error: null, loading: true };
  else st.arr.loading = true;
  invalidate();
  try {
    const data = await fetchArrivals(code);
    if (st.arr?.stop !== code) return;
    const first = !st.arr.data;
    st.arr = { stop: code, data, error: null, loading: false };
    // First answer for this stop: once the camera has arrived, pull back a little so approaching buses are in view.
    if (first && data.services.some((s) => s.buses.some((b) => b.pos))) {
      const t0 = Date.now();
      const settle = () => {
        const sel = st.selection;
        if (sel?.kind !== 'stop' || codes[sel.i] !== code || !tmap || Date.now() - t0 > 10_000) return;
        if (!tmap.landed || tmap.map.isMoving()) { setTimeout(settle, 400); return; }
        if (tmap.map.getZoom() > 14.6) tmap.map.easeTo({ zoom: 14.2, duration: 1400 });
      };
      setTimeout(settle, 600);
    }
    st.arrStats.ok++;
    st.arrStats.lastAt = Date.now();
    st.arrStats.lastError = null;
  } catch (e) {
    if (st.arr?.stop !== code) return;
    st.arr.error = e instanceof Error ? e.message : String(e);
    st.arr.loading = false;
    st.arrStats.fail++;
    st.arrStats.lastError = st.arr.error;
  }
  invalidate();
}
function trackArrivals(s: Selection | null) {
  clearInterval(st.arrTimer);
  if (s?.kind !== 'stop' || !ARRIVALS_URL) { st.arr = null; return; }
  const code = codes[s.i];
  loadArrivals(code);
  st.arrTimer = window.setInterval(() => loadArrivals(code), 30_000);
}

function select(s: Selection | null, fly: boolean) {
  st.selection = s;
  trackArrivals(s);
  if (s) { setRightTab('entity'); if (innerWidth <= 1100) setMtab('entity'); }
  if (s?.kind === 'stop') history.replaceState(null, '', `#/stop/${codes[s.i]}`);
  else if (s?.kind === 'area') history.replaceState(null, '', `#/area/${encodeURIComponent(s.name)}`);
  else if (/^#\/(stop|area)\//.test(location.hash)) history.replaceState(null, '', '#/');
  if (s && fly && tmap) { const f = focusFor(s); if (f) { setOrbitUI(false); tmap.focus(f.at, s.kind === 'stop' ? 15.6 : s.kind === 'area' ? 13 : 14); } }
  invalidate();
}

/* ---------------- HUD ---------------- */
let hudT = 0;
let hudTimer = 0;
function hudView() {
  const v = st.view;
  if (!v) return;
  const b = ((v.bearing % 360) + 360) % 360;
  const w = (refs.hdTrack.parentElement as HTMLElement).clientWidth;
  refs.hdTrack.style.transform = `translateX(${(w / 2 - (b + 360) * 4).toFixed(1)}px)`;
  refs.hdVal.textContent = `${String(Math.round(b) % 360).padStart(3, '0')}° ${compass(b)}`;
  hudReadout();
}
function hudReadout() {
  const now = performance.now();
  // Throttle to ~25 updates a second, but always land on the final position.
  clearTimeout(hudTimer);
  if (now - hudT < 40) { hudTimer = window.setTimeout(hudReadout, 45); return; }
  hudT = now;
  const v = st.view;
  if (!v) return;
  const c = st.cursor;
  let cur = '<span class="dim">CUR —</span>';
  if (c) {
    const n = stopGrid.within(c, 300).map((i) => ({ i, d: haversine(c, stops[i]) })).sort((a, b) => a.d - b.d)[0];
    cur = `CUR ${c[1].toFixed(5)}°N ${c[0].toFixed(5)}°E${n ? ` <span class="hl">◇ STOP ${codes[n.i]} · ${Math.round(n.d)} M</span>` : ''}`;
  }
  refs.readout.innerHTML = `<div>CTR ${v.lat.toFixed(5)}°N ${v.lng.toFixed(5)}°E · Z ${v.zoom.toFixed(2)} · PIT ${Math.round(v.pitch)}°</div><div>${cur}</div>`;
}

/* ---------------- lens + layers ---------------- */
function setLens(l: Lens) {
  st.lens = l;
  refs.lens.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.lens === l)));
  if (tmap?.landed && l !== 'pulse' && tmap.map.getZoom() > 12.4) tmap.goTo(PRESETS.island);
  invalidate();
}
refs.lens.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b?.dataset.lens) setLens(b.dataset.lens as Lens); });

const CHIPS: { k: LayerKey; label: string; c: string }[] = [
  { k: 'stops', label: 'STOPS', c: HEX.cyan }, { k: 'rain', label: 'RAIN', c: '#2fa8ff' }, { k: 'taxis', label: 'TAXI', c: HEX.amber },
  { k: 'lightning', label: 'LTG', c: HEX.red }, { k: 'cams', label: 'CAM', c: HEX.green }, { k: 'forecast', label: 'FCST', c: HEX.violet }, { k: 'grid', label: 'GRID', c: HEX.dim },
];
refs.chips.innerHTML = CHIPS.map((x) => `<button data-layer="${x.k}" aria-pressed="true" style="--cc:${x.c}"><i></i>${x.label}</button>`).join('');
refs.chips.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  const k = b?.dataset.layer as LayerKey | undefined;
  if (!b || !k) return;
  st.on[k] = !st.on[k];
  b.setAttribute('aria-pressed', String(st.on[k]));
  invalidate();
});

refs.hudBr.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b || !tmap) return;
  if (b.dataset.preset) { setOrbitUI(false); tmap.goTo(PRESETS[b.dataset.preset]); }
  if (b.dataset.z === 'in') tmap.zoomBy(1);
  if (b.dataset.z === 'out') tmap.zoomBy(-1);
  if (b.dataset.z === 'north') tmap.north();
});
function setOrbitUI(on: boolean) {
  tmap?.setOrbit(on);
  refs.orbitBtn.setAttribute('aria-pressed', String(!!tmap?.orbiting));
}
refs.orbitBtn.addEventListener('click', () => setOrbitUI(!tmap?.orbiting));

/* ---------------- timeline ---------------- */
function renderTimeline() {
  const fr = frames();
  const n = fr.length;
  refs.scrub.max = String(Math.max(0, n - 1));
  refs.scrub.value = String(frameIndex());
  refs.scrub.disabled = n < 2;
  refs.timeLabel.textContent = n ? timeSGT(fr[frameIndex()].t) : '--:--';
  refs.liveBtn.classList.toggle('is-live', isLive());
  refs.play.innerHTML = icon(st.playing ? 'pause' : 'play');
  refs.play.setAttribute('aria-label', st.playing ? 'Pause rain replay' : 'Play rain replay');
  refs.tlMeta.textContent = n ? `2H · ${n} FRAMES · ${timeSGT(fr[0].t)}–${timeSGT(fr[n - 1].t)}` : '2H · LOADING';
  setHTML(refs.histo, bars(st.frameStats.map((x) => x.wetGauges), (v) => (v ? HEX.cyan : 'rgba(47,224,255,.16)'), { w: 300, h: 20, active: frameIndex() }));
  if (n > 1) {
    const t0 = fr[0].ms, t1 = fr[n - 1].ms;
    const ev = st.signals.filter((s) => s.kind === 'rain' && s.t >= t0 && s.t <= t1);
    setHTML(refs.ticks, ev.map((s) => `<i class="sev-${s.sev}" style="left:${(((s.t - t0) / (t1 - t0)) * 100).toFixed(2)}%" title="${esc(timeSGT(s.t) + ' ' + s.title)}"></i>`).join(''));
  }
}
function setFrame(i: number) {
  st.frameIdx = i >= liveIdx() ? -1 : Math.max(0, i);
  updateExposure();
  invalidate();
}
refs.scrub.addEventListener('input', () => { stopPlay(); setFrame(Number(refs.scrub.value)); });
refs.liveBtn.addEventListener('click', () => { stopPlay(); setFrame(liveIdx()); });
refs.play.addEventListener('click', () => (st.playing ? stopPlay() : startPlay()));
function startPlay() {
  if (frames().length < 2) return;
  st.playing = true;
  if (isLive()) st.frameIdx = 0;
  updateExposure();
  st.playTimer = window.setInterval(() => {
    const next = frameIndex() + 1;
    if (next > liveIdx()) { stopPlay(); setFrame(liveIdx()); return; }
    setFrame(next);
  }, 600);
  invalidate();
}
function stopPlay() { st.playing = false; clearInterval(st.playTimer); invalidate(); }

/* ---------------- camera wall ---------------- */
let camKey = '';
function renderCams() {
  const cams = hub.data.cams?.cams ?? [];
  refs.camMeta.textContent = hub.data.cams ? `${cams.length} ONLINE · ${timeSGT(hub.data.cams.t, true)}` : 'CONNECTING';
  const sel = st.selection?.kind === 'cam' ? st.selection.id : '';
  const key = cams.map((c) => c.id + c.t).join('|') + sel;
  if (key === camKey) return;
  camKey = key;
  refs.cams.innerHTML = cams.length ? cams.map((c) => `<button class="cam-t${c.id === sel ? ' sel' : ''}" data-cam="${esc(c.id)}" aria-label="Camera ${esc(c.id)}">
      <img src="${esc(c.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"/>
      <span class="ct-live">● LIVE</span><span class="ct-id">CAM ${esc(c.id)}</span><span class="ct-t">${timeSGT(c.t, true)}</span><span class="ct-xy">${c.pos[1].toFixed(4)}N ${c.pos[0].toFixed(4)}E</span>
    </button>`).join('') : '<p class="empty">No cameras reporting.</p>';
}
refs.cams.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button[data-cam]') as HTMLElement | null; if (b) select({ kind: 'cam', id: b.dataset.cam! }, true); });

/* ---------------- search ---------------- */
type Hit = { label: string; sub: string; go: () => void };
let hits: Hit[] = [];
let hitIdx = 0;
function search(q: string): Hit[] {
  q = q.trim();
  if (!q) return [];
  const out: Hit[] = [];
  const d = hub.data;
  if (/^\d{1,5}$/.test(q)) {
    for (let i = 0; i < codes.length && out.length < 8; i++) if (codes[i].startsWith(q)) out.push({ label: `STOP ${codes[i]}`, sub: up(areaOfStop(i)?.name ?? ''), go: () => select({ kind: 'stop', i }, true) });
    return out;
  }
  const ql = q.toLowerCase();
  for (const a of d.forecast?.areas ?? []) if (a.name.toLowerCase().includes(ql)) out.push({ label: up(a.name), sub: `AREA · ${up(d.forecast!.forecast.get(a.name) ?? '')}`, go: () => select({ kind: 'area', name: a.name }, true) });
  for (const g of gauges()) if (g.name.toLowerCase().includes(ql) || g.id.toLowerCase() === ql) out.push({ label: up(g.name), sub: `GAUGE ${g.id}`, go: () => select({ kind: 'gauge', id: g.id }, true) });
  for (const c of d.cams?.cams ?? []) if (c.id.includes(q)) out.push({ label: `CAM ${c.id}`, sub: 'TRAFFIC CAMERA', go: () => select({ kind: 'cam', id: c.id }, true) });
  return out.slice(0, 8);
}
function renderResults() {
  const r = refs.results;
  const v = refs.search.value.trim();
  if (!hits.length) { r.hidden = !v; r.innerHTML = v ? '<p class="nohit">NO MATCH. STOP CODES ARE THE FIVE DIGITS ON THE POLE.</p>' : ''; return; }
  r.hidden = false;
  r.innerHTML = hits.map((h, i) => `<button role="option" aria-selected="${i === hitIdx}" data-i="${i}"><b>${esc(h.label)}</b><small>${esc(h.sub)}</small></button>`).join('');
}
refs.search.addEventListener('input', () => { hits = search(refs.search.value); hitIdx = 0; renderResults(); });
refs.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { hitIdx = Math.min(hits.length - 1, hitIdx + 1); renderResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { hitIdx = Math.max(0, hitIdx - 1); renderResults(); e.preventDefault(); }
  if (e.key === 'Enter' && hits[hitIdx]) { hits[hitIdx].go(); closeSearch(); }
  if (e.key === 'Escape') closeSearch();
});
refs.results.addEventListener('mousedown', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) { e.preventDefault(); hits[Number(b.dataset.i)]?.go(); closeSearch(); } });
refs.search.addEventListener('blur', () => setTimeout(() => { refs.results.hidden = true; }, 120));
function closeSearch() { refs.search.value = ''; hits = []; refs.results.hidden = true; refs.search.blur(); }

/* ---------------- phone tabs ---------------- */
function setMtab(t: string) {
  root.dataset.mtab = t;
  refs.mtabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mtab === t)));
  if (t === 'areas') setRightTab('areas');
  if (t === 'entity') setRightTab('entity');
}
refs.mtabs.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b?.dataset.mtab) setMtab(b.dataset.mtab); });

/* ---------------- pages ---------------- */
let currentPage = '';
function renderPage(name: string) {
  currentPage = name;
  const html = name === 'method' ? methodPage() : name === 'sources' ? sourcesPage() : aboutPage();
  setHTML(refs.pageBody, html);
}
function openPage(name: string) {
  renderPage(name);
  refs.page.hidden = false;
  requestAnimationFrame(() => refs.page.classList.add('in'));
  setTimeout(() => refs.page.classList.add('in'), 50);
  (refs.page.querySelector('.page-close') as HTMLElement).focus({ preventScroll: true });
}
function closePage() {
  currentPage = '';
  refs.page.classList.remove('in');
  setTimeout(() => { if (!currentPage) refs.page.hidden = true; }, 220);
}
refs.page.addEventListener('click', (e) => { if (e.target === refs.page || (e.target as HTMLElement).closest('.page-close')) location.hash = '#/'; });

function methodPage(): string {
  const pctOutside = (1 - st.nearest1km / stops.length) * 100;
  return `
  <p class="doc-k">DOC-01 · METHOD</p>
  <h1>How every number is made</h1>
  <p class="lede">Everything in the console is a published observation, or a simple rule applied to one. Nothing is modelled, predicted or filled in. When a source is late, the console says so and keeps showing its last reading with its time.</p>

  <h2>Rain at a bus stop</h2>
  <p>Singapore has ${fmtInt(stops.length)} bus stops and about ${gauges().length || 88} rain gauges. Each stop takes the five-minute total from its <b>nearest gauge that reported</b> in that window, and the distance is always shown. A fixed 1 km radius would leave <b>${Number.isFinite(pctOutside) ? pctOutside.toFixed(0) : '~56'}%</b> of stops unassessed: the median stop is <b>${fmtDistance(st.nearestMedian)}</b> from its nearest gauge. Nearest-gauge assignment covers every stop, but it is still a point reading.</p>
  <table class="tbl"><thead><tr><th>Band</th><th>Hourly rate</th><th>Five-minute total</th></tr></thead><tbody>
    <tr><td><i class="sw-dot" style="background:${css(BAND_RGBA.light, 1)}"></i>Light</td><td>under 2.5 mm/h</td><td>under 0.21 mm</td></tr>
    <tr><td><i class="sw-dot" style="background:${css(BAND_RGBA.moderate, 1)}"></i>Moderate</td><td>2.5 – 7.6 mm/h</td><td>0.21 – 0.63 mm</td></tr>
    <tr><td><i class="sw-dot" style="background:${css(BAND_RGBA.heavy, 1)}"></i>Heavy</td><td>7.6 – 50 mm/h</td><td>0.63 – 4.2 mm</td></tr>
    <tr><td><i class="sw-dot" style="background:${css(BAND_RGBA.violent, 1)}"></i>Violent</td><td>over 50 mm/h</td><td>over 4.2 mm</td></tr>
  </tbody></table>
  <p class="small">Hourly rate = five-minute total × 12. Bands follow the American Meteorological Society's rain-rate definitions. The newest five-minute window is used once at least 60% of the usual number of gauges have reported in it.</p>

  <h2>Condition level</h2>
  <p>The status in the top bar is a fixed rule set about weather around the bus network. It is not a claim about delays.</p>
  <table class="tbl"><thead><tr><th>Level</th><th>Any of these</th></tr></thead><tbody>
    <tr><td><span class="lvl-tag" data-level="alert">ALERT</span></td><td>Violent rain (over 50 mm/h) at any gauge · cloud-to-ground lightning within 10 km of a bus stop</td></tr>
    <tr><td><span class="lvl-tag" data-level="watch">WATCH</span></td><td>Heavy rain at any gauge · any lightning within 30 km of a bus stop · any area forecast thundery showers · 10 or more areas forecast rain</td></tr>
    <tr><td><span class="lvl-tag" data-level="nominal">NOMINAL</span></td><td>None of the above</td></tr>
  </tbody></table>

  <h2>Signals</h2>
  <p>Signals are changes in published readings, stamped with the source's own time: rain onset, cessation and intensification at each gauge (rebuilt from the two-hour history when you open the console), located lightning, forecast changes per area, a 3% or larger change in free taxis over ten minutes, and an area losing 40% or more of its free taxis in ten minutes (from at least 15). Severity follows the bands and rules above.</p>

  <h2>Areas and links</h2>
  <p>The two-hour forecast names ${hub.data.forecast?.areas.length ?? 47} areas, each with a label point rather than a boundary. Stops and taxis count toward the nearest label point. Link analysis draws what an asset is tied to: its gauge, its forecast area, the nearest reporting camera and the nearest located strike, each with a distance.</p>

  <h2>Bus arrivals</h2>
  <p>${ARRIVALS_URL ? 'When you lock a bus stop, the console asks BUNI\'s arrivals proxy (a Cloudflare Worker that holds the LTA DataMall key, so the key never reaches your browser) for that stop\'s next three buses per service, and refreshes every 30 seconds. Times and the map positions of approaching buses are LTA\'s own estimates. Italic times come from the timetable because LTA is not tracking that bus live. Crowding (seats, standing, limited standing), deck type and wheelchair access are as LTA reports them.' : 'Unfinished. The arrivals board, map markers and a Cloudflare Worker proxy are built and tested, but this build is not connected to a DataMall key. Contributions welcome.'}</p>

  <h2>What the console does not do</h2>
  <ul class="ticks">
    <li>No bus positions of its own: approaching buses are shown only at LTA's estimated positions, and only for the stop you lock.</li>
    <li>No delay or congestion claims: rain near a stop is not evidence that a bus is late.</li>
    <li>No tracking of people or vehicles: taxi positions are anonymous points published by LTA, with no identifiers.</li>
    <li>No predictions, interpolated rain surfaces or back-filled history.</li>
    <li>No accounts, cookies, analytics or location access.</li>
  </ul>

  <h2>Freshness</h2>
  <table class="tbl"><thead><tr><th>Feed</th><th>Refreshed</th><th>Stale after</th></tr></thead><tbody>
    ${FEED_ORDER.map((id) => `<tr><td>${FEEDS[id].label}</td><td>every ${FEEDS[id].every / 60000} min</td><td>${FEEDS[id].staleAfter / 60000} min</td></tr>`).join('')}
  </tbody></table>
  <p class="small">Requests go from your browser straight to data.gov.sg, spaced at least two seconds apart per host and paused while the tab is hidden. That stays well inside the published keyless limits.</p>`;
}

function sourcesPage(): string {
  const row = (id: FeedId) => {
    const s = hub.status[id], m = FEEDS[id];
    return `<tr><td><b>${m.label}</b><small>${esc(m.what)}</small></td><td>${esc(m.publisher)}</td>
      <td><span class="pill ${s.state}">${up(s.state)}</span>${s.error ? `<small class="err">${esc(s.error)}</small>` : ''}</td>
      <td class="mono">${s.observedAt ? timeSGT(s.observedAt, true) : '—'}</td>
      <td><a class="mono src" href="${m.endpoint}" target="_blank" rel="noopener">${m.endpoint.replace('https://', '')} ${icon('ext')}</a></td></tr>`;
  };
  return `
  <p class="doc-k">DOC-02 · SOURCES</p>
  <h1>Where the data comes from</h1>
  <p class="lede">Six live feeds and one dataset, all published openly by Singapore government agencies on data.gov.sg. The status below is checked from your browser right now.</p>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Feed</th><th>Publisher</th><th>Status</th><th>Observed (SGT)</th><th>Endpoint</th></tr></thead><tbody>
    ${FEED_ORDER.map(row).join('')}
    ${ARRIVALS_URL ? `<tr><td><b>Bus arrivals</b><small>On demand for the locked stop, through BUNI's arrivals proxy, which holds the DataMall key. Cached 20 s.</small></td><td>Land Transport Authority (DataMall)</td><td><span class="pill ${st.arrStats.lastError ? 'stale' : st.arrStats.ok ? 'live' : 'loading'}">${st.arrStats.lastError ? 'DEGRADED' : st.arrStats.ok ? 'LIVE' : 'ON DEMAND'}</span>${st.arrStats.lastError ? `<small class="err">${esc(st.arrStats.lastError)}</small>` : ''}</td><td class="mono">${st.arrStats.lastAt ? timeSGT(st.arrStats.lastAt, true) : '—'}</td><td><a class="mono src" href="https://datamall.lta.gov.sg/content/datamall/en/dynamic-data.html" target="_blank" rel="noopener">datamall.lta.gov.sg ${icon('ext')}</a></td></tr>` : ''}
    <tr><td><b>Bus stops</b><small>${fmtInt(stopsFile.count)} stop poles, static</small></td><td>Land Transport Authority</td><td><span class="pill live">BUNDLED</span></td><td class="mono">${fmtDate(stopsFile.datasetUpdated)}</td><td><a class="mono src" href="${esc(stopsFile.source)}" target="_blank" rel="noopener">data.gov.sg dataset ${icon('ext')}</a></td></tr>
  </tbody></table></div>
  <h2>Basemap</h2>
  <p>Vector tiles from <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> (no keys, no cookies), schema by <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a>, map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>. Building heights come from OpenStreetMap and are approximate.</p>
  <h2>Licence</h2>
  <p>Government data is used under the <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener">Singapore Open Data Licence</a>. BUNI Transit is independent and is not endorsed by LTA, NEA, GovTech or any agency.</p>`;
}

function aboutPage(): string {
  return `
  <p class="doc-k">DOC-03 · ABOUT</p>
  <h1>BUNI Transit-INT</h1>
  <p class="lede">An open-source intelligence console for Singapore's streets: rain at every bus stop, free taxis, lightning, forecasts and traffic cameras, correlated live in 3D. It is built so anyone can see what the public data actually says, and nothing more.</p>
  <div class="about-grid">
    <div><h3>Evidence first</h3><p>Every figure links to its source and carries its observation time. Late data is labelled, never disguised.</p></div>
    <div><h3>Infrastructure, not people</h3><p>Stops, gauges, cameras and weather. Taxi positions are anonymous points with no identifiers, and nothing is tracked over time.</p></div>
    <div><h3>Private by design</h3><p>No accounts, cookies, analytics or location access. Your browser fetches public data directly from data.gov.sg and map tiles from OpenFreeMap; those services see your IP address, as any website would.</p></div>
  </div>
  <h2>Not for operational use</h2>
  <p>BUNI Transit is for understanding and exploration. Do not use it for navigation, safety decisions or emergency response. For official weather warnings, see the Meteorological Service Singapore; for transport, see LTA's channels.</p>
  <h2>Keyboard</h2>
  <p class="mono small">/ search · 1 2 3 lenses · SPACE replay · O orbit · G grid · ESC release asset</p>
  <h2>Roadmap</h2>
  <ul class="ticks"><li><b>v1.2</b> · live bus arrivals and LTA-estimated bus positions for any locked stop${ARRIVALS_URL ? ' (live)' : '. <b>Unfinished:</b> the board, map markers and Cloudflare Worker proxy are built and tested, but not connected to a DataMall key yet'}.</li><li><b>v1.3</b> · longer rain history and day-by-day comparison.</li></ul>
  <h2>Open source</h2>
  <p>BUNI Transit is unfinished on purpose, and open so people can improve it. The code is MIT-licensed on <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>. Issues and pull requests are welcome, especially for live arrivals.</p>
  <p class="small mono">VERSION ${VERSION} · BUILD ${esc(__BUILD__.slice(0, 16).replace('T', ' '))} UTC · BUNI INDUSTRIES, SINGAPORE</p>`;
}

/* ---------------- router ---------------- */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, ...rest] = h.split('/');
  const b = decodeURIComponent(rest.join('/'));
  refs.nav.querySelectorAll('a').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.route === (['method', 'sources', 'about'].includes(a) ? a : '')));
  if (a === 'method' || a === 'sources' || a === 'about') openPage(a); else if (!refs.page.hidden) closePage();
  if (a === 'stop' && b) { const i = codeToIdx.get(b); if (i !== undefined) { if (st.selection?.kind !== 'stop' || st.selection.i !== i) select({ kind: 'stop', i }, !!tmap?.landed); } else toast(refs, `NO BUS STOP WITH CODE ${b}`, 'warn'); }
  if (a === 'area' && b) { if (st.selection?.kind !== 'area' || st.selection.name !== b) select({ kind: 'area', name: b }, !!tmap?.landed); }
  root.classList.remove('menu-open');
  refs.menuBtn.setAttribute('aria-expanded', 'false');
}
window.addEventListener('hashchange', route);
refs.menuBtn.addEventListener('click', () => { const on = !root.classList.contains('menu-open'); root.classList.toggle('menu-open', on); refs.menuBtn.setAttribute('aria-expanded', String(on)); });

/* ---------------- keyboard ---------------- */
window.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).matches('input, textarea, select');
  if (e.key === 'Escape') { if (!refs.page.hidden) location.hash = '#/'; else if (st.selection) select(null, false); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); refs.search.focus(); }
  else if (e.key === '1') setLens('pulse');
  else if (e.key === '2') setLens('network');
  else if (e.key === '3') setLens('taxis');
  else if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); st.playing ? stopPlay() : startPlay(); }
  else if (e.key.toLowerCase() === 'o') setOrbitUI(!tmap?.orbiting);
  else if (e.key.toLowerCase() === 'g') { st.on.grid = !st.on.grid; refs.chips.querySelector('[data-layer="grid"]')?.setAttribute('aria-pressed', String(st.on.grid)); invalidate(); }
});

/* ---------------- clocks ---------------- */
const tick = () => {
  const n = new Date();
  refs.sgt.textContent = timeSGT(n.getTime(), true);
  refs.utc.textContent = n.toISOString().slice(11, 19);
};
tick();
setInterval(tick, 1000);
setInterval(() => { if (st.rightTab === 'feeds') invalidate(); }, 5000);

/* ---------------- boot sequence ---------------- */
const bootT0 = performance.now();
let bootDone = false;
let bootFinal = false;
const dots = (s: string, w = 24) => (s + ' ').padEnd(w, '.');
function renderBoot() {
  if (!refs.boot.isConnected) return;
  const L: string[] = [];
  const ok = (t: string) => `<span class="ok">${t}</span>`;
  L.push(`<span class="hd">BUNI TRANSIT-INT ${VERSION}</span>  <span class="dim">BUILD ${esc(__BUILD__.slice(0, 10))}</span>`);
  L.push('<span class="dim">OPEN-SOURCE TRANSPORT &amp; WEATHER INTELLIGENCE · SINGAPORE</span>');
  L.push('<span class="dim">──────────────────────────────────────────────────────</span>');
  L.push(`&gt; ${dots('RENDER CORE')} ${has3D ? ok('WEBGL2 OK') : '<span class="bad">WEBGL2 UNAVAILABLE</span>'}`);
  L.push(`&gt; ${dots('STOP REGISTRY')} ${ok(`${fmtInt(stops.length)} ASSETS`)} <span class="dim">LTA ${fmtDate(stopsFile.datasetUpdated)}</span>`);
  L.push(`&gt; ${dots('UPLINK data.gov.sg')} ${FEED_ORDER.some((id) => stateOf(id) === 'live') ? ok('OPEN') : '<span class="dim">CONNECTING<b class="cur">_</b></span>'}`);
  for (const id of FEED_ORDER) {
    const s = hub.status[id];
    const tag = s.state === 'live' || s.state === 'stale' ? ok('[ OK ]') : s.state === 'error' ? '<span class="bad">[FAIL]</span>' : '<span class="dim">[ .. ]</span>';
    const body = s.state === 'loading' ? '<span class="dim">awaiting</span>' : s.state === 'error' ? `<span class="bad">${esc(up(s.error ?? 'error'))}</span>` : `${esc(up(feedSummary(id)))}${s.latencyMs !== null ? ` <span class="dim">${s.latencyMs} MS</span>` : ''}`;
    L.push(`  ${tag} ${dots(up(FEEDS[id].label), 20)} ${body}`);
  }
  if (bootFinal) {
    L.push(`&gt; ${dots('CORRELATING')} ${ok(`${fmtInt(stops.length)} STOPS ↔ ${gauges().length} GAUGES ↔ ${hub.data.forecast?.areas.length ?? 0} AREAS`)}`);
    L.push(`&gt; ${dots('CONDITION LEVEL')} <span class="lv-${st.level.level}">${up(st.level.level)}</span>`);
    L.push(`&gt; ${ok('ENTERING SG-SIN ▸')}<b class="cur">_</b>`);
  }
  setHTML(refs.bootLog, L.join('\n'));
}

function finishBoot() {
  if (bootDone) return;
  bootDone = true;
  refs.boot.classList.add('out');
  setTimeout(() => refs.boot.remove(), 900);
  signal([{ id: `sys:boot`, t: Date.now(), kind: 'sys', sev: st.level.level === 'alert' ? 'alert' : st.level.level === 'watch' ? 'watch' : 'info', title: `CONSOLE ONLINE · STATUS ${up(st.level.level)}`, detail: `${FEED_ORDER.filter((id) => stateOf(id) === 'live').length}/${FEED_ORDER.length} feeds live · ${fmtInt(stops.length)} stops registered` }]);
  if (!tmap) return;
  // Dive to the heaviest rain if any gauge is above light; otherwise to the island overview.
  const f = liveFrame();
  let top: { g: Gauge; v: number } | null = null;
  if (f) for (const g of gauges()) { const v = f.values.get(g.id); if (v !== undefined && v > 0 && (!top || v > top.v)) top = { g, v }; }
  const target: Preset = top && RANK[rainBand(top.v)] >= 2 ? { center: top.g.pos, zoom: 12.4, pitch: 58, bearing: -24 } : PRESETS.island;
  tmap.dive(target).then(() => { if (!reduceMotion && !st.selection) setOrbitUI(true); });
}

async function runBoot() {
  tmap?.spin();
  // Proceed once rain and taxis have each answered, whether with data or an error.
  const ready = () => stateOf('rain') !== 'loading' && stateOf('taxis') !== 'loading';
  await new Promise<void>((res) => { const check = () => (ready() || performance.now() - bootT0 > 9000 || bootDone ? res() : setTimeout(check, 120)); check(); });
  const wait = Math.max(0, (reduceMotion ? 400 : 2600) - (performance.now() - bootT0));
  await new Promise((r) => setTimeout(r, wait));
  bootFinal = true;
  invalidate();
  await new Promise((r) => setTimeout(r, reduceMotion ? 200 : 1100));
  finishBoot();
}
refs.boot.querySelector('.boot-skip')!.addEventListener('click', () => { bootFinal = true; finishBoot(); });
// Hard limit: the boot screen never holds the console for more than 12 seconds, however slow a feed is.
setTimeout(() => { if (!bootDone) { bootFinal = true; finishBoot(); } }, 12000);

/* ---------------- go ---------------- */
const deepLink = /^#\/(stop|area)\//.test(location.hash);
hub.start();
route();
renderAll();
if (stillMode || deepLink) {
  bootDone = true;
  refs.boot.remove();
  tmap?.jump(stillMode ? PRESETS.cbd : PRESETS.island).then(() => {
    route();
    const f = focusFor(st.selection);
    if (f && !stillMode) tmap!.focus(f.at, st.selection?.kind === 'stop' ? 15.6 : 13);
    if (stillMode) {
      const mark = () => { if (hub.data.rain && hub.data.taxis && tmap!.map.areTilesLoaded()) document.documentElement.dataset.ready = '1'; else setTimeout(mark, 500); };
      tmap!.map.once('idle', mark);
    }
  });
} else runBoot();

// Derived measures. Every function here is deterministic and documented on the Method page.
import { haversine, nearestN, quantile, type LonLat } from './geo.ts';

/* ---------- Rain bands ----------
   NEA gauges report the rain total for each five-minute window. We convert to an hourly rate
   (x12) and use the standard rain-rate bands (American Meteorological Society glossary):
   light < 2.5 mm/h, moderate 2.5-7.6 mm/h, heavy 7.6-50 mm/h, violent > 50 mm/h. */
export type RainBand = 'unknown' | 'dry' | 'light' | 'moderate' | 'heavy' | 'violent';
export const BANDS: RainBand[] = ['unknown', 'dry', 'light', 'moderate', 'heavy', 'violent'];

export function mmPerHour(mm5: number): number {
  return mm5 * 12;
}

export function rainBand(mm5: number | null | undefined): RainBand {
  if (mm5 === null || mm5 === undefined || !Number.isFinite(mm5)) return 'unknown';
  if (mm5 <= 0) return 'dry';
  const r = mmPerHour(mm5);
  if (r < 2.5) return 'light';
  if (r < 7.6) return 'moderate';
  if (r <= 50) return 'heavy';
  return 'violent';
}

export interface Gauge { id: string; name: string; pos: LonLat }
export interface RainFrame { t: string; ms: number; values: Map<string, number> }

/** For each stop, its K nearest gauges (indices + metres), computed once per gauge list. */
export interface StopGaugeLinks { k: number; idx: Int16Array; dist: Float32Array }

export function linkStopsToGauges(stops: readonly LonLat[], gauges: readonly Gauge[], k = 4): StopGaugeLinks {
  const kk = Math.min(k, gauges.length);
  const pts = gauges.map((g) => g.pos);
  const idx = new Int16Array(stops.length * kk).fill(-1);
  const dist = new Float32Array(stops.length * kk).fill(Infinity);
  for (let s = 0; s < stops.length; s++) {
    const near = nearestN(stops[s], pts, kk);
    for (let j = 0; j < near.length; j++) {
      idx[s * kk + j] = near[j].i;
      dist[s * kk + j] = near[j].d;
    }
  }
  return { k: kk, idx, dist };
}

/** Rain exposure of every stop for one frame: the nearest gauge that has a reading in that frame. */
export interface Exposure {
  gauge: Int16Array;   // gauge index used, -1 if none of the K nearest reported
  dist: Float32Array;  // metres to that gauge
  mm5: Float32Array;   // five-minute total at that gauge, NaN if unknown
  band: Uint8Array;    // index into BANDS
}

export function exposureFor(links: StopGaugeLinks, gauges: readonly Gauge[], frame: RainFrame | null, nStops: number): Exposure {
  const gauge = new Int16Array(nStops).fill(-1);
  const dist = new Float32Array(nStops).fill(NaN);
  const mm5 = new Float32Array(nStops).fill(NaN);
  const band = new Uint8Array(nStops);
  for (let s = 0; s < nStops; s++) {
    for (let j = 0; j < links.k; j++) {
      const gi = links.idx[s * links.k + j];
      if (gi < 0) break;
      const v = frame?.values.get(gauges[gi].id);
      if (v === undefined || !Number.isFinite(v)) continue;
      gauge[s] = gi;
      dist[s] = links.dist[s * links.k + j];
      mm5[s] = v;
      break;
    }
    band[s] = BANDS.indexOf(rainBand(Number.isNaN(mm5[s]) ? null : mm5[s]));
  }
  return { gauge, dist, mm5, band };
}

export interface ExposureSummary {
  wetStops: number;
  byBand: Record<RainBand, number>;
  medianDistance: number;
  within1km: number;
  within2km: number;
}

export function summariseExposure(e: Exposure): ExposureSummary {
  const byBand = Object.fromEntries(BANDS.map((b) => [b, 0])) as Record<RainBand, number>;
  const d: number[] = [];
  let within1km = 0, within2km = 0;
  for (let s = 0; s < e.band.length; s++) {
    byBand[BANDS[e.band[s]]]++;
    if (!Number.isNaN(e.dist[s])) {
      d.push(e.dist[s]);
      if (e.dist[s] <= 1000) within1km++;
      if (e.dist[s] <= 2000) within2km++;
    }
  }
  d.sort((a, b) => a - b);
  const wetStops = byBand.light + byBand.moderate + byBand.heavy + byBand.violent;
  return { wetStops, byBand, medianDistance: quantile(d, 0.5), within1km, within2km };
}

/* ---------- Forecast areas ----------
   The 2-hour forecast names 47 areas, each with a label point (not a boundary).
   A stop takes the forecast of the nearest label point; the Method page says so. */
export interface ForecastArea { name: string; pos: LonLat }

export function nearestAreaIndex(stops: readonly LonLat[], areas: readonly ForecastArea[]): Uint8Array {
  const pts = areas.map((a) => a.pos);
  const out = new Uint8Array(stops.length);
  for (let s = 0; s < stops.length; s++) out[s] = nearestN(stops[s], pts, 1)[0]?.i ?? 0;
  return out;
}

export function isWetForecast(text: string | undefined): boolean {
  return !!text && /shower|rain|thunder|drizzle/i.test(text);
}

/** Short tag for a forecast text, used for chips. */
export function forecastTone(text: string | undefined): 'storm' | 'rain' | 'cloud' | 'fair' | 'haze' | 'unknown' {
  if (!text) return 'unknown';
  if (/thunder/i.test(text)) return 'storm';
  if (/shower|rain|drizzle/i.test(text)) return 'rain';
  if (/haz|mist|fog/i.test(text)) return 'haze';
  if (/cloud|overcast/i.test(text)) return 'cloud';
  return 'fair';
}

/* ---------- Area matrix ---------- */
export interface AreaStat { name: string; pos: LonLat; forecast: string; stops: number; wetStops: number; taxis: number }

/** Per forecast area: stops and taxis assigned by nearest label point, and stops under rain. */
export function areaStats(
  areas: readonly ForecastArea[],
  forecast: Map<string, string> | null,
  stopArea: Uint8Array | null,
  exposure: Exposure | null,
  taxiArea: Uint8Array | null,
): AreaStat[] {
  const out: AreaStat[] = areas.map((a) => ({ name: a.name, pos: a.pos, forecast: forecast?.get(a.name) ?? '', stops: 0, wetStops: 0, taxis: 0 }));
  if (stopArea) for (let s = 0; s < stopArea.length; s++) {
    const a = out[stopArea[s]];
    if (!a) continue;
    a.stops++;
    if (exposure && exposure.band[s] >= 2) a.wetStops++;
  }
  if (taxiArea) for (let i = 0; i < taxiArea.length; i++) { const a = out[taxiArea[i]]; if (a) a.taxis++; }
  return out;
}

/* ---------- Condition level ----------
   A plain rule set, published on the Method page. It describes weather conditions around the
   bus network; it is not a claim about delays. */
export type Level = 'nominal' | 'watch' | 'alert';

export function conditionLevel(p: { maxBand: RainBand; groundStrikeKm: number | null; anyStrikeKm: number | null; thunderAreas: number; wetAreas: number }): { level: Level; reasons: string[] } {
  const reasons: string[] = [];
  let level: Level = 'nominal';
  const up = (l: Level) => { if (l === 'alert' || (l === 'watch' && level === 'nominal')) level = l; };
  if (p.maxBand === 'violent') { up('alert'); reasons.push('Violent rain (over 50 mm/h) at a gauge'); }
  else if (p.maxBand === 'heavy') { up('watch'); reasons.push('Heavy rain (7.6–50 mm/h) at a gauge'); }
  if (p.groundStrikeKm !== null && p.groundStrikeKm <= 10) { up('alert'); reasons.push(`Cloud-to-ground lightning ${p.groundStrikeKm.toFixed(1)} km from a bus stop`); }
  else if (p.anyStrikeKm !== null && p.anyStrikeKm <= 30) { up('watch'); reasons.push(`Lightning ${Math.round(p.anyStrikeKm)} km from a bus stop`); }
  if (p.thunderAreas > 0) { up('watch'); reasons.push(`${p.thunderAreas} area${p.thunderAreas > 1 ? 's' : ''} forecast thundery showers`); }
  else if (p.wetAreas >= 10) { up('watch'); reasons.push(`${p.wetAreas} areas forecast rain`); }
  return { level, reasons };
}

/* ---------- Lightning ---------- */
export interface Strike { pos: LonLat; kind: 'ground' | 'cloud'; t: string }

export function nearestStrike(p: LonLat, strikes: readonly Strike[]): { strike: Strike; d: number } | null {
  let best: { strike: Strike; d: number } | null = null;
  for (const s of strikes) {
    const d = haversine(p, s.pos);
    if (!best || d < best.d) best = { strike: s, d };
  }
  return best;
}

/* ---------- Formatting helpers shared by the UI and tests ---------- */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

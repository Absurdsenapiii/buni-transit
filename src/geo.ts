// Pure geometry helpers. Erasable TypeScript only, so Node can run the tests directly.

export type LonLat = [number, number];

const R = 6371008.8; // mean Earth radius, metres
const RAD = Math.PI / 180;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b in degrees (0 = north). */
export function bearing(a: LonLat, b: LonLat): number {
  const f1 = a[1] * RAD, f2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compass(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8];
}

/** The n nearest points to target, nearest first. Brute force: fine for a few hundred points. */
export function nearestN(target: LonLat, pts: readonly LonLat[], n: number): { i: number; d: number }[] {
  const out: { i: number; d: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const d = haversine(target, pts[i]);
    if (out.length < n || d < out[out.length - 1].d) {
      out.push({ i, d });
      out.sort((p, q) => p.d - q.d);
      if (out.length > n) out.pop();
    }
  }
  return out;
}

/**
 * Uniform grid over lon/lat for fast radius queries across thousands of points.
 * Cell size is given in metres; near the equator a degree is ~111 km both ways.
 */
export class GridIndex {
  readonly cell: number;
  readonly cells: Map<number, number[]>;
  readonly pts: readonly LonLat[];

  constructor(pts: readonly LonLat[], cellMetres = 500) {
    this.pts = pts;
    this.cell = cellMetres / 111320;
    this.cells = new Map();
    for (let i = 0; i < pts.length; i++) {
      const k = this.key(Math.floor(pts[i][0] / this.cell), Math.floor(pts[i][1] / this.cell));
      const bucket = this.cells.get(k);
      if (bucket) bucket.push(i); else this.cells.set(k, [i]);
    }
  }

  key(cx: number, cy: number): number {
    return cx * 100003 + cy;
  }

  /** Indices of points within radius metres of centre. */
  within(centre: LonLat, radius: number): number[] {
    const span = Math.ceil(radius / 111320 / this.cell);
    const cx = Math.floor(centre[0] / this.cell), cy = Math.floor(centre[1] / this.cell);
    const out: number[] = [];
    for (let x = cx - span; x <= cx + span; x++) {
      for (let y = cy - span; y <= cy + span; y++) {
        const bucket = this.cells.get(this.key(x, y));
        if (!bucket) continue;
        for (const i of bucket) if (haversine(centre, this.pts[i]) <= radius) out.push(i);
      }
    }
    return out;
  }

  count(centre: LonLat, radius: number): number {
    return this.within(centre, radius).length;
  }
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
/** Standard base-32 geohash of a point. */
export function geohash(lat: number, lon: number, precision = 9): string {
  let idx = 0, bit = 0, even = true, out = '';
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  while (out.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = idx * 2 + 1; lonMin = mid; } else { idx *= 2; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx *= 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { out += B32[idx]; bit = 0; idx = 0; }
  }
  return out;
}

/** Degrees-minutes-seconds, e.g. 1°17'48.7"N. */
export function dms(v: number, pos: string, neg: string): string {
  const s = v < 0 ? neg : pos;
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let sec = Math.round(((a - d) * 60 - m) * 600) / 10;
  if (sec >= 60) { sec = 0; m++; }
  if (m >= 60) { m = 0; d++; }
  return `${d}°${String(m).padStart(2, '0')}'${sec.toFixed(1).padStart(4, '0')}"${s}`;
}

export function quantile(sorted: ArrayLike<number>, p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

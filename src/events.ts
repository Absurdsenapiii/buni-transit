// Signals: discrete events derived from changes in the published data. Every signal carries the
// source's own timestamp. Nothing here is predicted; a signal only says that a reading changed.
import { mmPerHour, rainBand, type Gauge, type RainBand, type RainFrame } from './analysis.ts';
import type { LonLat } from './geo.ts';

export type Sev = 'info' | 'watch' | 'alert';
export type SigKind = 'rain' | 'bolt' | 'taxi' | 'fcst' | 'temp' | 'cam' | 'sys';

export interface Signal {
  id: string;
  t: number;
  kind: SigKind;
  sev: Sev;
  title: string;
  detail: string;
  pos?: LonLat;
  gauge?: string;
  area?: string;
}

export const RANK: Record<RainBand, number> = { unknown: -1, dry: 0, light: 1, moderate: 2, heavy: 3, violent: 4 };
const sevFor = (b: RainBand): Sev => (RANK[b] >= 3 ? 'alert' : RANK[b] === 2 ? 'watch' : 'info');
const rate = (v: number) => `${v.toFixed(1)} mm/5 min · ${mmPerHour(v).toFixed(1)} mm/h`;

/** Onset, cessation and intensification at each gauge across consecutive five-minute frames. */
export function rainSignals(gauges: readonly Gauge[], frames: readonly RainFrame[]): Signal[] {
  const out: Signal[] = [];
  if (!frames.length) return out;
  const first = frames[0];
  const active = gauges.filter((g) => (first.values.get(g.id) ?? 0) > 0);
  if (active.length) {
    out.push({
      id: `rain:active:${first.ms}`, t: first.ms, kind: 'rain', sev: 'info',
      title: `RAIN ACTIVE · ${active.length} GAUGE${active.length > 1 ? 'S' : ''}`,
      detail: `At the start of the 2-hour window: ${active.slice(0, 3).map((g) => g.name).join(', ')}${active.length > 3 ? ' …' : ''}`,
    });
  }
  for (let k = 1; k < frames.length; k++) {
    const f0 = frames[k - 1], f1 = frames[k];
    for (const g of gauges) {
      const v0 = f0.values.get(g.id), v1 = f1.values.get(g.id);
      if (v0 === undefined || v1 === undefined) continue;
      const b0 = rainBand(v0), b1 = rainBand(v1);
      const base = { t: f1.ms, kind: 'rain' as const, pos: g.pos, gauge: g.id };
      if (v0 <= 0 && v1 > 0) out.push({ ...base, id: `rain:${g.id}:${f1.ms}:on`, sev: sevFor(b1), title: `RAIN ONSET · ${g.name.toUpperCase()}`, detail: `${rate(v1)} · ${b1}` });
      else if (v0 > 0 && v1 <= 0) out.push({ ...base, id: `rain:${g.id}:${f1.ms}:off`, sev: 'info', title: `RAIN CEASED · ${g.name.toUpperCase()}`, detail: `Last reading ${rate(v0)}` });
      else if (RANK[b1] > RANK[b0] && RANK[b1] >= 3) out.push({ ...base, id: `rain:${g.id}:${f1.ms}:up`, sev: sevFor(b1), title: `RAIN INTENSIFIED · ${g.name.toUpperCase()}`, detail: `${b0} → ${b1} · ${rate(v1)}` });
    }
  }
  return out;
}

/** Keep a newest-first, de-duplicated signal list. Returns how many were new. */
export function mergeSignals(list: Signal[], seen: Set<string>, incoming: readonly Signal[], cap = 400): number {
  let added = 0;
  for (const s of incoming) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    list.push(s);
    added++;
  }
  if (added) {
    list.sort((a, b) => b.t - a.t);
    if (list.length > cap) list.length = cap;
  }
  return added;
}

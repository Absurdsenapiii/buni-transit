// Live bus arrivals, fetched from BUNI's own Cloudflare Worker (which holds the LTA DataMall key).
// The key never reaches the browser. Without VITE_ARRIVALS_URL at build time the feature stays off.
export const ARRIVALS_URL: string = String(import.meta.env.VITE_ARRIVALS_URL ?? '').replace(/\/$/, '');

export interface ArrBus {
  eta: string;
  mins: number;
  monitored: boolean;
  load: 'SEA' | 'SDA' | 'LSD' | null;
  type: 'SD' | 'DD' | 'BD' | null;
  wab: boolean;
  visit: number;
  pos: [number, number] | null;
  origin: string | null;
  dest: string | null;
}
export interface ArrService { no: string; op: string | null; buses: ArrBus[] }
export interface Arrivals { stop: string; fetchedAt: string; source: string; services: ArrService[] }

export async function fetchArrivals(stop: string): Promise<Arrivals> {
  const r = await fetch(`${ARRIVALS_URL}/arrivals?stop=${encodeURIComponent(stop)}`, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? `Arrivals service answered HTTP ${r.status}`);
  return j as Arrivals;
}

/** Minutes until arrival, measured now (not at fetch time). */
export const minsUntil = (eta: string) => Math.round((Date.parse(eta) - Date.now()) / 60000);

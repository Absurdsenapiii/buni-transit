import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { haversine, nearestN, GridIndex, quantile, compass, bearing, geohash, dms, type LonLat } from '../src/geo.ts';
import { rainBand, mmPerHour, linkStopsToGauges, exposureFor, summariseExposure, nearestAreaIndex, isWetForecast, forecastTone, fmtDistance, areaStats, conditionLevel, BANDS, type Gauge, type RainFrame } from '../src/analysis.ts';
import { rainSignals, mergeSignals, type Signal } from '../src/events.ts';

const stopsFile = JSON.parse(fs.readFileSync(new URL('../public/data/stops.json', import.meta.url), 'utf8'));
const stops: LonLat[] = stopsFile.stops.map((s: [string, number, number]) => [s[1], s[2]]);

test('bundled stop dataset is the full official set with Singapore coordinates', () => {
  assert.equal(stopsFile.count, stops.length);
  assert.ok(stops.length > 5000, `expected 5,000+ stops, got ${stops.length}`);
  assert.equal(new Set(stopsFile.stops.map((s: string[]) => s[0])).size, stops.length, 'stop codes are unique');
  // Upper latitude allows LTA's cross-border stops in Johor Bahru (e.g. 46239 at Larkin, lat 1.4955).
  for (const [lon, lat] of stops) assert.ok(lat > 1.15 && lat < 1.52 && lon > 103.6 && lon < 104.1, `${lon},${lat}`);
});

test('haversine matches known distances', () => {
  assert.equal(haversine([103.8, 1.3], [103.8, 1.3]), 0);
  const d = haversine([103.8198, 1.3521], [103.8198, 1.3611]); // 0.009 degrees of latitude
  assert.ok(Math.abs(d - 1000.8) < 2, `got ${d}`);
  assert.equal(compass(bearing([103.8, 1.3], [103.8, 1.4])), 'N');
  assert.equal(compass(bearing([103.8, 1.3], [103.9, 1.3])), 'E');
});

test('nearestN returns sorted nearest points', () => {
  const pts: LonLat[] = [[103.9, 1.3], [103.81, 1.3], [103.85, 1.3]];
  const r = nearestN([103.8, 1.3], pts, 2);
  assert.deepEqual(r.map((x) => x.i), [1, 2]);
  assert.ok(r[0].d < r[1].d);
});

test('GridIndex radius queries agree with brute force', () => {
  const idx = new GridIndex(stops, 600);
  const centre: LonLat = [103.851, 1.2905];
  for (const r of [150, 500, 1200]) {
    const brute = stops.filter((p) => haversine(centre, p) <= r).length;
    assert.equal(idx.count(centre, r), brute, `radius ${r}`);
  }
});

test('rain bands follow the standard hourly-rate thresholds', () => {
  assert.equal(rainBand(null), 'unknown');
  assert.equal(rainBand(undefined), 'unknown');
  assert.equal(rainBand(0), 'dry');
  assert.equal(rainBand(0.2), 'light');      // 2.4 mm/h
  assert.equal(rainBand(0.21), 'moderate');  // 2.52 mm/h
  assert.equal(rainBand(0.63), 'moderate');  // 7.56 mm/h
  assert.equal(rainBand(0.64), 'heavy');     // 7.68 mm/h
  assert.equal(rainBand(4.2), 'violent');    // 50.4 mm/h
  assert.equal(mmPerHour(0.5), 6);
});

test('each stop reads its nearest gauge that actually reported', () => {
  const gauges: Gauge[] = [
    { id: 'A', name: 'near', pos: [103.80, 1.30] },
    { id: 'B', name: 'far', pos: [103.90, 1.30] },
  ];
  const s: LonLat[] = [[103.801, 1.30]];
  const links = linkStopsToGauges(s, gauges, 2);
  const both: RainFrame = { t: 'x', ms: 0, values: new Map([['A', 1.0], ['B', 0]]) };
  const onlyFar: RainFrame = { t: 'y', ms: 1, values: new Map([['B', 0]]) };
  const e1 = exposureFor(links, gauges, both, 1);
  assert.equal(e1.gauge[0], 0);
  assert.equal(BANDS[e1.band[0]], 'heavy');
  const e2 = exposureFor(links, gauges, onlyFar, 1);
  assert.equal(e2.gauge[0], 1, 'falls back to the next nearest reporting gauge');
  assert.equal(BANDS[e2.band[0]], 'dry');
  const e3 = exposureFor(links, gauges, { t: 'z', ms: 2, values: new Map() }, 1);
  assert.equal(e3.gauge[0], -1);
  assert.equal(BANDS[e3.band[0]], 'unknown', 'no reading stays unknown, never dry');
});

test('exposure summary counts and distances are consistent on the real stop set', () => {
  const gauges: Gauge[] = [
    { id: 'W', name: 'west', pos: [103.70, 1.34] },
    { id: 'C', name: 'centre', pos: [103.82, 1.35] },
    { id: 'E', name: 'east', pos: [103.95, 1.35] },
  ];
  const links = linkStopsToGauges(stops, gauges, 3);
  const frame: RainFrame = { t: 't', ms: 0, values: new Map([['W', 0.3], ['C', 0], ['E', 0]]) };
  const sum = summariseExposure(exposureFor(links, gauges, frame, stops.length));
  const total = Object.values(sum.byBand).reduce((a, b) => a + b, 0);
  assert.equal(total, stops.length);
  assert.ok(sum.wetStops > 0 && sum.wetStops < stops.length);
  assert.equal(sum.byBand.unknown, 0);
  assert.ok(sum.medianDistance > 0);
});

test('forecast helpers', () => {
  assert.ok(isWetForecast('Thundery Showers'));
  assert.ok(isWetForecast('Light Rain'));
  assert.ok(!isWetForecast('Partly Cloudy (Night)'));
  assert.equal(forecastTone('Heavy Thundery Showers with Gusty Winds'), 'storm');
  assert.equal(forecastTone('Cloudy'), 'cloud');
  const idx = nearestAreaIndex([[103.99, 1.36]], [{ name: 'Jurong', pos: [103.70, 1.34] }, { name: 'Changi', pos: [103.98, 1.36] }]);
  assert.equal(idx[0], 1);
});

test('geohash and DMS match reference values', () => {
  assert.equal(geohash(57.64911, 10.40744, 11), 'u4pruydqqvj'); // published reference point
  assert.equal(geohash(1.29685, 103.85254, 5), 'w21z7');
  assert.equal(dms(1.29685, 'N', 'S'), `1°17'48.7"N`);
  assert.equal(dms(-0.5, 'N', 'S'), `0°30'00.0"S`);
});

test('area stats assign stops and taxis to their nearest area', () => {
  const areas = [{ name: 'West', pos: [103.70, 1.34] as LonLat }, { name: 'East', pos: [103.95, 1.35] as LonLat }];
  const pts: LonLat[] = [[103.71, 1.34], [103.94, 1.35], [103.96, 1.36]];
  const stopArea = nearestAreaIndex(pts, areas);
  const exp = { gauge: new Int16Array(3), dist: new Float32Array(3), mm5: new Float32Array(3), band: new Uint8Array([3, 1, 1]) };
  const s = areaStats(areas, new Map([['West', 'Showers']]), stopArea, exp, nearestAreaIndex([[103.95, 1.35]], areas));
  assert.deepEqual(s.map((a) => [a.name, a.stops, a.wetStops, a.taxis, a.forecast]), [['West', 1, 1, 0, 'Showers'], ['East', 2, 0, 1, '']]);
});

test('condition level follows the published rules', () => {
  const calm = { maxBand: 'dry' as const, groundStrikeKm: null, anyStrikeKm: null, thunderAreas: 0, wetAreas: 2 };
  assert.equal(conditionLevel(calm).level, 'nominal');
  assert.equal(conditionLevel({ ...calm, maxBand: 'heavy' }).level, 'watch');
  assert.equal(conditionLevel({ ...calm, maxBand: 'violent' }).level, 'alert');
  assert.equal(conditionLevel({ ...calm, anyStrikeKm: 22 }).level, 'watch');
  assert.equal(conditionLevel({ ...calm, groundStrikeKm: 6, anyStrikeKm: 6 }).level, 'alert');
  assert.equal(conditionLevel({ ...calm, thunderAreas: 1 }).level, 'watch');
  assert.equal(conditionLevel({ ...calm, anyStrikeKm: 45 }).level, 'nominal');
});

test('rain signals: onset, intensification, cessation, and missing readings ignored', () => {
  const g: Gauge[] = [{ id: 'A', name: 'Alpha', pos: [103.8, 1.3] }, { id: 'B', name: 'Beta', pos: [103.9, 1.3] }];
  const f = (ms: number, a?: number, b?: number): RainFrame => {
    const values = new Map<string, number>();
    if (a !== undefined) values.set('A', a);
    if (b !== undefined) values.set('B', b);
    return { t: new Date(ms).toISOString(), ms, values };
  };
  const sigs = rainSignals(g, [f(0, 0, 0), f(300000, 0.1, 0), f(600000, 1.0, undefined), f(900000, 0, 0)]);
  const titles = sigs.map((s) => `${s.title}|${s.sev}`);
  assert.deepEqual(titles, ['RAIN ONSET · ALPHA|info', 'RAIN INTENSIFIED · ALPHA|alert', 'RAIN CEASED · ALPHA|info']);
  const list: Signal[] = [];
  const seen = new Set<string>();
  assert.equal(mergeSignals(list, seen, sigs), 3);
  assert.equal(mergeSignals(list, seen, sigs), 0, 'duplicates are dropped');
  assert.ok(list[0].t >= list[1].t, 'newest first');
});

test('formatting', () => {
  assert.equal(fmtDistance(640), '640 m');
  assert.equal(fmtDistance(1103), '1.1 km');
  assert.equal(fmtDistance(NaN), '—');
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
});

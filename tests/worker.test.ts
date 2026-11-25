import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeArrivals } from '../worker/src/arrivals.js';
import worker from '../worker/src/index.js';

const now = Date.parse('2026-11-26T08:00:00+08:00');
const nb = (min: number, extra: Record<string, string> = {}) => ({
  OriginCode: '77009', DestinationCode: '10009', EstimatedArrival: new Date(now + min * 60000).toISOString(),
  Monitored: 1, Latitude: '1.2967', Longitude: '103.8525', VisitNumber: '1', Load: 'SEA', Feature: 'WAB', Type: 'DD', ...extra,
});
const empty = { OriginCode: '', DestinationCode: '', EstimatedArrival: '', Monitored: 0, Latitude: '0.0', Longitude: '0.0', VisitNumber: '', Load: '', Feature: '', Type: '' };
// Shaped like DataMall's documented BusArrival v3 response.
const sample = {
  'odata.metadata': 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival',
  BusStopCode: '01012',
  Services: [
    { ServiceNo: '7', Operator: 'SBST', NextBus: nb(3), NextBus2: nb(11, { Monitored: 0 as any, Latitude: '0.0', Longitude: '0.0', Load: 'SDA' }), NextBus3: empty },
    { ServiceNo: '12', Operator: 'GAS', NextBus: nb(-1, { Load: 'LSD', Type: 'SD', Feature: '' }), NextBus2: empty, NextBus3: empty },
    { ServiceNo: '2', Operator: 'SBST', NextBus: empty, NextBus2: empty, NextBus3: empty },
  ],
};

test('shapes DataMall arrivals: natural service order, ETAs, flags, estimated positions', () => {
  const s = shapeArrivals(sample, now);
  assert.equal(s.stop, '01012');
  assert.deepEqual(s.services.map((x) => x.no), ['2', '7', '12']);
  const seven = s.services.find((x) => x.no === '7')!;
  assert.equal(seven.buses.length, 2, 'blank NextBus3 dropped');
  assert.deepEqual([seven.buses[0].mins, seven.buses[0].monitored, seven.buses[0].load, seven.buses[0].type, seven.buses[0].wab], [3, true, 'SEA', 'DD', true]);
  assert.deepEqual(seven.buses[0].pos, [103.8525, 1.2967]);
  assert.equal(seven.buses[1].monitored, false, 'scheduled, not live-tracked');
  assert.equal(seven.buses[1].pos, null, '0.0 coordinates mean no position');
  const twelve = s.services.find((x) => x.no === '12')!;
  assert.equal(twelve.buses[0].mins, -1);
  assert.equal(twelve.buses[0].wab, false);
  assert.equal(s.services.find((x) => x.no === '2')!.buses.length, 0, 'service with no buses kept, empty');
});

test('worker: validates input, protects the key, enforces origins', async () => {
  const env = { DATAMALL_KEY: 'test-key-not-real' };
  const call = (path: string, origin?: string) => worker.fetch(new Request(`https://w.example${path}`, { headers: origin ? { Origin: origin } : {} }), env as any, { waitUntil() {} } as any);
  assert.equal((await call('/arrivals?stop=12')).status, 400);
  assert.equal((await call('/arrivals?stop=01012', 'https://evil.example')).status, 403);
  assert.equal((await call('/nope')).status, 404);
  const h = await call('/health', 'https://absurdsenapiii.github.io');
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('Access-Control-Allow-Origin'), 'https://absurdsenapiii.github.io');
  const body = await h.text();
  assert.ok(!body.includes('test-key-not-real'), 'health never echoes the key');
  assert.deepEqual(JSON.parse(body), { ok: true, keyConfigured: true });
  const noKey = await worker.fetch(new Request('https://w.example/arrivals?stop=01012'), {} as any, { waitUntil() {} } as any);
  assert.equal(noKey.status, 503);
});

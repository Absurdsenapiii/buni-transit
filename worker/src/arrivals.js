// Shapes an LTA DataMall BusArrival v3 response into the compact form the console uses.
// Pure function: no network, no secrets. Unit-tested in tests/worker.test.ts.

/** @param {any} b one of NextBus / NextBus2 / NextBus3 */
function bus(b, now) {
  if (!b || !b.EstimatedArrival) return null;
  const t = Date.parse(b.EstimatedArrival);
  if (!Number.isFinite(t)) return null;
  const lat = Number(b.Latitude), lon = Number(b.Longitude);
  return {
    eta: b.EstimatedArrival,
    mins: Math.round((t - now) / 60000),
    // Monitored 1: LTA estimates from the bus's live location. 0: from the timetable.
    monitored: Number(b.Monitored) === 1,
    load: ['SEA', 'SDA', 'LSD'].includes(b.Load) ? b.Load : null, // seats / standing / limited standing
    type: ['SD', 'DD', 'BD'].includes(b.Type) ? b.Type : null,    // single deck / double deck / bendy
    wab: b.Feature === 'WAB',                                      // wheelchair accessible
    visit: Number(b.VisitNumber) || 1,
    // LTA's estimated position of the bus, or null when it has none.
    pos: lat > 1 && lat < 2 && lon > 103 && lon < 105 ? [lon, lat] : null,
    origin: b.OriginCode || null,
    dest: b.DestinationCode || null,
  };
}

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

export function shapeArrivals(raw, now = Date.now()) {
  const services = (Array.isArray(raw?.Services) ? raw.Services : [])
    .map((s) => ({
      no: String(s.ServiceNo ?? '').trim(),
      op: s.Operator || null,
      buses: [s.NextBus, s.NextBus2, s.NextBus3].map((b) => bus(b, now)).filter(Boolean),
    }))
    .filter((s) => s.no)
    .sort((a, b) => natural(a.no, b.no));
  return {
    stop: String(raw?.BusStopCode ?? ''),
    fetchedAt: new Date(now).toISOString(),
    source: 'LTA DataMall BusArrival v3',
    services,
  };
}

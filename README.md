# BUNI Transit-INT

**Live:** https://absurdsenapiii.github.io/buni-transit/ · **Licence:** MIT

> **Unfinished, and open source on purpose.** Live bus arrivals (v1.2) are built and tested but not connected to a DataMall key yet. Help finish it: see [CONTRIBUTING.md](CONTRIBUTING.md).

Repository layout: source at the root; `docs/` is the built site that GitHub Pages serves.

**An open-source intelligence console for Singapore's streets.** Rain at every one of the 5,205 bus stops, every free taxi, located lightning, the 2-hour forecast, air temperature and a live wall of expressway traffic cameras. Everything is correlated on a 3D map and turned into a running signal log. All of it comes from official open data, and nothing is invented.

## What's in it

| | |
|---|---|
| **Boot + globe dive** | A terminal boot sequence that reports each real feed as it connects (record counts and round-trip times). Then it dives from a spinning globe into 3D Singapore. |
| **Status bar** | Condition level NOMINAL / WATCH / ALERT from published rules, feed health, request count, SGT and UTC clocks, and a live ticker of the newest signals. |
| **SITREP** | A plain-language situation report rebuilt from the live data on every update. |
| **Indicators** | Gauges wet, stops under rain, free taxis, lightning, areas forecasting rain and air temperature. Each has a trend line and a feed-status light. |
| **Signal log** | Real events: rain onset, cessation and intensification at each gauge (rebuilt from the 2-hour history), located lightning, forecast changes per area, taxi-supply swings, feed uplinks and outages. Filterable; click to locate. |
| **3D map + HUD** | Dark tactical basemap with OSM building heights, coordinate grid, heading tape, reticle and cursor readout (coordinates plus the nearest stop). Three lenses: Pulse, Network and Taxis. |
| **Asset dossiers + link analysis** | Lock any stop, gauge, camera, strike or area. You get coordinates (decimal, DMS, geohash), a link graph and arcs on the map to its gauge, area, nearest camera and nearest strike, plus a 2-hour rain chart, forecast, taxi density and camera still. |
| **Area matrix** | All 47 forecast areas with forecast, stops, stops under rain, free taxis and 10-minute change. Sortable; click to lock. |
| **Camera wall** | Every reporting LTA traffic camera, live. |
| **Rain replay** | Scrub or play the last 25 five-minute readings, with signal ticks on the timeline. |
| **Documents** | Method (every rule), Sources (live feed health) and About. |
| **Phone layout** | Map first, with tabbed panels below. |

Keyboard: `/` search · `1` `2` `3` lenses · `Space` replay · `O` orbit · `G` grid · `Esc` release asset.

## What it deliberately does not do

- **No bus positions or arrival times.** Those need an LTA DataMall key (the founder's call), planned for v1.2.
- **No delay or congestion claims.** The condition level describes weather around the network, not service.
- **No tracking of people or vehicles.** Taxi positions are anonymous points LTA publishes with no identifiers, and nothing is followed over time.
- **No predictions,** no interpolated rain surfaces, no back-filled history, no accounts, cookies, analytics or location access.

## Run it

Requires Node 22+ (Node 24 recommended).

```sh
npm ci
npm test          # 13 unit tests: geometry, geohash, rain bands, nearest-gauge logic, area stats, condition rules, signals
npm run dev       # http://localhost:5173
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ on http://localhost:4174
```

- Refresh the bundled bus-stop dataset (LTA publishes quarterly): `npm run data`.
- Re-shoot the social card from live data: `npm run build`, then `npm run preview`, then `node scripts/og-shot.mjs` in a second terminal (needs Microsoft Edge), then build again.
- `?still` on the URL skips the intro and opens on the CBD (used for the card).

## How it works

```
Browser ──fetch──▶ api-open.data.gov.sg  (rain, lightning, forecast, temperature)   CORS *, no key
        ──fetch──▶ api.data.gov.sg       (taxi availability, traffic cameras)       CORS *, no key
        ──tiles──▶ tiles.openfreemap.org (vector basemap, OSM building heights)     no key, no cookies
        ──static─▶ data/stops.json       (5,205 LTA stops, 155 KB, bundled)
```

- **No server.** `dist/` is plain static files with relative paths, so it can be hosted in any folder (for example `/busapp/`).
- **Request budget.** Requests are spaced at least 2.2 s apart per host, back off on HTTP 429 and pause while the tab is hidden. Just after midnight the rain feed falls back to the previous day, because today's page answers 404 until the first reading lands.
- **Stack.** TypeScript, Vite 8, MapLibre GL 5.24 (pinned: deck.gl 9.4's interleaved renderer needs MapLibre 5; globe projection for the intro), deck.gl 9.4, self-hosted Inter and JetBrains Mono.
- **Security.** Strict Content-Security-Policy in the production build: scripts only from itself, and network only to the three hosts above plus images.data.gov.sg.

| File | Role |
|---|---|
| `src/feeds.ts` | Live feeds: request queue, parsers, health, round-trip times |
| `src/events.ts` | Signal generation from rain history (pure, unit-tested) |
| `src/analysis.ts` | Rain bands, nearest-gauge exposure, area stats, condition rules (pure, unit-tested) |
| `src/geo.ts` | Distances, bearings, grid index, geohash, DMS (pure, unit-tested) |
| `src/map.ts`, `src/mapstyle.ts` | Globe intro, 3D scene, tactical basemap, link arcs |
| `src/main.ts`, `src/ui.ts`, `src/styles.css` | Console |

## Data and licences

Government data: LTA and NEA via data.gov.sg, under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence). Basemap: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors. BUNI Transit is independent and not endorsed by any agency. Not for navigation, safety or emergency decisions.

## Known limits

- Rain is a point reading at the nearest gauge; the median stop is about 1.1 km from it.
- The traffic-camera feed currently reports about 8 cameras; the wall shows whatever is reporting.
- The keyless API limit is per IP address. Many viewers behind one office IP may see brief "rate limited" retries.
- OSM building heights are approximate. The bundle is 1.7 MB (about 470 KB gzipped), normal for a WebGL map.

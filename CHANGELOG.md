# Changelog

## 1.1.0 · 26 November 2026 · Console

The interface is redesigned as an open-source intelligence console. Same data and rules, much more instrument.

**New**
- Boot terminal that reports each real feed as it connects, then a dive from a spinning globe into 3D Singapore.
- Status bar with a condition level (NOMINAL / WATCH / ALERT) from published rules, feed health, request count, SGT and UTC clocks, and a live signal ticker.
- SITREP: a plain-language situation report from live data.
- Signal log: rain onset, cessation and intensification at each gauge (rebuilt from the 2-hour history), located lightning (cloud-to-ground strikes near stops called out), forecast changes per area, taxi-supply swings, feed uplinks, outages and recoveries.
- HUD: heading tape, reticle, coordinate grid, and centre and cursor readouts with the nearest stop.
- Asset dossiers for stops, gauges, cameras, strikes and areas: decimal, DMS and geohash coordinates, a link-analysis graph, and arcs on the map.
- Area matrix: 47 areas with forecast, stops, stops under rain, free taxis and 10-minute change. Sortable.
- Camera wall of every reporting LTA traffic camera.
- Area deep links (`#/area/<name>`), feed round-trip times, keyboard shortcuts (`G` grid), new social card.

**Fixed**
- 26 Nov hotfix: the closed Method/Sources/About layer stayed on screen invisibly and blocked every click. Hidden elements are now always hidden, and the boot screen leaves after 12 s at most. Checked with real mouse clicks: 18/18 controls respond.
- Just after midnight the rain feed answered 404 for the new day. It now falls back to the previous day.
- A rain window only counts once it holds at least 60% of the usual gauges, never fewer than 24, so a half-filled reading can't show "0 of 4".
- The HUD readout always settles on the final camera position.

## 1.0.0 · 25 November 2026 (not released; superseded by 1.1.0)

First full release. Rebuilt from scratch (the MVP's code was reviewed, not reused).

**New**
- 3D city map: dark custom basemap, OSM building heights, MRT lines, camera presets, auto-orbit, cinematic intro.
- Six live feeds, all keyless and fetched in the browser: rainfall, taxi availability, lightning, 2-hour forecast, air temperature, traffic cameras.
- Rain at every bus stop by its nearest reporting gauge, with the distance shown. Replaces the MVP's fixed 1 km rule, which left about 56% of stops unassessed.
- Two-hour rain replay with play, scrub and jump-to-live.
- Lenses: Pulse, Network (stop-density hexagons), Taxis (supply hexagons).
- Stop inspector with deep links (`#/stop/<code>`): rain chart, forecast, nearby taxis, lightning, nearest camera still.
- Live insights, plus Method, Sources (live feed health) and About pages.
- Phone layout with bottom sheet.
- Social card (og.png), favicon, web manifest, strict Content-Security-Policy.
- Fresh LTA bus-stop dataset (5,205 stops, published 6 Oct 2026), including cross-border stop 46239 at Larkin, Johor Bahru.

**Fixed from the MVP**
- A gauge with no reading now shows as "No reading", never as dry.
- The newest rain window is used only once 60% of gauges have reported (it fills in over a few minutes).
- Stale data is labelled on the card it affects, not only in a side panel.

**Not included (by design)**
- Bus positions, arrivals and delay estimates: these wait for an LTA DataMall key (v1.1).

// Tactical basemap from OpenFreeMap vector tiles (OpenMapTiles schema, OSM data).
// Opens as a globe with an atmosphere; the app switches to flat 3D once it has dived into Singapore.
import type { StyleSpecification } from 'maplibre-gl';

const LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const POLY = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
const FONT = ['Noto Sans Regular'];
const FONT_B = ['Noto Sans Bold'];

export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · Data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> contributors';

/** Coordinate grid over Singapore every 0.05° with edge labels. */
function graticule(): GeoJSON.FeatureCollection {
  const f: GeoJSON.Feature[] = [];
  const [w, s, e, n] = [103.55, 1.15, 104.15, 1.5];
  const step = 0.05;
  for (let lon = w; lon <= e + 1e-9; lon += step) {
    const x = +lon.toFixed(2);
    f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x, s], [x, n]] } });
    f.push({ type: 'Feature', properties: { label: `${x.toFixed(2)}°E` }, geometry: { type: 'Point', coordinates: [x, n - 0.006] } });
  }
  for (let lat = s; lat <= n + 1e-9; lat += step) {
    const y = +lat.toFixed(2);
    f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[w, y], [e, y]] } });
    f.push({ type: 'Feature', properties: { label: `${y.toFixed(2)}°N` }, geometry: { type: 'Point', coordinates: [w + 0.012, y] } });
  }
  return { type: 'FeatureCollection', features: f };
}

export function tacticalStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'BUNI Transit Tactical',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    projection: { type: 'globe' },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: ATTRIBUTION },
      grid: { type: 'geojson', data: graticule() },
    },
    sky: {
      'sky-color': '#03070a',
      'horizon-color': '#0a3340',
      'fog-color': '#03070a',
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.8,
      'fog-ground-blend': 0.6,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0] as any,
    },
    light: { anchor: 'viewport', color: '#cdeff7', intensity: 0.3, position: [1.4, 205, 35] },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a1013' } },
      { id: 'landuse-res', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['all', POLY, ['==', ['get', 'class'], 'residential']] as any, paint: { 'fill-color': '#0c1418', 'fill-opacity': 0.85 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#0a1714', 'fill-opacity': 0.9 } },
      { id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['all', POLY, ['match', ['get', 'class'], ['wood', 'grass', 'farmland', 'wetland'], true, false]] as any, paint: { 'fill-color': '#0a1613', 'fill-opacity': 0.85 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['all', POLY, ['!=', ['get', 'brunnel'], 'tunnel']] as any, paint: { 'fill-color': '#020506', 'fill-antialias': false } },
      { id: 'coast-glow', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['all', POLY, ['!=', ['get', 'brunnel'], 'tunnel']] as any, paint: { 'line-color': '#12b5d4', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 9, 0.45, 15, 0.18], 'line-blur': 2.5, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 10, 3, 15, 4] } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['all', POLY, ['!=', ['get', 'brunnel'], 'tunnel']] as any, paint: { 'line-color': '#2fe0ff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.55, 12, 0.4], 'line-width': 0.6 } },
      { id: 'boundary', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]] as any, paint: { 'line-color': '#2a8fa3', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 10, 1.2], 'line-dasharray': [3, 2] } },
      { id: 'aeroway', type: 'fill', source: 'omt', 'source-layer': 'aeroway', filter: POLY as any, paint: { 'fill-color': '#0d171b' } },
      { id: 'grid-line', type: 'line', source: 'grid', minzoom: 8.5, filter: ['==', ['geometry-type'], 'LineString'] as any, paint: { 'line-color': '#2fe0ff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, 0.09, 15, 0.05], 'line-width': 0.8 } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12, filter: ['all', LINE, ['match', ['get', 'class'], ['minor', 'service', 'track'], true, false]] as any, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#10211f', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.4, 18, 8] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8, filter: ['all', LINE, ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false]] as any, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#163238', 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.3, 12, 1.1, 18, 14] } },
      { id: 'road-motorway-glow', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8, filter: ['all', LINE, ['==', ['get', 'class'], 'motorway']] as any, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#18b6d4', 'line-opacity': 0.13, 'line-blur': 4, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 3, 18, 36] } },
      { id: 'road-motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 6, filter: ['all', LINE, ['==', ['get', 'class'], 'motorway']] as any, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1f5866', 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 6, 0.4, 12, 1.5, 18, 18] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10, filter: ['all', LINE, ['match', ['get', 'class'], ['rail', 'transit'], true, false], ['!', ['has', 'service']]] as any, layout: { 'line-join': 'round' }, paint: { 'line-color': '#9b7bff', 'line-opacity': ['case', ['==', ['get', 'brunnel'], 'tunnel'], 0.25, 0.55], 'line-dasharray': [2, 1.4], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 2.2] } },
      { id: 'building-flat', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 12, maxzoom: 13.5, paint: { 'fill-color': '#0f1a1e', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 0.9] } },
      {
        id: 'building-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 13,
        filter: ['!', ['has', 'hide_3d']] as any,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#0f1b1f', 30, '#132529', 90, '#183139', 180, '#1f414b', 280, '#28586a'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 13.8, ['coalesce', ['get', 'render_height'], 8]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.9,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      { id: 'grid-label', type: 'symbol', source: 'grid', minzoom: 10, filter: ['==', ['geometry-type'], 'Point'] as any, layout: { 'text-field': ['get', 'label'] as any, 'text-font': FONT, 'text-size': 9.5, 'text-letter-spacing': 0.1, 'text-allow-overlap': false }, paint: { 'text-color': '#2b7f90', 'text-halo-color': '#05090b', 'text-halo-width': 1.2 } },
      { id: 'road-label', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 15, filter: LINE as any, layout: { 'symbol-placement': 'line', 'text-field': ['upcase', NAME] as any, 'text-font': FONT, 'text-size': 9.5, 'text-letter-spacing': 0.12, 'symbol-spacing': 380 }, paint: { 'text-color': '#3b6670', 'text-halo-color': '#05090b', 'text-halo-width': 1.3 } },
      { id: 'water-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 10, layout: { 'text-field': ['upcase', NAME] as any, 'text-font': FONT, 'text-size': 10, 'text-letter-spacing': 0.3 }, paint: { 'text-color': '#1d5866', 'text-halo-color': '#020506', 'text-halo-width': 1 } },
      { id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 12.5, filter: ['match', ['get', 'class'], ['neighbourhood', 'quarter', 'hamlet'], true, false] as any, layout: { 'text-field': ['upcase', NAME] as any, 'text-font': FONT, 'text-size': 9.5, 'text-letter-spacing': 0.14 }, paint: { 'text-color': '#4a7a85', 'text-halo-color': '#05090b', 'text-halo-width': 1.2 } },
      { id: 'place-suburb', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 10.5, filter: ['match', ['get', 'class'], ['suburb', 'town', 'village'], true, false] as any, layout: { 'text-field': ['upcase', NAME] as any, 'text-font': FONT_B, 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 15, 11.5], 'text-letter-spacing': 0.24 }, paint: { 'text-color': '#5f949f', 'text-halo-color': '#05090b', 'text-halo-width': 1.5 } },
      { id: 'place-country', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 7, filter: ['==', ['get', 'class'], 'country'] as any, layout: { 'text-field': ['upcase', NAME] as any, 'text-font': FONT_B, 'text-size': 10, 'text-letter-spacing': 0.3 }, paint: { 'text-color': '#2f7d8e', 'text-halo-color': '#020506', 'text-halo-width': 1.2 } },
    ],
  };
}

/** deck.gl layers sit beneath this layer, so labels stay on top. */
export const DECK_BEFORE_ID = 'grid-label';

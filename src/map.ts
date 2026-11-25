// The 3D scene: MapLibre basemap (globe intro, then flat 3D) with deck.gl layers interleaved into it.
// MapLibre is pinned to 5.x: deck.gl 9.4's interleaved renderer reads map.transform, which MapLibre 6 removed.
import { Map as MLMap, AttributionControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, ColumnLayer, LineLayer, ArcLayer, TextLayer } from '@deck.gl/layers';
import { HexagonLayer } from '@deck.gl/aggregation-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { tacticalStyle, DECK_BEFORE_ID } from './mapstyle.ts';
import { BANDS, mmPerHour, rainBand, forecastTone, fmtDistance, type Exposure, type ForecastArea, type Gauge, type RainFrame, type Strike } from './analysis.ts';
import type { Camera } from './feeds.ts';
import type { LonLat } from './geo.ts';
import { BAND_LABEL, BAND_RGBA, C, STOP_HEX_RANGE, TAXI_HEX_RANGE, type LayerKey, type Lens, type RGBA, type Selection } from './state.ts';

export interface LinkLine { to: LonLat; color: RGBA; label: string }

export interface Scene {
  lens: Lens;
  on: Record<LayerKey, boolean>;
  stops: LonLat[];
  codes: string[];
  exposure: Exposure | null;
  exposureVersion: number;
  gauges: Gauge[];
  frame: RainFrame | null;
  taxis: LonLat[];
  strikes: Strike[];
  cams: Camera[];
  areas: ForecastArea[];
  forecast: Map<string, string> | null;
  selection: Selection | null;
  focus: { at: LonLat; ring?: number; links: LinkLine[]; buses?: BusMark[] } | null;
}

/** A bus approaching the locked stop, at LTA's estimated position. */
export interface BusMark { pos: LonLat; label: string; monitored: boolean; load: 'SEA' | 'SDA' | 'LSD' | null }
const LOAD_RGBA: Record<string, RGBA> = { SEA: [53, 242, 161, 255], SDA: [255, 176, 32, 255], LSD: [255, 77, 77, 255] };

export interface Preset { center: LonLat; zoom: number; pitch: number; bearing: number }
export const PRESETS: Record<string, Preset & { label: string; code: string }> = {
  island: { label: 'Island', code: 'ISL', center: [103.8150, 1.3560], zoom: 10.6, pitch: 50, bearing: -12 },
  cbd: { label: 'CBD', code: 'CBD', center: [103.8540, 1.2832], zoom: 14.7, pitch: 64, bearing: -34 },
  changi: { label: 'Changi', code: 'CHG', center: [103.9870, 1.3540], zoom: 12.9, pitch: 58, bearing: 36 },
  jurong: { label: 'Jurong', code: 'JUR', center: [103.7420, 1.3360], zoom: 13.4, pitch: 60, bearing: -58 },
  woodlands: { label: 'Woodlands', code: 'WDL', center: [103.7880, 1.4360], zoom: 13.4, pitch: 58, bearing: 18 },
};

export interface ViewInfo { lng: number; lat: number; zoom: number; bearing: number; pitch: number }

export interface MapHandlers {
  onSelect: (s: Selection | null) => void;
  onUserMove: () => void;
  onView: (v: ViewInfo) => void;
  onCursor: (p: LonLat | null) => void;
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isNarrow = () => window.innerWidth <= 1100;

export function webglOK(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

const FONT_MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

export class TransitMap {
  map: MLMap;
  overlay: MapboxOverlay;
  scene: Scene | null = null;
  private idx: number[] = [];
  private t0 = performance.now();
  private tick = 0;
  private animTimer = 0;
  private orbitOn = false;
  private orbitRaf = 0;
  private spinRaf = 0;
  private flying = false;
  private deckOn = false;
  private fade = 0;
  private gridOn = true;
  private handlers: MapHandlers;
  ready: Promise<void>;

  constructor(container: HTMLElement, handlers: MapHandlers) {
    this.handlers = handlers;
    this.map = new MLMap({
      container,
      style: tacticalStyle(),
      center: [70, 8],
      zoom: isNarrow() ? 1.05 : 1.55,
      pitch: 0,
      bearing: 0,
      maxPitch: 78,
      minZoom: 1,
      maxZoom: 18.5,
      attributionControl: false,
      renderWorldCopies: false,
      canvasContextAttributes: { antialias: true },
    } as any);
    this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    this.overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      pickingRadius: 8,
      onClick: (info: PickingInfo) => this.pick(info),
      onHover: (info: PickingInfo) => { this.map.getCanvas().style.cursor = info.object !== undefined && info.object !== null ? 'pointer' : 'crosshair'; },
      getTooltip: (info: PickingInfo) => this.tooltip(info),
    } as any);
    this.map.addControl(this.overlay as any);

    const stopOrbit = () => { if (this.orbitOn && !this.flying) { this.setOrbit(false); this.handlers.onUserMove(); } };
    for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) container.addEventListener(ev, stopOrbit, { passive: true });
    this.map.on('moveend', () => { this.flying = false; });
    const view = () => { const c = this.map.getCenter(); this.handlers.onView({ lng: c.lng, lat: c.lat, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() }); };
    this.map.on('move', view);
    this.map.on('mousemove', (e) => this.handlers.onCursor([e.lngLat.lng, e.lngLat.lat]));
    this.map.getCanvas().addEventListener('mouseleave', () => this.handlers.onCursor(null));
    this.map.getCanvas().style.cursor = 'crosshair';

    // Keep the canvas matched to its container (panels, phone rotation, late-loading CSS).
    new ResizeObserver(() => this.map.resize()).observe(container);

    this.ready = new Promise((res) => this.map.once('load', () => { view(); res(); }));
    // Compact attribution opens expanded by default; start it collapsed (the (i) button opens it).
    this.map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  }

  /* ---------------- camera ---------------- */
  /** Slow globe rotation while the console boots. */
  spin() {
    if (reduceMotion()) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(64, now - last); last = now;
      if (!this.deckOn && !this.flying) {
        const c = this.map.getCenter();
        this.map.setCenter([c.lng + dt * 0.0075, c.lat]);
      }
      this.spinRaf = requestAnimationFrame(step);
    };
    this.spinRaf = requestAnimationFrame(step);
  }

  /** Dive from the globe into Singapore, then switch to flat 3D and bring the data layers in. */
  async dive(target: Preset) {
    await this.ready;
    cancelAnimationFrame(this.spinRaf);
    const dur = reduceMotion() ? 0 : 7400;
    this.flying = true;
    this.map.flyTo({ ...target, duration: dur, curve: 1.5, essential: true });
    if (dur) await new Promise<void>((res) => this.map.once('moveend', () => res()));
    this.land();
  }

  /** Skip the intro: jump straight into flat 3D. */
  async jump(target: Preset) {
    await this.ready;
    cancelAnimationFrame(this.spinRaf);
    this.map.jumpTo(target);
    this.land();
  }

  private land() {
    this.map.setProjection({ type: 'mercator' });
    this.deckOn = true;
    const start = performance.now();
    const fadeIn = () => {
      this.fade = Math.min(1, (performance.now() - start) / 900);
      if (this.scene) this.overlay.setProps({ layers: this.layers(this.scene) });
      if (this.fade < 1) setTimeout(fadeIn, 60);
    };
    fadeIn();
  }

  get landed() { return this.deckOn; }

  goTo(p: Preset) {
    this.flying = true;
    this.map.flyTo({ ...p, duration: reduceMotion() ? 0 : 2600, curve: 1.3, essential: true });
  }

  focus(pos: LonLat, zoom = 15.6) {
    this.flying = true;
    this.map.flyTo({ center: pos, zoom: Math.max(zoom, Math.min(this.map.getZoom(), 17)), pitch: Math.max(55, this.map.getPitch()), bearing: this.map.getBearing(), duration: reduceMotion() ? 0 : 1800, essential: true });
  }

  zoomBy(d: number) { this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 300 }); }
  north() { this.map.easeTo({ bearing: 0, duration: 600 }); }

  setOrbit(on: boolean) {
    this.orbitOn = on && !reduceMotion();
    cancelAnimationFrame(this.orbitRaf);
    if (!this.orbitOn) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(64, now - last); last = now;
      if (!this.flying && !this.map.isMoving()) this.map.setBearing(this.map.getBearing() + dt * 0.0042);
      this.orbitRaf = requestAnimationFrame(step);
    };
    this.orbitRaf = requestAnimationFrame(step);
  }
  get orbiting() { return this.orbitOn; }

  /* ---------------- picking ---------------- */
  private pick(info: PickingInfo) {
    const id = info.layer?.id ?? '';
    const o = info.object as any;
    if (o === undefined || o === null) { this.handlers.onSelect(null); return; }
    if (id === 'stops') this.handlers.onSelect({ kind: 'stop', i: o as number });
    else if (id === 'rain-columns' || id === 'rain-rings') this.handlers.onSelect({ kind: 'gauge', id: (o as Gauge).id });
    else if (id === 'cams') this.handlers.onSelect({ kind: 'cam', id: (o as Camera).id });
    else if (id.startsWith('strike')) this.handlers.onSelect({ kind: 'strike', i: this.scene?.strikes.indexOf(o as Strike) ?? -1 });
    else if (id === 'forecast') this.handlers.onSelect({ kind: 'area', name: (o as ForecastArea).name });
  }

  private tooltip(info: PickingInfo): any {
    const s = this.scene;
    const o = info.object as any;
    if (!s || o === undefined || o === null) return null;
    const id = info.layer?.id ?? '';
    const row = (k: string, v: string) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`;
    let html = '';
    if (id === 'stops') {
      const i = o as number;
      const e = s.exposure;
      const band = e ? BANDS[e.band[i]] : 'unknown';
      html = `<div class="tt-title">BUS STOP ${s.codes[i]}</div>` + row('RAIN', BAND_LABEL[band].toUpperCase()) + (e && e.gauge[i] >= 0 ? row('GAUGE', fmtDistance(e.dist[i])) : '');
    } else if (id === 'rain-columns' || id === 'rain-rings') {
      const g = o as Gauge;
      const v = s.frame?.values.get(g.id);
      html = `<div class="tt-title">GAUGE ${esc(g.id)} · ${esc(g.name.toUpperCase())}</div>` + row('5-MIN', v === undefined ? 'NO READING' : `${v.toFixed(1)} MM`) + (v !== undefined ? row('RATE', `${mmPerHour(v).toFixed(1)} MM/H`) : '');
    } else if (id === 'cams') {
      html = `<div class="tt-title">CAM ${esc((o as Camera).id)}</div>` + row('FRAME', timeSGT((o as Camera).t, true));
    } else if (id.startsWith('strike')) {
      const k = o as Strike;
      html = `<div class="tt-title">${k.kind === 'ground' ? 'CLOUD-TO-GROUND' : 'CLOUD-TO-CLOUD'}</div>` + row('TIME', timeSGT(k.t, true));
    } else if (id === 'stop-hex') {
      html = `<div class="tt-title">${o.count ?? o.points?.length ?? 0} STOPS / 450 M CELL</div>` + row('UNDER RAIN', `${Math.round((o.colorValue ?? 0) * 100)}%`);
    } else if (id === 'taxi-hex') {
      html = `<div class="tt-title">${o.count ?? o.points?.length ?? 0} TAXIS / 320 M CELL</div>`;
    } else if (id === 'forecast') {
      html = `<div class="tt-title">${esc((o as ForecastArea).name.toUpperCase())}</div>` + row('2H FCST', esc((s.forecast?.get(o.name) ?? '').toUpperCase()));
    } else return null;
    return { html, className: 'deck-tt', style: { background: 'transparent', padding: '0' } };
  }

  /* ---------------- layers ---------------- */
  render(scene: Scene) {
    this.scene = scene;
    if (scene.on.grid !== this.gridOn && this.map.isStyleLoaded()) {
      this.gridOn = scene.on.grid;
      for (const l of ['grid-line', 'grid-label']) this.map.setLayoutProperty(l, 'visibility', this.gridOn ? 'visible' : 'none');
    }
    if (this.idx.length !== scene.stops.length) this.idx = Array.from({ length: scene.stops.length }, (_, i) => i);
    // Animate only while something moves: lightning rings or the selection pulse.
    const animate = !reduceMotion() && ((scene.on.lightning && scene.strikes.length > 0) || !!scene.focus);
    if (animate && !this.animTimer) {
      this.animTimer = window.setInterval(() => { this.tick++; if (this.scene && this.deckOn) this.overlay.setProps({ layers: this.layers(this.scene) }); }, 80);
    } else if (!animate && this.animTimer) { clearInterval(this.animTimer); this.animTimer = 0; }
    this.overlay.setProps({ layers: this.deckOn ? this.layers(scene) : [] });
  }

  private layers(s: Scene): Layer[] {
    const L: Layer[] = [];
    const lens = s.lens;
    const e = s.exposure;
    const B = { beforeId: DECK_BEFORE_ID } as any;
    const o = (v: number) => v * this.fade;
    const now = (performance.now() - this.t0) / 1000;

    if (lens === 'network') {
      L.push(new HexagonLayer<number>({
        id: 'stop-hex', ...B, data: this.idx,
        getPosition: (i: number) => s.stops[i],
        getColorWeight: (i: number) => (e && e.band[i] >= 2 ? 1 : 0), colorAggregation: 'MEAN', colorDomain: [0, 1],
        getElevationWeight: () => 1, elevationAggregation: 'SUM',
        radius: 450, coverage: 0.82, extruded: true, elevationRange: [0, 2200], elevationScale: 1, upperPercentile: 100,
        colorRange: STOP_HEX_RANGE as any, pickable: true, gpuAggregation: false, opacity: o(0.92),
        material: { ambient: 0.55, diffuse: 0.55, shininess: 28, specularColor: [60, 140, 160] },
        updateTriggers: { getColorWeight: s.exposureVersion },
      } as any));
    }

    if (lens === 'taxis' && s.on.taxis) {
      L.push(new HexagonLayer<LonLat>({
        id: 'taxi-hex', ...B, data: s.taxis, getPosition: (d: LonLat) => d,
        radius: 320, coverage: 0.8, extruded: true, elevationRange: [0, 4200], elevationScale: 1, upperPercentile: 99.5,
        colorRange: TAXI_HEX_RANGE as any, pickable: true, gpuAggregation: false, opacity: o(0.92),
        material: { ambient: 0.6, diffuse: 0.55, shininess: 24, specularColor: [120, 100, 60] },
      } as any));
    }

    if (s.on.stops && lens !== 'network') {
      L.push(new ScatterplotLayer<number>({
        id: 'stops', ...B, data: this.idx,
        getPosition: (i: number) => s.stops[i],
        getRadius: (i: number) => (e && e.band[i] >= 2 ? 34 : 20),
        radiusUnits: 'meters', radiusMinPixels: 1.2, radiusMaxPixels: 7,
        getFillColor: (i: number) => (e ? BAND_RGBA[BANDS[e.band[i]]] : BAND_RGBA.unknown),
        pickable: true, opacity: o(lens === 'taxis' ? 0.35 : 1),
        updateTriggers: { getFillColor: s.exposureVersion, getRadius: s.exposureVersion },
      }));
    }

    if (s.on.rain && s.gauges.length) {
      const f = s.frame;
      const reporting = s.gauges.filter((g) => f?.values.has(g.id));
      const wet = reporting.filter((g) => (f?.values.get(g.id) ?? 0) > 0);
      L.push(new ScatterplotLayer<Gauge>({
        id: 'rain-rings', ...B, data: reporting, getPosition: (g) => g.pos,
        getRadius: 300, radiusUnits: 'meters', radiusMinPixels: 3.5, stroked: true, filled: false,
        lineWidthUnits: 'pixels', getLineWidth: 1.1, opacity: o(1),
        getLineColor: (g) => { const c = BAND_RGBA[rainBand(f?.values.get(g.id))]; return [c[0], c[1], c[2], 170]; },
        updateTriggers: { getLineColor: f?.t }, pickable: true,
      }));
      L.push(new ScatterplotLayer<Gauge>({
        id: 'rain-dots', ...B, data: reporting, getPosition: (g) => g.pos,
        getRadius: 55, radiusUnits: 'meters', radiusMinPixels: 1.6, radiusMaxPixels: 4, opacity: o(1),
        getFillColor: (g) => { const c = BAND_RGBA[rainBand(f?.values.get(g.id))]; return [c[0], c[1], c[2], 230]; },
        updateTriggers: { getFillColor: f?.t },
      }));
      if (lens !== 'taxis' && wet.length) {
        const elev = (g: Gauge) => 160 + Math.min(mmPerHour(f?.values.get(g.id) ?? 0), 60) * 90;
        L.push(new ColumnLayer<Gauge>({
          id: 'rain-columns', ...B, data: wet, getPosition: (g) => g.pos,
          diskResolution: 36, radius: 230, extruded: true, elevationScale: 1, opacity: o(0.88),
          getElevation: elev,
          getFillColor: (g) => BAND_RGBA[rainBand(f?.values.get(g.id))],
          material: { ambient: 0.62, diffuse: 0.5, shininess: 64, specularColor: [200, 240, 255] },
          pickable: true,
          updateTriggers: { getElevation: f?.t, getFillColor: f?.t },
          transitions: { getElevation: { duration: 650 } },
        }));
        L.push(new TextLayer<Gauge>({
          id: 'rain-labels', data: wet, getPosition: (g: Gauge) => [g.pos[0], g.pos[1], elev(g) + 260],
          getText: (g: Gauge) => `${g.id} ${(f?.values.get(g.id) ?? 0).toFixed(1)}MM`,
          getSize: 10.5, sizeUnits: 'pixels', getColor: (g: Gauge) => BAND_RGBA[rainBand(f?.values.get(g.id))],
          fontFamily: FONT_MONO, fontWeight: 600, characterSet: 'auto', billboard: true, opacity: o(1),
          background: true, getBackgroundColor: [3, 8, 10, 215], backgroundPadding: [5, 2], getBorderColor: [47, 224, 255, 90], getBorderWidth: 1,
          updateTriggers: { getText: f?.t, getPosition: f?.t, getColor: f?.t },
        } as any));
      }
    }

    if (s.on.taxis && lens !== 'network') {
      L.push(new ScatterplotLayer<LonLat>({
        id: 'taxis', ...B, data: s.taxis, getPosition: (d) => d,
        getRadius: 11, radiusUnits: 'meters', radiusMinPixels: lens === 'taxis' ? 0.9 : 1.1, radiusMaxPixels: 5,
        getFillColor: C.taxi, opacity: o(lens === 'taxis' ? 0.45 : 0.9),
        parameters: { blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one' } as any,
      }));
    }

    if (s.on.cams && s.cams.length) {
      L.push(new ScatterplotLayer<Camera>({
        id: 'cams', ...B, data: s.cams, getPosition: (c) => c.pos,
        getRadius: 170, radiusUnits: 'meters', radiusMinPixels: 5, radiusMaxPixels: 12,
        stroked: true, filled: true, getFillColor: [3, 26, 18, 230], getLineColor: C.cam,
        lineWidthUnits: 'pixels', getLineWidth: 1.6, pickable: true, opacity: o(1),
      }));
      L.push(new TextLayer<Camera>({
        id: 'cam-labels', data: s.cams, getPosition: (c: Camera) => c.pos, getText: (c: Camera) => `CAM ${c.id}`,
        getSize: 9.5, sizeUnits: 'pixels', getColor: [53, 242, 161, 230], getPixelOffset: [0, -16],
        fontFamily: FONT_MONO, fontWeight: 600, characterSet: 'auto', opacity: o(1),
      } as any));
    }

    if (s.on.lightning && s.strikes.length) {
      const ground = s.strikes.filter((k) => k.kind === 'ground');
      const cloud = s.strikes.filter((k) => k.kind === 'cloud');
      const phase = (i: number) => (now / 1.8 + i * 0.37) % 1;
      L.push(new ScatterplotLayer<Strike>({
        id: 'strike-ring', data: s.strikes, getPosition: (k) => [k.pos[0], k.pos[1], 0],
        getRadius: (_k, { index }) => 250 + phase(index) * 2600, radiusUnits: 'meters', radiusMinPixels: 2,
        stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 1.4,
        getLineColor: (k, { index }) => { const c = k.kind === 'ground' ? C.ground : C.cloud; return [c[0], c[1], c[2], Math.round(230 * (1 - phase(index)))]; },
        updateTriggers: { getRadius: this.tick, getLineColor: this.tick }, opacity: o(1),
      }));
      L.push(new LineLayer<Strike>({
        id: 'strike-bolt', data: ground,
        getSourcePosition: (k) => [k.pos[0], k.pos[1], 4200], getTargetPosition: (k) => [k.pos[0], k.pos[1], 0],
        getColor: [255, 214, 214, 255], getWidth: 2.4, widthUnits: 'pixels', pickable: true,
        opacity: o(0.55 + 0.45 * Math.abs(Math.sin(now * 2.1))),
      }));
      L.push(new ScatterplotLayer<Strike>({
        id: 'strike-cloud', data: cloud, getPosition: (k) => [k.pos[0], k.pos[1], 3800],
        getRadius: 650, radiusUnits: 'meters', radiusMinPixels: 3, getFillColor: [255, 176, 32, 150], pickable: true,
        opacity: o(0.5 + 0.5 * Math.abs(Math.sin(now * 2.7))),
        parameters: { blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one' } as any,
      }));
    }

    if (s.on.forecast && s.forecast && s.areas.length && lens === 'pulse') {
      const wet = s.areas.filter((a) => { const t = forecastTone(s.forecast!.get(a.name)); return t === 'rain' || t === 'storm'; });
      L.push(new TextLayer<ForecastArea>({
        id: 'forecast', data: wet, getPosition: (a: ForecastArea) => [a.pos[0], a.pos[1], 700],
        getText: (a: ForecastArea) => `▲ ${a.name.toUpperCase()} · ${(s.forecast!.get(a.name) ?? '').toUpperCase()}`,
        getSize: 10.5, sizeUnits: 'pixels', getColor: [214, 200, 255, 255],
        fontFamily: FONT_MONO, fontWeight: 600, characterSet: 'auto', pickable: true,
        background: true, getBackgroundColor: [14, 8, 30, 220], backgroundPadding: [7, 3], getBorderColor: [178, 140, 255, 200], getBorderWidth: 1,
        billboard: true, opacity: o(1),
      } as any));
    }

    if (s.focus) {
      const g = s.focus;
      if (g.ring) {
        L.push(new ScatterplotLayer({
          id: 'sel-ring', data: [g.at], getPosition: (d: LonLat) => d, getRadius: g.ring, radiusUnits: 'meters',
          stroked: true, filled: true, getFillColor: [47, 224, 255, 10], getLineColor: [47, 224, 255, 150], lineWidthUnits: 'pixels', getLineWidth: 1,
        }));
      }
      if (g.links.length) {
        L.push(new ArcLayer<LinkLine>({
          id: 'sel-links', data: g.links, getSourcePosition: () => g.at, getTargetPosition: (d) => d.to,
          getSourceColor: C.select, getTargetColor: (d) => d.color, getWidth: 2.2, widthUnits: 'pixels', getHeight: 0.35,
        }));
        L.push(new TextLayer<LinkLine>({
          id: 'sel-link-labels', data: g.links, getPosition: (d: LinkLine) => d.to, getText: (d: LinkLine) => d.label,
          getSize: 10, sizeUnits: 'pixels', getColor: (d: LinkLine) => d.color, getPixelOffset: [0, -16],
          fontFamily: FONT_MONO, fontWeight: 600, characterSet: 'auto',
          background: true, getBackgroundColor: [3, 8, 10, 225], backgroundPadding: [5, 2],
        } as any));
      }
      if (g.buses?.length) {
        const col = (b: BusMark): RGBA => (b.load ? LOAD_RGBA[b.load] : [230, 252, 255, 255]);
        L.push(new LineLayer<BusMark>({
          id: 'bus-lines', data: g.buses, getSourcePosition: (b) => b.pos, getTargetPosition: () => g.at,
          getColor: (b) => { const c = col(b); return [c[0], c[1], c[2], 110]; }, getWidth: 1.2, widthUnits: 'pixels',
        }));
        L.push(new ScatterplotLayer<BusMark>({
          id: 'bus-pos', data: g.buses, getPosition: (b) => b.pos, getRadius: 70, radiusUnits: 'meters', radiusMinPixels: 6, radiusMaxPixels: 14,
          stroked: true, getFillColor: [3, 8, 10, 235], getLineColor: col, lineWidthUnits: 'pixels', getLineWidth: 2.2,
        }));
        L.push(new TextLayer<BusMark>({
          id: 'bus-labels', data: g.buses, getPosition: (b: BusMark) => b.pos, getText: (b: BusMark) => b.label,
          getSize: 10.5, sizeUnits: 'pixels', getColor: (b: BusMark) => col(b), getPixelOffset: [0, -18],
          fontFamily: FONT_MONO, fontWeight: 700, characterSet: 'auto',
          background: true, getBackgroundColor: [3, 8, 10, 230], backgroundPadding: [5, 2], getBorderColor: (b: BusMark) => col(b), getBorderWidth: 1,
        } as any));
      }
      const pulse = 60 + ((now % 1.6) / 1.6) * 220;
      L.push(new ScatterplotLayer({
        id: 'sel-pulse', data: [g.at], getPosition: (d: LonLat) => d, getRadius: pulse, radiusUnits: 'meters',
        stroked: true, filled: false, getLineColor: [230, 252, 255, 160], lineWidthUnits: 'pixels', getLineWidth: 1.2,
        updateTriggers: { getRadius: this.tick },
      }));
      L.push(new ScatterplotLayer({
        id: 'sel-dot', data: [g.at], getPosition: (d: LonLat) => d, getRadius: 42, radiusUnits: 'meters', radiusMinPixels: 5,
        stroked: true, getFillColor: [230, 252, 255, 255], getLineColor: [3, 8, 10, 255], lineWidthUnits: 'pixels', getLineWidth: 2,
      }));
    }
    return L;
  }

}

/* ---------------- shared formatting ---------------- */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function timeSGT(iso: string | number | null, seconds = false): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return d.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });
}

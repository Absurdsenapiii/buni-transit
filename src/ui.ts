// Console shell and small renderers. No framework: the map is the product, the DOM is the instrument panel.
import { esc } from './map.ts';

export const ICON = {
  search: '<path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="7"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  orbit: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  north: '<path d="M12 3l5 16-5-4-5 4z"/>',
};

export const icon = (name: keyof typeof ICON, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${ICON[name]}</svg>`;

export const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M16 2.8 27.4 9.4v13.2L16 29.2 4.6 22.6V9.4z" fill="none" stroke="#2fe0ff" stroke-width="2" stroke-linejoin="miter"/>
  <path d="M10.5 19.5 16 11.5l5.5 8" fill="none" stroke="#2fe0ff" stroke-width="1.8" stroke-linecap="square"/>
  <rect x="8.6" y="17.6" width="3.8" height="3.8" fill="#2fe0ff"/><rect x="14.1" y="9.6" width="3.8" height="3.8" fill="#e6fcff"/><rect x="19.6" y="17.6" width="3.8" height="3.8" fill="#ffb020"/>
</svg>`;

export interface Refs {
  root: HTMLElement;
  map: HTMLElement;
  level: HTMLElement;
  feedsCount: HTMLElement;
  reqCount: HTMLElement;
  sgt: HTMLElement;
  utc: HTMLElement;
  nav: HTMLElement;
  menuBtn: HTMLButtonElement;
  ticker: HTMLElement;
  sitrepT: HTMLElement;
  sitrep: HTMLElement;
  metrics: HTMLElement;
  sigCount: HTMLElement;
  sigFilters: HTMLElement;
  sigList: HTMLElement;
  hdTrack: HTMLElement;
  hdVal: HTMLElement;
  lens: HTMLElement;
  chips: HTMLElement;
  search: HTMLInputElement;
  results: HTMLElement;
  readout: HTMLElement;
  hudBr: HTMLElement;
  orbitBtn: HTMLButtonElement;
  rtabs: HTMLElement;
  rbody: HTMLElement;
  play: HTMLButtonElement;
  scrub: HTMLInputElement;
  histo: HTMLElement;
  ticks: HTMLElement;
  timeLabel: HTMLElement;
  liveBtn: HTMLButtonElement;
  tlMeta: HTMLElement;
  camMeta: HTMLElement;
  cams: HTMLElement;
  mtabs: HTMLElement;
  page: HTMLElement;
  pageBody: HTMLElement;
  boot: HTMLElement;
  bootLog: HTMLElement;
  toasts: HTMLElement;
}

export function buildShell(root: HTMLElement, presets: { key: string; code: string; label: string }[]): Refs {
  // Heading tape: ticks every 5°, labels every 15°, from -360° to 720° so it can scroll seamlessly.
  let tape = '';
  for (let d = -360; d <= 720; d += 5) {
    const n = ((d % 360) + 360) % 360;
    const lab = n % 90 === 0 ? ['N', 'E', 'S', 'W'][n / 90] : n % 45 === 0 ? ['NE', 'SE', 'SW', 'NW'][(n - 45) / 90] : n % 15 === 0 ? String(n).padStart(3, '0') : '';
    tape += `<i class="tk ${n % 15 === 0 ? 'maj' : ''}" style="left:${(d + 360) * 4}px">${lab ? `<span class="${n % 45 === 0 ? 'card' : ''}">${lab}</span>` : ''}</i>`;
  }

  root.innerHTML = `
  <header class="sysbar">
    <a class="brand" href="#/" aria-label="BUNI Transit console">${LOGO}<span class="b1">BUNI</span><span class="sl">//</span><span class="b2">TRANSIT-INT</span></a>
    <span class="tagx">OPEN SOURCE</span>
    <span class="tagx dim">SG · SIN</span>
    <span class="lvl" data-level="nominal" title="Condition level"><i></i>STATUS <b>NOMINAL</b></span>
    <span class="sysm">FEEDS <b class="feeds-count">0/6</b></span>
    <span class="sysm req">REQ <b class="req-count">0</b></span>
    <nav class="nav" aria-label="Main">
      <a href="#/" data-route="">Console</a><a href="#/method" data-route="method">Method</a><a href="#/sources" data-route="sources">Sources</a><a href="#/about" data-route="about">About</a>
    </nav>
    <span class="clk"><b class="sgt">--:--:--</b> SGT</span>
    <span class="clk utc"><b class="utcv">--:--:--</b>Z</span>
    <button class="ibtn menu" aria-label="Menu" aria-expanded="false">${icon('menu')}</button>
  </header>

  <div class="ticker" aria-label="Latest signals"><span class="tk-tag">LIVE ▸</span><div class="tk-vp"><div class="tk-track"></div></div></div>

  <main class="console">
    <aside class="col-left">
      <section class="box sitrep" data-m="sitrep">
        <header class="bh"><span>SITREP</span><time class="sitrep-t">--:--</time></header>
        <div class="sitrep-body"><p class="ld">Awaiting uplink…</p></div>
      </section>
      <section class="box ind" data-m="sitrep">
        <header class="bh"><span>INDICATORS</span><span class="bh-r">LIVE · SGT</span></header>
        <div class="mgrid"></div>
      </section>
      <section class="box sig" data-m="signals">
        <header class="bh"><span>SIGNALS</span><span class="sig-count">0</span></header>
        <div class="sig-filters" role="tablist" aria-label="Signal filter">
          ${['all', 'rain', 'bolt', 'taxi', 'fcst', 'sys'].map((k, i) => `<button data-f="${k}" aria-selected="${i === 0}">${k.toUpperCase()}</button>`).join('')}
        </div>
        <ol class="sig-list"></ol>
      </section>
    </aside>

    <section class="mapcell" data-m="map">
      <div id="map" class="map" role="application" aria-label="3D map of Singapore with live public data"></div>
      <div class="scanlines" aria-hidden="true"></div>
      <div class="hud">
        <i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br brr"></i>
        <div class="heading" aria-hidden="true"><div class="hd-track">${tape}</div><i class="hd-caret"></i><b class="hd-val">000°</b></div>
        <svg class="reticle" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="14"/><path d="M40 4v18M40 58v18M4 40h18M58 40h18"/><circle cx="40" cy="40" r="1.6" class="c"/></svg>
        <div class="hud-tl">
          <div class="seg lens" role="tablist" aria-label="Map lens">
            <button data-lens="pulse" aria-selected="true">PULSE</button><button data-lens="network" aria-selected="false">NETWORK</button><button data-lens="taxis" aria-selected="false">TAXIS</button>
          </div>
          <div class="chips" aria-label="Layers"></div>
        </div>
        <div class="hud-tr">
          <div class="search">${icon('search')}<input type="search" placeholder="LOCATE: STOP CODE / AREA / GAUGE" aria-label="Search bus stop code, area or rain gauge" autocomplete="off" spellcheck="false"/><kbd>/</kbd><div class="results" role="listbox" hidden></div></div>
        </div>
        <div class="hud-bl readout mono"></div>
        <div class="hud-br">
          <div class="vbtns">${presets.map((p) => `<button data-preset="${p.key}" title="${p.label}">${p.code}</button>`).join('')}</div>
          <div class="zbtns">
            <button class="ibtn" data-z="in" aria-label="Zoom in">${icon('plus')}</button>
            <button class="ibtn" data-z="out" aria-label="Zoom out">${icon('minus')}</button>
            <button class="ibtn" data-z="north" aria-label="Reset north">${icon('north')}</button>
            <button class="ibtn orbit" aria-pressed="false" aria-label="Auto-orbit" title="Auto-orbit (O)">${icon('orbit')}</button>
          </div>
        </div>
      </div>
    </section>

    <aside class="col-right box" data-m="right">
      <div class="rtabs" role="tablist">
        <button data-rtab="entity" aria-selected="false">ENTITY</button><button data-rtab="areas" aria-selected="true">AREAS</button><button data-rtab="feeds" aria-selected="false">FEEDS</button>
      </div>
      <div class="rbody"></div>
    </aside>

    <section class="bottom">
      <section class="box timeline" data-m="timeline">
        <header class="bh"><span>RAIN REPLAY</span><span class="tl-meta">2H · 0 FRAMES</span></header>
        <div class="tl-row">
          <button class="ibtn play" aria-label="Play rain replay">${icon('play')}</button>
          <div class="scrub-wrap"><div class="ticks" aria-hidden="true"></div><div class="histo" aria-hidden="true"></div><input class="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="Rain replay time"/></div>
          <b class="tl-time mono">--:--</b>
          <button class="live-btn is-live" aria-label="Jump to latest reading">LIVE</button>
        </div>
      </section>
      <section class="box camwall" data-m="cams">
        <header class="bh"><span>CAMERA WALL · LTA</span><span class="cam-meta">— ONLINE</span></header>
        <div class="cams"></div>
      </section>
    </section>
  </main>

  <nav class="mtabs" aria-label="Panels">
    ${['sitrep', 'signals', 'areas', 'cams', 'entity'].map((k, i) => `<button data-mtab="${k}" aria-selected="${i === 0}">${k.toUpperCase()}</button>`).join('')}
  </nav>

  <section class="page" hidden aria-modal="true" role="dialog" aria-label="Document">
    <div class="page-card"><button class="ibtn page-close" aria-label="Close">${icon('close')}</button><div class="page-body"></div></div>
  </section>

  <div class="boot" aria-live="polite">
    <div class="boot-term"><pre class="boot-log"></pre><button class="boot-skip">[ SKIP INTRO ▸ ]</button></div>
  </div>
  <div class="toasts" aria-live="polite"></div>`;

  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  return {
    root,
    map: q('#map'),
    level: q('.lvl'),
    feedsCount: q('.feeds-count'),
    reqCount: q('.req-count'),
    sgt: q('.sgt'),
    utc: q('.utcv'),
    nav: q('.nav'),
    menuBtn: q<HTMLButtonElement>('.menu'),
    ticker: q('.tk-track'),
    sitrepT: q('.sitrep-t'),
    sitrep: q('.sitrep-body'),
    metrics: q('.mgrid'),
    sigCount: q('.sig-count'),
    sigFilters: q('.sig-filters'),
    sigList: q('.sig-list'),
    hdTrack: q('.hd-track'),
    hdVal: q('.hd-val'),
    lens: q('.lens'),
    chips: q('.chips'),
    search: q<HTMLInputElement>('.search input'),
    results: q('.results'),
    readout: q('.readout'),
    hudBr: q('.hud-br'),
    orbitBtn: q<HTMLButtonElement>('.orbit'),
    rtabs: q('.rtabs'),
    rbody: q('.rbody'),
    play: q<HTMLButtonElement>('.play'),
    scrub: q<HTMLInputElement>('.scrub'),
    histo: q('.histo'),
    ticks: q('.ticks'),
    timeLabel: q('.tl-time'),
    liveBtn: q<HTMLButtonElement>('.live-btn'),
    tlMeta: q('.tl-meta'),
    camMeta: q('.cam-meta'),
    cams: q('.cams'),
    mtabs: q('.mtabs'),
    page: q('.page'),
    pageBody: q('.page-body'),
    boot: q('.boot'),
    bootLog: q('.boot-log'),
    toasts: q('.toasts'),
  };
}

/* ---------------- small renderers ---------------- */
export function sparkline(values: number[], color: string, opts: { w?: number; h?: number; marker?: number } = {}): string {
  const w = opts.w ?? 120, h = opts.h ?? 26;
  if (values.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${h - 1.5}" y2="${h - 1.5}" stroke="${color}" stroke-opacity=".3" stroke-dasharray="2 3"/></svg>`;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const m = opts.marker !== undefined && pts[opts.marker] ? `<rect x="${(pts[opts.marker][0] - 2).toFixed(1)}" y="${(pts[opts.marker][1] - 2).toFixed(1)}" width="4" height="4" fill="${color}"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w},${h}L0,${h}Z" fill="${color}" fill-opacity=".1"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.3" vector-effect="non-scaling-stroke"/>${m}</svg>`;
}

export function bars(values: (number | null)[], colorOf: (v: number | null) => string, opts: { w?: number; h?: number; active?: number } = {}): string {
  const w = opts.w ?? 300, h = opts.h ?? 40, n = values.length || 1;
  const max = Math.max(0.2, ...values.map((v) => v ?? 0));
  const bw = w / n;
  return `<svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${values.map((v, i) => {
    const bh = v === null ? 1.5 : Math.max(1.5, (v / max) * (h - 3));
    return `<rect x="${(i * bw + 0.8).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1.6).toFixed(1)}" height="${bh.toFixed(1)}" fill="${colorOf(v)}" ${opts.active === i ? 'stroke="#e6fcff" stroke-width="1"' : ''}/>`;
  }).join('')}</svg>`;
}

/** Link-analysis graph: the selected asset in the centre, related assets around it. */
export function linkGraph(center: { label: string; color: string }, nodes: { label: string; sub: string; color: string }[]): string {
  const w = 340, h = 190, cx = w / 2, cy = h / 2;
  const n = nodes.length;
  const pos = nodes.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1) + (n === 2 ? Math.PI / 2 : 0);
    return [cx + Math.cos(a) * 112, cy + Math.sin(a) * 60];
  });
  const edges = nodes.map((nd, i) => `<line x1="${cx}" y1="${cy}" x2="${pos[i][0].toFixed(1)}" y2="${pos[i][1].toFixed(1)}" stroke="${nd.color}" stroke-opacity=".55" stroke-dasharray="3 3"/>
    <text x="${((cx + pos[i][0]) / 2).toFixed(1)}" y="${((cy + pos[i][1]) / 2 - 4).toFixed(1)}" class="eg">${esc(nd.sub)}</text>`).join('');
  const nodeEls = nodes.map((nd, i) => {
    const [x, y] = pos[i];
    // Labels sit centred above or below their node so nothing clips at the panel edge.
    const tx = Math.min(w - 44, Math.max(44, x));
    const ty = y < cy - 8 ? y - 10 : y + 17;
    return `<rect x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9" fill="#05090b" stroke="${nd.color}" stroke-width="1.6"/><text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" class="nl" fill="${nd.color}">${esc(nd.label)}</text>`;
  }).join('');
  return `<svg class="lgraph" viewBox="0 0 ${w} ${h}" aria-hidden="true">${edges}${nodeEls}
    <rect x="${cx - 7}" y="${cy - 7}" width="14" height="14" fill="${center.color}"/><rect x="${cx - 12}" y="${cy - 12}" width="24" height="24" fill="none" stroke="${center.color}" stroke-opacity=".5"/>
    <text x="${cx}" y="${cy + 28}" text-anchor="middle" class="nl c" fill="${center.color}">${esc(center.label)}</text></svg>`;
}

export function toast(refs: Refs, text: string, tone: 'info' | 'warn' | 'err' = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = text;
  refs.toasts.append(el);
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4800);
}

export const fmtInt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-SG') : '—');

/** Animate a number in an element from its previous value. */
export function countTo(el: HTMLElement, target: number, format: (n: number) => string) {
  const from = Number(el.dataset.v ?? NaN);
  el.dataset.v = String(target);
  if (!Number.isFinite(from) || from === target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = format(target); return; }
  const t0 = performance.now(), dur = 700;
  const step = (now: number) => {
    if (el.dataset.v !== String(target)) return;
    const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
    el.textContent = format(from + (target - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // Land on the exact value even where animation frames are paused.
  setTimeout(() => { if (el.dataset.v === String(target)) el.textContent = format(target); }, dur + 80);
}

export { esc };

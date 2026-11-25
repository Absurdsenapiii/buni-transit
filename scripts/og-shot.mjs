// Photographs the live site for the social card (public/og.png, 1200x630: the 1600x840 desktop layout at 0.75).
// Usage: start the release preview (npm run build && npm run preview), then
//   node scripts/og-shot.mjs [url]       default url: http://localhost:4174/?still
// Drives headless Microsoft Edge over the DevTools protocol and waits until the
// map has finished loading tiles and live data before taking the picture.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4174/?still';
const out = new URL('../public/og.png', import.meta.url);
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!edge) throw new Error('Microsoft Edge not found');

const port = 9333;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'buni-og-'));
const proc = spawn(edge, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1600,840', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) throw new Error('Edge did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 840, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url });

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await sleep(500);
  const r = await send('Runtime.evaluate', { expression: 'document.documentElement.dataset.ready === "1"', returnByValue: true });
  ready = r.result?.result?.value === true;
}
if (!ready) console.warn('Map never reported ready; capturing anyway.');
await sleep(1500); // let fonts, labels and the last frame settle
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1600, height: 840, scale: 0.75 } });
await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'));
console.log(`Wrote ${path.basename(out.pathname)} (${ready ? 'map ready' : 'not ready'})`);
ws.close();
proc.kill();
await sleep(500);
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});

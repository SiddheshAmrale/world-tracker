#!/usr/bin/env node
// Headless performance profile of a running build (dev or `vite preview`).
//
//   node scripts/perf-profile.mjs --url http://localhost:4174 [--seconds 30] [--json out.json]
//
// Opens the app, enters LIVE CONTACTS (the busiest everyday view: hundreds of
// aircraft, labels and HUD), lets it settle, then measures over a window:
//   - time to first rendered globe frame after navigation
//   - main-thread busy time split into script / layout / style
//   - frames rendered (scene.postRender) and their rate
//   - JS heap, network requests and bytes during the window
//   - the hottest JS functions by self time (CPU profile)
// Headless Chromium renders WebGL with SwiftShader, so absolute frame rates are
// not meaningful; main-thread script/task time and request volume are.

import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:4174');
const seconds = Number(arg('seconds', '30'));
const settle = Number(arg('settle', '20'));
const jsonOut = arg('json', null);
// Optional: also report who calls functions whose name/location contains this text.
const callersOf = arg('callers', null);

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--window-size=1280,800',
    '--enable-unsafe-swiftshader',
  ],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable');

await page.evaluateOnNewDocument(() => {
  window.__perf = { frames: 0, firstFrameAt: null };
  const hook = () => {
    const viewer = window.__godsEyeView?.viewer;
    if (!viewer) return void setTimeout(hook, 50);
    viewer.scene.postRender.addEventListener(() => {
      window.__perf.frames += 1;
      if (window.__perf.firstFrameAt === null)
        window.__perf.firstFrameAt = performance.now();
    });
  };
  hook();
});

const requests = [];
page.on('requestfinished', async (req) => {
  const res = req.response();
  let bytes = 0;
  try {
    bytes =
      Number(res?.headers()['content-length'] || 0) ||
      (await res.buffer()).length;
  } catch {}
  requests.push({
    t: Date.now(),
    url: req.url(),
    type: req.resourceType(),
    bytes,
  });
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__perf?.firstFrameAt !== null, {
  timeout: 120000,
});
const firstFrameMs = await page.evaluate(() =>
  Math.round(window.__perf.firstFrameAt),
);
const loadBytes = requests.reduce((s, r) => s + r.bytes, 0);
const loadJs = requests
  .filter((r) => r.type === 'script')
  .reduce((s, r) => s + r.bytes, 0);

const metrics = async () =>
  Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );

/** Measure one window: CDP metrics deltas, frames, requests and a CPU profile. */
async function measure(label, secs) {
  const before = await metrics();
  const framesBefore = await page.evaluate(() => window.__perf.frames);
  const reqStart = requests.length;
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await new Promise((r) => setTimeout(r, secs * 1000));
  const { profile } = await cdp.send('Profiler.stop');
  const after = await metrics();
  const frames =
    (await page.evaluate(() => window.__perf.frames)) - framesBefore;
  const windowReqs = requests.slice(reqStart);

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    if (['(idle)', '(program)', '(root)'].includes(f.functionName)) return;
    const key = `${f.functionName || '(anonymous)'}  ${f.url.split('/').slice(-1)[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  });
  // Self time of matching functions, attributed to their callers (2 levels up).
  const callers = new Map();
  if (callersOf) {
    const parent = new Map();
    for (const n of profile.nodes)
      for (const c of n.children || []) parent.set(c, n.id);
    const label = (id) => {
      const f = byId.get(id)?.callFrame;
      return f
        ? `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-1)[0].split('?')[0]}:${f.lineNumber + 1}`
        : '?';
    };
    profile.samples.forEach((id, i) => {
      const own = label(id);
      const hit = callersOf.split('|').find((c) => own.includes(c));
      if (!hit) return;
      const p1 = parent.get(id);
      const p2 = parent.get(p1);
      const key = `[${hit}] ${label(p1)}  <-  ${label(p2)}  <-  ${label(parent.get(p2))}`;
      callers.set(
        key,
        (callers.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000,
      );
    });
  }
  const bySource = {};
  for (const r of windowReqs) {
    const u = new URL(r.url);
    const key = u.pathname.startsWith('/api/')
      ? u.pathname.split('/').slice(0, 3).join('/')
      : u.host;
    bySource[key] = (bySource[key] || 0) + 1;
  }
  const d = (k) => after[k] - before[k];
  return {
    label,
    seconds: secs,
    mainThreadBusyPct: +((d('TaskDuration') / secs) * 100).toFixed(1),
    scriptPct: +((d('ScriptDuration') / secs) * 100).toFixed(1),
    layoutPct: +((d('LayoutDuration') / secs) * 100).toFixed(1),
    stylePct: +((d('RecalcStyleDuration') / secs) * 100).toFixed(1),
    layoutsPerSec: +(d('LayoutCount') / secs).toFixed(1),
    styleRecalcsPerSec: +(d('RecalcStyleCount') / secs).toFixed(1),
    framesPerSec: +(frames / secs).toFixed(1),
    jsHeapMB: +(after.JSHeapUsedSize / 1048576).toFixed(1),
    domNodes: after.Nodes,
    requests: windowReqs.length,
    requestKB: Math.round(windowReqs.reduce((s, r) => s + r.bytes, 0) / 1024),
    requestsBySource: Object.fromEntries(
      Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
    ),
    ...(callersOf && {
      callersMs: Object.fromEntries(
        [...callers.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([k, v]) => [k, Math.round(v)]),
      ),
    }),
    hottestFunctionsMs: Object.fromEntries(
      [...self.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 18)
        .map(([k, v]) => [k, Math.round(v)]),
    ),
  };
}

// 1) Idle: the first-launch chooser over a parked globe (nothing should move).
await new Promise((r) => setTimeout(r, 8000));
const idle = await measure('idle', Math.min(seconds, 20));

// 2) Live contacts: hundreds of aircraft, labels, HUD.
const clicked = await page.evaluate(() => {
  const b = document.querySelector('button[data-first-run-choice="contacts"]');
  b?.click();
  return !!b;
});
if (!clicked) throw new Error('LIVE CONTACTS button not found');
await new Promise((r) => setTimeout(r, settle * 1000));
const live = await measure('live-contacts', seconds);

const report = {
  url,
  firstFrameMs,
  initialTransferKB: Math.round(loadBytes / 1024),
  initialJsKB: Math.round(loadJs / 1024),
  idle,
  live,
};
console.log(JSON.stringify(report, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
await browser.close();

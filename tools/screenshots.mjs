#!/usr/bin/env node
// Renders the README pictures (assets/*.png) from the preview page, which draws
// everything with the userscript's own UI code on a mock SoundCloud player.
//
//   node tools/screenshots.mjs [--browser <path>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
const browserPath = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : undefined;

// The preview is written as a page body; give it a document of its own.
const tmp = mkdtempSync(join(tmpdir(), 'scnoai-shots-'));
const body = join(tmp, 'body.html');
execFileSync(process.execPath, [join(ROOT, 'tools', 'preview.mjs'), body]);
const page = join(tmp, 'page.html');
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${readFileSync(body, 'utf8')}</body></html>`);

const { send, evaluate, close } = await launch({ browserPath, args: ['--hide-scrollbars'] });
await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 1400, deviceScaleFactor: 2, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await send('Page.navigate', { url: pathToFileURL(page).href });
await sleep(1500);
// Load every face up front: measuring before the web fonts arrive gives crops
// for a layout that reflows a moment later.
await evaluate(`Promise.all(['400 13px Inter', '600 13px Inter', '700 13px Inter', '800 22px Archivo', '500 11px "IBM Plex Mono"']
  .map((f) => document.fonts.load(f))).then(() => document.fonts.ready).then(() => true)`);
await sleep(500);

// Sets the preview's state (SoundCloud theme, what's playing, panel, notice) and redraws.
const scene = (playing, { panel = false, notice = false } = {}) =>
  evaluate(`(() => {
    state.sc = 'dark';
    state.playing = ${JSON.stringify(playing)};
    Object.assign(stages[0], { panelOpen: ${panel}, notice: ${notice}, showAll: false, open: { settings: false, history: false } });
    render();
    document.getElementById('sna-callout')?.remove();
    return true;
  })()`);

const rect = (selector) =>
  evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY };
  })()`);

// box() runs after the redraw has settled, so the crop matches what's captured.
async function shoot(name, box) {
  await sleep(400);
  const { left, top, right, bottom } = await box();
  const clip = { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top), scale: 1 };
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log(`assets/${name}  ${clip.width}×${clip.height}`);
}

mkdirSync(OUT, { recursive: true });

// 1. The player bar, with a label pointing at the dot.
await scene('ok');
await sleep(300);
await evaluate(`(() => {
  const screen = document.querySelector('.screen');
  const dot = document.querySelector('.bar .sna-badge__dot').getBoundingClientRect();
  const box = screen.getBoundingClientRect();
  screen.style.position = 'relative';
  const c = document.createElement('div');
  c.id = 'sna-callout';
  c.innerHTML = '<span>SoundCloud No AI</span><i></i>';
  // The dot sits at the right edge, so the label extends to the left of its pointer.
  c.style.cssText = 'position:absolute;display:flex;flex-direction:column;align-items:flex-end;transform:translateX(-100%);pointer-events:none;' +
    'left:' + (dot.left + dot.width / 2 - box.left + 14) + 'px;bottom:' + (box.bottom - dot.top + 4) + 'px';
  c.querySelector('span').style.cssText = 'padding:5px 11px;border-radius:999px;background:#fff;color:#121212;font:600 13px/1 Inter,system-ui,sans-serif;white-space:nowrap';
  c.querySelector('i').style.cssText = 'width:1.5px;height:34px;margin-right:13.25px;background:#fff';
  screen.appendChild(c);
  return true;
})()`);
await shoot('player-bar.png', async () => {
  const bar = await rect('.bar');
  return { left: bar.left, top: bar.top - 64, right: bar.right, bottom: bar.bottom };
});

// 2. Every state of the dot, resting and hovered.
await scene('ok');
await shoot('states.png', () => rect('#matrix'));

// 3. Right after a skip.
await scene('ai', { notice: true });
await shoot('skipped.png', async () => {
  const bar = await rect('.bar');
  const sound = await rect('.bar__sound');
  return { left: sound.left - 14, top: bar.top - 20, right: bar.right, bottom: bar.bottom };
});

// 4. The panel, open above the dot.
await scene('ai', { panel: true });
await shoot('panel.png', async () => {
  const panel = await rect('.panel-slot .sna-panel');
  const bar = await rect('.bar');
  return { left: panel.left - 24, top: panel.top - 24, right: bar.right, bottom: bar.bottom };
});

// 5. Flagged artists in a list.
await scene('ai');
await shoot('lists.png', async () => {
  const feed = await rect('.feed');
  return { left: feed.left - 20, top: feed.top - 20, right: feed.right + 20, bottom: feed.bottom + 20 };
});

await close();

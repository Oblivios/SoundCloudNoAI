#!/usr/bin/env node
// Offline regression test for the skip race: an AI track is being checked when
// the user picks another song, and SoundCloud's now-playing link still shows
// the AI track because it only redraws once the new track has loaded. The
// skip must not land on the song the user chose.
//
//   node tools/race.mjs [--browser <path>] [--headed]
//
// Runs a fake player page in headless Chrome/Edge with the SoundCloud API
// stubbed from a test fixture, so it needs no network and no account.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(ROOT, 'soundcloud-no-ai.user.js'), 'utf8');
const FX = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'velour02--system-updates-interrupt-triumph-46.json'), 'utf8'));
const AI_PATH = new URL(FX.track.permalink_url).pathname;
const API_DELAY = 800; // per request; the check takes two

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const headed = args.includes('--headed');
const browserPath = opt('--browser');

const PAGE = `<!doctype html><meta charset="utf-8"><title>race</title>
<script>
  localStorage.clear();
  localStorage.setItem('scnoai:clientId', JSON.stringify('a'.repeat(32)));
  const FX = ${JSON.stringify(FX)};
  window.__next = 0;
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname !== 'api-v2.soundcloud.com') return realFetch(input, init);
    await new Promise((r) => setTimeout(r, ${API_DELAY}));
    if (u.pathname === '/resolve') return json({ ...FX.track, kind: 'track', user_id: FX.user.id, user: FX.user });
    if (/^\\/users\\/\\d+\\/tracks$/.test(u.pathname)) return json({ collection: FX.recent, next_href: null });
    if (/^\\/users\\/\\d+$/.test(u.pathname)) return json(FX.user);
    return new Response('', { status: 404 });
  };
</script>
<div class="soundList__item"><button class="sc-button-play playButton" id="pick">Play a human song</button></div>
<div class="playControls__elements">
  <button class="skipControl playControls__control skipControl__next" id="next" onclick="window.__next++">Next</button>
  <div class="playControls__soundBadge"><div class="playbackSoundBadge">
    <a class="playbackSoundBadge__titleLink" href="${AI_PATH}">AI track</a>
  </div></div>
</div>`;

const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { send, evaluate, close } = await launch({ browserPath, headed });

async function clickReal(selector) {
  const at = await evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
}

// [name, what the user does while the AI track is being checked, Next presses expected in total]
const SCENARIOS = [
  ['nobody touches anything: the AI track is skipped', null, 1],
  ['user picks another song: no skip lands on it', '#pick', 0],
  ['user presses Next: no second skip on top of theirs', '#next', 1],
];

let failures = 0;
for (const [name, userClick, want] of SCENARIOS) {
  await send('Page.navigate', { url });
  await sleep(500);
  await evaluate(SCRIPT);
  if (userClick) {
    await sleep(API_DELAY / 2);
    await clickReal(userClick);
  }
  await sleep(API_DELAY * 2 + 1500);
  const got = await evaluate('window.__next');
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name} (Next pressed ${got}×, expected ${want}×)`);
}

await close();
server.close();
process.exit(failures ? 1 : 0);

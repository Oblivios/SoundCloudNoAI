#!/usr/bin/env node
// Live smoke test: opens SoundCloud pages in a headless Chrome/Edge, injects the
// userscript, presses play on the first track and reports what the player did.
//
//   node tools/e2e.mjs [<page-url> ...] [--seconds 30] [--browser <path>] [--headed]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(ROOT, 'soundcloud-no-ai.user.js'), 'utf8');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args.splice(i, 1), true) : false;
};
const seconds = Number(opt('--seconds', 30));
const headed = flag('--headed');
const browserPath = opt('--browser');
const pages = args.length ? args : ['https://soundcloud.com/velour02/tracks'];

const { send, evaluate, on, close } = await launch({
  browserPath,
  headed,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1280,900'],
});
on((msg) => {
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (text.startsWith('[SC No AI]')) console.log('   page:', text.slice(0, 200));
  }
});

let failures = 0;
for (const url of pages) {
  console.log(`\n=== ${url}`);
  await send('Page.navigate', { url });
  await sleep(5000);

  // Decline non-essential cookies if the consent banner shows up.
  await evaluate(`document.querySelector('#onetrust-reject-all-handler')?.click(); true`);
  await sleep(500);
  await evaluate(SCRIPT);
  // SoundCloud ignores synthetic element.click() on play buttons, so send a
  // real mouse click at the button's position.
  const at = await evaluate(`(() => {
    const btn = document.querySelector('.l-main .sc-button-play, .l-listen-hero .sc-button-play, .sc-button-play.playButton');
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (at) {
    await sleep(300);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
  }
  const started = !!at;
  if (!started) {
    console.log('   could not find a play button');
    failures++;
    continue;
  }
  await sleep(3000);

  // Anonymous sessions get a sign-in wall instead of playback. In that case
  // fake the "now playing" link the userscript watches, cycling through the
  // first tracks on the page, so the analysis and UI still get exercised.
  let simulated = null;
  if (!(await evaluate(`!!document.querySelector('a.playbackSoundBadge__titleLink')`))) {
    simulated = await evaluate(`(() => {
      const links = [...document.querySelectorAll('a.soundTitle__title')].map((a) => a.getAttribute('href').split('?')[0]);
      if (!links.length && /^\\/[^/]+\\/[^/]+$/.test(location.pathname)) links.push(location.pathname);
      return [...new Set(links)].slice(0, 3);
    })()`);
    const authWall = await evaluate(`!!document.querySelector('.auth-modal iframe, iframe[src*="web-auth"]')`);
    console.log(`   ${authWall ? 'playback needs sign-in' : 'player did not start'}; simulating the player on ${simulated.length} track(s)`);
  }
  const setNowPlaying = (href) =>
    evaluate(`(() => {
      const badge = document.querySelector('.playbackSoundBadge');
      if (!badge) return false;
      let a = badge.querySelector('a.playbackSoundBadge__titleLink');
      if (!a) {
        a = document.createElement('a');
        a.className = 'playbackSoundBadge__titleLink';
        badge.appendChild(a);
      }
      a.setAttribute('href', ${JSON.stringify(href)});
      return true;
    })()`);

  const seen = [];
  for (let t = 0; t < seconds; t++) {
    if (simulated && t % 8 === 0 && simulated[t / 8]) await setNowPlaying(simulated[t / 8]);
    await sleep(1000);
    const s = await evaluate(`(() => {
      const a = document.querySelector('.playbackSoundBadge__titleLink');
      return {
        path: a ? a.getAttribute('href').split('?')[0] : null,
        badge: document.querySelector('.sna-badge .sna-badge__btn')?.textContent || null,
        playing: !!document.querySelector('.playControl.playing'),
        notice: document.querySelector('.sna-badge[data-notice]')?.textContent || null,
      };
    })()`);
    const last = seen[seen.length - 1];
    if (!last || last.path !== s.path || last.badge !== s.badge) {
      seen.push(s);
      console.log(`   ${String(t + 1).padStart(2)}s ${s.playing ? '▶' : '⏸'} ${s.path}  [${s.badge}]${s.notice ? `  notice: ${s.notice}` : ''}`);
    }
  }
  const skipLog = await evaluate(`JSON.parse(localStorage.getItem('scnoai:skipLog') || '[]').length`);
  const tracks = new Set(seen.map((s) => s.path).filter(Boolean));
  const flags = await evaluate(`document.querySelectorAll('.sna-flag').length`);
  console.log(`   → ${tracks.size} distinct tracks, ${skipLog} skips logged so far, ${flags} list items flagged`);
  const panel = await evaluate(`(() => {
    document.querySelector('.sna-badge .sna-badge__btn')?.click();
    const text = document.querySelector('.sna-panel')?.innerText || '';
    document.querySelector('.sna-badge .sna-badge__btn')?.click();
    return text.split('\\n').filter(Boolean).slice(0, 6).join(' | ');
  })()`);
  console.log(`   panel: ${panel}`);
  if (!seen.some((s) => /^(OK|AI)/.test(s.badge || ''))) {
    console.log('   ✗ the badge never showed a verdict');
    failures++;
  }
}

await close();
process.exit(failures ? 1 : 0);

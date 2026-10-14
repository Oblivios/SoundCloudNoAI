#!/usr/bin/env node
// Score SoundCloud tracks from the terminal with the same logic as the userscript.
//
//   node tools/check.mjs <track-url> [<track-url> ...] [--save ai|ok]
//
// --save writes test/fixtures/<artist>--<track>.json with the expected verdict,
// so a missed AI track (or a wrongly skipped human one) becomes a regression test.

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Score = require('../soundcloud-no-ai.user.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api-v2.soundcloud.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (SoundCloudNoAI check)' };

const args = process.argv.slice(2);
const saveIdx = args.indexOf('--save');
const saveAs = saveIdx >= 0 ? args.splice(saveIdx, 2)[1] : null;
if (!args.length || (saveIdx >= 0 && !['ai', 'suspect', 'ok'].includes(saveAs))) {
  console.error('usage: node tools/check.mjs <track-url> [...] [--save ai|suspect|ok]');
  process.exit(2);
}

let clientId;
async function getClientId() {
  if (clientId) return clientId;
  const html = await (await fetch('https://soundcloud.com/', { headers: UA })).text();
  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
  for (const src of scripts) {
    const m = /client_id\s*[:=]\s*"([A-Za-z0-9]{20,40})"/.exec(await (await fetch(src, { headers: UA })).text());
    if (m) return (clientId = m[1]);
  }
  throw new Error('could not find a client_id on soundcloud.com');
}

async function api(pathOrUrl, params = {}) {
  const url = new URL(pathOrUrl, API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('client_id', await getClientId());
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url.pathname}`);
  return res.json();
}

async function recentUploads(userId) {
  const tracks = [];
  let hiddenPages = 0;
  let page = await api(`/users/${userId}/tracks`, { limit: 50, linked_partitioning: 1 });
  for (let i = 0; i < 10; i++) {
    tracks.push(...page.collection);
    if (!page.collection.length && !tracks.length) hiddenPages++;
    if (tracks.length >= 40 || !page.next_href) break;
    page = await api(page.next_href);
  }
  return { tracks, hiddenPages };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const slimTrack = (t) => ({
  ...pick(t, ['id', 'title', 'permalink', 'permalink_url', 'created_at', 'description', 'tag_list', 'genre', 'playback_count', 'likes_count', 'comment_count', 'user_id']),
  publisher_metadata: t.publisher_metadata ? pick(t.publisher_metadata, ['writer_composer']) : undefined,
});
const slimUser = (u) => pick(u, ['id', 'username', 'permalink', 'description', 'track_count', 'followers_count', 'followings_count', 'verified', 'badges', 'avatar_url']);

for (const url of args) {
  const track = await api('/resolve', { url: url.split('?')[0] });
  if (track.kind !== 'track') {
    console.log(`${url}: not a track (${track.kind})`);
    continue;
  }
  const user = track.user.track_count == null ? await api(`/users/${track.user_id}`) : track.user;
  const { tracks, hiddenPages } = await recentUploads(track.user_id);
  const now = Date.now();
  const result = Score.scoreTrack(track, user, Score.uploadStats(tracks, hiddenPages), { now });

  console.log(`\n${track.title} — ${user.username}`);
  console.log(`${result.verdict.toUpperCase()} (score ${result.score})  ${user.track_count} tracks · ${user.followers_count} followers`);
  for (const r of result.reasons) console.log(`  ${(r.pts > 0 ? '+' : '') + r.pts}`.padEnd(7) + r.why);

  if (saveAs) {
    const fixture = {
      url: track.permalink_url,
      expect: saveAs,
      capturedAt: new Date(now).toISOString(),
      track: slimTrack(track),
      user: slimUser(user),
      hiddenPages,
      recent: tracks.map(slimTrack),
    };
    const file = join(ROOT, 'test', 'fixtures', `${user.permalink}--${track.permalink}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(fixture, null, 1) + '\n');
    console.log(`  saved ${file}`);
  }
}

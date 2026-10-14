const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../soundcloud-no-ai.user.js');

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();

/* ---------- real tracks captured with tools/check.mjs --save ---------- */

const FIXTURES = path.join(__dirname, 'fixtures');
for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  test(`fixture ${file} → ${fx.expect}`, () => {
    const stats = S.uploadStats(fx.recent, fx.hiddenPages);
    const r = S.scoreTrack(fx.track, fx.user, stats, { now: Date.parse(fx.capturedAt) });
    assert.equal(r.verdict, fx.expect, `score ${r.score}: ${r.reasons.map((x) => `${x.pts} ${x.why}`).join(' | ')}`);
  });
}

/* ---------- synthetic humans that must not be skipped ---------- */

function uploads(n, { start = NOW, every = DAY, title = (i) => `Song ${String.fromCharCode(65 + (i % 26))}${i}`, ...extra } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    title: typeof title === 'function' ? title(i) : title,
    permalink: `song-${i}`.replace(/-\d+$/, `-x${i}`),
    created_at: iso(start - i * every),
    ...extra,
  }));
}

const human = (over = {}) => ({
  id: 1,
  username: 'Someone',
  permalink: 'someone',
  track_count: 40,
  followers_count: 300,
  followings_count: 120,
  verified: false,
  badges: { pro_unlimited: false },
  avatar_url: 'https://i1.sndcdn.com/avatars-abc-large.jpg',
  ...over,
});

const aTrack = (over = {}) => ({
  title: 'Night Drive',
  permalink: 'night-drive',
  created_at: iso(NOW - 2 * DAY),
  description: '',
  playback_count: 40,
  likes_count: 3,
  comment_count: 0,
  ...over,
});

function verdict(track, user, recent, hiddenPages = 0) {
  return S.scoreTrack(track, user, S.uploadStats(recent, hiddenPages), { now: NOW });
}

test('a small artist dropping a 14-track album is fine', () => {
  const album = uploads(14, { every: 60e3 });
  const older = uploads(26, { start: NOW - 60 * DAY, every: 20 * DAY });
  const r = verdict(aTrack(), human({ badges: { pro_unlimited: true } }), [...album, ...older]);
  assert.equal(r.verdict, 'ok', JSON.stringify(r));
});

test('a new account uploading its back catalogue in one day is not skipped', () => {
  const r = verdict(aTrack(), human({ track_count: 50, followers_count: 10 }), uploads(50, { every: 120e3 }));
  assert.notEqual(r.verdict, 'ai', JSON.stringify(r));
});

test('a big artist whose label ingests a whole catalogue is fine', () => {
  const r = verdict(aTrack({ playback_count: 900000, likes_count: 20000, comment_count: 300 }), human({ track_count: 300, followers_count: 450000, verified: true }), uploads(40, { every: 60e3 }));
  assert.equal(r.verdict, 'ok', JSON.stringify(r));
});

test('a prolific type-beat producer with a real audience is not skipped', () => {
  const r = verdict(aTrack(), human({ track_count: 650, followers_count: 2400, badges: { pro_unlimited: true } }), uploads(50, { every: DAY }));
  assert.notEqual(r.verdict, 'ai', JSON.stringify(r));
});

test('sped up / slowed / instrumental versions are not "style variants"', () => {
  const titles = ['Lights', 'Lights (Sped Up)', 'Lights (Slowed + Reverb)', 'Lights (Instrumental)', 'Lights (Remix)'];
  const recent = uploads(20, { title: (i) => titles[i % titles.length] });
  assert.equal(S.uploadStats(recent).variantShare, 0);
});

test('a low play count alone never skips a track', () => {
  const r = verdict(aTrack({ playback_count: 3, created_at: iso(NOW - 90 * DAY) }), human(), uploads(20, { every: 30 * DAY }));
  assert.equal(r.verdict, 'ok', JSON.stringify(r));
});

/* ---------- synthetic farms ---------- */

test('one title regenerated in many styles is flagged as a variant farm', () => {
  const styles = ['Folk Rock', 'Celtic Ballad', 'City Pop', 'Bossa Nova', 'Neo-Soul', 'Trip-Hop', 'Dream Pop', 'Jazz'];
  const recent = uploads(40, { title: (i) => `${i < 20 ? 'To Her' : 'Bye My Love'} (${styles[i % styles.length]})` });
  const stats = S.uploadStats(recent);
  assert.ok(stats.variantShare > 0.9);
  assert.ok(stats.genreTagShare > 0.9);
});

test('mass uploads with a tiny audience are AI', () => {
  const r = verdict(aTrack({ playback_count: 12 }), human({ track_count: 900, followers_count: 40, followings_count: 0, badges: { pro_unlimited: true } }), uploads(50, { every: 600e3 }));
  assert.equal(r.verdict, 'ai', JSON.stringify(r));
});

test('a track that says it was made with Suno is AI', () => {
  const r = verdict(aTrack({ description: 'Lyrics by me, music made with Suno AI' }), human(), uploads(20, { every: 10 * DAY }));
  assert.equal(r.verdict, 'ai', JSON.stringify(r));
});

test('a learned farm composer only counts on a different account', () => {
  const track = aTrack({ publisher_metadata: { writer_composer: 'Oliver Wolff' } });
  const farmComposers = { 'oliver wolff': [111] };
  const why = (user) => S.scoreTrack(track, user, null, { now: NOW, farmComposers }).reasons.map((r) => r.why).join();
  assert.match(why(human({ id: 222 })), /Oliver Wolff/);
  assert.doesNotMatch(why(human({ id: 111 })), /Oliver Wolff/);
});

/* ---------- UI templates ---------- */

test('the badge renders every state', () => {
  for (const state of ['idle', 'pending', 'error', 'ok', 'suspect', 'ai']) {
    const html = S.UI.wrap('badge', { state }, S.UI.badgeHTML({ state, score: 42 }));
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.match(html, /class="sna-badge__dot"/);
  }
});

test('the panel escapes track data and lists every reason on demand', () => {
  const reasons = Array.from({ length: 7 }, (_, i) => ({ pts: 10 - i, why: `reason ${i}` }));
  const view = { state: 'ai', score: 93, title: '<img src=x onerror=alert(1)>', url: '/a/b', artist: 'A&B', artistUrl: '/a', reasons, settings: { aiThreshold: 60, suspectThreshold: 35 } };
  const short = S.UI.panelHTML(view);
  assert.doesNotMatch(short, /<img/);
  assert.match(short, /A&amp;B/);
  assert.equal((short.match(/class="sna-reason /g) || []).length, 3);
  assert.match(short, /Show all 7/);
  assert.equal((S.UI.panelHTML({ ...view, showAll: true }).match(/class="sna-reason /g) || []).length, 7);
});

test('after a skip the badge offers Undo next to, not inside, its button', () => {
  const html = S.UI.badgeHTML({ state: 'ai', score: 100, notice: { kind: 'skipped', title: 'Wireframe', artist: 'Velour' } });
  assert.match(html, /<span class="sna-badge__label">Skipped<\/span>/);
  assert.match(html, /<\/button><button type="button" class="sna-badge__undo" data-act="undo"/);
  assert.doesNotMatch(html, /sna-badge__score/);
  assert.match(S.UI.wrap('badge', { state: 'ai', notice: {} }, ''), / data-notice>/);
});

test('settings show the current thresholds', () => {
  const html = S.UI.panelHTML({ state: 'idle', settings: { aiThreshold: 70, suspectThreshold: 40 } });
  assert.match(html, /data-set="aiThreshold" min="30" max="100" step="5" value="70"/);
  assert.match(html, /data-set="suspectThreshold" min="10" max="65" step="5" value="40"/);
});

/* ---------- helpers ---------- */

test('batchPosition', () => {
  assert.equal(S.batchPosition({ title: 'Wireframe', permalink: 'wireframe-80' }), 80);
  assert.equal(S.batchPosition({ title: 'To Her (Folk Rock)', permalink: 'to-her-folk-rock-12' }), 12);
  assert.equal(S.batchPosition({ title: 'Song', permalink: 'song-1' }), 0);
  assert.equal(S.batchPosition({ title: 'Piano M 830', permalink: 'piano-m-830' }), 0);
  assert.equal(S.batchPosition({ title: 'Venom - 8_20_22, 3.05 PM', permalink: 'venom-8_20_22-305' }), 0);
  assert.equal(S.batchPosition({ title: 'Maybe Laura', permalink: 'maybe-laura-ambient-sauna-dec-25' }), 0);
  assert.equal(S.batchPosition({ title: 'Stay', permalink: 'stay-2024' }), 0);
  assert.equal(S.batchPosition({ title: 'Deep House', permalink: 'deep-house-mix-160' }), 0);
});

test('aiDisclosure', () => {
  for (const s of ['Made with Suno', 'SunoAI', 'udio', 'AI generated', 'AI-assisted production', 'Drake AI cover', 'created with AI', 'généré par IA', 'hecho con IA', 'KI-generiert', '#aimusic', 'Artificial Intelligence']) {
    assert.ok(S.aiDisclosure(s), s);
  }
  for (const s of ['Recorded at my studio', 'Air Max', 'Said it again', 'boomy 808s', 'Ai Weiwei tribute', 'Thai music', 'Mai Tai']) {
    assert.equal(S.aiDisclosure(s), null, s);
  }
});

test('genreTagShare', () => {
  assert.equal(S.genreTagShare([{ title: 'Iron Will (Viking Music)' }, { title: 'Trance Energy (Trance, Electronic)' }]), 1);
  assert.equal(S.genreTagShare([{ title: 'Fallin (Original Mix)' }, { title: 'Lights (feat. Kai)' }, { title: 'Plain' }]), 0);
});

test('job tag', () => {
  assert.ok(S.JOB_TAG_RE.test('A Space Mango collection.\n[owmp-job:space_mango_next_200_20260930:20]'));
  assert.ok(!S.JOB_TAG_RE.test('[Free download] [prod. by me]'));
});

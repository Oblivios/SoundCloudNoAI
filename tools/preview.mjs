#!/usr/bin/env node
// Builds docs/styles.html: the dot, panel and list flags rendered by the
// userscript's own templates (the block between `// <ui>` and `// </ui>`), on a mock player.
//
//   node tools/preview.mjs [out.html]

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const S = require('../soundcloud-no-ai.user.js');
const OUT = process.argv[2] || join(ROOT, 'docs', 'styles.html');

const source = readFileSync(join(ROOT, 'soundcloud-no-ai.user.js'), 'utf8');
const uiSource = source.slice(source.indexOf('// <ui>'), source.indexOf('// </ui>'));
if (!uiSource.includes('const UI =')) throw new Error('UI block markers not found');

// The AI example is real: one of the reported tracks, scored from its fixture.
const fx = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'velour02--system-updates-interrupt-triumph-46.json'), 'utf8'));
const real = S.scoreTrack(fx.track, fx.user, S.uploadStats(fx.recent, fx.hiddenPages), { now: Date.parse(fx.capturedAt) });

const EXAMPLES = {
  ai: {
    title: fx.track.title,
    url: '/velour02/system-updates-interrupt-triumph-46',
    artist: fx.user.username,
    artistUrl: '/velour02',
    tracks: fx.user.track_count,
    followers: fx.user.followers_count,
    score: real.score,
    reasons: real.reasons,
  },
  suspect: {
    title: 'Midnight Static (Synthwave)',
    url: '#',
    artist: 'Arcwave Studio',
    artistUrl: '#',
    tracks: 412,
    followers: 160,
    score: 50,
    reasons: [
      { pts: 25, why: 'Uploads ~3.9 tracks/day (last 47)' },
      { pts: 20, why: '412 tracks vs 160 followers' },
      { pts: 5, why: 'Pro Unlimited (unlimited uploads) with a small audience' },
    ],
  },
  ok: {
    title: 'Night Bus Home',
    url: '#',
    artist: 'marlow.wav',
    artistUrl: '#',
    tracks: 38,
    followers: 6120,
    score: 0,
    reasons: [
      { pts: 10, why: 'Only 96 plays after 9 days' },
      { pts: -15, why: '6,120 followers' },
      { pts: -10, why: '14 comments' },
    ],
  },
};

const HISTORY = [
  { title: 'System Updates Interrupt Triumph', artist: 'Velour', url: '/velour02/system-updates-interrupt-triumph-46', score: 100, ago: '2 min ago' },
  { title: 'Soft Sparks From a Distant Summer', artist: 'STSoundsystem', url: '/zgsales/soft-sparks-from-a-distant', score: 100, ago: '9 min ago' },
  { title: 'Cloud Gardening for Beginners', artist: 'Spacemango2026', url: '/spacemango2026/cloud-gardening-for-beginners', score: 100, ago: '1 h ago' },
  { title: 'Capetown Calling', artist: 'Nasty Dreams', url: '/nastydreams/capetown-calling', score: 100, ago: '1 d ago' },
];

const FEED = [
  { artist: 'Velour', permalink: 'velour02', title: 'System Updates Interrupt Triumph', flag: 'ai', hue: 268 },
  { artist: 'marlow.wav', permalink: 'marlow', title: 'Night Bus Home', flag: null, hue: 24 },
  { artist: 'STSoundsystem', permalink: 'zgsales', title: 'Soft Sparks From a Distant Summer', flag: 'ai', hue: 150 },
];

const page = String.raw`<title>No AI Styles</title>
<meta name="description" content="The SoundCloud No AI dot and panel, rendered by the userscript's own UI code.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700;800&display=swap">
<style>
/* Layout: a spec sheet. Name and controls, a strip of every badge state, then one full-size player stage. */
:root{
  --paper:#ebeae7; --sheet:#f6f5f3; --ink:#141414; --ink-2:#5c5b57; --rule:rgba(20,20,20,.13); --accent:#e64a00;
  --display:"Archivo","Helvetica Neue",Arial,sans-serif;
  --body:"Archivo","Helvetica Neue",Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0d0d0d;--sheet:#151514;--ink:#f0efeb;--ink-2:#9c9a94;--rule:rgba(240,239,235,.13);--accent:#ff6a1f;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#0d0d0d;--sheet:#151514;--ink:#f0efeb;--ink-2:#9c9a94;--rule:rgba(240,239,235,.13);--accent:#ff6a1f;color-scheme:dark}

/* SoundCloud's own theme variables, as soundcloud.com sets them on <body>. */
.sc{--surface-color:#121212;--primary-color:#fff;--primary-rgb:255,255,255;--secondary-color:#999;--highlight-color:#303030;--special-color:#f50;--font-sans-serif-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.sc[data-sc="light"]{--surface-color:#fff;--primary-color:#121212;--primary-rgb:18,18,18;--secondary-color:#666;--highlight-color:#f3f3f3}

body{margin:0;background:var(--paper);color:var(--ink);font:400 15px/1.55 var(--body)}
.wrap{max-width:1180px;margin:0 auto;padding-inline:clamp(16px,4vw,40px);padding-block:40px 64px;display:flex;flex-direction:column;gap:48px}

.top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px 40px;align-items:end}
.eyebrow{font:500 12px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);display:flex;gap:10px;align-items:center}
.eyebrow i{width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block}
h1{margin:14px 0 12px;font:800 clamp(40px,7vw,80px)/.92 var(--display);font-stretch:125%;letter-spacing:-.025em;text-wrap:balance}
.lede{margin:0;max-width:58ch;color:var(--ink-2);font-size:16px}
.controls{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.control{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}
.control__label{font:500 11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);width:66px}
.seg{display:inline-flex;flex-wrap:wrap;padding:3px;border-radius:18px;background:var(--sheet);box-shadow:inset 0 0 0 1px var(--rule)}
.seg button{all:unset;cursor:pointer;padding:6px 12px;border-radius:999px;font:600 13px/1 var(--body);color:var(--ink-2);white-space:nowrap}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--paper)}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

h2{margin:0;font:800 22px/1.1 var(--display);font-stretch:112%;letter-spacing:-.01em}
.sec-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.sec-head p{margin:0;color:var(--ink-2);font-size:14px}

.matrix-box{overflow-x:auto;border-radius:10px;box-shadow:inset 0 0 0 1px var(--rule);background:var(--sheet)}
.matrix{border-collapse:collapse;width:100%;min-width:900px}
.matrix th,.matrix td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--rule);vertical-align:middle}
.matrix tr:last-child th,.matrix tr:last-child td{border-bottom:0}
.matrix thead th{font:500 11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);padding-block:14px}
.matrix tbody th{width:120px}
.matrix tbody th b{display:block;font:700 15px/1.2 var(--body)}
.matrix tbody th span{font-size:12px;color:var(--ink-2)}
.cell{display:flex;align-items:center;height:44px;padding:0 6px;border-radius:6px;background:var(--highlight-color)}
.cell .sna-badge{margin:0}
.listcell{display:flex;align-items:center;height:44px;padding:0 10px;border-radius:6px;background:var(--surface-color);color:var(--secondary-color);font:500 13px/1 var(--font-sans-serif-family);white-space:nowrap}

.stages{display:flex;flex-direction:column;gap:28px}
.stage{border-radius:12px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--rule),0 1px 0 var(--rule)}
.screen{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:1fr auto;gap:16px 24px;padding:24px 20px 0;background:var(--surface-color);min-height:560px}
.feed{display:flex;flex-direction:column;gap:22px;align-self:start;min-width:0;font-family:var(--font-sans-serif-family);color:var(--primary-color)}
.row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:14px;align-items:start}
.art{width:72px;height:72px;border-radius:3px}
.row__meta{display:flex;flex-direction:column;gap:3px;min-width:0}
.row__artist{font-size:13px;color:var(--secondary-color);white-space:nowrap}
.row__artist a{color:inherit;text-decoration:none}
.row__title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wave{display:block;width:100%;height:34px;margin-top:6px}
.wave rect{fill:rgba(var(--primary-rgb),.34)}
.wave rect.is-played{fill:var(--special-color)}
.panel-slot{grid-column:2;grid-row:1;align-self:end;justify-self:end;min-width:0;max-width:100%}
.panel-slot .sna-panel{position:static;max-height:none;max-width:100%}
.panel-slot.is-closed{visibility:hidden}
.bar{grid-column:1/-1;grid-row:2;display:flex;align-items:center;gap:16px;height:48px;margin:0 -20px;padding:0 20px;background:var(--highlight-color);color:var(--primary-color);font-family:var(--font-sans-serif-family)}
.bar__ctl{display:flex;gap:14px;align-items:center;flex:none}
.bar__ctl svg{width:16px;height:16px;fill:currentColor}
.bar__time{font-size:11px;color:var(--secondary-color);font-variant-numeric:tabular-nums;flex:none}
.bar__track{flex:1;height:2px;background:rgba(var(--primary-rgb),.25);position:relative;min-width:40px}
.bar__track i{position:absolute;inset:0 auto 0 0;width:3%;background:var(--special-color)}
.bar__sound{display:flex;align-items:center;gap:10px;min-width:0;max-width:220px;flex:none}
.bar__sound .art{width:30px;height:30px;border-radius:2px;flex:none}
.bar__sound div{display:flex;flex-direction:column;min-width:0;font-size:11px;line-height:1.35}
.bar__sound span{color:var(--secondary-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar__sound b{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar__end{display:flex;align-items:center;flex:none}
.bar__actions{display:flex;align-items:center;gap:18px;color:var(--secondary-color)}
.bar__actions svg{width:16px;height:16px;fill:currentColor}

.note{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding-top:24px;border-top:1px solid var(--rule);color:var(--ink-2);font-size:14px}
.note b{color:var(--ink)}
.note p{margin:0;max-width:62ch}
kbd{font:500 12px/1 var(--mono);padding:2px 6px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--rule);color:var(--ink)}

@media (max-width:860px){
  .top{grid-template-columns:1fr}
  .screen{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto;min-height:0}
  .panel-slot{grid-column:1;grid-row:2;justify-self:stretch}
  .panel-slot .sna-panel{width:100%}
  .panel-slot.is-closed{display:none}
  .bar{grid-row:3}
  .bar__time,.bar__track{display:none}
  .bar__sound{max-width:none;flex:1}
  .note{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
${S.UI.CSS}
</style>

<div class="wrap">
  <header class="top">
    <div>
      <div class="eyebrow"><i></i>SoundCloud No AI</div>
      <h1>Quiet until you hover</h1>
      <p class="lede">One dot in SoundCloud's player bar, spaced like the buttons next to it. Its color is the verdict. Hover it to read the label and score, click it for the reasons and the controls. When it skips a track, it says “Skipped · Undo” for a few seconds, then goes quiet again. Everything below is drawn by the script's own UI code on a mock SoundCloud player, so it's what you get on the real page.</p>
    </div>
    <div class="controls">
      <div class="control"><span class="control__label">SoundCloud</span><span class="seg" data-control="sc"><button data-v="dark" aria-pressed="true">Dark</button><button data-v="light" aria-pressed="false">Light</button></span></div>
      <div class="control"><span class="control__label">Playing</span><span class="seg" data-control="state"><button data-v="ai" aria-pressed="true">Likely AI</button><button data-v="suspect" aria-pressed="false">Suspicious</button><button data-v="ok" aria-pressed="false">Human</button><button data-v="pending" aria-pressed="false">Checking</button></span></div>
    </div>
  </header>

  <section class="sc" data-sc="dark" id="matrix-sec">
    <div class="sec-head"><h2>Every state at a glance</h2><p>The dot as it sits in the player bar, and what hovering it reveals.</p></div>
    <div class="matrix-box" id="matrix"></div>
  </section>

  <section>
    <div class="sec-head"><h2>Up close</h2><p>Click the dot to open or close the panel. The settings and sliders work.</p></div>
    <div class="stages" id="stages"></div>
  </section>

  <footer class="note">
    <p><b>Using it.</b> Hover the dot for the verdict, click it for the reasons, <kbd>Block artist</kbd>, <kbd>Trust artist</kbd> and <kbd>Skip</kbd>. Esc or a click elsewhere closes the panel. Settings and recent skips are folded at the bottom.</p>
    <p><b>Example data.</b> The “Likely AI” track is Velour's, one of the known AI tracks in the test fixtures, scored by the real detector. The suspicious and human tracks are made up for the demo.</p>
  </footer>
</div>

<script>
${uiSource}
const EXAMPLES = ${JSON.stringify(EXAMPLES)};
const HISTORY = ${JSON.stringify(HISTORY)};
const FEED = ${JSON.stringify(FEED)};
const state = { sc: 'dark', playing: 'ai' };
const stages = [{
  panelOpen: true,
  showAll: false,
  notice: true,
  open: { settings: false, history: false },
  settings: { enabled: true, skipSuspects: false, markLists: true, learnComposers: true, aiThreshold: 60, suspectThreshold: 35 },
}];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const art = (hue) => 'background:linear-gradient(135deg,hsl(' + hue + ' 55% 46%),hsl(' + (hue + 40) + ' 60% 28%))';
// A deterministic fake waveform: 110 bars from a few summed sines.
function waveSVG(seed) {
  let bars = '';
  for (let i = 0; i < 110; i++) {
    const t = i / 110;
    const env = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    const h = Math.max(3, Math.round(30 * env * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.9 + seed) * Math.cos(i * 0.37 + seed / 7)))));
    bars += '<rect' + (i < 6 ? ' class="is-played"' : '') + ' x="' + i * 4 + '" y="' + (34 - h) + '" width="2.4" height="' + h + '"/>';
  }
  return '<svg class="wave" viewBox="0 0 440 34" preserveAspectRatio="none" aria-hidden="true">' + bars + '</svg>';
}
const verdictFor = (score, set) => (score >= set.aiThreshold ? 'ai' : score >= set.suspectThreshold ? 'suspect' : 'ok');

function matrixHTML() {
  const cols = [['ok', 'Looks human'], ['suspect', 'Suspicious'], ['ai', 'Likely AI'], ['pending', 'Checking'], ['off', 'Auto-skip off'], ['skipped', 'Just skipped']];
  const scores = { ok: 8, suspect: 50, ai: 93, off: 93 };
  const rows = [['In the bar', 'Resting', false], ['On hover', 'Label slides out', true]];
  let h = '<table class="matrix"><thead><tr><th></th>' + cols.map((c) => '<th>' + c[1] + '</th>').join('') + '<th>In lists</th></tr></thead><tbody>';
  for (const [name, blurb, hovered] of rows) {
    h += '<tr><th><b>' + name + '</b><span>' + blurb + '</span></th>';
    for (const [k] of cols) {
      const v = { scheme: state.sc, state: k === 'off' || k === 'skipped' ? 'ai' : k, score: scores[k], off: k === 'off', open: hovered };
      if (k === 'skipped') v.notice = { kind: 'skipped', title: 'Wireframe', artist: 'Velour' };
      h += '<td><div class="cell">' + UI.wrap('badge', v, UI.badgeHTML(v)) + '</div></td>';
    }
    h += '<td><div class="listcell">Velour' + UI.flagHTML({ scheme: state.sc, state: 'ai' }) + '</div></td></tr>';
  }
  return h + '</tbody></table>';
}

function stageHTML(st, i) {
  const set = st.settings;
  const ex = state.playing === 'pending' ? null : EXAMPLES[state.playing];
  const verdict = ex ? verdictFor(ex.score, set) : 'pending';
  const skips = verdict === 'ai' || (set.skipSuspects && verdict === 'suspect');
  const outcome = !ex ? null : skips ? (set.enabled ? 'Skipped' : 'Auto-skip off') : verdict === 'suspect' ? 'Kept playing' : null;
  const base = { scheme: state.sc, state: verdict, score: ex ? ex.score : null, off: !set.enabled };
  const pv = Object.assign({}, base, ex || {}, {
    outcome, settings: set, showAll: st.showAll, open: st.open,
    counts: { blocked: 2, trusted: 1, composers: 2 }, history: HISTORY,
  });
  const feed = FEED.map((r) => {
    const flagged = set.markLists && r.flag;
    return '<div class="row' + (flagged ? ' sna-dim' : '') + '"><div class="art" style="' + art(r.hue) + '"></div><div class="row__meta">' +
      '<span class="row__artist"><a href="#">' + esc(r.artist) + '</a>' + (flagged ? UI.flagHTML({ scheme: state.sc, state: r.flag }) : '') + '</span>' +
      '<span class="row__title">' + esc(r.title) + '</span>' + waveSVG(r.hue) + '</div></div>';
  }).join('');
  const showNotice = st.notice && ex && skips && set.enabled;
  const bv = Object.assign({ open: st.panelOpen }, base, showNotice ? { state: 'ai', notice: { kind: 'skipped', title: ex.title, artist: ex.artist } } : {});
  const playingTitle = ex ? ex.title : 'Loading…';
  const playingArtist = ex ? ex.artist : '';
  return '<article class="stage sc" data-sc="' + state.sc + '" data-i="' + i + '">' +
    '<div class="screen">' +
      '<div class="feed">' + feed + '</div>' +
      '<div class="panel-slot' + (st.panelOpen ? '' : ' is-closed') + '">' + UI.wrap('panel', pv, UI.panelHTML(pv)) + '</div>' +
      '<div class="bar">' +
        '<div class="bar__ctl" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 3h2v10H3zM13 3v10L6 8z"/></svg><svg viewBox="0 0 16 16"><path d="M4 2h3v12H4zM9 2h3v12H9z"/></svg><svg viewBox="0 0 16 16"><path d="M11 3h2v10h-2zM3 3v10l7-5z"/></svg></div>' +
        '<span class="bar__time">0:04</span><span class="bar__track"><i></i></span><span class="bar__time">2:54</span>' +
        '<div class="bar__sound"><div class="art" style="' + art(ex === EXAMPLES.ok ? 24 : ex === EXAMPLES.suspect ? 205 : 268) + '"></div><div><span>' + esc(playingArtist) + '</span><b>' + esc(playingTitle) + '</b></div></div>' +
        '<div class="bar__end"><div class="bar__actions" aria-hidden="true">' +
          '<svg viewBox="0 0 16 16"><path d="M8 14.2 2.6 8.9a3.3 3.3 0 0 1 4.7-4.7L8 4.9l.7-.7a3.3 3.3 0 0 1 4.7 4.7z"/></svg>' +
          '<svg viewBox="0 0 16 16"><circle cx="6" cy="5" r="3"/><path d="M0.8 14.5c0-3 2.3-5.2 5.2-5.2s5.2 2.2 5.2 5.2z"/><path d="M12.6 4.5h1.4v2h2v1.4h-2v2h-1.4v-2h-2V6.5h2z"/></svg>' +
          '<svg viewBox="0 0 16 16"><path d="M1 3h10v1.5H1zM1 7h10v1.5H1zM1 11h7v1.5H1zM12 9v6l4-3z"/></svg>' +
        '</div>' + UI.wrap('badge', bv, UI.badgeHTML(bv)) + '</div>' +
      '</div>' +
    '</div></article>';
}

function render() {
  document.getElementById('matrix-sec').dataset.sc = state.sc;
  document.getElementById('matrix').innerHTML = matrixHTML();
  document.getElementById('stages').innerHTML = stages.map(stageHTML).join('');
  document.querySelectorAll('.seg').forEach((seg) => {
    const cur = seg.dataset.control === 'sc' ? state.sc : state.playing;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cur)));
  });
}

document.querySelectorAll('.seg').forEach((seg) =>
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (seg.dataset.control === 'sc') state.sc = b.dataset.v;
    else state.playing = b.dataset.v;
    stages.forEach((st) => (st.notice = true));
    render();
  })
);

const stagesEl = document.getElementById('stages');
const stageOf = (el) => stages[Number(el.closest('.stage').dataset.i)];
stagesEl.addEventListener('click', (e) => {
  const stageEl = e.target.closest('.stage');
  if (!stageEl) return;
  const st = stageOf(stageEl);
  if (e.target.closest('a[href]')) e.preventDefault();
  if (e.target.closest('.sna-badge__btn')) st.panelOpen = !st.panelOpen;
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'close') st.panelOpen = false;
    if (a === 'more') st.showAll = !st.showAll;
    if (a === 'undo') {
      st.notice = false;
      setTimeout(() => { st.notice = true; render(); }, 1800);
    }
  }
  if (!e.target.closest('summary') && !e.target.closest('label')) render();
});
stagesEl.addEventListener('change', (e) => {
  const input = e.target.closest('[data-set]');
  if (!input) return;
  const st = stageOf(input);
  const k = input.dataset.set;
  st.settings[k] = input.type === 'checkbox' ? input.checked : Number(input.value);
  if (st.settings.suspectThreshold > st.settings.aiThreshold - 5) st.settings.suspectThreshold = st.settings.aiThreshold - 5;
  render();
});
stagesEl.addEventListener('input', (e) => {
  if (e.target.type !== 'range') return;
  const out = e.target.closest('.sna-field').querySelector('output');
  if (out) out.textContent = e.target.value;
});
stagesEl.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches || !d.matches('details[data-section]')) return;
  stageOf(d).open[d.dataset.section] = d.open;
}, true);

render();
</script>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);
console.log(`wrote ${OUT} (${(page.length / 1024).toFixed(1)} KB)`);

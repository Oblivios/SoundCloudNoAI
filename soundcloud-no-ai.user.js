// ==UserScript==
// @name         SoundCloud No AI
// @namespace    https://github.com/Oblivios/SoundCloudNoAI
// @version      1.0.0
// @description  Detects likely AI-generated / content-farm tracks on SoundCloud and skips them automatically.
// @author       Oblivios
// @match        https://soundcloud.com/*
// @icon         https://a-v2.sndcdn.com/assets/images/sc-icons/favicon-2cadd14bdb.ico
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Oblivios/SoundCloudNoAI
// @downloadURL  https://raw.githubusercontent.com/Oblivios/SoundCloudNoAI/main/soundcloud-no-ai.user.js
// @updateURL    https://raw.githubusercontent.com/Oblivios/SoundCloudNoAI/main/soundcloud-no-ai.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Scoring. Pure functions only, so test/score.test.js can run them   *
   * under Node against real API responses.                             *
   * ------------------------------------------------------------------ */

  const DAY = 864e5;
  const fmtN = (x) => Number(x).toLocaleString('en-US');

  // Upload pipelines sometimes leak their job id into the description,
  // e.g. "[owmp-job:space_mango_next_200_20260930:20]".
  const JOB_TAG_RE = /\[[a-z0-9_.-]*job[a-z0-9_.-]*:[^\]\n]{3,}\]/i;

  // Uploaders who say it themselves: "Suno AI", "AI cover", "AI-assisted",
  // "généré par IA", "hecho con IA", "KI-generiert"...
  const AI_DISCLOSURE_RE = new RegExp(
    [
      '\\b(suno|udio|riffusion|mubert|soundraw|aiva)(\\s*ai|\\.com)?\\b',
      '\\b(ai|a\\.i\\.)[\\s-]*(generated|generative|music|production|produced|songs?|covers?|assisted|made|vocals?|voice|artist|band|tracks?|singer)\\b',
      '\\b(made|created|generated|produced|composed)\\s+(with|by|using)\\s+(an?\\s+)?(ai|a\\.i\\.|artificial intelligence)\\b',
      '\\bartificial intelligence\\b',
      '\\b(g[ée]n[ée]r[ée]e?s?|cr[ée]{2}e?s?|faite?s?|compos[ée]e?s?|hech[oa]s?|generad[oa]s?|cread[oa]s?|producid[oa]s?)\\s+(par|avec|con|por)\\s+(l[\'’]\\s*)?(une?\\s+)?(ia|ai)\\b',
      '\\b(musique|chanson|m[uú]sica|canci[oó]n)\\s+(ia|ai)\\b',
      '\\bki[\\s-]*(generiert|musik|songs?|erstellt)\\b',
      '#(ai|aimusic|aiart|sunoai|suno|udio)\\b',
    ].join('|'),
    'i'
  );

  function aiDisclosure(text) {
    const m = AI_DISCLOSURE_RE.exec(text || '');
    return m ? m[0].trim() : null;
  }

  const trackText = (t) => [t.title, t.description, t.tag_list, t.genre].filter(Boolean).join('\n');

  const DEFAULT_THRESHOLDS = { ai: 60, suspect: 35 };

  // Tracks uploaded together in one batch get their position appended to the
  // permalink ("wireframe-80"). Albums stay below ~30; farms go much higher.
  function batchPosition(track) {
    const permalink = track.permalink || '';
    const m = /-(\d{2,3})$/.exec(permalink);
    if (!m) return 0;
    // Digits that come from the title itself ("Piano 8306", "3.05 PM").
    if ((track.title || '').replace(/\D+/g, '').includes(m[1])) return 0;
    // Dates and series numbers ("...-dec-25", "...-vol-12").
    if (/-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d+(st|nd|rd|th)|vol|part|pt|ep|no|mix|episode|session|day|week)-\d+$/i.test(permalink)) return 0;
    return Number(m[1]);
  }

  // Parenthesised version tags that humans use for the same song.
  const HUMAN_VARIANT_RE = /remix|mix|edit|version|sped|slow|reverb|instrumental|acapella|a cappella|live|demo|cover|bootleg|flip|vip|clean|explicit|extended|radio|nightcore|8d|prod|feat|ft\.|remaster|acoustic version|bass boost/i;

  // Share of uploads that are one title regenerated in several styles,
  // e.g. "To Her (Folk Rock)", "To Her (Celtic Ballad)", "To Her (City Pop)".
  function styleVariantShare(tracks) {
    const groups = {};
    for (const t of tracks) {
      const title = t.title || '';
      const tags = title.match(/\(([^)]*)\)|\[([^\]]*)\]/g);
      if (!tags || tags.some((tag) => HUMAN_VARIANT_RE.test(tag))) continue;
      const base = title
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
      if (base) groups[base] = (groups[base] || 0) + 1;
    }
    const inGroups = Object.values(groups).filter((c) => c >= 3).reduce((s, c) => s + c, 0);
    return tracks.length ? inGroups / tracks.length : 0;
  }

  // Generators tend to put the prompt's style in the title: "Iron Will (Viking
  // Music)", "Trance Energy (Trance, Electronic)", "Moon Dreams (sleep beats)".
  const GENRE_WORDS = new Set(
    ('pop rock house techno trance jazz lofi lo fi phonk ballad soul folk country trap edm electronic electronica electro ambient ' +
      'cinematic synthwave synth wave vaporwave reggae dub dancehall metal punk blues funk disco gospel rnb r&b hip hop rap drill cumbia ' +
      'bossa nova orchestral epic celtic viking western world new age chill chillhop chillout lounge deep melodic progressive hard ' +
      'soft dark dream indie alternative alt grunge shoegaze emo acoustic piano guitar orchestra classical neo neoclassical retro 80s ' +
      '90s 70s city glitch future liquid dnb drum bass breakbeat garage dubstep hardstyle psytrance psy psychedelic downtempo ' +
      'trip latin afro afrobeat afrobeats amapiano kpop jpop anime game lullaby meditation healing sleep study relax relaxing ' +
      'calm focus spa nature rain beats beat vibes music style instrumental vocal power heavy symphonic tropical summer jungle ' +
      'phonk hz 432hz 528hz waltz tango salsa bachata reggaeton flamenco swing bluegrass americana gothic industrial noise ' +
      'experimental minimal tech nu jazzy soulful groovy dance party club ethereal atmospheric')
      .split(/\s+/)
  );

  function genreTagShare(tracks) {
    let tagged = 0;
    for (const t of tracks) {
      const groups = (t.title || '').match(/\(([^)]*)\)|\[([^\]]*)\]/g) || [];
      const isGenre = groups.some((g) => {
        const words = g.slice(1, -1).toLowerCase().split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
        return words.length > 0 && words.every((w) => GENRE_WORDS.has(w));
      });
      if (isGenre) tagged++;
    }
    return tracks.length ? tagged / tracks.length : 0;
  }

  /**
   * @param tracks  the user's most recent uploads
   * @param hiddenPages  how many 50-track pages came back empty before them —
   *                     SoundCloud hides scheduled (future-dated) releases
   */
  function uploadStats(tracks, hiddenPages = 0) {
    const times = tracks
      .map((t) => Date.parse(t.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const n = times.length;
    let burst = 0;
    for (let i = 0, j = 0; i < n; i++) {
      while (times[i] - times[j] > DAY) j++;
      burst = Math.max(burst, i - j + 1);
    }
    const spanDays = n > 1 ? (times[n - 1] - times[0]) / DAY : 0;
    const disclosures = tracks.map((t) => aiDisclosure(trackText(t))).filter(Boolean);
    return {
      n,
      burst,
      spanDays,
      perDay: n / Math.max(spanDays, 1),
      hiddenPages,
      maxBatch: tracks.reduce((m, t) => Math.max(m, batchPosition(t)), 0),
      variantShare: styleVariantShare(tracks),
      genreTagShare: genreTagShare(tracks),
      jobTags: tracks.filter((t) => JOB_TAG_RE.test(t.description || '')).length,
      disclosures: disclosures.length,
      disclosure: disclosures[0] || null,
    };
  }

  /**
   * @param track  api-v2 track object
   * @param user   api-v2 user object (full, with track_count / followings_count)
   * @param stats  uploadStats() of the user's most recent uploads, or null
   * @param ctx    { now, thresholds, farmComposers: { [composerLowercase]: userId[] } }
   * @returns {{score:number, verdict:'ai'|'suspect'|'ok', reasons:{pts:number, why:string}[]}}
   */
  function scoreTrack(track, user, stats, ctx = {}) {
    const now = ctx.now || Date.now();
    const th = Object.assign({}, DEFAULT_THRESHOLDS, ctx.thresholds);
    const farmComposers = ctx.farmComposers || {};
    const reasons = [];
    const add = (pts, why) => reasons.push({ pts, why });

    const tc = user.track_count || 0;
    const fol = user.followers_count || 0;
    const badges = user.badges || {};
    const composer = ((track.publisher_metadata && track.publisher_metadata.writer_composer) || '').trim();

    // --- smoking guns ---
    if (JOB_TAG_RE.test(track.description || '') || (stats && stats.jobTags > 0)) {
      add(100, 'Upload-pipeline job tag in description');
    }
    const composerAccounts = composer ? farmComposers[composer.toLowerCase()] : null;
    if (Array.isArray(composerAccounts) && composerAccounts.some((id) => id !== user.id)) {
      add(50, `Composer "${composer}" is behind other flagged accounts`);
    }
    const said = aiDisclosure(trackText(track));
    const bio = aiDisclosure(user.description);
    const disclosed = stats ? stats.disclosures : 0;
    if (said) add(70, `Track says "${said}"`);
    else if (bio) add(60, `Profile says "${bio}"`);
    else if (disclosed >= 3) add(60, `${disclosed} recent uploads say "${stats.disclosure}"`);
    else if (disclosed === 2) add(45, `2 recent uploads say "${stats.disclosure}"`);
    else if (disclosed === 1) add(25, `A recent upload says "${stats.disclosure}"`);

    // --- upload cadence ---
    if (stats) {
      let cadence = 0;
      let why = '';
      if (stats.n >= 20) {
        const rate = stats.perDay;
        if (rate >= 8) cadence = 45;
        else if (rate >= 3) cadence = 25;
        else if (rate >= 1.5) cadence = 10;
        if (cadence) why = `Uploads ~${rate.toFixed(1)} tracks/day (last ${stats.n})`;
      }
      const burstPts = stats.burst >= 30 ? 25 : stats.burst >= 20 ? 10 : 0;
      if (burstPts > cadence) {
        cadence = burstPts;
        why = `${stats.burst} tracks uploaded within 24h`;
      }
      if (cadence) add(cadence, why);

      if (stats.hiddenPages >= 2) add(25, `${fmtN(stats.hiddenPages * 50)}+ tracks scheduled for future release`);
      else if (stats.hiddenPages === 1) add(10, 'Dozens of tracks scheduled for future release');

      if (stats.n >= 10 && stats.variantShare >= 0.25) {
        add(20, `${Math.round(stats.variantShare * 100)}% of uploads are one title in several styles`);
      }
      if (stats.n >= 10 && stats.genreTagShare >= 0.5) {
        add(15, `${Math.round(stats.genreTagShare * 100)}% of titles carry a style tag like "(Viking Music)"`);
      }
    }
    const batch = Math.max(batchPosition(track), stats ? stats.maxBatch : 0);
    if (batch >= 40) add(20, `Bulk uploads of ${batch}+ tracks at once`);

    // --- catalogue size vs. audience ---
    if (tc >= 150) {
      const ratio = tc / Math.max(fol, 1);
      if (ratio >= 5) add(35, `${fmtN(tc)} tracks but only ${fmtN(fol)} followers`);
      else if (ratio >= 2) add(20, `${fmtN(tc)} tracks vs ${fmtN(fol)} followers`);
      else if (ratio >= 1) add(8, `More tracks (${fmtN(tc)}) than followers (${fmtN(fol)})`);
    }
    if (tc >= 1000 && fol < 2000) add(10, `Huge catalogue (${fmtN(tc)} tracks)`);

    // --- weak account hints ---
    if (user.followings_count === 0 && tc >= 50 && fol < 5000) add(8, 'Follows nobody');
    if (badges.pro_unlimited && fol < 1000 && tc >= 100) add(5, 'Pro Unlimited (unlimited uploads) with a small audience');
    if (/default_avatar/.test(user.avatar_url || '') && tc >= 50) add(5, 'Default avatar');
    if (track.playback_count == null) add(5, 'Play count hidden');

    // --- the track itself ---
    const plays = track.playback_count;
    const ageDays = (now - Date.parse(track.created_at)) / DAY;
    if (plays != null && plays < 150 && ageDays >= 7) {
      add(10, `Only ${fmtN(plays)} plays after ${Math.floor(ageDays)} days`);
    }

    // --- evidence of a real audience ---
    if (user.verified || badges.verified) add(-100, 'Verified artist');
    if (fol >= 100000) add(-60, `${fmtN(fol)} followers`);
    else if (fol >= 20000) add(-35, `${fmtN(fol)} followers`);
    else if (fol >= 5000) add(-15, `${fmtN(fol)} followers`);
    if ((track.comment_count || 0) >= 5) add(-10, `${fmtN(track.comment_count)} comments`);
    if ((track.likes_count || 0) >= 100) add(-10, `${fmtN(track.likes_count)} likes`);

    const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.pts, 0)));
    const verdict = score >= th.ai ? 'ai' : score >= th.suspect ? 'suspect' : 'ok';
    reasons.sort((a, b) => b.pts - a.pts);
    return { score, verdict, reasons };
  }

  const Score = { scoreTrack, uploadStats, batchPosition, styleVariantShare, genreTagShare, aiDisclosure, JOB_TAG_RE, DEFAULT_THRESHOLDS };

  // <ui>
  /* ------------------------------------------------------------------ *
   * UI. Pure templates: a view object in, an HTML string out. This     *
   * block is copied as-is into the preview page by tools/preview.mjs,  *
   * so keep it self-contained.                                         *
   * ------------------------------------------------------------------ */

  const UI = (() => {
    const REASONS_SHOWN = 3;
    const LABEL = { idle: 'No AI', pending: 'Checking', error: 'Error', ok: 'OK', suspect: 'AI?', ai: 'AI' };
    const VERDICT = { idle: 'Nothing playing', pending: 'Checking…', error: 'Couldn’t check this track', ok: 'Looks human', suspect: 'Suspicious', ai: 'Likely AI' };
    const SCORED = new Set(['ok', 'suspect', 'ai']);

    const ICON = {
      block: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M4 12l8-8"/></svg>',
      trust: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
      skip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="sna-fill" d="M3.5 3.2v9.6L10.4 8z"/><path d="M12.5 3.5v9"/></svg>',
      close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
      chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const num = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));
    const signed = (p) => (p > 0 ? `+${p}` : p < 0 ? `−${-p}` : '·');

    function ago(ms) {
      const s = Math.max(0, ms) / 1000;
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)} min ago`;
      if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
      return `${Math.floor(s / 86400)} d ago`;
    }

    // Attributes of a component's root element. Styles hang off these.
    function attrs(kind, v) {
      const a = { class: `sna sna-${kind}`, 'data-scheme': v.scheme === 'light' ? 'light' : 'dark', 'data-state': v.state || 'idle' };
      if (v.off) a['data-off'] = '';
      if (v.notice) a['data-notice'] = '';
      return a;
    }
    const attrString = (a) => Object.entries(a).map(([k, val]) => (val === '' ? k : `${k}="${esc(val)}"`)).join(' ');
    const wrap = (kind, v, inner, tag = 'div') => `<${tag} ${attrString(attrs(kind, v))}>${inner}</${tag}>`;

    // A dot in the player bar; the label slides out on hover or focus.
    // Right after a skip it reads "Skipped · Undo" for a few seconds.
    // v: { state, score, off, open, notice: { kind: 'skipped' | 'paused', title, artist } }
    function badgeHTML(v) {
      const state = v.state || 'idle';
      const scored = SCORED.has(state) && !v.notice;
      const done = v.notice && (v.notice.kind === 'paused' ? 'Paused' : 'Skipped');
      const tip = done
        ? `${done} “${v.notice.title}” by ${v.notice.artist}`
        : `SoundCloud No AI · ${VERDICT[state]}${scored ? ` (score ${v.score})` : ''}${v.off ? ' · auto-skip off' : ''}`;
      return (
        `<button type="button" class="sna-badge__btn" aria-haspopup="dialog" aria-expanded="${v.open ? 'true' : 'false'}" title="${esc(tip)}">` +
        '<span class="sna-badge__dot" aria-hidden="true"></span>' +
        `<span class="sna-badge__text"><span class="sna-badge__label">${done || LABEL[state]}</span>` +
        (scored ? `<span class="sna-badge__score">${v.score}</span>` : '') +
        (v.off && !done ? '<span class="sna-badge__off">off</span>' : '') +
        '</span></button>' +
        (done
          ? `<button type="button" class="sna-badge__undo" data-act="undo" title="Play it again">Undo</button><span class="sna-sr" role="status">${esc(tip)}</span>`
          : '')
      );
    }

    const toggle = (key, label, on) =>
      `<label class="sna-toggle"><input type="checkbox" class="sna-toggle__input" data-set="${key}"${on ? ' checked' : ''}><span class="sna-toggle__track" aria-hidden="true"></span><span>${label}</span></label>`;

    const slider = (key, label, value, min, max) =>
      `<label class="sna-field"><span class="sna-field__row"><span>${label}</span><output class="sna-field__val">${value}</output></span>` +
      `<input type="range" class="sna-range" data-set="${key}" min="${min}" max="${max}" step="5" value="${value}"></label>`;

    /**
     * v: { scheme, state, title, url, artist, artistUrl, tracks, followers,
     *      score, reasons, outcome, listStatus, error, showAll, open: {settings, history},
     *      settings, counts: {blocked, trusted, composers}, history: [{title, artist, url, score, ago}] }
     */
    function panelHTML(v) {
      const state = v.state || 'idle';
      const scored = SCORED.has(state);
      const set = v.settings || {};
      const th = { ai: set.aiThreshold || 60, suspect: set.suspectThreshold || 35 };
      let h = '';

      h +=
        '<div class="sna-panel__head">' +
        `<span class="sna-panel__verdict"><span class="sna-panel__vdot" aria-hidden="true"></span>${esc(VERDICT[state])}</span>` +
        (v.outcome ? `<span class="sna-panel__outcome">${esc(v.outcome)}</span>` : '') +
        (scored ? `<span class="sna-panel__num">${v.score}<small>/100</small></span>` : '') +
        `<button type="button" class="sna-iconbtn" data-act="close" aria-label="Close">${ICON.close}</button></div>`;

      if (v.title) {
        h +=
          '<div class="sna-panel__track">' +
          `<a class="sna-panel__title" href="${esc(v.url)}" title="${esc(v.title)}">${esc(v.title)}</a>` +
          `<div class="sna-panel__meta"><a href="${esc(v.artistUrl)}">${esc(v.artist)}</a>` +
          (v.tracks != null ? ` · ${num(v.tracks)} tracks · ${num(v.followers)} followers` : '') +
          '</div></div>';
      }

      if (scored) {
        const reasons = v.reasons || [];
        const shown = v.showAll ? reasons : reasons.slice(0, REASONS_SHOWN);
        h +=
          '<ul class="sna-reasons" aria-label="Why this score">' +
          shown
            .map((r) => `<li class="sna-reason ${r.pts < 0 ? 'is-neg' : 'is-pos'}"><span class="sna-reason__pts">${signed(r.pts)}</span><span class="sna-reason__why">${esc(r.why)}</span></li>`)
            .join('') +
          '</ul>';
        if (reasons.length > REASONS_SHOWN) {
          h += `<button type="button" class="sna-linkbtn" data-act="more">${v.showAll ? 'Show fewer' : `Show all ${reasons.length}`}</button>`;
        }
      } else if (state === 'error') {
        h += `<p class="sna-panel__note">${esc(v.error || 'SoundCloud didn’t answer.')}</p>`;
      } else if (state === 'pending') {
        h += '<p class="sna-panel__note">Looking at the uploader’s recent activity.</p>';
      } else {
        h += '<p class="sna-panel__note">Play a track and its AI score shows up here.</p>';
      }

      if (v.title) {
        const isBlocked = v.listStatus === 'blocked';
        const isTrusted = v.listStatus === 'trusted';
        h +=
          '<div class="sna-actions">' +
          `<button type="button" class="sna-btn${isBlocked ? ' is-on' : ''}" data-act="block" aria-pressed="${isBlocked}">${ICON.block}<span>${isBlocked ? 'Unblock' : 'Block artist'}</span></button>` +
          `<button type="button" class="sna-btn${isTrusted ? ' is-on' : ''}" data-act="trust" aria-pressed="${isTrusted}">${ICON.trust}<span>${isTrusted ? 'Untrust' : 'Trust artist'}</span></button>` +
          `<button type="button" class="sna-btn is-primary" data-act="skip">${ICON.skip}<span>Skip</span></button></div>`;
      } else if (state === 'error') {
        h += '<div class="sna-actions"><button type="button" class="sna-btn" data-act="retry"><span>Try again</span></button></div>';
      }

      const counts = v.counts || {};
      h +=
        '<div class="sna-sections">' +
        `<details class="sna-section" data-section="settings"${v.open && v.open.settings ? ' open' : ''}>` +
        `<summary class="sna-section__sum">${ICON.chevron}Settings</summary><div class="sna-section__body">` +
        toggle('enabled', 'Skip AI tracks automatically', set.enabled) +
        toggle('skipSuspects', 'Also skip suspicious tracks', set.skipSuspects) +
        toggle('markLists', 'Mark AI artists in lists', set.markLists) +
        toggle('learnComposers', 'Learn songwriter credits used by farms', set.learnComposers) +
        slider('aiThreshold', 'Skip from score', th.ai, 30, 100) +
        slider('suspectThreshold', 'Suspicious from score', th.suspect, 10, th.ai - 5) +
        `<div class="sna-panel__foot"><span>${num(counts.blocked || 0)} blocked · ${num(counts.trusted || 0)} trusted · ${num(counts.composers || 0)} credits learned</span>` +
        '<button type="button" class="sna-linkbtn" data-act="clear">Clear cache</button></div></div></details>';

      const hist = v.history || [];
      h +=
        `<details class="sna-section" data-section="history"${v.open && v.open.history ? ' open' : ''}>` +
        `<summary class="sna-section__sum">${ICON.chevron}Recently skipped<span class="sna-section__count">${hist.length}</span></summary><div class="sna-section__body">` +
        (hist.length
          ? '<ul class="sna-history">' +
            hist
              .slice(0, 8)
              .map((x) => `<li><a href="${esc(x.url)}" title="${esc(x.title)}">${esc(x.title)}</a><span>${esc(x.artist)} · ${esc(x.ago)}</span><b>${x.score}</b></li>`)
              .join('') +
            '</ul>'
          : '<p class="sna-panel__note">Nothing skipped yet.</p>') +
        '</div></details></div>';
      return h;
    }

    // A small dot next to the artist's name in lists. v: { scheme, state: 'ai' | 'suspect' }
    const flagHTML = (v) => `<span ${attrString(attrs('flag', v))} title="${esc(VERDICT[v.state])} · SoundCloud No AI">${v.state === 'ai' ? 'AI' : 'AI?'}</span>`;

    const CSS = `
.sna{--sna-surface:var(--surface-color,#fff);--sna-raised:var(--surface-color,#fff);--sna-fg:var(--primary-color,#121212);--sna-rgb:var(--primary-rgb,18,18,18);--sna-muted:var(--secondary-color,#666);--sna-line:rgba(var(--sna-rgb),.14);--sna-accent:var(--special-color,#f50);--sna-ai:#d61348;--sna-suspect:#b26a00;--sna-ok:#00875a;--sna-shadow:0 12px 32px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.06);--sna-font:var(--font-sans-serif-family,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);--sna-v:var(--sna-muted);font:400 13px/1.4 var(--sna-font);color:var(--sna-fg);-webkit-font-smoothing:antialiased}
.sna[data-scheme=dark]{--sna-raised:#1b1b1b;--sna-ai:#ff5a78;--sna-suspect:#f2b33d;--sna-ok:#3fcf8e;--sna-shadow:0 16px 40px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04)}
.sna[data-state=ok]{--sna-v:var(--sna-ok)}.sna[data-state=suspect]{--sna-v:var(--sna-suspect)}.sna[data-state=ai]{--sna-v:var(--sna-ai)}
.sna,.sna *,.sna *::before,.sna *::after{box-sizing:border-box}
.sna :is(button,a,input,ul,li,p,label,output,details,summary,b,i,small){margin:0;padding:0;border:0;background:none;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;text-decoration:none;list-style:none;box-shadow:none;min-width:0;line-height:inherit}
.sna summary::-webkit-details-marker{display:none}
.sna svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sna svg .sna-fill{fill:currentColor;stroke:none}
.sna :focus{outline:none}.sna :focus-visible{outline:2px solid var(--sna-accent);outline-offset:2px}
@keyframes sna-pulse{50%{opacity:.25}}
@keyframes sna-grow{from{max-width:0;opacity:0}}
.sna .sna-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.sna,.sna *{animation:none!important;transition:none!important}}

.sna-badge{display:flex;align-items:center;align-self:center;flex:none;margin:0 4px 0 10px;border-radius:13px;transition:background-color .2s}
.sna-badge .sna-badge__btn{display:inline-flex;align-items:center;gap:0;height:26px;padding:0 8px;border-radius:13px;font-size:12px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;color:var(--sna-fg);transition:background-color .15s,opacity .15s,gap .2s}
.sna-badge .sna-badge__btn:is(:hover,:focus-visible,[aria-expanded=true]){gap:7px;background:rgba(var(--sna-rgb),.08)}
.sna-badge .sna-badge__dot{width:10px;height:10px;flex:none;border-radius:50%;background:var(--sna-v)}
.sna-badge:is([data-state=idle],[data-state=error]) .sna-badge__dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--sna-muted)}
.sna-badge[data-state=pending] .sna-badge__dot{animation:sna-pulse 1s ease-in-out infinite}
.sna-badge[data-state=ai] .sna-badge__dot{box-shadow:0 0 0 3px color-mix(in srgb,var(--sna-ai) 30%,transparent)}
.sna-badge[data-off] .sna-badge__btn{opacity:.6}
.sna-badge[data-off] .sna-badge__dot{background:transparent;box-shadow:inset 0 0 0 2px var(--sna-v)}
.sna-badge .sna-badge__text{display:inline-flex;align-items:baseline;gap:5px;max-width:0;overflow:hidden;opacity:0;transition:max-width .22s ease,opacity .18s ease}
.sna-badge .sna-badge__btn:is(:hover,:focus-visible,[aria-expanded=true]) .sna-badge__text{max-width:96px;opacity:1}
.sna-badge .sna-badge__score,.sna-badge .sna-badge__off{font-weight:500;color:var(--sna-muted);font-variant-numeric:tabular-nums}
.sna-badge .sna-badge__undo{display:inline-flex;align-items:center;height:26px;max-width:0;overflow:hidden;opacity:0;font-size:12px;font-weight:600;white-space:nowrap;color:var(--sna-fg);cursor:pointer;transition:max-width .22s ease,opacity .18s ease}
.sna-badge .sna-badge__undo::before{content:"·";margin-right:6px;color:var(--sna-muted)}
.sna-badge .sna-badge__undo:hover{text-decoration:underline;text-underline-offset:2px}
.sna-badge[data-notice]{background:rgba(var(--sna-rgb),.08)}
.sna-badge[data-notice] .sna-badge__btn{gap:7px;padding-right:6px;background:none}
.sna-badge[data-notice] .sna-badge__text{max-width:96px;opacity:1;animation:sna-grow .25s ease}
.sna-badge[data-notice] .sna-badge__undo{max-width:80px;opacity:1;padding-right:10px;animation:sna-grow .25s ease}

.sna-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:10px;width:296px;max-width:calc(100vw - 24px);max-height:calc(100vh - 84px);overflow:auto;overscroll-behavior:contain;padding:12px 14px 2px;border-radius:14px;background:var(--sna-raised);color:var(--sna-fg);box-shadow:var(--sna-shadow)}
.sna-panel .sna-panel__head{display:flex;align-items:center;gap:8px;min-height:26px}
.sna-panel .sna-panel__verdict{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;white-space:nowrap}
.sna-panel .sna-panel__vdot{width:9px;height:9px;flex:none;border-radius:50%;background:var(--sna-v)}
.sna-panel:is([data-state=idle],[data-state=error]) .sna-panel__vdot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--sna-muted)}
.sna-panel[data-state=pending] .sna-panel__vdot{animation:sna-pulse 1s ease-in-out infinite}
.sna-panel .sna-panel__outcome{padding:2px 7px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;color:var(--sna-muted);background:rgba(var(--sna-rgb),.07)}
.sna-panel .sna-panel__num{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
.sna-panel .sna-panel__num small{margin-left:1px;font-size:11px;font-weight:500;color:var(--sna-muted)}
.sna-panel .sna-iconbtn{display:grid;place-items:center;width:26px;height:26px;margin:0 -6px 0 auto;border-radius:13px;color:var(--sna-muted);cursor:pointer}
.sna-panel .sna-panel__num+.sna-iconbtn{margin-left:2px}
.sna-panel .sna-iconbtn:hover{color:var(--sna-fg);background:rgba(var(--sna-rgb),.08)}
.sna-panel .sna-panel__track{display:flex;flex-direction:column;gap:2px;min-width:0}
.sna-panel .sna-panel__title{overflow:hidden;font-size:13px;font-weight:600;white-space:nowrap;text-overflow:ellipsis}
.sna-panel .sna-panel__meta{overflow:hidden;font-size:12px;white-space:nowrap;text-overflow:ellipsis;color:var(--sna-muted)}
.sna-panel .sna-panel__meta a{color:var(--sna-fg)}
.sna-panel :is(.sna-panel__title,.sna-panel__meta a,.sna-history a):hover{text-decoration:underline}
.sna-panel .sna-panel__note{font-size:12px;color:var(--sna-muted)}
.sna-panel .sna-reasons{display:flex;flex-direction:column;gap:6px}
.sna-panel .sna-reason{display:grid;grid-template-columns:32px 1fr;gap:8px;align-items:baseline;font-size:12px}
.sna-panel .sna-reason__pts{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:var(--sna-muted)}
.sna-panel .sna-reason__why{min-width:0;overflow-wrap:anywhere}
.sna-panel .sna-linkbtn{align-self:flex-start;font-size:12px;font-weight:600;color:var(--sna-muted);cursor:pointer}
.sna-panel .sna-linkbtn:hover{color:var(--sna-fg)}
.sna-panel .sna-actions{display:flex;flex-wrap:wrap;gap:2px}
.sna-panel .sna-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:13px;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer;color:var(--sna-muted);transition:background-color .15s,color .15s}
.sna-panel .sna-btn:hover{color:var(--sna-fg);background:rgba(var(--sna-rgb),.08)}
.sna-panel .sna-btn.is-on{color:var(--sna-fg);box-shadow:inset 0 0 0 1.5px currentColor}
.sna-panel .sna-btn.is-primary{margin-left:auto;color:var(--sna-fg);background:rgba(var(--sna-rgb),.09)}
.sna-panel .sna-btn.is-primary:hover{background:rgba(var(--sna-rgb),.15)}
.sna-panel .sna-sections{display:flex;flex-direction:column;margin:0 -14px;padding:0 14px}
.sna-panel .sna-section{border-top:1px solid var(--sna-line);margin:0 -14px;padding:0 14px}
.sna-panel .sna-section__sum{display:flex;align-items:center;gap:6px;height:38px;font-size:12px;font-weight:600;color:var(--sna-muted);cursor:pointer}
.sna-panel .sna-section__sum:hover{color:var(--sna-fg)}
.sna-panel .sna-section__sum svg{transition:transform .15s}
.sna-panel .sna-section[open]>.sna-section__sum{color:var(--sna-fg)}
.sna-panel .sna-section[open]>.sna-section__sum svg{transform:rotate(90deg)}
.sna-panel .sna-section__count{margin-left:auto;font-variant-numeric:tabular-nums}
.sna-panel .sna-section__body{display:flex;flex-direction:column;gap:12px;padding:0 0 14px}
.sna-panel .sna-toggle{position:relative;display:flex;align-items:center;gap:10px;font-size:12px;cursor:pointer}
.sna-panel .sna-toggle__input{position:absolute;width:1px;height:1px;opacity:0}
.sna-panel .sna-toggle__track{position:relative;flex:none;width:28px;height:16px;border-radius:8px;background:rgba(var(--sna-rgb),.22);transition:background-color .15s}
.sna-panel .sna-toggle__track::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.sna-panel .sna-toggle__input:checked+.sna-toggle__track{background:var(--sna-accent)}
.sna-panel .sna-toggle__input:checked+.sna-toggle__track::after{transform:translateX(12px)}
.sna-panel .sna-toggle__input:focus-visible+.sna-toggle__track{outline:2px solid var(--sna-accent);outline-offset:2px}
.sna-panel .sna-field{display:flex;flex-direction:column;gap:6px;font-size:12px}
.sna-panel .sna-field__row{display:flex;justify-content:space-between}
.sna-panel .sna-field__val{font-weight:700;font-variant-numeric:tabular-nums}
.sna-panel .sna-range{width:100%;height:16px;margin:0;accent-color:var(--sna-accent);cursor:pointer}
.sna-panel .sna-panel__foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--sna-muted)}
.sna-panel .sna-history{display:flex;flex-direction:column;gap:9px}
.sna-panel .sna-history li{display:grid;grid-template-columns:1fr auto;column-gap:12px;min-width:0}
.sna-panel .sna-history a{overflow:hidden;font-size:12px;font-weight:600;white-space:nowrap;text-overflow:ellipsis}
.sna-panel .sna-history span{overflow:hidden;grid-column:1;font-size:11px;white-space:nowrap;text-overflow:ellipsis;color:var(--sna-muted)}
.sna-panel .sna-history b{grid-column:2;grid-row:1/span 2;align-self:center;font-weight:700;font-variant-numeric:tabular-nums;color:var(--sna-ai)}


.sna-flag{display:inline-block;width:8px;height:8px;margin-left:6px;vertical-align:middle;border-radius:50%;font-size:0;color:transparent;background:var(--sna-v)}
.sna-dim{opacity:.4;transition:opacity .2s}.sna-dim:hover{opacity:1}
`;

    return { attrs, wrap, ago, badgeHTML, panelHTML, flagHTML, CSS };
  })();
  // </ui>

  if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
    module.exports = { ...Score, UI };
    return;
  }

  /* ------------------------------------------------------------------ *
   * Browser side                                                       *
   * ------------------------------------------------------------------ */

  const API = 'https://api-v2.soundcloud.com';
  const KEY = 'scnoai';
  const USER_TTL = 12 * 3600e3;
  const MAX_CACHED_USERS = 400;
  const LOG = (...a) => console.debug('[SC No AI]', ...a);

  const store = {
    get(name, fallback) {
      try {
        const v = JSON.parse(localStorage.getItem(`${KEY}:${name}`));
        return v == null ? fallback : v;
      } catch {
        return fallback;
      }
    },
    set(name, value) {
      try {
        localStorage.setItem(`${KEY}:${name}`, JSON.stringify(value));
      } catch (e) {
        LOG('storage failed', e);
      }
    },
  };

  const settings = Object.assign(
    { enabled: true, skipSuspects: false, aiThreshold: DEFAULT_THRESHOLDS.ai, suspectThreshold: DEFAULT_THRESHOLDS.suspect, learnComposers: true, markLists: true },
    store.get('settings', {})
  );
  const saveSettings = () => store.set('settings', settings);

  // { [userId]: { name, permalink } }
  const blocked = store.get('blocked', {});
  const trusted = store.get('trusted', {});
  // { [composerLowercase]: userId[] } — accounts flagged with that songwriter credit
  const farmComposers = store.get('farmComposers', {});
  // { [userId]: { at, user, stats } }
  const userCache = store.get('userCache', {});
  // { [permalink]: 'ai' | 'suspect' } — used to mark lists without extra requests
  const verdictByPermalink = store.get('verdicts', {});
  const skipLog = store.get('skipLog', []);

  /* ---------------- API ---------------- */

  let clientId = store.get('clientId', null);

  function clientIdFromPerformance() {
    for (const e of performance.getEntriesByType('resource')) {
      const m = /[?&]client_id=([A-Za-z0-9]{20,40})/.exec(e.name);
      if (m) return m[1];
    }
    return null;
  }

  async function clientIdFromAssets() {
    const srcs = [...document.querySelectorAll('script[src*="sndcdn.com/assets/"]')].map((s) => s.src).reverse();
    for (const src of srcs) {
      try {
        const m = /client_id\s*[:=]\s*"([A-Za-z0-9]{20,40})"/.exec(await (await fetch(src)).text());
        if (m) return m[1];
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async function getClientId(refresh) {
    if (clientId && !refresh) return clientId;
    clientId = clientIdFromPerformance() || (await clientIdFromAssets());
    if (!clientId) throw new Error('could not find a SoundCloud client_id');
    store.set('clientId', clientId);
    return clientId;
  }

  async function api(pathOrUrl, params = {}, retried = false) {
    const url = new URL(pathOrUrl, API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('client_id', await getClientId(retried));
    const res = await fetch(url, { credentials: 'omit' });
    if ((res.status === 401 || res.status === 403) && !retried) return api(pathOrUrl, params, true);
    if (!res.ok) throw new Error(`${res.status} ${url.pathname}`);
    return res.json();
  }

  async function recentUploads(userId) {
    // The endpoint is ordered by release date and returns empty pages for
    // scheduled (future-dated) releases, so keep following next_href.
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

  async function userProfile(partialUser) {
    const id = partialUser.id;
    const hit = userCache[id];
    if (hit && Date.now() - hit.at < USER_TTL) return hit;
    const user = partialUser.track_count == null ? await api(`/users/${id}`) : partialUser;
    const { tracks, hiddenPages } = await recentUploads(id);
    const stats = Score.uploadStats(tracks, hiddenPages);
    const entry = { at: Date.now(), user: slimUser(user), stats };
    userCache[id] = entry;
    const ids = Object.keys(userCache);
    if (ids.length > MAX_CACHED_USERS) {
      ids.sort((a, b) => userCache[a].at - userCache[b].at);
      for (const old of ids.slice(0, ids.length - MAX_CACHED_USERS)) delete userCache[old];
    }
    store.set('userCache', userCache);
    return entry;
  }

  function slimUser(u) {
    const keep = ['id', 'username', 'permalink', 'track_count', 'followers_count', 'followings_count', 'verified', 'badges', 'avatar_url'];
    const slim = Object.fromEntries(keep.map((k) => [k, u[k]]));
    slim.description = (u.description || '').slice(0, 600);
    return slim;
  }

  /* ---------------- analysis ---------------- */

  const trackCache = new Map(); // path -> track

  async function analyse(path) {
    let track = trackCache.get(path);
    if (!track) {
      track = await api('/resolve', { url: `https://soundcloud.com${path}` });
      if (track.kind !== 'track') throw new Error(`not a track: ${path}`);
      trackCache.set(path, track);
    }
    const uid = track.user_id;
    if (trusted[uid]) {
      return { track, user: track.user, result: { score: 0, verdict: 'ok', reasons: [{ pts: 0, why: 'You trusted this artist' }] } };
    }
    if (blocked[uid]) {
      return { track, user: track.user, result: { score: 100, verdict: 'ai', reasons: [{ pts: 100, why: 'You blocked this artist' }] } };
    }
    const { user, stats } = await userProfile(track.user);
    const result = Score.scoreTrack(track, user, stats, {
      farmComposers: settings.learnComposers ? farmComposers : {},
      thresholds: { ai: settings.aiThreshold, suspect: settings.suspectThreshold },
    });
    // Farms run many "artists" under one songwriter credit; remember it so
    // that credit counts against the next account it shows up on.
    if (settings.learnComposers && result.score >= 80) {
      const c = ((track.publisher_metadata && track.publisher_metadata.writer_composer) || '').trim().toLowerCase();
      if (c && c !== (user.username || '').toLowerCase()) {
        const owners = Array.isArray(farmComposers[c]) ? farmComposers[c] : [];
        if (!owners.includes(user.id)) {
          farmComposers[c] = [...owners, user.id].slice(-20);
          store.set('farmComposers', farmComposers);
        }
      }
    }
    if (result.verdict !== 'ok') verdictByPermalink[user.permalink] = result.verdict;
    else delete verdictByPermalink[user.permalink];
    store.set('verdicts', verdictByPermalink);
    return { track, user, result };
  }

  /* ---------------- player ---------------- */

  const $ = (sel, root = document) => root.querySelector(sel);

  function currentTrackPath() {
    const a = $('.playbackSoundBadge__titleLink');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    return href.split(/[?#]/)[0] || null;
  }

  function skipToNext() {
    const next = $('.skipControl__next');
    if (!next || next.classList.contains('disabled')) return false;
    next.click();
    return true;
  }

  function pause() {
    const play = $('.playControl.playing');
    if (play) play.click();
  }

  let lastPath = null;
  let current = null; // { path, track, user, result, outcome } | { path, error } | { path, pending }
  const allowed = new Set(); // track paths the user brought back with Undo this session

  // Only tracks that arrive on their own (autoplay, stations, the next one in
  // a queue) get skipped. A track you start yourself plays, and so does the
  // rest of that artist this session; otherwise playing from an AI artist's
  // page would race through their whole list.
  const PICK_WINDOW = 3000;
  const PICK_TARGETS = '.sc-button-play, .playButton, .waveform, .compactTrackListItem, .trackItem, .queue__itemWrapper';
  let pickedAt = 0;
  const chosenArtists = new Set();
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!e.isTrusted || !(t instanceof Element) || t.closest('.playControls__elements, .sna')) return;
      if (t.closest(PICK_TARGETS)) pickedAt = Date.now();
    },
    true
  );

  // Never skip more than this many tracks in a row quickly; pause instead.
  const BURST = { skips: 4, ms: 20000 };
  const recentSkips = [];

  async function onTrackChange(path) {
    const picked = Date.now() - pickedAt < PICK_WINDOW;
    current = { path, pending: true };
    render();
    try {
      const info = await analyse(path);
      if (currentTrackPath() !== path) return; // user moved on meanwhile
      const { verdict, score } = info.result;
      const uid = info.track.user_id;
      const wantsSkip = verdict === 'ai' || (settings.skipSuspects && verdict === 'suspect');
      if (wantsSkip && picked) chosenArtists.add(uid);
      const spared = picked || allowed.has(path) || chosenArtists.has(uid);
      let outcome = null;
      if (trusted[uid]) outcome = 'Trusted';
      else if (wantsSkip && picked) outcome = 'You picked it';
      else if (wantsSkip && spared) outcome = 'Allowed';
      else if (wantsSkip && !settings.enabled) outcome = 'Auto-skip off';
      else if (verdict === 'suspect') outcome = 'Kept playing';
      current = { path, ...info, outcome };
      LOG(info.track.title, '—', score, verdict, info.result.reasons);
      if (wantsSkip && settings.enabled && !spared) {
        const now = Date.now();
        while (recentSkips.length && now - recentSkips[0] > BURST.ms) recentSkips.shift();
        const skipped = recentSkips.length < BURST.skips && skipToNext();
        if (skipped) recentSkips.push(now);
        else pause();
        current.outcome = skipped ? 'Skipped' : 'Paused';
        const entry = { at: Date.now(), path, title: info.track.title, artist: info.user.username, url: info.track.permalink_url, score };
        skipLog.unshift(entry);
        skipLog.length = Math.min(skipLog.length, 50);
        store.set('skipLog', skipLog);
        showNotice({ ...entry, kind: skipped ? 'skipped' : 'paused' });
      }
    } catch (e) {
      LOG('analysis failed', e);
      if (currentTrackPath() === path) current = { path, error: String(e.message || e) };
    }
    render();
    markLists();
  }

  let ticks = 0;

  function tick() {
    const path = currentTrackPath();
    if (path && path !== lastPath) {
      lastPath = path;
      onTrackChange(path);
    }
    ensureBadge();
    alignBadge();
    if (++ticks % 4 === 0) followTheme();
  }

  /* ---------------- theme ---------------- */

  // SoundCloud keeps its theme in CSS variables on <body>; the UI reads them
  // directly and only needs to know light vs. dark for its own accents.
  function detectScheme() {
    const cs = getComputedStyle(document.body);
    const rgb = parseColor(cs.getPropertyValue('--surface-color').trim()) || parseColor(cs.backgroundColor);
    if (rgb) return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128 ? 'dark' : 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function parseColor(c) {
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c || '');
    if (m) {
      const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return p.length >= 3 && !(p[3] === 0) ? p.slice(0, 3) : null;
  }

  let scheme = detectScheme();
  function followTheme() {
    const next = detectScheme();
    if (next === scheme) return;
    scheme = next;
    render();
    markLists();
  }

  /* ---------------- views ---------------- */

  const pathOf = (url) => {
    try {
      return new URL(url, location.origin).pathname;
    } catch {
      return url;
    }
  };

  function trackState() {
    if (current && current.pending) return 'pending';
    if (current && current.error) return 'error';
    if (current && current.result) return current.result.verdict;
    return 'idle';
  }

  function badgeView() {
    return {
      scheme,
      state: notice ? 'ai' : trackState(),
      score: current && current.result ? current.result.score : null,
      off: !settings.enabled,
      open: !!panelEl,
      notice: notice && { kind: notice.kind, title: notice.title, artist: notice.artist },
    };
  }

  function panelView() {
    const v = {
      scheme,
      state: trackState(),
      score: current && current.result ? current.result.score : null,
      settings,
      showAll,
      open: sectionsOpen,
      counts: { blocked: Object.keys(blocked).length, trusted: Object.keys(trusted).length, composers: Object.keys(farmComposers).length },
      history: skipLog.map((s) => ({ ...s, url: pathOf(s.url), ago: UI.ago(Date.now() - s.at) })),
    };
    if (current && current.result) {
      const { track, user, result } = current;
      Object.assign(v, {
        title: track.title,
        url: pathOf(track.permalink_url),
        artist: user.username,
        artistUrl: `/${user.permalink}`,
        tracks: user.track_count,
        followers: user.followers_count,
        reasons: result.reasons,
        outcome: current.outcome,
        listStatus: trusted[track.user_id] ? 'trusted' : blocked[track.user_id] ? 'blocked' : null,
      });
    }
    if (current && current.error) v.error = current.error;
    return v;
  }

  // Applies UI.attrs() to a mounted root element, dropping stale data-* flags.
  function setRoot(el, kind, v) {
    const a = UI.attrs(kind, v);
    for (const name of el.getAttributeNames()) if (name.startsWith('data-') && !(name in a)) el.removeAttribute(name);
    for (const [k, val] of Object.entries(a)) el.setAttribute(k, val);
  }

  function render() {
    renderBadge();
    renderPanel();
  }

  /* ---------------- badge ---------------- */

  let badgeEl = null;

  function ensureBadge() {
    if (badgeEl && badgeEl.isConnected) return;
    const host = $('.playControls__elements');
    if (!host) return;
    badgeEl = document.createElement('div');
    badgeEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="undo"]')) undo(notice);
      else if (e.target.closest('.sna-badge__btn')) togglePanel();
    });
    // Hovering holds the "Skipped · Undo" notice open.
    badgeEl.addEventListener('mouseenter', () => {
      if (!notice) return;
      clearTimeout(noticeTimer);
      noticeLeft -= Date.now() - noticeStart;
    });
    badgeEl.addEventListener('mouseleave', () => {
      if (notice) armNotice(Math.max(1200, noticeLeft));
    });
    const sound = $('.playControls__soundBadge', host);
    host.insertBefore(badgeEl, sound ? sound.nextSibling : null);
    renderBadge();
  }

  function renderBadge() {
    if (!badgeEl) return;
    const focused = badgeEl.contains(document.activeElement);
    const v = badgeView();
    setRoot(badgeEl, 'badge', v);
    badgeEl.innerHTML = UI.badgeHTML(v);
    if (focused) badgeEl.querySelector('button').focus();
    alignBadge();
  }

  // Space the dot like SoundCloud's own icons right before it (like, follow,
  // queue): the same gap after the last icon as between the last two.
  function alignBadge() {
    if (!badgeEl || !badgeEl.isConnected) return;
    const dot = badgeEl.querySelector('.sna-badge__dot');
    const actions = $('.playbackSoundBadge__actions');
    const icons = actions
      ? [...actions.children]
          .map((el) => [...el.querySelectorAll('svg'), el].map((x) => x.getBoundingClientRect()).find((r) => r.width > 0))
          .filter(Boolean)
      : [];
    if (!dot || icons.length < 2) {
      badgeEl.style.marginLeft = '';
      return;
    }
    const [prev, last] = icons.slice(-2);
    const want = last.left - prev.right;
    const have = dot.getBoundingClientRect().left - last.right;
    if (Math.abs(want - have) < 0.5) return;
    const margin = parseFloat(getComputedStyle(badgeEl).marginLeft) || 0;
    badgeEl.style.marginLeft = `${Math.max(0, margin + want - have)}px`;
  }

  /* ---------------- panel ---------------- */

  let panelEl = null;
  let showAll = false;
  const sectionsOpen = Object.assign({ settings: false, history: false }, store.get('sections', {}));

  function togglePanel() {
    if (panelEl) closePanel();
    else openPanel();
  }

  function openPanel() {
    panelEl = document.createElement('div');
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'SoundCloud No AI');
    panelEl.tabIndex = -1;
    panelEl.addEventListener('click', onPanelClick);
    panelEl.addEventListener('change', onPanelChange);
    panelEl.addEventListener('input', onPanelInput);
    panelEl.addEventListener('toggle', onPanelToggle, true); // toggle doesn't bubble
    document.body.appendChild(panelEl);
    render();
    panelEl.focus({ preventScroll: true });
  }

  function closePanel(restoreFocus) {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = null;
    showAll = false;
    renderBadge();
    if (restoreFocus && badgeEl) badgeEl.querySelector('button')?.focus();
  }

  function renderPanel() {
    if (!panelEl) return;
    const v = panelView();
    const scroll = panelEl.scrollTop;
    const focusKey = keyOf(document.activeElement);
    setRoot(panelEl, 'panel', v);
    panelEl.innerHTML = UI.panelHTML(v);
    panelEl.scrollTop = scroll;
    if (focusKey) panelEl.querySelector(focusKey)?.focus();
    placePanel();
  }

  // A selector that finds the same control again after a re-render.
  function keyOf(el) {
    if (!el || !panelEl || !panelEl.contains(el)) return null;
    for (const k of ['data-act', 'data-set']) if (el.hasAttribute(k)) return `[${k}="${el.getAttribute(k)}"]`;
    if (el.matches('summary')) return `[data-section="${el.parentElement.dataset.section}"] > summary`;
    return null;
  }

  // Opens upward from the badge, right edges aligned, kept inside the window.
  function placePanel() {
    if (!panelEl) return;
    const anchor = badgeEl && badgeEl.isConnected ? badgeEl.getBoundingClientRect() : null;
    const w = panelEl.offsetWidth;
    const right = anchor ? anchor.right : window.innerWidth - 16;
    panelEl.style.left = `${Math.max(12, Math.min(right - w, window.innerWidth - w - 12))}px`;
    panelEl.style.bottom = `${anchor ? window.innerHeight - anchor.top + 10 : 64}px`;
  }

  function onPanelClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) onAction(act.dataset.act);
  }

  function onPanelChange(e) {
    const input = e.target.closest('[data-set]');
    if (!input) return;
    const k = input.dataset.set;
    if (input.type === 'checkbox') {
      settings[k] = input.checked;
    } else {
      settings[k] = Number(input.value);
      if (settings.suspectThreshold > settings.aiThreshold - 5) settings.suspectThreshold = settings.aiThreshold - 5;
      rethreshold();
    }
    saveSettings();
    if (k === 'markLists') markLists();
    render();
  }

  function onPanelInput(e) {
    if (e.target.type !== 'range') return;
    const out = e.target.closest('.sna-field').querySelector('output');
    if (out) out.textContent = e.target.value;
  }

  function onPanelToggle(e) {
    const d = e.target;
    if (!d.matches || !d.matches('details[data-section]')) return;
    sectionsOpen[d.dataset.section] = d.open;
    store.set('sections', sectionsOpen);
    placePanel();
  }

  // New thresholds relabel the current track without re-running the analysis.
  function rethreshold() {
    if (!current || !current.result || trusted[current.track.user_id] || blocked[current.track.user_id]) return;
    const s = current.result.score;
    current.result.verdict = s >= settings.aiThreshold ? 'ai' : s >= settings.suspectThreshold ? 'suspect' : 'ok';
  }

  function onAction(act) {
    if (act === 'close') return closePanel(true);
    if (act === 'more') {
      showAll = !showAll;
      return renderPanel();
    }
    if (act === 'retry') {
      lastPath = null;
      return;
    }
    if (act === 'clear') {
      for (const k of Object.keys(userCache)) delete userCache[k];
      for (const k of Object.keys(verdictByPermalink)) delete verdictByPermalink[k];
      trackCache.clear();
      store.set('userCache', userCache);
      store.set('verdicts', verdictByPermalink);
      markLists();
      return render();
    }
    if (!current || !current.track) return;
    const { track, user } = current;
    const uid = track.user_id;
    const entry = { name: user.username, permalink: user.permalink };
    if (act === 'skip') return skipToNext();
    if (act === 'block') {
      if (blocked[uid]) delete blocked[uid];
      else {
        blocked[uid] = entry;
        delete trusted[uid];
      }
    }
    if (act === 'trust') {
      if (trusted[uid]) delete trusted[uid];
      else {
        trusted[uid] = entry;
        delete blocked[uid];
      }
    }
    store.set('blocked', blocked);
    store.set('trusted', trusted);
    if (act === 'block' && blocked[uid]) {
      verdictByPermalink[user.permalink] = 'ai';
      store.set('verdicts', verdictByPermalink);
    }
    lastPath = null; // re-run the analysis with the new list state
    render();
  }

  // Click outside or Escape closes the panel.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (panelEl && !panelEl.contains(e.target) && !(badgeEl && badgeEl.contains(e.target))) closePanel();
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelEl) closePanel(true);
  });
  window.addEventListener('resize', placePanel);

  /* ---------------- skip notice ---------------- */

  // After a skip the dot widens to "Skipped · Undo" for a few seconds.
  const NOTICE_MS = 6000;
  let notice = null; // { kind, path, title, artist, score }
  let noticeTimer = 0;
  let noticeLeft = 0;
  let noticeStart = 0;

  function showNotice(entry) {
    notice = entry;
    renderBadge();
    armNotice(NOTICE_MS);
  }

  function armNotice(ms) {
    clearTimeout(noticeTimer);
    noticeLeft = ms;
    noticeStart = Date.now();
    noticeTimer = setTimeout(endNotice, ms);
  }

  function endNotice() {
    clearTimeout(noticeTimer);
    if (!notice) return;
    notice = null;
    // Let the label slide back into the dot before swapping the content.
    if (badgeEl) badgeEl.removeAttribute('data-notice');
    setTimeout(renderBadge, 240);
  }

  // Brings a skipped track back and lets it play for the rest of the session.
  function undo(entry) {
    if (!entry) return;
    endNotice();
    allowed.add(entry.path);
    if (entry.kind === 'paused') {
      lastPath = null;
      $('.playControl:not(.playing)')?.click();
      return;
    }
    const prev = $('.skipControl__previous');
    if (!prev) return;
    prev.click();
    // "Previous" restarts the current track once it has played a few seconds; press again if so.
    setTimeout(() => {
      if (currentTrackPath() !== entry.path) $('.skipControl__previous')?.click();
    }, 700);
  }

  /* ---------------- list marking ---------------- */

  // Only uses verdicts already computed while listening — no extra requests.
  const LIST_ITEM = '.soundList__item, .searchList__item, .trackList__item, .queue__itemWrapper, .playableTile, .compactTrackList__item, .soundBadgeList__item';

  function markLists() {
    for (const el of document.querySelectorAll('.sna-flag')) el.remove();
    for (const el of document.querySelectorAll('.sna-dim')) el.classList.remove('sna-dim');
    if (!settings.markLists) return;
    const tpl = document.createElement('template');
    for (const item of document.querySelectorAll(LIST_ITEM)) {
      // The artist link is the one pointing at a single path segment ("/velour02").
      const userLink = [...item.querySelectorAll('a[href^="/"]')].find((a) => /^\/[^/?#]+\/?$/.test(a.getAttribute('href')));
      const permalink = userLink && userLink.getAttribute('href').replace(/\//g, '');
      const verdict = permalink && verdictByPermalink[permalink];
      if (!verdict) continue;
      if (verdict === 'ai') item.classList.add('sna-dim');
      tpl.innerHTML = UI.flagHTML({ scheme, state: verdict });
      userLink.after(tpl.content.firstElementChild);
    }
  }

  // Throttled rather than debounced: the player mutates the DOM constantly.
  let markTimer = 0;
  const scheduleMark = () => {
    if (markTimer) return;
    markTimer = setTimeout(() => {
      markTimer = 0;
      markLists();
    }, 800);
  };

  /* ---------------- boot ---------------- */

  const style = document.createElement('style');
  style.id = 'sna-style';
  style.textContent = UI.CSS;
  document.head.appendChild(style);

  setInterval(tick, 700);
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.closest('.sna')))) scheduleMark();
  }).observe(document.body, { childList: true, subtree: true });
  tick();
  LOG('ready');
})();

/* Ruby Radar: reads data/latest.json + data/samples.json (see dev/DATA-CONTRACT.md).
   Every string from the JSON goes into the page as a text node (h() below); nothing uses innerHTML. */
'use strict';
(function () {
  // ------------------------------------------------------------------ settings
  const REFRESH_MS = 2 * 60 * 1000;
  const TICK_MS = 15 * 1000;
  const MIN_SAMPLES = 12;          // ~6 h of ~30 min leaderboard refreshes before giving a verdict
  const MAX_WINDOW_MIN = 120;      // longer windows are ignored for averages
  const MIN_CELL = 2;              // heatmap cells need this many samples
  const STALE_GENERATED_MIN = 60;   // GitHub cron runs can slip 20–30 min
  const STALE_LEADERBOARD_MIN = 80;  // ~30 min refresh + ~15 min render lag + polling
  const LOW_PCT = 35, HIGH_PCT = 65;
  const LOOKAHEAD_H = 12, MIN_CANDIDATES = 4;
  const GRIND_CAP = 15;
  const GAME_MIN = 30;             // est = count * max(1, 30 / minutes)

  // `units` never break inside; the verdict wraps between them on narrow screens.
  const VERDICTS = {
    go:   { cls: 'v-go',   art: 'verdict-go',    units: ['QUEUE UP'],
            sub: 'Ruby players are a smaller slice of ranked than usual. Good time to go.' },
    flip: { cls: 'v-flip', art: 'verdict-coin',  units: ['COIN FLIP'],
            sub: 'About the usual mix of Ruby players. Your call.' },
    wait: { cls: 'v-wait', art: 'verdict-sweat', units: ['SWEATS', 'ONLINE', '— WAIT'],
            sub: 'More Ruby players than usual are in ranked. Give it a while.' },
  };
  const verdictWords = (v) => v.units.join(' ');

  // Pixel sprites from dev/ART-MANIFEST.md, in docs/art/. The page probes each
  // file and only swaps the CSS placeholder for the sprite once it has loaded.
  const ART = ['radar', 'verdict-go', 'verdict-coin', 'verdict-sweat', 'verdict-calibrating',
    'stale', 'live', 'gem', 'favicon'];

  const METRICS = {
    share: { label: 'Ruby share', diverging: true, lo: 'Safer', mid: 'Typical', hi: 'Sweatier' },
    ruby:  { label: 'Ruby players (est.)', diverging: true, lo: 'Fewer', mid: 'Typical', hi: 'More' },
    all:   { label: 'All ranked (est.)', diverging: false, lo: 'Quieter', hi: 'Busier' },
  };

  // Heatmap colours: stepped bins, not gradients. Diverging (share, Ruby players):
  // safe -> safe-dark -> haze (typical) -> gold -> ruby. Sequential (all ranked):
  // five violet steps. Both checked with the dataviz palette validator
  // (all-pairs colour-blind separation >= 8, single-hue sequential ramp).
  const DIV_BINS = ['var(--safe)', 'var(--safe-dark)', 'var(--haze)', 'var(--gold)', 'var(--ruby)'];
  const SEQ_BINS = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

  // ------------------------------------------------------------------ state
  const state = {
    latest: null, samples: null, samplesError: null,
    error: null, loadedAt: null, loading: false,
    metric: readPref('rr-metric', 'share'),
    showAllGrind: false,
    animated: false, heroKind: null, hour: null,
  };
  if (!METRICS[state.metric]) state.metric = 'share';
  let heat = null;                 // { cells, metric, scale } for the tooltip
  let refreshTimer = null;
  let artProbed = false;

  const $ = (id) => document.getElementById(id);
  const narrow = window.matchMedia('(max-width: 639px)');

  // ------------------------------------------------------------------ DOM helper
  // h('a', { href, class }, 'text', child...) - strings become text nodes.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, String(val));
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  // <span class="sprite s-radar">: sized box; CSS shows the sprite strip once
  // <html> has class art-radar, otherwise a placeholder.
  const sprite = (name, extra = '') => h('span', { class: `sprite s-${name}${extra ? ' ' + extra : ''}`, 'aria-hidden': 'true' });

  function probeArt(retry) {
    const root = document.documentElement;
    for (const name of ART) {
      if (root.classList.contains(`art-${name}`)) continue;
      const img = new Image();
      img.onload = () => {
        root.classList.add(`art-${name}`);
        if (name === 'favicon') {
          const link = document.querySelector('link[rel="icon"]');
          if (link) { link.type = 'image/png'; link.href = 'art/favicon.png'; }
        }
      };
      img.onerror = () => { /* keep the placeholder; try again on the next refresh */ };
      img.src = `art/${name}.png` + (retry ? `?t=${Date.now()}` : '');
    }
  }

  // ------------------------------------------------------------------ formatting
  const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const pf1 = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const int = (n) => nf0.format(n);
  const pct = (x) => pf1.format(x);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const parseTime = (s) => { const ms = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(ms) ? ms : null; };
  const plural = (n, one, many) => `${int(n)} ${n === 1 ? one : (many || one + 's')}`;
  const estFactor = (minutes) => Math.max(1, GAME_MIN / Math.max(minutes, 0.1));

  const HOUR12 = (() => {
    try {
      const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
      return hc ? hc === 'h12' || hc === 'h11' : /[AP]M/i.test(new Date(2024, 0, 1, 15).toLocaleTimeString());
    } catch (e) { return true; }
  })();
  const hourShort = (hr) => HOUR12 ? `${hr % 12 || 12}${hr < 12 ? 'a' : 'p'}` : String(hr).padStart(2, '0');
  const hourLong = (hr) => HOUR12 ? `${hr % 12 || 12} ${hr < 12 ? 'AM' : 'PM'}` : `${String(hr).padStart(2, '0')}:00`;
  // Monday-first weekday names in the viewer's language (2024-01-01 was a Monday).
  const DAYS = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 1 + i)));
  const dayIndex = (d) => (d.getDay() + 6) % 7;
  const shortDate = (ms) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ms));

  function duration(min) {
    min = Math.max(0, Math.round(min));
    if (min < 60) return `${min} min`;
    const hrs = Math.floor(min / 60), rest = min % 60;
    if (hrs < 48) return rest ? `${hrs} h ${rest} min` : `${hrs} h`;
    return plural(Math.round(hrs / 24), 'day');
  }
  function ago(ms) {
    const min = (Date.now() - ms) / 60000;
    if (min < 1) return 'just now';
    return `${duration(min)} ago`;
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function timeZoneLabel() {
    let zone = '', abbr = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* old browser */ }
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
      abbr = part ? part.value : '';
    } catch (e) { /* old browser */ }
    zone = zone.replace(/_/g, ' ');
    if (zone && abbr) return `${zone} (${abbr})`;
    return zone || abbr || 'your local time';
  }

  // Live-updating "x min ago" spans; tick() rewrites them.
  function agoEl(ms, prefix = '', suffix = '') {
    if (ms == null) return h('span', null, prefix + 'unknown' + suffix);
    return h('span', { 'data-ago': ms, 'data-prefix': prefix, 'data-suffix': suffix }, prefix + ago(ms) + suffix);
  }
  function sinceEl(ms, prefix = '') {
    if (ms == null) return null;
    return h('span', { 'data-since': ms, 'data-prefix': prefix }, prefix + duration((Date.now() - ms) / 60000));
  }

  function readPref(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  // ------------------------------------------------------------------ data loading
  // ?data=<base> points at another folder (same origin only), e.g. ?data=../dev/fixture/
  const BASE = (() => {
    const param = new URLSearchParams(location.search).get('data');
    if (param) {
      try {
        const u = new URL(param.endsWith('/') ? param : param + '/', location.href);
        if (u.origin === location.origin) return u;
      } catch (e) { /* fall through to the default */ }
    }
    return new URL('data/', location.href);
  })();

  async function fetchJSON(name) {
    const url = new URL(name, BASE);
    url.searchParams.set('t', String(Date.now()));
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      throw new Error(`couldn’t reach ${name}`);
    }
    if (!res.ok) throw new Error(`${name} returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch (e) {
      throw new Error(`${name} isn’t valid JSON`);
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    clearTimeout(refreshTimer);
    const [latest, samples] = await Promise.allSettled([fetchJSON('latest.json'), fetchJSON('samples.json')]);
    state.loading = false;
    const ok = latest.status === 'fulfilled' && latest.value && typeof latest.value === 'object' && !Array.isArray(latest.value);
    if (ok) {
      state.latest = latest.value;
      state.error = null;
      state.loadedAt = Date.now();
      if (samples.status === 'fulfilled') {
        state.samples = samples.value;
        state.samplesError = null;
      } else {
        state.samplesError = samples.reason.message;   // keep earlier samples if we had them
      }
    } else {
      state.error = latest.status === 'rejected' ? latest.reason.message : 'latest.json has an unexpected shape';
    }
    render();
    probeArt(artProbed);
    artProbed = true;
    refreshTimer = setTimeout(load, REFRESH_MS);
  }

  // ------------------------------------------------------------------ model
  function num(v) { return isNum(v) ? v : null; }

  function parseRows(samples) {
    if (!samples || !Array.isArray(samples.rows)) return [];
    const fields = Array.isArray(samples.fields) ? samples.fields : ['t', 'minutes', 'ruby', 'all', 'steam', 'twitchRuby'];
    const iT = fields.indexOf('t'), iM = fields.indexOf('minutes'), iR = fields.indexOf('ruby'), iA = fields.indexOf('all');
    if (iT < 0 || iM < 0 || iR < 0 || iA < 0) return [];
    const out = [];
    for (const row of samples.rows) {
      if (!Array.isArray(row)) continue;
      const t = num(row[iT]), m = num(row[iM]), r = num(row[iR]), a = num(row[iA]);
      if (t == null || m == null || r == null || a == null) continue;
      out.push({ t, m, r, a });
    }
    out.sort((x, y) => x.t - y.t);
    return out;
  }

  function buildCells(usable) {
    const cells = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, hr) =>
      ({ d, h: hr, n: 0, share: 0, ruby: 0, all: 0 })));
    for (const s of usable) {
      const dt = new Date(s.t * 1000);
      const c = cells[dayIndex(dt)][dt.getHours()];
      const k = estFactor(s.m);
      c.n += 1;
      c.share += s.r / s.a;
      c.ruby += s.r * k;
      c.all += s.a * k;
    }
    for (const row of cells) for (const c of row) {
      if (c.n) { c.share /= c.n; c.ruby /= c.n; c.all /= c.n; }
    }
    return cells;
  }

  function percentileOf(sorted, v) {
    // share of past windows strictly below v, counting ties as half
    let below = 0, equal = 0;
    for (const s of sorted) { if (s < v) below++; else if (s === v) equal++; else break; }
    return (100 * (below + equal / 2)) / sorted.length;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function model() {
    const L = state.latest;
    const now = Date.now();
    const m = { hasData: !!L, L: L || {}, now };
    if (!L) { m.kind = state.loading ? 'loading' : 'error'; return m; }

    const rows = parseRows(state.samples);
    const usable = rows.filter((s) => s.m > 0 && s.m <= MAX_WINDOW_MIN && s.a > 0);
    const shares = usable.map((s) => s.r / s.a).sort((a, b) => a - b);
    m.rows = rows; m.usable = usable; m.shares = shares;
    m.cells = buildCells(usable);
    m.firstT = usable.length ? (usable[0].t - usable[0].m * 60) * 1000 : null;
    m.lastT = usable.length ? usable[usable.length - 1].t * 1000 : null;

    const gen = parseTime(L.generatedAt), lb = parseTime(L.leaderboardUpdatedAt);
    m.gen = gen; m.lb = lb;
    m.genAge = gen != null ? (now - gen) / 60000 : null;
    m.lbAge = lb != null ? (now - lb) / 60000 : null;
    m.staleGen = gen == null || m.genAge > STALE_GENERATED_MIN;
    m.staleLb = lb != null && m.lbAge > STALE_LEADERBOARD_MIN;
    m.stale = m.staleGen || m.staleLb;

    const w = L.window && typeof L.window === 'object' && isNum(L.window.minutes) && L.window.minutes > 0 ? L.window : null;
    m.win = w;
    m.minutes = w ? w.minutes : null;
    m.windowEnd = w ? parseTime(w.to) : null;
    m.ruby = num(L.rubyActive);
    m.all = num(L.allActive);
    m.share = num(L.rubyShare);
    const k = w ? estFactor(w.minutes) : null;
    m.rubyEst = w && m.ruby != null ? m.ruby * k : null;
    m.allEst = w && m.all != null ? m.all * k : null;
    m.pct = m.share != null && shares.length ? percentileOf(shares, m.share) : null;

    const nowDate = new Date(now);
    const here = m.cells[dayIndex(nowDate)][nowDate.getHours()];
    if (here.n >= MIN_CELL) m.typical = { value: here.share, scope: 'at this hour' };
    else if (shares.length >= MIN_SAMPLES) m.typical = { value: quantile(shares, 0.5), scope: 'overall' };
    else m.typical = null;

    const verdict = m.pct == null ? null : m.pct < LOW_PCT ? 'go' : m.pct > HIGH_PCT ? 'wait' : 'flip';
    m.verdict = verdict;
    if (m.stale) m.kind = 'stale';
    else if (!w) m.kind = 'waiting';
    else if (usable.length < MIN_SAMPLES) m.kind = 'calibrating';
    else if (m.share == null) m.kind = 'quiet';
    else m.kind = verdict;

    m.next = usable.length >= MIN_SAMPLES ? nextWindow(m.cells, nowDate) : null;
    return m;
  }

  function nextWindow(cells, nowDate) {
    const candidates = [];
    for (let i = 1; i <= LOOKAHEAD_H; i++) {
      const start = new Date(nowDate.getTime() + i * 3600 * 1000);
      start.setMinutes(0, 0, 0);
      const c = cells[dayIndex(start)][start.getHours()];
      if (c.n >= MIN_CELL) candidates.push({ c, start });
    }
    if (candidates.length < MIN_CANDIDATES) return null;
    candidates.sort((a, b) => a.c.share - b.c.share);
    const best = candidates[0];
    return { day: best.c.d, hour: best.c.h, value: best.c.share, n: best.c.n, start: best.start.getTime() };
  }

  // ------------------------------------------------------------------ render: page chrome
  function render() {
    const m = model();
    state.hour = new Date().getHours();
    state.heroKind = m.kind;
    renderOnAir(m);
    renderBanner();
    renderHero(m);
    renderNext(m);
    renderTwitch(m);
    renderHeat(m);
    renderGrind(m);
    renderFooter(m);
  }

  function renderOnAir(m) {
    const el = $('onair');
    let cls = 'onair', text, mark = h('span', { class: 'dot', 'aria-hidden': 'true' });
    if (!m.hasData) { cls += ' err'; text = h('span', null, state.loading ? 'Tuning in…' : 'No signal'); }
    else if (m.stale) { cls += ' stale'; mark = sprite('stale'); text = agoEl(m.gen, 'Stale: updated '); }
    else { text = agoEl(m.gen, 'Updated '); }
    el.className = cls;
    el.replaceChildren(mark, text);
  }

  function retryButton(label = 'Try again') {
    return h('button', { class: 'btn', type: 'button', onclick: () => load() }, label);
  }

  function renderBanner() {
    const el = $('banner');
    if (state.error && state.latest) {
      el.hidden = false;
      el.replaceChildren(h('p', null,
        `Couldn’t refresh: ${state.error}. Showing the data that loaded `, agoEl(state.loadedAt), '. '),
        retryButton());
    } else {
      el.hidden = true;
      el.replaceChildren();
    }
  }

  // ------------------------------------------------------------------ render: hero
  function slab(cls, art, units, sub) {
    const longest = Math.max(...units.map((s) => s.length)) + 1;   // +1 for the cursor
    const words = [];
    units.forEach((u, i) => { if (i) words.push(' '); words.push(h('span', { class: 'unit' }, u)); });
    return h('div', { class: `slab ${cls}` },
      h('div', { class: 'slab-art' }, sprite(art, 'big')),
      h('div', { class: 'slab-text' },
        h('p', { class: 'verdict', vars: { '--chars': longest } }, words, h('span', { class: 'cursor', 'aria-hidden': 'true' })),
        sub ? h('p', { class: 'slab-sub' }, sub) : null));
  }

  function nowLine(m, withTypical = true) {
    // "About 42 Ruby players in ranked (4.6% of active top-10k players). Usually 2.9% at this hour."
    const parts = [];
    if (m.rubyEst != null) {
      // "About" rather than "~": the pixel font's tilde reads like a minus sign.
      parts.push(`About ${int(m.rubyEst)} Ruby ${m.rubyEst === 1 ? 'player' : 'players'} in ranked`);
      if (m.share != null) parts.push(` (${pct(m.share)} of active top-10k players)`);
      parts.push('.');
    }
    if (withTypical && m.typical) parts.push(` Usually ${pct(m.typical.value)} ${m.typical.scope}.`);
    return parts.join('');
  }

  function windowMeta(m) {
    const bits = [];
    const asOf = m.windowEnd != null ? m.windowEnd : m.lb;
    bits.push(agoEl(asOf, 'As of '));
    if (m.win) {
      bits.push(`, from a ${duration(m.minutes)} window: ${int(m.ruby || 0)} Ruby of ${int(m.all || 0)} players finished a game.`);
    } else bits.push('.');
    return bits;
  }

  function lowerThird(main, meta) {
    return h('div', { class: 'l3' },
      main ? h('p', { class: 'l3-main' }, main) : null,
      meta ? h('p', { class: 'l3-meta' }, meta) : null);
  }

  // A 20-block power bar: each block is 5 percentile points, lit up to "now".
  function meter(m) {
    const p = Math.max(0, Math.min(100, m.pct));
    const r = Math.round(p);
    const lit = Math.max(1, Math.ceil(p / 5));
    const blocks = [];
    for (let i = 0; i < 20; i++) {
      const zone = i < 7 ? 'go' : i < 13 ? 'flip' : 'wait';
      blocks.push(h('i', { class: `seg-b z-${zone}${i < lit ? ' lit' : ''}`, vars: { '--i': i } }));
    }
    const bar = h('div', { class: `meter-bar${state.animated ? '' : ' enter'}`, role: 'img',
      'aria-label': `Ruby share percentile ${r} out of 100. Below 35 is a good time, above 65 means wait.` },
      blocks, h('b', { class: `meter-mark${lit <= 3 ? ' edge-l' : lit >= 18 ? ' edge-r' : ''}`, vars: { '--at': `${(lit - 0.5) * 5}%` } }, `${ordinal(r)} pct`));
    const zone = (key, label) => h('span', { class: `zl z-${key}${m.verdict === key ? ' on' : ''}` }, label);
    return h('div', { class: 'meter' }, bar,
      h('div', { class: 'meter-zones', 'aria-hidden': 'true' }, zone('go', 'Queue up'), zone('flip', 'Coin flip'), zone('wait', 'Wait')),
      h('p', { class: 'meter-cap' },
        `Ruby share is higher than in ${r}% of the ${int(m.shares.length)} windows recorded since ${shortDate(m.firstT)}.`));
  }

  function collected(m) {
    const n = m.usable.length;
    const spanMin = m.firstT != null ? (m.lastT - m.firstT) / 60000 : 0;
    const blocks = [];
    for (let i = 0; i < MIN_SAMPLES; i++) blocks.push(h('i', { class: i < n ? 'on' : null }));
    return h('div', { class: 'progress' },
      h('p', { class: 'progress-label', 'aria-hidden': 'true' }, `Loading ${Math.min(n, MIN_SAMPLES)}/${MIN_SAMPLES}`),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': MIN_SAMPLES,
        'aria-valuenow': Math.min(n, MIN_SAMPLES), 'aria-label': 'Windows collected' }, blocks),
      h('p', null,
        n ? `${int(n)} of ${MIN_SAMPLES} windows so far (${duration(spanMin)} of data). ` : 'No windows recorded yet. ',
        'The verdict switches on after about 6 hours; the heatmap gets reliable after about 7 days.'));
  }

  function renderHero(m) {
    const hero = $('hero');
    hero.dataset.kind = m.kind;
    const kids = [];
    if (m.kind === 'loading') {
      kids.push(slab('v-cal', 'verdict-calibrating', ['TUNING IN'], 'Loading the latest numbers…'));
    } else if (m.kind === 'error') {
      kids.push(slab('v-err', 'stale', ['CAN’T LOAD', 'DATA'], `Couldn’t load the numbers: ${state.error || 'unknown error'}.`));
      kids.push(lowerThird('This page checks again every 2 minutes.', null));
      kids.push(h('p', { class: 'hero-actions' }, retryButton()));
    } else if (m.kind === 'stale') {
      const why = [];
      if (m.staleGen) why.push(m.gen != null ? `The collector last ran ${ago(m.gen)}.` : 'The data has no timestamp.');
      if (m.staleLb) why.push(`Embark’s leaderboard last refreshed ${ago(m.lb)}.`);
      kids.push(slab('v-stale', 'stale', ['DATA IS', 'STALE'], `No fresh numbers, so no verdict. ${why.join(' ')}`));
      let last = nowLine(m, false);
      if (last && m.verdict && m.usable.length >= MIN_SAMPLES) {
        const word = verdictWords(VERDICTS[m.verdict]).replace(' — ', ', ');
        last += ` Back then that was ${word}.`;
      }
      kids.push(lowerThird(last ? `Last reading: ${last}` : null, windowMeta(m)));
    } else if (m.kind === 'waiting' || m.kind === 'calibrating') {
      const sub = m.kind === 'waiting'
        ? 'Waiting for a second leaderboard refresh to compare against. Embark refreshes about every 30 minutes.'
        : 'Collecting data before calling it. Here’s the raw count from the latest window.';
      kids.push(slab('v-cal', 'verdict-calibrating', ['CALIBRATING'], sub));
      if (m.kind === 'calibrating') {
        const raw = [];
        if (m.rubyEst != null) raw.push(`About ${int(m.rubyEst)} Ruby players in ranked`);
        if (m.share != null) raw.push(` (${pct(m.share)} of active top-10k players)`);
        kids.push(lowerThird(raw.length ? raw.join('') + '.' : null, windowMeta(m)));
      }
      kids.push(collected(m));
    } else if (m.kind === 'quiet') {
      kids.push(slab('v-cal', 'verdict-calibrating', ['NO GAMES', 'SEEN'], 'Nobody in the top 10k finished a ranked game in the latest window, so there’s nothing to compare. This usually clears up on the next check.'));
      kids.push(lowerThird(null, windowMeta(m)));
    } else {
      const v = VERDICTS[m.kind];
      kids.push(slab(v.cls, v.art, v.units, v.sub));
      kids.push(lowerThird(nowLine(m), windowMeta(m)));
      kids.push(meter(m));
      state.animated = true;
    }
    if (state.samplesError && m.hasData) {
      kids.push(h('p', { class: 'hero-note' }, `History didn’t load (${state.samplesError}), so the verdict may be missing.`));
    }
    hero.replaceChildren(...kids);
  }

  // ------------------------------------------------------------------ render: next good window
  function renderNext(m) {
    const sec = $('window');
    const nx = m.hasData ? m.next : null;
    if (!nx) { sec.hidden = true; sec.replaceChildren(); return; }
    sec.hidden = false;
    const startsIn = duration((nx.start - Date.now()) / 60000);
    let extra = `Starts in ${startsIn}. Based on ${plural(nx.n, 'sample')}.`;
    if (m.share != null && !m.stale && m.win && m.share <= nx.value) extra += ` Right now (${pct(m.share)}) is already lower.`;
    sec.replaceChildren(h('div', { class: 'strip' },
      h('p', { class: 'strip-tag' }, 'Best bet in the next 12h'),
      h('div', { class: 'strip-body' },
        h('p', { class: 'strip-main' }, h('strong', null, `${hourLong(nx.hour)} ${DAYS[nx.day]}`), ` — Ruby share usually ${pct(nx.value)}`),
        h('p', { class: 'strip-meta' }, extra))));
  }

  // ------------------------------------------------------------------ render: Twitch
  const LOGIN_RE = /^[A-Za-z0-9_]{1,25}$/;
  const twitchUrl = (login) => (typeof login === 'string' && LOGIN_RE.test(login) ? `https://www.twitch.tv/${login}` : null);
  function thumbUrl(t) {
    if (typeof t !== 'string' || !/^https:\/\//.test(t)) return null;
    return t.replace('{width}', '480').replace('{height}', '270');
  }
  function linkOrDiv(href, cls, kids, label) {
    return href
      ? h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label }, kids)
      : h('div', { class: cls }, kids);
  }
  const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  function sectionHead(id, title, tag, art) {
    return h('div', { class: 'sh' },
      h('h2', { id }, art ? sprite(art, 'sh-art') : null, title),
      tag ? h('p', { class: 'sh-tag' }, tag) : null);
  }

  function streamCard(s) {
    const href = twitchUrl(s.login);
    const name = text(s.displayName) || text(s.login) || 'Unknown streamer';
    const thumb = thumbUrl(s.thumbnail);
    const kids = [
      h('div', { class: 'mon' },
        thumb ? h('img', { src: thumb, alt: '', width: 480, height: 270, loading: 'lazy', decoding: 'async',
          referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
        h('span', { class: 'mon-rank' }, sprite('gem'), isNum(s.rank) ? `#${s.rank}` : 'Ruby'),
        h('span', { class: 'mon-live' }, sprite('live'), sinceEl(parseTime(s.startedAt), 'Live for ') || 'Live'),
        isNum(s.viewers) ? h('span', { class: 'mon-view' }, `${int(s.viewers)} watching`) : null),
      h('div', { class: 'card-body' },
        h('p', { class: 'card-name' }, name),
        s.name ? h('p', { class: 'card-lb' }, text(s.name), s.matchedBy === 'alias' ? ' (matched by alias)' : '') : null,
        s.title ? h('p', { class: 'card-title' }, text(s.title)) : null),
    ];
    return h('li', null, linkOrDiv(href, 'card', kids, href ? `${name} on Twitch, opens in a new tab` : null));
  }

  function renderTwitch(m) {
    const sec = $('twitch');
    if (!m.hasData) { sec.hidden = true; return; }
    sec.hidden = false;
    const tw = m.L.twitch && typeof m.L.twitch === 'object' ? m.L.twitch : null;
    if (!tw || !tw.enabled) {
      sec.replaceChildren(sectionHead('twitch-h', 'Live on Twitch', null, 'live'),
        h('p', { class: 'note coin' }, h('span', { class: 'coin-tag' }, 'Insert coin'),
          h('span', null, 'Twitch check is off — add ', h('code', null, 'TWITCH_CLIENT_ID'), ' and ',
            h('code', null, 'TWITCH_CLIENT_SECRET'), ' repo secrets to turn it on.')));
      return;
    }
    const live = (Array.isArray(tw.rubyLive) ? tw.rubyLive : []).filter((s) => s && typeof s === 'object')
      .slice().sort((a, b) => (isNum(a.rank) ? a.rank : 1e9) - (isNum(b.rank) ? b.rank : 1e9));
    const mentions = (Array.isArray(tw.titleMentions) ? tw.titleMentions : []).filter((s) => s && typeof s === 'object');
    const failed = typeof tw.error === 'string' && tw.error;
    const tag = failed ? 'Check failed' : live.length ? `${plural(live.length, 'Ruby player')} live` : 'No Ruby players live';
    const kids = [sectionHead('twitch-h', 'Live on Twitch', tag, 'live')];
    if (failed) kids.push(h('p', { class: 'empty' }, `Couldn’t reach Twitch on the last check (${text(tw.error)}). It retries every run.`));
    else if (live.length) kids.push(h('ul', { class: 'cards' }, live.map(streamCard)));
    else kids.push(h('p', { class: 'empty' }, 'None of the top 500 are streaming right now.'));

    if (mentions.length) {
      kids.push(h('h3', { class: 'sub-h' }, 'Titles mentioning Ruby or top 500'));
      kids.push(h('ul', { class: 'mentions' }, mentions.map((s) => {
        const href = twitchUrl(s.login);
        const name = text(s.displayName) || text(s.login) || 'Unknown';
        return h('li', null, linkOrDiv(href, 'mention', [
          h('span', { class: 'mn-name' }, name),
          h('span', { class: 'mn-title' }, text(s.title)),
          isNum(s.viewers) ? h('span', { class: 'mn-view' }, `${int(s.viewers)} watching`) : null,
        ], href ? `${name} on Twitch: ${text(s.title)}. Opens in a new tab` : null));
      })));
    }
    const foot = [];
    if (isNum(tw.totalStreams)) foot.push(`${plural(tw.totalStreams, 'THE FINALS stream')} live. `);
    const checked = parseTime(tw.checkedAt);
    if (checked != null) foot.push(agoEl(checked, 'Checked ', '.'));
    if (foot.length) kids.push(h('p', { class: 'tw-total' }, foot));
    sec.replaceChildren(...kids);
  }

  // ------------------------------------------------------------------ render: heatmap
  const cellValue = (c, metric) => c[metric];
  function formatValue(v, metric) {
    if (metric === 'share') return pct(v);
    return int(v);   // the metric label already says "est." (and the pixel font's ~ looks like a minus)
  }

  function makeScale(metric, values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const robust = sorted.length >= 12;
    const mid = quantile(sorted, 0.5);
    // Clip outliers, and never stretch the colours over less than +/-25% of the
    // median, so a handful of early cells doesn't look like a dramatic pattern.
    const lo = Math.min(robust ? quantile(sorted, 0.05) : sorted[0], mid * 0.75);
    const hi = Math.max(robust ? quantile(sorted, 0.95) : sorted[sorted.length - 1], mid * 1.25);
    const def = METRICS[metric];
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    let bin, bins;
    if (def.diverging) {
      // t runs -1 (at/below lo) .. 0 (median) .. +1 (at/above hi); five equal steps
      bins = DIV_BINS;
      bin = (v) => {
        const t = v < mid ? -(mid > lo ? (mid - v) / (mid - lo) : 0) : (hi > mid ? (v - mid) / (hi - mid) : 0);
        return clamp(Math.round(clamp(t, -1, 1) * 2) + 2, 0, 4);
      };
    } else {
      bins = SEQ_BINS;
      bin = (v) => clamp(Math.floor((hi > lo ? (v - lo) / (hi - lo) : 0.5) * 5), 0, 4);
    }
    return { lo, mid, hi, bin, bins, color: (v) => bins[bin(v)], def };
  }

  function place(el, wc, wr, nc, nr) {
    el.style.setProperty('--wc', wc); el.style.setProperty('--wr', wr);
    el.style.setProperty('--nc', nc); el.style.setProperty('--nr', nr);
    return el;
  }

  function cellLabel(c, metric) {
    const when = `${DAYS[c.d]} ${hourLong(c.h)}`;
    if (c.n < MIN_CELL) return `${when}: not enough data (${plural(c.n, 'sample')})`;
    return `${when}: ${METRICS[metric].label} ${formatValue(cellValue(c, metric), metric)} average, ${plural(c.n, 'sample')}`;
  }

  function renderHeat(m) {
    const sec = $('heat');
    if (!m.hasData) { sec.hidden = true; return; }
    sec.hidden = false;
    const metric = state.metric;
    const values = [];
    for (const row of m.cells) for (const c of row) if (c.n >= MIN_CELL) values.push(cellValue(c, metric));
    const scale = makeScale(metric, values);
    heat = { cells: m.cells, metric, scale };

    const nowDate = new Date();
    const today = dayIndex(nowDate), thisHour = nowDate.getHours();

    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Heatmap metric' },
      Object.entries(METRICS).map(([key, def]) => h('button', {
        type: 'button', 'aria-pressed': key === metric ? 'true' : 'false',
        onclick: () => {
          if (state.metric === key) return;
          state.metric = key;
          writePref('rr-metric', key);
          renderHeat(model());
          const btn = $('heat').querySelector(`.seg button[data-key="${key}"]`);
          if (btn) btn.focus();
        },
        'data-key': key,
      }, def.label)));

    const grid = h('div', { class: 'hm', role: 'group', 'aria-label': `Heatmap of ${METRICS[metric].label} by weekday and hour` });
    grid.append(place(h('span', { class: 'corner' }), 1, 1, 1, 1));
    for (let hr = 0; hr < 24; hr++) {
      grid.append(place(h('span', { class: `hl${hr % 2 ? ' odd' : ''}${hr === thisHour ? ' cur' : ''}`, 'aria-hidden': 'true' }, hourShort(hr)), hr + 2, 1, 1, hr + 2));
    }
    for (let d = 0; d < 7; d++) {
      grid.append(place(h('span', { class: `dl${d === today ? ' cur' : ''}`, 'aria-hidden': 'true' }, DAYS[d]), 1, d + 2, d + 2, 1));
    }
    for (let d = 0; d < 7; d++) {
      for (let hr = 0; hr < 24; hr++) {
        const c = m.cells[d][hr];
        const enough = c.n >= MIN_CELL && scale;
        const isNow = d === today && hr === thisHour;
        const btn = h('button', {
          type: 'button', class: `c${enough ? '' : ' empty'}${isNow ? ' now' : ''}`,
          tabindex: isNow ? '0' : '-1', 'data-d': d, 'data-h': hr,
          'aria-label': cellLabel(c, metric) + (isNow ? ' (now)' : ''),
        });
        if (enough) btn.style.setProperty('--fill', scale.color(cellValue(c, metric)));
        grid.append(place(btn, hr + 2, d + 2, d + 2, hr + 2));
      }
    }
    wireGrid(grid);
    const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
    const wrap = h('div', { class: 'hm-wrap' }, grid, tip);

    const kids = [sectionHead('heat-h', 'Ruby traffic by hour', `Your time: ${timeZoneLabel()}`), seg, wrap];
    kids.push(legend(scale, metric));
    const spanMin = m.firstT != null ? (m.lastT - m.firstT) / 60000 : 0;
    kids.push(h('p', { class: 'note' }, m.usable.length
      ? `Built from ${plural(m.usable.length, 'window')} over ${duration(spanMin)}. Each square averages the windows that ended in that hour. Hover or tap a square for details.`
      : 'No windows recorded yet. Squares fill in as data arrives, and the pattern gets reliable after about 7 days.'));
    sec.replaceChildren(...kids);
  }

  function legend(scale, metric) {
    const keys = h('div', { class: 'lg-keys' },
      h('span', { class: 'lg-key' }, h('i', { class: 'sw empty', 'aria-hidden': 'true' }), 'Fewer than 2 samples'),
      h('span', { class: 'lg-key' }, h('i', { class: 'sw now', 'aria-hidden': 'true' }), 'Now'));
    if (!scale) return h('div', { class: 'legend' }, keys);
    const def = scale.def;
    const labels = def.diverging
      ? [h('span', null, def.lo, h('b', null, formatValue(scale.lo, metric))),
         h('span', null, def.mid, h('b', null, formatValue(scale.mid, metric))),
         h('span', null, def.hi, h('b', null, formatValue(scale.hi, metric)))]
      : [h('span', null, def.lo, h('b', null, formatValue(scale.lo, metric))),
         h('span', null, def.hi, h('b', null, formatValue(scale.hi, metric)))];
    const bar = h('div', { class: 'lg-bar', 'aria-hidden': 'true' },
      scale.bins.map((c) => h('i', { vars: { '--fill': c } })));
    return h('div', { class: 'legend' },
      h('div', { class: 'lg-scale' }, bar, h('div', { class: 'lg-labels' }, labels)), keys);
  }

  function showTip(cell) {
    if (!heat) return;
    const wrap = cell.closest('.hm-wrap');
    const tip = wrap && wrap.querySelector('.tip');
    if (!tip) return;
    const c = heat.cells[+cell.dataset.d][+cell.dataset.h];
    const def = METRICS[heat.metric];
    const enough = c.n >= MIN_CELL && heat.scale;
    tip.replaceChildren(
      h('strong', null, `${DAYS[c.d]} ${hourLong(c.h)}`),
      enough
        ? h('span', null, `${def.label}: ${formatValue(cellValue(c, heat.metric), heat.metric)} avg`)
        : h('span', null, 'Not enough data yet'),
      h('span', { class: 'tip-n' }, plural(c.n, 'sample')));
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = cr.left - wr.left + cr.width / 2 - tw / 2;
    x = Math.max(0, Math.min(wr.width - tw, x));
    let y = cr.top - wr.top - th - 8;
    if (y < 0) y = cr.bottom - wr.top + 8;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function hideTip() {
    const tip = document.querySelector('#heat .tip');
    if (tip) tip.hidden = true;
  }

  function wireGrid(grid) {
    grid.addEventListener('pointerover', (e) => {
      const c = e.target.closest('.c');
      if (c) showTip(c);
    });
    grid.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !grid.contains(document.activeElement)) hideTip();
    });
    grid.addEventListener('click', (e) => {
      const c = e.target.closest('.c');
      if (c) showTip(c);
    });
    grid.addEventListener('focusin', (e) => {
      const c = e.target.closest('.c');
      if (c) showTip(c);
    });
    grid.addEventListener('focusout', (e) => {
      if (!grid.contains(e.relatedTarget)) hideTip();
    });
    grid.addEventListener('keydown', (e) => {
      const c = e.target.closest('.c');
      if (!c) return;
      if (e.key === 'Escape') { hideTip(); return; }
      const wide = !narrow.matches;
      const moves = wide
        ? { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }
        : { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const mv = moves[e.key];
      if (!mv) return;
      e.preventDefault();
      const d = (+c.dataset.d + mv[0] + 7) % 7, hr = (+c.dataset.h + mv[1] + 24) % 24;
      const next = grid.querySelector(`.c[data-d="${d}"][data-h="${hr}"]`);
      if (!next) return;
      c.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.hm')) hideTip();
  });

  // ------------------------------------------------------------------ render: grinding
  function renderGrind(m) {
    const sec = $('grind');
    if (!m.hasData) { sec.hidden = true; return; }
    sec.hidden = false;
    const list = (Array.isArray(m.L.grinding) ? m.L.grinding : []).filter((g) => g && typeof g === 'object')
      .slice().sort((a, b) => (isNum(a.rank) ? a.rank : 1e9) - (isNum(b.rank) ? b.rank : 1e9));
    const tag = m.win
      ? `${plural(list.length, 'Ruby player')} finished a game in the last ${duration(m.minutes)}`
      : 'Waiting for the first window';
    const kids = [sectionHead('grind-h', 'Who’s grinding', tag)];
    if (!list.length) {
      kids.push(h('p', { class: 'empty' }, m.win
        ? 'No Ruby players finished a ranked game in this window.'
        : 'The list shows up after the collector has seen two leaderboard refreshes.'));
      sec.replaceChildren(...kids);
      return;
    }
    const shown = state.showAllGrind ? list : list.slice(0, GRIND_CAP);
    kids.push(h('ol', { class: 'board' }, shown.map((g) => {
      const name = text(g.name) || 'Unknown';
      const href = twitchUrl(g.twitch);
      const delta = isNum(g.delta) ? g.delta : null;
      return h('li', { class: 'row' },
        h('span', { class: 'rk' }, sprite('gem'), isNum(g.rank) ? `#${g.rank}` : '?'),
        h('span', { class: 'nm' },
          h('span', { class: 'nm-text' }, name),
          g.club ? h('span', { class: 'club', title: 'Club tag' }, text(g.club)) : null),
        href ? h('a', { class: 'tw', href, target: '_blank', rel: 'noopener noreferrer',
          'aria-label': `Watch ${name} live on Twitch (opens in a new tab)` }, sprite('live'), 'Live') : h('span'),
        h('span', { class: `delta${delta != null && delta < 0 ? ' down' : ''}`, title: 'Rank score change this window' },
          delta == null ? '' : delta > 0 ? `+${int(delta)}` : delta < 0 ? `−${int(-delta)}` : '±0'));
    })));
    if (list.length > GRIND_CAP) {
      kids.push(h('p', { class: 'more' }, h('button', {
        class: 'btn ghost', type: 'button', 'aria-expanded': state.showAllGrind ? 'true' : 'false',
        onclick: () => {
          state.showAllGrind = !state.showAllGrind;
          renderGrind(model());
          const again = document.querySelector('#grind .more button');
          if (again) again.focus();
        },
      }, state.showAllGrind ? `Show top ${GRIND_CAP}` : `Show all ${int(list.length)}`)));
    }
    sec.replaceChildren(...kids);
  }

  // ------------------------------------------------------------------ render: footer
  function renderFooter(m) {
    const steam = $('steam');
    const n = m.hasData ? num(m.L.steamPlayers) : null;
    steam.textContent = n != null
      ? `${int(n)} people playing THE FINALS on Steam right now (all modes).`
      : 'Steam player count unavailable right now.';
    const season = $('season');
    const s = m.hasData && typeof m.L.season === 'string' ? m.L.season.match(/^s(\d+)$/i) : null;
    season.textContent = s ? `Season ${s[1]} ranked leaderboard.` : '';
    season.hidden = !s;
  }

  // ------------------------------------------------------------------ clock
  function tick() {
    document.querySelectorAll('[data-ago]').forEach((el) => {
      el.textContent = (el.dataset.prefix || '') + ago(+el.dataset.ago) + (el.dataset.suffix || '');
    });
    document.querySelectorAll('[data-since]').forEach((el) => {
      el.textContent = (el.dataset.prefix || '') + duration((Date.now() - +el.dataset.since) / 60000);
    });
    // Re-render when the hour rolls over or the data goes stale while the page sits open.
    if (state.latest && (new Date().getHours() !== state.hour || model().kind !== state.heroKind)) render();
  }

  setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!state.loadedAt || Date.now() - state.loadedAt > REFRESH_MS)) load();
  });
  load();
})();

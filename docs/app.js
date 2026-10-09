/* Ruby Radar: reads data/latest.json + data/samples.json, and talks to the squad's
   lobby log API at window.RUBY_RADAR_API (config.js). See dev/DATA-CONTRACT.md.
   Every string from the JSON or the API goes into the page as a text node (h() below);
   nothing uses innerHTML. */
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
  // lobby log
  const UNDO_MS = 10 * 1000;       // how long "LOGGED!" offers Undo
  const NOTE_MS = 8 * 1000;        // how long other lobby messages stay up
  const API_TIMEOUT_MS = 12 * 1000;
  const NAME_MAX = 24;
  const LOG_SHOWN = 8;             // recent taps listed in "Your lobbies"
  const MEANINGFUL_TAPS = 10;      // fewer than this: "gets meaningful after a couple of weeks"

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

  // What a lobby tap records as "the verdict the page showed" (POST /api/lobby `verdict`).
  // "waiting" (no second refresh yet) is drawn as CALIBRATING, so it's logged as that;
  // loading, error and "no games seen" show no verdict at all.
  const TAP_VERDICT = { go: 'queue', flip: 'coin', wait: 'wait', calibrating: 'calibrating', waiting: 'calibrating', stale: 'stale' };
  // How logged verdicts read back in "Your lobbies", in table order.
  const LOGGED = {
    queue:       { label: 'QUEUE UP',    cls: 'go' },
    coin:        { label: 'COIN FLIP',   cls: 'flip' },
    wait:        { label: 'WAIT',        cls: 'wait' },
    calibrating: { label: 'CALIBRATING', cls: 'cal' },
    stale:       { label: 'STALE',       cls: 'other' },
    unknown:     { label: 'NO VERDICT',  cls: 'other' },
  };
  const loggedVerdict = (v) => LOGGED[v] || { label: text(v).toUpperCase().slice(0, 16) || '?', cls: 'other' };

  // Pixel sprites from dev/ART-MANIFEST.md, in docs/art/. The page probes each
  // file and only swaps the CSS placeholder for the sprite once it has loaded.
  const ART = ['radar', 'verdict-go', 'verdict-coin', 'verdict-sweat', 'verdict-calibrating',
    'stale', 'live', 'gem', 'favicon'];

  const METRICS = {
    share: { label: 'Ruby share', diverging: true, lo: 'Safer', mid: 'Typical', hi: 'Sweatier' },
    ruby:  { label: 'Ruby players (est.)', diverging: true, lo: 'Fewer', mid: 'Typical', hi: 'More' },
    all:   { label: 'Top 10k (est.)', diverging: false, lo: 'Quieter', hi: 'Busier' },
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
    view: ['am', 'global'].includes(readPref('rr-view', '')) ? readPref('rr-view', '') : null,   // null = not chosen yet
    showAllGrind: false, howOpen: false,
    animated: false, heroKind: null, hour: null,
    shown: null,                   // what the hero shows right now, for lobby taps
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

  // Sections that re-render while someone may be using them mark their controls with
  // data-focus="<fixed key>", so focus can come back to the same control afterwards.
  function focusKey(root) {
    const el = document.activeElement;
    return el && el !== document.body && root.contains(el) && el.dataset ? el.dataset.focus || null : null;
  }
  function restoreFocus(root, key) {
    const el = key ? root.querySelector(`[data-focus="${key}"]`) : null;
    if (el && !el.disabled) el.focus();
  }

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
  const pf0 = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
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
  function forgetPref(key) {
    try { localStorage.removeItem(key); } catch (e) { /* private mode */ }
  }

  // ------------------------------------------------------------------ data loading
  // ?data=<base> points at another folder (same origin only), e.g. ?data=../dev/fixture/
  // On the live site the repo's raw files come first: they update within minutes of each
  // data commit, even when a GitHub Pages deploy is stuck. The Pages copy is the fallback.
  const RAW_DATA = 'https://raw.githubusercontent.com/natanforestree/finals-radar/main/docs/data/';
  const BASES = (() => {
    const param = new URLSearchParams(location.search).get('data');
    if (param) {
      try {
        const u = new URL(param.endsWith('/') ? param : param + '/', location.href);
        if (u.origin === location.origin) return [u];
      } catch (e) { /* fall through to the default */ }
    }
    const pages = new URL('data/', location.href);
    return location.hostname.endsWith('github.io') ? [new URL(RAW_DATA), pages] : [pages];
  })();

  async function fetchJSON(name) {
    let lastError;
    for (const base of BASES) {
      try {
        return await fetchFrom(base, name);
      } catch (e) {
        lastError = e;   // try the next place
      }
    }
    throw lastError;
  }

  async function fetchFrom(base, name) {
    const url = new URL(name, base);
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
    loadLobbies();                     // the squad's log refreshes on the same 2-minute beat
    refreshTimer = setTimeout(load, REFRESH_MS);
  }

  // ------------------------------------------------------------------ model
  function num(v) { return isNum(v) ? v : null; }

  // Rows as { t, m, r, a, ar, aa }: r/a = Ruby/all, ar/aa = Americas Ruby/all.
  // Rows from before regions existed have null (or no) regional fields.
  function parseRows(samples) {
    if (!samples || !Array.isArray(samples.rows)) return [];
    const fields = Array.isArray(samples.fields) ? samples.fields : ['t', 'minutes', 'ruby', 'all', 'steam', 'twitchRuby'];
    const iT = fields.indexOf('t'), iM = fields.indexOf('minutes'), iR = fields.indexOf('ruby'), iA = fields.indexOf('all');
    const iAR = fields.indexOf('amRuby'), iAA = fields.indexOf('amAll');
    if (iT < 0 || iM < 0 || iR < 0 || iA < 0) return [];
    const at = (row, i) => (i < 0 ? null : num(row[i]));
    const out = [];
    for (const row of samples.rows) {
      if (!Array.isArray(row)) continue;
      const t = num(row[iT]), m = num(row[iM]);
      if (t == null || m == null) continue;
      out.push({ t, m, r: at(row, iR), a: at(row, iA), ar: at(row, iAR), aa: at(row, iAA) });
    }
    out.sort((x, y) => x.t - y.t);
    return out;
  }

  // latest.regions, or null when it's missing / null (no region detection: the page acts as before).
  function parseRegions(L) {
    const R = L.regions;
    if (!R || typeof R !== 'object' || Array.isArray(R)) return null;
    const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : null);
    const pair = (o) => (obj(o) ? { ruby: num(o.ruby), all: num(o.all) } : null);
    const placed = obj(R.placed) || {}, by = obj(R.rubyByRegion) || {}, win = obj(R.window);
    return {
      ready: R.ready === true,
      placedRuby: num(placed.ruby),
      by: { am: num(by.am), eu: num(by.eu), ap: num(by.ap) },
      win: win ? { am: pair(win.am), unplaced: pair(win.unplaced) } : null,
    };
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

    // View: "am" (Americas share, amRuby/amAll) or "global". Without regions it's always global.
    const reg = parseRegions(L);
    m.reg = reg;
    m.view = reg ? (state.view || (reg.ready ? 'am' : 'global')) : 'global';
    m.am = m.view === 'am';

    const rows = parseRows(state.samples);
    const inRange = (s) => s.m > 0 && s.m <= MAX_WINDOW_MIN;
    const usable = m.am
      ? rows.filter((s) => inRange(s) && s.ar != null && s.aa != null && s.aa > 0).map((s) => ({ t: s.t, m: s.m, r: s.ar, a: s.aa }))
      : rows.filter((s) => inRange(s) && s.r != null && s.a != null && s.a > 0);
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
    // "Now" numbers: global from the top-level fields, Americas from regions.window.am.
    const amNow = reg && reg.win ? reg.win.am : null;
    const amRuby = amNow ? amNow.ruby : null, amAll = amNow ? amNow.all : null;
    m.globalShare = num(L.rubyShare);
    m.amShare = amRuby != null && amAll != null && amAll > 0 ? amRuby / amAll : null;
    m.unplaced = reg && reg.win && reg.win.unplaced ? reg.win.unplaced.all : null;
    m.ruby = m.am ? amRuby : num(L.rubyActive);
    m.all = m.am ? amAll : num(L.allActive);
    m.share = m.am ? m.amShare : m.globalShare;
    const k = w ? estFactor(w.minutes) : null;
    m.rubyEst = w && m.ruby != null ? m.ruby * k : null;
    m.allEst = w && m.all != null ? m.all * k : null;
    m.pct = m.share != null && shares.length ? percentileOf(shares, m.share) : null;
    // How busy the top 10k is next to every recorded window (estimated players in ranked).
    // Information only: busy isn't sweaty (a packed evening has more of everyone).
    const allEsts = usable.map((s) => s.a * estFactor(s.m)).sort((a, b) => a - b);
    m.allEsts = allEsts;
    m.allPct = m.allEst != null && allEsts.length ? percentileOf(allEsts, m.allEst) : null;
    m.busy = m.allPct == null ? null : m.allPct < LOW_PCT ? 'quiet' : m.allPct > HIGH_PCT ? 'busy' : 'usual';

    const nowDate = new Date(now);
    const here = m.cells[dayIndex(nowDate)][nowDate.getHours()];
    if (here.n >= MIN_CELL) m.typical = { value: here.share, scope: 'at this hour' };
    else if (shares.length >= MIN_SAMPLES) m.typical = { value: quantile(shares, 0.5), scope: 'overall' };
    else m.typical = null;
    if (here.n >= MIN_CELL) m.typicalAll = { value: here.all, scope: 'at this hour' };
    else if (allEsts.length >= MIN_SAMPLES) m.typicalAll = { value: quantile(allEsts, 0.5), scope: 'overall' };
    else m.typicalAll = null;

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
    state.shown = shownForTap(m);
    renderOnAir(m);
    renderBanner();
    renderViewbar(m);
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

  // ------------------------------------------------------------------ render: view switch
  // Americas / Global, plus how far region placement has got ("Regions" in the contract).
  const REGION_NAMES = [['am', 'Americas'], ['eu', 'Europe'], ['ap', 'Asia-Pacific']];

  function setView(key) {
    writePref('rr-view', key);
    const changed = model().view !== key;
    state.view = key;
    if (!changed) return;
    state.animated = false;            // replay the meter fill for the new numbers
    render();
    restoreFocus($('viewbar'), `view-${key}`);
  }

  function placingLine(reg) {
    // "Placing players by when they play: 312 of 500 Ruby placed · Americas 140 · Europe 150 · Asia-Pacific 22"
    const bits = ['Placing players by when they play: ',
      h('b', null, reg.placedRuby != null ? `${int(reg.placedRuby)} of 500` : 'some'), ' Ruby placed'];
    for (const [key, name] of REGION_NAMES) {
      // the space sits outside the no-wrap span, so the line can break before each region
      if (reg.by[key] != null) bits.push(' ', h('span', { class: 'pl-r' }, `· ${name} ${int(reg.by[key])}`));
    }
    return bits;
  }

  function howPlaced(reg) {
    return h('details', { class: 'how', open: state.howOpen, ontoggle: (e) => { state.howOpen = e.currentTarget.open; } },
      h('summary', { 'data-focus': 'how' }, 'How players are placed'),
      h('div', { class: 'how-body' },
        h('p', null, 'The leaderboard doesn’t say where anyone plays, so the radar works it out from when they play: it notes the hours each player finishes ranked games and matches that pattern to evening-shaped curves for the Americas, Europe and Asia-Pacific.'),
        h('p', null, 'A player is placed once they’ve been seen in at least 5 windows and one region clearly fits, so it takes a few days to fill in. Players who aren’t placed yet are left out of the Americas numbers.'),
        h('p', null, 'North and South America play at the same hours, so they can’t be told apart. Night owls can be misplaced too: a European grinding at 2 AM looks just like an American evening.'),
        h('p', null, reg.ready
          ? 'Enough of the top 500 are placed now, so Americas is the default view.'
          : 'Americas becomes the default view once 250 of the top 500 are placed. Until then it’s still learning.'),
        h('p', null, 'Names are never published next to play times: each pattern is stored under a keyed hash.')));
  }

  function renderViewbar(m) {
    const bar = $('viewbar');
    const reg = m.hasData ? m.reg : null;
    if (!reg) { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    const keep = focusKey(bar);
    const btn = (key, label, extra) => h('button', {
      type: 'button', 'data-focus': `view-${key}`, 'aria-pressed': m.view === key ? 'true' : 'false',
      onclick: () => setView(key),
    }, label, extra);
    // 10 blocks of 50 players; the first lights up as soon as anyone is placed
    const lit = reg.placedRuby > 0 ? Math.max(1, Math.min(10, Math.floor(reg.placedRuby / 50))) : 0;
    const blocks = [];
    for (let i = 0; i < 10; i++) blocks.push(h('i', { class: i < lit ? 'on' : null }));
    bar.replaceChildren(
      h('div', { class: 'vb-switch' },
        h('span', { class: 'vb-label', id: 'vb-label' }, 'Verdict for'),
        h('div', { class: 'seg views', role: 'group', 'aria-labelledby': 'vb-label' },
          btn('am', 'Americas', reg.ready ? null : h('span', { class: 'badge' }, 'learning')),
          btn('global', 'Global'))),
      h('div', { class: 'vb-info' },
        h('p', { class: `placing${reg.ready ? ' ready' : ''}` },
          h('span', { class: 'pbar', 'aria-hidden': 'true' }, blocks),
          h('span', null, placingLine(reg))),
        howPlaced(reg)));
    restoreFocus(bar, keep);
  }

  function learningNote(m) {
    const n = m.reg.placedRuby;
    return h('p', { class: 'learn' }, h('span', { class: 'coin-tag' }, 'Still learning'),
      h('span', null, `${n != null ? `Only ${int(n)} of the top 500 are` : 'Not many players are'} placed in a region so far, so treat the Americas numbers as a rough guess for now. It takes a few days.`));
  }

  // The hero as a lobby tap records it (POST /api/lobby). `share` is only set when the
  // verdict was computed from one (QUEUE UP / COIN FLIP / WAIT); both shares always ride along.
  function shownForTap(m) {
    const r4 = (x) => (isNum(x) ? Math.round(x * 1e4) / 1e4 : null);
    const verdict = TAP_VERDICT[m.kind] || 'unknown';
    const lb = m.hasData && typeof m.L.leaderboardUpdatedAt === 'string' ? m.L.leaderboardUpdatedAt : null;
    return {
      verdict,
      view: m.view === 'am' ? 'am' : 'global',
      share: ['queue', 'coin', 'wait'].includes(verdict) ? r4(m.share) : null,
      globalShare: m.hasData ? r4(m.globalShare) : null,
      amShare: m.hasData ? r4(m.amShare) : null,
      lbUpdatedAt: lb && lb.length <= 40 ? lb : null,
    };
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

  // "Americas " in the Americas view, nothing in Global, so Global reads exactly as before.
  const where = (m) => (m.am ? 'Americas ' : '');
  const ofActive = (m) => (m.am ? 'of active Americas players' : 'of active top-10k players');

  function nowLine(m, withTypical = true) {
    // "About 42 Ruby players in ranked (4.6% of active top-10k players). Usually 2.9% at this hour."
    const parts = [];
    if (m.rubyEst != null) {
      // "About" rather than "~": the pixel font's tilde reads like a minus sign.
      parts.push(`About ${int(m.rubyEst)} ${where(m)}Ruby ${m.rubyEst === 1 ? 'player' : 'players'} in ranked`);
      if (m.share != null) parts.push(` (${pct(m.share)} ${ofActive(m)})`);
      parts.push('.');
    }
    if (withTypical && m.typical) parts.push(` Usually ${pct(m.typical.value)} ${m.typical.scope}.`);
    return parts.join('');
  }

  function windowMeta(m) {
    const bits = [];
    const asOf = m.windowEnd != null ? m.windowEnd : m.lb;
    bits.push(agoEl(asOf, 'As of '));
    if (m.win && m.am) {
      const more = m.unplaced ? ` (plus ${int(m.unplaced)} not placed in a region yet)` : '';
      bits.push(`, from a ${duration(m.minutes)} window: ${int(m.ruby || 0)} Americas Ruby of ${int(m.all || 0)} Americas players finished a game${more}.`);
    } else if (m.win) {
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
      'aria-label': `${where(m)}Ruby share percentile ${r} out of 100. Below 35 is a good time, above 65 means wait.` },
      blocks, h('b', { class: `meter-mark${lit <= 3 ? ' edge-l' : lit >= 18 ? ' edge-r' : ''}`, vars: { '--at': `${(lit - 0.5) * 5}%` } }, `${ordinal(r)} pct`));
    const zone = (key, label) => h('span', { class: `zl z-${key}${m.verdict === key ? ' on' : ''}` }, label);
    return h('div', { class: 'meter' }, bar,
      h('div', { class: 'meter-zones', 'aria-hidden': 'true' }, zone('go', 'Queue up'), zone('flip', 'Coin flip'), zone('wait', 'Wait')),
      h('p', { class: 'meter-cap' },
        `${m.am ? 'Americas Ruby share' : 'Ruby share'} is higher than in ${r}% of the ${int(m.shares.length)} ${where(m)}windows recorded since ${shortDate(m.firstT)}.`));
  }

  // "Top 10k: busier than usual. About 380 top-10k players in ranked, busier than 72% of the 940
  // windows recorded. Usually about 300 at this hour."
  const TENK_LABEL = { quiet: 'quieter than usual', usual: 'about usual', busy: 'busier than usual' };
  function tenk(m) {
    if (!m.busy) return null;
    const who = m.am ? 'Americas top-10k' : 'top-10k';
    const r = Math.round(Math.max(0, Math.min(100, m.allPct)));
    const typical = m.typicalAll ? ` Usually about ${int(m.typicalAll.value)} ${m.typicalAll.scope}.` : '';
    return h('p', { class: 'tenk' },
      h('span', { class: `tenk-tag t-${m.busy}` }, `${m.am ? 'AMERICAS ' : ''}TOP 10K`),
      h('span', null, h('b', null, `${TENK_LABEL[m.busy][0].toUpperCase()}${TENK_LABEL[m.busy].slice(1)}.`),
        ` About ${int(m.allEst)} ${who} players in ranked, busier than ${r}% of the ${int(m.allEsts.length)} ${where(m)}windows recorded.${typical}`));
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
        n ? `${int(n)} of ${MIN_SAMPLES} ${where(m)}windows so far (${duration(spanMin)} of data). ` : `No ${where(m)}windows recorded yet. `,
        m.am
          ? 'The Americas verdict switches on after about 6 hours of windows with placed players. Switch to Global for a verdict meanwhile.'
          : 'The verdict switches on after about 6 hours; the heatmap gets reliable after about 7 days.'));
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
        : m.am
          ? 'The Americas view only counts players placed in the Americas, and it needs a few more hours of their windows before calling it. Here’s the raw Americas count from the latest window.'
          : 'Collecting data before calling it. Here’s the raw count from the latest window.';
      kids.push(slab('v-cal', 'verdict-calibrating', ['CALIBRATING'], sub));
      if (m.kind === 'calibrating') {
        const raw = [];
        if (m.rubyEst != null) raw.push(`About ${int(m.rubyEst)} ${where(m)}Ruby players in ranked`);
        if (m.share != null) raw.push(` (${pct(m.share)} ${ofActive(m)})`);
        kids.push(lowerThird(raw.length ? raw.join('') + '.' : null, windowMeta(m)));
      }
      kids.push(collected(m));
    } else if (m.kind === 'quiet') {
      kids.push(slab('v-cal', 'verdict-calibrating', ['NO GAMES', 'SEEN'], m.am
        ? 'None of the players placed in the Americas finished a ranked game in the latest window, so there’s nothing to compare. This usually clears up on the next check.'
        : 'Nobody in the top 10k finished a ranked game in the latest window, so there’s nothing to compare. This usually clears up on the next check.'));
      kids.push(lowerThird(null, windowMeta(m)));
    } else {
      const v = VERDICTS[m.kind];
      kids.push(slab(v.cls, v.art, v.units, v.sub));
      kids.push(lowerThird(nowLine(m), windowMeta(m)));
      kids.push(meter(m));
      const busy = tenk(m);
      if (busy) kids.push(busy);
      state.animated = true;
    }
    if (m.am && !m.reg.ready && m.hasData) {
      // right under the numbers it qualifies
      const at = kids.findIndex((k) => k.classList.contains('l3'));
      kids.splice(at < 0 ? 1 : at + 1, 0, learningNote(m));
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
      h('p', { class: 'strip-tag' }, m.am ? 'Best bet in the next 12h (Americas)' : 'Best bet in the next 12h'),
      h('div', { class: 'strip-body' },
        h('p', { class: 'strip-main' }, h('strong', null, `${hourLong(nx.hour)} ${DAYS[nx.day]}`), ` — ${where(m)}Ruby share usually ${pct(nx.value)}`),
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

    const kids = [sectionHead('heat-h', 'Ruby traffic by hour', `${m.am ? 'Americas · ' : ''}Your time: ${timeZoneLabel()}`), seg, wrap];
    kids.push(legend(scale, metric));
    const spanMin = m.firstT != null ? (m.lastT - m.firstT) / 60000 : 0;
    const only = m.am ? 'Americas only: counts just the players placed in the Americas. ' : '';
    kids.push(h('p', { class: 'note' }, m.usable.length
      ? `${only}Built from ${plural(m.usable.length, 'window')} over ${duration(spanMin)}. Each square averages the windows that ended in that hour. Hover or tap a square for details.`
      : `${only}No windows recorded yet. Squares fill in as data arrives, and the pattern gets reliable after about 7 days.`));
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
      ? `${plural(list.length, 'Ruby player')} finished a game in the last ${duration(m.minutes)}${m.am ? ' · all regions' : ''}`
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
    // The static text (no regions) says the heatmap mixes every region; with regions it explains the views.
    const note = $('regions-note');
    if (!note.dataset.mixed) note.dataset.mixed = note.textContent;
    note.textContent = m.hasData && m.reg
      ? 'the leaderboard is global while matchmaking is regional: the Americas view counts only players the radar has placed in the Americas by when they play (see “How players are placed” up top), and the Global view mixes every region together.'
      : note.dataset.mixed;
  }

  // ------------------------------------------------------------------ lobby log
  // "Lobby log API" in dev/DATA-CONTRACT.md. The squad code only ever travels in the
  // X-Squad-Code header and sits in localStorage; it never goes into a URL or the console.

  // Base URL from config.js, or ?api= to test against a local mock (localhost only).
  const isLocal = (u) => u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  const API = (() => {
    const param = new URLSearchParams(location.search).get('api');
    if (param) {
      try {
        const u = new URL(param);
        if (isLocal(u)) return u.origin;
      } catch (e) { /* ignore a malformed override */ }
    }
    const cfg = typeof window.RUBY_RADAR_API === 'string' ? window.RUBY_RADAR_API.trim() : '';
    if (!cfg) return '';
    try {
      const u = new URL(cfg);
      if (u.protocol === 'https:' || isLocal(u)) return (u.origin + u.pathname).replace(/\/+$/, '');
    } catch (e) { /* a malformed value counts as not connected */ }
    return '';
  })();

  const lobby = {
    code: readPref('rr-squad-code', ''),
    name: readPref('rr-squad-name', ''),
    filter: readPref('rr-lobby-filter', 'all') === 'me' ? 'me' : 'all',
    busy: false, checking: false,
    rows: null, error: null, authFailed: false, seq: 0,
    pending: null,                 // 'sweaty' | 'normal' waiting on the squad dialog
    opener: null,                  // what had focus before the dialog opened
    undo: null,                    // { id, result, timer } while Undo is on offer
    noteTimer: null,
  };
  const els = {};

  // -> { status, data }; status 0 = no answer (offline, CORS, timeout).
  async function api(method, path, body, code = lobby.code) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), API_TIMEOUT_MS) : null;
    const init = { method, headers: { 'X-Squad-Code': code }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    if (ctrl) init.signal = ctrl.signal;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(API + path, init);
      let data = null;
      try { data = await res.json(); } catch (e) { /* empty or not JSON */ }
      return { status: res.status, data };
    } catch (e) {
      return { status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }
  const okStatus = (s) => s >= 200 && s < 300;

  function apiProblem(status, data) {
    if (status === 0) return 'Couldn’t reach the log, try again.';
    if (status === 429) {
      const wait = data && Number.isInteger(data.retryAfter) && data.retryAfter > 0 && data.retryAfter < 3600 ? data.retryAfter : null;
      return `Easy — one tap per match.${wait ? ` You can tap again in ${plural(wait, 'second')}.` : ''}`;
    }
    // 503 is the Worker's "no squad code configured on the server yet"
    if (status === 503) return 'The lobby log isn’t set up yet (HTTP 503). Try again later.';
    if (status === 404 || status === 405 || status === 501) return `The lobby log isn’t set up at this address yet (HTTP ${status}).`;
    if (status === 400) return 'The log didn’t accept that (HTTP 400). Reload the page and try again.';
    return `The log had a problem (HTTP ${status}). Try again in a bit.`;
  }

  // ---- the two big buttons, built once so a refresh never yanks them away mid-tap
  function initLobby() {
    const button = (result, art, word) => h('button', {
      type: 'button', class: `lob ${result}`, 'data-focus': `lob-${result}`, onclick: () => tap(result),
    }, h('span', { class: 'lob-art' }, sprite(art)),
    h('span', { class: 'lob-label' }, h('span', { class: 'unit' }, word), ' ', h('span', { class: 'unit' }, 'LOBBY')));
    els.sweaty = button('sweaty', 'verdict-sweat', 'SWEATY');
    els.normal = button('normal', 'verdict-go', 'NORMAL');
    els.status = h('div', { class: 'lobby-status', role: 'status' });
    els.meta = h('p', { class: 'lobby-meta', id: 'lobby-meta' });
    const sec = $('lobby');
    sec.replaceChildren(
      h('p', { class: 'lobby-ask', id: 'lobby-h' }, sprite('gem'), h('span', null, 'Just finished a ranked match? Tell the radar.')),
      h('div', { class: 'lobby-btns' }, els.sweaty, els.normal),
      els.status, els.meta);
    sec.hidden = false;
    updateLobby();
  }

  function updateLobby() {
    const off = !API;
    for (const b of [els.sweaty, els.normal]) {
      b.disabled = off;
      b.classList.toggle('off', off);
      // aria-disabled (not disabled) while busy, so keyboard focus stays on the button
      if (lobby.busy) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      if (off) b.setAttribute('aria-describedby', 'lobby-meta'); else b.removeAttribute('aria-describedby');
    }
    els.status.querySelectorAll('button').forEach((b) => {
      if (lobby.busy) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
    const settings = h('button', { type: 'button', class: 'linkish', 'data-focus': 'settings', onclick: () => openSquad({}) }, 'squad settings');
    let kids;
    if (off) kids = [h('span', { class: 'coin-tag' }, 'Not connected'), h('span', null, 'Lobby log isn’t connected yet.')];
    else if (lobby.code && lobby.name) kids = [h('span', null, 'Logging as ', h('b', null, lobby.name)), settings];
    else kids = [h('span', null, 'The first tap asks for your squad code and name.'), settings];
    const keep = focusKey(els.meta);
    els.meta.replaceChildren(...kids);
    restoreFocus(els.meta, keep);
  }

  function setBusy(on) {
    lobby.busy = on;
    updateLobby();
  }

  async function tap(result) {
    if (!API || lobby.busy) return;
    if (!lobby.code || !lobby.name) { openSquad({ pending: result }); return; }
    const shown = state.shown || shownForTap({ kind: 'unknown', hasData: false });
    // Exactly the contract's fields; the Worker adds id and t.
    const body = {
      who: lobby.name, result,
      verdict: shown.verdict, view: shown.view, share: shown.share,
      globalShare: shown.globalShare, amShare: shown.amShare, lbUpdatedAt: shown.lbUpdatedAt,
    };
    setBusy(true);
    const res = await api('POST', '/api/lobby', body);
    setBusy(false);
    if (okStatus(res.status)) {
      const id = res.data && Number.isInteger(res.data.id) ? res.data.id : null;
      showUndo(id, result, 'LOGGED!', `${result === 'sweaty' ? 'Sweaty' : 'Normal'} lobby logged. The radar said ${loggedVerdict(body.verdict).label}${body.view === 'am' ? ' (Americas)' : ''}.`, 'ok');
      loadLobbies();
    } else if (res.status === 401) {
      squadRejected(result);
    } else {
      showNote(res.status === 429 ? 'Hold up' : 'Not logged', apiProblem(res.status, res.data), 'err');
    }
  }

  // ---- the message under the buttons: LOGGED! + Undo, or a short note
  function clearStatus() {
    if (lobby.undo) clearTimeout(lobby.undo.timer);
    clearTimeout(lobby.noteTimer);
    lobby.undo = null;
    els.status.replaceChildren();
  }

  function showUndo(id, result, big, msg, kind) {
    clearStatus();
    const kids = [h('p', { class: 'toast-big' }, big), h('p', { class: 'toast-text' }, msg)];
    if (id != null) {
      kids.push(h('button', { type: 'button', class: 'btn', 'data-focus': 'undo', onclick: () => undoTap(id) }, 'Undo'),
        h('i', { class: 'undo-bar', 'aria-hidden': 'true', vars: { '--ms': UNDO_MS } }));
      lobby.undo = { id, result, timer: setTimeout(expireUndo, UNDO_MS) };
    } else {
      lobby.noteTimer = setTimeout(expireNote, NOTE_MS);
    }
    els.status.replaceChildren(h('div', { class: `toast ${kind} ${result}` }, kids));
  }

  // Errors stay up until the next tap, so a phone put down mid-request still shows "not logged".
  function showNote(big, msg, kind = 'info') {
    clearStatus();
    els.status.replaceChildren(h('div', { class: `toast ${kind}` }, h('p', { class: 'toast-big' }, big), h('p', { class: 'toast-text' }, msg)));
    if (kind !== 'err') lobby.noteTimer = setTimeout(expireNote, NOTE_MS);
  }

  // Don't pull a button out from under someone who's focused on it.
  function expireUndo() {
    if (!lobby.undo) return;
    if (els.status.contains(document.activeElement)) { lobby.undo.timer = setTimeout(expireUndo, 1500); return; }
    clearStatus();
  }
  function expireNote() {
    if (els.status.contains(document.activeElement)) { lobby.noteTimer = setTimeout(expireNote, 1500); return; }
    clearStatus();
  }

  async function undoTap(id) {
    if (!lobby.undo || lobby.undo.id !== id || lobby.busy) return;
    const result = lobby.undo.result;
    clearTimeout(lobby.undo.timer);
    const hadFocus = els.status.contains(document.activeElement);
    setBusy(true);
    const res = await api('DELETE', `/api/lobby/${encodeURIComponent(String(id))}`);
    setBusy(false);
    if (okStatus(res.status) || res.status === 404) {
      showNote('Undone', res.status === 404 ? 'That tap was already gone from the log.' : 'Tap removed from the log.');
      loadLobbies();
    } else if (res.status === 401) {
      clearStatus();
      squadRejected(null);
      return;
    } else {
      showUndo(id, result, 'Not undone', apiProblem(res.status), 'err');
    }
    if (hadFocus && !els.status.contains(document.activeElement)) els[result].focus();
  }

  // ---- squad dialog: code + name, checked with GET /api/ping
  function buildSquadDialog() {
    const code = h('input', { type: 'password', name: 'squad-code', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 200 });
    // maxlength counts UTF-16 units, so leave room for emoji; the 24-character check is in submitSquad
    const name = h('input', { type: 'text', name: 'nickname', autocomplete: 'nickname', spellcheck: 'false', maxlength: NAME_MAX * 2 });
    const err = h('p', { class: 'dlg-err', role: 'alert' });
    const save = h('button', { type: 'submit', class: 'btn' }, 'Save');
    const forget = h('button', { type: 'button', class: 'linkish', onclick: forgetSquad }, 'Forget on this device');
    // method="dialog": even if the script broke, a submit could never put the code in a URL
    const form = h('form', { class: 'dlg-form', method: 'dialog', novalidate: true, onsubmit: submitSquad },
      h('h2', { class: 'dlg-h', id: 'dlg-h' }, sprite('gem'), 'Squad log'),
      h('p', { class: 'dlg-p', id: 'dlg-d' }, 'Taps go to a log only your squad can see. Enter your squad’s code and the name your taps show up under.'),
      h('label', { class: 'field' }, h('span', null, 'Squad code'), code),
      h('label', { class: 'field' }, h('span', null, 'Your name ', h('small', null, `(1–${NAME_MAX} characters)`)), name),
      err,
      h('div', { class: 'dlg-btns' }, save, h('button', { type: 'button', class: 'btn ghost', onclick: () => closeSquad() }, 'Cancel')),
      h('p', { class: 'dlg-foot' }, h('span', null, 'Saved only in this browser.'), forget));
    const dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-h', 'aria-describedby': 'dlg-d' }, form);
    let downOnBackdrop = false;            // a drag that ends outside the box isn't a backdrop click
    dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg && downOnBackdrop) closeSquad(); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeSquad(); });
    document.body.append(dlg);
    Object.assign(els, { dlg, code, name, err, save, forget });
  }

  function openSquad({ pending = null, error = '' }) {
    if (!els.dlg) buildSquadDialog();
    if (!els.dlg.open) lobby.opener = document.activeElement;
    lobby.pending = pending;
    els.code.value = lobby.code;
    els.name.value = lobby.name;
    els.err.textContent = error;
    els.save.textContent = pending ? `Save & log ${pending} lobby` : 'Save';
    els.forget.hidden = !(lobby.code || lobby.name || readPref('rr-squad-name', ''));
    if (!els.dlg.open) {
      if (typeof els.dlg.showModal === 'function') els.dlg.showModal(); else els.dlg.setAttribute('open', '');
    }
    (error || !els.code.value ? els.code : els.name).focus();
  }

  function closeSquad() {
    const fallback = els[lobby.pending] || els.sweaty;
    lobby.pending = null;
    if (!els.dlg || !els.dlg.open) return;
    if (typeof els.dlg.close === 'function') els.dlg.close(); else els.dlg.removeAttribute('open');
    const back = lobby.opener && lobby.opener.isConnected && lobby.opener !== document.body ? lobby.opener : fallback;
    lobby.opener = null;
    if (back && !back.disabled) back.focus();
  }

  async function submitSquad(e) {
    e.preventDefault();
    if (lobby.checking) return;
    const code = els.code.value.trim();
    const name = els.name.value.trim().replace(/\s+/g, ' ');
    const fail = (msg, field) => { els.err.textContent = msg; if (field) field.focus(); };
    if (!code) return fail('Enter your squad code.', els.code);
    if (!/^[\x20-\x7e]+$/.test(code)) return fail('Squad codes are plain letters, numbers and symbols.', els.code);
    if (!name) return fail('Enter the name your taps show up under.', els.name);
    if ([...name].length > NAME_MAX) return fail(`Names can be up to ${NAME_MAX} characters.`, els.name);
    if (/[\u0000-\u001f\u007f]/.test(name)) return fail('That name has characters the log can’t take.', els.name);
    const label = els.save.textContent;
    lobby.checking = true;
    els.save.disabled = true;
    els.save.textContent = 'Checking…';
    els.err.textContent = '';
    const res = await api('GET', '/api/ping', undefined, code);
    lobby.checking = false;
    els.save.disabled = false;
    els.save.textContent = label;
    if (res.status === 200) {
      const pending = lobby.pending;
      lobby.code = code;
      lobby.name = name;
      lobby.authFailed = false;
      writePref('rr-squad-code', code);
      writePref('rr-squad-name', name);
      closeSquad();
      updateLobby();
      loadLobbies();
      if (pending) tap(pending);
      else showNote('Saved', `Taps will show up as ${name}.`);
    } else if (res.status === 401) {
      fail('That squad code didn’t work. Check it and try again.', els.code);
    } else {
      fail(apiProblem(res.status));
    }
  }

  // A 401 on a tap: the code changed or was mistyped. Drop it and ask again.
  function squadRejected(pending) {
    lobby.code = '';
    forgetPref('rr-squad-code');
    lobby.rows = null;
    lobby.authFailed = false;
    lobby.seq++;
    updateLobby();
    renderLobbies();
    openSquad({ pending, error: 'That squad code didn’t work. Enter it again.' });
  }

  function forgetSquad() {
    forgetPref('rr-squad-code');
    forgetPref('rr-squad-name');
    Object.assign(lobby, { code: '', name: '', rows: null, error: null, authFailed: false });
    lobby.seq++;                     // drop any load still in flight
    closeSquad();
    updateLobby();
    renderLobbies();
    showNote('Forgotten', 'Squad code and name removed from this browser.');
  }

  // ---- "Your lobbies": does the verdict predict sweaty lobbies?
  async function loadLobbies() {
    if (!API || !lobby.code || !lobby.name) { renderLobbies(); return; }
    const seq = ++lobby.seq;
    const res = await api('GET', '/api/lobbies');
    if (seq !== lobby.seq) return;   // a newer load (or "forget") superseded this one
    if (res.status === 200 && res.data && Array.isArray(res.data.lobbies)) {
      lobby.rows = res.data.lobbies.filter((r) => r && typeof r === 'object' && isNum(r.t)).sort((a, b) => a.t - b.t);
      lobby.error = null;
      lobby.authFailed = false;
    } else if (res.status === 401) {
      lobby.authFailed = true;
    } else {
      lobby.error = res.status === 503 ? 'it isn’t set up on the server yet' : res.status ? `HTTP ${res.status}` : 'couldn’t reach it';
    }
    renderLobbies();
  }

  const tapRecent = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const tapOlder = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tapTime = (ms) => (Date.now() - ms < 6 * 86400000 ? tapRecent : tapOlder).format(new Date(ms));
  const resultWord = (r) => (r === 'sweaty' ? 'Sweaty' : r === 'normal' ? 'Normal' : text(r) || '?');

  function renderLobbies() {
    const sec = $('lobbies');
    if (!API) { sec.hidden = true; sec.replaceChildren(); return; }
    sec.hidden = false;
    const keep = focusKey(sec);
    const head = (tag) => sectionHead('lobbies-h', 'Your lobbies', tag, 'gem');
    const action = (label, onclick) => h('p', { class: 'more' }, h('button', { type: 'button', class: 'btn', 'data-focus': 'act', onclick }, label));
    const why = 'Every tap records the verdict the radar showed at the time, so this shows whether the verdict actually predicts your lobbies.';
    let kids;
    if (!lobby.code || !lobby.name) {
      kids = [head(null), h('p', { class: 'empty' }, `${why} Enter your squad code to see your squad’s log.`),
        action('Enter squad code', () => openSquad({}))];
    } else if (lobby.authFailed) {
      kids = [head(null), h('p', { class: 'empty' }, 'The log didn’t accept your squad code. It may have changed.'),
        action('Enter the code again', () => openSquad({ error: 'The log didn’t accept the saved code. Enter it again.' }))];
    } else if (!lobby.rows) {
      kids = [head(null)];
      if (lobby.error) kids.push(h('p', { class: 'empty' }, `Couldn’t load the log (${lobby.error}).`), action('Try again', loadLobbies));
      else kids.push(h('p', { class: 'empty' }, 'Loading the log…'));
    } else {
      kids = lobbyStats(head, why);
      if (lobby.error) kids.push(h('p', { class: 'note' }, `Couldn’t refresh the log (${lobby.error}), so this is from earlier. It tries again every 2 minutes.`));
    }
    sec.replaceChildren(...kids);
    restoreFocus(sec, keep);
  }

  function lobbyStats(head, why) {
    const me = lobby.name.trim().toLowerCase();
    const rows = lobby.filter === 'me' ? lobby.rows.filter((r) => text(r.who).trim().toLowerCase() === me) : lobby.rows;
    const tally = () => ({ n: 0, sweaty: 0 });
    const by = { queue: tally(), coin: tally(), wait: tally(), calibrating: tally() };
    const other = tally(), total = tally();
    for (const r of rows) {
      const s = r.result === 'sweaty' ? 1 : 0;
      for (const t of [by[r.verdict] || other, total]) { t.n += 1; t.sweaty += s; }
    }
    const fbtn = (key, label) => h('button', {
      type: 'button', 'data-focus': `f-${key}`, 'aria-pressed': lobby.filter === key ? 'true' : 'false',
      onclick: () => {
        if (lobby.filter === key) return;
        lobby.filter = key;
        writePref('rr-lobby-filter', key);
        renderLobbies();
      },
    }, label);
    const out = [
      head(lobby.filter === 'me' ? `${plural(rows.length, 'tap')} by you` : `${plural(rows.length, 'tap')} logged`),
      h('div', { class: 'seg lfilter', role: 'group', 'aria-label': 'Whose taps to count' }, fbtn('all', 'Everyone'), fbtn('me', 'Just me')),
    ];
    if (!rows.length) {
      out.push(h('p', { class: 'empty' }, lobby.filter === 'me' && lobby.rows.length
        ? `No taps logged as ${lobby.name} yet.`
        : 'No taps yet. Hit SWEATY LOBBY or NORMAL LOBBY after your next ranked match.'),
      h('p', { class: 'note' }, `${why} It gets meaningful after a couple of weeks of tapping.`));
      return out;
    }

    const share = (t) => (t.n ? pf0.format(t.sweaty / t.n) : '–');
    const line = (label, cls, t) => {
      const lit = t.n ? Math.round((t.sweaty / t.n) * 10) : 0;
      const blocks = [];
      for (let i = 0; i < 10; i++) blocks.push(h('i', { class: i < lit ? 'on' : null }));
      return h('tr', { class: t.n ? null : 'zero' },
        h('th', { scope: 'row' }, cls ? h('span', { class: `vchip v-${cls}` }, label) : label),
        h('td', { class: 'n' }, int(t.n)),
        h('td', { class: 'pct' }, h('b', null, share(t)), h('span', { class: `sbar${t.n ? '' : ' none'}`, 'aria-hidden': 'true' }, blocks)));
    };
    const body = ['queue', 'coin', 'wait', 'calibrating'].map((v) => line(LOGGED[v].label, LOGGED[v].cls, by[v]));
    if (other.n) body.push(line('STALE / NONE', 'other', other));
    out.push(h('table', { class: 'ltable' },
      h('caption', { class: 'vh' }, 'Taps by the verdict the radar showed at the time, and the share of those lobbies that were sweaty'),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Radar said'), h('th', { scope: 'col', class: 'n' }, 'Taps'), h('th', { scope: 'col' }, 'Sweaty'))),
      h('tbody', null, body),
      h('tfoot', null, line('All taps', null, total))));

    if (total.n < MEANINGFUL_TAPS) {
      out.push(h('p', { class: 'note' }, `Only ${plural(total.n, 'tap')} so far. This gets meaningful after a couple of weeks of tapping.`));
    } else if (by.queue.n >= 3 && by.wait.n >= 3) {
      out.push(h('p', { class: 'insight' },
        `When the radar said QUEUE UP, ${share(by.queue)} of ${lobby.filter === 'me' ? 'your' : 'these'} lobbies were sweaty. When it said WAIT, ${share(by.wait)}.`));
    }

    out.push(h('h3', { class: 'sub-h' }, 'Last taps'));
    out.push(h('ol', { class: 'taplog' }, rows.slice(-LOG_SHOWN).reverse().map((r) => {
      const v = loggedVerdict(r.verdict);
      const ms = r.t * 1000;
      return h('li', null,
        h('time', { datetime: new Date(ms).toISOString() }, tapTime(ms)),
        h('span', { class: 'who' }, text(r.who) || '?'),
        h('span', { class: `res ${r.result === 'sweaty' ? 'sweaty' : 'normal'}` }, resultWord(r.result)),
        h('span', { class: 'lv' }, h('span', { class: `vchip v-${v.cls}` }, v.label), r.view === 'am' ? ' Americas' : r.view === 'global' ? ' Global' : ''));
    })));
    out.push(h('p', { class: 'more' }, h('button', {
      type: 'button', class: 'btn ghost', 'data-focus': 'csv', onclick: () => exportCsv(rows),
    }, `Export CSV (${plural(rows.length, 'tap')})`)));
    return out;
  }

  // Spreadsheet-safe: quote when needed, and defuse cells that would run as formulas
  // (names are typed by people).
  function csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv(rows) {
    const pad = (n) => String(n).padStart(2, '0');
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const cols = ['id', 't', 'time_utc', 'time_local', 'who', 'result', 'verdict', 'view', 'share', 'globalShare', 'amShare', 'lbUpdatedAt'];
    const lines = [cols.join(',')];
    for (const r of rows) {
      const d = new Date(r.t * 1000);
      lines.push([r.id, r.t, d.toISOString().replace('.000Z', 'Z'), local(d), r.who, r.result, r.verdict, r.view,
        r.share, r.globalShare, r.amShare, r.lbUpdatedAt].map(csvCell).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const a = h('a', { href: url, download: `ruby-radar-lobbies-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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

  initLobby();
  renderLobbies();
  setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!state.loadedAt || Date.now() - state.loadedAt > REFRESH_MS)) load();
  });
  load();
})();

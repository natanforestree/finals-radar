// Ruby Radar Worker.
// 1. Lobby log API for the page, stored in D1 (dev/DATA-CONTRACT.md,
//    "Lobby log API").
// 2. A cron trigger that asks GitHub to run the collect workflow every
//    10 minutes, because GitHub's own schedule drifts and drops runs.

const MAX_BODY_BYTES = 2048;
const RATE_LIMIT_SECONDS = 30;

const RESULTS = ['sweaty', 'normal'];
const VERDICTS = ['queue', 'coin', 'wait', 'calibrating', 'stale', 'unknown'];
const VIEWS = ['am', 'global'];

const PAGES_ORIGIN = 'https://natanforestree.github.io';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

// One statement, so two quick taps can't both slip past the rate limit.
const INSERT_LOBBY = `
  INSERT INTO lobbies (t, who, result, verdict, view, share, global_share, am_share, lb_updated_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
  WHERE NOT EXISTS (SELECT 1 FROM lobbies WHERE who = ?2 AND t > ?10)
  RETURNING id`;
const LAST_POST = 'SELECT MAX(t) AS t FROM lobbies WHERE who = ?';
const DELETE_LOBBY = 'DELETE FROM lobbies WHERE id = ?';
const LIST_LOBBIES = `
  SELECT id, t, who, result, verdict, view, share, global_share, am_share, lb_updated_at
  FROM lobbies WHERE t >= ? ORDER BY t, id`;

const ROUTES = [
  ['GET', /^\/api\/ping$/, ping],
  ['POST', /^\/api\/lobby$/, addLobby],
  ['DELETE', /^\/api\/lobby\/(\d{1,15})$/, deleteLobby],
  ['GET', /^\/api\/lobbies$/, listLobbies],
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      response = errorResponse(err);
    }
    for (const [name, value] of Object.entries(corsHeaders(request))) {
      response.headers.set(name, value);
    }
    return response;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchCollect(env));
  },
};

async function route(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(request.url);
  for (const [method, pattern, handler] of ROUTES) {
    const match = url.pathname.match(pattern);
    if (match && request.method === method) {
      await requireSquadCode(request, env);
      return handler({ request, env, url, params: match.slice(1) });
    }
  }
  throw new HttpError(404, 'not found');
}

// ---- Handlers --------------------------------------------------------------

function ping() {
  return json(200, { ok: true });
}

async function addLobby({ request, env }) {
  const lobby = parseLobby(await readJson(request));
  const t = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(INSERT_LOBBY)
    .bind(t, lobby.who, lobby.result, lobby.verdict, lobby.view, lobby.share,
      lobby.globalShare, lobby.amShare, lobby.lbUpdatedAt, t - RATE_LIMIT_SECONDS)
    .first();
  if (row) return json(201, { id: row.id, t });

  const last = await env.DB.prepare(LAST_POST).bind(lobby.who).first();
  const retryAfter = Math.max(1, (last?.t ?? t) + RATE_LIMIT_SECONDS - t);
  return json(429, { error: 'too soon', retryAfter }, { 'Retry-After': String(retryAfter) });
}

async function deleteLobby({ env, params: [id] }) {
  const { meta } = await env.DB.prepare(DELETE_LOBBY).bind(Number(id)).run();
  if (!meta.changes) throw new HttpError(404, 'not found');
  return json(200, { ok: true });
}

async function listLobbies({ env, url }) {
  const since = url.searchParams.get('since');
  if (since !== null && !/^\d{1,12}$/.test(since)) {
    throw new HttpError(400, 'since must be unix seconds');
  }
  const { results } = await env.DB.prepare(LIST_LOBBIES).bind(Number(since ?? 0)).all();
  return json(200, { lobbies: results.map(toApi) });
}

function toApi(row) {
  return {
    id: row.id,
    t: row.t,
    who: row.who,
    result: row.result,
    verdict: row.verdict,
    view: row.view,
    share: row.share,
    globalShare: row.global_share,
    amShare: row.am_share,
    lbUpdatedAt: row.lb_updated_at,
  };
}

// ---- Input -----------------------------------------------------------------

// Reads at most MAX_BODY_BYTES, stopping early instead of buffering a big body.
async function readJson(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body too large');
  }
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'body too large');
      }
      chunks.push(part.value);
    }
  }
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

// Missing optional fields count as null (JSON.stringify drops undefined keys).
function parseLobby(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return {
    who: parseWho(body.who),
    result: oneOf('result', body.result, RESULTS),
    verdict: oneOf('verdict', body.verdict, VERDICTS),
    view: oneOf('view', body.view, VIEWS),
    share: shareOrNull('share', body.share),
    globalShare: shareOrNull('globalShare', body.globalShare),
    amShare: shareOrNull('amShare', body.amShare),
    lbUpdatedAt: isoOrNull('lbUpdatedAt', body.lbUpdatedAt),
  };
}

function parseWho(value) {
  const who = typeof value === 'string' ? value.trim() : '';
  const length = [...who].length;
  if (length < 1 || length > 24 || /\p{Cc}/u.test(who)) {
    throw new HttpError(400, 'who must be 1-24 printable characters');
  }
  return who;
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function shareOrNull(name, value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(400, `${name} must be a number from 0 to 1, or null`);
  }
  return value;
}

function isoOrNull(name, value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${name} must be an ISO time string, or null`);
  }
  return value;
}

// ---- Auth, CORS, responses -------------------------------------------------

async function requireSquadCode(request, env) {
  if (!env.SQUAD_CODE) throw new HttpError(503, 'squad code not set on the server');
  const given = request.headers.get('X-Squad-Code') ?? '';
  if (!(await sameSecret(given, env.SQUAD_CODE))) throw new HttpError(401, 'bad squad code');
}

// Constant time: hash both to equal-length digests, then compare every byte
// without exiting early, so response timing says nothing about the code.
async function sameSecret(a, b) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (text) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { Vary: 'Origin' };
  if (!origin || !(origin === PAGES_ORIGIN || LOCAL_ORIGIN.test(origin))) return headers;
  headers['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS') {
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Squad-Code';
    headers['Access-Control-Max-Age'] = '86400';
  } else {
    headers['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  return headers;
}

function errorResponse(err) {
  if (err instanceof HttpError) return json(err.status, { error: err.message });
  console.error('unhandled error:', err?.stack ?? err);
  return json(500, { error: 'server error' });
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

// ---- Cron: run the collect workflow ----------------------------------------

async function dispatchCollect(env) {
  if (!env.GITHUB_TOKEN) return;
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ruby-radar-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      console.error(`collect dispatch failed: HTTP ${res.status} ${detail}`);
    }
  } catch (err) {
    console.error(`collect dispatch failed: ${err}`);
  }
}

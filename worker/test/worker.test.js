import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from './fake-d1.js';

const BASE = 'https://ruby-radar.example.workers.dev';
const CODE = 'tilted-ruby-42';
const PAGES = 'https://natanforestree.github.io';
const START = 1_791_221_331; // unix seconds

let now; // the Worker's clock, in unix seconds

beforeEach(() => {
  now = START;
  mock.method(Date, 'now', () => now * 1000);
});

afterEach(() => mock.restoreAll());

function makeEnv(overrides = {}) {
  return {
    DB: createFakeD1(),
    SQUAD_CODE: CODE,
    GITHUB_REPO: 'natanforestree/finals-radar',
    GITHUB_WORKFLOW: 'collect.yml',
    ...overrides,
  };
}

function makeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
  };
}

// Calls the Worker like the page would. `code: null` sends no squad code;
// a string `body` is sent raw, anything else as JSON.
async function call(env, method, path, { body, code = CODE, origin, headers = {} } = {}) {
  const init = { method, headers: new Headers(headers) };
  if (code !== null) init.headers.set('X-Squad-Code', code);
  if (origin) init.headers.set('Origin', origin);
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers.set('Content-Type', 'application/json');
  }
  const res = await worker.fetch(new Request(BASE + path, init), env, makeCtx());
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const lobby = (extra = {}) => ({
  who: 'Nathan',
  result: 'sweaty',
  verdict: 'wait',
  view: 'am',
  share: 0.152,
  globalShare: 0.134,
  amShare: 0.171,
  lbUpdatedAt: '2026-10-05T17:28:51Z',
  ...extra,
});

describe('auth', () => {
  test('missing squad code gets 401', async () => {
    const res = await call(makeEnv(), 'GET', '/api/ping', { code: null });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'bad squad code' });
  });

  test('wrong squad code gets 401 (same and different length)', async () => {
    const env = makeEnv();
    for (const code of ['tilted-ruby-43', 'nope', '', `${CODE}x`]) {
      const res = await call(env, 'GET', '/api/ping', { code });
      assert.equal(res.status, 401, `code ${JSON.stringify(code)}`);
      assert.deepEqual(res.body, { error: 'bad squad code' });
    }
  });

  test('right squad code passes', async () => {
    const res = await call(makeEnv(), 'GET', '/api/ping');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  test('every API route needs the code, and nothing is written without it', async () => {
    const env = makeEnv();
    const posted = await call(env, 'POST', '/api/lobby', { body: lobby() });
    for (const [method, path, body] of [
      ['POST', '/api/lobby', lobby({ who: 'Friend' })],
      ['DELETE', `/api/lobby/${posted.body.id}`],
      ['GET', '/api/lobbies'],
    ]) {
      const res = await call(env, method, path, { body, code: 'wrong' });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal(env.DB.rows.length, 1);
  });

  test('without a SQUAD_CODE secret every call is refused', async () => {
    const res = await call(makeEnv({ SQUAD_CODE: undefined }), 'GET', '/api/ping', { code: '' });
    assert.equal(res.status, 503);
  });
});

describe('CORS', () => {
  for (const origin of [PAGES, 'http://localhost:5173', 'http://127.0.0.1:8000']) {
    test(`echoes allowed origin ${origin}`, async () => {
      const res = await call(makeEnv(), 'GET', '/api/ping', { origin });
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(res.headers.get('Vary'), 'Origin');
      assert.equal(res.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
    });
  }

  for (const origin of [
    'https://evil.example',
    'http://natanforestree.github.io',
    'https://natanforestree.github.io.evil.example',
    'https://natanforestree.github.io:8443',
    'http://localhost',
    'https://localhost:5173',
    'http://localhost:8080.evil.example',
    'null',
  ]) {
    test(`does not echo disallowed origin ${origin}`, async () => {
      const res = await call(makeEnv(), 'GET', '/api/ping', { origin });
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
      assert.equal(res.headers.get('Vary'), 'Origin');
    });
  }

  test('no Origin header (curl, the collector) still works, without CORS headers', async () => {
    const res = await call(makeEnv(), 'GET', '/api/ping');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('error responses carry CORS headers so the page can read them', async () => {
    const res = await call(makeEnv(), 'GET', '/api/ping', { code: 'wrong', origin: PAGES });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGES);
  });

  test('preflight from an allowed origin: 204, no squad code needed', async () => {
    const res = await call(makeEnv(), 'OPTIONS', '/api/lobby', {
      code: null,
      origin: PAGES,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-squad-code' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGES);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-Squad-Code');
    assert.ok(Number(res.headers.get('Access-Control-Max-Age')) > 0);
  });

  test('preflight from a disallowed origin gets no CORS headers', async () => {
    const res = await call(makeEnv(), 'OPTIONS', '/api/lobby', { code: null, origin: 'https://evil.example' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), null);
  });
});

describe('POST /api/lobby', () => {
  test('stores a lobby; the server sets id and t', async () => {
    const env = makeEnv();
    const res = await call(env, 'POST', '/api/lobby', { body: lobby() });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { id: 1, t: START });
    assert.match(res.headers.get('Content-Type'), /^application\/json/);

    const list = await call(env, 'GET', '/api/lobbies');
    assert.deepEqual(list.body.lobbies, [{ id: 1, t: START, ...lobby() }]);
  });

  test('stores camelCase fields in snake_case columns', async () => {
    const env = makeEnv();
    await call(env, 'POST', '/api/lobby', { body: lobby() });
    assert.deepEqual(env.DB.rows[0], {
      id: 1, t: START, who: 'Nathan', result: 'sweaty', verdict: 'wait', view: 'am',
      share: 0.152, global_share: 0.134, am_share: 0.171, lb_updated_at: '2026-10-05T17:28:51Z',
    });
  });

  test('ignores client-sent t, id and unknown fields; trims who', async () => {
    const env = makeEnv();
    const res = await call(env, 'POST', '/api/lobby', {
      body: lobby({ who: '  Nathan  ', t: 5, id: 99, admin: true }),
    });
    assert.deepEqual(res.body, { id: 1, t: START });
    const [row] = (await call(env, 'GET', '/api/lobbies')).body.lobbies;
    assert.equal(row.who, 'Nathan');
    assert.equal(row.t, START);
    assert.equal(row.id, 1);
    assert.equal('admin' in row, false);
  });

  test('null and missing optional fields are stored as null', async () => {
    const env = makeEnv();
    await call(env, 'POST', '/api/lobby', {
      body: { who: 'Nathan', result: 'normal', verdict: 'unknown', view: 'global', share: null, lbUpdatedAt: null },
    });
    const [row] = (await call(env, 'GET', '/api/lobbies')).body.lobbies;
    assert.deepEqual(row, {
      id: 1, t: START, who: 'Nathan', result: 'normal', verdict: 'unknown', view: 'global',
      share: null, globalShare: null, amShare: null, lbUpdatedAt: null,
    });
  });

  test('accepts the edges of valid input', async () => {
    const env = makeEnv();
    const accepted = [
      lobby({ who: 'x'.repeat(24), share: 0, globalShare: 1, amShare: 0.5 }),
      lobby({ who: '🎸'.repeat(24) }), // 24 characters, 48 UTF-16 units
      lobby({ who: 'A', lbUpdatedAt: '2026-10-05T17:28:51.123Z' }),
      lobby({ who: 'B', lbUpdatedAt: '2026-10-05T17:28:51.123456+00:00' }),
      ...['queue', 'coin', 'wait', 'calibrating', 'stale', 'unknown']
        .map((verdict) => lobby({ who: `v-${verdict}`, verdict, result: 'normal', view: 'global' })),
    ];
    for (const body of accepted) {
      const res = await call(env, 'POST', '/api/lobby', { body });
      assert.equal(res.status, 201, JSON.stringify(body));
    }
  });

  const invalid = [
    ['result', { result: 'spicy' }],
    ['result', { result: 'Sweaty' }],
    ['result', { result: undefined }],
    ['verdict', { verdict: 'great' }],
    ['verdict', { verdict: undefined }],
    ['view', { view: 'eu' }],
    ['view', { view: undefined }],
    ['share', { share: 1.5 }],
    ['share', { share: -0.01 }],
    ['share', { share: '0.5' }],
    ['share', { share: true }],
    ['share', { share: {} }],
    ['globalShare', { globalShare: 2 }],
    ['amShare', { amShare: 'high' }],
    ['who', { who: '' }],
    ['who', { who: '    ' }],
    ['who', { who: 'x'.repeat(25) }],
    ['who', { who: 7 }],
    ['who', { who: undefined }],
    ['who', { who: 'Na\u0007than' }],
    ['lbUpdatedAt', { lbUpdatedAt: 'yesterday' }],
    ['lbUpdatedAt', { lbUpdatedAt: 1791221331 }],
    ['lbUpdatedAt', { lbUpdatedAt: '2026-10-05' }],
    ['lbUpdatedAt', { lbUpdatedAt: '2026-13-45T99:99:99Z' }],
  ];
  for (const [field, change] of invalid) {
    test(`400 for bad ${field}: ${JSON.stringify(change)}`, async () => {
      const env = makeEnv();
      const res = await call(env, 'POST', '/api/lobby', { body: lobby(change) });
      assert.equal(res.status, 400);
      assert.match(res.body.error, new RegExp(`^${field} `));
      assert.equal(env.DB.rows.length, 0);
    });
  }

  test('400 for a non-finite share (1e999 parses to Infinity)', async () => {
    const raw = JSON.stringify(lobby()).replace('"share":0.152', '"share":1e999');
    const res = await call(makeEnv(), 'POST', '/api/lobby', { body: raw });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /^share /);
  });

  for (const [label, raw, message] of [
    ['not JSON', '{"who": "Nathan",', 'body must be JSON'],
    ['empty', '', 'body must be JSON'],
    ['an array', '[]', 'body must be a JSON object'],
    ['null', 'null', 'body must be a JSON object'],
    ['a string', '"sweaty"', 'body must be a JSON object'],
  ]) {
    test(`400 when the body is ${label}`, async () => {
      const res = await call(makeEnv(), 'POST', '/api/lobby', { body: raw });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: message });
    });
  }

  test('a body just under 2 KB is fine; over 2 KB gets 413', async () => {
    const env = makeEnv();
    const padTo = (bytes) => {
      const base = JSON.stringify(lobby({ pad: '' }));
      return JSON.stringify(lobby({ pad: 'x'.repeat(bytes - base.length) }));
    };
    assert.equal(padTo(2048).length, 2048);
    assert.equal((await call(env, 'POST', '/api/lobby', { body: padTo(2048) })).status, 201);

    const res = await call(env, 'POST', '/api/lobby', { body: padTo(2049) });
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: 'body too large' });
    assert.equal(env.DB.rows.length, 1);
  });

  test('413 for a streamed body with no Content-Length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1000));
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request(`${BASE}/api/lobby`, {
      method: 'POST',
      headers: { 'X-Squad-Code': CODE },
      body: stream,
      duplex: 'half',
    });
    assert.equal(request.headers.get('Content-Length'), null);
    const res = await worker.fetch(request, makeEnv(), makeCtx());
    assert.equal(res.status, 413);
    assert.ok(sent < 10, 'stopped reading early');
  });
});

describe('rate limit', () => {
  test('same who within 30 s gets 429 with retryAfter', async () => {
    const env = makeEnv();
    assert.equal((await call(env, 'POST', '/api/lobby', { body: lobby() })).status, 201);

    now = START + 10;
    let res = await call(env, 'POST', '/api/lobby', { body: lobby({ result: 'normal' }) });
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: 'too soon', retryAfter: 20 });
    assert.equal(res.headers.get('Retry-After'), '20');

    now = START + 29;
    res = await call(env, 'POST', '/api/lobby', { body: lobby() });
    assert.equal(res.status, 429);
    assert.equal(res.body.retryAfter, 1);
    assert.equal(env.DB.rows.length, 1);
  });

  test('who is trimmed before the check', async () => {
    const env = makeEnv();
    await call(env, 'POST', '/api/lobby', { body: lobby() });
    now = START + 5;
    const res = await call(env, 'POST', '/api/lobby', { body: lobby({ who: ' Nathan ' }) });
    assert.equal(res.status, 429);
  });

  test('another who can post meanwhile, and the same who can post again at 30 s', async () => {
    const env = makeEnv();
    await call(env, 'POST', '/api/lobby', { body: lobby() });

    now = START + 1;
    assert.equal((await call(env, 'POST', '/api/lobby', { body: lobby({ who: 'Friend' }) })).status, 201);

    now = START + 30;
    const res = await call(env, 'POST', '/api/lobby', { body: lobby() });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { id: 3, t: START + 30 });
  });
});

describe('GET /api/lobbies', () => {
  async function seed(env) {
    for (const [offset, who] of [[0, 'Nathan'], [60, 'Friend'], [120, 'Nathan']]) {
      now = START + offset;
      await call(env, 'POST', '/api/lobby', { body: lobby({ who }) });
    }
  }

  test('empty log', async () => {
    const res = await call(makeEnv(), 'GET', '/api/lobbies');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { lobbies: [] });
  });

  test('returns every row oldest first without since', async () => {
    const env = makeEnv();
    await seed(env);
    const res = await call(env, 'GET', '/api/lobbies');
    assert.deepEqual(res.body.lobbies.map((row) => [row.id, row.t, row.who]), [
      [1, START, 'Nathan'],
      [2, START + 60, 'Friend'],
      [3, START + 120, 'Nathan'],
    ]);
  });

  test('since filters by t (inclusive)', async () => {
    const env = makeEnv();
    await seed(env);
    const ids = async (since) => (await call(env, 'GET', `/api/lobbies?since=${since}`)).body.lobbies.map((row) => row.id);
    assert.deepEqual(await ids(0), [1, 2, 3]);
    assert.deepEqual(await ids(START + 60), [2, 3]);
    assert.deepEqual(await ids(START + 61), [3]);
    assert.deepEqual(await ids(START + 121), []);
  });

  for (const since of ['abc', '-5', '1.5', '', '1e9']) {
    test(`400 for since=${JSON.stringify(since)}`, async () => {
      const res = await call(makeEnv(), 'GET', `/api/lobbies?since=${since}`);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'since must be unix seconds' });
    });
  }
});

describe('DELETE /api/lobby/:id', () => {
  test('deletes a row (undo), then 404 the second time', async () => {
    const env = makeEnv();
    await call(env, 'POST', '/api/lobby', { body: lobby() });
    now = START + 60;
    const { body: { id } } = await call(env, 'POST', '/api/lobby', { body: lobby({ who: 'Friend' }) });

    const res = await call(env, 'DELETE', `/api/lobby/${id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const left = (await call(env, 'GET', '/api/lobbies')).body.lobbies;
    assert.deepEqual(left.map((row) => row.who), ['Nathan']);

    const again = await call(env, 'DELETE', `/api/lobby/${id}`);
    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { error: 'not found' });
  });

  test('404 for an unknown or non-numeric id', async () => {
    const env = makeEnv();
    assert.equal((await call(env, 'DELETE', '/api/lobby/999')).status, 404);
    assert.equal((await call(env, 'DELETE', '/api/lobby/abc')).status, 404);
    assert.equal((await call(env, 'DELETE', '/api/lobby/')).status, 404);
  });
});

describe('routing', () => {
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/nope'],
    ['GET', '/api/lobby'],
    ['PUT', '/api/lobby'],
    ['POST', '/api/ping'],
    ['GET', '/api/lobbies/1'],
  ]) {
    test(`404 JSON for ${method} ${path}`, async () => {
      const res = await call(makeEnv(), method, path);
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: 'not found' });
      assert.match(res.headers.get('Content-Type'), /^application\/json/);
    });
  }

  test('a database failure becomes a logged 500 JSON error', async () => {
    const errors = mock.method(console, 'error', () => {});
    const env = makeEnv({ DB: { prepare() { throw new Error('D1 is down'); } } });
    const res = await call(env, 'GET', '/api/lobbies', { origin: PAGES });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'server error' });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGES);
    assert.equal(errors.mock.callCount(), 1);
  });
});

describe('cron', () => {
  const event = { cron: '*/10 * * * *', scheduledTime: START * 1000 };

  test('asks GitHub to run the collect workflow', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const errors = mock.method(console, 'error', () => {});
    const ctx = makeCtx();

    await worker.scheduled(event, makeEnv({ GITHUB_TOKEN: 'github_pat_test' }), ctx);
    assert.equal(ctx.pending.length, 1, 'work is handed to ctx.waitUntil');
    await Promise.all(ctx.pending);

    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://api.github.com/repos/natanforestree/finals-radar/actions/workflows/collect.yml/dispatches');
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer github_pat_test');
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2022-11-28');
    assert.ok(headers.get('User-Agent'));
    assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
    assert.equal(errors.mock.callCount(), 0);
  });

  test('takes the repo and workflow from vars', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const ctx = makeCtx();
    const env = makeEnv({ GITHUB_TOKEN: 't', GITHUB_REPO: 'someone/fork', GITHUB_WORKFLOW: 'other.yml' });
    await worker.scheduled(event, env, ctx);
    await Promise.all(ctx.pending);
    assert.equal(fetchMock.mock.calls[0].arguments[0],
      'https://api.github.com/repos/someone/fork/actions/workflows/other.yml/dispatches');
  });

  test('skips quietly without GITHUB_TOKEN', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const errors = mock.method(console, 'error', () => {});
    const logs = mock.method(console, 'log', () => {});
    const ctx = makeCtx();
    await worker.scheduled(event, makeEnv(), ctx);
    await Promise.all(ctx.pending);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(errors.mock.callCount(), 0);
    assert.equal(logs.mock.callCount(), 0);
  });

  test('logs the status when GitHub refuses', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response('{"message":"Bad credentials"}', { status: 401 }));
    const errors = mock.method(console, 'error', () => {});
    const ctx = makeCtx();
    await worker.scheduled(event, makeEnv({ GITHUB_TOKEN: 'expired' }), ctx);
    await Promise.all(ctx.pending);
    assert.equal(errors.mock.callCount(), 1);
    const message = errors.mock.calls[0].arguments.join(' ');
    assert.match(message, /401/);
    assert.match(message, /Bad credentials/);
  });

  test('logs a network error instead of throwing', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
    const errors = mock.method(console, 'error', () => {});
    const ctx = makeCtx();
    await worker.scheduled(event, makeEnv({ GITHUB_TOKEN: 't' }), ctx);
    await assert.doesNotReject(Promise.all(ctx.pending));
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(' '), /fetch failed/);
  });

  const RENO = { RENO_TODAY_REPO: 'natanforestree/reno-today', RENO_TODAY_WORKFLOW: 'collect.yml' };
  const tick = (minute) => ({ cron: '*/10 * * * *', scheduledTime: Date.UTC(2026, 9, 5, 21, minute) });
  const RUBY_URL = 'https://api.github.com/repos/natanforestree/finals-radar/actions/workflows/collect.yml/dispatches';
  const RENO_URL = 'https://api.github.com/repos/natanforestree/reno-today/actions/workflows/collect.yml/dispatches';

  test('also runs Reno Today on the :30 tick', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const ctx = makeCtx();
    await worker.scheduled(tick(30), makeEnv({ GITHUB_TOKEN: 't', ...RENO }), ctx);
    assert.equal(ctx.pending.length, 1);
    await Promise.all(ctx.pending);
    assert.deepEqual(fetchMock.mock.calls.map((c) => c.arguments[0]).sort(), [RUBY_URL, RENO_URL]);
  });

  test('leaves Reno Today alone on the other ticks', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    for (const minute of [0, 10, 20, 40, 50]) {
      const ctx = makeCtx();
      await worker.scheduled(tick(minute), makeEnv({ GITHUB_TOKEN: 't', ...RENO }), ctx);
      await Promise.all(ctx.pending);
    }
    assert.deepEqual([...new Set(fetchMock.mock.calls.map((c) => c.arguments[0]))], [RUBY_URL]);
  });

  test('skips Reno Today when its repo var is missing', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const ctx = makeCtx();
    await worker.scheduled(tick(30), makeEnv({ GITHUB_TOKEN: 't' }), ctx);
    await Promise.all(ctx.pending);
    assert.deepEqual(fetchMock.mock.calls.map((c) => c.arguments[0]), [RUBY_URL]);
  });

  test('a Reno Today failure is logged with its repo and does not stop Ruby Radar', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async (url) =>
      url === RENO_URL ? new Response('{"message":"Not Found"}', { status: 404 }) : new Response(null, { status: 204 }));
    const errors = mock.method(console, 'error', () => {});
    const ctx = makeCtx();
    await worker.scheduled(tick(30), makeEnv({ GITHUB_TOKEN: 't', ...RENO }), ctx);
    await Promise.all(ctx.pending);
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(' '), /reno-today.*404/);
  });
});

// ---- Visitor counter (public, no squad code) --------------------------------

describe('visitor counter', () => {
  // Noon on 2026-10-04 in Reno (PDT, UTC-7).
  beforeEach(() => { now = Date.UTC(2026, 9, 4, 19, 0, 0) / 1000; });
  const DAY = 86400;
  const visit = (env, site = 'reno-today', extra = {}) => call(env, 'POST', `/api/visit/${site}`, { code: null, ...extra });
  const visits = (env, query = '', site = 'reno-today', extra = {}) =>
    call(env, 'GET', `/api/visits/${site}${query}`, { code: null, ...extra });

  test('POST counts a visit: 204, no body, no squad code needed', async () => {
    const env = makeEnv();
    const res = await visit(env);
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
    assert.deepEqual(env.DB.visits, [{ site: 'reno-today', day: '2026-10-04', count: 1 }]);
  });

  test('POST increments the same day', async () => {
    const env = makeEnv();
    await visit(env);
    await visit(env);
    await visit(env);
    assert.deepEqual(env.DB.visits, [{ site: 'reno-today', day: '2026-10-04', count: 3 }]);
  });

  test('the day is the Reno date, not the UTC date', async () => {
    const env = makeEnv();
    now = Date.UTC(2026, 9, 5, 5, 0, 0) / 1000; // 05:00 UTC = 22:00 Oct 4 in Reno
    await visit(env);
    now = Date.UTC(2026, 9, 5, 8, 0, 0) / 1000; // 01:00 Oct 5 in Reno
    await visit(env);
    assert.deepEqual(env.DB.visits.map((v) => v.day), ['2026-10-04', '2026-10-05']);
  });

  test('a new day starts a new row', async () => {
    const env = makeEnv();
    await visit(env);
    now += DAY;
    await visit(env);
    assert.deepEqual(env.DB.visits.map((v) => [v.day, v.count]), [['2026-10-04', 1], ['2026-10-05', 1]]);
  });

  test('unknown site is 404 and writes nothing', async () => {
    const env = makeEnv();
    const res = await visit(env, 'nope');
    assert.equal(res.status, 404);
    assert.equal(env.DB.visits.length, 0);
    assert.equal((await visits(env, '', 'nope')).status, 404);
  });

  test('only site, day and count are stored (bound values asserted)', async () => {
    const env = makeEnv();
    const bound = [];
    const prepare = env.DB.prepare;
    env.DB.prepare = (sql) => {
      const stmt = prepare(sql);
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...params) => { bound.push(params); return bind(...params); };
      return stmt;
    };
    await visit(env, 'reno-today', {
      origin: PAGES,
      headers: { 'User-Agent': 'secret-agent', 'CF-Connecting-IP': '203.0.113.9', Referer: 'https://x.example/' },
    });
    assert.deepEqual(bound, [['reno-today', '2026-10-04']]);
    assert.deepEqual(Object.keys(env.DB.visits[0]), ['site', 'day', 'count']);
  });

  test('GET returns the last N days oldest to newest, zero-filled', async () => {
    const env = makeEnv();
    await visit(env);
    await visit(env);
    now += 2 * DAY;
    await visit(env);
    const res = await visits(env, '?days=4');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      site: 'reno-today',
      days: [
        { day: '2026-10-03', count: 0 },
        { day: '2026-10-04', count: 2 },
        { day: '2026-10-05', count: 0 },
        { day: '2026-10-06', count: 1 },
      ],
    });
  });

  test('GET defaults to 7 days and spans a month boundary', async () => {
    const env = makeEnv();
    now = Date.UTC(2026, 10, 3, 20, 0, 0) / 1000; // Nov 3 in Reno
    const res = await visits(env);
    assert.equal(res.body.days.length, 7);
    assert.equal(res.body.days[0].day, '2026-10-28');
    assert.equal(res.body.days[6].day, '2026-11-03');
    assert.ok(res.body.days.every((d) => d.count === 0));
  });

  test('GET days bounds: 1..31 ok, otherwise 400', async () => {
    const env = makeEnv();
    assert.equal((await visits(env, '?days=1')).body.days.length, 1);
    assert.equal((await visits(env, '?days=31')).body.days.length, 31);
    for (const bad of ['0', '32', '-1', 'abc', '1.5', '', '7x']) {
      assert.equal((await visits(env, `?days=${bad}`)).status, 400, bad);
    }
  });

  test('GET is per site and never exposes anything but day and count', async () => {
    const env = makeEnv();
    await visit(env);
    const res = await visits(env, '?days=1');
    assert.deepEqual(Object.keys(res.body), ['site', 'days']);
    assert.deepEqual(Object.keys(res.body.days[0]), ['day', 'count']);
  });

  test('lobby routes still need the squad code', async () => {
    const env = makeEnv();
    assert.equal((await call(env, 'GET', '/api/lobbies', { code: null })).status, 401);
    assert.equal((await call(env, 'GET', '/api/ping', { code: null })).status, 401);
    assert.equal((await call(env, 'POST', '/api/lobby', { code: null, body: lobby() })).status, 401);
  });

  for (const origin of ['https://renotoday.com', 'https://www.renotoday.com', PAGES]) {
    test(`CORS: POST and GET from ${origin}`, async () => {
      const env = makeEnv();
      const post = await visit(env, 'reno-today', { origin });
      assert.equal(post.status, 204);
      assert.equal(post.headers.get('Access-Control-Allow-Origin'), origin);
      const get = await visits(env, '', 'reno-today', { origin });
      assert.equal(get.headers.get('Access-Control-Allow-Origin'), origin);
    });

    test(`CORS: preflight from ${origin} needs no squad code`, async () => {
      const res = await call(makeEnv(), 'OPTIONS', '/api/visit/reno-today', {
        code: null,
        origin,
        headers: { 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
    });
  }

  for (const origin of ['http://renotoday.com', 'https://evil.renotoday.com', 'https://renotoday.com.evil.example', 'https://renotoday.com:8443']) {
    test(`CORS: ${origin} is not allowed`, async () => {
      const res = await visit(makeEnv(), 'reno-today', { origin });
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    });
  }
});

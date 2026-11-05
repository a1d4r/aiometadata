/*
 * Run without network or a real key:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/kinoApi.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  applyView,
  freshnessTier,
  mergeRow,
  projectView,
  retryAfterMs,
  sourceOf,
  ttlFor,
  withKinoApi,
  TIER_TTL_MS,
  VIEW_VERSION,
  type StoredRow,
} from './kinoApi';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

describe('sourceOf', () => {
  test('TMDB id with the kind of the tile', () => {
    assert.deepEqual(sourceOf({ type: 'movie', _tmdbId: 550, imdb_id: 'tt0137523' }), { k: 'tmdb:movie:550', source: 'tmdb', id: '550', type: 'movie' });
    assert.deepEqual(sourceOf({ type: 'series', _tmdbId: '1399' }), { k: 'tmdb:tv:1399', source: 'tmdb', id: '1399', type: 'tv' });
  });

  test('IMDb id when there is no TMDB id', () => {
    assert.deepEqual(sourceOf({ type: 'series', imdb_id: 'tt0944947' }), { k: 'imdb:tt0944947', source: 'imdb', id: 'tt0944947', type: 'tv' });
    assert.equal(sourceOf({ type: 'movie', id: 'tt0137523' })?.k, 'imdb:tt0137523');
    assert.equal(sourceOf({ type: 'movie', _tmdbId: 'abc', id: 'tt0137523' })?.k, 'imdb:tt0137523');
  });

  test('TMDB id from a tmdb: id when there is no _tmdbId', () => {
    assert.deepEqual(sourceOf({ type: 'series', id: 'tmdb:1399', imdb_id: 'tt0944947' }), { k: 'tmdb:tv:1399', source: 'tmdb', id: '1399', type: 'tv' });
  });

  test('nothing to ask for', () => {
    assert.equal(sourceOf({ type: 'movie', id: 'mal:1' }), null);
    assert.equal(sourceOf({ type: 'tv', _tmdbId: '1' }), null);
    assert.equal(sourceOf(null), null);
  });
});

describe('projectView', () => {
  test('rating with one decimal, votes only with a rating', () => {
    assert.deepEqual(projectView({ ratings: { kinopoisk: { value: 7.94, votes: 12345 } } }), { kpRating: '7.9', kpVotes: 12345 });
    assert.deepEqual(projectView({ ratings: { kinopoisk: { value: 7, votes: 3 } } }), { kpRating: '7.0', kpVotes: 3 });
    assert.deepEqual(projectView({ ratings: { kinopoisk: { value: 0, votes: 50 } } }), {});
    assert.deepEqual(projectView({ ratings: { kinopoisk: { value: null } } }), {});
  });

  test('Kinopoisk id only as digits', () => {
    assert.equal(projectView({ id: { kinopoisk: 326 } }).kpId, '326');
    assert.equal(projectView({ id: { kinopoisk: '326x' } }).kpId, undefined);
  });

  test('short description cut to 300 characters', () => {
    assert.equal(projectView({ description: { short: '  Одна  фраза. ' } }).shortDescription, 'Одна фраза.');
    assert.equal(Array.from(projectView({ description: { short: 'я'.repeat(500) } }).shortDescription!).length, 300);
    assert.equal(projectView({ description: { short: '   ' } }).shortDescription, undefined);
  });

  test('voiceovers without empties and repeats, at most 30 of at most 60 characters', () => {
    const view = projectView({ voiceovers: ['Гоблин', '', '  ', 'гоблин', null, { name: 'Кубик в Кубе' }, 'x'.repeat(80)] });
    assert.deepEqual(view.voiceovers, ['Гоблин', 'Кубик в Кубе', 'x'.repeat(60)]);
    const many = projectView({ voiceovers: Array.from({ length: 40 }, (_, i) => `Студия ${i}`) });
    assert.equal(many.voiceovers!.length, 30);
    assert.equal(projectView({ voiceovers: [] }).voiceovers, undefined);
  });

  test('age only like 16+', () => {
    assert.equal(projectView({ release: { ageRating: '16+' } }).age, '16+');
    assert.equal(projectView({ release: { ageRating: '0+' } }).age, '0+');
    assert.equal(projectView({ release: { ageRating: 'R' } }).age, undefined);
    assert.equal(projectView({ release: { ageRating: '160+' } }).age, undefined);
  });

  test('English title is never taken', () => {
    assert.deepEqual(projectView({ title: { en: 'Бойцовский клуб' } }), {});
  });
});

describe('freshnessTier and ttlFor', () => {
  test('movies', () => {
    assert.equal(freshnessTier({ type: 'movie' }, NOW), 'day');
    assert.equal(freshnessTier({ type: 'movie', released: daysAgo(10) }, NOW), 'day');
    assert.equal(freshnessTier({ type: 'movie', released: daysAgo(-20) }, NOW), 'day');
    assert.equal(freshnessTier({ type: 'movie', released: daysAgo(100) }, NOW), 'week');
    assert.equal(freshnessTier({ type: 'movie', released: daysAgo(400) }, NOW), 'month');
  });

  test('movie release as a Date or a number, as catalog tiles carry it', () => {
    assert.equal(freshnessTier({ type: 'movie', released: new Date('2014-11-04') }, NOW), 'month');
    assert.equal(freshnessTier({ type: 'movie', released: new Date(daysAgo(100)) }, NOW), 'week');
    assert.equal(freshnessTier({ type: 'movie', released: Date.parse('2014-11-04') }, NOW), 'month');
    assert.equal(freshnessTier({ type: 'movie', released: new Date('nope') }, NOW), 'day');
  });

  test('series', () => {
    assert.equal(freshnessTier({ type: 'series', releaseInfo: '2024-' }, NOW), 'day');
    assert.equal(freshnessTier({ type: 'series', releaseInfo: '2019-2023', status: 'Returning Series' }, NOW), 'day');
    assert.equal(freshnessTier({ type: 'series', releaseInfo: '2024-2026', status: 'Ended' }, NOW), 'week');
    assert.equal(freshnessTier({ type: 'series', releaseInfo: '2019-2023', status: 'Ended' }, NOW), 'month');
    assert.equal(freshnessTier({ type: 'series', releaseInfo: '2020' }, NOW), 'month');
    assert.equal(freshnessTier({ type: 'series' }, NOW), 'day');
  });

  test('a day for titles not found or with neither rating nor voiceovers', () => {
    assert.equal(ttlFor('month', null), DAY);
    assert.equal(ttlFor('month', { kpId: '1', shortDescription: 'x' }), DAY);
    assert.equal(ttlFor('month', { kpRating: '7.0' }), TIER_TTL_MS.month);
    assert.equal(ttlFor('week', { voiceovers: ['Гоблин'] }), TIER_TTL_MS.week);
  });
});

describe('mergeRow', () => {
  const good = mergeRow('tmdb:movie:550', undefined, { ratings: { kinopoisk: { value: 8.7, votes: 900 } } }, 'month', NOW);

  test('a found title stores raw and view', () => {
    assert.equal(good.found, 1);
    assert.equal(good.view_v, VIEW_VERSION);
    assert.deepEqual(JSON.parse(good.view!), { kpRating: '8.7', kpVotes: 900 });
    assert.equal(good.expires_at, NOW + TIER_TTL_MS.month);
  });

  test('null after data keeps the data and asks again in a day', () => {
    const later = NOW + 40 * DAY;
    const row = mergeRow('tmdb:movie:550', good, null, 'month', later);
    assert.equal(row.found, 1);
    assert.equal(row.raw, good.raw);
    assert.equal(row.view, good.view);
    assert.equal(row.fetched_at, good.fetched_at);
    assert.equal(row.expires_at, later + DAY);
  });

  test('an empty object, an array or a string counts as null', () => {
    for (const raw of [{}, [], 'x', 0]) {
      const row = mergeRow('tmdb:movie:550', good, raw, 'month', NOW + DAY);
      assert.equal(row.raw, good.raw);
      assert.equal(row.found, 1);
      assert.equal(row.expires_at, NOW + 2 * DAY);
      assert.equal(mergeRow('imdb:tt2', undefined, raw, 'month', NOW).found, 0);
    }
  });

  test('null without data is stored as not found for a day', () => {
    const row = mergeRow('imdb:tt1', undefined, null, 'month', NOW);
    assert.deepEqual([row.found, row.raw, row.view, row.expires_at], [0, null, null, NOW + DAY]);
    const again = mergeRow('imdb:tt1', row, null, 'month', NOW + 2 * DAY);
    assert.equal(again.found, 0);
  });
});

describe('applyView', () => {
  test('copies the tile and leaves the original alone', () => {
    const meta = { id: 'tt1', type: 'movie', app_extras: { certifications: { US: 'R' }, seasonPosters: [] } };
    const snapshot = structuredClone(meta);
    const next = applyView(meta, { kpRating: '7.9', kpVotes: 10, voiceovers: ['Гоблин'], age: '18+' });
    assert.deepEqual(meta, snapshot);
    assert.notEqual(next, meta);
    assert.notEqual(next.app_extras, meta.app_extras);
    assert.deepEqual(next.app_extras, { certifications: { US: 'R', RU: '18+' }, seasonPosters: [] });
    assert.equal(next.kpRating, '7.9');
  });

  test('a Russian age already known is kept', () => {
    const meta = { id: 'tt1', type: 'movie', app_extras: { certifications: { RU: '16+' } } };
    const next = applyView(meta, { age: '18+' });
    assert.equal(next, meta);
    assert.equal(applyView({ type: 'movie' }, { age: '12+' }).app_extras.certifications.RU, '12+');
  });

  test('nothing to add returns the same tile', () => {
    const meta = { id: 'tt1' };
    assert.equal(applyView(meta, {}), meta);
    assert.equal(applyView(meta, null), meta);
  });
});

test('retryAfterMs', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs(''), 30_000);
  assert.equal(retryAfterMs(null), 30_000);
  assert.equal(retryAfterMs('soon'), 30_000);
  assert.equal(retryAfterMs(new Date(NOW + 5000).toUTCString(), NOW), 5000);
});

// ---------------------------------------------------------------------------
// Queue and store, with a stand-in for fetch and a temporary database
// ---------------------------------------------------------------------------

// The real settings service needs the addon database and the request tracker needs Redis:
// here the key comes from the environment only, and calls are not counted.
const stub = (name: string, exports: object) => {
  const Module = require('node:module');
  const file = require.resolve(name);
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[file] = mod;
};
stub('./settingsService', { getSetting: (key: string) => process.env[key] ?? '' });
stub('./requestTracker', { trackProviderCall: () => undefined });

const tiles = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `tt${from + i}`, type: 'movie', _tmdbId: String(from + i), released: '2001-01-01' }));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  at: number;
  auth: string | null;
  items: Array<{ source: string; id: string; type: string }>;
}

describe('withKinoApi', () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoapi-test-'));
  const dbFile = path.join(dir, 'addon', 'data', 'kinoapi.sqlite');
  let calls: Call[] = [];
  let answer: (call: Call) => Promise<Response> | Response;

  const titleFor = (item: { id: string }) => ({ id: { kinopoisk: 100 + Number(item.id.replace(/\D/g, '')) }, ratings: { kinopoisk: { value: 7.25, votes: 42 } }, voiceovers: ['Дублированный'] });
  const ok = (call: Call) => Response.json({ data: call.items.map(titleFor), meta: { requested: call.items.length, found: call.items.length } });
  const sql = () => new BetterSqlite3(dbFile);

  before(() => {
    process.chdir(dir);
    globalThis.fetch = (async (_url: any, init: any) => {
      const call: Call = { at: Date.now(), auth: new Headers(init.headers).get('Authorization'), items: JSON.parse(init.body).items };
      calls.push(call);
      return answer(call);
    }) as typeof fetch;
    answer = ok;
  });

  after(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
    delete process.env.KINOAPI_API_KEY;
    delete process.env.KINOAPI_CATALOG_WAIT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('without a key the tiles come back as they are and no file is opened', async () => {
    delete process.env.KINOAPI_API_KEY;
    const metas = tiles(1, 3);
    assert.equal(await withKinoApi(metas), metas);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(dbFile), false);
    process.env.KINOAPI_API_KEY = 'test-key';
  });

  test('missing titles are asked for in batches of at most 50 and waited for', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '3000';
    const metas = tiles(1000, 120);
    const out = await withKinoApi(metas);
    assert.deepEqual(calls.map((call) => call.items.length).sort((a, b) => b - a), [50, 50, 20]);
    assert.ok(calls.every((call) => call.auth === 'Bearer test-key'));
    assert.deepEqual(calls[0].items[0], { source: 'tmdb', id: '1000', type: 'movie' });
    const starts = calls.map((call) => call.at).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 180, `requests ${starts[i] - starts[i - 1]} ms apart`);
    assert.equal(out.filter((meta) => meta.kpRating === '7.3' && meta.kpVotes === 42).length, 120);
    assert.equal((metas[0] as any).kpRating, undefined);
  });

  test('stored titles are read from SQLite without a request', async () => {
    calls = [];
    const out = await withKinoApi(tiles(1000, 5));
    assert.equal(calls.length, 0);
    assert.equal(out[4].kpId, String(100 + 1004));
  });

  test('the same title asked for at once goes out once', async () => {
    calls = [];
    const page = [...tiles(2000, 3), { id: 'tt2000', type: 'movie', _tmdbId: '2000' }];
    const [a, b] = await Promise.all([withKinoApi(page), withKinoApi(tiles(2000, 3))]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].items.map((item) => item.id), ['2000', '2001', '2002']);
    assert.equal(a[3].kpRating, '7.3');
    assert.equal(b[0].kpRating, '7.3');
  });

  test('a response waits no longer than KINOAPI_CATALOG_WAIT_MS', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '300';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answer = async (call) => {
      await gate;
      return ok(call);
    };
    const started = Date.now();
    const out = await withKinoApi(tiles(3000, 2));
    const took = Date.now() - started;
    release();
    assert.ok(took >= 290 && took < 700, `waited ${took} ms`);
    assert.equal(out[0].kpRating, undefined);
    await pause(100);
    answer = ok;
    process.env.KINOAPI_CATALOG_WAIT_MS = '0';
    assert.equal((await withKinoApi(tiles(3000, 2)))[0].kpRating, '7.3');
    assert.equal(calls.length, 1);
  });

  test('wait 0 never waits', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '0';
    const out = await withKinoApi(tiles(3500, 1));
    assert.equal(out[0].kpRating, undefined);
    await pause(400);
    assert.equal(calls.length, 1);
    assert.equal((await withKinoApi(tiles(3500, 1)))[0].kpRating, '7.3');
  });

  test('an outdated projection is rebuilt from raw without a request', async () => {
    calls = [];
    const db = sql();
    db.prepare(`UPDATE kino_titles SET view = '{}', view_v = 0 WHERE k = 'tmdb:movie:1000'`).run();
    db.close();
    const out = await withKinoApi(tiles(1000, 1));
    assert.equal(calls.length, 0);
    assert.equal(out[0].kpRating, '7.3');
    const check = sql();
    const row = check.prepare(`SELECT view_v FROM kino_titles WHERE k = 'tmdb:movie:1000'`).get() as { view_v: number };
    check.close();
    assert.equal(row.view_v, VIEW_VERSION);
  });

  test('stale data is served as is; null keeps the last good data', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '3000';
    const db = sql();
    db.prepare(`UPDATE kino_titles SET expires_at = 0 WHERE k = 'tmdb:movie:1001'`).run();
    db.close();
    answer = (call) => Response.json({ data: call.items.map(() => null), meta: { requested: call.items.length, found: 0 } });
    const started = Date.now();
    const out = await withKinoApi(tiles(1001, 1));
    assert.ok(Date.now() - started < 300, 'stale titles do not wait');
    assert.equal(out[0].kpRating, '7.3');
    await pause(400);
    assert.equal(calls.length, 1);
    const check = sql();
    const row = check.prepare(`SELECT * FROM kino_titles WHERE k = 'tmdb:movie:1001'`).get() as StoredRow;
    check.close();
    assert.equal(row.found, 1);
    assert.ok(row.raw && JSON.parse(row.view!).kpRating === '7.3');
    assert.ok(Math.abs(row.expires_at - (Date.now() + DAY)) < 5000);
    answer = ok;
  });

  test('429 pauses for Retry-After and leaves the rows alone', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '300';
    answer = () => new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
    const first = await withKinoApi(tiles(4000, 2));
    const limitedAt = calls[0].at;
    assert.equal(first[0].kpRating, undefined);
    assert.equal(calls.length, 1);

    calls = [];
    answer = ok;
    process.env.KINOAPI_CATALOG_WAIT_MS = '3000';
    assert.equal((await withKinoApi(tiles(4000, 2)))[0].kpRating, undefined, 'failed titles are not asked again for 120 s');
    assert.equal(calls.length, 0);

    const next = await withKinoApi(tiles(5000, 1));
    assert.equal(next[0].kpRating, '7.3');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].at - limitedAt >= 990, `next request ${calls[0].at - limitedAt} ms after the 429`);

    const check = sql();
    const count = check.prepare(`SELECT COUNT(*) AS n FROM kino_titles WHERE k LIKE 'tmdb:movie:400%'`).get() as { n: number };
    check.close();
    assert.equal(count.n, 0);
  });

  test('a network failure leaves the tiles as they are', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '1000';
    answer = () => {
      throw new TypeError('fetch failed');
    };
    const metas = tiles(6000, 1);
    const out = await withKinoApi(metas);
    assert.equal(out, metas);
    assert.equal(calls.length, 1);
    answer = ok;
  });

  test('a database too busy to write leaves new titles for later instead of asking again', async () => {
    calls = [];
    process.env.KINOAPI_CATALOG_WAIT_MS = '600';
    const lock = sql();
    lock.prepare('BEGIN IMMEDIATE').run();
    try {
      const started = Date.now();
      const out = await withKinoApi(tiles(7000, 3));
      assert.ok(Date.now() - started <= 700, `waited ${Date.now() - started} ms`);
      assert.equal(out[0].kpRating, undefined);
      assert.equal(calls.length, 1);
      await withKinoApi(tiles(7000, 3));
      assert.equal(calls.length, 1, 'not sent to Kino API again within 120 s');
    } finally {
      lock.prepare('ROLLBACK').run();
      lock.close();
    }
    const check = sql();
    const count = check.prepare(`SELECT COUNT(*) AS n FROM kino_titles WHERE k LIKE 'tmdb:movie:700%'`).get() as { n: number };
    check.close();
    assert.equal(count.n, 0);
  });

  test('a busy database still serves stored titles when upkeep cannot write', async () => {
    calls = [];
    const db = sql();
    db.prepare(`UPDATE kino_titles SET last_access = 0, view_v = 0 WHERE k IN ('tmdb:movie:1002', 'tmdb:movie:1003')`).run();
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      const started = Date.now();
      const out = await withKinoApi(tiles(1002, 2));
      assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
      assert.deepEqual(out.map((meta) => meta.kpRating), ['7.3', '7.3']);
      assert.equal(calls.length, 0);
    } finally {
      db.prepare('ROLLBACK').run();
      db.close();
    }
  });
});

describe('a store file that cannot be opened', () => {
  test('is not opened again for a while and leaks no file descriptors', async () => {
    const realFetch = globalThis.fetch;
    const realCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoapi-broken-'));
    let fetches = 0;
    try {
      process.chdir(dir);
      fs.mkdirSync(path.join('addon', 'data'), { recursive: true });
      fs.writeFileSync(path.join('addon', 'data', 'kinoapi.sqlite'), 'x'.repeat(4096));
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error('no network in tests');
      }) as typeof fetch;
      process.env.KINOAPI_API_KEY = 'test-key';
      process.env.KINOAPI_CATALOG_WAIT_MS = '600';
      delete require.cache[require.resolve('./kinoApi')];
      const fresh = require('./kinoApi');
      const metas = tiles(1, 1);
      assert.equal(await fresh.withKinoApi(metas), metas);
      const before = fs.readdirSync('/dev/fd').length;
      const started = Date.now();
      for (let i = 0; i < 50; i++) assert.equal(await fresh.withKinoApi(metas), metas);
      assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
      assert.equal(fs.readdirSync('/dev/fd').length, before);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = realFetch;
      process.chdir(realCwd);
      delete process.env.KINOAPI_API_KEY;
      delete process.env.KINOAPI_CATALOG_WAIT_MS;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

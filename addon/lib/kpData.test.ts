/*
 * Run without network or the kp service:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/kpData.test.ts
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
  kpItemOf,
  mergeRow,
  projectView,
  sourceOf,
  withKpData,
  yearOf,
  VIEW_VERSION,
  type StoredRow,
} from './kpData';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

describe('sourceOf', () => {
  test('TMDB id with the kind of the tile', () => {
    assert.deepEqual(sourceOf({ type: 'movie', _tmdbId: 550, imdb_id: 'tt0137523' }), { k: 'tmdb:movie:550', type: 'movie' });
    assert.deepEqual(sourceOf({ type: 'series', _tmdbId: '1399' }), { k: 'tmdb:tv:1399', type: 'tv' });
  });

  test('IMDb id when there is no TMDB id', () => {
    assert.deepEqual(sourceOf({ type: 'series', imdb_id: 'tt0944947' }), { k: 'imdb:tt0944947', type: 'tv' });
    assert.equal(sourceOf({ type: 'movie', id: 'tt0137523' })?.k, 'imdb:tt0137523');
    assert.equal(sourceOf({ type: 'movie', _tmdbId: 'abc', id: 'tt0137523' })?.k, 'imdb:tt0137523');
  });

  test('TMDB id from a tmdb: id when there is no _tmdbId', () => {
    assert.deepEqual(sourceOf({ type: 'series', id: 'tmdb:1399', imdb_id: 'tt0944947' }), { k: 'tmdb:tv:1399', type: 'tv' });
  });

  test('nothing to ask for', () => {
    assert.equal(sourceOf({ type: 'movie', id: 'mal:1' }), null);
    assert.equal(sourceOf({ type: 'tv', _tmdbId: '1' }), null);
    assert.equal(sourceOf(null), null);
    // Person pages and TVDB collections reach the meta route's lookup too; they must stay without requests.
    assert.equal(sourceOf({ type: 'movie', id: 'tvdbc:123' }), null);
    assert.equal(sourceOf({ type: 'person', id: 'tmdb:287' }), null);
  });
});

describe('projectView', () => {
  test('rating with one decimal, votes only with a rating', () => {
    assert.deepEqual(projectView({ kpRating: '7.94', kpVotes: 12345 }), { kpRating: '7.9', kpVotes: 12345 });
    assert.deepEqual(projectView({ kpRating: 7, kpVotes: 3 }), { kpRating: '7.0', kpVotes: 3 });
    assert.deepEqual(projectView({ kpRating: '0', kpVotes: 50 }), {});
    assert.deepEqual(projectView({ kpRating: null }), {});
    // Alloha's rating comes without votes.
    assert.deepEqual(projectView({ kpId: '1', kpRating: '7.4' }), { kpRating: '7.4', kpId: '1' });
  });

  test('Kinopoisk id only as digits', () => {
    assert.equal(projectView({ kpId: 326 }).kpId, '326');
    assert.equal(projectView({ kpId: '326x' }).kpId, undefined);
  });

  test('short description cut to 300 characters', () => {
    assert.equal(projectView({ shortDescription: '  Одна  фраза. ' }).shortDescription, 'Одна фраза.');
    assert.equal(Array.from(projectView({ shortDescription: 'я'.repeat(500) }).shortDescription!).length, 300);
    assert.equal(projectView({ shortDescription: '   ' }).shortDescription, undefined);
  });

  test('voiceovers without empties and repeats, at most 30 of at most 60 characters', () => {
    const view = projectView({ voiceovers: ['Гоблин', '', '  ', 'гоблин', null, { name: 'Кубик в Кубе' }, 'x'.repeat(80)] });
    assert.deepEqual(view.voiceovers, ['Гоблин', 'Кубик в Кубе', 'x'.repeat(60)]);
    const many = projectView({ voiceovers: Array.from({ length: 40 }, (_, i) => `Студия ${i}`) });
    assert.equal(many.voiceovers!.length, 30);
    assert.equal(projectView({ voiceovers: [] }).voiceovers, undefined);
  });

  test('age only like 16+', () => {
    assert.equal(projectView({ age: '16+' }).age, '16+');
    assert.equal(projectView({ age: '0+' }).age, '0+');
    assert.equal(projectView({ age: 'R' }).age, undefined);
    assert.equal(projectView({ age: '160+' }).age, undefined);
  });

  test('a whole answer, and nothing else is taken', () => {
    assert.deepEqual(
      projectView({ kpId: '326', kpRating: '9.1', kpVotes: 1_000_000, age: '16+', shortDescription: 'Про тюрьму', voiceovers: ['Дубляж'], fetched_at: 1, expires_at: 2, name: 'Побег' }),
      { kpRating: '9.1', kpVotes: 1_000_000, kpId: '326', shortDescription: 'Про тюрьму', voiceovers: ['Дубляж'], age: '16+' },
    );
  });
});

describe('the tile as the kp service gets it', () => {
  test('year from year, releaseInfo, or released as a Date, a string or a number', () => {
    assert.equal(yearOf({ year: '2008–2013' }), 2008);
    assert.equal(yearOf({ year: 2019 }), 2019);
    assert.equal(yearOf({ releaseInfo: '2024-' }), 2024);
    // Catalog tiles carry released as a Date: the year must come out of it, not "[object Date]".
    assert.equal(yearOf({ released: new Date('2026-07-15T19:00:00.000Z') }), 2026);
    assert.equal(yearOf({ released: '1994-09-23T00:00:00.000Z' }), 1994);
    assert.equal(yearOf({ released: Date.parse('2001-01-01') }), 2001);
    assert.equal(yearOf({ released: new Date('nope') }), null);
    assert.equal(yearOf({}), null);
  });

  test('both ids, the names and the countries', () => {
    const meta = {
      id: 'tt33764258', type: 'movie', _tmdbId: '1368337', imdb_id: 'tt33764258', name: 'Одиссея',
      originalTitle: 'The Odyssey', englishTitle: 'The Odyssey', released: new Date('2026-07-15T19:00:00.000Z'),
      countries: ['United Kingdom', 'United States of America'],
    };
    const source = sourceOf(meta)!;
    assert.deepEqual(kpItemOf(meta, source, 'day'), {
      k: 'tmdb:movie:1368337', type: 'movie', tmdb: '1368337', tt: 'tt33764258', name: 'Одиссея',
      original: 'The Odyssey', english: 'The Odyssey', year: 2026,
      countries: ['United Kingdom', 'United States of America'], tier: 'day',
    });
    const series = { id: 'tmdb:1396', type: 'series', country: 'United States of America, Canada', releaseInfo: '2008-2013' };
    const item = kpItemOf(series, sourceOf(series)!, 'month');
    assert.deepEqual([item.tmdb, item.tt, item.type, item.countries, item.year], ['1396', null, 'tv', ['United States of America', 'Canada'], 2008]);
  });
});

describe('freshnessTier', () => {
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
});

describe('mergeRow', () => {
  const item = {
    kpId: '326', kpRating: '9.1', kpVotes: 1_000_000, age: '16+', shortDescription: 'Про тюрьму', voiceovers: ['Дубляж'],
    fetched_at: (NOW - 10 * DAY) / 1000, expires_at: (NOW + 20 * DAY) / 1000,
  };
  const good = mergeRow('tmdb:movie:278', undefined, item, NOW)!;

  test('a found title stores the answer and its view', () => {
    assert.equal(good.found, 1);
    assert.equal(good.view_v, VIEW_VERSION);
    assert.deepEqual(JSON.parse(good.raw!), item);
    assert.deepEqual(JSON.parse(good.view!), { kpRating: '9.1', kpVotes: 1_000_000, kpId: '326', shortDescription: 'Про тюрьму', voiceovers: ['Дубляж'], age: '16+' });
  });

  test('keeps the expires_at of the service, asked again no sooner than in 2 min', () => {
    assert.equal(good.fetched_at, NOW - 10 * DAY);
    assert.equal(good.expires_at, NOW + 20 * DAY);
    const old = mergeRow('tmdb:movie:278', undefined, { ...item, expires_at: (NOW - DAY) / 1000 }, NOW)!;
    assert.equal(old.expires_at, NOW + 120_000);
    const none = mergeRow('tmdb:movie:278', undefined, { kpId: '1' }, NOW)!;
    assert.equal(none.expires_at, NOW + DAY, 'no expires_at: a day');
    const future = mergeRow('tmdb:movie:278', undefined, { ...item, fetched_at: NOW / 1000 + 3600 }, NOW)!;
    assert.equal(future.fetched_at, NOW);
  });

  test('expires_at in a wrong unit is capped', () => {
    const row = mergeRow('k', undefined, { kpId: '1', fetched_at: NOW / 1000, expires_at: NOW + DAY }, NOW)!;
    assert.equal(row.expires_at, NOW + 31 * DAY);
  });

  test('pending is not stored', () => {
    assert.equal(mergeRow('k', undefined, { pending: true }, NOW), null);
    assert.equal(mergeRow('k', good, { pending: true }, NOW), null);
  });

  test('null after data keeps the data and asks again in a day', () => {
    const later = NOW + 40 * DAY;
    const row = mergeRow('tmdb:movie:278', good, null, later)!;
    assert.equal(row.found, 1);
    assert.equal(row.raw, good.raw);
    assert.equal(row.view, good.view);
    assert.equal(row.fetched_at, good.fetched_at);
    assert.equal(row.expires_at, later + DAY);
  });

  test('an empty object, an array, a string or an answer without a kp id counts as null', () => {
    for (const raw of [{}, [], 'x', 0, { kpId: 'x' }, { kpRating: '7.0' }]) {
      const row = mergeRow('tmdb:movie:278', good, raw, NOW + DAY)!;
      assert.equal(row.raw, good.raw);
      assert.equal(row.found, 1);
      assert.equal(row.expires_at, NOW + 2 * DAY);
      assert.equal(mergeRow('imdb:tt2', undefined, raw, NOW)!.found, 0);
    }
  });

  test('null without data is stored as not found for a day', () => {
    const row = mergeRow('imdb:tt1', undefined, null, NOW)!;
    assert.deepEqual([row.found, row.raw, row.view, row.expires_at], [0, null, null, NOW + DAY]);
    const again = mergeRow('imdb:tt1', row, null, NOW + 2 * DAY)!;
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

describe('a full meta, as the meta route sends it', () => {
  // The shape of meta/series/tt0388629.json: ids stamped by getMeta, an ISO release, a status.
  const meta = {
    id: 'tt0388629',
    type: 'series',
    _tmdbId: '37854',
    _imdbId: 'tt0388629',
    imdb_id: 'tt0388629',
    released: '1999-10-20T11:00:00.000Z',
    releaseInfo: '1999-',
    status: 'Returning Series',
    app_extras: { cast: [{ name: 'Mayumi Tanaka' }], certifications: { US: 'TV-14' }, seasonPosters: ['s1.jpg'] },
  };

  test('is looked up under the same key as its tile, so a title seen in a row needs no request', () => {
    assert.equal(sourceOf(meta)?.k, sourceOf({ id: 'tt0388629', type: 'series', _tmdbId: '37854' })?.k);
    assert.equal(sourceOf(meta)?.k, 'tmdb:tv:37854');
    assert.equal(freshnessTier(meta, NOW), 'day');
    assert.equal(freshnessTier({ type: 'movie', released: '2016-12-02T01:00:00.000Z' }, NOW), 'month');
  });

  test('keeps everything else in app_extras and is copied, not changed', () => {
    const snapshot = structuredClone(meta);
    const next = applyView(meta, { kpRating: '8.5', kpVotes: 81100, kpId: '382731', age: '12+' });
    assert.deepEqual(meta, snapshot);
    assert.equal(next.app_extras.cast, meta.app_extras.cast);
    assert.deepEqual(next.app_extras.certifications, { US: 'TV-14', RU: '12+' });
    assert.deepEqual([next.kpRating, next.kpVotes, next.kpId], ['8.5', 81100, '382731']);
  });
});

// ---------------------------------------------------------------------------
// Queue and store, with a stand-in for fetch and a temporary database
// ---------------------------------------------------------------------------

// The request tracker needs Redis: here the calls are only listed.
const stub = (name: string, exports: object) => {
  const Module = require('node:module');
  const file = require.resolve(name);
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[file] = mod;
};
const tracked: string[] = [];
stub('./requestTracker', { trackProviderCall: (name: string) => tracked.push(name) });

const tiles = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `tt${from + i}`, type: 'movie', _tmdbId: String(from + i), released: '2001-01-01' }));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  at: number;
  url: string;
  auth: string | null;
  items: any[];
}

describe('withKpData', () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpdata-test-'));
  const dbFile = path.join(dir, 'addon', 'data', 'kpdata.sqlite');
  let calls: Call[] = [];
  let answer: (call: Call) => Promise<Response> | Response;

  const titleFor = (item: { tmdb: string }) => ({
    kpId: String(100 + Number(item.tmdb)), kpRating: '7.25', kpVotes: 42, voiceovers: ['Дублированный'],
    fetched_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 30 * 86_400,
  });
  const ok = (call: Call) => Response.json({ data: call.items.map(titleFor) });
  const sql = () => new BetterSqlite3(dbFile);

  before(() => {
    process.chdir(dir);
    globalThis.fetch = (async (_url: any, init: any) => {
      const call: Call = { at: Date.now(), url: String(_url), auth: new Headers(init.headers).get('Authorization'), items: JSON.parse(init.body).items };
      calls.push(call);
      return answer(call);
    }) as typeof fetch;
    answer = ok;
  });

  after(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
    delete process.env.KP_SERVICE_URL;
    delete process.env.KP_CATALOG_WAIT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('without KP_SERVICE_URL the tiles come back as they are and no file is opened', async () => {
    delete process.env.KP_SERVICE_URL;
    // Kino API's key, left over from before 24.11.2026, turns nothing on.
    process.env.KINOAPI_API_KEY = 'old-key';
    const metas = tiles(1, 3);
    assert.equal(await withKpData(metas), metas);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(dbFile), false);
    delete process.env.KINOAPI_API_KEY;
    process.env.KP_SERVICE_URL = 'http://kp:8080/';
  });

  test('missing titles are asked for in batches of at most 50 and waited for', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '3000';
    const metas = tiles(1000, 120);
    const out = await withKpData(metas);
    assert.deepEqual(calls.map((call) => call.items.length).sort((a, b) => b - a), [50, 50, 20]);
    assert.ok(calls.every((call) => call.url === 'http://kp:8080/titles' && call.auth === null));
    const first = calls.flatMap((call) => call.items).find((item) => item.k === 'tmdb:movie:1000');
    assert.deepEqual(first, {
      k: 'tmdb:movie:1000', type: 'movie', tmdb: '1000', tt: 'tt1000', name: '', original: '', english: '',
      year: 2001, countries: [], tier: 'month',
    });
    assert.ok(tracked.length === 3 && tracked.every((name) => name === 'kp'));
    const starts = calls.map((call) => call.at).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 180, `requests ${starts[i] - starts[i - 1]} ms apart`);
    assert.equal(out.filter((meta) => meta.kpRating === '7.3' && meta.kpVotes === 42).length, 120);
    assert.equal((metas[0] as any).kpRating, undefined);
  });

  test('stored titles are read from SQLite without a request', async () => {
    calls = [];
    const out = await withKpData(tiles(1000, 5));
    assert.equal(calls.length, 0);
    assert.equal(out[4].kpId, String(100 + 1004));
  });

  test('the same title asked for at once goes out once', async () => {
    calls = [];
    const page = [...tiles(2000, 3), { id: 'tt2000', type: 'movie', _tmdbId: '2000' }];
    const [a, b] = await Promise.all([withKpData(page), withKpData(tiles(2000, 3))]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].items.map((item) => item.tmdb), ['2000', '2001', '2002']);
    assert.equal(a[3].kpRating, '7.3');
    assert.equal(b[0].kpRating, '7.3');
  });

  test('a response waits no longer than KP_CATALOG_WAIT_MS', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '300';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answer = async (call) => {
      await gate;
      return ok(call);
    };
    const started = Date.now();
    const out = await withKpData(tiles(3000, 2));
    const took = Date.now() - started;
    release();
    assert.ok(took >= 290 && took < 700, `waited ${took} ms`);
    assert.equal(out[0].kpRating, undefined);
    await pause(100);
    answer = ok;
    process.env.KP_CATALOG_WAIT_MS = '0';
    assert.equal((await withKpData(tiles(3000, 2)))[0].kpRating, '7.3');
    assert.equal(calls.length, 1);
  });

  test('wait 0 never waits', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '0';
    const out = await withKpData(tiles(3500, 1));
    assert.equal(out[0].kpRating, undefined);
    await pause(400);
    assert.equal(calls.length, 1);
    assert.equal((await withKpData(tiles(3500, 1)))[0].kpRating, '7.3');
  });

  test('an outdated projection is rebuilt from raw without a request', async () => {
    calls = [];
    const db = sql();
    db.prepare(`UPDATE kino_titles SET view = '{}', view_v = 0 WHERE k = 'tmdb:movie:1000'`).run();
    db.close();
    const out = await withKpData(tiles(1000, 1));
    assert.equal(calls.length, 0);
    assert.equal(out[0].kpRating, '7.3');
    const check = sql();
    const row = check.prepare(`SELECT view_v FROM kino_titles WHERE k = 'tmdb:movie:1000'`).get() as { view_v: number };
    check.close();
    assert.equal(row.view_v, VIEW_VERSION);
  });

  test('stale data is served as is; null keeps the last good data', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '3000';
    const db = sql();
    db.prepare(`UPDATE kino_titles SET expires_at = 0 WHERE k = 'tmdb:movie:1001'`).run();
    db.close();
    answer = (call) => Response.json({ data: call.items.map(() => null) });
    const started = Date.now();
    const out = await withKpData(tiles(1001, 1));
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

  test('an error status leaves the rows alone, and the titles are not asked again for 120 s', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '300';
    answer = () => new Response('{}', { status: 500 });
    const first = await withKpData(tiles(4000, 2));
    assert.equal(first[0].kpRating, undefined);
    assert.equal(calls.length, 1);

    calls = [];
    answer = ok;
    process.env.KP_CATALOG_WAIT_MS = '3000';
    assert.equal((await withKpData(tiles(4000, 2)))[0].kpRating, undefined);
    assert.equal(calls.length, 0);
    assert.equal((await withKpData(tiles(5000, 1)))[0].kpRating, '7.3', 'other titles are asked at once');
    assert.equal(calls.length, 1);

    const check = sql();
    const count = check.prepare(`SELECT COUNT(*) AS n FROM kino_titles WHERE k LIKE 'tmdb:movie:400%'`).get() as { n: number };
    check.close();
    assert.equal(count.n, 0);
  });

  test('a network failure leaves the tiles as they are', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '1000';
    answer = () => {
      throw new TypeError('fetch failed');
    };
    const metas = tiles(6000, 1);
    const out = await withKpData(metas);
    assert.equal(out, metas);
    assert.equal(calls.length, 1);
    answer = ok;
  });

  test('pending is not stored and not asked again for 2 min; null is', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '3000';
    answer = (call) => Response.json({ data: call.items.map((x) => (x.tmdb === '6500' ? { pending: true } : null)) });
    const out = await withKpData(tiles(6500, 2));
    assert.equal(out[0].kpId, undefined);
    assert.equal(calls.length, 1);
    await withKpData(tiles(6500, 2));
    await pause(300);
    assert.equal(calls.length, 1, 'pending waits RETRY_MS, a miss a day');
    const db = sql();
    const rows = db.prepare(`SELECT k, found FROM kino_titles WHERE k IN ('tmdb:movie:6500', 'tmdb:movie:6501')`).all() as StoredRow[];
    db.close();
    assert.deepEqual(rows.map((r) => [r.k, r.found]), [['tmdb:movie:6501', 0]]);
    answer = ok;
  });

  test('a database too busy to write leaves new titles for later instead of asking again', async () => {
    calls = [];
    process.env.KP_CATALOG_WAIT_MS = '600';
    const lock = sql();
    lock.prepare('BEGIN IMMEDIATE').run();
    try {
      const started = Date.now();
      const out = await withKpData(tiles(7000, 3));
      assert.ok(Date.now() - started <= 700, `waited ${Date.now() - started} ms`);
      assert.equal(out[0].kpRating, undefined);
      assert.equal(calls.length, 1);
      await withKpData(tiles(7000, 3));
      assert.equal(calls.length, 1, 'not sent to kp again within 120 s');
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
      const out = await withKpData(tiles(1002, 2));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpdata-broken-'));
    let fetches = 0;
    try {
      process.chdir(dir);
      fs.mkdirSync(path.join('addon', 'data'), { recursive: true });
      fs.writeFileSync(path.join('addon', 'data', 'kpdata.sqlite'), 'x'.repeat(4096));
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error('no network in tests');
      }) as typeof fetch;
      process.env.KP_SERVICE_URL = 'http://kp:8080';
      process.env.KP_CATALOG_WAIT_MS = '600';
      delete require.cache[require.resolve('./kpData')];
      const fresh = require('./kpData');
      const metas = tiles(1, 1);
      assert.equal(await fresh.withKpData(metas), metas);
      const before = fs.readdirSync('/dev/fd').length;
      const started = Date.now();
      for (let i = 0; i < 50; i++) assert.equal(await fresh.withKpData(metas), metas);
      assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
      assert.equal(fs.readdirSync('/dev/fd').length, before);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = realFetch;
      process.chdir(realCwd);
      delete process.env.KP_SERVICE_URL;
      delete process.env.KP_CATALOG_WAIT_MS;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

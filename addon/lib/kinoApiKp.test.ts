/*
 * The kp backend of kinoApi.ts (KP_SERVICE_URL), in its own process: the store is opened once per process.
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/kinoApiKp.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { fromKp, kpItemOf, kpMergeRow, projectView, sourceOf, withKinoApi, yearOf, type StoredRow } from './kinoApi';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-23T12:00:00Z');

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

describe('a kp answer', () => {
  const item = {
    kpId: '326', kpRating: '9.1', kpVotes: 1_000_000, age: '16+', shortDescription: 'Про тюрьму', voiceovers: ['Дубляж'],
    fetched_at: (NOW - 10 * DAY) / 1000, expires_at: (NOW + 20 * DAY) / 1000,
  };

  test('projects like a Kino API title', () => {
    assert.deepEqual(projectView(fromKp(item)), { kpRating: '9.1', kpVotes: 1_000_000, kpId: '326', shortDescription: 'Про тюрьму', voiceovers: ['Дубляж'], age: '16+' });
    // Alloha's rating comes without votes.
    assert.deepEqual(projectView(fromKp({ kpId: '1', kpRating: '7.4' })), { kpRating: '7.4', kpId: '1' });
    assert.deepEqual(projectView(fromKp({ kpId: '1' })), { kpId: '1' });
  });

  test('keeps the expires_at of the service, asked again no sooner than in 2 min', () => {
    const row = kpMergeRow('tmdb:movie:278', undefined, item, 'month', NOW)!;
    assert.equal(row.fetched_at, NOW - 10 * DAY);
    assert.equal(row.expires_at, NOW + 20 * DAY);
    const old = kpMergeRow('tmdb:movie:278', undefined, { ...item, expires_at: (NOW - DAY) / 1000 }, 'month', NOW)!;
    assert.equal(old.expires_at, NOW + 120_000);
    const none = kpMergeRow('tmdb:movie:278', undefined, { kpId: '1' }, 'month', NOW)!;
    assert.equal(none.expires_at, NOW + DAY, 'no expires_at: a day');
    const future = kpMergeRow('tmdb:movie:278', undefined, { ...item, fetched_at: NOW / 1000 + 3600 }, 'month', NOW)!;
    assert.equal(future.fetched_at, NOW);
  });

  test('pending is not stored; null keeps the last data', () => {
    assert.equal(kpMergeRow('k', undefined, { pending: true }, 'month', NOW), null);
    const good = kpMergeRow('k', undefined, item, 'month', NOW)!;
    const kept = kpMergeRow('k', good, null, 'month', NOW + DAY)!;
    assert.deepEqual([kept.found, kept.view, kept.expires_at], [1, good.view, NOW + 2 * DAY]);
    assert.equal(kpMergeRow('k', undefined, null, 'month', NOW)!.found, 0);
    assert.equal(kpMergeRow('k', undefined, { kpId: 'x' }, 'month', NOW)!.found, 0, 'an answer without a kp id is a miss');
  });
});

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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withKinoApi with KP_SERVICE_URL', () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  const dataDir = path.join(dir, 'addon', 'data');
  let calls: Array<{ url: string; headers: Headers; items: any[] }> = [];
  let answer: (items: any[]) => any[] = (items) =>
    items.map((x) => ({ kpId: String(Number(x.tmdb) + 1), kpRating: '8.0', kpVotes: 5000, fetched_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 86400 }));

  before(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    // The Kino API store of the stage before: read only, never written.
    const legacy = new BetterSqlite3(path.join(dataDir, 'kinoapi.sqlite'));
    legacy.exec(`CREATE TABLE kino_titles (k TEXT PRIMARY KEY, raw TEXT, view TEXT, view_v INTEGER NOT NULL, found INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_access INTEGER NOT NULL)`);
    legacy.prepare('INSERT INTO kino_titles VALUES (?, ?, ?, 1, 1, 0, 0, 0)').run('tmdb:movie:10', '{}', JSON.stringify({ kpRating: '6.0', kpId: '99' }));
    legacy.close();
    process.chdir(dir);
    process.env.KP_SERVICE_URL = 'http://kp:8080/';
    delete process.env.KINOAPI_API_KEY;
    globalThis.fetch = (async (url: any, init: any) => {
      const items = JSON.parse(init.body).items;
      calls.push({ url: String(url), headers: new Headers(init.headers), items });
      return Response.json({ data: answer(items) });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
    delete process.env.KP_SERVICE_URL;
    delete process.env.KINOAPI_CATALOG_WAIT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a new title is asked for and waited for, with no key sent', async () => {
    process.env.KINOAPI_CATALOG_WAIT_MS = '3000';
    const tile = { id: 'tt0111161', type: 'movie', _tmdbId: '278', name: 'Побег из Шоушенка', released: new Date('1994-09-23'), countries: ['United States of America'] };
    const [out] = await withKinoApi([tile]);
    assert.deepEqual([out.kpId, out.kpRating, out.kpVotes], ['279', '8.0', 5000]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://kp:8080/titles');
    assert.equal(calls[0].headers.get('Authorization'), null);
    assert.deepEqual(calls[0].items[0], {
      k: 'tmdb:movie:278', type: 'movie', tmdb: '278', tt: 'tt0111161', name: 'Побег из Шоушенка', original: '', english: '',
      year: 1994, countries: ['United States of America'], tier: 'month',
    });
    assert.ok(fs.existsSync(path.join(dataDir, 'kpdata.sqlite')));
    assert.deepEqual(tracked, ['kp']);
  });

  test('a title with only a Kino API row shows it at once and is asked in the background', async () => {
    calls = [];
    const started = Date.now();
    const [out] = await withKinoApi([{ id: 'tt10', type: 'movie', _tmdbId: '10', released: new Date('2001-01-01') }]);
    assert.ok(Date.now() - started < 300, 'not waited for');
    assert.deepEqual([out.kpId, out.kpRating], ['99', '6.0']);
    await pause(400);
    assert.equal(calls.length, 1);
    const [next] = await withKinoApi([{ id: 'tt10', type: 'movie', _tmdbId: '10', released: new Date('2001-01-01') }]);
    assert.deepEqual([next.kpId, next.kpRating], ['11', '8.0']);
    const legacy = new BetterSqlite3(path.join(dataDir, 'kinoapi.sqlite'), { readonly: true });
    const row = legacy.prepare("SELECT view FROM kino_titles WHERE k = 'tmdb:movie:10'").get() as { view: string };
    legacy.close();
    assert.equal(JSON.parse(row.view).kpRating, '6.0', 'kinoapi.sqlite is never written');
  });

  test('pending is not stored and not asked again for 2 min; null is', async () => {
    calls = [];
    answer = (items) => items.map((x) => (x.tmdb === '30' ? { pending: true } : null));
    const out = await withKinoApi([{ id: 'tt30', type: 'movie', _tmdbId: '30' }, { id: 'tt31', type: 'movie', _tmdbId: '31' }]);
    assert.equal(out[0].kpId, undefined);
    assert.equal(calls.length, 1);
    await withKinoApi([{ id: 'tt30', type: 'movie', _tmdbId: '30' }, { id: 'tt31', type: 'movie', _tmdbId: '31' }]);
    await pause(300);
    assert.equal(calls.length, 1, 'pending waits RETRY_MS, a miss a day');
    const db = new BetterSqlite3(path.join(dataDir, 'kpdata.sqlite'), { readonly: true });
    const rows = db.prepare("SELECT k, found FROM kino_titles WHERE k IN ('tmdb:movie:30', 'tmdb:movie:31')").all() as StoredRow[];
    db.close();
    assert.deepEqual(rows.map((r) => [r.k, r.found]), [['tmdb:movie:31', 0]]);
  });

  test('a title kp found no id for keeps its Kino API numbers', async () => {
    calls = [];
    answer = (items) => items.map(() => null);
    const legacy = new BetterSqlite3(path.join(dataDir, 'kinoapi.sqlite'));
    legacy.prepare('INSERT INTO kino_titles VALUES (?, ?, ?, 1, 1, 0, 0, 0)').run('tmdb:movie:40', '{}', JSON.stringify({ kpRating: '7.7', kpVotes: 5000, kpId: '40' }));
    legacy.close();
    const [first] = await withKinoApi([{ id: 'tt40', type: 'movie', _tmdbId: '40' }]);
    assert.equal(first.kpRating, '7.7');
    await pause(400);
    assert.equal(calls.length, 1);
    const [next] = await withKinoApi([{ id: 'tt40', type: 'movie', _tmdbId: '40' }]);
    assert.deepEqual([next.kpRating, next.kpVotes], ['7.7', 5000], 'a null row does not hide them');
    await pause(300);
    assert.equal(calls.length, 1, 'and is not asked again before its day');
  });

  test('expires_at in a wrong unit is capped', () => {
    const row = kpMergeRow('k', undefined, { kpId: '1', fetched_at: NOW / 1000, expires_at: NOW + DAY }, 'month', NOW)!;
    assert.equal(row.expires_at, NOW + 31 * DAY);
  });
});

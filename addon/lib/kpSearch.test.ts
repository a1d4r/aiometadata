/*
 * Titles Kinopoisk finds after TMDB's own in a search (kpSearch.ts).
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/kpSearch.test.ts
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendKpTail, askKp, classifyKpTail, kpTailOf, wantsKpTail, withKpTail, type KpHit, type TailContext, type TailDeps } from './kpSearch';

const tracked: Array<[string, boolean]> = [];
// The real tracker opens Redis; the module requires it lazily, so a stand-in in the cache is enough.
{
  const Module = require('node:module');
  const file = require.resolve('./requestTracker');
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = { trackProviderCall: (name: string, _ms: number, ok: boolean) => tracked.push([name, ok]) };
  require.cache[file] = mod;
}

const hit = (tt: string, kw: Partial<KpHit> = {}): KpHit => ({ kp: 1, tt, tmdb: null, name: null, year: null, ...kw });
const tile = (id: string, kw: any = {}) => ({ id, imdb_id: id.startsWith('tt') ? id : undefined, type: 'movie', name: `TMDB ${id}`, year: '2000', ...kw });

describe('which searches get Kinopoisk titles', () => {
  beforeEach(() => {
    process.env.KP_SERVICE_URL = 'http://kp:8080/';
  });

  test('a title query of a TMDB search, its first page', () => {
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, ' Карл XII '), true);
    assert.equal(wantsKpTail('tmdb.search', 'series', 1, 'Леди Мэр'), true);
    assert.equal(wantsKpTail('tmdb.search', 'movie', 2, 'Карл XII'), false, 'page 2: TMDB only');
    assert.equal(wantsKpTail('tvdb.search', 'movie', 1, 'Карл XII'), false);
    assert.equal(wantsKpTail('tmdb.search', 'anime.series', 1, 'Карл XII'), false);
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, 'tt0166675'), false, 'an id is no title');
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, 'tmdb:42'), false);
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, '  '), false);
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, 'x'.repeat(101)), false, "kp's limit");
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, undefined), false);
    process.env.KP_SERVICE_URL = '';
    assert.equal(wantsKpTail('tmdb.search', 'movie', 1, 'Карл XII'), false, 'off without KP_SERVICE_URL');
  });
});

describe("kp's answer", () => {
  beforeEach(() => {
    process.env.KP_SERVICE_URL = 'http://kp:8080/';
  });

  test('the type as kp names it, hits checked in their order', async () => {
    let sent: any;
    const fake = (async (url: any, init: any) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ complete: true, data: [
        { kp: 338622, tt: 'tt0166675', tmdb: null, name: 'Карл XII', year: 1974, votes: 28, exact: true },
        { kp: 2, tt: '0166675' }, { kp: 'x', tt: 'tt0000001' }, { kp: 4, tt: 'tt123' }, null,
        { kp: 3, tt: 'tt0000003', tmdb: 33, name: ' ', year: '1990', votes: 5 },
      ] }), { status: 200 });
    }) as typeof fetch;
    const got = await askKp(' Леди Мэр ', 'series', fake);
    assert.deepEqual(sent, { url: 'http://kp:8080/search', body: { q: 'Леди Мэр', type: 'tv' } });
    assert.equal(got.complete, true);
    assert.deepEqual(tracked.at(-1), ['kp', true], "in the providers' stats as kp");
    assert.deepEqual(got.hits, [
      { kp: 338622, tt: 'tt0166675', tmdb: null, name: 'Карл XII', year: 1974 },
      { kp: 3, tt: 'tt0000003', tmdb: 33, name: null, year: null },
    ], 'a tt TMDB search would not take for an id is no hit');
  });

  test('a failure is an empty partial answer', async () => {
    for (const fake of [
      (async () => new Response('{}', { status: 500 })) as typeof fetch,
      (async () => new Response('<html>', { status: 200 })) as typeof fetch,
      (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
    ]) {
      assert.deepEqual(await askKp('Карл XII', 'movie', fake), { hits: [], complete: false });
    }
  });
});

describe('the added tiles', () => {
  const tmdbTile = (tt: string, kw: any = {}) => ({ known: true, meta: tile(tt, kw) });

  test('after TMDB, in kp order, named as Kinopoisk names them, nothing TMDB has', async () => {
    const head = [tile('tt0000001'), tile('tmdb:77', { _tmdbId: 77 }), tile('tt0000005', { _tmdbId: 55 })];
    const answer = { complete: true, hits: [
      hit('tt0166675', { name: 'Карл XII', year: 1974 }),
      hit('tt0000001', { name: 'Дубль по tt' }),
      hit('tt0000002', { tmdb: 77, name: 'Дубль по TMDB id' }),
      hit('tt0000003', { name: 'Другой тайтл под тем же tt', year: 2017 }),
      hit('tt0000004', { year: 2016 }),
      hit('tt0000006', { name: 'TMDB не знает', year: 2003 }),
      hit('tt0000008'),
      hit('tt0000007', { name: 'TMDB даёт тайтл из выдачи' }),
      hit('tt0000009', { name: 'TMDB знает другим типом' }),
      hit('tt0000010', { name: 'Поиск TMDB его выкинул (adult)' }),
    ] };
    const asked: string[] = [];
    const hydrate = async (tt: string) => {
      asked.push(tt);
      if (tt === 'tt0000006' || tt === 'tt0000008') return { known: false, meta: null };
      if (tt === 'tt0000009' || tt === 'tt0000010') return { known: true, meta: null };
      if (tt === 'tt0000007') return tmdbTile('tt0000005', { _tmdbId: 55 });
      return tmdbTile(tt, { name: 'Karl XII', year: tt === 'tt0166675' ? '1974' : '2013' });
    };
    const got = await kpTailOf(head, answer, 'series', hydrate);
    assert.deepEqual(asked, ['tt0166675', 'tt0000003', 'tt0000004', 'tt0000006', 'tt0000008', 'tt0000007', 'tt0000009', 'tt0000010'],
      'no TMDB lookup for what TMDB found');
    assert.deepEqual(got.metas.map((m: any) => [m.id, m.name]), [['tt0166675', 'Карл XII'], ['tt0000004', 'Karl XII'], ['tt0000006', 'TMDB не знает']],
      "a year 4 off is another title, 3 is not; no Russian name keeps TMDB's; unknown to TMDB without a name: none");
    assert.deepEqual(got.metas[2], { id: 'tt0000006', imdb_id: 'tt0000006', type: 'series', name: 'TMDB не знает', year: '2003', releaseInfo: '2003' });
    assert.equal(got.kpPartial, undefined);
    assert.equal(head.length, 3, 'TMDB results untouched');
  });

  test('partial when kp was, or when TMDB failed: no tile of what TMDB may know', async () => {
    const got = await kpTailOf([], { complete: true, hits: [hit('tt0000001'), hit('tt0000002', { name: 'Сбой' })] }, 'movie', async (tt) => {
      if (tt === 'tt0000002') throw new Error('TMDB down');
      return tmdbTile(tt);
    });
    assert.deepEqual([got.metas.map((m: any) => m.id), got.kpPartial], [['tt0000001'], true]);
    assert.deepEqual(await kpTailOf([], { complete: false, hits: [] }, 'movie', async () => ({ known: false, meta: null })), { metas: [], kpPartial: true });
  });

  test('at most 20 TMDB lookups', async () => {
    let n = 0;
    const hits = Array.from({ length: 30 }, (_, i) => hit(`tt${1000000 + i}`));
    await kpTailOf([], { complete: true, hits }, 'movie', async (tt) => (n++, tmdbTile(tt)));
    assert.equal(n, 20);
  });

  test('kept 12 h, partial 5 min, an error never', () => {
    assert.deepEqual(classifyKpTail({ metas: [] }, null), { type: 'SUCCESS', ttl: null });
    assert.deepEqual(classifyKpTail({ metas: [tile('tt1')], kpPartial: true }, null), { type: 'PARTIAL', ttl: 300 });
    assert.equal(classifyKpTail(null, new Error('x')).ttl, 0);
    assert.equal(classifyKpTail({ error: true }, null).ttl, 0);
  });

  test('appended to the TMDB results of the hour, without what they have now', () => {
    const head = [tile('tt0000001'), tile('tmdb:9', { _tmdbId: 9 })];
    const tail = [tile('tt0000002'), tile('tt0000001'), tile('tt0000003', { _tmdbId: 9 })];
    assert.deepEqual(appendKpTail(head, tail).map((m: any) => m.id), ['tt0000001', 'tmdb:9', 'tt0000002']);
  });
});

describe('the search response', () => {
  beforeEach(() => {
    process.env.KP_SERVICE_URL = 'http://kp:8080';
  });

  const ctx = (kw: Partial<TailContext> = {}): TailContext => ({
    userUUID: 'u', searchKey: 'search:k', engine: 'tmdb.search', type: 'movie', page: 1, query: 'Карл XII',
    cleanId: 'search', language: 'ru-RU', config: {}, cacheOptions: { config: {} }, ...kw,
  });
  const deps = (kw: Partial<TailDeps> = {}): TailDeps & { keys: string[]; options: any[] } => {
    const keys: string[] = [];
    const options: any[] = [];
    return {
      keys, options,
      cacheWrapSearch: async (_u, key, method, _e, opts) => (keys.push(key), options.push(opts), method()),
      askKp: async () => ({ complete: true, hits: [hit('tt0166675', { name: 'Карл XII' })] }),
      hydrate: async (tt) => ({ known: true, meta: tile(tt, { name: 'Karl XII' }) }),
      waitMs: 1000,
      ...kw,
    };
  };

  test("TMDB's results, then Kinopoisk's, in an entry of their own", async () => {
    const d = deps();
    const got = await withKpTail(Promise.resolve({ metas: [tile('tt0000001')] }), ctx(), d);
    assert.deepEqual(got.metas.map((m: any) => [m.id, m.name]), [['tt0000001', 'TMDB tt0000001'], ['tt0166675', 'Карл XII']]);
    assert.deepEqual(d.keys, ['kp-tail:search:k']);
    assert.equal(d.options[0].resultClassifier, classifyKpTail);
    assert.equal(d.options[0].enableErrorCaching, false);
  });

  test('a search it does not take is the head as it is', async () => {
    const d = deps();
    const head = { metas: [tile('tt0000001')] };
    assert.equal(await withKpTail(Promise.resolve(head), ctx({ page: 2 }), d), head);
    assert.deepEqual(d.keys, []);
  });

  test('kp is asked while TMDB searches', async () => {
    let asked = false;
    let release!: (v: any) => void;
    const head = new Promise((resolve) => (release = resolve));
    const got = withKpTail(head, ctx(), deps({ askKp: async () => ((asked = true), { complete: true, hits: [] }) }));
    await new Promise((r) => setImmediate(r));
    assert.equal(asked, true, 'before TMDB answered');
    release({ metas: [] });
    assert.deepEqual((await got).metas, []);
  });

  test('late Kinopoisk titles: the head alone, on time', async () => {
    const started = Date.now();
    const got = await withKpTail(Promise.resolve({ metas: [tile('tt0000001')] }), ctx(),
      deps({ waitMs: 50, askKp: () => new Promise((r) => setTimeout(() => r({ complete: true, hits: [] }), 500)) }));
    assert.deepEqual(got.metas.map((m: any) => m.id), ['tt0000001']);
    assert.ok(Date.now() - started < 400);
  });

  test('a failing tail never fails the search; a failing head fails it as before', async () => {
    const got = await withKpTail(Promise.resolve({ metas: [tile('tt0000001')] }), ctx(),
      deps({ cacheWrapSearch: async () => { throw new Error('redis'); } }));
    assert.deepEqual(got.metas.map((m: any) => m.id), ['tt0000001']);
    await assert.rejects(withKpTail(Promise.reject(new Error('tmdb')), ctx(), deps()), /tmdb/);
  });
});

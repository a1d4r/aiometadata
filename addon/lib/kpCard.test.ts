/*
 * Kinopoisk's name, poster and description for IMDb's stand-in or no meta (kpCard.ts).
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/kpCard.test.ts
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { askKpCard, cardOf, isKpPoster, metaOf, patchStandIn, wantsKpCard, withKpCard, type KpCard } from './kpCard';

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

const POSTER = 'https://cdnrrviubnyuntopbez5.svc.cdn.yandex.net/get-kinopoisk-image/1900788/ef9c426d-f913-49aa-9de4-dc3d83f1f71b/600x900';
const card = (kw: Partial<KpCard> = {}): KpCard => ({
  kp: 405645, name: 'Пятый угол', year: 2001, poster: POSTER, description: 'Наше время.', seasons: [[1, 2]],
  released: '2020-09-08T05:28:49Z', ...kw,
});
// IMDb's stand-in for «Пятый угол» as AIOMetadata gives it (23.11.2026), cut.
const standIn = () => ({
  id: 'tt1166122', type: 'series', name: 'Pyatyy ugol', releaseInfo: '2001–', poster: 'https://aiometadata.kompotik.com/missing_poster.png',
  _metaProvider: 'imdb', kpId: '405645', videos: [{ id: 'tt1166122:1:1', season: 1, episode: 1, released: '2001-01-01T00:00:00.000Z' }],
});

beforeEach(() => {
  process.env.KP_SERVICE_URL = 'http://kp:8080/';
});

describe('which metas get Kinopoisk fields', () => {
  test("IMDb's stand-in or none, by a tt, a movie or a series", () => {
    assert.equal(wantsKpCard('series', 'tt1166122', standIn()), true);
    assert.equal(wantsKpCard('series', 'tt1166122', null), true);
    assert.equal(wantsKpCard('movie', 'tt1166122', { _metaProvider: 'tmdb' }), false, "never over TMDB's");
    assert.equal(wantsKpCard('series', 'tmdb:1396', null), false);
    assert.equal(wantsKpCard('series', 'kitsu:1', null), false);
    assert.equal(wantsKpCard('anime', 'tt1166122', null), false);
    process.env.KP_SERVICE_URL = '';
    assert.equal(wantsKpCard('series', 'tt1166122', null), false, 'off without KP_SERVICE_URL');
  });
});

describe("kp's answer", () => {
  test('POST /card with the type as kp names it; fields checked', async () => {
    let sent: any;
    const fake = (async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ complete: true, data: {
        kp: 405645, name: ' Пятый угол ', year: 2001, poster: POSTER, description: 'Наше время.',
        seasons: [[1, 10], [2, 5], [0, 3], ['3', 1]], released: '2020-09-08T05:28:49Z',
      } }), { status: 200 });
    }) as typeof fetch;
    const got = await askKpCard('tt1166122', 'series', fake);
    assert.deepEqual(sent, { url: 'http://kp:8080/card', body: { tt: 'tt1166122', type: 'tv' } });
    assert.deepEqual(got, card({ seasons: [[1, 10], [2, 5]] }), 'season 0 and a bad one left out');
    assert.deepEqual(tracked.at(-1), ['kp', true]);
  });

  test('none, a failure or a bad field: no card or no field', async () => {
    for (const fake of [
      (async () => new Response('{"data": null, "complete": true}', { status: 200 })) as typeof fetch,
      (async () => new Response('{}', { status: 500 })) as typeof fetch,
      (async () => new Response('[]', { status: 200 })) as typeof fetch,
      (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
    ]) {
      assert.equal(await askKpCard('tt1166122', 'movie', fake), null);
    }
    assert.equal(cardOf({ kp: 'x', name: 'Имя' }), null);
    const got = cardOf({ kp: 1, name: '', poster: 'https://evil.example/p.jpg', year: 99, released: '2020-09-08 08:28:49', seasons: [[1, 5000], [2, 9]] });
    assert.deepEqual(got, { kp: 1, name: null, year: null, poster: null, description: null, seasons: [[1, 3000]], released: null },
      '3000 episodes at most, as Melange reads');
  });
});

describe("Kinopoisk's posters", () => {
  test('the two hosts, the path, a card\'s or a tile\'s size: nothing else', () => {
    assert.equal(isKpPoster(POSTER), true);
    assert.equal(isKpPoster(POSTER.replace('600x900', '300x450')), true);
    assert.equal(isKpPoster(POSTER.replace('cdnrrviubnyuntopbez5.svc.cdn', 'avatars.mds')), true);
    for (const bad of [POSTER.replace('600x900', 'orig'), POSTER.replace('https', 'http'), `${POSTER}?x=1`, `${POSTER}/`,
      POSTER.replace('cdnrrviubnyuntopbez5.svc.cdn.yandex.net', 'evil.example'), 'https://image.tmdb.org/t/p/w342/abcdefghij.jpg', null]) {
      assert.equal(isKpPoster(bad), false, String(bad));
    }
  });
});

describe('the meta', () => {
  test("IMDb's stand-in gets Kinopoisk's name, poster and description; the rest stays", () => {
    const meta = standIn();
    const got = patchStandIn(meta, card());
    assert.deepEqual(got, { ...standIn(), name: 'Пятый угол', poster: POSTER, description: 'Наше время.' });
    assert.equal(meta.name, 'Pyatyy ugol', 'a copy: the cached meta is shared');
    assert.equal(patchStandIn(meta, card({ year: 2005 })), meta, '4 years off: another title under the tt');
    assert.equal(patchStandIn(meta, card({ year: 2004 })).name, 'Пятый угол', '3 is not');
    assert.equal(patchStandIn(meta, card({ name: null, poster: null, description: null })), meta);
    assert.equal(patchStandIn({ ...meta, description: 'IMDb says' }, card({ description: null })).description, 'IMDb says');
  });

  test("none: built from Kinopoisk, a series' episodes out by Alloha's date", () => {
    assert.deepEqual(metaOf('tt33368267', 'series', card({ name: 'Смешное время', year: 2018, description: null })), {
      id: 'tt33368267', imdb_id: 'tt33368267', type: 'series', name: 'Смешное время', poster: POSTER, year: '2018', releaseInfo: '2018',
      _metaProvider: 'kinopoisk', videos: [
        { id: 'tt33368267:1:1', season: 1, episode: 1, released: '2020-09-08T05:28:49Z' },
        { id: 'tt33368267:1:2', season: 1, episode: 2, released: '2020-09-08T05:28:49Z' },
      ],
    });
    assert.deepEqual(metaOf('tt0000001', 'movie', card({ year: null, poster: null })),
      { id: 'tt0000001', imdb_id: 'tt0000001', type: 'movie', name: 'Пятый угол', description: 'Наше время.', _metaProvider: 'kinopoisk' });
    assert.equal(metaOf('tt0000001', 'movie', card({ name: null })), null, 'no name, no meta');
  });

  test('the route: a stand-in patched, none built, the rest never asked', async () => {
    const asked: string[] = [];
    const ask = async (tt: string, type: 'movie' | 'series') => {
      asked.push(`${type}:${tt}`);
      return tt === 'tt0000404' ? null : card();
    };
    const got = await withKpCard({ meta: standIn(), cacheTime: 1 }, 'series', 'tt1166122', ask);
    assert.equal(got.meta.name, 'Пятый угол');
    assert.equal(got.cacheTime, 1);
    assert.equal((await withKpCard({ meta: null }, 'series', 'tt33368267', ask)).meta.videos.length, 2);
    assert.equal((await withKpCard(null, 'movie', 'tt33368267', ask)).meta.type, 'movie');
    assert.deepEqual(await withKpCard({ meta: null }, 'series', 'tt0000404', ask), { meta: null }, 'kp has none: as it was');
    const tmdb = { meta: { id: 'tt0000002', _metaProvider: 'tmdb', name: 'TMDB' } };
    assert.equal(await withKpCard(tmdb, 'movie', 'tt0000002', ask), tmdb);
    assert.deepEqual(asked, ['series:tt1166122', 'series:tt33368267', 'movie:tt33368267', 'series:tt0000404']);
  });
});

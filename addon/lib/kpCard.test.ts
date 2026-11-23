/*
 * Kinopoisk's name, poster and description for IMDb's stand-in or no meta (kpCard.ts).
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/kpCard.test.ts
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  askKpCard, cardOf, isKpPoster, metaOf, patchDescription, patchStandIn, standInEpisodes, tmdbWithNoRuDescription, wantsKpCard, withKpCard,
  type KpCard,
} from './kpCard';

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
  _metaProvider: 'imdb', kpId: '405645', videos: [{ id: 'tt1166122:1:1', season: 1, episode: 1, released: '2001-01-01T00:00:00Z' }],
});
// IMDb's episodes as AIOMetadata gives them (23.11.2026, «Пятый угол», «Леди Мэр»), cut.
const imdbEp = (number: number, firstAired: string | null, name = `Episode #1.${number}`) => ({
  name, season: 1, number, firstAired, rating: '0', id: `tt1166122:1:${number}`, imdb_id: `tt2023733${number}`,
});

beforeEach(() => {
  process.env.KP_SERVICE_URL = 'http://kp:8080/';
});

describe('which metas get Kinopoisk fields', () => {
  test("IMDb's stand-in or none, by a tt, a movie or a series", () => {
    assert.equal(wantsKpCard('series', 'tt1166122', standIn()), true);
    assert.equal(wantsKpCard('series', 'tt1166122', null), true);
    assert.equal(wantsKpCard('movie', 'tt1166122', { _metaProvider: 'tmdb' }), false, "not over TMDB's with a Russian description");
    const fellBack = { overviewLang: 'fallback', titleLang: 'exact' };
    assert.equal(wantsKpCard('movie', 'tt1166122', { _metaProvider: 'tmdb', _completeness: fellBack }, 'ru-RU'), true);
    assert.equal(wantsKpCard('movie', 'tt1166122', { _metaProvider: 'tvdb', _completeness: fellBack }, 'ru-RU'), false);
    assert.equal(wantsKpCard('series', 'tmdb:1396', null), false);
    assert.equal(wantsKpCard('series', 'kitsu:1', null), false);
    assert.equal(wantsKpCard('anime', 'tt1166122', null), false);
    process.env.KP_SERVICE_URL = '';
    assert.equal(wantsKpCard('series', 'tt1166122', null), false, 'off without KP_SERVICE_URL');
  });

  test("off without KP_SERVICE_URL, a stand-in's episodes fixed all the same", async () => {
    process.env.KP_SERVICE_URL = '';
    const asked: string[] = [];
    const ask = async (tt: string) => { asked.push(tt); return card(); };
    const got = await withKpCard({ meta: { ...standIn(), videos: [imdbEp(1, null)] } }, 'series', 'tt1166122', 'ru-RU', ask);
    assert.deepEqual(got.meta.videos, [{ ...imdbEp(1, null), episode: 1 }]);
    assert.equal(got.meta.name, 'Pyatyy ugol');
    assert.deepEqual(asked, []);
  });
});

describe("TMDB's meta with no Russian description", () => {
  // «Танганьика» (tt0047556, TMDB 241077): with language=ru-RU TMDB gives overview "" and no ru translation (23.11.2026),
  // so upstream's classifyTmdbLocalization stamps overviewLang 'fallback' and AIOMetadata shows en-US's.
  const fellBack = { titleLang: 'fallback', overviewLang: 'fallback' };
  test("upstream's stamp of the fallback is the sign, for a Russian config", () => {
    assert.equal(tmdbWithNoRuDescription({ _metaProvider: 'tmdb', _completeness: fellBack }, 'ru-RU'), true);
    assert.equal(tmdbWithNoRuDescription({ _metaProvider: 'tmdb', _completeness: { ...fellBack, overviewLang: 'exact' } }, 'ru-RU'), false);
    assert.equal(tmdbWithNoRuDescription({ _metaProvider: 'tmdb' }, 'ru-RU'), false, 'a card cached before: no stamp');
    assert.equal(tmdbWithNoRuDescription({ _metaProvider: 'tmdb', _completeness: fellBack }, 'en-US'), false,
      "Kinopoisk's is Russian");
    assert.equal(tmdbWithNoRuDescription({ _metaProvider: 'tmdb', _completeness: fellBack }, undefined), false);
    assert.equal(tmdbWithNoRuDescription(null, 'ru-RU'), false);
  });

  test("only the description, Kinopoisk's of the same year; none: the English one stays", () => {
    const meta = { id: 'tt0047556', _metaProvider: 'tmdb', _completeness: fellBack, name: 'Танганьика', year: '1954',
      poster: 'https://image.tmdb.org/t/p/w342/abcdefghij.jpg', description: 'A landowner in colonial Africa…' };
    assert.deepEqual(patchDescription(meta, card({ year: 1954 })), { ...meta, description: 'Наше время.' }, 'name and poster stay TMDB\'s');
    assert.equal(patchDescription(meta, card({ year: 1954, description: null })), meta);
    assert.equal(patchDescription(meta, card({ year: 1960 })), meta, 'another title under the tt');
    assert.equal(patchDescription(meta, null), meta);
    assert.equal(meta.description, 'A landowner in colonial Africa…', 'a copy');
  });

  test('the route: a TMDB meta with the sign gets the description, without it is never asked', async () => {
    const asked: Array<[string, number]> = [];
    const ask = async (tt: string, _type: string, timeoutMs?: number) => {
      asked.push([tt, timeoutMs!]);
      return card({ year: 1954, seasons: [[1, 9]] });
    };
    const meta = { id: 'tt0047556', _metaProvider: 'tmdb', _completeness: fellBack, name: 'Танганьика', year: '1954',
      description: 'A landowner…', videos: [{ season: 1, number: 1 }] };
    const got = await withKpCard({ meta, cacheTime: 1 }, 'movie', 'tt0047556', 'ru-RU', ask);
    assert.deepEqual(got, { meta: { ...meta, description: 'Наше время.' }, cacheTime: 1 }, "TMDB's episodes not touched");
    const ru = { meta: { ...meta, _completeness: { ...fellBack, overviewLang: 'exact' }, description: 'Помещик…' } };
    assert.equal(await withKpCard(ru, 'movie', 'tt0047556', 'ru-RU', ask), ru);
    await withKpCard({ meta: standIn() }, 'series', 'tt1166122', 'ru-RU', ask);
    assert.deepEqual(asked, [['tt0047556', 1500], ['tt1166122', 4000]], 'kp waited for less for a description only');
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
    const got = await askKpCard('tt1166122', 'series', undefined, fake);
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
      assert.equal(await askKpCard('tt1166122', 'movie', undefined, fake), null);
    }
    const slow = (async (_url: string, init: any) => new Promise((_, reject) => init.signal.addEventListener('abort',
      () => reject(init.signal.reason)))) as typeof fetch;
    assert.equal(await askKpCard('tt0047556', 'movie', 20, slow), null);
    assert.deepEqual(tracked.at(-1), ['kp', true], "TMDB's short wait running out is no failure of kp");
    assert.equal(await askKpCard('tt0047556', 'movie', 4000, (async () => { throw new DOMException('t', 'TimeoutError'); }) as typeof fetch), null);
    assert.deepEqual(tracked.at(-1), ['kp', false]);
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

  test("IMDb's episodes in Melange's fields: episode, released, title; the old ones kept", () => {
    const videos = [imdbEp(1, '2001-01-01T00:00:00.000Z'), imdbEp(2, null, 'Возвращение'), imdbEp(3, 'soon'),
      { ...imdbEp(4, null), episode: 4, released: '2002-02-02T00:00:00Z', title: 'Своё' }, null];
    const got = standInEpisodes(videos, card({ seasons: [[1, 2]] }));
    assert.deepEqual(got, [
      { ...imdbEp(1, '2001-01-01T00:00:00.000Z'), episode: 1, released: '2001-01-01T00:00:00Z' },
      { ...imdbEp(2, null, 'Возвращение'), episode: 2, released: '2020-09-08T05:28:49Z', title: 'Возвращение' },
      { ...imdbEp(3, 'soon'), episode: 3 },
      videos[3], null,
    ], "IMDb's date, else Alloha's for an episode Alloha has; IMDb's «Episode #1.1» is no name");
    assert.equal(videos[0].hasOwnProperty('episode'), false, 'copies: the cached meta is shared');
    assert.deepEqual(standInEpisodes([imdbEp(2, null)], card({ released: null })), [{ ...imdbEp(2, null), episode: 2 }]);
    assert.deepEqual(standInEpisodes([imdbEp(2, null)], null), [{ ...imdbEp(2, null), episode: 2 }], 'no card: no date');
    assert.equal(standInEpisodes([videos[3]], card()), null, 'nothing to add');
    assert.equal(standInEpisodes(undefined, card()), null);
  });

  test("a stand-in's episodes fixed with no card or another title's, without Alloha's date", () => {
    const meta = { ...standIn(), videos: [imdbEp(1, null)] };
    const fixed = [{ ...imdbEp(1, null), episode: 1 }];
    assert.deepEqual(patchStandIn(meta, null), { ...meta, videos: fixed });
    assert.deepEqual(patchStandIn(meta, card({ year: 2016 })), { ...meta, videos: fixed }, 'another title: not its name or date');
    assert.deepEqual(patchStandIn(meta, card()).videos, [{ ...fixed[0], released: '2020-09-08T05:28:49Z' }]);
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
    const got = await withKpCard({ meta: standIn(), cacheTime: 1 }, 'series', 'tt1166122', 'ru-RU', ask);
    assert.equal(got.meta.name, 'Пятый угол');
    assert.equal(got.cacheTime, 1);
    assert.equal((await withKpCard({ meta: null }, 'series', 'tt33368267', 'ru-RU', ask)).meta.videos.length, 2);
    assert.equal((await withKpCard(null, 'movie', 'tt33368267', 'ru-RU', ask)).meta.type, 'movie');
    assert.deepEqual(await withKpCard({ meta: null }, 'series', 'tt0000404', 'ru-RU', ask), { meta: null }, 'kp has none: as it was');
    assert.deepEqual((await withKpCard({ meta: { ...standIn(), videos: [imdbEp(1, null)] } }, 'series', 'tt0000404', 'ru-RU', ask)).meta.videos,
      [{ ...imdbEp(1, null), episode: 1 }], 'kp has none: the episodes fixed all the same');
    const tmdb = { meta: { id: 'tt0000002', _metaProvider: 'tmdb', name: 'TMDB' } };
    assert.equal(await withKpCard(tmdb, 'movie', 'tt0000002', 'ru-RU', ask), tmdb);
    assert.deepEqual(asked, ['series:tt1166122', 'series:tt33368267', 'movie:tt33368267', 'series:tt0000404', 'series:tt0000404']);
  });
});

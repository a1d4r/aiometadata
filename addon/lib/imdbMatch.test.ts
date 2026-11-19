/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/imdbMatch.test.ts
 *
 * Titles and IMDb answers are those of the measurement of 19.11.2026 (melange-vps reports/imdb-match.md).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imdbmatch-'));
process.env.IMDB_MATCH_FILE = path.join(dir, 'imdbmatch.sqlite');

import {
  factsOf,
  findAgrees,
  matchTitle,
  nextRow,
  numbersOf,
  parseSuggestions,
  personKey,
  romanize,
  titleOf,
  tmdbIdForMatchedImdb,
  withImdbIds,
  type Deps,
  type Row,
  type Suggestion,
} from './imdbMatch';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00Z');

const cast = (...names: string[]) => ({ cast: names.map((name) => ({ name, original_name: name })) });

const krasota = {
  original_name: 'Красота', name: 'Beauty', original_language: 'ru', origin_country: ['RU'],
  first_air_date: '2026-10-30', external_ids: { imdb_id: null },
  aggregate_credits: cast('Маргарита Дьяченкова', 'Дмитрий Мазуров', 'Some One'),
};

const sg = (id: string, l: string, qid: string, y: number | undefined, s: string) => ({ id, l, qid, y, s });

const ANSWERS: Record<string, any> = {
  krasota: { d: [
    sg('tt34829929', 'Krasota', 'tvSeries', 2026, 'Dmitriy Mazurov, Margarita Dyachenkova'),
    sg('tt14867770', 'Krasota nebesnaya', 'tvMiniSeries', 2021, 'Artyom Karasev, Anna Nemchenko'),
    sg('tt36022730', 'Ukradennaya krasota', 'tvMiniSeries', 2025, 'Anna Bachalova, Stanislav Belyaev'),
  ] },
  beauty: { d: [sg('tt33517752', 'The Beauty', 'tvSeries', 2026, 'Evan Peters, Anthony Ramos')] },
  'odna doma 3': { d: [
    sg('tt33440439', 'Odna doma. Velikolepnaya pyatyorka', 'movie', 2024, 'Vitaliya Kornienko, Anastasiya Panina'),
    sg('tt37931876', 'Ne odna doma 3. Vypusknoy', 'movie', 2026, 'Arman Davtyan, Grigoriy Dudnik'),
  ] },
  'tochka nol': { d: [sg('tt31811424', 'Tochka nol', 'tvSeries', 2024, 'Marina Aleksandrova, Konstantin Beloshapka')] },
  gornolyzhka: { d: [sg('tt38493359', 'Gornolyzhka', 'tvSeries', undefined, 'Oleg Taktarov, Polina Maksimova')] },
};

function deps(details: any, found: Record<string, any> = {}, calls: string[] = []): Deps {
  return {
    details: async () => details,
    find: async (id) => found[id] ?? { movie_results: [], tv_results: [] },
    suggest: async (query) => {
      calls.push(query);
      return parseSuggestions(ANSWERS[query] ?? { d: [] });
    },
  };
}

describe('names and numbers', () => {
  test('Russian is romanized as IMDb does', () => {
    assert.equal(romanize('Новороссия. Потёмкин'), 'novorossiya. potyomkin');
    assert.equal(romanize('Хозяин Москвы'), 'khozyain moskvy');
    assert.equal(romanize('Центурия'), 'tsenturiya');
  });

  test('romanizations of one name meet', () => {
    assert.equal(personKey('Дмитрий Мазуров'), personKey('Dmitriy Mazurov'));
    assert.equal(personKey('Маргарита Дьяченкова'), personKey('Margarita Dyachenkova'));
    assert.equal(personKey('Alexander Boyarskiy'), personKey('Aleksandr Boyarsky'));
    assert.equal(personKey('Milos Bikovic'), personKey('Miloš Biković'));
    assert.notEqual(personKey('Dmitriy Mazurov'), personKey('Dmitriy Kulichkov'));
    assert.equal(personKey('Madonna'), null);
  });

  test('numbers of a title', () => {
    assert.equal(numbersOf('Одна дома 3'), '3');
    assert.equal(numbersOf('Odna doma. Velikolepnaya pyatyorka'), '');
    assert.equal(numbersOf('16 лет и 9 месяцев'), numbersOf('16 let i 9 mesyatsev'));
    assert.equal(numbersOf('Рейс 0314'), '314');
  });

  test('a query is cut to the 200 characters IMDb takes', () => {
    const long = factsOf('movie', '1', { original_title: 'а'.repeat(300), original_language: 'ru' });
    assert.equal(long.queries[0].length, 200);
  });

  test('an answer without its list is IMDb turning us away, not a miss', () => {
    assert.throws(() => parseSuggestions(''), /payload/);
    assert.throws(() => parseSuggestions({}), /payload/);
    assert.deepEqual(parseSuggestions({ d: [{ id: 'nm1', l: 'x', qid: 'movie' }] }), []);
  });
});

describe('matchTitle', () => {
  test('Krasota is tt34829929, not FX\'s The Beauty', async () => {
    const calls: string[] = [];
    assert.deepEqual(await matchTitle('tv', '318158', deps(krasota, {}, calls)), { imdb: 'tt34829929', via: 'match', reason: null, year: 2026 });
    assert.deepEqual(calls, ['krasota', 'beauty']);
  });

  test('a sequel with the same cast is not the title: Одна дома 3 is not part 2', async () => {
    const details = {
      original_title: 'Одна дома 3', title: 'Home Alone 3', original_language: 'ru', origin_country: ['RU'],
      release_date: '2025-11-27', credits: cast('Виталия Корниенко', 'Анастасия Панина'),
    };
    assert.equal((await matchTitle('movie', '1586338', deps(details))).reason, 'no-candidate');
  });

  test('an IMDb id TMDB links to another title is left alone', async () => {
    const details = {
      original_name: 'Точка ноль', name: 'Point Zero', original_language: 'ru', origin_country: ['RU'],
      first_air_date: '2024-04-04', aggregate_credits: cast('Марина Александрова'),
    };
    const found = { tt31811424: { movie_results: [], tv_results: [{ id: 260667 }] } };
    assert.equal((await matchTitle('tv', '250838', deps(details, found))).reason, 'conflict');
    const same = { tt31811424: { movie_results: [], tv_results: [{ id: 250838 }] } };
    assert.equal((await matchTitle('tv', '250838', deps(details, same))).imdb, 'tt31811424');
    assert.equal(findAgrees('movie', '250838', same.tt31811424), false);
  });

  test('a series not out on IMDb needs both its actors', async () => {
    const details = (...names: string[]) => ({
      original_name: 'Горнолыжка', name: 'Ski Resort', original_language: 'ru', origin_country: ['RU'],
      first_air_date: '2026-12-01', aggregate_credits: cast(...names),
    });
    assert.equal((await matchTitle('tv', '321273', deps(details('Олег Тактаров', 'Полина Максимова')))).imdb, 'tt38493359');
    assert.equal((await matchTitle('tv', '321273', deps(details('Олег Тактаров')))).reason, 'no-candidate');
  });

  test('two candidates that fit are a doubt', async () => {
    const answers = { d: [
      sg('tt1', 'Krasota', 'tvSeries', 2026, 'Dmitriy Mazurov'),
      sg('tt2', 'Krasota', 'tvMiniSeries', 2025, 'Margarita Dyachenkova'),
    ] };
    const d = { ...deps(krasota), suggest: async () => parseSuggestions(answers) };
    assert.equal((await matchTitle('tv', '318158', d)).reason, 'ambiguous');
  });

  test('the kind and the year must agree', async () => {
    const answers = { d: [
      sg('tt1', 'Krasota', 'movie', 2026, 'Dmitriy Mazurov, Margarita Dyachenkova'),
      sg('tt2', 'Krasota', 'tvSeries', 2023, 'Dmitriy Mazurov, Margarita Dyachenkova'),
    ] };
    const d = { ...deps(krasota), suggest: async () => parseSuggestions(answers) };
    assert.equal((await matchTitle('tv', '318158', d)).reason, 'no-candidate');
  });

  test('TMDB\'s own id wins, and titles not Russian or without a cast are not looked up', async () => {
    const calls: string[] = [];
    assert.deepEqual(await matchTitle('tv', '1', deps({ ...krasota, external_ids: { imdb_id: 'tt0000001' } }, {}, calls)),
      { imdb: 'tt0000001', via: 'tmdb', reason: null, year: 2026 });
    assert.equal((await matchTitle('tv', '1', deps({ ...krasota, original_language: 'en', origin_country: ['US'] }, {}, calls))).reason, 'not-russian');
    assert.equal((await matchTitle('tv', '1', deps({ ...krasota, aggregate_credits: { cast: [] } }, {}, calls))).reason, 'no-cast');
    assert.deepEqual(calls, []);
  });

  test('IMDb or TMDB down is an error, not a miss', async () => {
    const d = { ...deps(krasota), suggest: async () => parseSuggestions('<html>') };
    await assert.rejects(matchTitle('tv', '318158', d));
  });
});

describe('nextRow', () => {
  const match: Row = { k: 'tmdb:tv:1', imdb: 'tt1', via: 'match', reason: null, checked_at: NOW - 40 * DAY, expires_at: NOW - DAY, last_access: NOW - DAY };

  test('a match survives a check that finds nothing, but not TMDB linking the id elsewhere', () => {
    const kept = nextRow('tmdb:tv:1', match, { imdb: null, via: null, reason: 'no-candidate', year: 2026 }, NOW);
    assert.equal(kept.imdb, 'tt1');
    assert.equal(kept.expires_at, NOW + 30 * DAY);
    assert.equal(nextRow('tmdb:tv:1', match, { imdb: null, via: null, reason: 'conflict', year: 2026 }, NOW).imdb, null);
    assert.equal(nextRow('tmdb:tv:1', match, { imdb: 'tt2', via: 'tmdb', reason: null, year: 2026 }, NOW).imdb, 'tt2');
  });

  test('a new title is tried again sooner than an old one', () => {
    assert.equal(nextRow('k', undefined, { imdb: null, via: null, reason: 'no-candidate', year: 2025 }, NOW).expires_at, NOW + 3 * DAY);
    assert.equal(nextRow('k', undefined, { imdb: null, via: null, reason: 'no-candidate', year: 2019 }, NOW).expires_at, NOW + 30 * DAY);
    assert.equal(nextRow('k', undefined, { imdb: null, via: null, reason: 'not-russian', year: 2026 }, NOW).expires_at, NOW + 30 * DAY);
  });
});

describe('titleOf', () => {
  test('TMDB titles without an IMDb id only', () => {
    assert.deepEqual(titleOf({ type: 'series', id: 'tmdb:318158', imdb_id: null }), { k: 'tmdb:tv:318158', kind: 'tv', id: '318158' });
    assert.deepEqual(titleOf({ type: 'movie', id: 'x', _tmdbId: '5' }), { k: 'tmdb:movie:5', kind: 'movie', id: '5' });
    assert.equal(titleOf({ type: 'series', id: 'tmdb:1', imdb_id: 'tt1' }), null);
    assert.equal(titleOf({ type: 'series', id: 'tt1', _tmdbId: '1' }), null);
    assert.equal(titleOf({ type: 'series', id: 'kitsu:1' }), null);
    assert.equal(titleOf({ type: 'other', id: 'tmdb:1' }), null);
  });
});

describe('withImdbIds and tmdbIdForMatchedImdb', () => {
  test('a meta waits for a new title, tiles do not; the IMDb id then opens the TMDB title', async () => {
    const tile = { type: 'series', id: 'tmdb:318158', _tmdbId: '318158', imdb_id: null, name: 'Красота' };
    let asked = 0;
    const d: Deps = { ...deps(krasota), details: async () => { asked++; await new Promise((r) => setTimeout(r, 30)); return krasota; } };

    const tiles = [tile, { type: 'series', id: 'tt0903747', imdb_id: 'tt0903747' }];
    const first = await withImdbIds(tiles, {}, false, d);
    assert.equal(first, tiles);
    assert.equal(tmdbIdForMatchedImdb('series', 'tt34829929'), null);

    const [meta] = await withImdbIds([tile], {}, true, d);
    assert.equal(meta.imdb_id, 'tt34829929');
    assert.equal(tile.imdb_id, null);
    assert.equal(asked, 1);

    const later = await withImdbIds(tiles, {}, false, d);
    assert.equal(later[0].imdb_id, 'tt34829929');
    assert.equal(later[1], tiles[1]);
    assert.equal(asked, 1);

    assert.equal(tmdbIdForMatchedImdb('series', 'tt34829929'), 'tmdb:318158');
    process.env.IMDB_MATCH = '0';
    assert.equal(tmdbIdForMatchedImdb('series', 'tt34829929'), null);
    assert.equal(await withImdbIds(tiles, {}, true, d), tiles);
    delete process.env.IMDB_MATCH;
    assert.equal(tmdbIdForMatchedImdb('movie', 'tt34829929'), null);
    assert.equal(tmdbIdForMatchedImdb('series', 'tt0903747'), null);
    assert.equal(tmdbIdForMatchedImdb('series', 'tmdb:318158'), null);
  });

  test('an id TMDB gave is put on tiles but does not reroute a meta', async () => {
    const own = { ...krasota, external_ids: { imdb_id: 'tt7777777' } };
    const [meta] = await withImdbIds([{ type: 'series', id: 'tmdb:5', imdb_id: null }], {}, true, deps(own));
    assert.equal(meta.imdb_id, 'tt7777777');
    assert.equal(tmdbIdForMatchedImdb('series', 'tt7777777'), null);
  });

  test('an IMDb id matched to two TMDB titles of a kind goes to neither', async () => {
    const twin = { ...krasota, external_ids: {} };
    const tiles = [{ type: 'series', id: 'tmdb:7', imdb_id: null }, { type: 'series', id: 'tmdb:8', imdb_id: null }];
    const first = await withImdbIds([tiles[0]], {}, true, deps(twin));
    assert.equal(first[0], tiles[0]);
    assert.equal(tmdbIdForMatchedImdb('series', 'tt34829929'), null);
    await withImdbIds([tiles[1]], {}, true, deps(twin));
    assert.equal(await withImdbIds(tiles, {}, false, deps(twin)), tiles);
    // The first match (tmdb:318158 above) is withheld too.
    const [krasotaTile] = await withImdbIds([{ type: 'series', id: 'tmdb:318158', imdb_id: null }], {}, false, deps(krasota));
    assert.equal(krasotaTile.imdb_id, null);
  });

  test('a meta moves its title ahead of the tiles queued before it', async () => {
    const order: string[] = [];
    const slow: Deps = {
      ...deps({ ...krasota, original_language: 'en', origin_country: ['US'] }),
      details: async (_kind, id) => { order.push(id); await new Promise((r) => setTimeout(r, 20)); return { original_language: 'en' }; },
    };
    const tiles = Array.from({ length: 8 }, (_, n) => ({ type: 'series', id: `tmdb:${200 + n}`, imdb_id: null }));
    await withImdbIds(tiles, {}, false, slow);
    await withImdbIds([tiles[7]], {}, true, slow);
    // Two were running already; the meta's title is next.
    assert.equal(order.indexOf('207'), 2);
  });

  test('failures leave the tiles as they are', async () => {
    const tiles = [{ type: 'series', id: 'tmdb:6', imdb_id: null }];
    const down: Deps = { ...deps(krasota), details: async () => { throw new Error('down'); } };
    assert.equal(await withImdbIds(tiles, {}, true, down), tiles);
  });
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

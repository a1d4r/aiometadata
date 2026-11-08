/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/shikimori.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  applyView,
  baseUrlOf,
  clientOf,
  firstSeasonMalId,
  malIdOf,
  mergeRow,
  plainDescription,
  projectView,
  retryAfterMs,
  ttlFor,
  withShikimori,
  lookUpShikimori,
  OTHER_TTL_MS,
  SETTLED_TTL_MS,
  VIEW_VERSION,
  type AnimeMapper,
  type StoredRow,
} from './shikimori';

const NOW = Date.parse('2026-11-09T12:00:00Z');

// A small Fribb: Re:Zero-like show with every season on TMDB season 1, a movie, a movie of several parts.
const FRIBB: any[] = [
  { mal_id: 39587, type: 'TV', themoviedb_id: 65942, themoviedb_type: 'tv', imdb_id: 'tt5607616', season: { tvdb: 2, tmdb: 1 } },
  { mal_id: 31240, type: 'TV', themoviedb_id: 65942, themoviedb_type: 'tv', imdb_id: 'tt5607616', season: { tvdb: 1, tmdb: 1 } },
  { mal_id: 31950, type: 'Special', themoviedb_id: 65942, themoviedb_type: 'tv', season: { tvdb: 0, tmdb: 0 } },
  { mal_id: 32281, type: 'Movie', themoviedb_id: 372058, themoviedb_type: 'movie', imdb_id: 'tt5311514' },
  { mal_id: 9260, type: 'Movie', themoviedb_id: 1, themoviedb_type: 'movie', imdb_id: 'tt0000001', multi_part: true },
  { mal_id: 20, type: 'TV', themoviedb_id: 46260, themoviedb_type: 'tv', imdb_id: 'tt0409591', season: {} },
];
const seriesLike = new Set(['tv', 'ova', 'ona', 'special']);
const isSeries = (entry: any) => seriesLike.has(String(entry.type).toLowerCase());
const fakeMapper: AnimeMapper = {
  getMappingByTmdbId: (id, type) => FRIBB.find((e) => String(e.themoviedb_id) === String(id) && (type === 'series' ? isSeries(e) : !isSeries(e))) ?? null,
  getSeriesMappingsByTmdbId: (id) => FRIBB.filter((e) => String(e.themoviedb_id) === String(id) && isSeries(e)),
  getMappingByImdbId: (id) => FRIBB.find((e) => e.imdb_id === id) ?? null,
  mappingIsType: (mapping, type) => (type === 'series' ? isSeries(mapping) : !isSeries(mapping)),
};

describe('malIdOf', () => {
  test('a show takes its first TV season, whatever TMDB season Fribb gives', () => {
    assert.equal(malIdOf({ type: 'series', _tmdbId: '65942' }, fakeMapper), 31240);
    assert.equal(malIdOf({ type: 'series', id: 'tmdb:65942' }, fakeMapper), 31240);
    assert.equal(malIdOf({ type: 'series', id: 'tt0409591', imdb_id: 'tt0409591' }, fakeMapper), 20, 'by IMDb id when there is no TMDB id');
  });

  test('a movie by TMDB, else IMDb id; a movie of several parts is skipped', () => {
    assert.equal(malIdOf({ type: 'movie', _tmdbId: '372058' }, fakeMapper), 32281);
    assert.equal(malIdOf({ type: 'movie', _tmdbId: '999', imdb_id: 'tt5311514' }, fakeMapper), 32281);
    assert.equal(malIdOf({ type: 'movie', _tmdbId: '1', imdb_id: 'tt0000001' }, fakeMapper), null);
  });

  test('a mal: id is used as is, even before the mapping is loaded', () => {
    assert.equal(malIdOf({ type: 'series', id: 'mal:64867' }, null), 64867);
    assert.equal(malIdOf({ type: 'series', _tmdbId: '65942' }, null), null);
  });

  test('not anime, or the wrong kind', () => {
    assert.equal(malIdOf({ type: 'movie', _tmdbId: '550', imdb_id: 'tt0137523' }, fakeMapper), null);
    assert.equal(malIdOf({ type: 'movie', _tmdbId: '65942' }, fakeMapper), null, 'a show id asked for as a movie');
    assert.equal(malIdOf({ type: 'series', imdb_id: 'tt5311514' }, fakeMapper), null, 'a movie asked for as a show');
    assert.equal(malIdOf({ type: 'anime', id: 'mal:1' }, fakeMapper), null);
    assert.equal(malIdOf(null, fakeMapper), null);
  });

  test('firstSeasonMalId ranks TV before others, then the lowest season', () => {
    assert.equal(firstSeasonMalId([{ mal_id: 5, type: 'ONA', season: { tvdb: 1 } }, { mal_id: 7, type: 'TV', season: { tvdb: 3 } }]), 7);
    assert.equal(firstSeasonMalId([{ mal_id: 9, type: 'TV', season: {} }, { mal_id: 8, type: 'TV', season: {} }]), 8);
    assert.equal(firstSeasonMalId([{ mal_id: null, type: 'TV' }]), null);
    assert.equal(firstSeasonMalId([]), null);
  });
});

describe('texts', () => {
  test('BBCode is unwrapped, spoilers and the source dropped, paragraphs kept', () => {
    const raw = 'Отряд героя [character=186854]Химмеля[/character] вернулся.\r\n\r\n\r\n[spoiler=спойлер]Химмель умрёт[/spoiler]Фрирен [i]уходит[/i] — [[Эльф]]&nbsp;&laquo;в путь&raquo;.<br>[source]ANN[/source]';
    assert.equal(plainDescription(raw), 'Отряд героя Химмеля вернулся.\n\nФрирен уходит — Эльф «в путь».');
    assert.equal(plainDescription('<p>Текст &amp; <b>ещё</b></p>'), 'Текст & ещё');
    assert.equal(plainDescription(null), '');
  });

  test('original names in brackets after the Russian ones are dropped; years and titles stay', () => {
    assert.equal(plainDescription('Сэнку Исигами [石神 千空] — гений. Мэй [Mei Kusakabe]. Момонга [Momonga], лич.'), 'Сэнку Исигами — гений. Мэй. Момонга, лич.');
    assert.equal(plainDescription('[character=184947]Сэнку[/character] [石神 千空] и «Цукаса [獅子王 司]»'), 'Сэнку и «Цукаса»');
    assert.equal(plainDescription('Синигами (死神様) и Мака (Maka Albarn), Сората (神田 空太).'), 'Синигами и Мака, Сората.');
    assert.equal(plainDescription('Ремейк (2024) по манге (TV), в «Стране» ("Deadman Wonderland"), студия MAPPA (Tokyo).'), 'Ремейк (2024) по манге (TV), в «Стране» ("Deadman Wonderland"), студия MAPPA (Tokyo).');
    assert.equal(plainDescription('Кира [Light (夜神月)] и [Рюк]'), 'Кира и [Рюк]', 'a bracket with Cyrillic is not an original name');
  });

  test('what a dropped name or spoiler leaves before punctuation goes too', () => {
    assert.equal(plainDescription('и Мэй [Mei],[spoiler]умрёт[/spoiler].'), 'и Мэй.');
    assert.equal(plainDescription('Конец [spoiler]x[/spoiler] , и всё [spoiler]y[/spoiler] !'), 'Конец, и всё!');
  });

  test('a hostile description takes no time', () => {
    const inputs = [' '.repeat(50_000) + '[', 'а' + '\t '.repeat(25_000) + 'б', '[a='.repeat(20_000), '[['.repeat(30_000), '<'.repeat(60_000), 'Аа ('.repeat(20_000), '[spoiler]'.repeat(10_000)];
    for (const input of inputs) {
      const started = Date.now();
      plainDescription(input);
      assert.ok(Date.now() - started < 200, `${JSON.stringify(input.slice(0, 6))}… took ${Date.now() - started} ms`);
    }
  });

  test('[br] is a line break, not glue', () => {
    assert.equal(plainDescription('из строя.[br][br]Главному герою'), 'из строя.\n\nГлавному герою');
    assert.equal(plainDescription('раз[br]два[BR /]три'), 'раз\nдва\nтри');
  });

  test('a nested or unclosed spoiler lets nothing out', () => {
    assert.equal(plainDescription('Начало. [spoiler]а[spoiler]б[/spoiler]хвост[/spoiler] Конец.'), 'Начало. Конец.');
    assert.equal(plainDescription('Начало. [spoiler=раз]а[spoiler=два]б[/spoiler]в[spoiler]г[/spoiler]хвост[/spoiler]Конец.'), 'Начало. Конец.');
    assert.equal(plainDescription('Начало. [spoiler]всё, что дальше'), 'Начало.');
    assert.equal(plainDescription('Начало[/spoiler] и конец.'), 'Начало и конец.');
  });

  test('a link with its text inside the tag keeps the text; a wrapping one keeps its own', () => {
    assert.equal(plainDescription('подруга [character=43669 коко-кага], с которой'), 'подруга коко-кага, с которой');
    assert.equal(plainDescription('[character=146156 тандзиро-камадо]Тандзиро[/character] и все'), 'Тандзиро и все');
  });

  test('only Russian texts are kept', () => {
    assert.deepEqual(projectView({ russian: '  Атака   титанов ', description: 'С давних времён…' }), { name: 'Атака титанов', description: 'С давних времён…' });
    assert.deepEqual(projectView({ russian: 'Beyblade X', description: 'Beginner blader' }), {});
    assert.deepEqual(projectView({ russian: null, description: null }), {});
    assert.deepEqual(projectView(null), {});
  });

  test('a month for a released title with both texts, a week otherwise', () => {
    assert.equal(ttlFor({ status: 'released' }, { name: 'А', description: 'Б' }), SETTLED_TTL_MS);
    assert.equal(ttlFor({ status: 'ongoing' }, { name: 'А', description: 'Б' }), OTHER_TTL_MS);
    assert.equal(ttlFor({ status: 'released' }, { name: 'А' }), OTHER_TTL_MS);
    assert.equal(ttlFor(null, null), OTHER_TTL_MS);
  });

  test('a text with Cyrillic stays; others take the Russian one; the tile itself is untouched', () => {
    const tile = { name: 'Beyblade X', description: 'Beginner blader', englishTitle: 'Beyblade X' };
    const out = applyView(tile, { name: 'Бейблэйд X', description: 'Начинающий' });
    assert.deepEqual(out, { name: 'Бейблэйд X', description: 'Начинающий', englishTitle: 'Beyblade X' });
    assert.equal(tile.name, 'Beyblade X');
    const russian = { name: 'Фрирен, провожающая в последний путь', description: 'Эльфийка' };
    assert.equal(applyView(russian, { name: 'Провожающая в последний путь Фрирен', description: 'Другое' }), russian);
    const mixed = { name: 'Dragon Ball Super: Бирус', description: 'When Beerus' };
    assert.deepEqual(applyView(mixed, { name: 'Драконий жемчуг', description: 'Когда Бирус' }), { name: 'Dragon Ball Super: Бирус', description: 'Когда Бирус' });
    assert.equal(applyView(tile, {}), tile);
  });

  test('mergeRow keeps the last good data when a title goes missing', () => {
    const good = mergeRow(1, undefined, { id: '1', russian: 'Аниме', description: 'Описание', status: 'released' }, NOW);
    assert.equal(good.found, 1);
    assert.equal(good.view_v, VIEW_VERSION);
    assert.equal(good.expires_at, NOW + SETTLED_TTL_MS);
    const later = mergeRow(1, good, undefined, NOW + 1000);
    assert.equal(later.view, good.view);
    assert.equal(later.expires_at, NOW + 1000 + OTHER_TTL_MS);
    const none: StoredRow = mergeRow(2, undefined, undefined, NOW);
    assert.equal(none.found, 0);
    assert.equal(none.view, null);
  });

  test('the switch and Retry-After', () => {
    assert.equal(baseUrlOf('https://shikimori.io/'), 'https://shikimori.io');
    assert.equal(baseUrlOf(''), null);
    assert.equal(baseUrlOf('0'), null);
    assert.equal(baseUrlOf('shikimori.io'), null);
    assert.equal(baseUrlOf('https://shikimori.io/api'), null);
    assert.deepEqual(clientOf('https://shikimori.io/', ' Melange '), { base: 'https://shikimori.io', userAgent: 'Melange' });
    assert.equal(clientOf('https://shikimori.io', ''), null, 'no requests without the application name');
    assert.equal(clientOf('https://shikimori.io', 'Мелания'), null, 'not a valid header value');
    assert.equal(clientOf('https://shikimori.io', 'Melange\nX-Evil: 1'), null);
    assert.equal(clientOf('', 'Melange'), null);
    assert.equal(retryAfterMs('5'), 5000);
    assert.equal(retryAfterMs(null), 60_000);
    assert.equal(retryAfterMs('99999'), 30 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Queue and store, with stand-ins for fetch, the tracker and the mapper
// ---------------------------------------------------------------------------

const stub = (name: string, exports: object) => {
  const Module = require('node:module');
  const file = require.resolve(name);
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[file] = mod;
};
stub('./requestTracker', { trackProviderCall: () => undefined });
stub('./id-mapper', { ...fakeMapper, isInitialized: () => true });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Anime tiles with English texts, as `mal:` ids. */
const animeTiles = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `mal:${from + i}`, type: 'series', name: `Anime ${from + i}`, description: 'English text' }));

interface Call {
  at: number;
  url: string;
  ua: string | null;
  ids: number[];
}

describe('withShikimori', () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shikimori-test-'));
  const dbFile = path.join(dir, 'addon', 'data', 'shikimori.sqlite');
  let calls: Call[] = [];
  let answer: (call: Call) => Promise<Response> | Response;
  const ok = (call: Call) =>
    Response.json({ data: { animes: call.ids.filter((id) => id % 10 !== 9).map((id) => ({ id: String(id), russian: `Аниме ${id}`, licenseNameRu: null, status: 'released', description: `[i]Описание[/i] ${id}` })) } });
  const sql = () => new BetterSqlite3(dbFile);

  before(() => {
    process.chdir(dir);
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      const call: Call = { at: Date.now(), url: String(url), ua: new Headers(init.headers).get('User-Agent'), ids: body.variables.ids.split(',').map(Number) };
      calls.push(call);
      return answer(call);
    }) as typeof fetch;
    answer = ok;
  });

  after(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
    delete process.env.SHIKIMORI_URL;
    delete process.env.SHIKIMORI_USER_AGENT;
    delete process.env.SHIKIMORI_CATALOG_WAIT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('switched off: the tiles come back as they are and no file is opened', async () => {
    process.env.SHIKIMORI_USER_AGENT = 'Melange-test';
    for (const value of [undefined, '', '0']) {
      if (value === undefined) delete process.env.SHIKIMORI_URL;
      else process.env.SHIKIMORI_URL = value;
      const metas = animeTiles(1, 2);
      assert.equal(await withShikimori(metas), metas);
    }
    process.env.SHIKIMORI_URL = 'https://shiki.test/';
    for (const value of [undefined, '', '  ']) {
      if (value === undefined) delete process.env.SHIKIMORI_USER_AGENT;
      else process.env.SHIKIMORI_USER_AGENT = value;
      const metas = animeTiles(1, 2);
      assert.equal(await withShikimori(metas), metas, 'an address without the application name is off too');
    }
    process.env.SHIKIMORI_USER_AGENT = 'Melange-test';
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(dbFile), false);
  });

  test('new anime wait for one batch; Russian tiles and non-anime are not asked for', async () => {
    process.env.SHIKIMORI_URL = 'https://shiki.test/';
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '3000';
    const metas = [
      ...animeTiles(100, 2),
      { id: 'tt5607616', type: 'series', _tmdbId: '65942', name: 'Re:ZERO – Жизнь с нуля', description: 'Субару Нацуки' },
      { id: 'tt0137523', type: 'movie', _tmdbId: '550', name: 'Fight Club', description: 'An insomniac' },
      { id: 'tt5311514', type: 'movie', _tmdbId: '372058', name: 'Your Name.', description: 'Две старшеклассницы' },
    ];
    const out = await withShikimori(metas);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://shiki.test/api/graphql');
    assert.equal(calls[0].ua, 'Melange-test');
    assert.deepEqual(calls[0].ids.sort(), [100, 101, 32281]);
    assert.deepEqual(out[0], { id: 'mal:100', type: 'series', name: 'Аниме 100', description: 'Описание 100' });
    assert.equal(out[2], metas[2], 'a Russian tile is the same object');
    assert.equal(out[3], metas[3], 'not anime');
    assert.equal(out[4].name, 'Аниме 32281');
    assert.equal(out[4].description, 'Две старшеклассницы', 'a Russian description stays');
    assert.equal(metas[0].name, 'Anime 100', 'the input tiles are untouched');

    calls = [];
    const again = await withShikimori(animeTiles(100, 2));
    assert.equal(calls.length, 0, 'stored anime are not asked for again');
    assert.equal(again[1].name, 'Аниме 101');
  });

  test('more than 50 anime go in batches of 50, a second apart; not found ones are stored as such', async () => {
    calls = [];
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '5000';
    const out = await withShikimori(animeTiles(1000, 60));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].ids.length, 50);
    assert.equal(calls[1].ids.length, 10);
    assert.ok(calls[1].at - calls[0].at >= 990, `second batch ${calls[1].at - calls[0].at} ms after the first`);
    assert.equal(out[59].name, 'Anime 1059', 'not found on Shikimori: unchanged');
    assert.equal(out[58].name, 'Аниме 1058');
    const db = sql();
    const row = db.prepare('SELECT found, expires_at, last_access FROM shiki_animes WHERE mal_id = 1059').get() as StoredRow;
    db.close();
    assert.equal(row.found, 0);
    assert.ok(Math.abs(row.expires_at - (Date.now() + OTHER_TTL_MS)) < 10_000);
  });

  test('a response waits no longer than the wait, and the answer comes on the next view', async () => {
    calls = [];
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '200';
    answer = async (call) => {
      await pause(600);
      return ok(call);
    };
    const started = Date.now();
    const first = await withShikimori(animeTiles(2000, 1));
    assert.ok(Date.now() - started < 1500, `waited ${Date.now() - started} ms`);
    assert.equal(first[0].name, 'Anime 2000');
    await pause(1500);
    assert.equal((await withShikimori(animeTiles(2000, 1)))[0].name, 'Аниме 2000');
    answer = ok;
  });

  test('stale anime are served as is and refreshed in the background', async () => {
    calls = [];
    const db = sql();
    db.prepare('UPDATE shiki_animes SET expires_at = 0 WHERE mal_id = 100').run();
    db.close();
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '3000';
    const started = Date.now();
    const out = await withShikimori(animeTiles(100, 1));
    assert.ok(Date.now() - started < 300, 'stale anime do not wait');
    assert.equal(out[0].name, 'Аниме 100');
    await pause(1500);
    assert.equal(calls.length, 1);
  });

  test('429 pauses for Retry-After; failures leave the tiles as they are and are not asked again soon', async () => {
    await pause(1100);
    calls = [];
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '300';
    answer = () => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
    const metas = animeTiles(3000, 1);
    assert.equal(await withShikimori(metas), metas);
    const limitedAt = calls[0].at;
    answer = ok;
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '4000';
    assert.equal((await withShikimori(animeTiles(3000, 1)))[0].name, 'Anime 3000', 'failed anime are not asked again for 10 minutes');
    assert.equal(calls.length, 1);
    const next = await withShikimori(animeTiles(4000, 1));
    assert.equal(next[0].name, 'Аниме 4000');
    assert.ok(calls[1].at - limitedAt >= 1990, `next request ${calls[1].at - limitedAt} ms after the 429`);

    calls = [];
    answer = () => {
      throw new TypeError('fetch failed');
    };
    const other = animeTiles(5000, 1);
    assert.equal(await withShikimori(other), other);
    answer = () => Response.json({ errors: [{ message: 'bad' }] });
    const refused = animeTiles(6000, 1);
    assert.equal(await withShikimori(refused), refused);
    answer = ok;
  });

  test('lookUp applies by the tile ids, so it works on copies made by other lookups', async () => {
    const metas = animeTiles(100, 1);
    const add = await lookUpShikimori(metas);
    const copies = [{ ...metas[0], kpRating: '7.0' }];
    assert.deepEqual(add(copies)[0], { id: 'mal:100', type: 'series', name: 'Аниме 100', description: 'Описание 100', kpRating: '7.0' });
    assert.equal(add([{ id: 'tt0137523', type: 'movie', name: 'Fight Club' }])[0].name, 'Fight Club');
  });

  // Last: the pause it starts lasts half an hour.
  test('403 pauses every request for as long as a 429 ever does', async () => {
    await pause(1100);
    calls = [];
    process.env.SHIKIMORI_CATALOG_WAIT_MS = '300';
    answer = () => new Response('{}', { status: 403 });
    const banned = animeTiles(4500, 1);
    assert.equal(await withShikimori(banned), banned);
    assert.equal(calls.length, 1);
    answer = ok;
    const other = animeTiles(4600, 1);
    assert.equal(await withShikimori(other), other);
    await pause(1500);
    assert.equal(calls.length, 1, 'nothing goes out during the pause');
  });
});

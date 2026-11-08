/*
 * Run without network or a real key:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/tmdbLogoInfo.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The real TMDB client needs Redis and a key: here it answers from a table and counts calls.
const calls: string[] = [];
let answers: Record<string, any> = {};
let delayMs = 0;
{
  const Module = require('node:module');
  const file = require.resolve('./getTmdb');
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = {
    titleImagesUncached: async (type: string, id: string) => {
      calls.push(`${type}:${id}`);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const answer = answers[`${type}:${id}`];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  };
  require.cache[file] = mod;
}

import { isKnownLogo, logoFileOf, logoRows, titleOf, lookUpTmdbLogoInfo, withLogoFields, withTmdbLogoInfo } from './tmdbLogoInfo';

const RU = '8YGHe69tPNbSaMbUwSo3AHkELKJ.png';
const EN = 'enLogo.png';
const interstellar = {
  logos: [
    { file_path: `/${EN}`, iso_639_1: 'en', width: 1000, height: 300 },
    { file_path: `/${RU}`, iso_639_1: 'ru', width: 775, height: 212 },
    { file_path: '/plain.svg', iso_639_1: null, width: 400, height: 100 },
  ],
};
const cached = (file: string) => `https://aiometadata.example/poster-cache/logo/https://image.tmdb.org/t/p/original/${file}`;

describe('logoFileOf', () => {
  test('TMDB logo, raw or behind the image cache', () => {
    assert.equal(logoFileOf(`https://image.tmdb.org/t/p/w500/${RU}`), RU);
    assert.equal(logoFileOf(cached(RU)), RU);
    assert.equal(logoFileOf(`https:/image.tmdb.org/t/p/original/${RU}`), RU);
  });

  test('anything else is not a TMDB logo', () => {
    assert.equal(logoFileOf('https://artworks.thetvdb.com/banners/v4/movie/1/clearlogo/x.png'), null);
    assert.equal(logoFileOf('https://assets.fanart.tv/fanart/movies/1/hdmovielogo/x.png'), null);
    assert.equal(logoFileOf(undefined), null);
    assert.equal(logoFileOf({}), null);
  });
});

describe('titleOf', () => {
  test('TMDB id from _tmdbId or a tmdb: id, with the kind of the tile', () => {
    assert.deepEqual(titleOf({ type: 'movie', id: 'tt0816692', _tmdbId: '157336' }), { k: 'movie:157336', type: 'movie', id: '157336' });
    assert.deepEqual(titleOf({ type: 'series', id: 'tmdb:1399' }), { k: 'tv:1399', type: 'tv', id: '1399' });
  });

  test('no TMDB id, no title', () => {
    assert.equal(titleOf({ type: 'movie', id: 'tt0816692' }), null);
    assert.equal(titleOf({ type: 'anime', _tmdbId: '1' }), null);
    assert.equal(titleOf(null), null);
  });
});

describe('logoRows', () => {
  test('language as given, "xx" and empty as null, broken paths dropped', () => {
    assert.deepEqual(
      logoRows({ logos: [
        { file_path: '/a.png', iso_639_1: 'ru', width: 775, height: 212 },
        { file_path: '/b.png', iso_639_1: 'xx', width: 0, height: '1' },
        { file_path: '/c.svg', iso_639_1: null },
        { file_path: 'no-slash.png', iso_639_1: 'en' },
        { file_path: '/../x.png', iso_639_1: 'en' },
      ] }),
      [
        { file: 'a.png', lang: 'ru' },
        { file: 'b.png', lang: null },
        { file: 'c.svg', lang: null },
      ],
    );
    assert.deepEqual(logoRows(null), []);
    assert.deepEqual(logoRows({ posters: [] }), []);
  });
});

describe('withLogoFields', () => {
  test('adds the language to a copy and keeps everything else as it is, Dates included', () => {
    const released = new Date('2014-11-05T00:00:00Z');
    const meta = { id: 'tt0816692', logo: cached(RU), released };
    const out = withLogoFields(meta, { file: RU, lang: 'ru' });
    assert.notEqual(out, meta);
    assert.deepEqual(out, { id: 'tt0816692', logo: cached(RU), released, logoLang: 'ru' });
    assert.equal(out.released, released);
    assert.equal('logoLang' in meta, false);
  });

  test('null language is sent as null', () => {
    assert.deepEqual(withLogoFields({}, { file: 'x.svg', lang: null }), { logoLang: null });
  });

  test('nothing known, the meta itself', () => {
    const meta = { logo: cached(RU) };
    assert.equal(withLogoFields(meta, undefined), meta);
  });
});

describe('withTmdbLogoInfo', () => {
  const realCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdblogos-test-'));

  before(() => {
    process.chdir(dir);
    answers = { 'movie:157336': interstellar, 'tv:1399': { logos: [{ file_path: '/got.png', iso_639_1: 'en', width: 800, height: 200 }] } };
  });

  after(() => {
    process.chdir(realCwd);
    delete process.env.TMDB_LOGO_INFO_WAIT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a new title is read once, waited for, and kept in the file', async () => {
    calls.length = 0;
    const metas = [
      { id: 'tt0816692', type: 'movie', _tmdbId: '157336', logo: cached(RU) },
      { id: 'tt0944947', type: 'series', _tmdbId: '1399', logo: `https://image.tmdb.org/t/p/original/got.png` },
      { id: 'tt0816692', type: 'movie', _tmdbId: '157336', logo: cached(EN) },
    ];
    const out = await withTmdbLogoInfo(metas, {});
    assert.deepEqual(calls.sort(), ['movie:157336', 'tv:1399']);
    assert.deepEqual(out.map((m: any) => m.logoLang), ['ru', 'en', 'en']);
    assert.ok(out.every((m: any) => !('logoW' in m) && !('logoH' in m)), 'no logo size: Melange does not read it');
    assert.equal(out[0].logo, cached(RU));
    assert.equal('logoLang' in metas[0], false);
    assert.ok(fs.existsSync(path.join(dir, 'addon', 'data', 'tmdblogos.sqlite')));

    calls.length = 0;
    const again = await withTmdbLogoInfo([{ type: 'movie', id: 'tmdb:157336', logo: cached('plain.svg') }], {});
    assert.deepEqual(calls, []);
    assert.deepEqual(again[0], { type: 'movie', id: 'tmdb:157336', logo: cached('plain.svg'), logoLang: null });
  });

  test('adds the language to the tiles as another lookup left them, as one after the other would', async () => {
    const metas = [
      { type: 'movie', _tmdbId: '157336', logo: cached(RU) },
      { type: 'movie', _tmdbId: '2' },
      { type: 'movie', _tmdbId: '157336', logo: cached(EN) },
    ];
    const addLogoInfo = await lookUpTmdbLogoInfo(metas, {});
    const changed = [{ ...metas[0], kpRating: '8.6' }, metas[1], metas[2]];
    const out = addLogoInfo(changed);
    assert.deepEqual(out, await withTmdbLogoInfo(changed, {}));
    assert.deepEqual(out.map((m: any) => [m.kpRating, m.logoLang]), [['8.6', 'ru'], [undefined, undefined], [undefined, 'en']]);
    assert.equal(out[1], metas[1]);
    assert.equal((await lookUpTmdbLogoInfo([metas[1]], {}))(changed), changed, 'nothing to add: the same array');
  });

  test('follows each tile by its logo when another lookup dropped or reordered tiles', async () => {
    const metas = [
      { type: 'movie', _tmdbId: '157336', logo: cached(RU) },
      { type: 'movie', _tmdbId: '2' },
      { type: 'movie', _tmdbId: '157336', logo: cached(EN) },
    ];
    const addLogoInfo = await lookUpTmdbLogoInfo(metas, {});
    const out = addLogoInfo([metas[2], metas[0]]);
    assert.deepEqual(out.map((m: any) => m.logoLang), ['en', 'ru']);
  });

  test('knows the logos it has seen, by the file name without the extension', () => {
    assert.equal(isKnownLogo(RU.replace(/\.png$/, '')), true);
    assert.equal(isKnownLogo('plain'), true, 'an SVG, asked for as .png');
    assert.equal(isKnownLogo('neverSeen'), false);
  });

  test('non-TMDB logo, no logo or no TMDB id: the same array, nothing asked', async () => {
    calls.length = 0;
    const metas = [
      { type: 'movie', _tmdbId: '1', logo: 'https://artworks.thetvdb.com/banners/x.png' },
      { type: 'movie', _tmdbId: '2' },
      { type: 'movie', id: 'tt1', logo: cached('unknown.png') },
      null,
    ];
    assert.equal(await withTmdbLogoInfo(metas, {}), metas);
    assert.deepEqual(calls, []);
  });

  test('a logo missing from the answer is not asked for again the same day', async () => {
    calls.length = 0;
    const metas = [{ type: 'movie', _tmdbId: '157336', logo: cached('new.png') }];
    assert.equal(await withTmdbLogoInfo(metas, {}), metas);
    answers['movie:500'] = { logos: [] };
    const other = [{ type: 'movie', _tmdbId: '500', logo: cached('x500.png') }];
    assert.equal(await withTmdbLogoInfo(other, {}), other);
    assert.equal(await withTmdbLogoInfo(other, {}), other);
    assert.deepEqual(calls, ['movie:500']);
  });

  test('a failed request leaves the tiles as they are and is not repeated at once', async () => {
    calls.length = 0;
    answers['movie:600'] = new Error('TMDB down');
    const metas = [{ type: 'movie', _tmdbId: '600', logo: cached('x600.png') }];
    assert.equal(await withTmdbLogoInfo(metas, {}), metas);
    assert.equal(await withTmdbLogoInfo(metas, {}), metas);
    assert.deepEqual(calls, ['movie:600']);
  });

  test('a slow answer is not waited for past the limit and lands for the next response', async () => {
    calls.length = 0;
    process.env.TMDB_LOGO_INFO_WAIT_MS = '20';
    delayMs = 100;
    answers['movie:700'] = { logos: [{ file_path: '/x700.png', iso_639_1: 'ru', width: 10, height: 5 }] };
    const metas = [{ type: 'movie', _tmdbId: '700', logo: cached('x700.png') }];
    const started = Date.now();
    assert.equal(await withTmdbLogoInfo(metas, {}), metas);
    assert.ok(Date.now() - started < 90);
    await new Promise((resolve) => setTimeout(resolve, 150));
    delayMs = 0;
    const out = await withTmdbLogoInfo(metas, {});
    assert.equal(out[0].logoLang, 'ru');
    assert.deepEqual(calls, ['movie:700']);
  });
});

describe('a store made with logo sizes', () => {
  test('is read and written as it is', async () => {
    const realCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdblogos-old-'));
    fs.mkdirSync(path.join(dir, 'addon', 'data'), { recursive: true });
    const file = path.join(dir, 'addon', 'data', 'tmdblogos.sqlite');
    const BetterSqlite3 = require('better-sqlite3');
    const old = new BetterSqlite3(file);
    old.exec('CREATE TABLE tmdb_logos (file TEXT PRIMARY KEY, lang TEXT, w INTEGER, h INTEGER) WITHOUT ROWID');
    old.prepare('INSERT INTO tmdb_logos VALUES (?, ?, ?, ?)').run('old.png', 'ru', 775, 212);
    old.close();
    // A module of its own: the one above keeps its store open in another folder.
    const id = require.resolve('./tmdbLogoInfo');
    const shared = require.cache[id];
    delete require.cache[id];
    process.chdir(dir);
    try {
      const fresh = require('./tmdbLogoInfo') as typeof import('./tmdbLogoInfo');
      answers['movie:800'] = { logos: [{ file_path: '/new800.png', iso_639_1: 'en', width: 10, height: 5 }] };
      const out = await fresh.withTmdbLogoInfo([
        { type: 'movie', _tmdbId: '1', logo: cached('old.png') },
        { type: 'movie', _tmdbId: '800', logo: cached('new800.png') },
      ], {});
      assert.deepEqual(out.map((m: any) => m.logoLang), ['ru', 'en']);
      assert.equal(fresh.isKnownLogo('new800'), true);
    } finally {
      process.chdir(realCwd);
      require.cache[id] = shared;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

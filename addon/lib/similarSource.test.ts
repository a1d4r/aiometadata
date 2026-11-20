/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/similarSource.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// The anime mappings, as id-mapper would answer for Frieren's IMDb and TMDB ids.
const MAPPED = new Set(['tt22248376', 'tmdb:209867']);
const id = require.resolve(path.join(__dirname, 'jellyfin', 'canonicalIds'));
require.cache[id] = {
  id, filename: id, loaded: true,
  exports: { isAnimeTitle: (titleId: string) => MAPPED.has(titleId) },
} as any;
const { simklPicksSimilar } = require('./similarSource');

const tmdbMeta = (over: any) => ({ _providerArt: { anime: false, originalLanguage: 'en' }, ...over });
const frierenByImdb = tmdbMeta({ id: 'tt22248376', _imdbId: 'tt22248376', _tmdbId: '209867', _providerArt: { anime: false, originalLanguage: 'ja' } });
const frierenByTmdb = tmdbMeta({ id: 'tmdb:209867', _tmdbId: '209867', _providerArt: { anime: false, originalLanguage: 'ja' } });
const malAnime = { id: 'kitsu:1', _malId: '52991' };
const leviathan = tmdbMeta({ id: 'tt2802154', _imdbId: 'tt2802154', _tmdbId: '265180', _providerArt: { anime: false, originalLanguage: 'ru' } });
const tvdbRussian = { id: 'tt28429213', _imdbId: 'tt28429213', _originalLanguage: 'rus' };
const darkKnight = tmdbMeta({ id: 'tt0468569', _imdbId: 'tt0468569', _tmdbId: '155' });
const japaneseDrama = tmdbMeta({ id: 'tt0000002', _tmdbId: '2', _providerArt: { anime: false, originalLanguage: 'ja' } });

function withEnv(value: string | undefined, run: () => void) {
  const before = process.env.SIMILAR_SIMKL_FOR;
  if (value === undefined) delete process.env.SIMILAR_SIMKL_FOR;
  else process.env.SIMILAR_SIMKL_FOR = value;
  try { run(); } finally {
    if (before === undefined) delete process.env.SIMILAR_SIMKL_FOR;
    else process.env.SIMILAR_SIMKL_FOR = before;
  }
}

test('unset, TMDB for every title, as upstream', () => withEnv(undefined, () => {
  for (const meta of [frierenByImdb, malAnime, leviathan, darkKnight]) {
    assert.equal(simklPicksSimilar(meta, 'series'), false);
  }
}));

test('anime goes to Simkl by its MAL id, its mapped IMDb or TMDB id, or the meta saying so', () => withEnv('anime,ru', () => {
  assert.equal(simklPicksSimilar(frierenByImdb, 'series'), true);
  assert.equal(simklPicksSimilar(frierenByTmdb, 'series'), true);
  assert.equal(simklPicksSimilar(malAnime, 'series'), true);
  assert.equal(simklPicksSimilar(tmdbMeta({ id: 'tt1', _providerArt: { anime: true } }), 'series'), true);
}));

test('a Russian title goes to Simkl whether TMDB says "ru" or TVDB "rus"', () => withEnv('anime, RU', () => {
  assert.equal(simklPicksSimilar(leviathan, 'movie'), true);
  assert.equal(simklPicksSimilar(tvdbRussian, 'series'), true);
}));

test('western and Japanese live action stay on TMDB', () => withEnv('anime,ru', () => {
  assert.equal(simklPicksSimilar(darkKnight, 'movie'), false);
  assert.equal(simklPicksSimilar(japaneseDrama, 'series'), false);
  assert.equal(simklPicksSimilar({}, 'movie'), false);
}));

test('only what is listed: "ru" alone keeps anime on TMDB', () => withEnv('ru', () => {
  assert.equal(simklPicksSimilar(frierenByImdb, 'series'), false);
  assert.equal(simklPicksSimilar(leviathan, 'movie'), true);
}));

test('Simkl in time: its answer', async () => {
  const { withinSimklWait } = require('./similarSource');
  assert.deepEqual(await withinSimklWait(Promise.resolve([1, 2]), 50), [1, 2]);
});

test('Simkl too slow: none, so TMDB answers; its late failure goes nowhere', async () => {
  const { withinSimklWait } = require('./similarSource');
  const slow = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('connect timeout')), 80));
  const started = Date.now();
  assert.deepEqual(await withinSimklWait(slow, 20), []);
  assert.ok(Date.now() - started < 70);
  await new Promise((resolve) => setTimeout(resolve, 100)); // an unhandled rejection would fail the run
});

test('Simkl failing in time: the failure, for the caller to catch', async () => {
  const { withinSimklWait } = require('./similarSource');
  await assert.rejects(withinSimklWait(Promise.reject(new Error('412')), 50), /412/);
});

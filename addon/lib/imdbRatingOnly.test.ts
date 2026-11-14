/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/imdbRatingOnly.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const asked: string[][] = [];
const RATINGS: Record<string, string> = { tt0372784: '8.2', tt0108778: '8.9' };
const id = require.resolve(path.join(__dirname, 'imdbRatings'));
require.cache[id] = {
  id, filename: id, loaded: true,
  exports: {
    getImdbRatingStrings: async (ids: string[]) => {
      asked.push(ids);
      return new Map(ids.filter((i) => RATINGS[i]).map((i) => [i, RATINGS[i]]));
    },
  },
} as any;
const { withImdbRatingOnly } = require('./imdbRatingOnly');

test('only an IMDb figure stays: TMDB vote_average and N/A go, without a request per tile', async () => {
  const input = [
    { id: 'tt0372784', name: 'Бэтмен: Начало', imdbRating: '7.7' },
    { id: 'tmdb:1668', _imdbId: 'tt0108778', imdbRating: '8.4' },
    { id: 'tt0000001', imdbRating: 'N/A' },
    { id: 'tmdb:2668', imdbRating: '6.4' },
    { id: 'tmdb:272', imdb_id: 'tt0372784', imdbRating: '7.7' },
  ];
  const out = await withImdbRatingOnly(input);
  assert.deepEqual(out.map((m: any) => m.imdbRating), ['8.2', '8.9', undefined, undefined, '8.2']);
  assert.equal('imdbRating' in out[3], false);
  assert.deepEqual(asked, [['tt0372784', 'tt0108778', 'tt0000001', 'tt0372784']]);
  assert.equal(input[0].imdbRating, '7.7'); // copies: a cached list is not changed
});

test('an empty list asks nothing', async () => {
  asked.length = 0;
  assert.deepEqual(await withImdbRatingOnly([]), []);
  assert.equal(asked.length, 0);
});

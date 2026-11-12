/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/tmdbCreators.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creatorsOf } from './tmdbCreators';

const FACE = 'https://image.tmdb.org/t/p/w276_and_h350_face';

// created_by as tv/{id} gives it; profile paths are made up.
const gameOfThrones = {
  id: 1399,
  name: 'Игра престолов',
  created_by: [
    { id: 9813, credit_id: '5256c8c219c2956ff604858a', name: 'David Benioff', original_name: 'David Benioff', gender: 2, profile_path: '/benioff.jpg' },
    { id: 228068, credit_id: '552e611e9251413fea000901', name: 'D. B. Weiss', original_name: 'D. B. Weiss', gender: 2, profile_path: null },
  ],
};

test('the creators of a series, in the shape of the directors of a movie', () => {
  assert.deepEqual(creatorsOf(gameOfThrones), [
    { name: 'David Benioff', character: 'David Benioff', photo: `${FACE}/benioff.jpg`, tmdbId: 9813 },
    { name: 'D. B. Weiss', character: 'D. B. Weiss', photo: null, tmdbId: 228068 },
  ]);
});

test('no creators, or a creator without a name', () => {
  assert.deepEqual(creatorsOf({ id: 1396, created_by: [] }), []);
  assert.deepEqual(creatorsOf({ id: 1396 }), []);
  assert.deepEqual(creatorsOf({ created_by: null }), []);
  assert.deepEqual(creatorsOf(null), []);
  assert.deepEqual(creatorsOf({ created_by: [null, { id: 1, name: '  ' }, { id: 2 }, { id: 66633, name: ' Vince Gilligan ' }] }), [
    { name: 'Vince Gilligan', character: 'Vince Gilligan', photo: null, tmdbId: 66633 },
  ]);
});

test('a creator without an integer id, which no person page can open', () => {
  assert.deepEqual(creatorsOf({ created_by: [{ name: 'No Id' }, { id: '66633', name: 'String Id' }, { id: 1.5, name: 'Fraction' }, { id: null, name: 'Null' }] }), []);
});

test('the same creators after a JSON round trip of the raw details', () => {
  assert.deepEqual(creatorsOf(JSON.parse(JSON.stringify(gameOfThrones))), creatorsOf(gameOfThrones));
});

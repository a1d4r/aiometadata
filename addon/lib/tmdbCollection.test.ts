/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/tmdbCollection.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belongsToCollectionOf } from './tmdbCollection';

test('the collection of a movie, with the catalog id of its parts', () => {
  const movie = { id: 22, belongs_to_collection: { id: 295, name: ' Пираты Карибского моря (Коллекция) ', poster_path: '/a.jpg', backdrop_path: '/b.jpg' } };
  assert.deepEqual(belongsToCollectionOf(movie), { id: 'tmdb.collection.295', name: 'Пираты Карибского моря (Коллекция)' });
});

test('no collection, or one TMDB gave without a usable id or name', () => {
  assert.equal(belongsToCollectionOf({ id: 550, belongs_to_collection: null }), undefined);
  assert.equal(belongsToCollectionOf({ id: 550 }), undefined);
  assert.equal(belongsToCollectionOf({ belongs_to_collection: { id: '295abc', name: 'X' } }), undefined);
  assert.equal(belongsToCollectionOf({ belongs_to_collection: { id: 0, name: 'X' } }), undefined);
  assert.equal(belongsToCollectionOf({ belongs_to_collection: { id: 295, name: '' } }), undefined);
  assert.equal(belongsToCollectionOf(null), undefined);
});

test('a key the meta can do without: JSON leaves it out when there is no collection', () => {
  assert.equal(JSON.stringify({ name: 'Бойцовский клуб', belongsToCollection: belongsToCollectionOf({}) }), '{"name":"Бойцовский клуб"}');
});

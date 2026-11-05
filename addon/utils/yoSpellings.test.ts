/*
 * Run:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/utils/yoSpellings.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hydrationLimit, yoVariants } from './yoSpellings';

describe('yoVariants', () => {
  test('е as ё, one at a time', () => {
    assert.deepEqual(yoVariants('елки'), ['ёлки']);
    assert.deepEqual(yoVariants('Елки 11'), ['Ёлки 11']);
    assert.deepEqual(yoVariants('зеленая миля'), ['зёленая миля', 'зелёная миля']);
  });

  test('ё as е first, then the е of what is left', () => {
    assert.deepEqual(yoVariants('ёлки'), ['елки']);
    assert.deepEqual(yoVariants('Зелёная миля'), ['Зеленая миля', 'Зёлёная миля']);
  });

  test('three at most, none without е or ё', () => {
    assert.equal(yoVariants('пепельные перелетные').length, 3);
    assert.deepEqual(yoVariants('дюна'), []);
    assert.deepEqual(yoVariants('Dune'), []);
    assert.deepEqual(yoVariants(''), []);
  });
});

describe('hydrationLimit', () => {
  test('upstream 25 alone, 20 more a spelling, 45 at most', () => {
    assert.equal(hydrationLimit([]), 25);
    assert.equal(hydrationLimit(['ёлки']), 45);
    assert.equal(hydrationLimit(['звёзды', 'звезды']), 45);
    assert.equal(hydrationLimit(yoVariants('пепельные перелетные')), 45);
  });
});

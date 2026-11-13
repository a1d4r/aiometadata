/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/metaCastCount.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { withMetaCastCount } from './metaCastCount';

afterEach(() => {
  delete process.env.META_CAST_COUNT;
});

test('META_CAST_COUNT replaces castCount for the meta, leaving the config itself alone', () => {
  process.env.META_CAST_COUNT = '30';
  const config = { castCount: 10, language: 'ru-RU' };
  assert.deepEqual(withMetaCastCount(config), { castCount: 30, language: 'ru-RU' });
  assert.equal(config.castCount, 10);
});

test('unset, empty or invalid META_CAST_COUNT keeps castCount', () => {
  const config = { castCount: 10 };
  assert.equal(withMetaCastCount(config), config);
  for (const value of ['', 'abc', '-1', '2.5']) {
    process.env.META_CAST_COUNT = value;
    assert.equal(withMetaCastCount(config), config);
  }
});

/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/posterCache/card.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// The poster cache imports './x.js' as the build emits it; ts-node outside the project finds only './x.ts'.
{
  const Module = require('node:module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: any[]) {
    try {
      return resolve.call(this, request, ...rest);
    } catch (error) {
      if (request.startsWith('.') && request.endsWith('.js')) return resolve.call(this, request.slice(0, -3), ...rest);
      throw error;
    }
  };
}
const { cardKey, composeCard, logoBox, parseCardPath } = require('./card') as typeof import('./card');

const sharp = require('sharp');

describe('parseCardPath', () => {
  const logo = 'kqjL17yufvn9OVLyXYpvtyrFfak';
  const fan = 'xJHokMbljvjADYdit5fK5VQsXEG.jpg';

  test('takes the line under the logo and TMDB file names', () => {
    const r = parseCardPath(`/card/v1/s/${logo}.svg/${fan}`);
    assert.deepEqual(r, { logo: { file: logo, under: 's' }, fanart: fan });
    assert.equal(cardKey(r!), `card:v1:s:${logo}:${fan}`);
    // An SVG logo is asked from TMDB as .png, so both name one card.
    assert.equal(cardKey(r!), cardKey(parseCardPath(`/card/v1/s/${logo}.png/${fan}`)!));
    assert.notEqual(cardKey(r!), cardKey(parseCardPath(`/card/v1/n/${logo}.png/${fan}`)!));
  });

  test('takes a card with no logo', () => {
    const r = parseCardPath(`/card/v1/${fan}`);
    assert.deepEqual(r, { logo: null, fanart: fan });
    assert.equal(cardKey(r!), `card:v1:${fan}`);
  });

  test('refuses anything off the list', () => {
    for (const path of [
      `/card/v2/s/${logo}.png/${fan}`,
      `/card/v1/1920/s/${logo}.png/${fan}`,
      `/card/v1/x/${logo}.png/${fan}`,
      `/card/v1/s/${fan}`,
      `/card/v1/-/${fan}`,
      `/card/v1/s/${logo}.png/xJHokMbljvjADYdit5fK5VQsXEG.png`,
      `/card/v1/s/${logo}.gif/${fan}`,
      `/card/v1/s/short.png/${fan}`,
      `/card/v1/s/${logo}.png/${fan}?x=1`,
      `/card/v1/s/..%2F${logo}.png/${fan}`,
      `/card/v1/s/https:/image.tmdb.org/t/p/w500/${logo}.png/${fan}`,
      `/card/v1/xJHokMbljvjADYdit5fK5VQsXEG.png`,
      '/card/v1/',
    ]) assert.equal(parseCardPath(path), null, path);
  });
});

describe('logoBox', () => {
  // The four logos of bg_probe (make_img.py), all with an English name under them.
  test('sizes and places a logo as make_img.py of bg_probe', () => {
    assert.deepEqual(logoBox(500, 222, 's'), { left: 130, top: 61, width: 336, height: 149 });
    assert.deepEqual(logoBox(498, 39, 's'), { left: 130, top: 149, width: 780, height: 61 });
    assert.deepEqual(logoBox(500, 171, 's'), { left: 130, top: 79, width: 382, height: 131 });
    assert.deepEqual(logoBox(499, 119, 's'), { left: 130, top: 101, width: 458, height: 109 });
  });

  test('puts the logo 46 px lower with no English name', () => {
    assert.equal(logoBox(500, 222, 'n').top, 61 + 46);
  });

  test('depends only on the proportions', () => {
    assert.deepEqual(logoBox(2000, 888, 's'), logoBox(500, 222, 's'));
  });
});

describe('composeCard', () => {
  async function inputs() {
    const fanart = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const logo = await sharp({ create: { width: 500, height: 222, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    return { fanart, logo };
  }

  async function pixel(img: any, x: number, y: number): Promise<number[]> {
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * info.channels;
    return [data[at], data[at + 1], data[at + 2]];
  }

  const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]) <= 12);

  test('makes a baseline JPEG of the screen: black, the fanart under the mask, the logo', async () => {
    const { fanart, logo } = await inputs();
    const out = await composeCard(fanart, { image: logo, under: 's' });
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.isProgressive, false);
    assert.deepEqual([meta.width, meta.height], [1920, 1080]);
    const img = sharp(out);
    assert.ok(near(await pixel(img, 300, 600), [0, 0, 0]), 'left of the fanart is black');
    assert.ok(near(await pixel(img, 300, 130), [255, 0, 0]), 'the logo, box 130..466 x 61..210');
    assert.ok(near(await pixel(img, 300, 230), [0, 0, 0]), 'under the logo');
    assert.ok(near(await pixel(img, 1900, 1000), [0, 0, 0]), 'under the fanart');
    const [r] = await pixel(img, 1900, 10);
    assert.ok(r > 100, `the fanart shows through the mask at the top right (${r})`);
  });

  test('makes the card with no logo the same, the logo left out', async () => {
    const { fanart, logo } = await inputs();
    const bare = await composeCard(fanart, null);
    const meta = await sharp(bare).metadata();
    assert.deepEqual([meta.width, meta.height], [1920, 1080]);
    assert.ok(near(await pixel(sharp(bare), 300, 130), [0, 0, 0]), 'no logo');
    const [a, b] = await Promise.all([pixel(sharp(bare), 1900, 10), pixel(sharp(await composeCard(fanart, { image: logo, under: 's' })), 1900, 10)]);
    assert.ok(near(a, b), 'the fanart and the mask as with a logo');
  });
});

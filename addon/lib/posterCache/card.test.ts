/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/posterCache/card.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
const { cardKey, composeCard, inCardSlot, logoBox, parseCardPath, posterCardHandler } = require('./card') as typeof import('./card');
const { ImageQueueFull } = require('./resize') as typeof import('./resize');
// TMDB answers from a table here; card.ts reads fetchImage off the module at each call.
const upstream = require('./upstream');
const images: Record<string, Buffer> = {};
const fetched: string[] = [];
upstream.fetchImage = async (url: string) => {
  fetched.push(url);
  const body = images[url];
  if (!body) throw new upstream.UpstreamRejected(`Not in the test table: ${url}`, 404);
  return { body, contentType: url.endsWith('.png') ? 'image/png' : 'image/jpeg' };
};

const sharp = require('sharp');

/** A JPEG of noise cut to its first part: what a dropped download leaves. */
async function cutJpeg(width: number, height: number): Promise<Buffer> {
  const noise = Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 2654435761) >>> 24));
  const whole: Buffer = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
  return whole.subarray(0, Math.floor(whole.length * 0.6));
}

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
  // k = min(sqrt(90000 / (w * h)), 780 / w, 200 / h), the bottom at y 256.
  test('sizes a logo by area, at most 780 x 200, and puts its bottom at y 256', () => {
    // Wide, as Джентльмены at w500: the width bounds it.
    assert.deepEqual(logoBox(498, 39, 'n'), { left: 130, top: 195, width: 780, height: 61 });
    // Nearly square: the height bounds it, its top at y 56.
    assert.deepEqual(logoBox(500, 450, 'n'), { left: 130, top: 56, width: 222, height: 200 });
    // The area bounds the rest.
    assert.deepEqual(logoBox(500, 171, 'n'), { left: 130, top: 81, width: 513, height: 175 });
    assert.deepEqual(logoBox(499, 119, 'n'), { left: 130, top: 109, width: 614, height: 147 });
  });

  test('puts the logo 46 px higher over an English name', () => {
    assert.equal(logoBox(500, 171, 's').top, 81 - 46);
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
    assert.equal(meta.chromaSubsampling, '4:4:4');
    assert.deepEqual([meta.width, meta.height], [1920, 1080]);
    const img = sharp(out);
    assert.ok(near(await pixel(img, 300, 600), [0, 0, 0]), 'left of the fanart is black');
    assert.ok(near(await pixel(img, 300, 130), [255, 0, 0]), 'the logo, box 130..580 x 10..210');
    assert.ok(near(await pixel(img, 300, 230), [0, 0, 0]), 'under the logo');
    assert.ok(near(await pixel(img, 1900, 1000), [0, 0, 0]), 'under the fanart');
    const [r] = await pixel(img, 1900, 10);
    assert.ok(r > 100, `the fanart shows through the mask at the top right (${r})`);
  });

  test('lays a soft edge as a straight resize over black would', async () => {
    // An orange disc fading out over 60 px, as the edges of a TMDB logo: faint pixels keep their colour.
    const [w, h] = [500, 222];
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = Math.round(255 * Math.min(1, Math.max(0, (100 - Math.hypot(x - 250, y - 111)) / 60)));
      if (a) px.set([255, 160, 40, a], (y * w + x) * 4);
    }
    const logo = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const fanart = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const box = logoBox(w, h, 's');
    assert.ok(box.left + box.width <= 640, 'the logo is all over the black left of the fanart');
    const region = { left: box.left, top: box.top, width: box.width, height: box.height };
    const got = await sharp(await composeCard(fanart, { image: logo, under: 's' })).extract(region).raw().toBuffer();
    const want = await sharp(logo).flatten({ background: '#000000' })
      .resize(box.width, box.height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
    let sum = 0;
    let max = 0;
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(got[i] - want[i]);
      sum += d;
      max = Math.max(max, d);
    }
    const mean = sum / want.length;
    // JPEG alone: mean 0.25, max 6 here. Divided by the alpha twice: mean 20, max 254.
    assert.ok(mean < 1 && max < 24, `mean ${mean.toFixed(2)}, max ${max}`);
  });

  test('refuses a cut-off source instead of making a card of it', async () => {
    const { fanart, logo } = await inputs();
    await assert.rejects(composeCard(await cutJpeg(1280, 720), null));
    await assert.rejects(composeCard(fanart, { image: logo.subarray(0, Math.floor(logo.length * 0.6)), under: 's' }));
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

describe('inCardSlot', () => {
  test('one card at a time, a short queue, then ImageQueueFull', async () => {
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const work = () => new Promise<void>((resolve) => {
      running++;
      most = Math.max(most, running);
      releases.push(() => {
        running--;
        resolve();
      });
    });
    const started = Array.from({ length: 9 }, () => inCardSlot(work));
    await assert.rejects(inCardSlot(work), ImageQueueFull, 'the tenth finds the queue full');
    for (let i = 0; i < 9; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(releases.length, i + 1, 'the next starts only when the one before is done');
      releases[i]();
    }
    await Promise.all(started);
    assert.equal(most, 1);
  });

  test('a failed card frees the slot', async () => {
    await assert.rejects(inCardSlot(async () => {
      throw new Error('broken');
    }), /broken/);
    assert.equal(await inCardSlot(async () => 'next'), 'next');
  });
});

describe('posterCardHandler', () => {
  const realCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-test-'));
  const saved = { cache: process.env.ENABLE_BUILTIN_POSTER_CACHE, processed: process.env.POSTER_CACHE_PROCESSED_IMAGES };

  before(() => {
    process.chdir(dir);
    process.env.ENABLE_BUILTIN_POSTER_CACHE = 'true';
    // Built on each request, so nothing is written but the logo store.
    process.env.POSTER_CACHE_PROCESSED_IMAGES = 'false';
  });

  after(() => {
    process.chdir(realCwd);
    for (const [name, value] of [['ENABLE_BUILTIN_POSTER_CACHE', saved.cache], ['POSTER_CACHE_PROCESSED_IMAGES', saved.processed]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function get(url: string) {
    const headers: Record<string, string> = {};
    const res: any = {
      headersSent: false,
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
      end() {
        return this;
      },
    };
    await posterCardHandler()({ path: url, method: 'GET', headers: {} }, res, () => assert.fail('next'));
    return { status: res.statusCode, headers };
  }

  const LOGO = 'kqjL17yufvn9OVLyXYpvtyrFfak';
  const TMDB = 'https://image.tmdb.org/t/p/';

  before(async () => {
    images[`${TMDB}w1280/xJHokMbljvjADYdit5fK5VQsXEG.jpg`] = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    images[`${TMDB}w500/${LOGO}.png`] = await sharp({ create: { width: 500, height: 222, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  });

  test('a logo no tile carries is not fetched: 404, not kept', async () => {
    fetched.length = 0;
    const r = await get(`/card/v1/s/${LOGO}.png/xJHokMbljvjADYdit5fK5VQsXEG.jpg`);
    assert.equal(r.status, 404);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(fetched, []);
  });

  test('a cut-off source is a 503, not kept', async () => {
    images[`${TMDB}w1280/bJHokMbljvjADYdit5fK5VQsXEG.jpg`] = await cutJpeg(320, 180);
    const r = await get('/card/v1/bJHokMbljvjADYdit5fK5VQsXEG.jpg');
    assert.equal(r.status, 503);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('a logo seen on a tile makes the card', async () => {
    const db = new (require('better-sqlite3'))(path.join(dir, 'addon', 'data', 'tmdblogos.sqlite'));
    db.prepare('INSERT INTO tmdb_logos (file, lang) VALUES (?, ?)').run(`${LOGO}.svg`, 'ru');
    db.close();
    // Another fanart: the one above is remembered as failed for a while.
    images[`${TMDB}w1280/aJHokMbljvjADYdit5fK5VQsXEG.jpg`] = images[`${TMDB}w1280/xJHokMbljvjADYdit5fK5VQsXEG.jpg`];
    const r = await get(`/card/v1/s/${LOGO}.png/aJHokMbljvjADYdit5fK5VQsXEG.jpg`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
  });

  test('a logo shown wider than its w500 copy is taken from the original', async () => {
    // As Джентльмены: TMDB gives 498x39 at w500 for a 1111x87 original.
    const wide = 'gJHokMbljvjADYdit5fK5VQsXEG';
    const db = new (require('better-sqlite3'))(path.join(dir, 'addon', 'data', 'tmdblogos.sqlite'));
    db.prepare('INSERT INTO tmdb_logos (file, lang) VALUES (?, ?)').run(`${wide}.png`, 'ru');
    db.close();
    const red = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    images[`${TMDB}w500/${wide}.png`] = await red(498, 39);
    images[`${TMDB}original/${wide}.png`] = await red(1111, 87);
    images[`${TMDB}w1280/cJHokMbljvjADYdit5fK5VQsXEG.jpg`] = images[`${TMDB}w1280/xJHokMbljvjADYdit5fK5VQsXEG.jpg`];
    fetched.length = 0;
    const r = await get(`/card/v1/n/${wide}.png/cJHokMbljvjADYdit5fK5VQsXEG.jpg`);
    assert.equal(r.status, 200);
    assert.ok(fetched.includes(`${TMDB}original/${wide}.png`), fetched.join(', '));
  });
});

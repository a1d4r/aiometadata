/**
 * The card background of Melange: one picture of the fanart, the mask of its info panel
 * and the title logo. The Dune shell switches a card only once its background has
 * loaded and loads a logo drawn over it only after, so the name shows as text first;
 * baked into the background, the logo comes with it.
 *
 *   /poster-cache/card/v1/<s|n>/<logo>.<png|svg>/<fanart>.jpg
 *   /poster-cache/card/v1/<fanart>.jpg    (a title with no logo: the same screen without it)
 *
 * logo and fanart are TMDB file names, so only TMDB is fetched and a URL always means
 * the same picture (the shell keeps a picture by its URL, even across a reinstall).
 * s: an English name is shown under the logo, n: none. v1 is the layout, its size
 * included: a new one is a new version. A failure is never answered with a picture:
 * the shell would keep it.
 */
import * as crypto from 'node:crypto';
import consola from 'consola';
import { isBuiltinPosterCacheEnabled, isBypassed, isClassEnabled, type ImageClass } from './config.js';
import { CARD_V1_MASK } from './cardMask.js';
import { etagMatches } from './proxyResponse.js';
import { inImageSlot } from './resize.js';
import * as store from './store.js';
import { OversizeImage, UpstreamRejected, fetchImage, isNotModified } from './upstream.js';

const logger = consola.withTag('PosterCard');

const TMDB = 'https://image.tmdb.org/t/p/';
const FILE = '[A-Za-z0-9]{10,40}';
const CARD_PATH = new RegExp(`^/card/v1/(?:([sn])/(${FILE})\\.(?:png|svg)/)?(${FILE}\\.jpg)$`);

// Layout v1 on a 1920x1080 screen, as Melange 0.55.0 draws its card (view_catalog.php):
// the fanart in (640, 0, 1280x720) under the mask; the logo as aio_catv_logo sizes it,
// its left at the text of the panel, its bottom at the bottom of the title (y 40 + 216),
// AIO_CATV_SUB_H (46) higher over the English name.
const SCREEN_W = 1920;
const SCREEN_H = 1080;
const FANART_X = 640;
const FANART_W = 1280;
const FANART_H = 720;
const LOGO_X = 130;
const LOGO_BOTTOM = { s: 210, n: 256 };
const LOGO_AREA = 50000;
const LOGO_MAX_W = 780;
const LOGO_MAX_H = 150;
/** The TMDB size of a logo; `original` when it is shown wider. */
const LOGO_SIZE_W = 500;
const JPEG_QUALITY = 88;

const GONE_MS = 5 * 60 * 1000;
const BUSY_MS = 30 * 1000;
const FAILURES_MAX = 5000;

export interface CardRequest {
  /** No logo: null. Else its TMDB file name without the extension (TMDB rasterises an SVG asked as .png) and s/n. */
  logo: { file: string; under: 's' | 'n' } | null;
  fanart: string;
}

export function parseCardPath(path: string): CardRequest | null {
  const m = CARD_PATH.exec(path);
  if (!m) return null;
  return { logo: m[2] ? { file: m[2], under: m[1] as 's' | 'n' } : null, fanart: m[3] };
}

export function cardKey(r: CardRequest): string {
  return r.logo ? `card:v1:${r.logo.under}:${r.logo.file}:${r.fanart}` : `card:v1:${r.fanart}`;
}

/** Where a logo of w x h goes on the screen: the formula of aio_catv_logo. */
export function logoBox(w: number, h: number, under: 's' | 'n'): { left: number; top: number; width: number; height: number } {
  const k = Math.min(Math.sqrt(LOGO_AREA / (w * h)), LOGO_MAX_W / w, LOGO_MAX_H / h);
  const width = Math.max(1, Math.round(w * k));
  const height = Math.max(1, Math.round(h * k));
  return { left: LOGO_X, top: LOGO_BOTTOM[under] - height, width, height };
}

/** A source image through the poster cache, so the copies Melange already asks for are shared. */
async function source(imageClass: ImageClass, url: string): Promise<Buffer> {
  try {
    if (!isClassEnabled(imageClass) || isBypassed(url)) {
      const outcome = await fetchImage(url);
      if (isNotModified(outcome)) throw new Error(`Not modified without validators: ${url}`);
      return outcome.body;
    }
    const { entry } = await store.getOrFetch(imageClass, url, (validators) => fetchImage(url, { validators }));
    if (entry.body) return entry.body;
    const chunks: Buffer[] = [];
    for await (const chunk of entry.openStream!()) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } catch (error: any) {
    if (error instanceof OversizeImage) {
      (error.stream as any).destroy?.();
      throw new UpstreamRejected(`Image over the size limit: ${url}`, 502);
    }
    throw error;
  }
}

export async function composeCard(fanart: Buffer, logo: { image: Buffer; under: 's' | 'n' } | null): Promise<Buffer> {
  const sharp = require('sharp');
  // The shell stretches a background over its frame, whatever its proportions.
  const fan = await sharp(fanart, { failOn: 'none' }).resize(FANART_W, FANART_H, { fit: 'fill' }).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const layers: any[] = [
    { input: fan.data, raw: fan.info, left: FANART_X, top: 0 },
    { input: CARD_V1_MASK, left: FANART_X, top: 0 },
  ];
  if (logo) {
    const { width, height } = await sharp(logo.image, { failOn: 'none' }).metadata();
    if (!width || !height) throw new Error('Logo has no size');
    const box = logoBox(width, height, logo.under);
    const mark = await sharp(logo.image, { failOn: 'none' }).ensureAlpha()
      .resize(box.width, box.height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
    layers.push({ input: mark.data, raw: mark.info, left: box.left, top: box.top });
  }
  // Baseline: whether the shell decodes progressive JPEG is not known.
  return sharp({ create: { width: SCREEN_W, height: SCREEN_H, channels: 3, background: '#000000' } })
    .composite(layers).jpeg({ quality: JPEG_QUALITY, progressive: false }).toBuffer();
}

async function sourceLogo(logo: NonNullable<CardRequest['logo']>): Promise<Buffer> {
  const small = await source('logo', `${TMDB}w${LOGO_SIZE_W}/${logo.file}.png`);
  const { width, height } = await require('sharp')(small, { failOn: 'none' }).metadata();
  // At the TMDB width and shown wider than it: the original is sharper.
  if (width >= LOGO_SIZE_W && height && logoBox(width, height, logo.under).width > width) {
    return source('logo', `${TMDB}original/${logo.file}.png`);
  }
  return small;
}

async function buildCard(r: CardRequest): Promise<Buffer> {
  const [fanart, logo] = await Promise.all([
    source('background', `${TMDB}w1280/${r.fanart}`),
    r.logo ? sourceLogo(r.logo) : null,
  ]);
  const card = logo && r.logo ? { image: logo, under: r.logo.under } : null;
  return inImageSlot(() => composeCard(fanart, card), fanart.length + (logo?.length ?? 0));
}

async function cardBytes(r: CardRequest): Promise<{ body: Buffer; etag: string; status: string }> {
  if (!isClassEnabled('processed')) {
    const body = await buildCard(r);
    return { body, etag: crypto.createHash('sha1').update(body).digest('hex').slice(0, 16), status: 'BYPASS' };
  }
  const { entry, status } = await store.getOrFetch('processed', cardKey(r), async () => ({
    body: await buildCard(r),
    contentType: 'image/jpeg',
  }));
  let body = entry.body;
  if (!body) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry.openStream!()) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  return { body, etag: entry.etag, status };
}

const failures = new Map<string, { until: number; status: number }>();

function remember(key: string, status: number): void {
  failures.set(key, { until: Date.now() + (status === 404 ? GONE_MS : BUSY_MS), status });
  if (failures.size <= FAILURES_MAX) return;
  const now = Date.now();
  for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
  for (const k of failures.keys()) {
    if (failures.size <= FAILURES_MAX) break;
    failures.delete(k);
  }
}

function recentFailure(key: string): number | null {
  const known = failures.get(key);
  if (!known) return null;
  if (known.until > Date.now()) return known.status;
  failures.delete(key);
  return null;
}

/** 404: a source is gone from TMDB (a stale tile); anything else may pass. */
function failureStatus(error: any): number {
  const status = error instanceof UpstreamRejected ? error.status : error?.response?.status;
  return status === 404 || status === 410 ? 404 : 503;
}

function fail(res: any, status: number, message: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: message });
}

export function posterCardHandler() {
  return async function handle(req: any, res: any, next: any): Promise<void> {
    if (!req.path.startsWith('/card/') || !isBuiltinPosterCacheEnabled()) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    const r = parseCardPath(req.path);
    if (!r) return fail(res, 404, 'Expected /poster-cache/card/v1/[<s|n>/<logo>.<png|svg>/]<fanart>.jpg');

    const key = cardKey(r);
    const known = recentFailure(key);
    if (known) return fail(res, known, 'Card failed recently');

    try {
      const { body, etag, status } = await cardBytes(r);
      res.setHeader('X-Cache-Status', status);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('ETag', `"${etag}"`);
      if (etagMatches(req.headers['if-none-match'], `"${etag}"`)) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Length', String(body.length));
      res.status(200).end(req.method === 'HEAD' ? undefined : body);
    } catch (error: any) {
      const status = failureStatus(error);
      remember(key, status);
      logger.warn(`${req.path} ${status}: ${error?.message || error}`);
      if (!res.headersSent) fail(res, status, status === 404 ? 'Source image not found' : 'Card unavailable');
    }
  };
}

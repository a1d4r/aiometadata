import consola from 'consola';
import { yearOf } from './kinoApi';

/**
 * Melange: the Russian name, poster and description of a title AIOMetadata knows only from IMDb, from
 * Kinopoisk (the owner's rule of 23.11.2026; why: dune-plugins knowledge/melange/research/card-ru-fallback-2026-11-23.md).
 * When TMDB does not know a tt, its meta is IMDb's stand-in (_metaProvider "imdb"): a transliterated name
 * («Pyatyy ugol»), no description or an English one, missing_poster.png. When TMDB and IMDb take a series
 * for a film, meta/series/<tt> is null. Only then the kp service of Melange VPS (POST /card) is asked:
 * name, year, poster and the series' seasons from Alloha's table, the description from kpu's card. Never
 * over TMDB's meta: a tt is another title at Kinopoisk now and then (3 of 50 Russian series), and only
 * the stand-ins had no such conflict in the sample.
 *
 * On the way out, after the meta caches, like the Kinopoisk data on tiles (kinoApi.ts): nothing is cached
 * here, kp answers from its SQLite. Off without KP_SERVICE_URL.
 *
 * The poster is Kinopoisk's picture on Yandex's CDN, open in Russia and without a key, in a size of its
 * own for a tile (300x450, kpSearch.ts) and a card (600x900): respond() hands it out as it is, not through
 * /poster-cache, whose hosts Caddy lists (isKpPoster in applyImageCachePrefix).
 */

const logger = consola.withTag('KP Card');

const TIMEOUT_MS = 4000; // kp waits for kpu's card 3 s
const TT = /^tt\d{1,10}$/;
// TMDB or IMDb and Kinopoisk put a series' or an old film's year 1-3 apart; a title under a tt that is another
// title at TMDB was 15 years off (dune-plugins knowledge/melange/research/card-ru-fallback-2026-11-23.md).
export const YEAR_SLACK = 3;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 3000; // Melange's MEL_CM_DESC_MAX
const MAX_EPISODES = 3000; // Melange's MEL_CM_EPS_MAX
// The pictures kp gives (kp.py KP_POSTER): the two hosts, the path, a card's or a tile's size, nothing else.
const KP_POSTER = /^https:\/\/(?:cdnrrviubnyuntopbez5\.svc\.cdn\.yandex\.net|avatars\.mds\.yandex\.net)\/get-kinopoisk-image\/[0-9]{1,10}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:600x900|300x450)$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A poster kp gives: handed out as it is, never through /poster-cache. */
export function isKpPoster(url: unknown): url is string {
  return typeof url === 'string' && KP_POSTER.test(url);
}

export interface KpCard {
  kp: number;
  name: string | null;
  year: number | null;
  poster: string | null;
  description: string | null;
  seasons: Array<[number, number]>;
  released: string | null;
}

function kpUrl(): string {
  return String(process.env.KP_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

/** Whether a meta gets Kinopoisk's fields: a tt asked as a movie or a series, IMDb's stand-in or none. */
export function wantsKpCard(type: string, id: string, meta: any): boolean {
  if (!kpUrl() || (type !== 'movie' && type !== 'series') || !TT.test(String(id))) return false;
  return !meta || meta._metaProvider === 'imdb';
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? Array.from(value.trim()).slice(0, max).join('') : null;
}

/** kp's data checked; null when it is not a title. */
export function cardOf(x: any): KpCard | null {
  if (!x || typeof x !== 'object' || !Number.isInteger(x.kp) || x.kp <= 0) return null;
  // kp gives each season once, in order (alloha_seasons); here only the types and the bound Melange reads.
  const seasons: Array<[number, number]> = [];
  let left = MAX_EPISODES;
  for (const s of Array.isArray(x.seasons) ? x.seasons : []) {
    if (!Array.isArray(s) || !Number.isInteger(s[0]) || !Number.isInteger(s[1]) || s[0] < 1 || s[1] < 1 || left <= 0) continue;
    seasons.push([s[0], Math.min(s[1], left)]);
    left -= Math.min(s[1], left);
  }
  return {
    kp: x.kp,
    name: str(x.name, MAX_NAME),
    year: Number.isInteger(x.year) && x.year > 1800 && x.year < 3000 ? x.year : null,
    poster: isKpPoster(x.poster) ? x.poster : null,
    description: str(x.description, MAX_DESCRIPTION),
    seasons,
    released: typeof x.released === 'string' && ISO_UTC.test(x.released) ? x.released : null,
  };
}

// Required lazily: the tests put a stand-in for it in the require cache.
function track(ms: number, ok: boolean): void {
  try {
    require('./requestTracker').trackProviderCall('kp', ms, ok);
  } catch {
    return;
  }
}

/** kp's card of a tt, or null: none, or kp failed (the meta stays as it is). */
export async function askKpCard(tt: string, type: 'movie' | 'series', fetchImpl: typeof fetch = fetch): Promise<KpCard | null> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${kpUrl()}/card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ tt, type: type === 'series' ? 'tv' : 'movie' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: any = await res.json();
    if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('unexpected answer');
    track(Date.now() - started, true);
    return cardOf(body.data);
  } catch (error: any) {
    track(Date.now() - started, false);
    logger.warn(`kp card failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message}`);
    return null;
  }
}

/** IMDb's stand-in with Kinopoisk's name, poster and description where Kinopoisk has them; a copy. */
export function patchStandIn(meta: any, card: KpCard): any {
  const year = yearOf(meta);
  if (card.year && year && Math.abs(card.year - year) > YEAR_SLACK) return meta;
  const fields: any = {};
  if (card.name) fields.name = card.name;
  if (card.poster) fields.poster = card.poster;
  if (card.description) fields.description = card.description;
  return Object.keys(fields).length ? { ...meta, ...fields } : meta;
}

/**
 * The meta of a title AIOMetadata has none for, in the shape of IMDb's stand-in, or null without a name.
 * A series' episodes are the ones Alloha has, each of them out by the date of Alloha's row, UTC (the owner's
 * choice of 23.11.2026: Melange leaves out a season whose first episode has no date).
 */
export function metaOf(tt: string, type: 'movie' | 'series', card: KpCard): any {
  if (!card.name) return null;
  const year = card.year ? String(card.year) : undefined;
  const meta: any = {
    id: tt, imdb_id: tt, type, name: card.name,
    ...(card.poster ? { poster: card.poster } : {}),
    ...(card.description ? { description: card.description } : {}),
    ...(year ? { year, releaseInfo: year } : {}),
    _metaProvider: 'kinopoisk',
  };
  if (type === 'series') {
    meta.videos = card.seasons.flatMap(([season, episodes]) => Array.from({ length: episodes }, (_, i) => ({
      id: `${tt}:${season}:${i + 1}`, season, episode: i + 1, ...(card.released ? { released: card.released } : {}),
    })));
  }
  return meta;
}

/** The meta route's result with Kinopoisk's fields, for wantsKpCard's metas; anything else as it is. */
export async function withKpCard(result: any, type: string, id: string, ask: typeof askKpCard = askKpCard): Promise<any> {
  const meta = result?.meta ?? null;
  if (!wantsKpCard(type, id, meta)) return result;
  const card = await ask(id, type as 'movie' | 'series');
  if (!card) return result;
  if (meta) {
    const patched = patchStandIn(meta, card);
    return patched === meta ? result : { ...result, meta: patched };
  }
  const built = metaOf(id, type as 'movie' | 'series', card);
  return built ? { ...(result || {}), meta: built } : result;
}

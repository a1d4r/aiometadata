import consola from 'consola';
import { kpItemOf, sourceOf, yearOf } from './kpData';

/**
 * Melange: the Russian name, poster and description of a title AIOMetadata knows only from IMDb, from
 * Kinopoisk (the owner's rule of 23.11.2026; why: dune-plugins knowledge/melange/research/card-ru-fallback-2026-11-23.md).
 * When TMDB does not know a tt, its meta is IMDb's stand-in (_metaProvider "imdb"): a transliterated name
 * («Pyatyy ugol»), no description or an English one, missing_poster.png. When TMDB and IMDb take a series
 * for a film, meta/series/<tt> is null. Then (and for TMDB's with no Russian description, below) the kp
 * service of Melange VPS (POST /card) is asked:
 * name, year, poster and the series' seasons from Alloha's table, the description from kpu's card. Never
 * over TMDB's name or poster: a tt is another title at Kinopoisk now and then (3 of 50 Russian series), and
 * only the stand-ins had no such conflict in the sample.
 *
 * On the way out, after the meta caches, like the Kinopoisk data on tiles (kpData.ts): nothing is cached
 * here, kp answers from its SQLite. Off without KP_SERVICE_URL, but for the stand-in's episodes.
 *
 * IMDb's stand-in gives a series' episodes as number, firstAired and name, and Melange reads episode, released
 * and title (mel_cm_eps leaves out an episode with no episode): they are added, the old fields kept (the owner's
 * rule of 23.11.2026), with kp off too (no KP_SERVICE_URL). An episode IMDb gives no date that Alloha has
 * is out by the date of Alloha's row, as in metaOf: Melange leaves out a season whose first episode has no
 * date («Леди Мэр»: none of 16 dated).
 *
 * TMDB's own meta gets only Kinopoisk's description, when TMDB has none in a Russian config (the owner's rule
 * of 23.11.2026): AIOMetadata then falls back to the English one or none (processOverviewTranslations), and
 * the builder stamps it _completeness.overviewLang 'fallback' (upstream's classifyTmdbLocalization; the card
 * cache keeps the stamp in basic, our line in getCache.ts). Its name, poster and the rest stay TMDB's; the
 * year is checked as for a stand-in, the type by kp. kp is waited for less there (TMDB_TIMEOUT_MS): the
 * description is the only gain, and kp fetches kpu's card on for the next time.
 *
 * The poster is Kinopoisk's picture on Yandex's CDN, open in Russia and without a key, in a size of its
 * own for a tile (300x450, kpSearch.ts) and a card (600x900): respond() hands it out as it is, not through
 * /poster-cache, whose hosts Caddy lists (isKpPoster in applyImageCachePrefix).
 */

const logger = consola.withTag('KP Card');

const TIMEOUT_MS = 4000; // kp waits for kpu's card 3 s
const TMDB_TIMEOUT_MS = 1500; // TMDB's meta: only its description; Melange waits for a meta 4 s
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
// IMDb's name of an episode with no name of its own: none for Melange.
const IMDB_NO_NAME = /^Episode #\d+\.\d+$/;

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

/** TMDB's meta with no description in a Russian config's language: AIOMetadata fell back to English's or none. */
export function tmdbWithNoRuDescription(meta: any, language: unknown): boolean {
  return meta?._metaProvider === 'tmdb' && meta._completeness?.overviewLang === 'fallback'
    && String(language || '').split('-')[0] === 'ru';
}

/**
 * Whether a meta gets Kinopoisk's fields: a tt asked as a movie or a series, IMDb's stand-in or none, or
 * TMDB's with no Russian description.
 */
export function wantsKpCard(type: string, id: string, meta: any, language?: unknown): boolean {
  if (!kpUrl() || (type !== 'movie' && type !== 'series') || !TT.test(String(id))) return false;
  return !meta || meta._metaProvider === 'imdb' || tmdbWithNoRuDescription(meta, language);
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

export interface AskOptions {
  /** The meta there is: kp finds the kp by its names, year, countries and TMDB id as for a tile (kpItemOf). */
  meta?: any;
  timeoutMs?: number;
}

/** kp's card of a tt, or null: none, or kp failed (the meta stays as it is). */
export async function askKpCard(tt: string, type: 'movie' | 'series', options: AskOptions = {}, fetchImpl: typeof fetch = fetch): Promise<KpCard | null> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const source = options.meta ? sourceOf(options.meta) : null;
  const started = Date.now();
  try {
    const res = await fetchImpl(`${kpUrl()}/card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        tt, type: type === 'series' ? 'tv' : 'movie', ...(source ? { item: kpItemOf(options.meta, source, 'day') } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: any = await res.json();
    if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('unexpected answer');
    track(Date.now() - started, true);
    return cardOf(body.data);
  } catch (error: any) {
    // TMDB's meta waits for less than kp waits for kpu: kp not done in time is no failure there.
    if (error?.name === 'TimeoutError' && timeoutMs < TIMEOUT_MS) {
      track(Date.now() - started, true);
      logger.debug(`kp card not in ${timeoutMs} ms: TMDB's description stays`);
      return null;
    }
    track(Date.now() - started, false);
    logger.warn(`kp card failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message}`);
    return null;
  }
}

/** IMDb's firstAired as released, in the form kp gives Alloha's (kp.py alloha_released), or null. */
function releasedOf(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The stand-in's episodes with episode, released and title Melange reads, from number, firstAired and name, or
 * released by Alloha's date for one the card has; null when none changes. Copies: the cached meta is shared.
 */
export function standInEpisodes(videos: unknown, card: KpCard | null): any[] | null {
  if (!Array.isArray(videos)) return null;
  const alloha = new Map(card?.released ? card.seasons : []);
  let changed = false;
  const fixed = videos.map((v) => {
    if (!v || typeof v !== 'object') return v;
    const add: any = {};
    if (v.episode == null && Number.isInteger(v.number)) add.episode = v.number;
    const episode = v.episode ?? add.episode;
    if (v.released == null) {
      const released = releasedOf(v.firstAired)
        ?? (Number.isInteger(episode) && episode >= 1 && episode <= (alloha.get(v.season) ?? 0) ? card!.released : null);
      if (released) add.released = released;
    }
    if (v.title == null && typeof v.name === 'string' && v.name.trim() && !IMDB_NO_NAME.test(v.name.trim())) add.title = v.name;
    if (!Object.keys(add).length) return v;
    changed = true;
    return { ...v, ...add };
  });
  return changed ? fixed : null;
}

/** The card when its year is the meta's (YEAR_SLACK), or null: another title under the tt. */
function cardOfSameTitle(meta: any, card: KpCard | null): KpCard | null {
  const year = yearOf(meta);
  return card && !(card.year && year && Math.abs(card.year - year) > YEAR_SLACK) ? card : null;
}

/** TMDB's meta with Kinopoisk's description in place of the English one or none; the rest as it is. A copy. */
export function patchDescription(meta: any, card: KpCard | null): any {
  const same = cardOfSameTitle(meta, card);
  return same?.description ? { ...meta, description: same.description } : meta;
}

/**
 * IMDb's stand-in with Kinopoisk's name, poster and description where Kinopoisk has them, and its episodes in
 * Melange's fields (standInEpisodes); a card of another year is another title: only the episodes. A copy.
 */
export function patchStandIn(meta: any, card: KpCard | null): any {
  const same = cardOfSameTitle(meta, card);
  const fields: any = {};
  if (same?.name) fields.name = same.name;
  if (same?.poster) fields.poster = same.poster;
  if (same?.description) fields.description = same.description;
  const videos = standInEpisodes(meta.videos, same);
  if (videos) fields.videos = videos;
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
export async function withKpCard(result: any, type: string, id: string, language?: unknown, ask: typeof askKpCard = askKpCard): Promise<any> {
  const meta = result?.meta ?? null;
  const withMeta = (patched: any) => (patched === meta ? result : { ...result, meta: patched });
  if (!wantsKpCard(type, id, meta, language)) return meta?._metaProvider === 'imdb' ? withMeta(patchStandIn(meta, null)) : result;
  const tmdb = tmdbWithNoRuDescription(meta, language);
  const card = await ask(id, type as 'movie' | 'series', { meta, timeoutMs: tmdb ? TMDB_TIMEOUT_MS : TIMEOUT_MS });
  if (meta) return withMeta(tmdb ? patchDescription(meta, card) : patchStandIn(meta, card));
  if (!card) return result;
  const built = metaOf(id, type as 'movie' | 'series', card);
  return built ? { ...(result || {}), meta: built } : result;
}

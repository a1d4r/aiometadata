import consola from 'consola';
import { yearOf } from './kinoApi';
import { mapWithLimit } from '../utils/concurrency';

/**
 * Melange: titles Kinopoisk finds for a search that TMDB does not know by their Russian name
 * («Карл XII», 1974, is only «Karl XII» at TMDB). The kp service of Melange VPS (POST /search) asks
 * kinopoiskapiunofficial.tech for one page and answers its titles of the type that have an IMDb id,
 * those named exactly as the query first, then by Kinopoisk votes. They go after TMDB's own results,
 * on the first page of a TMDB search only, each the tile TMDB search makes of its tt, named as
 * Kinopoisk names it in Russian. TMDB's results are never moved or dropped (append_exact, the
 * owner's rule of 23.11.2026; why: dune-plugins knowledge/melange/research/search-ru-ranking-2026-11-23.md).
 *
 * The added tiles are a search entry of their own next to TMDB's (`kp-tail:` + its key): 12 h like it,
 * a few minutes when kp or TMDB could not answer in full, so a slow moment is not kept for half a day.
 * A response waits for them TAIL_WAIT_MS at most; late ones still fill the entry.
 * Off without KP_SERVICE_URL (the same variable as Kinopoisk data on tiles, kinoApi.ts).
 */

const logger = consola.withTag('KP Search');

const TIMEOUT_MS = 5000; // kp waits for kpu 4 s
const TAIL_WAIT_MS = 6000; // a response waits for the added tiles this long from its start; Melange gives a search 10 s
const PARTIAL_TTL_S = 300;
const MAX_QUERY = 100; // kp's limit
const MAX_ADDED = 20; // one page of kpu is 20 titles of both types
// TMDB and Kinopoisk put a series' or an old film's year 1-3 apart; a title under a tt that is
// another title at TMDB was 15 years off (dune-plugins knowledge/melange/research/card-ru-fallback-2026-11-23.md).
const YEAR_SLACK = 3;

export interface KpHit {
  kp: number;
  tt: string;
  tmdb: number | null;
  name: string | null;
  year: number | null;
}

export interface KpAnswer {
  hits: KpHit[];
  complete: boolean;
}

/** TMDB on a tt: known says whether TMDB has the tt at all; meta is the tile of the type, if any. */
export interface Hydrated {
  known: boolean;
  meta: any | null;
}

export interface TailContext {
  userUUID: string;
  searchKey: string;
  engine: string | null;
  type: string;
  page: number;
  query: unknown;
  cleanId: string;
  language: string;
  config: any;
  cacheOptions: any;
}

function kpUrl(): string {
  return String(process.env.KP_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

/** Whether a search gets titles from Kinopoisk: a title query of a TMDB search, its first page. */
export function wantsKpTail(engine: string | null, type: string, page: number, query: unknown): boolean {
  if (!kpUrl() || engine !== 'tmdb.search' || (type !== 'movie' && type !== 'series') || page !== 1) return false;
  const q = typeof query === 'string' ? query.trim() : '';
  return q.length > 0 && q.length <= MAX_QUERY && !/^(tt\d+|tmdb:\d+)$/i.test(q);
}

const TT = /^tt\d{7,8}$/; // what TMDB search takes for an id (isImdbId, getSearch.ts); any other is a text query there

function hitOf(x: any): KpHit | null {
  if (!x || typeof x.tt !== 'string' || !TT.test(x.tt) || !Number.isInteger(x.kp)) return null;
  return {
    kp: x.kp,
    tt: x.tt,
    tmdb: Number.isInteger(x.tmdb) ? x.tmdb : null,
    name: typeof x.name === 'string' && x.name.trim() ? x.name.trim() : null,
    year: Number.isInteger(x.year) ? x.year : null,
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

/** kp's answer in its order; any failure is an empty, partial one. */
export async function askKp(query: string, type: 'movie' | 'series', fetchImpl: typeof fetch = fetch): Promise<KpAnswer> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${kpUrl()}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ q: query.trim(), type: type === 'series' ? 'tv' : 'movie' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: any = await res.json();
    if (!Array.isArray(body?.data)) throw new Error('unexpected answer');
    track(Date.now() - started, true);
    return { hits: body.data.map(hitOf).filter(Boolean) as KpHit[], complete: body.complete === true };
  } catch (error: any) {
    track(Date.now() - started, false);
    logger.warn(`kp search failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message}`);
    return { hits: [], complete: false };
  }
}

/** The ids a tile is known by: its own, its tt, its TMDB id. */
function idsOf(meta: any): string[] {
  return [meta?.id, meta?.imdb_id, meta?._tmdbId ? `tmdb:${meta._tmdbId}` : null].filter(Boolean).map(String);
}

/**
 * The tiles of kp's titles that TMDB's own results do not have, from hydrate(tt). A tile more than
 * YEAR_SLACK years off kp's is another title under the same tt, so it is not added. A tt TMDB does not
 * know at all («Леди Мэр», 2003) is a tile of what Kinopoisk says, its id, name and year (its meta is
 * AIOMetadata's IMDb one). A tt TMDB knows as the other type, or whose tile TMDB search leaves out
 * (adult), adds nothing. hydrate throwing (TMDB failed) makes the answer partial.
 */
export async function kpTailOf(head: any[], answer: KpAnswer, type: 'movie' | 'series', hydrate: (tt: string) => Promise<Hydrated>): Promise<{ metas: any[]; kpPartial?: true }> {
  const known = new Set(head.flatMap(idsOf));
  const todo = answer.hits.filter((h) => !known.has(h.tt) && !(h.tmdb && known.has(`tmdb:${h.tmdb}`))).slice(0, MAX_ADDED);
  let partial = !answer.complete;
  const built = await mapWithLimit(todo, async (hit) => {
    let found: Hydrated;
    try {
      found = await hydrate(hit.tt);
    } catch {
      partial = true;
      return null;
    }
    if (!found.known) return hit.name ? kpOnlyTile(hit, type) : null;
    const meta = found.meta;
    if (!meta) return null;
    const year = yearOf(meta);
    if (hit.year && year && Math.abs(year - hit.year) > YEAR_SLACK) return null;
    return hit.name ? { ...meta, name: hit.name } : meta;
  });
  const metas: any[] = [];
  for (const meta of built) {
    if (!meta || idsOf(meta).some((id) => known.has(id))) continue;
    idsOf(meta).forEach((id) => known.add(id));
    metas.push(meta);
  }
  return partial ? { metas, kpPartial: true } : { metas };
}

function kpOnlyTile(hit: KpHit, type: 'movie' | 'series'): any {
  const year = hit.year ? String(hit.year) : undefined;
  return { id: hit.tt, imdb_id: hit.tt, type, name: hit.name, ...(year ? { year, releaseInfo: year } : {}) };
}

/** The search entry of the added tiles: a partial one for a few minutes, an error never. */
export function classifyKpTail(result: any, error: any): { type: string; ttl: number | null } {
  if (error || !Array.isArray(result?.metas)) return { type: 'TEMPORARY_ERROR', ttl: 0 };
  return result.kpPartial ? { type: 'PARTIAL', ttl: PARTIAL_TTL_S } : { type: 'SUCCESS', ttl: null };
}

/** TMDB's results, then the added tiles they do not have (the two entries may come from different hours). */
export function appendKpTail(head: any[], tail: any[]): any[] {
  const known = new Set(head.flatMap(idsOf));
  return head.concat(tail.filter((meta) => !idsOf(meta).some((id) => known.has(id))));
}

/**
 * TMDB find by the tt (throws when TMDB fails or answers no lists), then TMDB search's own tile of the
 * title it found, by its TMDB id: the branch of performTmdbSearch that takes `tmdb:<id>` asks no find again.
 */
async function hydrateFromTmdb(tt: string, ctx: TailContext): Promise<Hydrated> {
  const found = await require('./getTmdb').find({ id: tt, external_source: 'imdb_id' }, ctx.config);
  if (!Array.isArray(found?.movie_results) || !Array.isArray(found?.tv_results)) throw new Error('no answer from TMDB find');
  const mine = ctx.type === 'movie' ? found.movie_results : found.tv_results;
  const theirs = ctx.type === 'movie' ? found.tv_results : found.movie_results;
  if (!Number.isInteger(mine[0]?.id)) return { known: mine.length > 0 || theirs.length > 0, meta: null };
  const { getSearch } = require('./getSearch');
  const metas = (await getSearch(ctx.cleanId, ctx.type, ctx.language, { search: `tmdb:${mine[0].id}` }, ctx.config)).metas || [];
  return { known: true, meta: metas[0] ?? null };
}

export interface TailDeps {
  cacheWrapSearch: (userUUID: string, key: string, method: () => Promise<any>, engine: string | null, options: any) => Promise<any>;
  askKp: (query: string, type: 'movie' | 'series') => Promise<KpAnswer>;
  hydrate: (tt: string, ctx: TailContext) => Promise<Hydrated>;
  waitMs: number;
}

const DEPS: TailDeps = {
  cacheWrapSearch: (...args) => require('./getCache').cacheWrapSearch(...args),
  askKp: (query, type) => askKp(query, type),
  hydrate: hydrateFromTmdb,
  waitMs: TAIL_WAIT_MS,
};

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * The search response: head (TMDB's search entry, a promise) and, for a search wantsKpTail takes,
 * the tiles Kinopoisk adds. kp is asked while TMDB searches. Never rejects for the added tiles.
 */
export async function withKpTail(head: Promise<any>, ctx: TailContext, deps: TailDeps = DEPS): Promise<any> {
  if (!wantsKpTail(ctx.engine, ctx.type, ctx.page, ctx.query)) return head;
  const started = Date.now();
  const type = ctx.type as 'movie' | 'series';
  const tail = deps.cacheWrapSearch(ctx.userUUID, `kp-tail:${ctx.searchKey}`, async () => {
    const answer = deps.askKp(String(ctx.query), type);
    const tmdb = await head.catch(() => null);
    if (!Array.isArray(tmdb?.metas)) return { metas: [], kpPartial: true };
    return kpTailOf(tmdb.metas, await answer, type, (tt) => deps.hydrate(tt, ctx));
  }, ctx.engine, { ...ctx.cacheOptions, enableErrorCaching: false, resultClassifier: classifyKpTail })
    .catch((error: any) => {
      logger.warn(`Kinopoisk titles failed: ${error?.message}`);
      return null;
    });
  const response = await head;
  const added = await within(tail, deps.waitMs - (Date.now() - started));
  if (!Array.isArray(added?.metas) || !added.metas.length || !Array.isArray(response?.metas)) return response;
  return { ...response, metas: appendKpTail(response.metas, added.metas) };
}

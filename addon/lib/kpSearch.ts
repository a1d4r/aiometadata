import consola from 'consola';
import { yearOf } from './kpData';
import { mapWithLimit } from '../utils/concurrency';
import { isKpPoster, YEAR_SLACK } from './kpCard';

/**
 * Melange: titles Kinopoisk finds for a search that TMDB does not know by their Russian name
 * («Карл XII», 1974, is only «Karl XII» at TMDB). The kp service of Melange VPS (POST /search) asks
 * kinopoiskapiunofficial.tech for three pages and answers its titles of the type that have an IMDb id.
 * On the first page of a TMDB search they join TMDB's own results, each the tile TMDB search makes of
 * its tt, named as Kinopoisk names it in Russian, and the whole page is sorted by wordx (the owner's
 * rule of 23.11.2026, for one-word voice searches: «Карл» finds «Карл XII»; why: dune-plugins
 * knowledge/melange/research/search-ru-ranking-2026-11-23.md): titles with every word of the query as a
 * whole word of a name, then with the query inside a name, then the rest; within a group by
 * log10(Kinopoisk votes + 10), one more for a name that is the query exactly; else as they came (TMDB's,
 * then Kinopoisk's). The votes are the tile's kpVotes, so the page is sorted on the way out, after
 * kpData.ts gave them (orderBySearch); a title Kinopoisk found has its votes from kp as well.
 *
 * The added tiles are a search entry of their own next to TMDB's (TAIL_KEY + its key): 12 h like it,
 * a few minutes when kp or TMDB could not answer in full, so a slow moment is not kept for half a day.
 * A response waits for them TAIL_WAIT_MS at most; late ones still fill the entry.
 * Off without KP_SERVICE_URL (the same variable as Kinopoisk data on tiles, kpData.ts).
 */

const logger = consola.withTag('KP Search');

const TIMEOUT_MS = 5000; // kp waits for kpu 4 s
const TAIL_WAIT_MS = 6000; // a response waits for the added tiles this long from its start; Melange gives a search 10 s
const PARTIAL_TTL_S = 300;
const MAX_QUERY = 100; // kp's limit
const MAX_ADDED = 20; // TMDB lookups a search, the first in kp's order: Melange looks at the first 20
// The search entry of the added tiles and kp's hits. Any change of what the entry holds (a tile, its
// name, the fields of hits) raises the version: the old entries are then never read, nothing to clear.
const TAIL_KEY = 'kp-tail:v3:';

export interface KpHit {
  kp: number;
  tt: string;
  tmdb: number | null;
  name: string | null;
  nameEn: string | null;
  year: number | null;
  votes: number;
  poster: string | null;
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
    nameEn: typeof x.nameEn === 'string' && x.nameEn.trim() ? x.nameEn.trim() : null,
    year: Number.isInteger(x.year) ? x.year : null,
    votes: Number.isInteger(x.votes) && x.votes > 0 ? x.votes : 0,
    poster: isKpPoster(x.poster) ? x.poster : null, // a tile's 300x450 (kpCard.ts)
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

/** A name as a search compares it: lower case, ё as е, every run of signs a space (kp.py's words). */
export function words(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
}

/** wordx's key of a title (kp.py's wordx): [group, -score], the smaller first. */
export function wordxKey(query: string, names: unknown[], votes: number): [number, number] {
  const q = words(query);
  const qw = q ? q.split(' ') : [];
  let group = 2;
  let exact = false;
  for (const name of names.map(words).filter(Boolean)) {
    exact = exact || name === q;
    const nw = new Set(name.split(' '));
    group = Math.min(group, qw.length && qw.every((w) => nw.has(w)) ? 0 : q && name.includes(q) ? 1 : 2);
  }
  return [group, -(Math.log10(Math.max(votes, 0) + 10) + (exact ? 1 : 0))];
}

/** Items in wordx's order; equal keys keep their order (Array.sort is stable). */
function byWordx<T>(query: string, items: Array<{ item: T; names: unknown[]; votes: number }>): T[] {
  const keyed = items.map((x) => ({ item: x.item, key: wordxKey(query, x.names, x.votes) }));
  keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
  return keyed.map((x) => x.item);
}

/** kp's hits by every id a tile may carry: tt, TMDB id, Kinopoisk id. */
function hitIndex(hits: KpHit[]): (meta: any) => KpHit | undefined {
  const by = new Map<string, KpHit>();
  for (const h of hits) {
    for (const key of [h.tt, h.tmdb ? `tmdb:${h.tmdb}` : null, `kp:${h.kp}`]) if (key && !by.has(key)) by.set(key, h);
  }
  return (meta) => [...idsOf(meta), meta?.kpId ? `kp:${meta.kpId}` : null].map((k) => (k ? by.get(k) : undefined)).find(Boolean);
}

function entryOf(meta: any, hit: KpHit | undefined) {
  const votes = Number(meta?.kpVotes);
  return {
    item: meta,
    names: [meta?.name, meta?.originalTitle, meta?.englishTitle, hit?.name, hit?.nameEn],
    votes: Number.isFinite(votes) && votes > 0 ? votes : hit?.votes || 0,
  };
}

/**
 * The first page of a search in wordx's order, on the way out (the tiles carry kpVotes and kpId now).
 * The same title twice goes, TMDB's tile kept: an added tile with the Kinopoisk id of one of TMDB's,
 * or any tile with an id seen before (a TMDB tile the hooks gave the tt of an added one).
 */
export function orderBySearch(metas: any[], hits: KpHit[], query: string, added: Set<string>): any[] {
  const hitOf = hitIndex(hits);
  const tmdbKp = new Set(metas.filter((m) => !added.has(m?.id) && m?.kpId).map((m) => String(m.kpId)));
  const seen = new Set<string>();
  const kept = metas.filter((m) => {
    if (added.has(m?.id) && m?.kpId && tmdbKp.has(String(m.kpId))) return false;
    if (m?.id && seen.has(m.id)) return false;
    if (m?.id) seen.add(m.id);
    return true;
  });
  return byWordx(query, kept.map((m) => entryOf(m, hitOf(m))));
}

/**
 * The tiles of kp's titles that TMDB's own results do not have, the first MAX_ADDED in kp's order
 * (wordx's on Kinopoisk's names and votes). From hydrate(tt). A tile more than
 * YEAR_SLACK years off kp's is another title under the same tt, so it is not added. A tt TMDB does not
 * know at all («Леди Мэр», 2003) is a tile of what Kinopoisk says, its id, name, poster and year (its meta
 * is AIOMetadata's IMDb one, with Kinopoisk's fields, kpCard.ts). A tt TMDB knows as the other type, or whose tile TMDB search leaves out
 * (adult), adds nothing. hydrate throwing (TMDB failed) makes the answer partial.
 */
export async function kpTailOf(head: any[], answer: KpAnswer, type: 'movie' | 'series', hydrate: (tt: string) => Promise<Hydrated>): Promise<{ metas: any[]; hits: KpHit[]; kpPartial?: true }> {
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
  return partial ? { metas, hits: answer.hits, kpPartial: true } : { metas, hits: answer.hits };
}

function kpOnlyTile(hit: KpHit, type: 'movie' | 'series'): any {
  const year = hit.year ? String(hit.year) : undefined;
  return { id: hit.tt, imdb_id: hit.tt, type, name: hit.name, ...(hit.poster ? { poster: hit.poster } : {}), ...(year ? { year, releaseInfo: year } : {}) };
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

/** What a search answers before the hooks on the way out, and how its page is sorted after them. */
export interface Searched {
  response: any;
  finish: ((metas: any[]) => any[]) | null;
}

/**
 * The search response: head (TMDB's search entry, a promise) and, for a search wantsKpTail takes,
 * the tiles Kinopoisk adds, with `finish` to sort the page once the tiles have their votes. kp is
 * asked while TMDB searches. Never rejects for the added tiles; without kp's answer, finish is null
 * and TMDB's order stays.
 */
export async function withKpTail(head: Promise<any>, ctx: TailContext, deps: TailDeps = DEPS): Promise<Searched> {
  if (!wantsKpTail(ctx.engine, ctx.type, ctx.page, ctx.query)) return { response: await head, finish: null };
  const started = Date.now();
  const type = ctx.type as 'movie' | 'series';
  const query = String(ctx.query);
  const tail = deps.cacheWrapSearch(ctx.userUUID, `${TAIL_KEY}${ctx.searchKey}`, async () => {
    const answer = deps.askKp(query, type);
    const tmdb = await head.catch(() => null);
    if (!Array.isArray(tmdb?.metas)) return { metas: [], hits: [], kpPartial: true };
    return kpTailOf(tmdb.metas, await answer, type, (tt) => deps.hydrate(tt, ctx));
  }, ctx.engine, { ...ctx.cacheOptions, enableErrorCaching: false, resultClassifier: classifyKpTail })
    .catch((error: any) => {
      logger.warn(`Kinopoisk titles failed: ${error?.message}`);
      return null;
    });
  const response = await head;
  const got = await within(tail, deps.waitMs - (Date.now() - started));
  const hits: KpHit[] = Array.isArray(got?.hits) ? got.hits : [];
  if (!Array.isArray(response?.metas) || !hits.length) return { response, finish: null };
  const metas = appendKpTail(response.metas, Array.isArray(got?.metas) ? got.metas : []);
  const added = new Set<string>(metas.slice(response.metas.length).map((m: any) => m.id));
  return { response: { ...response, metas }, finish: (out) => orderBySearch(out, hits, query, added) };
}

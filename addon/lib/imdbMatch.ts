import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';

/**
 * An IMDb id for Russian TMDB titles that TMDB has none for, so that Melange can ask stream
 * addons for them (`<tt>:<season>:<episode>`): new Russian series often reach IMDb weeks before
 * TMDB links them, and by a TMDB id stream addons find nothing or another title's releases.
 *
 * A title is matched against IMDb's suggestion endpoint by its transliterated original title and
 * its English one. A candidate counts only when its kind and year (±1) agree, the numbers in its
 * title are those of the title's own, and at least one of the two actors IMDb lists for it is in
 * TMDB's cast. Exactly one candidate must remain, and TMDB must not have linked that IMDb id to
 * another title (a sequel with the same cast). A wrong id is worse than none: anything in doubt
 * stays without one. Measured on 88 Russian titles of 2024-2026 without an IMDb id in TMDB
 * (melange-vps reports/imdb-match.md): 42 matched, none wrong.
 *
 * Runs on the way out, after the caches, like the other Melange fields: tiles and metas get
 * `imdb_id`, and a meta asked for by a matched IMDb id is built from its TMDB id (meta route).
 * Matches live in their own SQLite file and are never dropped for lack of use: a watchlist or a
 * history keeps the IMDb id and opens the title by it. Read from the environment:
 *   IMDB_MATCH                  0 turns it all off: no imdb_id added, no IMDb id rerouted (the store is kept);
 *   IMDB_MATCH_WAIT_MS          how long a meta waits for a title never matched (2500 by default;
 *                               0 never waits); catalog and search tiles never wait.
 */

const logger = consola.withTag('IMDb match');

const SUGGEST_URL = 'https://v3.sg.media-imdb.com/suggestion/titles/x/';
const CONCURRENCY = 2;
const SUGGEST_INTERVAL_MS = 300;
const TIMEOUT_MS = 10_000;
const QUEUE_LIMIT = 2000;
const RETRY_MS = 10 * 60_000;
const IMDB_PAUSE_MS = 10 * 60_000;
// IMDb answers a longer query with 400 ("exceeds the limit of 200").
const MAX_QUERY = 200;
const TMDB_URL = 'https://api.themoviedb.org/3';
const DAY = 86_400_000;
const RECHECK_MS = 30 * DAY;
const NEW_MISS_MS = 3 * DAY;
const OLD_MISS_MS = 30 * DAY;
const FORGET_MISS_AFTER_MS = 90 * DAY;
const PURGE_EVERY_MS = 3_600_000;
const REOPEN_AFTER_MS = 10 * 60_000;
const BUSY_TIMEOUT_MS = 50;
const DEFAULT_WAIT_MS = 2500;
const CAST_LIMIT = 40;
const YEAR_SLACK = 1;

export type Kind = 'movie' | 'tv';

/** Why a title has the id it has, or none. */
export type Via = 'tmdb' | 'match';
export type Miss = 'not-russian' | 'no-candidate' | 'ambiguous' | 'conflict' | 'no-cast';

export interface Outcome {
  imdb: string | null;
  via: Via | null;
  reason: Miss | null;
  /** TMDB's year of the title: how soon a miss is tried again. */
  year: number | null;
}

export interface Facts {
  kind: Kind;
  tmdbId: string;
  tmdbImdb: string | null;
  russian: boolean;
  year: number | null;
  titles: string[];
  queries: string[];
  cast: Set<string>;
}

export interface Suggestion {
  id: string;
  title: string;
  qid: string;
  year: number | null;
  actors: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const IMDB_ID = /^tt\d{1,10}$/;
const NUMERIC_ID = /^\d+$/;
const TMDB_STREMIO_ID = /^tmdb:(\d+)$/;
const CYRILLIC = /[а-яё]/i;
const LATIN = /[a-z]/i;

const QIDS: Record<Kind, Set<string>> = {
  movie: new Set(['movie', 'tvMovie', 'video', 'short']),
  tv: new Set(['tvSeries', 'tvMiniSeries']),
};

// IMDb romanizes Russian titles close to BGN/PCGN: Potyomkin, Tsenturiya, Khozyain Moskvy.
const ROMAN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function romanize(text: string): string {
  return Array.from(text.toLowerCase(), (ch) => ROMAN[ch] ?? ch).join('');
}

/**
 * A person's name reduced so that romanizations of one Russian name meet: Dmitriy, Dmitry and
 * Дмитрий; Aleksandr and Alexander; Potyomkin and Потёмкин. The key is the first name's initial
 * and the surname.
 */
export function personKey(name: string): string | null {
  let s = romanize(String(name ?? '')).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/[^a-z ]/g, ' ');
  for (const [from, to] of [['kh', 'h'], ['ks', 'x'], ['iy', 'i'], ['yi', 'i'], ['ii', 'i'], ['j', 'i'], ['y', 'i'],
    ['ts', 'c'], ['tz', 'c'], ['ie', 'e'], ['ye', 'e'], ['yo', 'e'], ['io', 'e']] as const) {
    s = s.split(from).join(to);
  }
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 2 ? `${words[0][0]} ${words[words.length - 1]}` : null;
}

/** The numbers in a title, in order: "Smersh 3" and "Смерш 3" agree, "Одна дома 3" and its part 2 do not. */
export function numbersOf(title: string): string {
  return (String(title ?? '').match(/\d+/g) ?? []).map((n) => String(Number(n))).join(' ');
}

function yearOf(date: unknown): number | null {
  const year = Number.parseInt(String(date ?? '').slice(0, 4), 10);
  return Number.isFinite(year) && year > 1800 ? year : null;
}

/** What matching needs from one TMDB details answer in English with credits and external ids appended. */
export function factsOf(kind: Kind, tmdbId: string, details: any): Facts {
  const tmdbImdb = String(details?.external_ids?.imdb_id ?? details?.imdb_id ?? '');
  const countries = [
    ...(Array.isArray(details?.origin_country) ? details.origin_country : []),
    ...(Array.isArray(details?.production_countries) ? details.production_countries.map((c: any) => c?.iso_3166_1) : []),
  ];
  const original = String((kind === 'tv' ? details?.original_name : details?.original_title) ?? '').trim();
  const english = String((kind === 'tv' ? details?.name : details?.title) ?? '').trim();
  const titles = [...new Set([original, english].filter(Boolean))];
  const queries: string[] = [];
  for (const title of titles) {
    const query = Array.from((CYRILLIC.test(title) ? romanize(title) : title.toLowerCase()).replace(/\s+/g, ' ').trim())
      .slice(0, MAX_QUERY).join('').trim();
    if (query && LATIN.test(query) && !queries.includes(query)) queries.push(query);
  }
  const credits = kind === 'tv' ? (details?.aggregate_credits ?? details?.credits) : details?.credits;
  const cast = new Set<string>();
  for (const person of (Array.isArray(credits?.cast) ? credits.cast : []).slice(0, CAST_LIMIT)) {
    for (const name of [person?.name, person?.original_name]) {
      const key = personKey(name);
      if (key) cast.add(key);
    }
  }
  return {
    kind,
    tmdbId,
    tmdbImdb: IMDB_ID.test(tmdbImdb) ? tmdbImdb : null,
    russian: details?.original_language === 'ru' || countries.includes('RU'),
    year: yearOf(kind === 'tv' ? details?.first_air_date : details?.release_date),
    titles,
    queries,
    cast,
  };
}

/**
 * The titles of one suggestion answer. An answer without the `d` list is IMDb turning the client
 * away with a 2xx (as utils/imdbSuggestions.ts notes), not a title it lacks: it throws.
 */
export function parseSuggestions(body: any): Suggestion[] {
  if (!Array.isArray(body?.d)) throw new Error('no suggestion payload');
  return body.d
    .filter((entry: any) => typeof entry?.id === 'string' && IMDB_ID.test(entry.id) && typeof entry.qid === 'string')
    .map((entry: any) => ({
      id: entry.id,
      title: String(entry.l ?? ''),
      qid: entry.qid,
      year: Number.isInteger(entry.y) ? entry.y : null,
      actors: String(entry.s ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    }));
}

export function castHits(facts: Facts, candidate: Suggestion): number {
  return candidate.actors.filter((name) => {
    const key = personKey(name);
    return key !== null && facts.cast.has(key);
  }).length;
}

/**
 * The one candidate that is this title, or why there is none. A candidate with no year on IMDb
 * (a series not out yet) needs both its actors in the cast.
 */
export function pick(facts: Facts, candidates: Suggestion[]): { id: string } | { reason: Miss } {
  const numbers = new Set(facts.titles.map(numbersOf));
  const seen = new Set<string>();
  const fits: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (!QIDS[facts.kind].has(candidate.qid) || !numbers.has(numbersOf(candidate.title))) continue;
    const hits = castHits(facts, candidate);
    const yearFits = candidate.year === null
      ? hits >= 2
      : facts.year !== null && Math.abs(candidate.year - facts.year) <= YEAR_SLACK;
    if (yearFits && hits >= 1) fits.push(candidate.id);
  }
  if (fits.length === 1) return { id: fits[0] };
  return { reason: fits.length > 1 ? 'ambiguous' : 'no-candidate' };
}

/** Whether TMDB leaves an IMDb id free for this title: linked to nothing, or to this very title. */
export function findAgrees(kind: Kind, tmdbId: string, found: any): boolean {
  const linked = [
    ...(Array.isArray(found?.movie_results) ? found.movie_results.map((r: any) => `movie:${r?.id}`) : []),
    ...(Array.isArray(found?.tv_results) ? found.tv_results.map((r: any) => `tv:${r?.id}`) : []),
  ];
  return linked.length === 0 || (linked.length === 1 && linked[0] === `${kind}:${tmdbId}`);
}

export interface Deps {
  details(kind: Kind, tmdbId: string): Promise<any>;
  find(imdbId: string): Promise<any>;
  suggest(query: string): Promise<Suggestion[]>;
}

/** Matches one TMDB title. Throws when TMDB or IMDb could not be asked: such a title is tried again later. */
export async function matchTitle(kind: Kind, tmdbId: string, deps: Deps): Promise<Outcome> {
  const facts = factsOf(kind, tmdbId, await deps.details(kind, tmdbId));
  const { year } = facts;
  const miss = (reason: Miss): Outcome => ({ imdb: null, via: null, reason, year });
  if (facts.tmdbImdb) return { imdb: facts.tmdbImdb, via: 'tmdb', reason: null, year };
  if (!facts.russian) return miss('not-russian');
  if (facts.cast.size === 0) return miss('no-cast');
  const candidates: Suggestion[] = [];
  for (const query of facts.queries) candidates.push(...await deps.suggest(query));
  const picked = pick(facts, candidates);
  if ('reason' in picked) return miss(picked.reason);
  if (!findAgrees(kind, tmdbId, await deps.find(picked.id))) return miss('conflict');
  return { imdb: picked.id, via: 'match', reason: null, year };
}

export interface Row {
  k: string;
  imdb: string | null;
  via: Via | null;
  reason: Miss | null;
  checked_at: number;
  expires_at: number;
  last_access: number;
}

/**
 * The row to store after a check. A match found before survives a later check that finds nothing
 * (IMDb's suggestions shift with popularity), but not one where TMDB links its id elsewhere.
 */
export function nextRow(k: string, prev: Row | undefined, outcome: Outcome, now: number): Row {
  const base = { k, checked_at: now, last_access: now };
  if (outcome.imdb) return { ...base, imdb: outcome.imdb, via: outcome.via, reason: null, expires_at: now + RECHECK_MS };
  if (prev?.imdb && prev.via === 'match' && outcome.reason !== 'conflict' && outcome.reason !== 'not-russian') {
    return { ...prev, checked_at: now, expires_at: now + RECHECK_MS, last_access: Math.max(prev.last_access, now) };
  }
  const fresh = outcome.year === null || outcome.year >= new Date(now).getUTCFullYear() - 1;
  const wait = outcome.reason === 'not-russian' ? OLD_MISS_MS : fresh ? NEW_MISS_MS : OLD_MISS_MS;
  return { ...base, imdb: null, via: null, reason: outcome.reason, expires_at: now + wait };
}

/** The TMDB title of a tile or meta that has no IMDb id of its own; null for anything else. */
export function titleOf(meta: any): { k: string; kind: Kind; id: string } | null {
  if (!meta || typeof meta !== 'object' || (meta.type !== 'movie' && meta.type !== 'series')) return null;
  if (IMDB_ID.test(String(meta.imdb_id ?? '')) || IMDB_ID.test(String(meta.id ?? ''))) return null;
  const ownId = String(meta._tmdbId ?? '');
  const id = NUMERIC_ID.test(ownId) ? ownId : TMDB_STREMIO_ID.exec(String(meta.id ?? ''))?.[1];
  if (!id) return null;
  const kind: Kind = meta.type === 'series' ? 'tv' : 'movie';
  return { k: `tmdb:${kind}:${id}`, kind, id };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Store {
  db: BetterSqlite3.Database;
  read: BetterSqlite3.Statement;
  byImdb: BetterSqlite3.Statement;
  touch: BetterSqlite3.Statement;
  upsert: BetterSqlite3.Statement;
  purge: BetterSqlite3.Statement;
}

let store: Store | null = null;
let openFailedUntil = 0;
let lastWarned = 0;

function warn(message: string): void {
  if (Date.now() - lastWarned > 60_000) {
    lastWarned = Date.now();
    logger.warn(message);
  } else {
    logger.debug(message);
  }
}

function storeFile(): string {
  return process.env.IMDB_MATCH_FILE || path.join(process.cwd(), 'addon', 'data', 'imdbmatch.sqlite');
}

function openStore(): Store | null {
  if (store) return store;
  if (Date.now() < openFailedUntil) return null;
  const file = storeFile();
  let db: BetterSqlite3.Database | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new BetterSqlite3(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS imdb_match (
        k           TEXT PRIMARY KEY,
        imdb        TEXT,
        via         TEXT,
        reason      TEXT,
        checked_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        last_access INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imdb_match_imdb ON imdb_match(imdb);
    `);
    const keys = 'SELECT value FROM json_each(?)';
    store = {
      db,
      read: db.prepare(`SELECT * FROM imdb_match WHERE k IN (${keys})`),
      byImdb: db.prepare(`SELECT k FROM imdb_match WHERE imdb = ? AND via = 'match'`),
      touch: db.prepare(`UPDATE imdb_match SET last_access = ? WHERE k IN (${keys})`),
      upsert: db.prepare(`
        INSERT INTO imdb_match (k, imdb, via, reason, checked_at, expires_at, last_access)
        VALUES (@k, @imdb, @via, @reason, @checked_at, @expires_at, @last_access)
        ON CONFLICT(k) DO UPDATE SET imdb = excluded.imdb, via = excluded.via, reason = excluded.reason,
          checked_at = excluded.checked_at, expires_at = excluded.expires_at,
          last_access = MAX(imdb_match.last_access, excluded.last_access)
      `),
      // Matches stay: a watchlist keeps the IMDb id and opens the title by it however long it is not shown.
      purge: db.prepare(`DELETE FROM imdb_match WHERE via IS NOT 'match' AND last_access < ?`),
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already unusable
    }
    openFailedUntil = Date.now() + REOPEN_AFTER_MS;
    warn(`Could not open the IMDb match store, trying again in 10 minutes: ${(error as Error).message}`);
    return null;
  }
  const opened = store;
  const timer = setInterval(() => {
    try {
      opened.purge.run(Date.now() - FORGET_MISS_AFTER_MS);
    } catch (error) {
      logger.debug(`Could not drop old misses: ${(error as Error).message}`);
    }
  }, PURGE_EVERY_MS);
  timer.unref?.();
  logger.info(`IMDb match store ready at ${file}`);
  return store;
}

function readRows(s: Store, keys: string[], now: number): Map<string, Row> {
  const out = new Map<string, Row>();
  if (keys.length === 0) return out;
  const untouched: string[] = [];
  for (const row of s.read.all(JSON.stringify(keys)) as Row[]) {
    out.set(row.k, row);
    if (row.last_access < now - DAY) untouched.push(row.k);
  }
  if (untouched.length > 0) {
    try {
      s.touch.run(now, JSON.stringify(untouched));
    } catch (error) {
      warn(`Could not mark ${untouched.length} titles as shown: ${(error as Error).message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network: TMDB and IMDb straight, IMDb one request at a time and paused after a refusal
// ---------------------------------------------------------------------------

let lastSuggestAt = 0;
let suggestChain: Promise<void> = Promise.resolve();

function suggestTurn(): Promise<void> {
  const turn = suggestChain.then(async () => {
    const wait = lastSuggestAt + SUGGEST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastSuggestAt = Date.now();
  });
  suggestChain = turn;
  return turn;
}

/** Until when IMDb is not asked after it turned a request away (403, 429, 5xx, a 2xx without the list). */
let imdbPausedUntil = 0;

// Required lazily, as in kpData.ts.
function track(ms: number, ok: boolean): void {
  try {
    require('./requestTracker').trackProviderCall('tmdb', ms, ok);
  } catch {
    return;
  }
}

/**
 * TMDB straight, not through getTmdb.ts: its makeTmdbRequest fills a missing imdb_id of a
 * /movie/<id> or /tv/<id> answer with its own guess (nameToImdb by title and year, the
 * www.imdb.com scraper), which would pass for TMDB's own id here, and would run the scraper
 * on every check. Neither request goes through Redis: a match is checked once a month. The URL
 * carries the key, so it is never put in an error.
 */
async function tmdbGet(endpoint: string, params: Record<string, string>, key: string): Promise<any> {
  if (!key) throw new Error('no TMDB key');
  const url = `${TMDB_URL}${endpoint}?${new URLSearchParams({ ...params, api_key: key })}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    track(Date.now() - started, false);
    throw new Error((error as Error)?.name === 'TimeoutError' ? 'TMDB timed out' : 'TMDB network error');
  }
  track(Date.now() - started, res.ok);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // A title TMDB removed: no facts, so a miss.
    if (res.status === 404) return null;
    throw new Error(`TMDB status ${res.status}`);
  }
  return res.json();
}

function networkDeps(config: any): Deps {
  const { httpGet } = require('../utils/httpClient');
  // The key getTmdb.ts picks; it does not export its getApiKey.
  const key = () => String(config?.apiKeys?.tmdb || process.env.TMDB_API_KEY || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '');
  return {
    details: (kind, tmdbId) => tmdbGet(`/${kind}/${tmdbId}`, {
      language: 'en-US',
      append_to_response: kind === 'tv' ? 'aggregate_credits,external_ids' : 'credits,external_ids',
    }, key()),
    find: (imdbId) => tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' }, key()),
    suggest: async (query) => {
      await suggestTurn();
      try {
        const response = await httpGet(`${SUGGEST_URL}${encodeURIComponent(query)}.json?includeVideos=0`, { timeout: TIMEOUT_MS });
        if (response?.status !== 200) throw new Error(`IMDb suggestion status ${response?.status}`);
        return parseSuggestions(response.data);
      } catch (error) {
        imdbPausedUntil = Date.now() + IMDB_PAUSE_MS;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<void>>();
const failed = new LRUCache<string, number>({ max: 20_000 });
const waiting: Array<() => void> = [];
/** The start of each title still waiting, so that a meta can move a tile's title ahead. */
const starts = new Map<string, () => void>();
let running = 0;

function next(): void {
  while (running < CONCURRENCY && waiting.length > 0) {
    running++;
    waiting.shift()!();
  }
}

/** A title a meta waits for goes ahead of the tiles. */
function queue(title: { k: string; kind: Kind; id: string }, prev: Row | undefined, deps: Deps, first: boolean): Promise<void> | undefined {
  const busy = inflight.get(title.k);
  if (busy) {
    const start = first ? starts.get(title.k) : undefined;
    const at = start ? waiting.indexOf(start) : -1;
    if (at > 0) waiting.unshift(...waiting.splice(at, 1));
    return busy;
  }
  if ((failed.get(title.k) ?? 0) > Date.now() || waiting.length >= QUEUE_LIMIT) return undefined;
  const done = new Promise<void>((resolve) => {
    const start = () => {
      starts.delete(title.k);
      resolve();
    };
    starts.set(title.k, start);
    if (first) waiting.unshift(start);
    else waiting.push(start);
  })
    .then(() => check(title, prev, deps))
    .finally(() => {
      inflight.delete(title.k);
      running--;
      next();
    });
  inflight.set(title.k, done);
  next();
  return done;
}

async function check(title: { k: string; kind: Kind; id: string }, prev: Row | undefined, deps: Deps): Promise<void> {
  // While IMDb is paused, not even TMDB is asked: the check could not finish.
  if (Date.now() < imdbPausedUntil) {
    failed.set(title.k, imdbPausedUntil);
    return;
  }
  let outcome: Outcome;
  try {
    outcome = await matchTitle(title.kind, title.id, deps);
  } catch (error) {
    failed.set(title.k, Date.now() + RETRY_MS);
    warn(`Could not match ${title.k}: ${(error as Error).message}`);
    return;
  }
  try {
    const s = openStore();
    if (!s) throw new Error('store unavailable');
    const row = nextRow(title.k, prev, outcome, Date.now());
    s.upsert.run(row);
    if (row.via === 'match' && row.imdb !== prev?.imdb) logger.info(`${title.k} is ${row.imdb}`);
    else if (prev?.imdb && !row.imdb) logger.info(`${title.k} is no longer ${prev.imdb}: ${outcome.reason}`);
  } catch (error) {
    failed.set(title.k, Date.now() + RETRY_MS);
    warn(`Could not store the match of ${title.k}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function waitFor(pending: Promise<void>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * An IMDb id matched to more than one TMDB title of a kind (a TMDB duplicate, or a sequel) is
 * a doubt: none of them gets it, as the meta route opens none of them by it.
 */
function soleMatch(s: Store, k: string, row: Row | undefined): string | null {
  if (!row?.imdb) return null;
  if (row.via !== 'match') return row.imdb;
  const kind = k.split(':')[1];
  const same = (s.byImdb.all(row.imdb) as Array<{ k: string }>).filter((other) => other.k.split(':')[1] === kind);
  return same.length === 1 ? row.imdb : null;
}

async function enrich(metas: any[], deps: Deps, waitMs: number): Promise<any[]> {
  const titles = metas.map(titleOf);
  const keys = [...new Set(titles.filter((t) => t !== null).map((t) => t!.k))];
  if (keys.length === 0) return metas;
  const s = openStore();
  if (!s) return metas;
  const now = Date.now();
  let rows = readRows(s, keys, now);
  const pending: Promise<void>[] = [];
  const queued = new Set<string>();
  for (const title of titles) {
    if (!title || queued.has(title.k)) continue;
    queued.add(title.k);
    const row = rows.get(title.k);
    if (row && row.expires_at > now) continue;
    const done = queue(title, row, deps, waitMs > 0);
    if (done && !row) pending.push(done);
  }
  if (pending.length > 0 && waitMs > 0) {
    await waitFor(pending, waitMs);
    rows = readRows(s, keys, Date.now());
  }
  let out = metas;
  metas.forEach((meta, index) => {
    const title = titles[index];
    const imdb = title && soleMatch(s, title.k, rows.get(title.k));
    if (!imdb) return;
    if (out === metas) out = metas.slice();
    out[index] = { ...meta, imdb_id: imdb };
  });
  return out;
}

/**
 * Tiles or a meta with `imdb_id` for the TMDB titles that lack one and have been matched; the same
 * array when nothing is added. Titles not checked yet are queued; only a meta waits for them.
 */
function enabled(): boolean {
  return String(process.env.IMDB_MATCH ?? '').trim() !== '0';
}

export async function withImdbIds(metas: any[], config: any, isMeta: boolean, deps?: Deps): Promise<any[]> {
  if (!Array.isArray(metas) || metas.length === 0 || !enabled()) return metas;
  try {
    const waitMs = isMeta ? envInt('IMDB_MATCH_WAIT_MS', DEFAULT_WAIT_MS, 0) : 0;
    return await enrich(metas, deps ?? networkDeps(config), waitMs);
  } catch (error) {
    warn(`Titles left without a matched IMDb id: ${(error as Error).message}`);
    return metas;
  }
}

/**
 * The TMDB id (`tmdb:<id>`) a meta asked for by a matched IMDb id is built from; null for any other
 * id. Only our own matches: an IMDb id TMDB knows itself is resolved by the addon as before.
 */
export function tmdbIdForMatchedImdb(type: string, id: string): string | null {
  if (!enabled() || !IMDB_ID.test(String(id ?? '')) || (type !== 'movie' && type !== 'series')) return null;
  try {
    const s = openStore();
    if (!s) return null;
    const kind: Kind = type === 'series' ? 'tv' : 'movie';
    const rows = s.byImdb.all(id) as Array<{ k: string }>;
    const own = rows.map((row) => /^tmdb:(movie|tv):(\d+)$/.exec(row.k)).filter((m) => m && m[1] === kind);
    // Two TMDB titles matched to one IMDb id is a doubt: neither is used.
    return own.length === 1 ? `tmdb:${own[0]![2]}` : null;
  } catch (error) {
    warn(`Could not look up ${id}: ${(error as Error).message}`);
    return null;
  }
}

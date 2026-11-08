import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';

/**
 * Russian names and descriptions of anime from Shikimori on catalog and search tiles
 * and on metas, where TMDB has none.
 *
 * A title is anime when the Fribb mapping already loaded by id-mapper knows it (by TMDB
 * or IMDb id), or when its id is a `mal:` one; a MAL id is a Shikimori id. Only the title
 * level is used: Fribb's TMDB seasons are too rough to tie Shikimori entries to seasons,
 * so a show takes the entry of its first season and episodes are never touched. A name
 * or a description is replaced only when it has no Cyrillic in it, so a Russian text
 * from TMDB always stays.
 *
 * Added right before the response, after every cache, like Kino API. Answers are read in
 * batches through Shikimori's GraphQL API for every user at once and kept whole in their
 * own SQLite file; a response waits for new titles only briefly. Without SHIKIMORI_URL
 * nothing here runs and the file is never opened. Shikimori bans the IP of a client whose
 * User-Agent does not name its registered OAuth2 application, so without
 * SHIKIMORI_USER_AGENT the module stays off too, with one warning.
 */

const logger = consola.withTag('Shikimori');

const BATCH_SIZE = 50;
// One request a second at most, one at a time: well under Shikimori's 5 rps and 90 rpm.
const MIN_INTERVAL_MS = 1000;
const GATHER_MS = 100;
const TIMEOUT_MS = 10_000;
const QUEUE_LIMIT = 2000;
const RETRY_MS = 10 * 60_000;
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 30 * 60_000;
const DAY = 86_400_000;
const FORGET_AFTER_MS = 90 * DAY;
const PURGE_EVERY_MS = 3_600_000;
const REOPEN_AFTER_MS = 10 * 60_000;
const BUSY_TIMEOUT_MS = 50;
const DEFAULT_WAIT_MS = 600;
const MAX_NAME = 300;
const MAX_DESCRIPTION = 4000;
const QUERY = 'query ($ids: String!) { animes(ids: $ids, limit: 50) { id russian licenseNameRu status description } }';

/** Bump when the projection gains or changes a field: stored rows are re-projected from `raw`, without new requests. */
export const VIEW_VERSION = 1;
/** Finished titles with both texts are asked for again in a month; anything else in a week. */
export const SETTLED_TTL_MS = 30 * DAY;
export const OTHER_TTL_MS = 7 * DAY;

export interface AnimeView {
  name?: string;
  description?: string;
}

export interface StoredRow {
  mal_id: number;
  raw: string | null;
  view: string | null;
  view_v: number;
  found: number;
  fetched_at: number;
  expires_at: number;
  last_access: number;
}

/** The part of id-mapper used here. */
export interface AnimeMapper {
  getMappingByTmdbId(tmdbId: string, type: 'movie' | 'series'): any;
  getSeriesMappingsByTmdbId(tmdbId: string): any[];
  getMappingByImdbId(imdbId: string): any;
  mappingIsType(mapping: any, type: 'movie' | 'series'): boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const CYRILLIC = /[А-Яа-яЁё]/;
const NUMERIC_ID = /^\d+$/;
const TMDB_STREMIO_ID = /^tmdb:(\d+)$/;
const MAL_STREMIO_ID = /^mal:(\d+)$/;
const IMDB_ID = /^tt\d+$/;

export function hasCyrillic(value: unknown): boolean {
  return typeof value === 'string' && CYRILLIC.test(value);
}

function malId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function seasonNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : Infinity;
}

/** The entry of a show's first season: a TV entry before others, then the lowest TVDB, then TMDB season, then MAL id. */
export function firstSeasonMalId(entries: any[]): number | null {
  const ranked = entries
    .filter((entry) => malId(entry?.mal_id))
    .map((entry) => ({
      id: malId(entry.mal_id)!,
      key: [
        String(entry.type ?? '').toLowerCase() === 'tv' ? 0 : 1,
        seasonNumber(entry.season?.tvdb),
        seasonNumber(entry.season?.tmdb),
      ],
    }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.id - b.id);
  return ranked[0]?.id ?? null;
}

/**
 * The Shikimori (MAL) id of a tile or meta, or null when it is not anime. A movie entry that
 * Fribb collapsed from several parts is skipped: its MAL id names one part only.
 */
export function malIdOf(meta: any, mapper: AnimeMapper | null): number | null {
  if (!meta || typeof meta !== 'object' || (meta.type !== 'movie' && meta.type !== 'series')) return null;
  const own = MAL_STREMIO_ID.exec(String(meta.id ?? ''))?.[1];
  if (own) return malId(own);
  if (!mapper) return null;
  const ownTmdb = String(meta._tmdbId ?? '');
  const tmdbId = NUMERIC_ID.test(ownTmdb) ? ownTmdb : TMDB_STREMIO_ID.exec(String(meta.id ?? ''))?.[1];
  const imdbId = [meta.imdb_id, meta._imdbId, meta.id].map((value) => String(value ?? '')).find((value) => IMDB_ID.test(value));

  if (meta.type === 'series') {
    let entries = tmdbId ? mapper.getSeriesMappingsByTmdbId(tmdbId) ?? [] : [];
    if (entries.length === 0 && imdbId) {
      const entry = mapper.getMappingByImdbId(imdbId);
      if (entry && mapper.mappingIsType(entry, 'series')) {
        const siblings = entry.themoviedb_id ? mapper.getSeriesMappingsByTmdbId(String(entry.themoviedb_id)) ?? [] : [];
        entries = siblings.length > 0 ? siblings : [entry];
      }
    }
    return firstSeasonMalId(entries);
  }

  let entry = tmdbId ? mapper.getMappingByTmdbId(tmdbId, 'movie') : null;
  if (!entry && imdbId) entry = mapper.getMappingByImdbId(imdbId);
  if (!entry || entry.multi_part || !mapper.mappingIsType(entry, 'movie')) return null;
  return malId(entry.mal_id);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() + '…' : value;
}

// The innermost spoiler: no other spoiler tag inside it.
const INNER_SPOILER = /\[spoiler[a-z_]*(?:=[^\]]*)?\](?:(?!\[\/?spoiler)[\s\S])*?\[\/spoiler[a-z_]*\]/gi;
// Shikimori's own tags are lower case; a capitalised `[Mei]` is a name, handled below.
const TAG = /\[\/?[a-z][a-z0-9_]*(?:=[^\]\n]{0,500})?\]|\[\*\]/g;
// A link with its text inside the tag, `[character=43669 Кага]`, unless it wraps a text of its own.
const NAMED_LINK = /\[(anime|manga|ranobe|character|person)=\d+ ([^\]\n]+)\](?![^\[]*\[\/\1\])/g;
// Original names after the Russian ones: `[石神 千空]`, `[Mei Kusakabe]`, `(死神様)`, and a Latin
// `(Maka Albarn)` right after a capitalised Russian word. Never `(2024)`, `(TV)` or `("Title")`.
const FOREIGN_BRACKETS = /[^\S\n]*\[[^\[\]\nА-Яа-яЁё]*\]/g;
const CJK_PARENS = /[^\S\n]*[(（][^()（）\nА-Яа-яЁё]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][^()（）\nА-Яа-яЁё]*[)）]/gu;
const ROMAJI_PARENS = /(?<=(?:^|[^А-Яа-яЁё])[А-ЯЁ][а-яё]+)[^\S\n]*\([A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\)/g;
// Marks a dropped insertion until spacing is settled: nothing before punctuation, one space otherwise.
const GAP = '\u0001';
const GAP_BEFORE_PUNCTUATION = /\u0001+(?=[^\S\n]*(?:[,.;:!?)»…]|\n|$))/g;
// Longer than any real description: the patterns below backtrack, so a hostile input stays short.
const MAX_INPUT = 3 * MAX_DESCRIPTION;

/**
 * Plain text of a Shikimori description: spoilers (nested too) and the source note dropped,
 * BBCode tags and `[[wiki links]]` unwrapped to their text, original names in brackets after
 * the Russian ones dropped, HTML tags removed, `[br]` and `<br>` kept as line breaks.
 */
export function plainDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Runs of blanks collapsed first: patterns that start with blanks would rescan a long run at every blank.
  let text = value
    .slice(0, MAX_INPUT)
    .replaceAll(GAP, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(INNER_SPOILER, ' ');
  }
  text = text
    // A spoiler left open hides everything after it.
    .replace(/\[spoiler[a-z_]*(?:=[^\]]*)?\][\s\S]*$/i, ' ')
    .replace(/\[source\][\s\S]*?\[\/source\]/gi, ' ')
    .replace(/\[\[([^\]]{0,300})\]\]/g, '$1')
    .replace(/\[br\s*\/?\]|<br\s*\/?>/gi, '\n')
    .replace(NAMED_LINK, '$2')
    .replace(TAG, '')
    .replace(/<[^>]{0,500}>/g, '')
    .replace(FOREIGN_BRACKETS, GAP)
    .replace(CJK_PARENS, GAP)
    .replace(ROMAJI_PARENS, GAP);
  text = decodeEntities(text)
    .replace(GAP_BEFORE_PUNCTUATION, '')
    .replaceAll(GAP, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // What a dropped spoiler or name leaves behind: `Мэй , .` becomes `Мэй.`
    .replace(/ +(?=[,.;:!?)»])/g, '')
    .replace(/,+(?=[.!?;:])/g, '')
    .trim();
  return cut(text, MAX_DESCRIPTION);
}

/** The Russian texts of one Shikimori anime, each only when it is Russian (has Cyrillic). */
export function projectView(raw: any): AnimeView {
  const view: AnimeView = {};
  if (!raw || typeof raw !== 'object') return view;
  const name = typeof raw.russian === 'string' ? raw.russian.replace(/\s+/g, ' ').trim() : '';
  if (hasCyrillic(name)) view.name = cut(name, MAX_NAME);
  const description = plainDescription(raw.description);
  if (hasCyrillic(description)) view.description = description;
  return view;
}

/** Freshness of a stored answer: a released title with both texts keeps for a month, anything else for a week. */
export function ttlFor(raw: any, view: AnimeView | null): number {
  if (!raw || !view?.name || !view.description) return OTHER_TTL_MS;
  return raw.status === 'released' ? SETTLED_TTL_MS : OTHER_TTL_MS;
}

/** The row to store after Shikimori answered (or did not) for one id. A title not found keeps its last good data. */
export function mergeRow(id: number, prev: StoredRow | undefined, raw: unknown, now: number): StoredRow {
  if (raw && typeof raw === 'object') {
    const view = projectView(raw);
    return {
      mal_id: id,
      raw: JSON.stringify(raw),
      view: JSON.stringify(view),
      view_v: VIEW_VERSION,
      found: 1,
      fetched_at: now,
      expires_at: now + ttlFor(raw, view),
      last_access: now,
    };
  }
  if (prev?.found) return { ...prev, expires_at: now + OTHER_TTL_MS, last_access: now };
  return { mal_id: id, raw: null, view: null, view_v: VIEW_VERSION, found: 0, fetched_at: now, expires_at: now + OTHER_TTL_MS, last_access: now };
}

/** A copy of the tile with the Russian texts where its own have no Cyrillic; the tile itself is never changed. */
export function applyView(meta: any, view: AnimeView | null | undefined): any {
  if (!view || !meta || typeof meta !== 'object') return meta;
  let next = meta;
  if (view.name && !hasCyrillic(meta.name)) next = { ...next, name: view.name };
  if (view.description && !hasCyrillic(meta.description)) next = { ...next, description: view.description };
  return next;
}

/** Base address from SHIKIMORI_URL, or null when the module is off (empty, `0` or not an http(s) address). */
export function baseUrlOf(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+$/i.test(text) ? text : null;
}

export interface Client {
  base: string;
  userAgent: string;
}

/** Where and as whom to ask, or null when the module is off: no address, or no usable User-Agent. */
export function clientOf(url: unknown, userAgent: unknown): Client | null {
  const base = baseUrlOf(url);
  const agent = String(userAgent ?? '').trim();
  return base && /^[\x20-\x7e]+$/.test(agent) ? { base, userAgent: agent } : null;
}

export function retryAfterMs(header: string | null, now: number = Date.now()): number {
  const value = String(header ?? '').trim();
  if (!value) return DEFAULT_PAUSE_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds * 1000, MAX_PAUSE_MS) : DEFAULT_PAUSE_MS;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - now, 0), MAX_PAUSE_MS) : DEFAULT_PAUSE_MS;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Store {
  db: BetterSqlite3.Database;
  read: BetterSqlite3.Statement;
  readFull: BetterSqlite3.Statement;
  reproject: BetterSqlite3.Statement;
  touch: BetterSqlite3.Statement;
  upsert: BetterSqlite3.Statement;
  purge: BetterSqlite3.Statement;
}

let store: Store | null = null;
let openFailedUntil = 0;
let lastStoreError = 0;

function storeError(message: string): void {
  if (Date.now() - lastStoreError > 60_000) {
    lastStoreError = Date.now();
    logger.error(message);
  } else {
    logger.debug(message);
  }
}

/** The store, or null while it cannot be opened: a failed open is retried only after REOPEN_AFTER_MS. */
function openStore(): Store | null {
  if (store) return store;
  if (Date.now() < openFailedUntil) return null;
  const file = path.join(process.cwd(), 'addon', 'data', 'shikimori.sqlite');
  let db: BetterSqlite3.Database | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new BetterSqlite3(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // The driver is synchronous and this data is optional: give up quickly rather than stall the process.
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS shiki_animes (
        mal_id      INTEGER PRIMARY KEY,
        raw         TEXT,
        view        TEXT,
        view_v      INTEGER NOT NULL,
        found       INTEGER NOT NULL,
        fetched_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        last_access INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shiki_last_access ON shiki_animes(last_access);
    `);
    const ids = 'SELECT value FROM json_each(?)';
    store = {
      db,
      read: db.prepare(`SELECT mal_id, raw, view, view_v, found, expires_at, last_access FROM shiki_animes WHERE mal_id IN (${ids})`),
      readFull: db.prepare(`SELECT * FROM shiki_animes WHERE mal_id IN (${ids})`),
      reproject: db.prepare('UPDATE shiki_animes SET view = ?, view_v = ? WHERE mal_id = ?'),
      touch: db.prepare(`UPDATE shiki_animes SET last_access = ? WHERE mal_id IN (${ids})`),
      upsert: db.prepare(`
        INSERT INTO shiki_animes (mal_id, raw, view, view_v, found, fetched_at, expires_at, last_access)
        VALUES (@mal_id, @raw, @view, @view_v, @found, @fetched_at, @expires_at, @last_access)
        ON CONFLICT(mal_id) DO UPDATE SET raw = excluded.raw, view = excluded.view, view_v = excluded.view_v,
          found = excluded.found, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
          last_access = MAX(shiki_animes.last_access, excluded.last_access)
      `),
      purge: db.prepare('DELETE FROM shiki_animes WHERE last_access < ?'),
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already unusable
    }
    openFailedUntil = Date.now() + REOPEN_AFTER_MS;
    storeError(`Could not open the Shikimori store, trying again in 10 minutes: ${(error as Error).message}`);
    return null;
  }
  const opened = store;
  const timer = setInterval(() => {
    try {
      const dropped = opened.purge.run(Date.now() - FORGET_AFTER_MS).changes;
      if (dropped > 0) logger.debug(`Dropped ${dropped} anime not shown for 90 days`);
    } catch (error) {
      logger.debug(`Could not drop old anime: ${(error as Error).message}`);
    }
  }, PURGE_EVERY_MS);
  timer.unref?.();
  logger.info(`Shikimori store ready at ${file}`);
  return store;
}

interface ReadView {
  view: AnimeView | null;
  expiresAt: number;
}

function parseView(json: string | null): AnimeView | null {
  if (!json) return null;
  try {
    const view = JSON.parse(json);
    return view && typeof view === 'object' ? view : null;
  } catch {
    return null;
  }
}

function readViews(s: Store, ids: number[], now: number): Map<number, ReadView> {
  const out = new Map<number, ReadView>();
  if (ids.length === 0) return out;
  const rows = s.read.all(JSON.stringify(ids)) as Array<Pick<StoredRow, 'mal_id' | 'raw' | 'view' | 'view_v' | 'found' | 'expires_at' | 'last_access'>>;
  const rebuilt: Array<[number, AnimeView]> = [];
  const untouched: number[] = [];
  for (const row of rows) {
    let view = row.found ? parseView(row.view) : null;
    if (row.found && row.view_v < VIEW_VERSION) {
      try {
        view = projectView(JSON.parse(row.raw ?? 'null'));
        rebuilt.push([row.mal_id, view]);
      } catch {
        // keep the old projection
      }
    }
    out.set(row.mal_id, { view, expiresAt: row.expires_at });
    if (row.last_access < now - DAY) untouched.push(row.mal_id);
  }
  // Rebuilding projections and marking access are upkeep: failing them must not cost the tiles their texts.
  if (rebuilt.length > 0) {
    try {
      s.db.transaction(() => {
        for (const [id, view] of rebuilt) s.reproject.run(JSON.stringify(view), VIEW_VERSION, id);
      })();
    } catch (error) {
      storeError(`Could not rebuild ${rebuilt.length} stored anime: ${(error as Error).message}`);
    }
  }
  if (untouched.length > 0) {
    try {
      s.touch.run(now, JSON.stringify(untouched));
    } catch (error) {
      storeError(`Could not mark ${untouched.length} anime as shown: ${(error as Error).message}`);
    }
  }
  return out;
}

function storeAnswers(s: Store, ids: number[], found: Map<number, any>, now: number): void {
  const missing = ids.filter((id) => !found.has(id));
  const prev = new Map<number, StoredRow>();
  if (missing.length > 0) {
    for (const row of s.readFull.all(JSON.stringify(missing)) as StoredRow[]) prev.set(row.mal_id, row);
  }
  s.db.transaction(() => {
    for (const id of ids) s.upsert.run(mergeRow(id, prev.get(id), found.get(id), now));
  })();
}

// ---------------------------------------------------------------------------
// Client and queue
// ---------------------------------------------------------------------------

class Paused extends Error {
  constructor(readonly ms: number, message = 'rate limited') {
    super(message);
  }
}

let warnedNoAgent = false;

// Read on every call, like the other Melange settings: they live outside the settings registry.
function client(): Client | null {
  const url = process.env.SHIKIMORI_URL;
  const found = clientOf(url, process.env.SHIKIMORI_USER_AGENT);
  if (!found && baseUrlOf(url) && !warnedNoAgent) {
    warnedNoAgent = true;
    logger.warn('SHIKIMORI_URL is set, but SHIKIMORI_USER_AGENT is empty or not plain ASCII: Shikimori stays off. Set it to the name of the OAuth2 application registered on Shikimori.');
  }
  return found;
}

// Required lazily: the tests put stand-ins for these in the require cache.
function mapper(): AnimeMapper | null {
  try {
    const idMapper = require('./id-mapper');
    return idMapper.isInitialized?.() ? idMapper : null;
  } catch {
    return null;
  }
}

function track(ms: number, ok: boolean): void {
  try {
    require('./requestTracker').trackProviderCall('shikimori', ms, ok);
  } catch {
    return;
  }
}

let lastWarned = 0;

function warn(message: string): void {
  if (Date.now() - lastWarned > 60_000) {
    lastWarned = Date.now();
    logger.warn(message);
  } else {
    logger.debug(message);
  }
}

let lastRequestAt = 0;
let pausedUntil = 0;

async function throttle(): Promise<void> {
  // A 429 may arrive while this one sleeps, so the pause is checked again after each sleep.
  const due = () => Math.max(lastRequestAt + MIN_INTERVAL_MS, pausedUntil) - Date.now();
  // Unref'd: a long pause must not keep the process alive on its own.
  for (let wait = due(); wait > 0; wait = due()) await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
  lastRequestAt = Date.now();
}

async function fetchAnimes(ids: number[], { base, userAgent }: Client): Promise<Map<number, any>> {
  await throttle();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({ query: QUERY, variables: { ids: ids.join(',') } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    track(Date.now() - started, false);
    throw new Error((error as Error)?.name === 'TimeoutError' ? 'timed out' : 'network error');
  }
  track(Date.now() - started, res.ok);
  if (res.status === 429) throw new Paused(retryAfterMs(res.headers.get('Retry-After')));
  // A 403 is how Shikimori turns a client away (a ban, a missing User-Agent): back off as long as we ever do.
  if (res.status === 403) throw new Paused(MAX_PAUSE_MS, 'forbidden');
  if (!res.ok) throw new Error(`status ${res.status}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error('unreadable answer');
  }
  const animes = body?.data?.animes;
  if (!Array.isArray(animes)) throw new Error(Array.isArray(body?.errors) ? 'query refused' : 'unexpected answer');
  const out = new Map<number, any>();
  for (const anime of animes) {
    const id = malId(anime?.id);
    if (id && ids.includes(id)) out.set(id, anime);
  }
  return out;
}

const pending = new Map<number, { done: Promise<void>; resolve: () => void }>();
const inflight = new Map<number, Promise<void>>();
const failed = new LRUCache<number, number>({ max: 20000 });
let running = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queue(id: number): Promise<void> | undefined {
  const busy = inflight.get(id) ?? pending.get(id)?.done;
  if (busy) return busy;
  if ((failed.get(id) ?? 0) > Date.now() || pending.size >= QUEUE_LIMIT) return undefined;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  pending.set(id, { done, resolve });
  scheduleFlush();
  return done;
}

function scheduleFlush(): void {
  if (flushTimer || running) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void drain();
  }, GATHER_MS);
  flushTimer.unref?.();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.size > 0) {
      const batch: Array<[number, () => void]> = [];
      for (const [id, item] of pending) {
        pending.delete(id);
        inflight.set(id, item.done);
        batch.push([id, item.resolve]);
        if (batch.length >= BATCH_SIZE) break;
      }
      try {
        await runBatch(batch.map(([id]) => id));
      } finally {
        for (const [id, resolve] of batch) {
          inflight.delete(id);
          resolve();
        }
      }
    }
  } finally {
    running = false;
  }
}

async function runBatch(ids: number[]): Promise<void> {
  const asker = client();
  if (!asker) return;
  let found: Map<number, any>;
  try {
    found = await fetchAnimes(ids, asker);
  } catch (error) {
    if (error instanceof Paused) pausedUntil = Math.max(pausedUntil, Date.now() + error.ms);
    const retryAt = Date.now() + RETRY_MS;
    for (const id of ids) failed.set(id, retryAt);
    warn(`Could not read ${ids.length} anime: ${(error as Error).message}`);
    return;
  }
  try {
    const s = openStore();
    if (!s) throw new Error('store unavailable');
    storeAnswers(s, ids, found, Date.now());
    logger.debug(`Stored ${ids.length} anime, ${found.size} found`);
  } catch (error) {
    // Not asked for again right away: otherwise every page would send them to Shikimori anew.
    const retryAt = Date.now() + RETRY_MS;
    for (const id of ids) failed.set(id, retryAt);
    storeError(`Could not store ${ids.length} anime: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function waitFor(waiting: Promise<void>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(waiting),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

type AddRussian = (tiles: any[]) => any[];

const unchanged: AddRussian = (tiles) => tiles;

/** A tile that could take a Russian text from Shikimori: one of its texts has no Cyrillic. */
function wantsRussian(meta: any): boolean {
  return !!meta && typeof meta === 'object' && (!hasCyrillic(meta.name) || !hasCyrillic(meta.description));
}

async function lookUp(metas: any[]): Promise<AddRussian> {
  const m = mapper();
  const wanted = [...new Set(metas.filter(wantsRussian).map((meta) => malIdOf(meta, m)).filter((id): id is number => id !== null))];
  if (wanted.length === 0) return unchanged;
  const s = openStore();
  if (!s) return unchanged;

  const now = Date.now();
  const views = readViews(s, wanted, now);
  const waiting: Promise<void>[] = [];
  const missing: number[] = [];
  for (const id of wanted) {
    const row = views.get(id);
    if (row) {
      if (row.expiresAt <= now) queue(id);
      continue;
    }
    const done = queue(id);
    if (done) {
      waiting.push(done);
      missing.push(id);
    }
  }
  const waitMs = envInt('SHIKIMORI_CATALOG_WAIT_MS', DEFAULT_WAIT_MS, 0);
  if (waiting.length > 0 && waitMs > 0) {
    await waitFor(waiting, waitMs);
    for (const [id, row] of readViews(s, missing, Date.now())) views.set(id, row);
  }

  return (tiles) => {
    let out = tiles;
    tiles.forEach((meta, index) => {
      // By the tile's own ids, not its place: another lookup may have rebuilt the list.
      const id = wantsRussian(meta) ? malIdOf(meta, m) : null;
      const next = id !== null ? applyView(meta, views.get(id)?.view) : meta;
      if (next === meta) return;
      if (out === tiles) out = tiles.slice();
      out[index] = next;
    });
    return out;
  };
}

/**
 * Looks the anime among the tiles up on Shikimori, waiting briefly for new ones, and gives back
 * what puts the Russian texts on these tiles or on copies of them: so other lookups that wait
 * too can run on the same tiles at the same time.
 */
export async function lookUpShikimori(metas: any[]): Promise<AddRussian> {
  if (!Array.isArray(metas) || metas.length === 0 || !client()) return unchanged;
  try {
    return await lookUp(metas);
  } catch (error) {
    storeError(`Anime left without Russian texts: ${(error as Error).message}`);
    return unchanged;
  }
}

/** Tiles or metas with Russian anime texts where they have none; the same array when there is nothing to change. */
export async function withShikimori(metas: any[]): Promise<any[]> {
  return (await lookUpShikimori(metas))(metas);
}

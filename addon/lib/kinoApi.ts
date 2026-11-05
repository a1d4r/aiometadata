import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { getSettleSeconds } from './metaColdStore/config';
import { envInt } from '../utils/envNumber';

/**
 * Kinopoisk data from Kino API (kinoapi.lampac.dev) on catalog and search tiles.
 *
 * Added after the catalog caches, right before the response, so its own freshness
 * does not depend on how long a row or a search stays in Redis. Raw answers are kept
 * whole in their own SQLite file; tiles read a small projection of them. Titles not
 * stored yet are fetched in batches for every user at once, and a response waits for
 * them only briefly; anything stale is served as is and refreshed in the background.
 * Without KINOAPI_API_KEY nothing here runs and the file is never opened.
 */

const logger = consola.withTag('Kino API');

const API_URL = 'https://kinoapi.lampac.dev/api/v1/titles/batch';
const BATCH_SIZE = 50;
const CONCURRENCY = 2;
const MIN_INTERVAL_MS = 200;
const GATHER_MS = 100;
const TIMEOUT_MS = 10_000;
const QUEUE_LIMIT = 5000;
const RETRY_MS = 120_000;
const DEFAULT_PAUSE_MS = 30_000;
const DAY = 86_400_000;
const RECENT_MOVIE_MS = 30 * DAY;
const FORGET_AFTER_MS = 90 * DAY;
const PURGE_EVERY_MS = 3_600_000;
const REOPEN_AFTER_MS = 10 * 60_000;
const BUSY_TIMEOUT_MS = 50;
const DEFAULT_WAIT_MS = 600;

const MAX_SHORT_DESCRIPTION = 300;
const MAX_VOICEOVERS = 30;
const MAX_VOICEOVER = 60;

/** Bump when the projection gains or changes a field: stored rows are re-projected from `raw`, without new requests. */
export const VIEW_VERSION = 1;

export type Tier = 'day' | 'week' | 'month';
export const TIER_TTL_MS: Record<Tier, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY };

export interface KinoSource {
  k: string;
  source: 'tmdb' | 'imdb';
  id: string;
  type: 'movie' | 'tv';
}

export interface KinoRef extends KinoSource {
  tier: Tier;
}

export interface KinoView {
  kpRating?: string;
  kpVotes?: number;
  kpId?: string;
  shortDescription?: string;
  voiceovers?: string[];
  age?: string;
}

export interface StoredRow {
  k: string;
  raw: string | null;
  view: string | null;
  view_v: number;
  found: number;
  fetched_at: number;
  expires_at: number;
  last_access: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const NUMERIC_ID = /^\d+$/;
const TMDB_STREMIO_ID = /^tmdb:(\d+)$/;
const IMDB_ID = /^tt\d+$/;
const AGE = /^[0-9]{1,2}\+$/;
const ONGOING_STATUSES = new Set(['returning series', 'in production', 'planned', 'pilot', 'currently airing', 'not yet aired']);

/** What to ask Kino API for: the TMDB id with the tile's kind, else its IMDb id, else nothing. */
export function sourceOf(meta: any): KinoSource | null {
  if (!meta || typeof meta !== 'object' || (meta.type !== 'movie' && meta.type !== 'series')) return null;
  const type = meta.type === 'series' ? 'tv' : 'movie';
  const ownId = String(meta._tmdbId ?? '');
  const tmdbId = NUMERIC_ID.test(ownId) ? ownId : TMDB_STREMIO_ID.exec(String(meta.id ?? ''))?.[1];
  if (tmdbId) return { k: `tmdb:${type}:${tmdbId}`, source: 'tmdb', id: tmdbId, type };
  const imdbId = [meta.imdb_id, meta._imdbId, meta.id].map((value) => String(value ?? '')).find((value) => IMDB_ID.test(value));
  return imdbId ? { k: `imdb:${imdbId}`, source: 'imdb', id: imdbId, type } : null;
}

/** Catalog tiles carry `released` as a Date; cached or searched ones may carry a string or a number. */
function releasedMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(typeof value === 'string' ? value : '');
}

/** Past the cold store's settle window (180 days for movies, 90 for series by default). */
function settled(kind: 'movie' | 'series', endMs: number, now: number): boolean {
  return now - endMs >= getSettleSeconds(kind) * 1000;
}

/**
 * How soon a title is asked for again, judged from the tile alone: tiles carry no
 * `_stability` and movies carry no status, so the cold store's own classifier cannot
 * be used on them; only its settle windows are.
 */
export function freshnessTier(meta: any, now: number = Date.now()): Tier {
  if (meta?.type === 'movie') {
    const released = releasedMs(meta.released);
    if (!Number.isFinite(released) || now - released < RECENT_MOVIE_MS) return 'day';
    return settled('movie', released, now) ? 'month' : 'week';
  }
  const info = String(meta?.releaseInfo ?? '').trim();
  if (/[-–]$/.test(info) || ONGOING_STATUSES.has(String(meta?.status ?? '').trim().toLowerCase())) return 'day';
  const endYear = /(\d{4})$/.exec(info)?.[1];
  if (!endYear) return 'day';
  return settled('series', Date.parse(`${endYear}-12-31`), now) ? 'month' : 'week';
}

function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : value;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function voiceoverName(value: unknown): string {
  if (typeof value === 'string') return text(value);
  if (value && typeof value === 'object') return text((value as any).name ?? (value as any).title);
  return '';
}

/** The few fields tiles need, taken defensively from one raw Kino API title. */
export function projectView(raw: any): KinoView {
  const view: KinoView = {};
  if (!raw || typeof raw !== 'object') return view;

  const rating = Number(raw.ratings?.kinopoisk?.value);
  if (Number.isFinite(rating) && rating > 0 && rating <= 10) {
    view.kpRating = (Math.round(rating * 10) / 10).toFixed(1);
    const votes = Number(raw.ratings?.kinopoisk?.votes);
    if (Number.isFinite(votes) && votes >= 0) view.kpVotes = Math.round(votes);
  }

  const kpId = String(raw.id?.kinopoisk ?? '');
  if (NUMERIC_ID.test(kpId)) view.kpId = kpId;

  const short = text(raw.description?.short);
  if (short) view.shortDescription = cut(short, MAX_SHORT_DESCRIPTION);

  if (Array.isArray(raw.voiceovers)) {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of raw.voiceovers) {
      const name = cut(voiceoverName(item), MAX_VOICEOVER);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
      if (names.length >= MAX_VOICEOVERS) break;
    }
    if (names.length > 0) view.voiceovers = names;
  }

  const age = text(raw.release?.ageRating);
  if (AGE.test(age)) view.age = age;
  return view;
}

/** Freshness of a stored answer: titles not found, or with neither a rating nor voiceovers, are asked again in a day. */
export function ttlFor(tier: Tier, view: KinoView | null): number {
  if (!view || (!view.kpRating && !view.voiceovers?.length)) return DAY;
  return TIER_TTL_MS[tier];
}

/** An answer worth storing: a non-empty object. `null`, `{}`, arrays and strings count as not found. */
export function isTitle(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0;
}

/**
 * The row to store after Kino API answered for one title. A title not found that had
 * data keeps the last good data and is asked again in a day.
 */
export function mergeRow(k: string, prev: StoredRow | undefined, raw: unknown, tier: Tier, now: number): StoredRow {
  if (isTitle(raw)) {
    const view = projectView(raw);
    return {
      k,
      raw: JSON.stringify(raw),
      view: JSON.stringify(view),
      view_v: VIEW_VERSION,
      found: 1,
      fetched_at: now,
      expires_at: now + ttlFor(tier, view),
      last_access: now,
    };
  }
  if (prev?.found) return { ...prev, expires_at: now + DAY, last_access: now };
  return { k, raw: null, view: null, view_v: VIEW_VERSION, found: 0, fetched_at: now, expires_at: now + DAY, last_access: now };
}

/** A copy of the tile with the Kinopoisk fields; the tile itself is never changed, since cached tiles may be shared. */
export function applyView(meta: any, view: KinoView | null | undefined): any {
  if (!view || !meta || typeof meta !== 'object') return meta;
  const { age, ...fields } = view;
  let next = Object.keys(fields).length > 0 ? { ...meta, ...fields } : meta;
  if (age) {
    const extras = meta.app_extras && typeof meta.app_extras === 'object' ? meta.app_extras : {};
    const certifications = extras.certifications && typeof extras.certifications === 'object' ? extras.certifications : {};
    if (!certifications.RU) {
      next = { ...next, app_extras: { ...extras, certifications: { ...certifications, RU: age } } };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Store {
  db: BetterSqlite3.Database;
  read: BetterSqlite3.Statement;
  readRaw: BetterSqlite3.Statement;
  readFull: BetterSqlite3.Statement;
  reproject: BetterSqlite3.Statement;
  touch: BetterSqlite3.Statement;
  upsert: BetterSqlite3.Statement;
  purge: BetterSqlite3.Statement;
}

let store: Store | null = null;
let openFailedUntil = 0;
let lastStoreError = 0;

/** Storage trouble is logged apart from network trouble, at most once a minute. */
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
  const file = path.join(process.cwd(), 'addon', 'data', 'kinoapi.sqlite');
  let db: BetterSqlite3.Database | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new BetterSqlite3(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // The driver is synchronous and this data is optional: give up quickly rather than stall the process.
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS kino_titles (
        k           TEXT PRIMARY KEY,
        raw         TEXT,
        view        TEXT,
        view_v      INTEGER NOT NULL,
        found       INTEGER NOT NULL,
        fetched_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        last_access INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kino_last_access ON kino_titles(last_access);
    `);
    const keys = 'SELECT value FROM json_each(?)';
    store = {
      db,
      read: db.prepare(`SELECT k, view, view_v, found, expires_at, last_access FROM kino_titles WHERE k IN (${keys})`),
      readRaw: db.prepare(`SELECT k, raw FROM kino_titles WHERE found = 1 AND k IN (${keys})`),
      readFull: db.prepare(`SELECT * FROM kino_titles WHERE k IN (${keys})`),
      reproject: db.prepare('UPDATE kino_titles SET view = ?, view_v = ? WHERE k = ?'),
      touch: db.prepare(`UPDATE kino_titles SET last_access = ? WHERE k IN (${keys})`),
      upsert: db.prepare(`
        INSERT INTO kino_titles (k, raw, view, view_v, found, fetched_at, expires_at, last_access)
        VALUES (@k, @raw, @view, @view_v, @found, @fetched_at, @expires_at, @last_access)
        ON CONFLICT(k) DO UPDATE SET raw = excluded.raw, view = excluded.view, view_v = excluded.view_v,
          found = excluded.found, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
          last_access = MAX(kino_titles.last_access, excluded.last_access)
      `),
      purge: db.prepare('DELETE FROM kino_titles WHERE last_access < ?'),
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already unusable
    }
    openFailedUntil = Date.now() + REOPEN_AFTER_MS;
    storeError(`Could not open the Kino API store, trying again in 10 minutes: ${(error as Error).message}`);
    return null;
  }
  const opened = store;
  const timer = setInterval(() => {
    try {
      const dropped = opened.purge.run(Date.now() - FORGET_AFTER_MS).changes;
      if (dropped > 0) logger.debug(`Dropped ${dropped} titles not shown for 90 days`);
    } catch (error) {
      logger.debug(`Could not drop old titles: ${(error as Error).message}`);
    }
  }, PURGE_EVERY_MS);
  timer.unref?.();
  logger.info(`Kino API store ready at ${file}`);
  return store;
}

interface ReadView {
  view: KinoView | null;
  expiresAt: number;
}

function parseView(json: string | null): KinoView | null {
  if (!json) return null;
  try {
    const view = JSON.parse(json);
    return view && typeof view === 'object' ? view : null;
  } catch {
    return null;
  }
}

function readViews(s: Store, keys: string[], now: number): Map<string, ReadView> {
  const out = new Map<string, ReadView>();
  if (keys.length === 0) return out;
  const rows = s.read.all(JSON.stringify(keys)) as Array<Pick<StoredRow, 'k' | 'view' | 'view_v' | 'found' | 'expires_at' | 'last_access'>>;
  const outdated: string[] = [];
  const untouched: string[] = [];
  for (const row of rows) {
    out.set(row.k, { view: row.found ? parseView(row.view) : null, expiresAt: row.expires_at });
    if (row.found && row.view_v < VIEW_VERSION) outdated.push(row.k);
    if (row.last_access < now - DAY) untouched.push(row.k);
  }
  // Rebuilding projections and marking access are upkeep: failing them must not cost the tiles their data.
  if (outdated.length > 0) {
    try {
      const raws = s.readRaw.all(JSON.stringify(outdated)) as Array<{ k: string; raw: string | null }>;
      const rebuilt: Array<[string, KinoView]> = [];
      for (const { k, raw } of raws) {
        try {
          rebuilt.push([k, projectView(JSON.parse(raw ?? 'null'))]);
        } catch {
          continue;
        }
      }
      for (const [k, view] of rebuilt) out.set(k, { view, expiresAt: out.get(k)!.expiresAt });
      s.db.transaction(() => {
        for (const [k, view] of rebuilt) s.reproject.run(JSON.stringify(view), VIEW_VERSION, k);
      })();
    } catch (error) {
      storeError(`Could not rebuild ${outdated.length} stored titles: ${(error as Error).message}`);
    }
  }
  if (untouched.length > 0) {
    try {
      s.touch.run(now, JSON.stringify(untouched));
    } catch (error) {
      storeError(`Could not mark ${untouched.length} titles as shown: ${(error as Error).message}`);
    }
  }
  return out;
}

function storeAnswers(s: Store, refs: KinoRef[], data: unknown[], now: number): void {
  const nulls = refs.filter((_, index) => !isTitle(data[index])).map((ref) => ref.k);
  const prev = new Map<string, StoredRow>();
  if (nulls.length > 0) {
    for (const row of s.readFull.all(JSON.stringify(nulls)) as StoredRow[]) prev.set(row.k, row);
  }
  s.db.transaction(() => {
    refs.forEach((ref, index) => s.upsert.run(mergeRow(ref.k, prev.get(ref.k), data[index], ref.tier, now)));
  })();
}

// ---------------------------------------------------------------------------
// Client and queue (a trimmed copy of the one in criticRatings.ts)
// ---------------------------------------------------------------------------

class Paused extends Error {
  constructor(readonly ms: number) {
    super('rate limited');
  }
}

export function retryAfterMs(header: string | null, now: number = Date.now()): number {
  const value = String(header ?? '').trim();
  if (!value) return DEFAULT_PAUSE_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds * 1000, 10 * 60_000) : DEFAULT_PAUSE_MS;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - now, 0), 10 * 60_000) : DEFAULT_PAUSE_MS;
}

// Required lazily, like the tracker below: the tests put stand-ins for both in the require cache.
function apiKey(): string {
  const { getSetting } = require('./settingsService');
  return String(getSetting('KINOAPI_API_KEY') || '').trim();
}

function track(ms: number, ok: boolean): void {
  try {
    require('./requestTracker').trackProviderCall('kinoapi', ms, ok);
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
let throttleChain: Promise<void> = Promise.resolve();
let pausedUntil = 0;

/** Requests start at least MIN_INTERVAL_MS apart, and not while Kino API asked to pause. */
function throttle(): Promise<void> {
  const turn = throttleChain.then(async () => {
    // A 429 may arrive while this one sleeps, so the pause is checked again after each sleep.
    const due = () => Math.max(lastRequestAt + MIN_INTERVAL_MS, pausedUntil) - Date.now();
    for (let wait = due(); wait > 0; wait = due()) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  throttleChain = turn;
  return turn;
}

async function fetchTitles(refs: KinoRef[], key: string): Promise<unknown[]> {
  await throttle();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: refs.map(({ source, id, type }) => ({ source, id, type })) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    track(Date.now() - started, false);
    throw new Error((error as Error)?.name === 'TimeoutError' ? 'timed out' : 'network error');
  }
  track(Date.now() - started, res.ok);
  if (res.status === 429) throw new Paused(retryAfterMs(res.headers.get('Retry-After')));
  if (!res.ok) throw new Error(`status ${res.status}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error('unreadable answer');
  }
  if (!Array.isArray(body?.data) || body.data.length !== refs.length) throw new Error('unexpected answer');
  return body.data;
}

interface Pending {
  ref: KinoRef;
  done: Promise<void>;
  resolve: () => void;
}

const pending = new Map<string, Pending>();
const inflight = new Map<string, Promise<void>>();
const failed = new LRUCache<string, number>({ max: 20000 });
let running = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queue(ref: KinoRef): Promise<void> | undefined {
  const busy = inflight.get(ref.k) ?? pending.get(ref.k)?.done;
  if (busy) return busy;
  if ((failed.get(ref.k) ?? 0) > Date.now() || pending.size >= QUEUE_LIMIT) return undefined;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  pending.set(ref.k, { ref, done, resolve });
  scheduleFlush();
  return done;
}

function scheduleFlush(): void {
  if (pending.size >= BATCH_SIZE) {
    drain();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    drain();
  }, GATHER_MS);
  flushTimer.unref?.();
}

function drain(): void {
  while (running < CONCURRENCY && pending.size > 0) {
    const batch: Pending[] = [];
    for (const [k, item] of pending) {
      pending.delete(k);
      inflight.set(k, item.done);
      batch.push(item);
      if (batch.length >= BATCH_SIZE) break;
    }
    running++;
    void runBatch(batch).finally(() => {
      running--;
      for (const item of batch) {
        inflight.delete(item.ref.k);
        item.resolve();
      }
      if (pending.size > 0) scheduleFlush();
    });
  }
}

async function runBatch(batch: Pending[]): Promise<void> {
  const refs = batch.map((item) => item.ref);
  const key = apiKey();
  if (!key) return;
  let data: unknown[];
  try {
    data = await fetchTitles(refs, key);
  } catch (error) {
    if (error instanceof Paused) pausedUntil = Math.max(pausedUntil, Date.now() + error.ms);
    const retryAt = Date.now() + RETRY_MS;
    for (const ref of refs) failed.set(ref.k, retryAt);
    warn(`Could not read ${refs.length} titles: ${(error as Error).message}`);
    return;
  }
  try {
    const s = openStore();
    if (!s) throw new Error('store unavailable');
    storeAnswers(s, refs, data, Date.now());
    logger.debug(`Stored ${refs.length} titles, ${data.filter(isTitle).length} found`);
  } catch (error) {
    // Not asked for again right away: otherwise every page would send them to Kino API anew.
    const retryAt = Date.now() + RETRY_MS;
    for (const ref of refs) failed.set(ref.k, retryAt);
    storeError(`Could not store ${refs.length} titles: ${(error as Error).message}`);
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

async function enrich(metas: any[]): Promise<any[]> {
  const now = Date.now();
  const refs = new Map<string, KinoRef>();
  const keyAt = metas.map((meta) => {
    const source = sourceOf(meta);
    if (!source) return undefined;
    if (!refs.has(source.k)) refs.set(source.k, { ...source, tier: freshnessTier(meta, now) });
    return source.k;
  });
  if (refs.size === 0) return metas;

  const s = openStore();
  if (!s) return metas;
  const views = readViews(s, [...refs.keys()], now);
  const waiting: Promise<void>[] = [];
  const missing: string[] = [];
  for (const ref of refs.values()) {
    const row = views.get(ref.k);
    if (row) {
      if (row.expiresAt <= now) queue(ref);
      continue;
    }
    const done = queue(ref);
    if (done) {
      waiting.push(done);
      missing.push(ref.k);
    }
  }
  const waitMs = envInt('KINOAPI_CATALOG_WAIT_MS', DEFAULT_WAIT_MS, 0);
  if (waiting.length > 0 && waitMs > 0) {
    await waitFor(waiting, waitMs);
    for (const [k, row] of readViews(s, missing, Date.now())) views.set(k, row);
  }

  let out = metas;
  metas.forEach((meta, index) => {
    const k = keyAt[index];
    const next = k ? applyView(meta, views.get(k)?.view) : meta;
    if (next === meta) return;
    if (out === metas) out = metas.slice();
    out[index] = next;
  });
  return out;
}

/** Catalog and search tiles with Kinopoisk fields added; the same array when there is nothing to add or no key. */
export async function withKinoApi(metas: any[]): Promise<any[]> {
  if (!Array.isArray(metas) || metas.length === 0 || !apiKey()) return metas;
  try {
    return await enrich(metas);
  } catch (error) {
    storeError(`Tiles left without Kinopoisk data: ${(error as Error).message}`);
    return metas;
  }
}

import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';

/**
 * Language of a TMDB logo next to `logo` on catalog tiles and metas: `logoLang`
 * (TMDB iso_639_1, null when the logo has no language).
 *
 * Added right before the response, after every cache and after the art policy, so the
 * fields describe the logo actually sent, whichever code path picked it and however old
 * the cached tile is. A logo is looked up by its TMDB file name in a small SQLite file.
 * A title whose logo is not there yet has its images read once, straight from TMDB and
 * not through Redis, and the response waits for that only briefly. Logos from anywhere
 * but image.tmdb.org get no fields.
 */

const logger = consola.withTag('TMDB logos');

const CONCURRENCY = 6;
const QUEUE_LIMIT = 2000;
const RECHECK_MS = 86_400_000;
const RETRY_MS = 10 * 60_000;
const REOPEN_AFTER_MS = 10 * 60_000;
const BUSY_TIMEOUT_MS = 50;
const DEFAULT_WAIT_MS = 600;

export interface LogoRow {
  file: string;
  lang: string | null;
}

export interface LogoTitle {
  k: string;
  type: 'movie' | 'tv';
  id: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const TMDB_LOGO = /image\.tmdb\.org\/t\/p\/[^/]+\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)(?:[?#]|$)/;
const NUMERIC_ID = /^\d+$/;
const TMDB_STREMIO_ID = /^tmdb:(\d+)$/;

/** TMDB file name of a logo URL, raw or behind /poster-cache/logo/; null for any other host. */
export function logoFileOf(url: unknown): string | null {
  return typeof url === 'string' ? TMDB_LOGO.exec(url)?.[1] ?? null : null;
}

/** The TMDB title of a tile or meta: its `_tmdbId`, else a `tmdb:` id. */
export function titleOf(meta: any): LogoTitle | null {
  if (!meta || typeof meta !== 'object' || (meta.type !== 'movie' && meta.type !== 'series')) return null;
  const type = meta.type === 'series' ? 'tv' : 'movie';
  const ownId = String(meta._tmdbId ?? '');
  const id = NUMERIC_ID.test(ownId) ? ownId : TMDB_STREMIO_ID.exec(String(meta.id ?? ''))?.[1];
  return id ? { k: `${type}:${id}`, type, id } : null;
}

/** Logos of a TMDB images answer; "xx" (no language) is stored as null, like a missing language. */
export function logoRows(images: any): LogoRow[] {
  if (!Array.isArray(images?.logos)) return [];
  const rows: LogoRow[] = [];
  for (const logo of images.logos) {
    const file = /^\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(String(logo?.file_path ?? ''))?.[1];
    if (!file) continue;
    const lang = typeof logo.iso_639_1 === 'string' && logo.iso_639_1 && logo.iso_639_1 !== 'xx' ? logo.iso_639_1 : null;
    rows.push({ file, lang });
  }
  return rows;
}

/** A copy of the meta with the logo language, or the meta itself when it is not known. */
export function withLogoFields(meta: any, row: LogoRow | undefined): any {
  return row ? { ...meta, logoLang: row.lang } : meta;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Store {
  db: BetterSqlite3.Database;
  read: BetterSqlite3.Statement;
  upsert: BetterSqlite3.Statement;
}

let store: Store | null = null;
let openFailedUntil = 0;
let lastError = 0;

/** Logged at most once a minute: these fields are optional and must not flood the log. */
function warn(message: string): void {
  if (Date.now() - lastError > 60_000) {
    lastError = Date.now();
    logger.warn(message);
  } else {
    logger.debug(message);
  }
}

function openStore(): Store | null {
  if (store) return store;
  if (Date.now() < openFailedUntil) return null;
  const file = path.join(process.cwd(), 'addon', 'data', 'tmdblogos.sqlite');
  let db: BetterSqlite3.Database | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new BetterSqlite3(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // A file made before logoW and logoH were dropped still has their columns w and h: unused.
    db.exec(`
      CREATE TABLE IF NOT EXISTS tmdb_logos (
        file TEXT PRIMARY KEY,
        lang TEXT
      ) WITHOUT ROWID;
    `);
    store = {
      db,
      read: db.prepare('SELECT file, lang FROM tmdb_logos WHERE file IN (SELECT value FROM json_each(?))'),
      upsert: db.prepare(`
        INSERT INTO tmdb_logos (file, lang) VALUES (@file, @lang)
        ON CONFLICT(file) DO UPDATE SET lang = excluded.lang
      `),
    };
    logger.info(`TMDB logo store ready at ${file}`);
    return store;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already unusable
    }
    openFailedUntil = Date.now() + REOPEN_AFTER_MS;
    warn(`Could not open the TMDB logo store, trying again in 10 minutes: ${(error as Error).message}`);
    return null;
  }
}

function readRows(s: Store, files: string[]): Map<string, LogoRow> {
  const out = new Map<string, LogoRow>();
  if (files.length === 0) return out;
  for (const row of s.read.all(JSON.stringify(files)) as LogoRow[]) out.set(row.file, row);
  return out;
}

// ---------------------------------------------------------------------------
// Queue: one TMDB images request per title, a few at a time
// ---------------------------------------------------------------------------

/** Titles read lately (a logo still missing then is not asked for again) or failed (retry time). */
const checked = new LRUCache<string, number>({ max: 50_000 });
const failed = new LRUCache<string, number>({ max: 20_000 });
const inflight = new Map<string, Promise<void>>();
const waiting: Array<{ title: LogoTitle; config: any; start: () => void }> = [];
let running = 0;

function queue(title: LogoTitle, config: any): Promise<void> | undefined {
  const busy = inflight.get(title.k);
  if (busy) return busy;
  const now = Date.now();
  if ((checked.get(title.k) ?? 0) > now - RECHECK_MS || (failed.get(title.k) ?? 0) > now) return undefined;
  if (waiting.length >= QUEUE_LIMIT) return undefined;
  const done = new Promise<void>((resolve) => {
    waiting.push({ title, config, start: resolve });
  }).then(() => readTitle(title, config));
  const settled = done.finally(() => {
    inflight.delete(title.k);
    running--;
    next();
  });
  inflight.set(title.k, settled);
  next();
  return settled;
}

function next(): void {
  while (running < CONCURRENCY && waiting.length > 0) {
    running++;
    waiting.shift()!.start();
  }
}

async function readTitle(title: LogoTitle, config: any): Promise<void> {
  let images: any;
  try {
    images = await require('./getTmdb').titleImagesUncached(title.type, title.id, config);
  } catch (error) {
    failed.set(title.k, Date.now() + RETRY_MS);
    warn(`Could not read the logos of ${title.k}: ${(error as Error).message}`);
    return;
  }
  const rows = logoRows(images);
  try {
    const s = openStore();
    if (!s) throw new Error('store unavailable');
    if (rows.length > 0) s.db.transaction(() => rows.forEach((row) => s.upsert.run(row)))();
    checked.set(title.k, Date.now());
  } catch (error) {
    failed.set(title.k, Date.now() + RETRY_MS);
    warn(`Could not store the logos of ${title.k}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
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

type AddLogoInfo = (tiles: any[]) => any[];

const unchanged: AddLogoInfo = (tiles) => tiles;

async function lookUp(metas: any[], config: any): Promise<AddLogoInfo> {
  const files = metas.map((meta) => logoFileOf(meta?.logo));
  const wanted = [...new Set(files.filter((file): file is string => !!file))];
  if (wanted.length === 0) return unchanged;
  const s = openStore();
  if (!s) return unchanged;

  let rows = readRows(s, wanted);
  const pending: Promise<void>[] = [];
  metas.forEach((meta, index) => {
    const file = files[index];
    if (!file || rows.has(file)) return;
    const title = titleOf(meta);
    const done = title && queue(title, config);
    if (done) pending.push(done);
  });
  const waitMs = envInt('TMDB_LOGO_INFO_WAIT_MS', DEFAULT_WAIT_MS, 0);
  if (pending.length > 0 && waitMs > 0) {
    await waitFor(pending, waitMs);
    rows = readRows(s, wanted);
  }

  return (tiles) => {
    let out = tiles;
    tiles.forEach((meta, index) => {
      // By the tile's own logo, not its place: another lookup may have rebuilt the list.
      const file = logoFileOf(meta?.logo);
      const nextMeta = file ? withLogoFields(meta, rows.get(file)) : meta;
      if (nextMeta === meta) return;
      if (out === tiles) out = tiles.slice();
      out[index] = nextMeta;
    });
    return out;
  };
}

/**
 * Looks the logos of the tiles up, waiting briefly for new titles, and gives back what adds
 * logoLang to these tiles or to copies of them: so another lookup that waits too can run on
 * the same tiles at the same time.
 */
export async function lookUpTmdbLogoInfo(metas: any[], config: any): Promise<AddLogoInfo> {
  if (!Array.isArray(metas) || metas.length === 0) return unchanged;
  try {
    return await lookUp(metas, config);
  } catch (error) {
    warn(`Logos left without language: ${(error as Error).message}`);
    return unchanged;
  }
}

/** Tiles or metas with logoLang next to a TMDB logo; the same array when there is nothing to add. */
export async function withTmdbLogoInfo(metas: any[], config: any): Promise<any[]> {
  return (await lookUpTmdbLogoInfo(metas, config))(metas);
}

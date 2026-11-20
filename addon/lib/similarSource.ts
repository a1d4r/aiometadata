/**
 * Whether Simkl recommends More Like This for a title the config leaves to TMDB. Simkl's viewers
 * pick better than TMDB for anime and for Russian titles, while TMDB keeps the genre for the rest,
 * where Simkl leans to the hits everyone watched. SIMILAR_SIMKL_FOR lists what goes to Simkl:
 * "anime" and original languages, as in "anime,ru". Unset, nothing does, as upstream. Simkl falls
 * back to TMDB when it has nothing for the title.
 */
export function simklPicksSimilar(meta: any, type: 'movie' | 'series'): boolean {
  const wanted = String(process.env.SIMILAR_SIMKL_FOR || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return false;
  if (wanted.includes('anime') && isAnime(meta, type)) return true;
  // TMDB names a language "ru" and TVDB "rus": both sides are read as one ISO 639-2 code. The
  // fields are those of originalLanguage in jellyfin/items.ts, which pulls in all of Jellyfin.
  const { resolveLanguage } = require('./jellyfin/languageTags');
  const codeOf = (raw: any): string | null => (raw ? resolveLanguage(String(raw))?.code ?? null : null);
  const language = codeOf(meta?._originalLanguage || meta?._providerArt?.originalLanguage);
  return !!language && wanted.some((entry) => entry !== 'anime' && codeOf(entry) === language);
}

// Two Simkl requests take ~0.5 s; Melange waits 3 s for the whole row, cards included.
const SIMKL_WAIT_MS = 1200;

/**
 * Simkl's suggestions, or none when they take longer than Melange can wait, so that TMDB
 * answers instead. Simkl retries a dead connection for minutes and caches no failure, so a
 * request would otherwise hang while it is down. A late answer still fills the cache.
 */
export function withinSimklWait<T>(request: Promise<T[]>, waitMs = SIMKL_WAIT_MS): Promise<T[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T[]>((resolve) => {
    timer = setTimeout(() => resolve([]), waitMs);
  });
  return Promise.race([request, late]).finally(() => clearTimeout(timer));
}

/** Anime as the anime mappings know it, the way rows and meta tell it, whatever id the card was opened by. */
function isAnime(meta: any, type: 'movie' | 'series'): boolean {
  if (meta?._malId || meta?._providerArt?.anime) return true;
  const { isAnimeTitle } = require('./jellyfin/canonicalIds');
  const imdb = meta?._imdbId || meta?.imdb_id;
  const ids = [meta?.id, imdb, meta?._tmdbId && `tmdb:${meta._tmdbId}`].filter(Boolean).map(String);
  return ids.some((id) => isAnimeTitle(id, type));
}

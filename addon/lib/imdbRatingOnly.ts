// Melange: tiles built from TMDB rows (metaFromTmdbRow) carry TMDB's vote_average as imdbRating, and
// Melange draws it under an IMDb badge. Lists that skip the catalog's IMDb projection (cacheWrapCatalog)
// pass through here: a figure from the in-memory IMDb table, else no field (not "N/A").
const IMDB_ID = /^tt\d+$/;

const imdbIdOf = (meta: any): string | undefined =>
  [meta?._imdbId, meta?.imdb_id, meta?.id].find((value) => typeof value === 'string' && IMDB_ID.test(value));

/** One batch for the list, no request per tile; returns copies, the input stays as it was. */
export async function withImdbRatingOnly(metas: any[]): Promise<any[]> {
  if (!Array.isArray(metas) || metas.length === 0) return metas;
  const { getImdbRatingStrings } = require('./imdbRatings');
  const ratings: Map<string, string> = await getImdbRatingStrings(metas.map(imdbIdOf).filter(Boolean));
  return metas.map((meta) => {
    if (!meta || typeof meta !== 'object') return meta;
    const { imdbRating: _ignored, ...rest } = meta;
    const imdbId = imdbIdOf(meta);
    const rating = imdbId ? ratings.get(imdbId) : undefined;
    return rating ? { ...rest, imdbRating: rating } : rest;
  });
}

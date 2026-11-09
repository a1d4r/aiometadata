/**
 * The TMDB collection a movie belongs to (`belongs_to_collection` of the movie details),
 * as `belongsToCollection` on its meta. `id` is the catalog id that lists the movies of the
 * collection, `catalog/movie/tmdb.collection.<id>.json`; `name` comes in the language of the
 * details. Not `collection`: that key already marks a meta that is a collection itself.
 */

export interface BelongsToCollection {
  id: string;
  name: string;
}

export function belongsToCollectionOf(movie: any): BelongsToCollection | undefined {
  const collection = movie?.belongs_to_collection;
  const id = Number(collection?.id);
  const name = typeof collection?.name === 'string' ? collection.name.trim() : '';
  return Number.isSafeInteger(id) && id > 0 && name ? { id: `tmdb.collection.${id}`, name } : undefined;
}

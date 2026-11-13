/**
 * The cast of a TMDB series over all its seasons. `credits` of tv/{id} is the cast of the
 * latest season only (Doctor Who 2005: the three actors of 2021), while
 * tv/{id}/aggregate_credits lists everyone who ever played, with the episodes each played in.
 * The series meta keeps the first ones by episodes, in the shape of `credits.cast`, so
 * `parseCast` reads them as it reads `credits`.
 */

/** How many are kept in the cache; the meta is cut to `castCount` on the way out. */
export const AGGREGATE_CAST_LIMIT = 30;

/** Part of the cache key of the cut (7 days): raise it on any change to what this file keeps. */
export const AGGREGATE_CAST_VERSION = 1;

export interface CastCredit {
  id: number;
  name: string;
  original_name?: string;
  character: string;
  profile_path: string | null;
  order?: number;
}

function episodes(value: any): number {
  return Number.isFinite(value) ? value : 0;
}

/** The character of the role played in the most episodes; the first such role on a tie. */
function mainCharacter(roles: any): string {
  let best = '';
  let bestEpisodes = -1;
  for (const role of Array.isArray(roles) ? roles : []) {
    const character = typeof role?.character === 'string' ? role.character.trim() : '';
    if (character && episodes(role.episode_count) > bestEpisodes) {
      best = character;
      bestEpisodes = episodes(role.episode_count);
    }
  }
  return best;
}

/**
 * The first `limit` of the cast of an aggregate_credits reply, by episodes played and then by
 * TMDB's `order`; null when there is nobody, so the caller keeps `credits`.
 */
export function topAggregateCast(reply: any, limit: number = AGGREGATE_CAST_LIMIT): CastCredit[] | null {
  const cast = Array.isArray(reply?.cast) ? reply.cast : [];
  const top = cast
    .filter((person: any) => person && Number.isInteger(person.id) && typeof person.name === 'string' && person.name.trim())
    .sort((a: any, b: any) =>
      episodes(b.total_episode_count) - episodes(a.total_episode_count)
      || (Number.isFinite(a.order) ? a.order : Infinity) - (Number.isFinite(b.order) ? b.order : Infinity))
    .slice(0, limit)
    .map((person: any): CastCredit => ({
      id: person.id,
      name: person.name.trim(),
      ...(typeof person.original_name === 'string' ? { original_name: person.original_name } : {}),
      character: mainCharacter(person.roles),
      profile_path: typeof person.profile_path === 'string' && person.profile_path ? person.profile_path : null,
      ...(Number.isFinite(person.order) ? { order: person.order } : {}),
    }));
  return top.length ? top : null;
}

/** `credits` with the cast over all seasons, or as it is when there is none; crew stays. */
export function withCastOverSeasons(credits: any, cast: CastCredit[] | null | undefined): any {
  if (!Array.isArray(cast) || cast.length === 0) return credits;
  return { ...(credits || {}), cast, crew: Array.isArray(credits?.crew) ? credits.crew : [] };
}

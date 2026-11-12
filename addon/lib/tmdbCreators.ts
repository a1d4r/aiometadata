/**
 * The people who created a TMDB series (`created_by` of the series details), as
 * `app_extras.creators` on its meta. Same shape as `app_extras.directors`, so a client opens a
 * creator the way it opens a director, by `tmdbId`.
 */

export interface Creator {
  name: string;
  character: string;
  photo: string | null;
  tmdbId: number;
}

export function creatorsOf(series: any): Creator[] {
  const createdBy = Array.isArray(series?.created_by) ? series.created_by : [];
  return createdBy
    .filter((person: any) => person && Number.isInteger(person.id) && typeof person.name === 'string' && person.name.trim())
    .map((person: any) => {
      const name = person.name.trim();
      return {
        name,
        character: name,
        photo: person.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${person.profile_path}` : null,
        tmdbId: person.id,
      };
    });
}

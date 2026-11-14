// https://docs.aiostreams.viren070.me/reference/addon-protocol/people/
import { envInt } from '../utils/envNumber';

const PERSON_ID = /^(tmdb|tvdb):(\d+)$/;

const day = (value: string | null | undefined): string | undefined => {
  const match = String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : undefined;
};

const CREDIT_FIELDS = ['id', 'type', 'name', 'poster', 'background', 'description', 'releaseInfo', 'released', 'year', 'imdbRating', 'role', 'personTypes', 'episodes'];

const creditsLimit = (): number => envInt('PERSON_CREDITS_LIMIT', 100, 1);

// A long-running show the person dropped into once outvotes their own work.
const isGuestSpot = (meta: any): boolean => meta.type === 'series' && meta._episodes > 0 && meta._episodes <= 2;

/** Guest spots on shows last, the rest by TMDB votes; then cut, so the cut keeps the main work. */
export function rankTmdbCredits(credits: any[]): any[] {
  return [...credits]
    .sort((a, b) => Number(isGuestSpot(a)) - Number(isGuestSpot(b)) || (b._votes || 0) - (a._votes || 0))
    .slice(0, creditsLimit());
}

// A character comes first, then what they did behind the camera, the director's chair before a producer credit.
const JOB_ORDER = ['Director', 'Creator', 'Writer'];
const roleRank = (role: any): number => {
  if (role.credit === 'cast') return 0;
  const ranks = (role.kinds || []).map((kind: string) => (JOB_ORDER.includes(kind) ? JOB_ORDER.indexOf(kind) : JOB_ORDER.length));
  return 1 + Math.min(JOB_ORDER.length, ...ranks);
};

/** What the person was on the title: up to two characters or jobs, characters first. */
export function creditRole(meta: any): string | undefined {
  const roles: any[] = Array.isArray(meta._roles) ? meta._roles : [];
  const text = [...roles].sort((a, b) => roleRank(a) - roleRank(b)).slice(0, 2).map((r) => r.text).join(', ');
  return text || undefined;
}

// Jellyfin counts every acting credit as GuestStar too; to a client it would read as a guest spot.
const personTypes = (meta: any): string[] | undefined =>
  Array.isArray(meta._personTypes) ? meta._personTypes.filter((kind: string) => kind !== 'GuestStar') : undefined;

export async function personMeta(config: any, id: string): Promise<any | null> {
  const match = id.match(PERSON_ID);
  if (!match) return null;
  const { personById, personCredits } = require('./jellyfin/people');
  const person = await personById(config, match[1], Number(match[2]));
  if (!person) return null;

  let credits: any[] = (await personCredits(config, person)).filter((meta: any) => meta._personTypes?.length);
  if (person.source === 'tmdb') credits = rankTmdbCredits(credits);
  const { creditCards } = require('./titleCards');
  const { withImdbRatingOnly } = require('./imdbRatingOnly');
  const cards: any[] = (await withImdbRatingOnly(await creditCards(config, credits))).map((meta: any) => ({
    ...meta,
    role: creditRole(meta),
    personTypes: personTypes(meta),
    episodes: meta._episodes,
  }));

  return {
    id,
    type: 'person',
    name: person.name,
    description: person.biography || undefined,
    descriptionLang: person.biography ? person.biographyLang : undefined,
    knownFor: person.knownFor || undefined,
    poster: person.photo || undefined,
    birthday: day(person.birthday),
    deathday: day(person.deathday),
    birthPlace: person.birthplace || undefined,
    ids: {
      [match[1]]: match[2],
      [person.source]: String(person.id),
      ...(person.imdbId ? { imdb: person.imdbId } : {}),
    },
    credits: cards.map((meta) => Object.fromEntries(CREDIT_FIELDS.filter((field) => meta[field]).map((field) => [field, meta[field]]))),
  };
}

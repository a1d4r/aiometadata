/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/personMeta.test.ts
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// TMDB and the card builder are swapped for fixtures before the modules load them.
const calls: any[] = [];
let tmdb: { person: Record<string, any>; movies: any; shows: any } = { person: {}, movies: {}, shows: {} };
const stub = (file: string, exports: any) => {
  const id = require.resolve(path.join(__dirname, file));
  require.cache[id] = { id, filename: id, loaded: true, exports } as any;
};
stub('getTmdb', {
  personInfo: async ({ id, language }: any) => {
    calls.push(['person', id, language]);
    return tmdb.person[language] ?? null;
  },
  personMovieCredits: async () => tmdb.movies,
  personTvCredits: async () => tmdb.shows,
});
stub('titleCards', { creditCards: async (_config: any, rows: any[]) => rows.map((row) => ({ ...row })) });
const RATINGS: Record<string, string> = { tt0108778: '8.9' };
stub('imdbRatings', {  // read through imdbRatingOnly
  getImdbRatingStrings: async (ids: string[]) => new Map(ids.filter((id) => RATINGS[id]).map((id) => [id, RATINGS[id]])),
});

const { personMeta, rankTmdbCredits } = require('./personMeta');
const { normalizeTmdbPersonCreditsForCache } = require('./tmdbCacheNormalizers');

const RU = { language: 'ru-RU' };
const person = (biography: string) => ({ id: 14408, name: 'Мэттью Перри', biography, known_for_department: 'Acting' });

beforeEach(() => {
  calls.length = 0;
  delete process.env.PERSON_CREDITS_LIMIT;
  tmdb = { person: { 'ru-RU': person('Американский актёр.') }, movies: { cast: [], crew: [] }, shows: { cast: [], crew: [] } };
});

test('a guest spot on a long-running show goes below the person’s own show', async () => {
  tmdb.shows.cast = [
    { id: 456, name: 'Симпсоны', first_air_date: '1989-12-17', vote_count: 10000, character: 'Steve Smith (voice)', episode_count: 1 },
    { id: 1668, name: 'Друзья', first_air_date: '1994-09-22', vote_count: 8000, character: 'Chandler Bing', episode_count: 236 },
  ];
  tmdb.movies.cast = [{ id: 2668, title: '17 снова', release_date: '2009-04-17', vote_count: 5000, character: 'Mike O’Donnell (Adult)' }];
  const meta = await personMeta(RU, 'tmdb:14408');
  assert.deepEqual(meta.credits.map((c: any) => c.name), ['Друзья', '17 снова', 'Симпсоны']);
  const friends = meta.credits[0];
  assert.equal(friends.role, 'Chandler Bing');
  assert.equal(friends.episodes, 236);
  assert.deepEqual(friends.personTypes, ['Actor']);
  // a movie has no episode count, and is not a guest spot
  assert.equal(meta.credits[1].episodes, undefined);
  assert.equal(meta.knownFor, 'Actor');
});

test('the role puts the character first, then the director’s chair before a producer credit, without repeats', async () => {
  tmdb.shows.cast = [{ id: 1396, name: 'Во все тяжкие', first_air_date: '2008-01-20', vote_count: 15000, character: 'Walter White', episode_count: 62 }];
  tmdb.shows.crew = [
    { id: 1396, name: 'Во все тяжкие', first_air_date: '2008-01-20', vote_count: 15000, job: 'Producer', department: 'Production', episode_count: 16 },
    { id: 1396, name: 'Во все тяжкие', first_air_date: '2008-01-20', vote_count: 15000, job: 'Director', department: 'Directing', episode_count: 3 },
    { id: 1396, name: 'Во все тяжкие', first_air_date: '2008-01-20', vote_count: 15000, job: 'Director', department: 'Directing', episode_count: 3 },
  ];
  const [show] = (await personMeta(RU, 'tmdb:17419')).credits;
  assert.equal(show.role, 'Walter White, Director');
  assert.deepEqual(show.personTypes, ['Actor', 'Producer', 'Director']);
  assert.equal(show.episodes, 62);
});

test('a director’s films take their job as the role', async () => {
  tmdb.movies.crew = [
    { id: 329865, title: 'Прибытие', release_date: '2016-11-10', vote_count: 19000, job: 'Director', department: 'Directing' },
    { id: 329865, title: 'Прибытие', release_date: '2016-11-10', vote_count: 19000, job: 'Screenplay', department: 'Writing' },
  ];
  const [film] = (await personMeta(RU, 'tmdb:137427')).credits;
  assert.equal(film.role, 'Director, Screenplay');
  assert.deepEqual(film.personTypes, ['Director', 'Writer']);
});

test('playing themselves gives no role and drops the title, as before', async () => {
  tmdb.shows.cast = [{ id: 1, name: 'Шоу', first_air_date: '2000-01-01', vote_count: 10, character: 'Himself', episode_count: 4 }];
  assert.deepEqual((await personMeta(RU, 'tmdb:14408')).credits, []);
});

test('an empty biography falls back to English and says so', async () => {
  tmdb.person['ru-RU'] = person('');
  tmdb.person['en-US'] = person('Maxime Gaudette is a Canadian actor.');
  const meta = await personMeta(RU, 'tmdb:88592');
  assert.equal(meta.description, 'Maxime Gaudette is a Canadian actor.');
  assert.equal(meta.descriptionLang, 'en');
  assert.deepEqual(calls.map((c) => c[2]), ['ru-RU', 'en-US']);
});

test('a biography in the asked language takes no second request and no language mark', async () => {
  const meta = await personMeta(RU, 'tmdb:137427');
  assert.equal(meta.description, 'Американский актёр.');
  assert.equal(meta.descriptionLang, undefined);
  assert.deepEqual(calls.map((c) => c[2]), ['ru-RU']);
});

test('no biography in either language leaves both out', async () => {
  tmdb.person['ru-RU'] = person('');
  tmdb.person['en-US'] = person('');
  const meta = await personMeta(RU, 'tmdb:1');
  assert.equal(meta.description, undefined);
  assert.equal(meta.descriptionLang, undefined);
});

test('an English config asks once', async () => {
  tmdb.person['en-US'] = person('');
  await personMeta({ language: 'en-US' }, 'tmdb:1');
  assert.equal(calls.length, 1);
});

test('the filmography is cut after ranking, so a guest spot is what falls off', () => {
  process.env.PERSON_CREDITS_LIMIT = '2';
  const guest = { type: 'series', name: 'guest', _votes: 900, _episodes: 1 };
  const credits = [guest, { type: 'movie', name: 'a', _votes: 10 }, { type: 'series', name: 'b', _votes: 5, _episodes: 3 }];
  assert.deepEqual(rankTmdbCredits(credits).map((c: any) => c.name), ['a', 'b']);
});

test('the filmography is cut at 100 by default', () => {
  const credits = Array.from({ length: 150 }, (_, i) => ({ type: 'movie', name: String(i), _votes: i }));
  const ranked = rankTmdbCredits(credits);
  assert.equal(ranked.length, 100);
  assert.equal(ranked[0].name, '149');
});

test('the credits cache keeps the episode count', () => {
  const normalized = normalizeTmdbPersonCreditsForCache({ id: 1, cast: [{ id: 1, name: 'x', episode_count: 7, credit_id: 'c' }], crew: [] });
  assert.deepEqual(normalized.cast, [{ id: 1, name: 'x', episode_count: 7 }]);
});

test('a credit carries the IMDb rating of its title, as a catalog tile does', async () => {
  tmdb.shows.cast = [{ id: 1668, name: 'Друзья', first_air_date: '1994-09-22', vote_count: 8000, character: 'Chandler Bing', episode_count: 236 }];
  tmdb.movies.cast = [{ id: 2668, title: '17 снова', release_date: '2009-04-17', vote_count: 5000, vote_average: 6.4, character: 'Mike' }];
  const { creditCards } = require('./titleCards');
  const cards = (rows: any[]) => rows.map((row) => ({ ...row, ...(row.name === 'Друзья' ? { _imdbId: 'tt0108778' } : {}) }));
  require.cache[require.resolve('./titleCards')]!.exports.creditCards = async (_c: any, rows: any[]) => cards(rows);
  try {
    const meta = await personMeta(RU, 'tmdb:14408');
    assert.equal(meta.credits.find((c: any) => c.name === 'Друзья').imdbRating, '8.9');
    // no IMDb id or no rating: no field, and not TMDB's vote_average under an IMDb name
    assert.equal('imdbRating' in meta.credits.find((c: any) => c.name === '17 снова'), false);
  } finally {
    require.cache[require.resolve('./titleCards')]!.exports.creditCards = creditCards;
  }
});

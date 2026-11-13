/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/cinemetaPairs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cinemetaPairs, pairVideos, lookUpCinemetaPairs } from './cinemetaPairs';

const day = (n: number) => new Date(Date.UTC(2020, 0, 1) + n * 86400000).toISOString();
const tmdb = (season: number, episode: number, d: number | null, id = `tt1:${season}:${episode}`) =>
  ({ id, title: `T${season}x${episode}`, season, episode, released: d === null ? null : day(d) });
const cin = (season: number, episode: number, d: number | null) =>
  ({ id: `tt1:${season}:${episode}`, season, episode, released: d === null ? undefined : day(d) });
const pairsOf = (videos: any[], cinemeta: any[]) => Object.fromEntries(cinemetaPairs(videos, cinemeta));

test('the same numbering on both sides pairs every episode with itself', () => {
  const videos = [tmdb(1, 1, 0), tmdb(1, 2, 7), tmdb(2, 1, 100), tmdb(2, 2, 107)];
  const out = pairVideos(videos, [cin(1, 1, 0), cin(1, 2, 7), cin(2, 1, 100), cin(2, 2, 107)], 'tt1', '99');
  assert.deepEqual(out.map((v) => [v.id, v.imdbSeason, v.imdbEpisode, v.absoluteEpisode]),
    [['tt1:1:1', 1, 1, 1], ['tt1:1:2', 1, 2, 2], ['tt1:2:1', 2, 1, 3], ['tt1:2:2', 2, 2, 4]]);
  assert.equal(out[0].title, 'T1x1');
});

test('TMDB numbering across seasons maps onto Cinemeta seasons by air date', () => {
  // TMDB: one season E1..E5; Cinemeta: S1 = 2 episodes, S2 = 3 (One Piece in small).
  const videos = [1, 2, 3, 4, 5].map((e) => tmdb(1, e, e * 7, `tt1:1:${e}`));
  const out = pairVideos(videos, [cin(1, 1, 7), cin(1, 2, 14), cin(2, 1, 21), cin(2, 2, 28), cin(2, 3, 35)], 'tt1', '99');
  assert.deepEqual(out.map((v) => v.id), ['tt1:1:1', 'tt1:1:2', 'tt1:2:1', 'tt1:2:2', 'tt1:2:3']);
  assert.deepEqual(out.map((v) => [v.season, v.episode, v.absoluteEpisode]), [[1, 1, 1], [1, 2, 2], [1, 3, 3], [1, 4, 4], [1, 5, 5]]);
});

test('an episode Cinemeta lacks stays unpaired and keeps its id; its neighbours still pair', () => {
  // TMDB E3 is a crossover Cinemeta keeps in season 0 on another day.
  const videos = [1, 2, 3, 4].map((e) => tmdb(1, e, e * 7));
  const pairs = pairsOf(videos, [cin(1, 1, 7), cin(1, 2, 14), cin(2, 1, 28), cin(0, 9, 200)]);
  assert.deepEqual(pairs, { '1:1': [1, 1], '1:2': [1, 2], '1:4': [2, 1] });
  const out = pairVideos(videos, [cin(1, 1, 7), cin(1, 2, 14), cin(2, 1, 28)], 'tt1', '99');
  assert.equal(out[2].id, 'tt1:1:3');
  assert.equal(out[2].imdbSeason, undefined);
  assert.equal(out[2].absoluteEpisode, 3);
});

test('a wrong date between matches is paired by position when both gaps are the same size', () => {
  const videos = [1, 2, 3, 4].map((e) => tmdb(1, e, e * 7));
  // Cinemeta has E3 a month late.
  assert.deepEqual(pairsOf(videos, [cin(1, 1, 7), cin(1, 2, 14), cin(1, 3, 50), cin(1, 4, 28)])['1:3'], [1, 3]);
});

test('a wrong date that matches the neighbour aired the same day is undone', () => {
  // Cinemeta puts E2 and E3 on day 14; TMDB has E3 on day 21. The date match may take E2 <-> C3.
  const videos = [1, 2, 3, 4].map((e) => tmdb(1, e, e * 7));
  const pairs = pairsOf(videos, [cin(1, 1, 7), cin(1, 2, 14), cin(1, 3, 14), cin(1, 4, 28)]);
  assert.deepEqual(pairs, { '1:1': [1, 1], '1:2': [1, 2], '1:3': [1, 3], '1:4': [1, 4] });
});

test('upcoming episodes without a date pair by position only when both tails are as long', () => {
  const videos = [tmdb(1, 1, 7), tmdb(1, 2, 14), tmdb(1, 3, 21)];
  assert.deepEqual(pairsOf(videos, [cin(1, 1, 7), cin(1, 2, null), cin(1, 3, null)]),
    { '1:1': [1, 1], '1:2': [1, 2], '1:3': [1, 3] });
  assert.deepEqual(pairsOf(videos, [cin(1, 1, 7), cin(1, 2, 14)]), { '1:1': [1, 1], '1:2': [1, 2] });
});

test('specials pair by date only, never by position', () => {
  const videos = [tmdb(0, 1, 10), tmdb(0, 2, 300), tmdb(0, 3, null), tmdb(1, 1, 7)];
  const out = pairVideos(videos, [cin(0, 5, 11), cin(0, 6, 500), cin(0, 7, null), cin(1, 1, 7)], 'tt1', '99');
  assert.deepEqual(out.map((v) => [v.id, v.imdbSeason, v.imdbEpisode, v.absoluteEpisode]),
    [['tt1:0:5', 0, 5, undefined], ['tt1:0:2', undefined, undefined, undefined], ['tt1:0:3', undefined, undefined, undefined], ['tt1:1:1', 1, 1, 1]]);
});

test('specials aired the same day pair by their numbers, or not at all', () => {
  // Breaking Bad: four webisodes on one day, numbered alike on both sides.
  const webisodes = [1, 2, 3, 4].map((e) => tmdb(0, e, 50));
  assert.deepEqual(pairsOf(webisodes, [1, 2, 3, 4, 5].map((e) => cin(0, e, 50))),
    { '0:1': [0, 1], '0:2': [0, 2], '0:3': [0, 3], '0:4': [0, 4] });
  // Two specials on one day under other numbers: no telling which is which.
  assert.deepEqual(pairsOf([tmdb(0, 7, 90), tmdb(0, 8, 90)], [cin(0, 30, 90), cin(0, 31, 90)]), {});
  // One left in the window after the numbered one: still ambiguous when another TMDB special wants it.
  assert.deepEqual(pairsOf([tmdb(0, 16, 90), tmdb(0, 20, 90), tmdb(0, 21, 91)], [cin(0, 16, 90), cin(0, 171, 90)]), { '0:16': [0, 16] });
  // ... and taken when it is the only one either side.
  assert.deepEqual(pairsOf([tmdb(0, 16, 90), tmdb(0, 20, 91)], [cin(0, 16, 90), cin(0, 171, 90)]), { '0:16': [0, 16], '0:20': [0, 171] });
});

test('a daily show pairs each day with its own day, not a neighbour within the window', () => {
  const videos = [1, 2, 3, 4, 5].map((e) => tmdb(1, e, e));
  assert.deepEqual(pairsOf(videos, [1, 2, 3, 4, 5].map((e) => cin(1, e, e))),
    { '1:1': [1, 1], '1:2': [1, 2], '1:3': [1, 3], '1:4': [1, 4], '1:5': [1, 5] });
});

test('a fallback id that lost its tmdb: prefix gets it back; another IMDb title stays', () => {
  const videos = [tmdb(11, 1, 900, '57041:11:1'), tmdb(2, 1, 800, 'tt9:1:1')];
  const out = pairVideos(videos, [], 'tt1', '99');
  assert.deepEqual(out.map((v) => v.id), ['tmdb:57041:11:1', 'tt9:1:1']);
});

test('an unpaired episode whose id names another Cinemeta episode gets a tmdb: id', () => {
  // TMDB 0:47 has no match, but Cinemeta's 0:47 is the one TMDB 0:50 pairs with.
  const videos = [tmdb(0, 47, 100, 'tt1:0:47'), tmdb(0, 50, 80, 'tt1:0:50'), tmdb(1, 1, 7)];
  const out = pairVideos(videos, [cin(0, 47, 80), cin(1, 1, 7)], 'tt1', '99');
  assert.deepEqual(out.map((v) => v.id), ['tmdb:99:0:47', 'tt1:0:47', 'tt1:1:1']);
  assert.equal(new Set(out.map((v) => v.id)).size, 3);
  // The newest episode, undated at Cinemeta behind a placeholder: no pair, and its id stays.
  const airing = pairVideos([tmdb(1, 1, 0), tmdb(1, 2, 7), tmdb(1, 3, 14)], [cin(1, 1, 0), cin(1, 2, 7), cin(1, 3, null), cin(1, 4, null)], 'tt1', '99');
  assert.deepEqual(airing.map((v) => v.id), ['tt1:1:1', 'tt1:1:2', 'tt1:1:3']);
  assert.equal(airing[2].imdbSeason, undefined);
  // Without the TMDB id it is left as built.
  assert.equal(pairVideos(videos, [cin(0, 47, 80), cin(1, 1, 7)], 'tt1', null)[0].id, 'tt1:0:47');
});

test('the ends of the lists never reach across a match', () => {
  // TMDB splits the premiere in two; Cinemeta has one more undated episode in its tail.
  const videos = [tmdb(1, 1, 0), tmdb(1, 2, 0), tmdb(1, 3, 7), tmdb(1, 4, 14)];
  assert.deepEqual(pairsOf(videos, [cin(1, 1, 0), cin(1, 2, 7), cin(1, 3, null), cin(1, 4, null)]),
    { '1:1': [1, 1], '1:3': [1, 2] });
});

test('thousands of episodes on one date skip the date match rather than make millions of candidates', () => {
  const many = Array.from({ length: 1000 }, (_, e) => tmdb(1, e + 1, 5));
  const started = Date.now();
  // Lists as long pair by position, as with no dates at all; otherwise nothing pairs.
  const even = pairsOf(many, Array.from({ length: 1000 }, (_, e) => cin(1, e + 1, 5)));
  assert.equal(Object.keys(even).length, 1000);
  assert.deepEqual(even['1:777'], [1, 777]);
  assert.deepEqual(pairsOf(many, Array.from({ length: 999 }, (_, e) => cin(1, e + 1, 5))), {});
  assert.ok(Date.now() - started < 500);
});

test('lookUpCinemetaPairs: only TMDB-built series with an IMDb id, on a copy', async () => {
  const metaOf = (imdbId: string) => ({ id: imdbId, imdb_id: imdbId, _tmdbId: '99', type: 'series', _metaProvider: 'tmdb', videos: [tmdb(1, 1, 7, `${imdbId}:1:1`)] });
  const pairs = async (meta: any, fetch: (id: string) => Promise<any>, waitMs = 1000) => (await lookUpCinemetaPairs([meta], fetch, waitMs))([meta])[0];
  const meta = metaOf('tt101');
  const out = await pairs(meta, async () => ({ videos: [cin(1, 1, 7)] }));
  assert.equal(out.imdbPairs, true);
  assert.equal(out.videos[0].imdbEpisode, 1);
  assert.equal((meta.videos[0] as any).imdbEpisode, undefined);
  assert.equal('imdbPairs' in meta, false);

  const failed = await pairs(metaOf('tt102'), async () => undefined);
  assert.equal(failed.imdbPairs, false);
  assert.equal(failed.videos[0].imdbEpisode, undefined);
  assert.equal((await pairs(metaOf('tt103'), async () => { throw new Error('down'); })).imdbPairs, false);
  // Cinemeta slower than the wait: no pairs this time, and a good late answer is not held against it.
  const slow = () => new Promise((r) => setTimeout(r, 60, { videos: [cin(1, 1, 7)] }));
  assert.equal((await pairs(metaOf('tt104'), slow, 10)).imdbPairs, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await pairs(metaOf('tt104'), async () => ({ videos: [cin(1, 1, 7)] }))).imdbPairs, true);
  // A title Cinemeta does not know is not asked for again within the hour.
  let tries = 0;
  await pairs(metaOf('tt105'), async () => { tries++; throw new Error('307'); });
  assert.equal((await pairs(metaOf('tt105'), async () => { tries++; return { videos: [] }; })).imdbPairs, false);
  assert.equal(tries, 1);

  let asked = 0;
  const ask = async () => { asked++; return { videos: [] }; };
  for (const other of [{ ...meta, _metaProvider: 'tvdb' }, { ...meta, type: 'movie' }, { ...meta, imdb_id: undefined }, { ...meta, videos: [] }, null]) {
    assert.equal((await lookUpCinemetaPairs([other], ask))([other])[0], other);
  }
  assert.equal(asked, 0);
});

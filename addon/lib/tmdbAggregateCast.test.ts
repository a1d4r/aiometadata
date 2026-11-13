/*
 * Run without network:
 *   TS_NODE_SKIP_PROJECT=1 TS_NODE_TRANSPILE_ONLY=1 \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0"}' \
 *   node --require ts-node/register --test addon/lib/tmdbAggregateCast.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topAggregateCast, withCastOverSeasons, AGGREGATE_CAST_LIMIT } from './tmdbAggregateCast';

// Rows of tv/57243/aggregate_credits?language=ru-RU (Doctor Who 2005) as TMDB gave them on
// 13.11.2026, shuffled; roles of Nicholas Briggs cut to four of ten.
const smith = { id: 136532, name: 'Мэтт Смит', original_name: 'Matt Smith', profile_path: '/wxMdHj4UA6LgIU5MiA7CKySZeVU.jpg', order: 2, total_episode_count: 40, roles: [{ character: 'The Doctor', episode_count: 40 }] };
const tennant = { id: 20049, name: 'Дэвид Теннант', original_name: 'David Tennant', profile_path: '/syFdcmvI86Pn5YYfZLZlbkvCsj3.jpg', order: 5, total_episode_count: 40, roles: [{ character: 'The Doctor', episode_count: 40 }] };
const briggs = {
  id: 1193572, name: 'Николас Бриггс', original_name: 'Nicholas Briggs', profile_path: '/7QUxZVfw8WqUSxPVHrhmRtXGFUl.jpg', order: 1731, total_episode_count: 38,
  roles: [
    { character: 'Daleks (voice) / Judoon (voice)', episode_count: 1 },
    { character: 'Daleks (voice)', episode_count: 15 },
    { character: 'Daleks / Cybermen (voice)', episode_count: 4 },
    { character: 'Cybermen (voice)', episode_count: 11 },
  ],
};
const capaldi = { id: 12982, name: 'Питер Капальди', original_name: 'Peter Capaldi', profile_path: '/r5bEXZBOSA89SZvv4jjqa4iSgst.jpg', order: 176, total_episode_count: 37, roles: [{ character: 'The Doctor', episode_count: 36 }, { character: 'Caecilius', episode_count: 1 }] };
const whittaker = { id: 66431, name: 'Джоди Уиттакер', original_name: 'Jodie Whittaker', profile_path: '/zS6EO1GsfOiuyaa66YqmUPWDX78.jpg', order: 6, total_episode_count: 26, roles: [{ character: 'The Doctor', episode_count: 26 }] };
const gill = { id: 1752554, name: 'Мандип Гилл', original_name: 'Mandip Gill', profile_path: '/8YK6RDwTSrPhx6fwQaD83LnDxuN.jpg', order: 8, total_episode_count: 26, roles: [{ character: "Yasmin 'Yaz' Khan", episode_count: 26 }] };
const doctorWho = { id: 57243, cast: [whittaker, briggs, tennant, gill, capaldi, smith], crew: [{ id: 1, name: 'Someone', jobs: [{ job: 'Director', episode_count: 3 }] }] };

// credits of tv/57243: the latest season only.
const latestSeason = {
  cast: [
    { id: 66431, name: 'Джоди Уиттакер', character: 'The Doctor', profile_path: '/zS6EO1GsfOiuyaa66YqmUPWDX78.jpg', order: 6 },
    { id: 1752554, name: 'Мандип Гилл', character: "Yasmin 'Yaz' Khan", profile_path: '/8YK6RDwTSrPhx6fwQaD83LnDxuN.jpg', order: 8 },
  ],
  crew: [{ id: 2, name: 'Chris Chibnall', job: 'Writer', department: 'Writing' }],
};

test('by episodes played, then by order, each with the character of the main role', () => {
  assert.deepEqual(topAggregateCast(doctorWho), [
    { id: 136532, name: 'Мэтт Смит', original_name: 'Matt Smith', character: 'The Doctor', profile_path: '/wxMdHj4UA6LgIU5MiA7CKySZeVU.jpg', order: 2 },
    { id: 20049, name: 'Дэвид Теннант', original_name: 'David Tennant', character: 'The Doctor', profile_path: '/syFdcmvI86Pn5YYfZLZlbkvCsj3.jpg', order: 5 },
    { id: 1193572, name: 'Николас Бриггс', original_name: 'Nicholas Briggs', character: 'Daleks (voice)', profile_path: '/7QUxZVfw8WqUSxPVHrhmRtXGFUl.jpg', order: 1731 },
    { id: 12982, name: 'Питер Капальди', original_name: 'Peter Capaldi', character: 'The Doctor', profile_path: '/r5bEXZBOSA89SZvv4jjqa4iSgst.jpg', order: 176 },
    { id: 66431, name: 'Джоди Уиттакер', original_name: 'Jodie Whittaker', character: 'The Doctor', profile_path: '/zS6EO1GsfOiuyaa66YqmUPWDX78.jpg', order: 6 },
    { id: 1752554, name: 'Мандип Гилл', original_name: 'Mandip Gill', character: "Yasmin 'Yaz' Khan", profile_path: '/8YK6RDwTSrPhx6fwQaD83LnDxuN.jpg', order: 8 },
  ]);
});

test('the first role of the most episodes on a tie, and a role with a character over an empty one', () => {
  const [person] = topAggregateCast({ cast: [{ id: 1, name: 'A', total_episode_count: 9, roles: [
    { character: '', episode_count: 7 },
    { character: ' Milhouse Van Houten (voice) ', episode_count: 3 },
    { character: 'Jimbo Jones (voice)', episode_count: 3 },
  ] }] })!;
  assert.equal(person.character, 'Milhouse Van Houten (voice)');
  assert.equal(topAggregateCast({ cast: [{ id: 1, name: 'A', roles: [{ character: '', episode_count: 2 }] }] })![0].character, '');
  assert.equal(topAggregateCast({ cast: [{ id: 1, name: 'A' }] })![0].character, '');
});

test('the first 30 only, without episodes last, and nobody without an id or a name', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, order: i, total_episode_count: 100 - i, roles: [] }));
  const top = topAggregateCast({ cast: [{ id: 99, name: 'No episodes', order: 0 }, ...many] })!;
  assert.equal(top.length, AGGREGATE_CAST_LIMIT);
  assert.deepEqual(top.slice(0, 2).map((p) => p.id), [1, 2]);
  assert.equal(top.at(-1)!.id, 30);
  assert.deepEqual(topAggregateCast({ cast: [{ id: 99, name: 'No episodes' }, ...many.slice(0, 2)] })!.map((p) => p.id), [1, 2, 99]);
  assert.deepEqual(topAggregateCast({ cast: [null, { id: '7', name: 'A' }, { id: 8, name: '  ' }, { id: 9 }, { id: 10, name: ' B ', profile_path: '' }] }), [
    { id: 10, name: 'B', character: '', profile_path: null },
  ]);
});

test('nothing to take: null, so the latest season cast stays', () => {
  assert.equal(topAggregateCast({ id: 1, cast: [], crew: [] }), null);
  assert.equal(topAggregateCast({ id: 1 }), null);
  assert.equal(topAggregateCast(null), null);
  assert.equal(topAggregateCast({ cast: [{ id: 1 }] }), null);
  assert.equal(withCastOverSeasons(latestSeason, null), latestSeason);
  assert.equal(withCastOverSeasons(latestSeason, undefined), latestSeason);
  assert.equal(withCastOverSeasons(latestSeason, []), latestSeason);
});

test('the cast over all seasons with the crew of credits, for directors and writers', () => {
  const cast = topAggregateCast(doctorWho);
  const credits = withCastOverSeasons(latestSeason, cast);
  assert.equal(credits.cast, cast);
  assert.equal(credits.crew, latestSeason.crew);
  assert.deepEqual(latestSeason.cast.map((p) => p.name), ['Джоди Уиттакер', 'Мандип Гилл']);
  assert.deepEqual(withCastOverSeasons(null, cast), { cast, crew: [] });
});

/**
 * The Cinemeta (IMDb) number of each episode of a TMDB-built series, on its meta.
 *
 * Stream addons, Stremio and the Dune's own cards ask for an episode as <imdb>:<season>:<episode>
 * in Cinemeta's numbering. TMDB numbers some shows differently (One Piece runs 1..1180 across arcs,
 * Cinemeta has 8 episodes in its first season), and the series builder writes TMDB's numbers into
 * the video id whenever Cinemeta has a season of that number at all. Here every episode is matched
 * to Cinemeta's by air date, keeping both orders, and an episode with a match gets:
 *   id                       <imdb>:<cinemeta season>:<cinemeta episode>
 *   imdbSeason, imdbEpisode  the same pair
 * Every episode outside season 0 gets absoluteEpisode, its place in TMDB's order (what files in a
 * pack are numbered by). An episode without a match keeps the id the builder gave it (TMDB's
 * numbers, another IMDb title, kitsu:), so a show Cinemeta has not caught up with is asked for as
 * before, and a client tells a confirmed pair by imdbSeason. meta.imdbPairs says whether Cinemeta
 * answered; without it the meta goes out as built.
 *
 * Runs on the way out, after the meta caches, on a copy: the pairs follow Cinemeta's own day-long
 * cache, and nothing here needs a cache cleared when it changes.
 */

import { LRUCache } from 'lru-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
// TMDB and Cinemeta put an episode a day or two apart (time zones, a first airing elsewhere).
const MATCH_WINDOW_MS = 3 * DAY_MS;
// One more matched episode always outweighs any spread of dates within the window (up to 4320
// minutes an episode, so up to ~2 million episodes), and sums stay exact below 2^53.
const MATCH_WEIGHT = 1e10;
// Dates within the window, all pairs: a weekly show has about one per episode, a daily one seven.
// Thousands of episodes on one date would make millions; that show skips the date match instead
// (fillGaps still pairs it by position when both lists are as long, as with no dates at all).
const MAX_CANDIDATES = 200_000;

interface Ep { season: number; episode: number; date: number | null }
type Pair = [number, number];

function dateOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function byNumber(a: Ep, b: Ep): number {
  return a.season - b.season || a.episode - b.episode;
}

/**
 * The longest chain of date matches that keeps the order of both lists, the closest dates among
 * equally long chains. Pairs of indexes into `a` and `b`, in order.
 */
function chainByDate(a: Ep[], b: Ep[]): Pair[] {
  const byDate = b.map((ep, j) => ({ j, date: ep.date })).filter((x): x is { j: number; date: number } => x.date !== null)
    .sort((x, y) => x.date - y.date);
  const candidates: { i: number; j: number; w: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    const date = a[i].date;
    if (date === null) continue;
    let lo = 0;
    let hi = byDate.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byDate[mid].date < date - MATCH_WINDOW_MS) lo = mid + 1; else hi = mid;
    }
    for (let k = lo; k < byDate.length && byDate[k].date <= date + MATCH_WINDOW_MS; k++) {
      if (candidates.length >= MAX_CANDIDATES) return [];
      candidates.push({ i, j: byDate[k].j, w: MATCH_WEIGHT - Math.round(Math.abs(byDate[k].date - date) / 60000) });
    }
  }
  // Heaviest chain increasing in both i and j: by i, and within one i by j falling, so that one
  // episode of `a` can not chain to itself; a Fenwick tree keeps the best chain ending below each j.
  candidates.sort((x, y) => x.i - y.i || y.j - x.j);
  const size = b.length;
  const treeValue = new Float64Array(size + 1);
  const treeAt = new Int32Array(size + 1).fill(-1);
  const value = new Float64Array(candidates.length);
  const prev = new Int32Array(candidates.length).fill(-1);
  let best = -1;
  candidates.forEach((c, n) => {
    let v = 0;
    let at = -1;
    for (let k = c.j; k > 0; k -= k & -k) {
      if (treeValue[k] > v) { v = treeValue[k]; at = treeAt[k]; }
    }
    value[n] = v + c.w;
    prev[n] = at;
    for (let k = c.j + 1; k <= size; k += k & -k) {
      if (value[n] > treeValue[k]) { treeValue[k] = value[n]; treeAt[k] = n; }
    }
    if (best < 0 || value[n] > value[best]) best = n;
  });
  const chain: Pair[] = [];
  for (let n = best; n >= 0; n = prev[n]) chain.push([candidates[n].i, candidates[n].j]);
  return chain.reverse();
}

// How many matches a gap may reach across to even out (see fillGaps).
const MAX_ANCHORS_ACROSS = 3;

/**
 * Between two matches, and before the first or after the last, as many unmatched episodes on
 * both sides are the same episodes in the same order: their dates disagree, or one side has none.
 * A wrong date can also match an episode to its neighbour (two episodes aired the same day on one
 * side), leaving one gap short on one side and the next short on the other. Such a match is
 * dropped when the gaps around it even out, up to MAX_ANCHORS_ACROSS matches away, between two
 * real matches only: the ends of the lists hold no such evidence (a two-part premiere one side
 * and an extra undated episode in the other's tail even out too, and would shift every pair).
 */
function fillGaps(chain: Pair[], aLength: number, bLength: number): Pair[] {
  const anchors: Pair[] = [[-1, -1], ...chain, [aLength, bLength]];
  const last = anchors.length - 1;
  const filled: Pair[] = [];
  let k = 0;
  while (k < last) {
    const [i0, j0] = anchors[k];
    const reach = k === 0 ? k + 1 : Math.max(k + 1, Math.min(last - 1, k + 1 + MAX_ANCHORS_ACROSS));
    let t = k + 1;
    while (t <= reach && anchors[t][0] - i0 !== anchors[t][1] - j0) t++;
    if (t > reach) t = k + 1;
    else for (let d = 1; i0 + d < anchors[t][0]; d++) filled.push([i0 + d, j0 + d]);
    if (t < last) filled.push(anchors[t]);
    k = t;
  }
  return filled;
}

function episodesOf(videos: any[], season0: boolean): Ep[] {
  return videos
    .filter((v) => v && isNumber(v.season) && isNumber(v.episode) && (v.season === 0) === season0)
    .map((v) => ({ season: v.season, episode: v.episode, date: dateOf(v.released) }));
}

/** TMDB "season:episode" -> Cinemeta pair. */
export function cinemetaPairs(videos: any[], cinemetaVideos: any[]): Map<string, Pair> {
  const pairs = new Map<string, Pair>();
  const keep = (a: Ep[], b: Ep[], chain: Pair[]) => {
    for (const [i, j] of chain) pairs.set(`${a[i].season}:${a[i].episode}`, [b[j].season, b[j].episode]);
  };
  const regular = episodesOf(videos, false).sort(byNumber);
  const cinRegular = episodesOf(cinemetaVideos, false).sort(byNumber);
  keep(regular, cinRegular, fillGaps(chainByDate(regular, cinRegular), regular.length, cinRegular.length));
  const specials = episodesOf(videos, true);
  const cinSpecials = episodesOf(cinemetaVideos, true);
  keep(specials, cinSpecials, matchSpecials(specials, cinSpecials));
  return pairs;
}

/**
 * Specials have no order both sides share, and several often air the same day (Breaking Bad's
 * five webisodes, Doctor Who's Christmas episode with its Extra), where dates alone pair them
 * crosswise. A special pairs with one aired within the window that has its number (the two often
 * number specials alike), else with the only one in the window, when nothing else in the window
 * could take either. Anything less certain stays unpaired: a hidden special beats wrong streams.
 */
function matchSpecials(a: Ep[], b: Ep[]): Pair[] {
  const near = (x: Ep, y: Ep) => x.date !== null && y.date !== null && Math.abs(x.date - y.date) <= MATCH_WINDOW_MS;
  const result: Pair[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  a.forEach((x, i) => {
    const j = b.findIndex((y) => y.episode === x.episode && near(x, y));
    if (j >= 0) { result.push([i, j]); usedA.add(i); usedB.add(j); }
  });
  const open = (i: number) => b.map((_, j) => j).filter((j) => !usedB.has(j) && near(a[i], b[j]));
  a.forEach((x, i) => {
    if (usedA.has(i)) return;
    const js = open(i);
    if (js.length !== 1) return;
    const rivals = a.filter((y, k) => k !== i && !usedA.has(k) && near(y, b[js[0]]));
    if (rivals.length === 0) result.push([i, js[0]]);
  });
  return result;
}

/**
 * The videos of a series with its Cinemeta pairs and TMDB order; `imdbId` is the series' own.
 * Without a match an episode keeps the builder's id, unless that id names the Cinemeta episode
 * another episode was matched to (two videos would share an id, and streams would be the other
 * one's): it becomes tmdb:<tmdbId>:S:E. A Cinemeta number nobody took stays: it is often the same
 * episode, still undated or behind a placeholder. The builder's fallback for a season IMDb lacks
 * also drops the "tmdb:" of a TMDB id ("57041:11:1"); it gets it back.
 */
export function pairVideos(videos: any[], cinemetaVideos: any[], imdbId: string, tmdbId: string | null): any[] {
  const pairs = cinemetaPairs(videos, cinemetaVideos);
  const order = new Map<string, number>();
  episodesOf(videos, false).sort(byNumber).forEach((e, n) => order.set(`${e.season}:${e.episode}`, n + 1));
  const taken = new Set([...pairs.values()].map(([s, e]) => `${s}:${e}`));
  return videos.map((v) => {
    if (!v || !isNumber(v.season) || !isNumber(v.episode)) return v;
    const key = `${v.season}:${v.episode}`;
    const out: any = { ...v };
    const pair = pairs.get(key);
    if (pair) {
      out.id = `${imdbId}:${pair[0]}:${pair[1]}`;
      out.imdbSeason = pair[0];
      out.imdbEpisode = pair[1];
    } else if (typeof v.id === 'string' && /^\d+:\d+:\d+$/.test(v.id)) {
      out.id = `tmdb:${v.id}`;
    } else if (tmdbId && typeof v.id === 'string' && v.id.startsWith(`${imdbId}:`) && taken.has(v.id.slice(imdbId.length + 1))) {
      out.id = `tmdb:${tmdbId}:${v.season}:${v.episode}`;
    }
    const n = order.get(key);
    if (n !== undefined) out.absoluteEpisode = n;
    return out;
  });
}

// Cinemeta that has not answered by then counts as not answering (imdbPairs: false); the fetch
// goes on and fills the cache for the next request. A day-old entry is the usual miss, while
// the meta itself is cached for a week.
const DEFAULT_WAIT_MS = 3000;
// The global cache keeps no failure: a title Cinemeta does not know (v3 answers 307, which the
// client takes for an error) would be asked for on every open of its card. Held here for an hour.
const unknown = new LRUCache<string, true>({ max: 5000, ttl: 60 * 60 * 1000 });

function imdbIdOf(meta: any): string | null {
  if (!meta || meta.type !== 'series' || meta._metaProvider !== 'tmdb' || !Array.isArray(meta.videos) || !meta.videos.length) return null;
  return typeof meta.imdb_id === 'string' && /^tt\d+$/.test(meta.imdb_id) ? meta.imdb_id : null;
}

/**
 * Looks up Cinemeta for the metas that take pairs (series built from TMDB, with an IMDb id) and
 * returns what puts the pairs on: imdbPairs, and the videos renumbered when Cinemeta answered.
 * Cinemeta comes through the addon's global cache (a day), as the series builder asks for it.
 */
export async function lookUpCinemetaPairs(
  metas: any[],
  fetchCinemeta: (imdbId: string) => Promise<any>,
  waitMs = envWait(),
): Promise<(metas: any[]) => any[]> {
  const found = new Map<string, any>();
  await Promise.all([...new Set(metas.map(imdbIdOf).filter((id): id is string => id !== null))].map(async (imdbId) => {
    if (unknown.has(imdbId)) {
      found.set(imdbId, null);
      return;
    }
    // A late answer still counts for the next request: a failure is remembered when it comes.
    const asked = Promise.resolve().then(() => fetchCinemeta(imdbId)).then(
      (cinemeta) => { if (!cinemeta || !Array.isArray(cinemeta.videos)) unknown.set(imdbId, true); return cinemeta; },
      () => { unknown.set(imdbId, true); return null; },
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, waitMs, null); });
    try {
      found.set(imdbId, await Promise.race([asked, late]));
    } finally {
      clearTimeout(timer);
    }
  }));
  return (list) => list.map((meta) => {
    const imdbId = imdbIdOf(meta);
    if (!imdbId || !found.has(imdbId)) return meta;
    const cinemeta = found.get(imdbId);
    if (!cinemeta || !Array.isArray(cinemeta.videos)) return { ...meta, imdbPairs: false };
    const tmdbId = typeof meta._tmdbId === 'string' && /^\d+$/.test(meta._tmdbId) ? meta._tmdbId : null;
    return { ...meta, imdbPairs: true, videos: pairVideos(meta.videos, cinemeta.videos, imdbId, tmdbId) };
  });
}

function envWait(): number {
  const n = Number.parseInt(process.env.CINEMETA_PAIRS_WAIT_MS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

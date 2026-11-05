// TMDB tells е from ё, and Russian titles are typed either way: "елки" misses "Ёлки 2".

/** The other spellings to ask TMDB for too: every ё as е, then one е as ё at a time; three at most. */
export function yoVariants(query: string): string[] {
  const variants = new Set<string>();
  if (/[ёЁ]/.test(query)) variants.add(query.replace(/ё/g, 'е').replace(/Ё/g, 'Е'));
  for (let i = 0; i < query.length; i++) {
    if (query[i] === 'е' || query[i] === 'Е') {
      variants.add(query.slice(0, i) + (query[i] === 'е' ? 'ё' : 'Ё') + query.slice(i + 1));
    }
  }
  return Array.from(variants).slice(0, 3);
}

/**
 * How many of the sorted results of a search page are hydrated; each costs a TMDB details
 * call, the ids and an IMDb rating, then Kino API and the logo languages. Upstream keeps 25
 * of one TMDB page of 20. A spelling brings up to 20 more; past the first page's 20 they are
 * titles that passed the filter, so the cut only stops three full spellings at 45 of 80:
 * on 08.11.2026 common words gave 31-39 ("звезды", "все"), a real pair 23 ("ёлки", "елки").
 */
export function hydrationLimit(variants: readonly string[]): number {
  return Math.min(25 + 20 * variants.length, 45);
}

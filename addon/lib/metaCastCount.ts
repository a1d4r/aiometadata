/**
 * The meta route's own cut of the cast. The cached meta keeps the whole cast and
 * `castCount` cuts it on the way out, for catalog rows and the meta alike;
 * META_CAST_COUNT lets the title page show more without fattening every row.
 * Unset or invalid — the meta follows castCount.
 */
export function withMetaCastCount<T extends { castCount?: number }>(config: T): T {
  const value = Number(process.env.META_CAST_COUNT);
  if (!config || process.env.META_CAST_COUNT === undefined || process.env.META_CAST_COUNT === '' || !Number.isInteger(value) || value < 0) return config;
  return { ...config, castCount: value };
}

/** 涨跌停区间（规范 P5/P6 §8.4）。unknown 或昨收缺失时不出建议。 */

export type PriceLimitType = 'main_10' | 'gem_20' | 'star_20' | 'bse_30' | 'st_5' | 'custom' | 'unknown'

export const LIMIT_PCT: Record<Exclude<PriceLimitType, 'custom' | 'unknown'>, number> = {
  main_10: 10,
  gem_20: 20,
  star_20: 20,
  bse_30: 30,
  st_5: 5,
}

export interface LimitRange {
  upCents: number
  downCents: number
  pct: number
}

function roundHalfUp(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n + 1e-9)
}

/** 昨收（分） + 类型 → 涨停/跌停（分）。 */
export function limitRange(
  lastCloseCents: number | null,
  type: PriceLimitType,
  customPct?: number | null,
): LimitRange | null {
  if (type === 'unknown' || !lastCloseCents || lastCloseCents <= 0) return null
  const pct = type === 'custom' ? customPct : LIMIT_PCT[type]
  if (pct === null || pct === undefined || !Number.isFinite(pct) || pct <= 0) return null
  return {
    upCents: roundHalfUp((lastCloseCents * (100 + pct)) / 100),
    downCents: roundHalfUp((lastCloseCents * (100 - pct)) / 100),
    pct,
  }
}

export function inRange(priceCents: number, range: LimitRange | null): boolean {
  if (!range) return false
  return priceCents >= range.downCents && priceCents <= range.upCents
}

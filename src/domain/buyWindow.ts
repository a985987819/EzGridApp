import { inRange, type LimitRange } from './limit'
import type { Lot } from './types'

export interface BuyWindow {
  /** 当前股票仍有未卖份额的最低实际买入成本，含回补/沙盒预览批次。 */
  referenceCents: number | null
  /** 最低持仓成本减股票间隔；仅作价格参考，不凭空生成订单或库存。 */
  nextGridCents: number | null
  marketRange: LimitRange | null
  /** 日内涨跌停与严格低于最低成本的交集；缺区间或无交集时不推荐。 */
  todayRange: { downCents: number; upCents: number } | null
}

export function buildBuyWindow(opts: {
  lots: readonly Lot[]
  stockName: string
  intervalCents: number | null | undefined
  range: LimitRange | null
}): BuyWindow {
  let referenceCents: number | null = null
  for (const lot of opts.lots) {
    if (lot.stockName !== opts.stockName || lot.remainingQty <= 0 || !Number.isSafeInteger(lot.buyPriceCents) || lot.buyPriceCents <= 0) continue
    referenceCents = referenceCents === null ? lot.buyPriceCents : Math.min(referenceCents, lot.buyPriceCents)
  }
  const interval = opts.intervalCents
  const next = referenceCents !== null && interval != null && Number.isSafeInteger(interval) && interval > 0
    ? referenceCents - interval : null
  const range = opts.range
  const upper = range ? Math.min(range.upCents, referenceCents === null ? range.upCents : referenceCents - 1) : null
  return {
    referenceCents,
    nextGridCents: next !== null && next > 0 ? next : null,
    marketRange: range,
    todayRange: range && upper !== null && upper >= range.downCents
      ? { downCents: range.downCents, upCents: upper } : null,
  }
}

/** 在所有改单/合并之后筛选最终展示价格；保留来源和顺序，不修改账务输入。 */
export function selectBuyWindow<T extends { priceCents: number }>(rows: readonly T[], window: BuyWindow): {
  today: T[]; outside: T[]; excluded: T[]
} {
  const today: T[] = [], outside: T[] = [], excluded: T[] = []
  for (const row of rows) {
    if (window.referenceCents !== null && row.priceCents >= window.referenceCents) excluded.push(row)
    else if (window.marketRange) (inRange(row.priceCents, window.marketRange) ? today : outside).push(row)
  }
  return { today, outside, excluded }
}

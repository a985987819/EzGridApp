/**
 * 规划用钱（2026-11-03）——管理页回答「这笔钱现在买哪只、能买多少、值不值博」。
 *
 * 纯派生、无 IO、无 React。三条口径：
 * - planPurchase：A 股主板一手 100 股，按整手向下取整；金额/价格全部整数分，
 *   资金不足一手时买 0 股并给出剩余金额，不凑零股。
 * - valuationAnchors：估值快照（domain/valuation）窗口内收盘价的 P20 / P50（中位）/
 *   P80 分位价（线性插值后取整分），作为值博率的上看目标与认错线。
 * - valueRatio：**值博率 =（中位价 − 现价）÷（现价 − P20 价）**——上看 5 年中位、
 *   下破 P20 认错；≥2 值博 / 1–2 一般 / <1 偏低；现价 ≤ P20 时风险线失真
 *   （分母趋零），直接标「优 · 已到 P20 下方」不报数值；现价 ≥ 中位说明已无
 *   「向中位回归」的空间，标「低 · 已在中位上方」。这只回答「位置上的赔率」，
 *   不预测方向、不构成买卖指令。
 */
import type { ValuationDay } from './valuation'

/** A 股主板一手股数 */
export const LOT_SIZE = 100

export interface PurchasePlan {
  /** 整手取整后的股数（LOT_SIZE 的倍数，可能为 0） */
  shares: number
  /** 需要金额（分） */
  costCents: number
  /** 剩余金额（分） */
  remainingCents: number
}

export function planPurchase(moneyCents: number | null, priceCents: number | null): PurchasePlan | null {
  if (moneyCents == null || !Number.isFinite(moneyCents) || moneyCents <= 0) return null
  if (priceCents == null || !Number.isFinite(priceCents) || priceCents <= 0) return null
  const shares = Math.floor(moneyCents / priceCents / LOT_SIZE) * LOT_SIZE
  const costCents = shares * priceCents
  return { shares, costCents, remainingCents: moneyCents - costCents }
}

export interface ValuationAnchors {
  p20Cents: number
  p50Cents: number
  p80Cents: number
}

const quantile = (sorted: readonly number[], q: number): number => {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/** 收盘价序列的 P20/P50/P80（分）；无有效数据返回 null */
export function valuationAnchors(days: readonly ValuationDay[]): ValuationAnchors | null {
  const closes = days.map((d) => d[1]).filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b)
  if (closes.length === 0) return null
  return {
    p20Cents: Math.round(quantile(closes, 0.2)),
    p50Cents: Math.round(quantile(closes, 0.5)),
    p80Cents: Math.round(quantile(closes, 0.8)),
  }
}

export type ValueLevel = 'high' | 'mid' | 'low'

export interface ValueBet {
  /** 值博率数值；null = 比率不可表达（已到 P20 下方 / 已过中位 / 无现价），看 label */
  ratio: number | null
  level: ValueLevel
  label: string
}

export function valueRatio(anchors: ValuationAnchors, priceCents: number | null): ValueBet {
  const { p20Cents, p50Cents } = anchors
  if (priceCents == null || !Number.isFinite(priceCents) || priceCents <= 0) {
    return { ratio: null, level: 'mid', label: '无现价' }
  }
  if (priceCents <= p20Cents) return { ratio: null, level: 'high', label: '优 · 已到 P20 下方' }
  if (priceCents >= p50Cents) return { ratio: null, level: 'low', label: '低 · 已在中位上方' }
  const ratio = Math.round(((p50Cents - priceCents) / (priceCents - p20Cents)) * 100) / 100
  return {
    ratio,
    level: ratio >= 2 ? 'high' : ratio >= 1 ? 'mid' : 'low',
    label: ratio >= 2 ? '值博' : ratio >= 1 ? '一般' : '偏低',
  }
}

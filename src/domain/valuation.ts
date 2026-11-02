/**
 * 估值温度带（2026-11-03）——概览页回答「当前股价 / PE / PB 在近 5 年里处于什么位置」。
 *
 * 数据来自 scripts/fetchValuation.mjs 抓取的静态快照（src/domain/valuationData.json，
 * `npm run refresh-valuation` 重新生成）。快照以构建期内联的方式懒加载，无运行时网络请求；
 * 页面副标题必须展示 asOf，过期数据靠刷新快照而不是运行时抓取。
 *
 * 口径（docs/估值温度带.md）：
 * - 股价百分位 = 快照窗口内「收盘 < 现价」的交易日占比（**严格小于**）。收盘为前复权价，
 *   今日收盘点 = 真实价，所以直接拿昨收（整数分）比较是成立的。
 * - PE/PB 现值 = 快照最后一天的值 ×（现价 / 快照最后收盘）：EPS/BPS 在两次刷新之间不变的
 *   假设。**除权除息后必须重跑 refresh-valuation**——前复权整条序列会被重定基，不刷新则
 *   百分位与估算都失真。
 * - PE/PB 百分位只在「正值基准」上算：亏损期 PE 为负没有比较意义（安道麦 5 年里 765 天
 *   亏损）。快照最后一天 PE/PB 非正 → 该指标失效（`peLoss/pbLoss`），界面显示「亏损 · 失效」
 *   不画针；缺失（null）→ 同样不画针但不标亏损。
 * - 分区：<20 极冷·低位 / <40 偏冷·低位 / <60 中性 / <80 偏热·高位 / ≥80 过热·高位。
 */

/** 一个交易日：[YYYY-MM-DD, 前复权收盘分, PE-TTM|null（亏损期为负值）, PB-MRQ|null] */
export type ValuationDay = readonly [string, number, number | null, number | null]

export interface ValuationStockSnapshot {
  code: string
  days: readonly ValuationDay[]
}

export interface ValuationFile {
  asOf: string
  source: string
  stocks: Record<string, ValuationStockSnapshot>
}

export interface ValuationBand {
  /** 股价百分位（0–100，一位小数由界面取整） */
  pricePct: number | null
  pePct: number | null
  pbPct: number | null
  /** 按现价缩放后的 PE / PB 估算值（快照末值 × 现价/快照末收盘） */
  peEst: number | null
  pbEst: number | null
  /** 快照末值非正 = 亏损 → 指标失效（区别于数据缺失） */
  peLoss: boolean
  pbLoss: boolean
}

const EMPTY_BAND: ValuationBand = {
  pricePct: null,
  pePct: null,
  pbPct: null,
  peEst: null,
  pbEst: null,
  peLoss: false,
  pbLoss: false,
}

/** 严格小于口径的百分位（0–100）；空序列或非法值返回 null */
export function percentileBelow(series: readonly number[], value: number): number | null {
  if (series.length === 0 || !Number.isFinite(value)) return null
  let below = 0
  for (const v of series) if (v < value) below += 1
  return (below / series.length) * 100
}

/** 百分位 → 温度分区文案 */
export function valuationZone(pct: number | null): string {
  if (pct == null) return '无数据'
  if (pct < 20) return '极冷·低位'
  if (pct < 40) return '偏冷·低位'
  if (pct < 60) return '中性'
  if (pct < 80) return '偏热·高位'
  return '过热·高位'
}

/**
 * 一条估值温度带：现价（昨收分）对照快照窗口。
 * 现价缺失/非法时只有股价百分位为 null，PE/PB 仍按快照末收盘给出（缩放比为 1）。
 */
export function computeValuationBand(days: readonly ValuationDay[], priceCents: number | null): ValuationBand {
  if (days.length === 0) return EMPTY_BAND
  const closes = days.map((d) => d[1])
  const pricePct = priceCents != null && priceCents > 0 ? percentileBelow(closes, priceCents) : null
  const last = days[days.length - 1]
  const closeLast = last[1]
  if (!(closeLast > 0)) return { ...EMPTY_BAND, pricePct }
  const ratio = priceCents != null && priceCents > 0 ? priceCents / closeLast : 1
  const scale = (v: number | null) => (v == null ? null : Math.round(v * ratio * 100) / 100)
  const peEst = scale(last[2])
  const pbEst = scale(last[3])
  const peLoss = last[2] != null && last[2] <= 0
  const pbLoss = last[3] != null && last[3] <= 0
  const positiveBasisPct = (lastValue: number | null, pick: (d: ValuationDay) => number | null): number | null => {
    if (lastValue == null || !(lastValue > 0)) return null
    const basis: number[] = []
    for (const d of days) {
      const v = pick(d)
      if (v != null && v > 0) basis.push(v)
    }
    return percentileBelow(basis, lastValue)
  }
  return {
    pricePct,
    pePct: positiveBasisPct(peEst, (d) => d[2]),
    pbPct: positiveBasisPct(pbEst, (d) => d[3]),
    peEst,
    pbEst,
    peLoss,
    pbLoss,
  }
}

/**
 * 快照懒加载：动态 import('?raw') 生成独立 chunk（147KB 左右），PWA 预缓存、离线可用。
 * ?raw + JSON.parse 而不是直接 import json——避免 tsc 对 147KB 字面量做类型推导。
 */
let valuationReady: Promise<ValuationFile> | null = null
export function loadValuationData(): Promise<ValuationFile> {
  valuationReady ??= import('./valuationData.json?raw').then((m) => JSON.parse(m.default) as ValuationFile)
  return valuationReady
}

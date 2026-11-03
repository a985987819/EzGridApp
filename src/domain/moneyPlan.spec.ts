import { describe, expect, it } from 'vitest'
import type { ValuationDay } from './valuation'
import { planPurchase, valuationAnchors, valueRatio } from './moneyPlan'

/** 收盘 [1000..1400] 分的 5 天快照 */
const DAYS: readonly ValuationDay[] = [
  ['2021-11-01', 1000, 40, 2.0],
  ['2021-11-02', 1100, 36, 1.8],
  ['2021-11-03', 1200, 30, 1.5],
  ['2021-11-04', 1300, -25, 1.2],
  ['2021-11-05', 1400, 20, 1.0],
]

describe('planPurchase 整手规划', () => {
  it('按 100 股一手向下取整，金额与剩余分毫不差', () => {
    // ¥10,400 买 ¥8.00 → 1300 股（13 手）全花完
    expect(planPurchase(1040000, 800)).toEqual({ shares: 1300, costCents: 1040000, remainingCents: 0 })
    // ¥10,500 → 还是 1300 股，剩 ¥100
    expect(planPurchase(1050000, 800)).toEqual({ shares: 1300, costCents: 1040000, remainingCents: 10000 })
  })
  it('资金不足一手买 0 股，不凑零股', () => {
    expect(planPurchase(79900, 800)).toEqual({ shares: 0, costCents: 0, remainingCents: 79900 })
  })
  it('无资金或无现价返回 null', () => {
    expect(planPurchase(null, 800)).toBeNull()
    expect(planPurchase(1040000, null)).toBeNull()
    expect(planPurchase(0, 800)).toBeNull()
    expect(planPurchase(1040000, -1)).toBeNull()
  })
})

describe('valuationAnchors 分位锚点', () => {
  it('P20/P50/P80 线性插值后取整分', () => {
    // i = (5-1)*q：P20 → 0.8 → 1000+80=1080；P50 → 2 → 1200；P80 → 3.2 → 1320
    expect(valuationAnchors(DAYS)).toEqual({ p20Cents: 1080, p50Cents: 1200, p80Cents: 1320 })
  })
  it('空数据返回 null，负收盘（若有脏数据）不参与', () => {
    expect(valuationAnchors([])).toBeNull()
    expect(valuationAnchors([['2021-11-01', 0, 1, 1], ['2021-11-02', -5, 1, 1]])).toBeNull()
  })
})

describe('valueRatio 值博率分区', () => {
  const anchors = valuationAnchors(DAYS)!
  it('比值博率 =（中位−现价）÷（现价−P20），≥2 值博', () => {
    // (1200-1100)/(1100-1080) = 5
    expect(valueRatio(anchors, 1100)).toEqual({ ratio: 5, level: 'high', label: '值博' })
  })
  it('1–2 一般，<1 偏低', () => {
    // (1200-1150)/(1150-1080) = 50/70 ≈ 0.71
    expect(valueRatio(anchors, 1150).label).toBe('偏低')
    // (1200-1120)/(1120-1080) = 80/40 = 2 → 值博
    expect(valueRatio(anchors, 1120).label).toBe('值博')
    // (1200-1160)/(1160-1080) = 40/80 = 0.5 → mid/low 边界之上取偏低？0.5 <1 → 偏低
    expect(valueRatio(anchors, 1160).level).toBe('low')
  })
  it('现价 ≤ P20 标「优」不报数值，≥ 中位标「低」不报数值', () => {
    const low = valueRatio(anchors, 1080)
    expect(low).toEqual({ ratio: null, level: 'high', label: '优 · 已到 P20 下方' })
    const high = valueRatio(anchors, 1200)
    expect(high).toEqual({ ratio: null, level: 'low', label: '低 · 已在中位上方' })
    expect(valueRatio(anchors, 1400).label).toBe('低 · 已在中位上方')
  })
  it('无现价返回无数据', () => {
    expect(valueRatio(anchors, null)).toEqual({ ratio: null, level: 'mid', label: '无现价' })
  })
})

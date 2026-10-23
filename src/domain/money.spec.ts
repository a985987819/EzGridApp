import { describe, expect, it } from 'vitest'
import { centsToYuan, formatMoney, mulCents, roundHalfUp, toCents } from './money'
import { deriveBuyQty, floorToHundred, handsFromBudget, isHundredMultiple } from './qty'
import { limitRange } from './limit'

describe('精度内核：整数分往返（S1 验收）', () => {
  it('7.81 → 781 → 7.81 无损', () => {
    expect(toCents('7.81')).toBe(781)
    expect(centsToYuan(781)).toBe('7.81')
  })

  it('781 × 100 = 78,100', () => {
    expect(mulCents(781, 100)).toBe(78100)
  })

  it('floor(99,500 / 78,100) = 1 手', () => {
    expect(handsFromBudget(99500, 78100)).toBe(1)
  })

  it('浮点陷阱：0.1 + 0.2 那套不许出现', () => {
    expect((toCents('0.1') ?? 0) + (toCents('0.2') ?? 0)).toBe(30)
    expect(toCents('6.331')).toBe(633)
    expect(toCents('8.005')).toBe(801)
    expect(toCents('¥1,234.50')).toBe(123450)
    expect(toCents('abc')).toBeNull()
    expect(toCents('')).toBeNull()
  })

  it('金额格式化', () => {
    expect(formatMoney(983100)).toBe('9,831.00')
    expect(formatMoney(-2000)).toBe('-20.00')
    expect(formatMoney(20228400)).toBe('202,284.00')
  })

  it('ROUND_HALF_UP', () => {
    expect(roundHalfUp(1000.5)).toBe(1001)
    expect(roundHalfUp(999.4)).toBe(999)
  })
})

describe('数量内核', () => {
  it('FLOOR(6000/11.48, 100) = 500', () => {
    expect(deriveBuyQty(1148)).toBe(500)
  })
  it('FLOOR(6000/18.81, 100) = 300', () => {
    expect(deriveBuyQty(1881)).toBe(300)
  })
  it('FLOOR(6000/7.81, 100) = 700（该行 Excel 手填 1000，以明细为准）', () => {
    expect(deriveBuyQty(781)).toBe(700)
  })
  it('整手判定', () => {
    expect(floorToHundred(15200)).toBe(15200)
    expect(floorToHundred(15299)).toBe(15200)
    expect(isHundredMultiple(100)).toBe(true)
    expect(isHundredMultiple(150)).toBe(false)
  })
})

describe('涨跌停区间（P5/P6）', () => {
  it('昨收 10.00 主板 → 9.00 / 11.00', () => {
    expect(limitRange(1000, 'main_10')).toEqual({ upCents: 1100, downCents: 900, pct: 10 })
  })
  it('创业板 20%', () => {
    expect(limitRange(1000, 'gem_20')).toEqual({ upCents: 1200, downCents: 800, pct: 20 })
  })
  it('四舍五入到分：昨收 8.13 主板 → 8.94 / 7.32', () => {
    const r = limitRange(813, 'main_10')!
    expect(r.upCents).toBe(894)
    expect(r.downCents).toBe(732)
  })
  it('unknown / 缺昨收 → 不出建议', () => {
    expect(limitRange(1000, 'unknown')).toBeNull()
    expect(limitRange(null, 'main_10')).toBeNull()
  })
  it('自定义比例', () => {
    expect(limitRange(1000, 'custom', 7)).toEqual({ upCents: 1070, downCents: 930, pct: 7 })
  })
})

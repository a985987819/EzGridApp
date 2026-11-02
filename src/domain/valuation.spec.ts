import { describe, expect, it } from 'vitest'
import { computeValuationBand, percentileBelow, valuationZone, type ValuationDay, type ValuationFile } from './valuation'
import rawSnapshot from './valuationData.json?raw'

/** 合成快照：5 天，收盘 1000~1400 分；第 4 天 PE 为负（亏损期） */
const DAYS: readonly ValuationDay[] = [
  ['2021-11-01', 1000, 40, 2.0],
  ['2021-11-02', 1100, 36, 1.8],
  ['2021-11-03', 1200, 30, 1.5],
  ['2021-11-04', 1300, -25, 1.2],
  ['2021-11-05', 1400, 20, 1.0],
]

describe('percentileBelow 严格小于口径', () => {
  it('低于一半计一半，恰好相等不计入', () => {
    expect(percentileBelow([1, 2, 3], 2)).toBeCloseTo(100 / 3)
    expect(percentileBelow([1, 2, 3], 3)).toBeCloseTo(200 / 3)
  })
  it('边界：低于全部为 0，高于全部为 100，空序列与非法值为 null', () => {
    expect(percentileBelow([1, 2, 3], 0)).toBe(0)
    expect(percentileBelow([1, 2, 3], 9)).toBe(100)
    expect(percentileBelow([], 5)).toBeNull()
    expect(percentileBelow([1], Number.NaN)).toBeNull()
  })
})

describe('computeValuationBand', () => {
  it('股价百分位按收盘序列与现价（分）比较', () => {
    // 1100 分 = 有 1 天（1000）严格低于它 → 20%
    expect(computeValuationBand(DAYS, 1100).pricePct).toBeCloseTo(20)
    expect(computeValuationBand(DAYS, 900).pricePct).toBe(0)
    expect(computeValuationBand(DAYS, 1500).pricePct).toBe(100)
  })

  it('PE/PB 现值按现价/快照末收盘缩放，百分位只在正值基准上算', () => {
    const band = computeValuationBand(DAYS, 1400) // 与快照末收盘同价 → 缩放比 1
    expect(band.peEst).toBe(20)
    expect(band.pbEst).toBe(1.0)
    // 正 PE 基准 = [40,36,30,20]（-25 被剔除），20 分位 = 0%
    expect(band.pePct).toBe(0)
    expect(band.peLoss).toBe(false)
    // 正 PB 基准 = [2.0,1.8,1.5,1.2,1.0]，1.0 → 0%
    expect(band.pbPct).toBe(0)
  })

  it('现价高于快照收盘时 PE/PB 等比例放大', () => {
    const band = computeValuationBand(DAYS, 2800) // 2800/1400 = 2 倍
    expect(band.peEst).toBe(40)
    expect(band.pbEst).toBe(2.0)
    // 40 在正 PE 基准 [40,36,30,20] 里严格小于它的有 3 个（36/30/20）→ 75%
    expect(band.pePct).toBe(75)
  })

  it('快照末 PE 非正 → 亏损失效（pePct null + peLoss），负值天不进基准', () => {
    const lossDays: readonly ValuationDay[] = [
      ['2021-11-01', 1000, 30, 1.5],
      ['2021-11-02', 1100, -10, 1.4],
      ['2021-11-03', 1200, -12, 1.3],
    ]
    const band = computeValuationBand(lossDays, 1100)
    expect(band.peLoss).toBe(true)
    expect(band.pePct).toBeNull()
    expect(band.pricePct).not.toBeNull() // 其它指标不受影响
  })

  it('快照末 PE 缺失（null）→ 不画针但不标亏损', () => {
    const missing: readonly ValuationDay[] = [['2021-11-01', 1000, null, 1.0]]
    const band = computeValuationBand(missing, 1000)
    expect(band.pePct).toBeNull()
    expect(band.peEst).toBeNull()
    expect(band.peLoss).toBe(false)
  })

  it('现价缺失时股价百分位为 null，PE/PB 按缩放比 1 给出', () => {
    const band = computeValuationBand(DAYS, null)
    expect(band.pricePct).toBeNull()
    expect(band.peEst).toBe(20)
    expect(band.pbEst).toBe(1.0)
  })

  it('空快照全部为 null', () => {
    expect(computeValuationBand([], 1000).pricePct).toBeNull()
  })
})

describe('valuationZone 分区', () => {
  it('20/40/60/80 分界', () => {
    expect(valuationZone(0)).toBe('极冷·低位')
    expect(valuationZone(19.9)).toBe('极冷·低位')
    expect(valuationZone(20)).toBe('偏冷·低位')
    expect(valuationZone(40)).toBe('中性')
    expect(valuationZone(60)).toBe('偏热·高位')
    expect(valuationZone(80)).toBe('过热·高位')
    expect(valuationZone(null)).toBe('无数据')
  })
})

describe('真实快照（valuationData.json）一致性', () => {
  const snapshot = JSON.parse(rawSnapshot) as ValuationFile

  it('四只股票都在且日期升序、窗口超过 1000 个交易日', () => {
    for (const name of ['柳工', '三一重工', '奥佳华', '安道麦']) {
      const stock = snapshot.stocks[name]
      expect(stock, `${name} 缺失`).toBeTruthy()
      expect(stock.days.length).toBeGreaterThan(1000)
      for (let i = 1; i < stock.days.length; i++) {
        expect(stock.days[i][0] > stock.days[i - 1][0], `${name} 日期乱序 @${i}`).toBe(true)
        expect(stock.days[i][1]).toBeGreaterThan(0)
      }
    }
    expect(snapshot.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('每股股价百分位与暴力重算一致，收盘分是整数', () => {
    for (const stock of Object.values(snapshot.stocks)) {
      const last = stock.days[stock.days.length - 1]
      const band = computeValuationBand(stock.days, last[1])
      const brute = (stock.days.filter((d) => d[1] < last[1]).length / stock.days.length) * 100
      expect(band.pricePct).toBeCloseTo(brute, 8)
      expect(Number.isInteger(last[1])).toBe(true)
    }
  })

  it('亏损股 PE 失效、盈利股 PE 有百分位，快照末 PE 与收盘缩放自洽', () => {
    const liugong = computeValuationBand(snapshot.stocks['柳工'].days, snapshot.stocks['柳工'].days.at(-1)![1])
    expect(liugong.peLoss).toBe(false)
    expect(liugong.pePct).not.toBeNull()
    const adama = computeValuationBand(snapshot.stocks['安道麦'].days, snapshot.stocks['安道麦'].days.at(-1)![1])
    expect(adama.peLoss).toBe(true)
    expect(adama.pePct).toBeNull()
    expect(adama.pbPct).not.toBeNull() // 亏损期仍能给 PB 参考位
  })
})

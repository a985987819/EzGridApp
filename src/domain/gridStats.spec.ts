import { describe, expect, it } from 'vitest'
import { buildGridStats } from './gridStats'
import type { Lot, SellExecution } from './types'

const lot = (id: string, stock: string, price: number, qty: number, remaining: number, buyDate?: string | null): Lot => ({
  id,
  sourceRow: 1,
  stockId: `stock:${stock}`,
  stockName: stock,
  buyDate: buyDate ?? null,
  buyPriceCents: price,
  qty,
  soldQty: qty - remaining,
  remainingQty: remaining,
  targetPriceCents: null,
  needsPrice: false,
  importKey: 'k' + id,
})

const sell = (id: string, lotId: string | null, profit: number | null, soldAt: string | null): SellExecution => ({
  id,
  sourceRow: 1,
  stockId: 'stock:T',
  stockName: 'T',
  qty: 100,
  priceCents: 800,
  costCents: 500,
  profitCents: profit,
  soldAt,
  dateMissing: false,
  priceSource: 'target',
  rebuyStatus: 'repaid',
  rebuyPriceCents: null,
  ownLotCoverQty: 0,
  sellBeforeBuy: false,
  groupKey: 'k',
  costComplete: true,
  lotId,
  targetId: null,
})

describe('网格进行度统计', () => {
  it('完成轮次按「已卖光批次」计数，虚拟回补批次一样算；进行中不算完成', () => {
    const lots = [
      lot('lot:2', 'T', 500, 700, 0),        // 卖光 → 完成
      lot('lot:exec:e', 'T', 500, 700, 0),   // 回补虚拟批次也卖光 → 完成
      lot('lot:3', 'T', 500, 700, 300),      // 还有持仓 → 进行中
      lot('lot:4', 'T', 600, 700, 700),      // 没卖过 → 进行中
      lot('lot:5', 'T', 700, 0, 0),          // qty 0 不算
    ]
    const p = buildGridStats(lots, [])
    expect(p.doneRounds).toBe(2)
    expect(p.activeRounds).toBe(2)
    expect(p.levels).toHaveLength(2) // 500 与 600 两个价位
    expect(p.hotTop?.priceCents).toBe(500)
  })

  it('点位盈利 = 该批次自身卖出盈利合计；裸卖与无批次卖出不参与', () => {
    const lots = [lot('lot:2', 'T', 500, 700, 0), lot('lot:3', 'T', 600, 700, 200)]
    const sells = [
      sell('s1', 'lot:2', 150000, null),
      sell('s2', 'lot:2', 30000, null),     // 同批次两笔，相加
      sell('s3', 'lot:3', -10000, null),    // 部分卖出亏损，计入点位盈利
      sell('s4', null, 999999, null),       // 裸卖不进点位
    ]
    const p = buildGridStats(lots, sells)
    const [l500, l600] = p.levels
    expect(l500.profitCents).toBe(180000)
    expect(l600.profitCents).toBe(-10000)
    expect(p.realizedCents).toBe(170000)
    // 每轮均盈只算完成批次的盈利：500 那轮的 180000 / 1
    expect(p.avgProfitCents).toBe(180000)
  })

  it('排名：完成次数降序，其次盈利降序、价位升序', () => {
    const lots = [
      lot('lot:2', 'A', 500, 100, 0),
      lot('lot:3', 'A', 500, 100, 0),
      lot('lot:4', 'A', 800, 100, 0),
      lot('lot:5', 'B', 600, 100, 0),
    ]
    const sells = [
      sell('s1', 'lot:2', 10000, null),
      sell('s2', 'lot:3', 5000, null),
      sell('s3', 'lot:4', 99999, null),
      sell('s4', 'lot:5', 0, null),
    ]
    const p = buildGridStats(lots, sells)
    expect(p.levels.map((l) => `${l.stockName}:${l.priceCents}`)).toEqual(['A:500', 'A:800', 'B:600'])
  })

  it('平均持仓天数 = 买入日到最后一笔卖出日；缺日期不进平均', () => {
    const lots = [
      lot('lot:2', 'T', 500, 700, 0, '2026-01-01'),
      lot('lot:3', 'T', 600, 700, 0, null),   // 无买入日，不进平均
    ]
    const sells = [
      sell('s1', 'lot:2', 100, '2026-01-11'),
      sell('s2', 'lot:2', 100, '2026-01-06'), // 两笔取最晚
      sell('s3', 'lot:3', 100, '2026-02-01'),
    ]
    const p = buildGridStats(lots, sells)
    expect(p.avgHoldingDays).toBe(10)
  })

  it('空数据全部归零，不出热点位', () => {
    const p = buildGridStats([], [])
    expect(p).toMatchObject({ doneRounds: 0, activeRounds: 0, realizedCents: 0, avgProfitCents: null, avgHoldingDays: null, hotTop: null })
    expect(p.levels).toEqual([])
  })
})

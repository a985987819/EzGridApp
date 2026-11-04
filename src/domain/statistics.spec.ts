import { describe, expect, it } from 'vitest'
import type { BookingReceipt } from './booking'
import { isoToSerial } from './edit'
import { buildLedger } from './ledger'
import { buildTradingStatistics } from './statistics'
import type { ExtraTarget, RawRecord, RebuyExecution, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const serial = (date: string) => isoToSerial(date)!
const row = (sourceRow: number, patch: Partial<RawRecord>): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null,
  qtyNeedsDerive: false, targetPriceCents: null, targetNeedsDerive: false, soldQty: 0,
  sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `stats:${sourceRow}`, ...patch,
})
const high = row(2, { buyDateSerial: serial('2026-01-01'), buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 1200 })
const root = row(3, { sellDateSerial: serial('2026-01-15'), targetPriceCents: 700, soldQty: 500, earlyBuyPriceCents: 500 })
const execution = (id: string, sellRow: number, qty: number, priceCents: number, date: string, rewardQty = 0): RebuyExecution => ({
  id, orderId: `rb:sell:${sellRow}`, sellExecId: `sell:${sellRow}`, stockId: stock.id, stockName: stock.name,
  qty, rewardQty, priceCents, groupKeyAtExecution: 'T|500', at: new Date(`${date}T12:00:00`).getTime(),
})
const receipt = (recordRows: number[]): BookingReceipt => ({
  id: 'booking:sale', kind: 'sell', payload: 'fixed', stockName: 'T', qty: 500, priceCents: 700,
  date: '2026-01-15', at: 1, recordRows, executionIds: [],
})
const project = (records: RawRecord[], options: Parameters<typeof buildLedger>[2] = {}, receipts: BookingReceipt[] = []) => {
  const inputs = JSON.stringify({ records, options, receipts })
  const ledger = buildLedger(records, [stock], options)
  const before = JSON.stringify(ledger)
  const statistics = buildTradingStatistics(ledger, records, receipts)
  expect(JSON.stringify({ records, options, receipts })).toBe(inputs)
  expect(JSON.stringify(ledger)).toBe(before)
  return { ledger, statistics }
}
const markedTarget = (mode: 'repair' | 'baseT'): ExtraTarget => ({
  id: 'grid:stats', lotId: 'lot:2', priceCents: 700, qty: 500, at: 1,
  strategy: { mode, rebuyPriceCents: 500, nextSellPriceCents: mode === 'baseT' ? 1200 : 700, groupId: 'stats' },
})
const markedRoot = { ...root, soldLotId: 'lot:2', soldTargetId: 'target:grid:stats' }

describe('统计日历的网格表现口径', () => {
  it('先卖后买的实际买回价高于卖价时如实显示负价差，不拿原高位成本或计划价替代', () => {
    const { ledger, statistics } = project([high, root], { executions: [execution('higher', 3, 500, 800, '2026-02-01')] })
    expect(statistics.events).toMatchObject([{ kind: 'rebuy', buyPriceCents: 800, profitCents: -50000, date: '2026-02-01' }])
    expect(ledger.totals.profitCents).toBe(-150000)
  })

  it('默认低位回本自动挂高位，未回补及部分回补均不计日历盈利或笔数', () => {
    for (const executions of [[], [execution('e1', 3, 200, 500, '2026-01-31')]]) {
      const { ledger, statistics } = project([high, root], { executions })
      expect(ledger.orders[0].strategyMode).toBe('repair')
      expect(ledger.effectiveHedges[0].items).toEqual([{ row: 2, qty: 500 }])
      expect(ledger.totals.profitCents).toBe(-150000)
      expect(statistics).toMatchObject({ events: [], daily: [], monthly: [], pendingRebuyCount: 1 })
    }
  })

  it('200股5元和300股5.5元跨月买回，按完成日统计实际850元而非计划1000元', () => {
    const { ledger, statistics } = project([high, root], { executions: [
      execution('e1', 3, 200, 500, '2026-01-31'), execution('e2', 3, 300, 550, '2026-02-01'),
    ] })
    expect(statistics.events).toMatchObject([{
      kind: 'rebuy', date: '2026-02-01', originalSoldAt: '2026-01-15', sourceRows: [3], qty: 500,
      sellPriceCents: 700, buyPriceCents: 530, sellAmountCents: 350000, buyAmountCents: 265000, profitCents: 85000,
    }])
    expect(statistics.daily).toEqual([{ day: '2026-02-01', sellCount: 1, sellQty: 500, profitCents: 85000, dateMissing: false }])
    expect(statistics.monthly).toEqual([{ month: '2026-02', sellCount: 1, sellQty: 500, sellAmountCents: 350000, profitCents: 85000, dateMissing: false }])
    expect(statistics.pendingRebuyCount).toBe(0)
    expect(ledger.totals.profitCents).toBe(-150000)
    expect(ledger.repairChains[0]).toMatchObject({ lossCents: -150000, profitCents: 0 })
  })

  it('奖励股不抵基础欠股，最后100股基础回补完成时才统计且不计奖励成本', () => {
    const partial = execution('e1', 3, 500, 500, '2026-01-31', 100)
    const first = project([high, root], { executions: [partial] })
    expect(first.ledger.sells.find(s => s.sourceRow === 3)?.actualRebuyQty).toBe(400)
    expect(first.statistics).toMatchObject({ events: [], pendingRebuyCount: 1 })
    const { statistics } = project([high, root], { executions: [partial, execution('e2', 3, 100, 550, '2026-02-02')] })
    expect(statistics.events).toMatchObject([{ qty: 500, date: '2026-02-02', buyAmountCents: 255000, profitCents: 95000 }])
  })

  it('同行回补采用真实5.5元与买入日期，多买100股不进入本次配对', () => {
    const own = { ...root, buyDateSerial: serial('2026-02-03'), buyPriceCents: 550, buyQtyRaw: 600 }
    const { ledger, statistics } = project([high, own])
    expect(ledger.lots.find(l => l.id === 'lot:3')?.qty).toBe(600)
    expect(statistics.events).toMatchObject([{ kind: 'rebuy', date: '2026-02-03', qty: 500, buyAmountCents: 275000, profitCents: 75000 }])
  })

  it('独立真实买入覆盖也按实际来源的最晚买入日完成，不以高位交割算回补', () => {
    const first = row(4, { buyDateSerial: serial('2026-01-31'), buyPriceCents: 500, buyQtyRaw: 200, targetPriceCents: 700 })
    const second = row(5, { buyDateSerial: serial('2026-02-04'), buyPriceCents: 500, buyQtyRaw: 300, targetPriceCents: 700 })
    const partial = project([high, root, first])
    expect(partial.statistics).toMatchObject({ events: [], pendingRebuyCount: 1 })
    const { statistics } = project([high, root, first, second])
    expect(statistics.events).toMatchObject([{ date: '2026-02-04', qty: 500, buyAmountCents: 250000, profitCents: 100000 }])
  })

  it('低位回本的5买7卖按普通盈利立即统计，不等待它自己的下一轮回补', () => {
    const lowSale = row(4, { soldLotId: 'lot:exec:e1', soldTargetId: 'target:lot:exec:e1', soldQty: 500,
      targetPriceCents: 700, sellDateSerial: serial('2026-02-05'), earlyBuyPriceCents: 500 })
    const { ledger, statistics } = project([high, markedRoot, lowSale], {
      extraTargets: [markedTarget('repair')], executions: [execution('e1', 3, 500, 500, '2026-02-01')],
    })
    expect(ledger.sells.find(s => s.sourceRow === 4)).toMatchObject({ sellBeforeBuy: true, actualRebuyQty: 0 })
    expect(statistics.events.find(e => e.sourceRows.includes(4))).toMatchObject({ kind: 'sale', date: '2026-02-05', profitCents: 100000 })
    expect(statistics.events.find(e => e.sourceRows.includes(3))).toMatchObject({ kind: 'rebuy', date: '2026-02-01', profitCents: 100000 })
    expect(ledger.repairChains[0]).toMatchObject({ lossCents: -150000, profitCents: 100000, netCents: -50000 })
    expect(ledger.totals.profitCents).toBe(-50000)
  })

  it('显式底仓做T全部回补后统计实际价差，不修改总账损失或创建回本链', () => {
    const { ledger, statistics } = project([high, markedRoot], {
      extraTargets: [markedTarget('baseT')], executions: [execution('e1', 3, 500, 500, '2026-02-01')],
    })
    expect(statistics.events).toMatchObject([{ kind: 'rebuy', date: '2026-02-01', profitCents: 100000 }])
    expect(ledger.totals.profitCents).toBe(-150000)
    expect(ledger.repairChains).toEqual([])
    expect(ledger.lots.find(l => l.id === 'lot:exec:e1')).toMatchObject({ buyPriceCents: 500, targetPriceCents: 1200, remainingQty: 500 })
  })

  it('正常盈利按卖出日，缺日期进入未填日期，正常亏损和零收益不显示', () => {
    const normal = row(2, { buyDateSerial: serial('2026-01-01'), buyPriceCents: 500, buyQtyRaw: 100,
      soldQty: 100, targetPriceCents: 700, sellDateSerial: serial('2026-01-20') })
    const missing = { ...normal, sourceRow: 3, sellDateSerial: null }
    const loss = { ...normal, sourceRow: 4, buyPriceCents: 1000 }
    const flat = { ...normal, sourceRow: 5, buyPriceCents: 700 }
    const { ledger, statistics } = project([normal, missing, loss, flat])
    expect(statistics.events).toHaveLength(2)
    expect(statistics.events.find(e => e.sourceRows.includes(2))).toMatchObject({ kind: 'sale', date: '2026-01-20', profitCents: 20000 })
    expect(statistics.events.find(e => e.sourceRows.includes(3))).toMatchObject({ kind: 'sale', date: null, profitCents: 20000 })
    expect(statistics.daily.find(d => d.day === '未填日期')).toMatchObject({ sellCount: 1, dateMissing: true, profitCents: 20000 })
    expect(ledger.totals.profitCents).toBe(10000)
  })

  it('同一卖出回执分配多个正常成本来源，只显示一次成交并累计真实盈利', () => {
    const first = row(2, { buyDateSerial: serial('2026-01-01'), buyPriceCents: 500, buyQtyRaw: 100,
      soldQty: 100, targetPriceCents: 700, sellDateSerial: serial('2026-01-15') })
    const second = { ...first, sourceRow: 3, buyPriceCents: 600, buyQtyRaw: 200, soldQty: 200 }
    const { statistics } = project([first, second], {}, [{ ...receipt([2, 3]), qty: 300 }])
    expect(statistics.events).toMatchObject([{ kind: 'sale', sourceRows: [2, 3], qty: 300, buyAmountCents: 170000, profitCents: 40000 }])
    expect(statistics.daily[0]).toMatchObject({ sellCount: 1, sellQty: 300, profitCents: 40000 })
  })

  it('同一回执的先卖后买若完成日期不同则分开，同日完成则合成一笔', () => {
    const first = { ...root, soldQty: 250 }
    const second = { ...root, sourceRow: 4, soldQty: 250 }
    const receipts = [receipt([3, 4])]
    const firstFill = execution('e1', 3, 250, 500, '2026-01-31')
    let result = project([high, first, second], { executions: [firstFill, execution('e2', 4, 250, 550, '2026-02-01')] }, receipts).statistics
    expect(result.events.map(e => [e.date, e.qty, e.profitCents])).toEqual([['2026-01-31', 250, 50000], ['2026-02-01', 250, 37500]])
    expect(result.monthly.map(m => [m.month, m.sellCount, m.profitCents])).toEqual([['2026-01', 1, 50000], ['2026-02', 1, 37500]])
    result = project([high, first, second], { executions: [firstFill, execution('e2', 4, 250, 550, '2026-01-31')] }, receipts).statistics
    expect(result.events).toMatchObject([{ sourceRows: [3, 4], qty: 500, profitCents: 87500 }])
    expect(result.daily[0]).toMatchObject({ sellCount: 1, sellQty: 500, profitCents: 87500 })
  })

  it('回执中只有部分来源完成时，仅显示已完成部分而不带入未回补份额', () => {
    const records = [high, { ...root, soldQty: 250 }, { ...root, sourceRow: 4, soldQty: 250 }]
    const { statistics } = project(records, { executions: [execution('e1', 3, 250, 500, '2026-02-01')] }, [receipt([3, 4])])
    expect(statistics.events).toMatchObject([{ sourceRows: [3], qty: 250, profitCents: 50000 }])
    expect(statistics.pendingRebuyCount).toBe(1)
  })

  it('撤销最后回补或软删来源后，完成记录消失且不保留旧的统计金额', () => {
    const first = execution('e1', 3, 200, 500, '2026-01-31')
    const last = execution('e2', 3, 300, 550, '2026-02-01')
    expect(project([high, root], { executions: [first, last] }).statistics.events).toHaveLength(1)
    expect(project([high, root], { executions: [first] }).statistics).toMatchObject({ events: [], pendingRebuyCount: 1 })
    expect(project([high, { ...root, deletedAt: 1 }], { executions: [first, last] }).statistics).toMatchObject({ events: [], pendingRebuyCount: 0 })
  })

  it('实际回补价格未知时不拿P列补盈利，日期未知时不猜成原卖出日', () => {
    const records = [high, root]
    const { ledger } = project(records, { executions: [execution('e1', 3, 500, 500, '2026-02-01')] })
    const real = ledger.sells.find(s => s.sourceRow === 3)!
    const fills = real.actualRebuyFills!
    const badPrice = { sells: [{ ...real, actualRebuyFills: fills.map(f => ({ ...f, priceCents: null })) }], lots: ledger.lots }
    expect(buildTradingStatistics(badPrice, records)).toMatchObject({ events: [], unpricedCount: 1, pendingRebuyCount: 0 })
    const missingDate = { sells: [{ ...real, actualRebuyFills: fills.map(f => ({ ...f, date: null })) }], lots: ledger.lots }
    const statistics = buildTradingStatistics(missingDate, records)
    expect(statistics.events).toMatchObject([{ date: null, originalSoldAt: '2026-01-15', profitCents: 100000 }])
    expect(statistics.monthly).toMatchObject([{ month: '未填日期', dateMissing: true, profitCents: 100000 }])
  })

  it('多张先卖单竞争独立真实买回来源，500股只完成一张，不重复使用来源', () => {
    const records = [high, { ...high, sourceRow: 6, buyPriceCents: 1100 }, root, { ...root, sourceRow: 4 },
      row(7, { buyDateSerial: serial('2026-01-31'), buyPriceCents: 500, buyQtyRaw: 200, targetPriceCents: 700 }),
      row(8, { buyDateSerial: serial('2026-02-01'), buyPriceCents: 500, buyQtyRaw: 300, targetPriceCents: 700 }),
    ]
    const { ledger, statistics } = project(records)
    const roots = ledger.sells.filter(s => s.sourceRow === 3 || s.sourceRow === 4)
    expect(roots.reduce((sum, s) => sum + (s.actualRebuyQty ?? 0), 0)).toBe(500)
    for (const [id, capacity] of [['lot:7', 200], ['lot:8', 300]] as const) {
      expect(roots.flatMap(s => s.actualRebuyFills ?? []).filter(f => f.sourceLotId === id).reduce((sum, f) => sum + f.qty, 0)).toBeLessThanOrEqual(capacity)
    }
    expect(statistics.events).toMatchObject([{ kind: 'rebuy', date: '2026-02-01', qty: 500, profitCents: 100000 }])
    expect(statistics.pendingRebuyCount).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { buildBuySuggestions, splitBuySuggestions } from './suggestions'
import { buildNextRoundBuyRows } from './buyBoard'
import { planImport } from './importPlan'
import type { RawRecord, StockConfig, TradePlan } from './types'
import { allocatePlan, bookingContributions, bookingPayload, saleFacts, tradeFacts, type BookingReceipt } from './booking'
const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const rec = (sourceRow: number, fields: Partial<RawRecord> = {}): RawRecord => ({ sourceRow, stockName: 'T', buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null, qtyNeedsDerive: false, targetPriceCents: 700, targetNeedsDerive: false, soldQty: 500, sellDateSerial: 46010, earlyBuyPriceCents: 500, rawProfitCents: null, importKey: `k${sourceRow}`, ...fields })
describe('记账流程：目的隔离与精确来源', () => {
  it('欠500与可选300同价仍两组，旧歧义计划不应用于任何一组', () => {
    const l = buildLedger([rec(9), rec(2, { buyDateSerial: 46000, buyPriceCents: 500, buyQtyRaw: 300, soldQty: 300, targetPriceCents: 500, earlyBuyPriceCents: null })], [stock])
    const board = buildBuySuggestions(l.buySplits, buildNextRoundBuyRows({ ...l, merges: [] }), [{ id: 'old', kind: 'buy', refId: 'buy:T:500', priceCents: 450, qty: 100, at: 1 }])
    const { mustBuy, bonus } = splitBuySuggestions(board, new Set(l.orders.filter(o => o.exposure).map(o => o.id)))
    expect(mustBuy.map(r => [r.qty, r.priceCents])).toEqual([[500, 500]])
    expect(bonus.map(r => [r.qty, r.priceCents])).toEqual([[300, 500]])
    expect(new Set(board.map(r => r.key)).size).toBe(2)
  })
  it('同目的两档各缩100后碰价，贡献恰100+100；不放大原档容量', () => {
    const l = buildLedger([rec(9), rec(10, { earlyBuyPriceCents: 450 })], [stock])
    const base = buildBuySuggestions(l.buySplits, [], [])
    const plans: TradePlan[] = base.map((r, i) => ({ id: `p${i}`, kind: 'buy', refId: r.key, priceCents: 500, qty: 100, at: i }))
    const result = buildBuySuggestions(l.buySplits, [], plans)
    expect(result).toHaveLength(1)
    expect(result[0].qty).toBe(200)
    expect(result[0].sources.map(s => s.qty)).toEqual([100, 100])
    expect(result[0].members?.map(m => m.qty)).toEqual([100, 100])
  })
})

describe('真实成交投影与分配守恒', () => {
  it('同内容对象不同字段顺序仍是同一请求，来源数组顺序保留', () => {
    expect(bookingPayload({ qty: 100, input: { side: 'buy', price: 500 } })).toBe(bookingPayload({ input: { price: 500, side: 'buy' }, qty: 100 }))
    expect(bookingPayload([1, 2])).not.toBe(bookingPayload([2, 1]))
  })
  it('合并成交只展示一笔，分配亏损不重复增加卖出股数', () => {
    const records = [rec(2, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 300, soldQty: null }), rec(9, { soldQty: 300 })]
    const l = buildLedger(records, [stock])
    expect(l.sells.some(s => s.hedgedFromSellRow !== undefined)).toBe(true)
    const sales = saleFacts(l.sells)
    expect(sales).toHaveLength(1)
    expect(sales[0].qty).toBe(300)
    expect(sales[0].profitCents).toBe(l.totals.profitCents)
  })
  it('没有回补价格并不代表实际买回；部分回补显示实际基础股', () => {
    const root = rec(9, { earlyBuyPriceCents: null, targetPriceCents: null })
    expect(buildLedger([root], [stock]).sells[0].actualRebuyQty).toBe(0)
    const l = buildLedger([rec(9)], [stock], { executions: [{ id: 'e', orderId: 'rb:sell:9', sellExecId: 'sell:9', stockId: 'stock:T', stockName: 'T', qty: 200, rewardQty: 0, priceCents: 500, groupKeyAtExecution: '', at: 1793200000000 }] })
    expect(l.sells.find(s => s.sourceRow === 9)?.actualRebuyQty).toBe(200)
  })
  it('缩量先明确本次各来源贡献，合计恰等本次量', () => {
    expect(bookingContributions([{ id: 'a', qty: 100 }, { id: 'b', qty: 300 }], 200)).toEqual([{ id: 'a', qty: 100 }, { id: 'b', qty: 100 }])
    expect(allocatePlan([{ key: 'a', qty: 1 }, { key: 'b', qty: 900 }], 200).reduce((sum, x) => sum + x.qty, 0)).toBe(200)
    expect(() => allocatePlan([{ key: 'a', qty: 100 }, { key: 'b', qty: 100 }], 1)).toThrow()
  })
  it('回执核对后修改原事实，自动变回待核对并显示真实价量', () => {
    const r = rec(2, { buyDateSerial: 46000, buyPriceCents: 500, buyQtyRaw: 300, soldQty: null })
    const receipt: BookingReceipt = { id: 'op', payload: '{}', kind: 'buy', stockName: 'T', qty: 300, priceCents: 500, date: '2025-12-09', at: 1, reviewedAt: 2, recordRows: [2], executionIds: [] }
    const first = tradeFacts([r], [], [receipt])[0]
    receipt.date = first.date
    expect(tradeFacts([r], [], [receipt])[0].reviewed).toBe(true)
    expect(tradeFacts([{ ...r, buyPriceCents: 550 }], [], [receipt])[0]).toMatchObject({ qty: 300, priceCents: 550, reviewed: false })
  })
  it('已回补事实再导入相同买回时必须选择跳过或另一笔', () => {
    const receipt: BookingReceipt = { id: 'op', payload: '{}', kind: 'buy', stockName: 'T', qty: 300, priceCents: 500, date: null, at: 1, recordRows: [], executionIds: ['e'] }
    const incoming = rec(2, { buyPriceCents: 500, buyQtyRaw: 300, buyDateSerial: 46001, soldQty: null })
    const facts = [{ id: receipt.id, stockName: 'T', side: 'buy' as const, qty: 300, priceCents: 500, date: new Date(Date.UTC(1899,11,30)+46001*86400000).toISOString().slice(0,10), rows: [], executionIds: ['e'], source: '回补', voided: false, reviewed: false }]
    expect(planImport([], [incoming], [], {}, facts).conflicts).toHaveLength(1)
    expect(planImport([], [incoming], [], { 2: 'skip' }, facts).fresh).toHaveLength(0)
    expect(planImport([], [incoming], [], { 2: 'new' }, facts).fresh).toHaveLength(1)
  })
})
describe('导入事实识别', () => {
  it('裸卖子集精确匹配B，不把A更新成B', () => {
    const a = rec(2, { targetPriceCents: 700 }), b = rec(3, { targetPriceCents: 800 })
    const plan = planImport([a, b], [{ ...b, sourceRow: 2 }])
    expect(plan.updates).toEqual([])
    expect(plan.fresh).toEqual([])
    expect(plan.unchanged).toBe(1)
  })
  it('同身份多个候选但内容不一致不能按队列猜更新', () => {
    const plan = planImport([rec(2), rec(3, { targetPriceCents: 800 })], [rec(9, { targetPriceCents: 900 })])
    expect(plan.updates).toEqual([])
    expect(plan.fresh).toEqual([])
    expect('conflicts' in plan && Array.isArray(plan.conflicts) && plan.conflicts.length).toBe(1)
  })
})

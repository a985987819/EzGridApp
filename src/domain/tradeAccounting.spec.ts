import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { isDone, isSoldOut } from './tradeState'
import { buildBuySuggestions } from './suggestions'
import type { RawRecord, RebuyExecution, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const record = (sourceRow: number, fields: Partial<RawRecord> = {}): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: 500, buyQtyRaw: 500,
  qtyNeedsDerive: false, targetPriceCents: 700, targetNeedsDerive: false, soldQty: 0,
  sellDateSerial: 46010, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `k${sourceRow}`, ...fields,
})
const naked = record(9, { buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null, soldQty: 1000, targetPriceCents: 800, earlyBuyPriceCents: 600 })
const targets = [
  { id: 'low', lotId: 'lot:2', priceCents: 600, qty: 200, at: 1 },
  { id: 'high', lotId: 'lot:2', priceCents: 700, qty: 300, at: 2 },
]
const sale = (fields: Partial<RawRecord> = {}) => record(10, { soldLotId: 'lot:2', buyQtyRaw: null, targetPriceCents: 600, soldQty: 200, ...fields })
const execution = (fields: Partial<RebuyExecution> = {}): RebuyExecution => ({
  id: 'e', orderId: 'rb:sell:9', sellExecId: 'sell:9', stockId: stock.id, stockName: 'T', qty: 200,
  priceCents: 500, rewardQty: 0, groupKeyAtExecution: 'stock:T|600', at: 1793000000000, ...fields,
})

describe('拆单成交与完成状态审计回归', () => {
  it.each([false, true])('卖档成交不复活，支持旧成交及来源身份 %s', (explicit) => {
    const l = buildLedger([record(2), sale(explicit ? { soldTargetId: 'target:low', targetPriceCents: 650 } : {})], [stock], { extraTargets: targets })
    expect(l.targets.map((t) => [t.priceCents, t.qty])).toEqual([[700, 300]])
    expect(l.anomalies.some((a) => a.kind === 'targetOverflow')).toBe(false)
  })
  it('同批次两个来源档成交分别扣量；撤销恢复原档', () => {
    const first = sale({ soldTargetId: 'target:low', soldQty: 100 })
    const second = sale({ sourceRow: 11, soldTargetId: 'target:high', soldQty: 100 })
    const l = buildLedger([record(2), first, second], [stock], { extraTargets: targets })
    expect(l.targets.map((t) => [t.priceCents, t.qty])).toEqual([[600, 100], [700, 200]])
    const undo = buildLedger([record(2), { ...first, deletedAt: 1 }, second], [stock], { extraTargets: targets })
    expect(undo.targets.map((t) => [t.priceCents, t.qty])).toEqual([[600, 200], [700, 200]])
  })
  it('明确默认档成交不扣同价手动档；已删除来源档不影响其它档', () => {
    const l = buildLedger([record(2, { buyQtyRaw: 700 }), sale({ soldTargetId: 'target:lot:2' })], [stock], { extraTargets: targets })
    expect(l.targets.map((t) => t.qty)).toEqual([200, 300])
    const removed = buildLedger([record(2), sale({ soldTargetId: 'target:removed', soldQty: 100 })], [stock], { extraTargets: targets.slice(0, 1) })
    expect(removed.targets[0].qty).toBe(200)
  })
  it('只拆200股，其余800股保留默认回补价', () => {
    const l = buildLedger([naked], [stock], { buyTargets: [{ id: 'cheap', sellRow: 9, priceCents: 500, qty: 200, at: 1 }] })
    expect(l.buySplits.map((b) => [b.priceCents, b.qty, b.targetId])).toEqual([[500, 200, 'cheap'], [600, 800, null]])
  })
  it.each([['cheap', 550, [100, 800]], ['default:rb:sell:9', 500, [200, 700]]] as const)('改价成交依然扣原买档 %s', (buyTargetId, priceCents, qty) => {
    const l = buildLedger([naked], [stock], {
      buyTargets: [{ id: 'cheap', sellRow: 9, priceCents: 500, qty: 200, at: 1 }],
      executions: [execution({ qty: 100, buyTargetId, priceCents })],
    })
    expect(l.buySplits.map((b) => b.qty)).toEqual(qty)
    expect(l.buySplits.reduce((a, b) => a + b.qty, 0)).toBe(l.orders[0].remainingQty)
  })
  it('奖励成交不会再次扣基础档；同订单合并建议保留两个来源', () => {
    const r = record(9, { soldQty: 500, earlyBuyPriceCents: 500 })
    const buyTargets = [{ id: 'a', sellRow: 9, priceCents: 450, qty: 300, at: 1 }, { id: 'b', sellRow: 9, priceCents: 500, qty: 200, at: 2 }]
    const initial = buildLedger([r], [stock], { buyTargets })
    const merged = buildBuySuggestions(initial.buySplits, [], [{ id: 'p', refId: 'buy:T:450', kind: 'buy', priceCents: 500, qty: 300, at: 1 }])
    expect(merged).toHaveLength(1)
    expect(merged[0].qty).toBe(700)
    expect(merged[0].sources).toHaveLength(2)
    const executions = [execution({ id: 'a', qty: 300, priceCents: 500, buyTargetId: 'a', groupKeyAtExecution: 'stock:T|500' }), execution({ id: 'b', qty: 400, rewardQty: 200, buyTargetId: 'b', groupKeyAtExecution: 'stock:T|500' })]
    const completed = buildLedger([r], [stock], { buyTargets, executions })
    expect(completed.buySplits.map((b) => b.qty)).toEqual([0, 0])
    expect(completed.groups.find((g) => g.groupKey === 'stock:T|500')?.usedProfitCents).toBe(100000)
    expect(completed.checks.filter((c) => !c.ok)).toEqual([])
    const corrupt = buildLedger([r], [stock], { executions: executions.map((e) => ({ ...e, rewardQty: 0 })) })
    expect(corrupt.checks.find((c) => c.name === '各订单基础成交 ≤ 基础回补量')?.ok).toBe(false)
  })
  it('默认档部分成交之后新增拆分，只分配尚未成交的基础股', () => {
    const l = buildLedger([naked], [stock], {
      buyTargets: [{ id: 'later', sellRow: 9, priceCents: 500, qty: 700, at: 2 }],
      executions: [execution({ qty: 300, priceCents: 600, buyTargetId: 'default:rb:sell:9' })],
    })
    expect(l.buySplits.map((b) => [b.priceCents, b.qty])).toEqual([[500, 700], [600, 0]])
  })
  it('先成交含奖励的档，奖励与基础股分开，另一档不受影响', () => {
    const r = record(9, { soldQty: 500, earlyBuyPriceCents: 500 })
    const buyTargets = [{ id: 'a', sellRow: 9, priceCents: 450, qty: 300, at: 1 }, { id: 'b', sellRow: 9, priceCents: 500, qty: 200, at: 2 }]
    const initial = buildLedger([r], [stock], { buyTargets })
    expect(initial.buySplits.map((b) => [b.baseRemainingQty, b.qty])).toEqual([[300, 300], [200, 400]])
    const l = buildLedger([r], [stock], { buyTargets, executions: [execution({ qty: 400, rewardQty: 200, buyTargetId: 'b', groupKeyAtExecution: 'stock:T|500' })] })
    expect(l.buySplits.map((b) => [b.baseRemainingQty, b.qty])).toEqual([[300, 300], [0, 0]])
    expect(l.checks.filter((c) => !c.ok)).toEqual([])
  })
  it('奖励预算按实际成交金额与历史价组判断，超预算仍报异常', () => {
    const r = record(9, { soldQty: 500, earlyBuyPriceCents: 500 })
    const e = execution({ qty: 600, rewardQty: 100, priceCents: 900, groupKeyAtExecution: 'stock:T|500' })
    const check = (priceCents: number) => buildLedger([r], [stock], { executions: [{ ...e, priceCents }] }).checks.find((c) => c.name === 'Σ已买回奖励金额 ≤ 组累计盈利')
    expect(check(900)?.ok).toBe(true)
    expect(check(1100)?.ok).toBe(false)
    const moved = buildLedger([{ ...r, earlyBuyPriceCents: 450 }], [stock], { executions: [e] })
    // 只改回补价不会挪走成本价组的历史盈利，奖励仍留在成交时所属组。
    expect(moved.checks.find((c) => c.name === 'Σ已买回奖励金额 ≤ 组累计盈利')?.ok).toBe(true)
    const missingPool = buildLedger([{ ...r, buyPriceCents: 450 }], [stock], { executions: [e] })
    expect(missingPool.checks.find((c) => c.name === 'Σ已买回奖励金额 ≤ 组累计盈利')?.ok).toBe(false)
  })
  it('父明细部分卖出未完成，卖光完成；撤销后恢复未完成', () => {
    for (const [qty, deletedAt, done] of [[200, undefined, false], [500, undefined, true], [500, 1, false]] as const) {
      const rec = record(2)
      const l = buildLedger([rec, sale({ soldQty: qty, deletedAt })], [stock])
      const row = { rec, lot: l.lots.find((b) => b.id === 'lot:2')!, sell: null }
      expect(isDone(row)).toBe(done)
      expect(isSoldOut(row)).toBe(done)
    }
  })
  it('本行仍待回补时不完成，子卖出的回补状态由子明细保留', () => {
    const r = record(2, { soldQty: 500, earlyBuyPriceCents: 500 })
    const l = buildLedger([r], [stock])
    expect(isDone({ rec: r, lot: l.lots[0], sell: l.sells[0] })).toBe(false)
    const child = sale({ soldQty: 500, earlyBuyPriceCents: 500 })
    const s = buildLedger([record(2), child], [stock])
    expect(isDone({ rec: child, lot: null, sell: s.sells.find((v) => v.sourceRow === 10)! })).toBe(false)
  })
})

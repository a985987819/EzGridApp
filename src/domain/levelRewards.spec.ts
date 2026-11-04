import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { buildNextRoundBuyRows } from './buyBoard'
import { consumedNextRounds } from './suggestions'
import type { RawRecord, RepairChainLink, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const rec = (sourceRow: number, fields: Partial<RawRecord>): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: 500, buyQtyRaw: 500,
  qtyNeedsDerive: false, targetPriceCents: 700, targetNeedsDerive: false,
  soldQty: 500, sellDateSerial: 46010, earlyBuyPriceCents: null, rawProfitCents: null,
  importKey: `level:${sourceRow}`, ...fields,
})
const link = (memberRows: number[], closedAt: number | null = null): RepairChainLink => ({
  id: 'chainlink:2', anchorRow: 2, stockName: 'T', memberRows, closedAt, at: 1,
})
const groupAt = (ledger: ReturnType<typeof buildLedger>, priceCents: number) => ledger.groups.find(group => group.rebuyPriceCents === priceCents)

describe('价位累计盈利与奖励共用预算', () => {
  it('普通5买7卖500，累计1000元可给下一轮增加200股', () => {
    const records = [rec(2, {})]
    const ledger = buildLedger(records, [stock])
    const next = buildNextRoundBuyRows({ ...ledger, merges: [], groups: ledger.groups })
    expect(groupAt(ledger, 500)?.grossProfitCents).toBe(100000)
    expect(next[0]).toMatchObject({ baseQty: 500, rewardQty: 200, qty: 700, amountCents: 350000 })
  })

  it('未回本的链占用1000元盈利，不给低位待买奖励', () => {
    const records = [rec(2, { buyPriceCents: 1000 }), rec(3, { buyDateSerial: 46011, sellDateSerial: 46012, earlyBuyPriceCents: 500 })]
    const ledger = buildLedger(records, [stock], { chainLinks: [link([3])] })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 2)).toMatchObject({ lossCents: -150000, profitCents: 100000, netCents: -50000, done: false })
    expect(groupAt(ledger, 500)?.grossProfitCents).toBe(0)
    expect(ledger.orders.find(order => order.sourceRow === 3)?.rewardQty).toBe(0)
  })

  it('回本后只释放净超额500元，而不是低位全部2000元', () => {
    const records = [rec(2, { buyPriceCents: 1000 }), rec(3, { buyDateSerial: 46011, sellDateSerial: 46012, buyQtyRaw: 1000, soldQty: 1000, earlyBuyPriceCents: 500 })]
    const ledger = buildLedger(records, [stock], { chainLinks: [link([3])] })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 2)).toMatchObject({ netCents: 50000, done: true })
    expect(groupAt(ledger, 500)?.grossProfitCents).toBe(50000)
    expect(ledger.orders.find(order => order.sourceRow === 3)?.rewardQty).toBe(100)
    expect(ledger.totals.profitCents).toBe(50000)
  })

  it('人工结束但仍亏损的链不解锁奖励', () => {
    const ledger = buildLedger([rec(2, { buyPriceCents: 1000 }), rec(3, { buyDateSerial: 46011, sellDateSerial: 46012, earlyBuyPriceCents: 500 })], [stock], {
      chainLinks: [link([3], Date.now())],
    })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 2)?.done).toBe(false)
    expect(groupAt(ledger, 500)?.grossProfitCents).toBe(0)
  })

  it('下一轮奖励按实际成本占用原价组，基础来源只消耗500股', () => {
    const records = [rec(2, {}), rec(3, { soldQty: 0, sellDateSerial: null, buyDateSerial: 46011, buyQtyRaw: 700,
      nextRoundOfRow: 2, profitRewardQty: 200, profitRewardGroupKey: 'stock:T|500' })]
    const ledger = buildLedger(records, [stock])
    expect(consumedNextRounds(records).get(2)).toBe(500)
    expect(groupAt(ledger, 500)).toMatchObject({ grossProfitCents: 100000, usedProfitCents: 100000, capacityHands: 0 })
  })

  it('旧回补奖励与下一轮奖励共享已用金额，不重复授予', () => {
    const records = [rec(2, {}), rec(3, { buyPriceCents: null, buyQtyRaw: null, buyDateSerial: null, targetPriceCents: 700, earlyBuyPriceCents: 500 })]
    const ledger = buildLedger(records, [stock], { hedges: [{ id: 'hedge:3', sellRow: 3, items: [], at: 1 }], executions: [{
      id: 'spent', orderId: 'rb:sell:3', sellExecId: 'sell:3', stockId: 'stock:T', stockName: 'T', qty: 300,
      rewardQty: 100, priceCents: 500, groupKeyAtExecution: 'stock:T|500', at: Date.UTC(2026, 1, 1),
    }] })
    expect(groupAt(ledger, 500)?.usedProfitCents).toBe(50000)
    const next = buildNextRoundBuyRows({ ...ledger, merges: [], groups: ledger.groups })
    expect((ledger.orders.find(order => order.sourceRow === 3)?.rewardQty ?? 0) - 100 + next.reduce((sum, row) => sum + (row.rewardQty ?? 0), 0)).toBeLessThanOrEqual(100)
  })
})

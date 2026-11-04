import { describe, expect, it } from 'vitest'
import { buildRepairChains } from './chain'
import { buildLedger } from './ledger'
import type { RawRecord, RebuyExecution, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
function record(sourceRow: number, fields: Partial<RawRecord> = {}): RawRecord {
  return { sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: null, buyQtyRaw: null,
    qtyNeedsDerive: false, targetPriceCents: null, targetNeedsDerive: false, soldQty: 0,
    sellDateSerial: 46010, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `k${sourceRow}`, ...fields }
}
const buy = (row: number, cost: number, qty: number) => record(row, { buyPriceCents: cost, buyQtyRaw: qty, targetPriceCents: cost + 200 })
const sell = (row: number, price: number, qty: number) => record(row, { buyDateSerial: null, targetPriceCents: price, soldQty: qty, earlyBuyPriceCents: price - 200 })
const execution = (row: number, qty: number, cost: number): RebuyExecution => ({ id: 'e', orderId: `rb:sell:${row}`, sellExecId: `sell:${row}`, stockId: stock.id,
  stockName: stock.name, qty, priceCents: cost, rewardQty: 0, groupKeyAtExecution: `${stock.id}|${cost}`, at: new Date('2026-01-05T12:00:00').getTime() })

describe('链盈利份额复用实际所有权分配', () => {
  it('正常亏损锚点与人工成员分别导出种子损失和已实现盈利，不改变链进度', () => {
    const records = [record(2, { buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 700, soldQty: 500 }),
      record(3, { buyPriceCents: 500, buyQtyRaw: 500, targetPriceCents: 900, soldQty: 500, buyDateSerial: 46015, sellDateSerial: 46020 })]
    const links = [{ id: 'c2', anchorRow: 2, stockName: 'T', memberRows: [3], closedAt: null, at: 1 }]
    const ledger = buildLedger(records, [stock], { chainLinks: links })
    const before = JSON.stringify({ lots: ledger.lots, sells: ledger.sells, links })
    const result = buildRepairChains({ ...ledger, executions: [], links })
    expect(result.chains[0]).toMatchObject({ lossCents: -150000, profitCents: 200000, netCents: 50000, done: true })
    expect(result.profitSlices).toEqual([
      expect.objectContaining({ chainId: 'chain:2', sellId: 'sell:2', qty: 500, profitCents: -150000, costCents: 1000, kind: 'seed' }),
      expect.objectContaining({ chainId: 'chain:2', sellId: 'sell:3', qty: 500, profitCents: 200000, costCents: 500, kind: 'branch' }),
    ])
    expect(JSON.stringify({ lots: ledger.lots, sells: ledger.sells, links })).toBe(before)
  })

  it('共享1000股回补再卖600，按500/100份额分两链，不能按分支总量同比例分利润', () => {
    const records = [buy(2, 1000, 500), buy(3, 1200, 500), sell(9, 700, 1000),
      record(10, { soldLotId: 'lot:exec:e', buyPriceCents: 500, buyDateSerial: 46020, targetPriceCents: 700, soldQty: 600, sellDateSerial: 46030, earlyBuyPriceCents: 500 })]
    const executions = [execution(9, 1000, 500)]
    const hedges = [{ id: 'hedge:9', sellRow: 9, items: [{ row: 2, qty: 500 }, { row: 3, qty: 500 }], at: 1 }]
    const ledger = buildLedger(records, [stock], { hedges, executions })
    const result = buildRepairChains({ ...ledger, executions, legacyHedgeRows: [9] })
    const sold = result.profitSlices.filter(slice => slice.sellId === 'sell:10')
    expect(sold.map(slice => [slice.chainAnchor, slice.qty, slice.profitCents, slice.costCents])).toEqual([[2, 500, 100000, 500], [3, 100, 20000, 500]])
    expect(sold.reduce((sum, slice) => sum + slice.qty, 0)).toBe(600)
    expect(sold.reduce((sum, slice) => sum + slice.profitCents, 0)).toBe(ledger.sells.find(sale => sale.id === 'sell:10')!.profitCents)
    expect(result.profitSlices.filter(slice => slice.kind === 'seed').map(slice => slice.profitCents)).toEqual([-150000, -250000])
  })

  it('价位槽按计划5元归属，实际5.5元回补的盈利仍归实际5.5成本价位', () => {
    const records = [record(2, { buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 700, soldQty: 500, earlyBuyPriceCents: 500 }),
      record(3, { soldLotId: 'lot:exec:e', buyPriceCents: 550, buyDateSerial: 46020, targetPriceCents: 750, soldQty: 300, sellDateSerial: 46030 })]
    const executions = [execution(2, 500, 550)]
    const ledger = buildLedger(records, [stock], { executions })
    const result = buildRepairChains({ ...ledger, executions })
    expect(result.chains[0].branches[0].buyPriceCents).toBe(500)
    expect(result.profitSlices.filter(slice => slice.kind === 'branch')).toEqual([
      expect.objectContaining({ sellId: 'sell:3', lotId: 'lot:exec:e', qty: 300, costCents: 550, profitCents: 60000 }),
    ])
  })

  it('明确归属的真实买入仅导出后来实际卖掉的份额，保留其负盈利', () => {
    const records = [record(2, { buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 700, soldQty: 500, earlyBuyPriceCents: 500 }),
      record(3, { buyPriceCents: 500, buyQtyRaw: 500, buyDateSerial: 46015 }),
      record(4, { soldLotId: 'lot:3', buyPriceCents: 500, buyDateSerial: 46015, targetPriceCents: 400, soldQty: 200, sellDateSerial: 46030 })]
    const links = [{ id: 'c2', anchorRow: 2, stockName: 'T', memberRows: [3], closedAt: null, at: 1 }]
    const ledger = buildLedger(records, [stock], { chainLinks: links })
    const result = buildRepairChains({ ...ledger, executions: [], links })
    const branch = result.profitSlices.filter(slice => slice.chainAnchor === 2 && slice.kind === 'branch')
    expect(branch).toEqual([expect.objectContaining({ sellId: 'sell:4', qty: 200, profitCents: -20000, costCents: 500 })])
    expect(branch.reduce((sum, slice) => sum + slice.profitCents, 0)).toBe(result.chains.find(chain => chain.anchorRow === 2)!.profitCents)
  })
})

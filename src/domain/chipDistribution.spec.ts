import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseWorkbook } from '../io/parseWorkbook'
import { DEFAULT_STOCKS } from './defaults'
import { buildLedger } from './ledger'
import { buildChipDistribution } from './chipDistribution'
import type { BookingReceipt } from './booking'
import type { RawRecord, RebuyExecution, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 50, priceLimitType: 'main_10' }
const other: StockConfig = { ...stock, id: 'stock:U', name: 'U' }
const record = (sourceRow: number, priceCents = 500, qty = 100, fields: Partial<RawRecord> = {}): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: priceCents, buyQtyRaw: qty,
  qtyNeedsDerive: false, targetPriceCents: 700, targetNeedsDerive: false, soldQty: 0,
  sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `k${sourceRow}`, ...fields,
})
const naked = (sourceRow: number, qty = 100, fields: Partial<RawRecord> = {}): RawRecord => record(sourceRow, 500, qty, {
  buyPriceCents: null, buyQtyRaw: null, buyDateSerial: null, soldQty: qty, sellDateSerial: 46010, earlyBuyPriceCents: 500, ...fields,
})
const execution = (id: string, sourceRow: number, qty = 100, fields: Partial<RebuyExecution> = {}): RebuyExecution => ({
  id, orderId: `rb:sell:${sourceRow}`, sellExecId: `sell:${sourceRow}`, stockId: stock.id, stockName: 'T', qty,
  priceCents: 500, rewardQty: 0, groupKeyAtExecution: 'stock:T|500', at: 1793000000000, ...fields,
})
const receipt = (id: string, fields: Partial<BookingReceipt> = {}): BookingReceipt => ({
  id, payload: '{}', kind: 'buy', stockName: 'T', qty: 200, priceCents: 500, date: null, at: 1, recordRows: [], executionIds: [], ...fields,
})
function distribution(records: RawRecord[], intervalCents: number | null = 50, executions: RebuyExecution[] = [], receipts: BookingReceipt[] = []) {
  const ledger = buildLedger(records, [stock, other], { executions })
  return buildChipDistribution({ stockName: 'T', records, ledger, executions, receipts, intervalCents })
}

describe('个股真实成交频次与未完成买单成本分布', () => {
  it('空数据不猜区间，所有数量归零', () => {
    expect(distribution([])).toMatchObject({
      widthCents: 50, totalTradeCount: 0, totalTradeQty: 0, totalHoldingQty: 0, totalHoldingLots: 0,
      excludedTradeCount: 0, hotTrades: null, heavyHoldings: null, levels: [],
    })
  })

  it('全部历史买卖各计一次，缺日期不排除，未完成买单只计实际剩余份额', () => {
    const rows = [record(2, 500, 500, { soldQty: 200, sellDateSerial: 46010 }), record(3, 520, 100, { buyDateSerial: null })]
    const result = distribution(rows)
    expect(result).toMatchObject({ totalTradeCount: 3, totalTradeQty: 800, totalHoldingQty: 400, totalHoldingLots: 2 })
    expect(result.hotTrades).toEqual({ loCents: 500, hiCents: 520, count: 2, qty: 600, buyCount: 2, sellCount: 0, sourceRows: [2, 3] })
    expect(result.heavyHoldings).toEqual({ loCents: 500, hiCents: 520, qty: 400, lotCount: 2, sourceRows: [2, 3] })
    expect(result.levels.map(level => [level.priceCents, level.tradeCount, level.holdingQty])).toEqual([[500, 1, 300], [520, 1, 100], [700, 1, 0]])
  })

  it('只统计当前股票，另一只同价巨量与软删除行均不串入', () => {
    const rows = [record(2), record(3, 500, 99999, { stockName: 'U' }), record(4, 500, 99999, { deletedAt: 1 })]
    const result = distribution(rows)
    expect(result).toMatchObject({ totalTradeCount: 1, totalTradeQty: 100, totalHoldingQty: 100, totalHoldingLots: 1 })
    expect(result.hotTrades?.sourceRows).toEqual([2])
  })

  it('一个间隔是最大跨度，包含边界且不会被相邻价位连锁扩成三档', () => {
    const result = distribution([record(2, 501), record(3, 551), record(4, 601)])
    expect(result.hotTrades).toMatchObject({ loCents: 501, hiCents: 551, count: 2, qty: 200 })
    expect(result.heavyHoldings).toMatchObject({ loCents: 501, hiCents: 551, qty: 200, lotCount: 2 })
    expect(result.hotTrades!.hiCents - result.hotTrades!.loCents).toBe(50)
  })

  it('频次按成交笔数、持仓按剩余股数，少笔大单不会冒充最高频', () => {
    const result = distribution([record(2, 500), record(3, 500), record(4, 500), record(5, 1000, 1000)], 0)
    expect(result.hotTrades).toMatchObject({ loCents: 500, hiCents: 500, count: 3, qty: 300 })
    expect(result.heavyHoldings).toMatchObject({ loCents: 1000, hiCents: 1000, qty: 1000, lotCount: 1 })
  })

  it('频次相同先比较成交股数，持仓股数相同先比较批次数', () => {
    const result = distribution([record(2, 500), record(3, 500), record(4, 700, 200), record(5, 900, 300)], 0)
    expect(result.hotTrades).toMatchObject({ loCents: 500, count: 2 })
    const quantityTie = distribution([record(2, 500), record(3, 700, 200)], 0)
    expect(quantityTie.hotTrades).toMatchObject({ loCents: 700, count: 1, qty: 200 })
    const holdingTie = distribution([record(2, 500), record(3, 500), record(4, 700, 200)], 0)
    expect(holdingTie.heavyHoldings).toMatchObject({ loCents: 500, qty: 200, lotCount: 2 })
  })

  it('同权重优先更窄区间，再以较低价稳定兜底', () => {
    const narrow = distribution([record(2, 500), record(3, 500), record(4, 700), record(5, 750)])
    expect(narrow.hotTrades).toMatchObject({ loCents: 500, hiCents: 500, count: 2 })
    expect(narrow.heavyHoldings).toMatchObject({ loCents: 500, hiCents: 500, qty: 200 })
    const lower = distribution([record(5, 900), record(4, 950), record(3, 700), record(2, 750)])
    expect(lower.hotTrades).toMatchObject({ loCents: 700, hiCents: 750, count: 2 })
  })

  it.each([null, -1, NaN, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])('间隔 %s 无效时只聚合同价，不发明宽度', width => {
    expect(distribution([record(2, 500), record(3, 501)], width)).toMatchObject({ widthCents: 0, hotTrades: { loCents: 500, hiCents: 500, count: 1 } })
  })

  it('一次买入回执分配多笔只算一次成交，持仓仍按各实际批次保留', () => {
    const rows = [record(2, 500, 100), record(3, 500, 200)]
    const result = distribution(rows, 50, [], [receipt('buy-op', { recordRows: [2, 3], qty: 300 })])
    expect(result).toMatchObject({ totalTradeCount: 1, totalTradeQty: 300, totalHoldingQty: 300, totalHoldingLots: 2 })
    expect(result.hotTrades).toMatchObject({ count: 1, qty: 300, sourceRows: [2, 3] })
  })

  it('卖出合并回执不因分配到多成本批次变成多次成交', () => {
    const rows = [record(2, 500, 100, { soldQty: 100, sellDateSerial: 46010 }), record(3, 600, 200, { soldQty: 200, sellDateSerial: 46010 })]
    const result = distribution(rows, 0, [], [receipt('sale-op', { kind: 'sell', recordRows: [2, 3], qty: 300, priceCents: 700 })])
    expect(result).toMatchObject({ totalTradeCount: 3, totalTradeQty: 600, totalHoldingQty: 0 })
    expect(result.levels.find(level => level.priceCents === 700)).toMatchObject({ tradeCount: 1, sellCount: 1, tradeQty: 300, tradeRows: [2, 3] })
  })

  it('回补多份分配只记一次买入，虚拟库存不额外制造成交并追溯真实卖出根', () => {
    const rows = [naked(2), naked(3)]
    const executions = [execution('a', 2), execution('b', 3)]
    const result = distribution(rows, 0, executions, [receipt('rebuy-op', { executionIds: ['a', 'b'] })])
    expect(result).toMatchObject({ totalTradeCount: 3, totalTradeQty: 400, totalHoldingQty: 200, totalHoldingLots: 2 })
    expect(result.levels.find(level => level.priceCents === 500)).toMatchObject({ tradeCount: 1, buyCount: 1, tradeQty: 200, tradeRows: [2, 3], holdingQty: 200, holdingRows: [2, 3] })
  })

  it('部分卖出的回补批次按余量统计，来源含原卖单与后续真实卖出行且不重复', () => {
    const rows = [naked(2, 200), naked(3, 100, { soldLotId: 'lot:exec:a', targetPriceCents: 650, earlyBuyPriceCents: null, sellDateSerial: 46020 })]
    const result = distribution(rows, 200, [execution('a', 2, 200)])
    expect(result).toMatchObject({ totalTradeCount: 3, totalTradeQty: 500, totalHoldingQty: 100, totalHoldingLots: 1 })
    expect(result.hotTrades).toMatchObject({ loCents: 500, hiCents: 700, count: 3, sourceRows: [2, 3] })
    expect(result.heavyHoldings).toMatchObject({ loCents: 500, qty: 100, sourceRows: [2] })
  })

  it('父记录删除后，尚存子记录与回补执行不重新冒充有效成交', () => {
    const rows = [naked(2, 200, { deletedAt: 1 }), naked(3, 100, { soldLotId: 'lot:exec:a' })]
    const result = distribution(rows, 50, [execution('a', 2, 200), execution('orphan', 999)])
    expect(result).toMatchObject({ totalTradeCount: 0, totalHoldingQty: 0, hotTrades: null, heavyHoldings: null })
  })

  it('挂钩合成高位交割不增加成交频次，已占用库存不继续算未完成买单', () => {
    const rows = [record(2, 1000), naked(3)]
    const ledger = buildLedger(rows, [stock])
    expect(ledger.sells.some(sell => sell.hedgedFromSellRow !== undefined)).toBe(true)
    const result = buildChipDistribution({ stockName: 'T', ledger, records: rows, executions: [], intervalCents: 50 })
    expect(result).toMatchObject({ totalTradeCount: 2, totalTradeQty: 200, totalHoldingQty: 0, totalHoldingLots: 0 })
  })

  it('混价回执和缺失成交价不取旧计划价或均价，排除数明确', () => {
    const rows = [record(2, 500), record(3, 550), naked(4, 100, { targetPriceCents: null })]
    const result = distribution(rows, 50, [], [receipt('mixed', { recordRows: [2, 3] })])
    expect(result).toMatchObject({ totalTradeCount: 0, excludedTradeCount: 2, totalHoldingQty: 200, hotTrades: null })
  })

  it('非法价量和跨股回执不进入区间，已撤销事实不算新成交', () => {
    const rows = [record(2, 0), record(3, 500, 1.5), record(4, 550), record(5, 550, 100, { stockName: 'U' }), record(6, 500, 100, { deletedAt: 1 })]
    const result = distribution(rows, 50, [], [receipt('bad-stock', { recordRows: [4, 5] }), receipt('void', { recordRows: [6], voidedAt: 1 })])
    expect(result).toMatchObject({ totalTradeCount: 0, excludedTradeCount: 3, totalHoldingQty: 100, totalHoldingLots: 1 })
  })

  it('改单、拆卖目标与奖励派生不改变实际成本，输入保持不变', () => {
    const rows = [record(2, 500, 300, { soldQty: 100, sellDateSerial: 46010, earlyBuyPriceCents: 450 })]
    const plans = [{ id: 'p', kind: 'sell' as const, refId: 'target:lot:2', priceCents: 999, qty: 20, at: 1 }]
    const ledger = buildLedger(rows, [stock], { plans, extraTargets: [{ id: 'split', lotId: 'lot:2', priceCents: 900, qty: 100, at: 1 }] })
    const before = JSON.stringify({ rows, ledger, plans })
    const result = buildChipDistribution({ stockName: 'T', ledger, records: rows, executions: [], intervalCents: 50 })
    expect(result.heavyHoldings).toMatchObject({ loCents: 500, hiCents: 500, qty: 200, lotCount: 1 })
    expect(result.levels.map(level => level.priceCents)).toEqual([500, 700])
    expect(JSON.stringify({ rows, ledger, plans })).toBe(before)
  })

  it('沙盒真实形式的行号保留在预览来源，不伪装成已落库记录', () => {
    const result = distribution([record(300001)])
    expect(result.hotTrades?.sourceRows).toEqual([300001])
    expect(result.heavyHoldings?.sourceRows).toEqual([300001])
  })

  it('真实62行Excel的各股股数汇总保持可追溯，缺成交价只排除该笔', async () => {
    const parsed = await parseWorkbook(new Uint8Array(readFileSync('tests/fixtures/26年网格记录.xlsx')))
    const ledger = buildLedger(parsed.records, DEFAULT_STOCKS)
    const results = DEFAULT_STOCKS.map(cfg => buildChipDistribution({ stockName: cfg.name, ledger, records: parsed.records, executions: [], intervalCents: cfg.intervalCents }))
    expect(results.reduce((sum, result) => sum + result.totalHoldingQty, 0)).toBe(15200)
    expect(results.reduce((sum, result) => sum + result.totalTradeQty, 0)).toBe(50100)
    expect(results.reduce((sum, result) => sum + result.excludedTradeCount, 0)).toBe(1)
    for (const result of results) {
      expect(result.hotTrades!.hiCents - result.hotTrades!.loCents).toBeLessThanOrEqual(result.widthCents)
      const rows = [...result.hotTrades!.sourceRows, ...(result.heavyHoldings?.sourceRows ?? [])]
      expect(rows.every(row => parsed.records.find(record => record.sourceRow === row)?.stockName === result.stockName)).toBe(true)
    }
  })
})

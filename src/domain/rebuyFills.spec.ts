import { describe, expect, it } from 'vitest'
import { buildRepairChains } from './chain'
import { buildActualRebuyFills } from './rebuyFills'
import type { Lot, RebuyExecution, SellExecution } from './types'

const lot = (sourceRow: number, qty: number, buyDate: string | null, buyPriceCents = 500): Lot => ({
  id: `lot:${sourceRow}`, sourceRow, stockId: 'stock:T', stockName: 'T', buyDate, buyPriceCents,
  qty, soldQty: 0, remainingQty: qty, targetPriceCents: 700, needsPrice: false, importKey: `r:${sourceRow}`,
})
const sale = (sourceRow: number, qty = 500, soldAt = '2026-01-01'): SellExecution => ({
  id: `sell:${sourceRow}`, sourceRow, stockId: 'stock:T', stockName: 'T', qty, soldAt,
  priceCents: 700, costCents: null, profitCents: null, dateMissing: false, priceSource: 'target',
  rebuyPriceCents: 500, rebuyStatus: 'pending', sellBeforeBuy: true, groupKey: null,
  costComplete: false, lotId: null, targetId: null,
})
const exec = (patch: Partial<RebuyExecution> = {}): RebuyExecution => ({
  id: 'e1', orderId: 'rb:sell:9', sellExecId: 'sell:9', stockId: 'stock:T', stockName: 'T',
  qty: 200, rewardQty: 0, priceCents: 550, groupKeyAtExecution: 'T|500',
  at: new Date('2026-01-03T12:00:00').getTime(), ...patch,
})

describe('实际回补来源切片', () => {
  it('同价真实买入按既有槽分配暴露切片，不跨卖出重用或填入早于卖出的批次', () => {
    const result = buildRepairChains({
      lots: [lot(2, 300, '2026-01-02'), lot(3, 400, '2026-01-03'), lot(4, 300, '2026-01-05')],
      sells: [sale(9), sale(10, 400, '2026-01-04')], executions: [],
    })
    expect(result.realCoverBySell.get(9)).toBe(500)
    expect(result.realCoverSlicesBySell.get(9)).toEqual([{ lotId: 'lot:2', qty: 300 }, { lotId: 'lot:3', qty: 200 }])
    expect(result.realCoverBySell.get(10)).toBe(300)
    expect(result.realCoverSlicesBySell.get(10)).toEqual([{ lotId: 'lot:4', qty: 300 }])
    for (const [row, qty] of result.realCoverBySell) {
      expect(result.realCoverSlicesBySell.get(row)?.reduce((sum, slice) => sum + slice.qty, 0)).toBe(qty)
    }
  })

  it('旧人工高位关联的独立真实覆盖只暴露扣除显式回补后的份额', () => {
    const high = { ...lot(2, 500, '2025-12-01', 1000), remainingQty: 0, soldQty: 500 }
    const allocated: SellExecution = { ...sale(2), id: 'sell:closed:9:2', lotId: high.id,
      costCents: 1000, profitCents: -150000, sellBeforeBuy: false, hedgedFromSellRow: 9, hedgeClosed: true, rebuyPriceCents: undefined }
    const result = buildRepairChains({ lots: [high, lot(3, 700, '2026-01-02')],
      sells: [sale(9), allocated], executions: [exec()], legacyHedgeRows: [9] })
    expect(result.realCoverBySell.get(9)).toBe(300)
    expect(result.realCoverSlicesBySell.get(9)).toEqual([{ lotId: 'lot:3', qty: 300 }])
  })

  it('同行、显式回补基础股与真实覆盖合用，金额和日期只取实际来源且总量不超卖出', () => {
    const own = lot(9, 100, '2026-01-02', 600), real = lot(3, 400, '2026-01-04', 500)
    const execution = exec({ qty: 300, rewardQty: 50 })
    const fills = buildActualRebuyFills({ sell: { ...sale(9), ownLotCoverQty: 100 },
      lotsById: new Map([own, real].map(l => [l.id, l])), executions: [execution, execution, exec({ id: 'other', sellExecId: 'sell:10' })],
      realCoverSlices: [{ lotId: real.id, qty: 400 }] })
    expect(fills).toEqual([
      { sourceLotId: 'lot:9', qty: 100, priceCents: 600, date: '2026-01-02' },
      { sourceLotId: 'lot:exec:e1', qty: 250, priceCents: 550, date: '2026-01-03' },
      { sourceLotId: 'lot:3', qty: 150, priceCents: 500, date: '2026-01-04' },
    ])
    expect(fills.reduce((sum, fill) => sum + fill.qty, 0)).toBe(500)
    expect(fills.reduce((sum, fill) => sum + fill.qty * fill.priceCents!, 0)).toBe(272500)
  })

  it('部分回补不凑满，未知日期不猜；重复真实来源不得超用该批次', () => {
    const real = lot(3, 200, null)
    const fills = buildActualRebuyFills({ sell: sale(9), lotsById: new Map([[real.id, real]]),
      executions: [exec({ qty: 100, rewardQty: 100 }), exec({ id: 'unknown-date', qty: 100, at: NaN })],
      realCoverSlices: [{ lotId: real.id, qty: 150 }, { lotId: real.id, qty: 150 }] })
    expect(fills.reduce((sum, fill) => sum + fill.qty, 0)).toBe(300)
    expect(fills.every(fill => fill.date === null)).toBe(true)
    expect(fills.filter(fill => fill.sourceLotId === real.id).reduce((sum, fill) => sum + fill.qty, 0)).toBe(200)
  })

  it('来源日期或价格无效时留空，非法数量不生成虚假成交', () => {
    const own = lot(9, 100, '2026-02-30', Infinity)
    expect(buildActualRebuyFills({ sell: { ...sale(9), ownLotCoverQty: 100 }, lotsById: new Map([[own.id, own]]), executions: [] }))
      .toEqual([{ sourceLotId: own.id, qty: 100, priceCents: null, date: null }])
    expect(buildActualRebuyFills({ sell: { ...sale(9), qty: NaN }, lotsById: new Map(), executions: [exec()] })).toEqual([])
  })
})

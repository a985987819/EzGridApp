import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { buildRepairChains } from './chain'
import type { RawRecord, RebuyExecution, RepairChainLink, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const row = (sourceRow: number, fields: Partial<RawRecord> = {}): RawRecord => ({
  sourceRow, stockName: stock.name, buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null,
  qtyNeedsDerive: false, targetPriceCents: null, targetNeedsDerive: false, soldQty: null,
  sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `chain-regression:${sourceRow}`, ...fields,
})
const high = row(1, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500,
  targetPriceCents: 700, soldQty: 500, sellDateSerial: 46010, earlyBuyPriceCents: 500 })
const execution = (id: string, sellRow: number, priceCents = 500, at = '2025-12-22T10:00:00+08:00', qty = 500): RebuyExecution => ({
  id, orderId: `rb:sell:${sellRow}`, sellExecId: `sell:${sellRow}`, stockId: stock.id, stockName: stock.name,
  qty, priceCents, rewardQty: 0, groupKeyAtExecution: `${stock.id}|${priceCents}`, at: Date.parse(at),
})
const closed = (): RepairChainLink => ({ id: 'chainlink:1', anchorRow: 1, stockName: stock.name,
  memberRows: [], closedAt: Date.parse('2025-12-22T12:00:00+08:00'), at: 1 })

describe('已归属库存的持续回本与实际成本', () => {
  it('C01：自动归属的低位库存亏着部分卖出，亏损和剩余继续留在原链，不另建亏损链', () => {
    const records = [high,
      row(2, { buyDateSerial: 46011, buyPriceCents: 500, buyQtyRaw: 500, targetPriceCents: 700 }),
      row(3, { soldLotId: 'lot:2', targetPriceCents: 400, soldQty: 300, sellDateSerial: 46012 }),
    ]
    const ledger = buildLedger(records, [stock])
    expect(ledger.repairChains).toHaveLength(1)
    expect(ledger.repairChains[0]).toMatchObject({ anchorRow: 1, lossCents: -150000,
      profitCents: -30000, netCents: -180000, holdingQty: 200 })
    const result = buildRepairChains({ ...ledger, executions: [] })
    expect(result.profitSlices.filter(slice => slice.sellId === 'sell:3')).toEqual([
      expect.objectContaining({ chainAnchor: 1, kind: 'branch', qty: 300, profitCents: -30000, costCents: 500 }),
    ])
    expect(ledger.totals.profitCents).toBe(-180000)
    expect(ledger.checks.every(check => check.ok)).toBe(true)
  })

  it('C02：普通自动关联后第二代实际回补沿已卖批次的原归属继承，不能丢失持仓', () => {
    const records = [
      row(10, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 1200 }),
      row(11, { targetPriceCents: 700, soldQty: 500, sellDateSerial: 46010, earlyBuyPriceCents: 500 }),
      row(12, { soldLotId: 'lot:exec:initial', targetPriceCents: 700, soldQty: 500,
        sellDateSerial: 46014, earlyBuyPriceCents: 500 }),
    ]
    const executions = [execution('initial', 11), execution('round2', 12, 500, '2025-12-24T10:00:00+08:00')]
    const ledger = buildLedger(records, [stock], { executions })
    expect(ledger.repairChains).toHaveLength(1)
    expect(ledger.repairChains[0]).toMatchObject({ anchorRow: 11, profitCents: 100000, holdingQty: 500 })
    const result = buildRepairChains({ ...ledger, executions })
    expect(result.profitSlices.filter(slice => slice.sellId === 'sell:12')).toEqual([
      expect.objectContaining({ chainAnchor: 11, qty: 500, profitCents: 100000 }),
    ])
    expect(ledger.checks.every(check => check.ok)).toBe(true)
  })

  it('C01：已归属的低位亏损不会吞掉另一批高位库存后来先卖后买的独立原始亏损', () => {
    const records = [high,
      row(2, { buyDateSerial: 46011, buyPriceCents: 500, buyQtyRaw: 500, targetPriceCents: 700 }),
      row(3, { soldLotId: 'lot:2', targetPriceCents: 400, soldQty: 300, sellDateSerial: 46012 }),
      row(10, { buyDateSerial: 46000, buyPriceCents: 2000, buyQtyRaw: 100, targetPriceCents: 2200 }),
      row(4, { targetPriceCents: 400, soldQty: 100, sellDateSerial: 46020, earlyBuyPriceCents: 200 }),
    ]
    const executions = [execution('independent', 4, 200, '2025-12-30T10:00:00+08:00', 100)]
    const ledger = buildLedger(records, [stock], { executions, chainLinks: [closed()] })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 1)).toMatchObject({ lossCents: -150000, profitCents: -30000 })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 4)).toMatchObject({ lossCents: -160000, holdingQty: 100 })
    expect(ledger.repairChains.reduce((sum, chain) => sum + chain.netCents, 0)).toBe(ledger.totals.profitCents)
  })

  it('C03：结束同日按实际回补时刻划界，已归属批次结束后的卖出仍累计', () => {
    const records = [high,
      row(2, { soldLotId: 'lot:exec:before', targetPriceCents: 700, soldQty: 100, sellDateSerial: 46020 }),
    ]
    const executions = [execution('before', 1, 500, '2025-12-22T11:00:00+08:00', 200),
      execution('after', 1, 500, '2025-12-22T15:00:00+08:00', 300)]
    const ledger = buildLedger(records, [stock], { executions, chainLinks: [closed()] })
    expect(ledger.repairChains[0]).toMatchObject({ profitCents: 20000, holdingQty: 100, plannedQty: 0 })
    expect(ledger.lots.find(lot => lot.id === 'lot:exec:after')?.remainingQty).toBe(300)
    expect(ledger.checks.every(check => check.ok)).toBe(true)
  })

  it('C03：第二代回补发生在结束之后，也不能从原批次重新继承', () => {
    const executions = [execution('before', 1, 500, '2025-12-22T11:00:00+08:00'),
      execution('after', 2, 500, '2025-12-22T15:00:00+08:00')]
    const records = [high, row(2, { soldLotId: 'lot:exec:before', targetPriceCents: 700,
      soldQty: 500, sellDateSerial: 46013, earlyBuyPriceCents: 500 })]
    const ledger = buildLedger(records, [stock], { executions, chainLinks: [closed()] })
    expect(ledger.repairChains[0]).toMatchObject({ profitCents: 100000, holdingQty: 0, plannedQty: 0 })
    expect(ledger.lots.find(lot => lot.id === 'lot:exec:after')?.remainingQty).toBe(500)
  })

  it('C01/C03：低位负盈利候选归回原链后，结束后另一价位的新亏损库存仍保留独立链', () => {
    const records = [high,
      row(2, { buyDateSerial: 46011, buyPriceCents: 500, buyQtyRaw: 500, targetPriceCents: 700 }),
      row(4, { soldLotId: 'lot:2', targetPriceCents: 400, soldQty: 300, sellDateSerial: 46012, earlyBuyPriceCents: 200 }),
      row(3, { buyDateSerial: 46020, buyPriceCents: 200, buyQtyRaw: 100, targetPriceCents: 400 }),
      row(6, { soldLotId: 'lot:3', targetPriceCents: 100, soldQty: 100, sellDateSerial: 46021 }),
    ]
    const ledger = buildLedger(records, [stock], { chainLinks: [closed()] })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 1)).toMatchObject({ profitCents: -30000, holdingQty: 200 })
    expect(ledger.repairChains.find(chain => chain.anchorRow === 3)).toMatchObject({ lossCents: -10000, holdingQty: 0 })
    expect(ledger.repairChains.reduce((sum, chain) => sum + chain.netCents, 0)).toBe(ledger.totals.profitCents)
  })

  it('C04：计划5元但实际5.5元回补，分支成本与节省取实际，节省不计盈利', () => {
    const executions = [execution('actual', 1, 550)]
    const ledger = buildLedger([high], [stock], { executions })
    expect(ledger.repairChains[0]).toMatchObject({ profitCents: 0, netCents: -150000, savingCents: 75000 })
    expect(ledger.repairChains[0].branches[0]).toMatchObject({ buyPriceCents: 550, savingCents: 75000 })
    expect(ledger.totals.profitCents).toBe(-150000)
  })

  it('C04：同档多实际成本按股数加权展示，节省逐份计算避免平均价取整误差', () => {
    const executions = [execution('a', 1, 550, '2025-12-22T10:00:00+08:00', 200),
      execution('b', 1, 575, '2025-12-22T11:00:00+08:00', 300)]
    const ledger = buildLedger([high], [stock], { executions })
    expect(ledger.repairChains[0].branches[0]).toMatchObject({ buyPriceCents: 565, qty: 500, savingCents: 67500 })
    expect(ledger.repairChains[0]).toMatchObject({ profitCents: 0, savingCents: 67500 })
  })

  it('C04：先卖后买的有根槽同样只按真实基础回补计算节省，不计奖励股', () => {
    const records = [row(10, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 1200 }),
      row(11, { targetPriceCents: 700, soldQty: 500, sellDateSerial: 46010, earlyBuyPriceCents: 500 })]
    const actual = { ...execution('actual', 11, 550, '2025-12-22T10:00:00+08:00', 600), rewardQty: 100 }
    const ledger = buildLedger(records, [stock], { executions: [actual] })
    expect(ledger.repairChains[0]).toMatchObject({ profitCents: 0, netCents: -150000, savingCents: 75000 })
    expect(ledger.repairChains[0].branches[0]).toMatchObject({ buyPriceCents: 550, savingCents: 75000 })
  })
})

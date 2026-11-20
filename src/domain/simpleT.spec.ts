import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { isSimpleT, simpleTProfitCents } from './simpleT'
import type { RawRecord, RebuyExecution, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const naked: RawRecord = {
  sourceRow: 9,
  stockName: 'T',
  buyDateSerial: null,
  buyPriceCents: null,
  buyQtyRaw: null,
  qtyNeedsDerive: false,
  targetPriceCents: 700,
  targetNeedsDerive: false,
  soldQty: 1000,
  sellDateSerial: 46010,
  earlyBuyPriceCents: 500,
  rawProfitCents: null,
  importKey: 'k9',
}
const exec = (id: string, qty: number, priceCents: number, rewardQty = 0, at = 1): RebuyExecution => ({
  id,
  orderId: 'rb:sell:9',
  sellExecId: 'sell:9',
  stockId: stock.id,
  stockName: 'T',
  qty,
  priceCents,
  rewardQty,
  groupKeyAtExecution: `stock:T|${priceCents}`,
  at,
})

describe('单纯做T（V9.68 多笔买入拆分）', () => {
  it('只买回一部分不算做T，仍按待回补处理', () => {
    const ledger = buildLedger([naked], [stock], { executions: [exec('e1', 400, 600)] })
    expect(isSimpleT(9, ledger)).toBe(false)
    expect(simpleTProfitCents(ledger.sells[0])).toBeNull()
    expect(ledger.sells[0].rebuyStatus).toBe('pending')
  })

  it('多笔按各自成交价算价差，买满后是单纯做T', () => {
    const ledger = buildLedger([naked], [stock], {
      executions: [exec('e1', 400, 600), exec('e2', 600, 500, 0, 2)],
    })
    expect(isSimpleT(9, ledger)).toBe(true)
    // (700 − 600) × 400 + (700 − 500) × 600
    expect(simpleTProfitCents(ledger.sells[0])).toBe(160000)
    // 不建回本链、不改写总账盈利
    expect(ledger.repairChains).toEqual([])
    expect(ledger.sells[0].profitCents).toBeNull()
  })

  it('奖励股不能顶替基础回补份额', () => {
    const ledger = buildLedger([naked], [stock], { executions: [exec('e1', 1000, 600, 200)] })
    expect(isSimpleT(9, ledger)).toBe(false)
    expect(simpleTProfitCents(ledger.sells[0])).toBeNull()
  })

  it('挂钩到高位批次的卖出不按单纯做T展示', () => {
    const high: RawRecord = {
      ...naked,
      sourceRow: 2,
      buyDateSerial: 45990,
      buyPriceCents: 1000,
      buyQtyRaw: 1000,
      soldQty: 0,
      earlyBuyPriceCents: null,
      targetPriceCents: 1200,
    }
    const ledger = buildLedger([high, naked], [stock], {
      hedges: [{ id: 'h', sellRow: 9, items: [{ row: 2, qty: 1000 }], at: 1 }],
      executions: [exec('e1', 1000, 600)],
    })
    expect(isSimpleT(9, ledger)).toBe(false)
    expect(ledger.repairChains.length).toBeGreaterThan(0)
  })
})

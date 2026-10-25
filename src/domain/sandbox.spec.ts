import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import {
  SANDBOX_ROW_BASE,
  makeSandboxItem,
  sandboxBuyInput,
  sandboxItemAtRow,
  sandboxRecords,
  sandboxSellInput,
  type SandboxItem,
} from './sandbox'
import type { HedgeLink, RawRecord, StockConfig } from './types'

const STOCK: StockConfig = {
  id: 's-liugong',
  name: '柳工',
  intervalCents: 50,
  priceLimitType: 'main_10',
}

function lot(): RawRecord {
  return {
    sourceRow: 2,
    stockName: '柳工',
    buyDateSerial: 46000,
    buyPriceCents: 1000,
    buyQtyRaw: 500,
    qtyNeedsDerive: false,
    targetPriceCents: 1100,
    targetNeedsDerive: false,
    soldQty: 0,
    sellDateSerial: null,
    earlyBuyPriceCents: null,
    rawProfitCents: null,
    importKey: 'k2',
  }
}

function sellItem(overrides: Partial<SandboxItem> = {}): SandboxItem {
  return makeSandboxItem(
    {
      kind: 'sell',
      stockName: '柳工',
      date: '2026-10-25',
      priceCents: 900,
      qty: 500,
      targetPriceCents: null,
      rebuyPriceCents: 800,
      ...overrides,
    },
    1,
  )
}

function buyItem(overrides: Partial<SandboxItem> = {}): SandboxItem {
  return makeSandboxItem(
    {
      kind: 'buy',
      stockName: '柳工',
      date: '2026-10-25',
      priceCents: 900,
      qty: 300,
      targetPriceCents: 1000,
      rebuyPriceCents: null,
      ...overrides,
    },
    2,
  )
}

describe('沙盒条目的预览行', () => {
  it('行号从 300000 起，且是稳定的 seq 映射', () => {
    const a = sellItem()
    const b = buyItem()
    expect(a.id).toMatch(/^sandbox:1:/)
    expect(sandboxRecords([a, b]).map((r) => r.sourceRow)).toEqual([SANDBOX_ROW_BASE + 1, SANDBOX_ROW_BASE + 2])
    expect(sandboxItemAtRow([a, b], SANDBOX_ROW_BASE + 2)?.kind).toBe('buy')
  })

  it('模拟待卖 = 买入批次（目标价留在待卖）', () => {
    const [rec] = sandboxRecords([buyItem()])
    expect(rec).toMatchObject({
      buyPriceCents: 900,
      buyQtyRaw: 300,
      targetPriceCents: 1000,
      soldQty: null,
      origin: 'manual',
    })
    const led = buildLedger([rec], [STOCK])
    expect(led.targets).toHaveLength(1)
    expect(led.targets[0]).toMatchObject({ priceCents: 1000, qty: 300 })
  })

  it('模拟待买 = 裸卖 + 回补价（生成待买订单）', () => {
    const [rec] = sandboxRecords([sellItem()])
    expect(rec).toMatchObject({
      buyPriceCents: null,
      targetPriceCents: 900,
      soldQty: 500,
      earlyBuyPriceCents: 800,
    })
    const led = buildLedger([rec], [STOCK])
    expect(led.orders).toHaveLength(1)
    expect(led.orders[0]).toMatchObject({ rebuyPriceCents: 800, baseQty: 500 })
  })

  it('记为成交复用「新增一笔」的字段口径', () => {
    expect(sandboxSellInput(sellItem())).toMatchObject({
      kind: 'sell',
      stockName: '柳工',
      date: '2026-10-25',
      price: '9.00',
      qty: '500',
      rebuyPrice: '8.00',
    })
    expect(sandboxBuyInput(buyItem())).toMatchObject({
      kind: 'buy',
      date: '2026-10-25',
      price: '9.00',
      qty: '300',
      targetPrice: '10.00',
    })
  })
})

describe('沙盒预演先卖后买挂钩', () => {
  it('不挂时：模拟裸卖自己按 P 列盈利，最高卖价不变', () => {
    const led = buildLedger([lot(), ...sandboxRecords([sellItem()])], [STOCK])
    expect(led.byStock[0].targetMaxPriceCents).toBe(1100)
    // (9.00 − 8.00) × 500 = +500
    expect(led.totals.profitCents).toBe(50000)
    expect(led.totals.exposureQty).toBe(500)
  })

  it('挂到 10 元批次后：批次退出待卖、最高卖价消失、已实现变成暂记亏损', () => {
    const item = sellItem()
    const hedges: HedgeLink[] = [
      { id: `sandbox-hedge:${SANDBOX_ROW_BASE + 1}`, sellRow: SANDBOX_ROW_BASE + 1, items: [{ row: 2, qty: 500 }], at: 1 },
    ]
    const led = buildLedger([lot(), ...sandboxRecords([item])], [STOCK], { hedges })
    expect(led.lots.find((l) => l.sourceRow === 2)?.remainingQty).toBe(0)
    expect(led.targets).toHaveLength(0)
    expect(led.byStock[0].targetMaxPriceCents).toBeNull()
    // (9.00 − 10.00) × 500 = −500
    expect(led.totals.profitCents).toBe(-50000)
    expect(led.sells.find((s) => s.sourceRow === SANDBOX_ROW_BASE + 1)?.hedgedHold).toBe(true)
    expect(led.totals.exposureQty).toBe(0)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('也能挂到模拟待卖的批次上：最高卖价随模拟批次一起变化', () => {
    const b = buyItem() // 9.00 买 300，目标 10.00
    const s = sellItem({ priceCents: 850, qty: 300, rebuyPriceCents: 800 })
    const hedges: HedgeLink[] = [
      { id: `sandbox-hedge:${SANDBOX_ROW_BASE + 1}`, sellRow: SANDBOX_ROW_BASE + 1, items: [{ row: SANDBOX_ROW_BASE + 2, qty: 300 }], at: 1 },
    ]
    const led = buildLedger([...sandboxRecords([b, s])], [STOCK], { hedges })
    expect(led.lots.find((l) => l.sourceRow === SANDBOX_ROW_BASE + 2)?.remainingQty).toBe(0)
    expect(led.targets).toHaveLength(0)
    expect(led.byStock[0].targetMaxPriceCents).toBeNull()
    // (8.50 − 9.00) × 300 = −150
    expect(led.totals.profitCents).toBe(-15000)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { DEFAULT_STOCKS } from './defaults'
import type { RawRecord } from './types'

let seq = 100
function rec(over: Partial<RawRecord> & { stockName: string }): RawRecord {
  seq += 1
  return {
    sourceRow: over.sourceRow ?? seq,
    buyDateSerial: 46000,
    buyPriceCents: null,
    buyQtyRaw: null,
    qtyNeedsDerive: false,
    targetPriceCents: null,
    targetNeedsDerive: false,
    soldQty: null,
    sellDateSerial: null,
    earlyBuyPriceCents: null,
    rawProfitCents: null,
    importKey: `k${seq}`,
    ...over,
  }
}

/** 一笔卖出（有买入批次、已全额卖出） */
function sellRow(stock: string, costCents: number, sellCents: number, qty: number, p: number | null, row?: number) {
  return rec({
    stockName: stock,
    sourceRow: row,
    buyPriceCents: costCents,
    buyQtyRaw: qty,
    targetPriceCents: sellCents,
    soldQty: qty,
    sellDateSerial: 46100,
    earlyBuyPriceCents: p,
  })
}

describe('奖励引擎：组池 + FIFO（R4 / R5）', () => {
  it('不足一手不加奖励：7.71 组 ¥435 < ¥771 → 0 股', () => {
    const l = buildLedger([sellRow('柳工', 771, 858, 500, 771)], DEFAULT_STOCKS)
    expect(l.totals.rewardQty).toBe(0)
  })

  it('刚好一手：profit = lotCost → 100 股', () => {
    // 成本 7.00 / 卖出 7.71 / 1000 股 → 盈 710，每手 700 → 1 手
    const l = buildLedger([sellRow('柳工', 700, 771, 1000, 700)], DEFAULT_STOCKS)
    expect(l.totals.rewardQty).toBe(100)
  })

  it('够多手：profit = 3×lotCost + 1 → 3 手 300 股', () => {
    // 成本 7.00（每手 700），盈 2101 → 3 手
    const l = buildLedger([sellRow('柳工', 700, 771, 3000, 700)], DEFAULT_STOCKS)
    expect(l.totals.rewardQty).toBe(300)
  })

  it('同股同价累计：两笔 ¥800 合成 ¥1,600 → 2 手', () => {
    const l = buildLedger(
      [sellRow('柳工', 700, 750, 1600, 700, 1), sellRow('柳工', 700, 750, 1600, 700, 2)],
      DEFAULT_STOCKS,
    )
    expect(l.groups[0].grossProfitCents).toBe(160000)
    expect(l.totals.rewardQty).toBe(200)
  })

  it('已回补的卖出不占名额，额度顺延给 open 订单', () => {
    const l = buildLedger(
      [
        // R1：有批次、P 空 → repaid，盈利 ¥1,000 仍入池
        sellRow('柳工', 781, 881, 1000, null, 1),
        // R2：无批次、P=7.81 → pending，尚未回补不计价差
        rec({ stockName: '柳工', sourceRow: 2, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781, buyPriceCents: null }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.totals.rewardQty).toBe(100)
    expect(l.orders).toHaveLength(1)
    expect(l.orders[0].rewardQty).toBe(100)
  })

  it('同股不同价不混用：7.81 与 7.86 各自成组', () => {
    const l = buildLedger(
      [sellRow('柳工', 781, 838, 1000, 781, 1), sellRow('柳工', 786, 843, 1000, 786, 2)],
      DEFAULT_STOCKS,
    )
    // 7.81 组盈 ¥570 → 0 手；7.86 组盈 ¥570 → 0 手
    expect(l.totals.rewardQty).toBe(0)
    expect(l.groups).toHaveLength(2)
  })

  it('缺成本不入池（R44 场景）', () => {
    const l = buildLedger(
      [rec({ stockName: '三一重工', buyPriceCents: 1881, buyQtyRaw: 300, soldQty: 300, targetPriceCents: null, sellDateSerial: 46265 })],
      DEFAULT_STOCKS,
    )
    expect(l.groups).toHaveLength(0)
    expect(l.totals.profitCents).toBe(0)
    expect(l.anomalies.filter((a) => a.kind === 'needsPrice')).toHaveLength(1)
  })
})

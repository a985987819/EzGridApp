/**
 * V9.26 先卖后买挂钩（H）：裸卖 → 高位批次的人工分配，纯派生语义。
 *
 * 口径（用户 2026-10-25 拍板）：
 *   挂钩期间：被挂份额退出待卖，按（卖价−买价）暂记负盈利挂到批次行上；
 *             裸卖自身盈利暂缓；全额挂住不算敞口（交割股由批次提供）。
 *   回补成交一出现：挂钩失效——批次复原、裸卖恢复按回补价结算、
 *             回补批次照常进待卖；撤销成交又自动恢复挂钩。
 *   一直不买回：暂记的负盈利就是真实亏损（计入合计盈利）。
 */
import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import type { HedgeLink, RawRecord, RebuyExecution, StockConfig } from './types'

const STOCK: StockConfig = {
  id: 's-liugong',
  name: '柳工',
  intervalCents: 50,
  priceLimitType: 'main_10',
}

/** 高位批次：10 元买 500 股，目标 11；裸卖：7 元卖 500 股，P 列回补价 6.5 */
function records(): RawRecord[] {
  return [
    {
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
    },
    {
      sourceRow: 3,
      stockName: '柳工',
      buyDateSerial: null,
      buyPriceCents: null,
      buyQtyRaw: null,
      qtyNeedsDerive: false,
      targetPriceCents: 700,
      targetNeedsDerive: false,
      soldQty: 500,
      sellDateSerial: 46010,
      earlyBuyPriceCents: 650,
      rawProfitCents: null,
      importKey: 'k3',
    },
  ]
}

const LINK: HedgeLink = { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 500 }], at: 0 }

describe('先卖后买挂钩（V9.26）', () => {
  it('不挂钩时维持原口径：裸卖计敞口、自身按 P 列成本记账', () => {
    const led = buildLedger(records(), [STOCK])
    const order = led.orders.find((o) => o.sourceRow === 3)
    expect(order?.exposure).toBe(true)
    expect(led.totals.exposureQty).toBe(500)
    // 裸卖盈利 =（7 − 6.5）× 500 = +250 元
    expect(led.sells.find((s) => s.sourceRow === 3)?.profitCents).toBe(25000)
    expect(led.totals.profitCents).toBe(25000)
    expect(led.lots.find((l) => l.sourceRow === 2)?.remainingQty).toBe(500)
  })

  it('挂钩期间：批次暂记卖出、负盈利进合计、裸卖盈利暂缓、敞口清零、守恒式全绿', () => {
    const led = buildLedger(records(), [STOCK], { hedges: [LINK] })
    // 批次：500 股全部退出待卖
    const lot = led.lots.find((l) => l.sourceRow === 2)
    expect(lot?.remainingQty).toBe(0)
    expect(lot?.soldQty).toBe(500)
    expect(led.targets.filter((t) => t.lotId === 'lot:2')).toHaveLength(0)
    // 暂记卖出挂到批次行：盈利 =（7 − 10）× 500 = −1,500 元
    const hedged = led.sells.find((s) => s.id === 'sell:hedged:3:2')
    expect(hedged).toMatchObject({ sourceRow: 2, qty: 500, priceCents: 700, costCents: 1000, profitCents: -150000 })
    // 裸卖自身盈利暂缓
    const naked = led.sells.find((s) => s.sourceRow === 3)
    expect(naked?.profitCents).toBeNull()
    expect(naked?.hedgedHold).toBe(true)
    // 合计：卖出量不重复计（仍 500），盈利按暂记 −1,500
    expect(led.totals.sellQty).toBe(500)
    expect(led.totals.sellCount).toBe(1)
    expect(led.totals.profitCents).toBe(-150000)
    // 净持仓不变（没发生真实交易），敞口清零（交割股由批次提供）
    expect(led.totals.netQty).toBe(0)
    expect(led.totals.exposureQty).toBe(0)
    expect(led.checks.every((c) => c.ok)).toBe(true)
    // 暂记不进组池（P4 的额度只认真实卖出）
    expect(led.groups).toHaveLength(0)
    // 日历口径：当天盈利 −1,500，卖出量不重复计
    expect(led.daily.reduce((a, d) => a + d.profitCents, 0)).toBe(-150000)
    expect(led.daily.reduce((a, d) => a + d.sellQty, 0)).toBe(500)
  })

  it('回补成交后挂钩自动失效：批次复原、裸卖按回补价结算、回补批次进待卖', () => {
    const exec: RebuyExecution = {
      id: 'exec:rb:sell:3:1',
      orderId: 'rb:sell:3',
      sellExecId: 'sell:3',
      stockId: STOCK.id,
      stockName: STOCK.name,
      qty: 500,
      priceCents: 650,
      rewardQty: 0,
      groupKeyAtExecution: `${STOCK.id}|650`,
      at: 46020,
    }
    const led = buildLedger(records(), [STOCK], { hedges: [LINK], executions: [exec] })
    // 挂钩失效：批次复原
    const lot = led.lots.find((l) => l.sourceRow === 2)
    expect(lot?.remainingQty).toBe(500)
    expect(led.sells.find((s) => s.id === 'sell:hedged:3:2')).toBeUndefined()
    // 裸卖恢复按 P 列结算：+250 元；高位批次回原目标 11
    const naked = led.sells.find((s) => s.sourceRow === 3)
    expect(naked?.profitCents).toBe(25000)
    expect(naked?.hedgedHold).toBeUndefined()
    expect(led.targets.find((t) => t.lotId === 'lot:2')?.priceCents).toBe(1100)
    // 回补批次 6.5 × 500 进待卖，目标 = 6.5 + 0.5 = 7
    const vl = led.lots.find((l) => l.id.startsWith('lot:exec:'))
    expect(vl).toMatchObject({ buyPriceCents: 650, qty: 500 })
    expect(led.targets.find((t) => t.lotId === vl?.id)?.priceCents).toBe(700)
    // 盈利回到 +250，守恒式全绿
    expect(led.totals.profitCents).toBe(25000)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('超挂截断 + 挂不满标异常、差额仍按敞口计（守恒式亮红灯）', () => {
    const over: HedgeLink = { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 600 }], at: 0 }
    const led = buildLedger(records(), [STOCK], { hedges: [over] })
    expect(led.anomalies.some((a) => a.kind === 'hedgeOverflow')).toBe(true)
    // 截到 500 = 卖出量 → 恰好全额挂住，不算 mismatch
    expect(led.totals.exposureQty).toBe(0)

    const partial: HedgeLink = { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 300 }], at: 0 }
    const led2 = buildLedger(records(), [STOCK], { hedges: [partial] })
    expect(led2.anomalies.some((a) => a.kind === 'hedgeMismatch')).toBe(true)
    // 敞口按差额计（挂住的 300 已由批次交割）：500 − 300 = 200，守恒式仍平衡
    expect(led2.totals.exposureQty).toBe(200)
    expect(led2.checks.find((c) => c.name.includes('待卖量 − 待补敞口'))?.ok).toBe(true)
  })

  it('挂到已卖过/别的股票的批次 → hedgeInvalid，什么都不动', () => {
    const bad: HedgeLink = { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 0 }], at: 0 }
    const led = buildLedger(records(), [STOCK], { hedges: [bad] })
    // qty 0 直接跳过（applied 0，不置 hedgedHold、不算 mismatch）
    expect(led.lots.find((l) => l.sourceRow === 2)?.remainingQty).toBe(500)
    expect(led.sells.find((s) => s.sourceRow === 3)?.hedgedHold).toBeUndefined()

    const wrongRow: HedgeLink = { id: 'hedge:3', sellRow: 3, items: [{ row: 99, qty: 500 }], at: 0 }
    const led2 = buildLedger(records(), [STOCK], { hedges: [wrongRow] })
    expect(led2.anomalies.some((a) => a.kind === 'hedgeInvalid')).toBe(true)
    expect(led2.totals.exposureQty).toBe(500)
  })
})

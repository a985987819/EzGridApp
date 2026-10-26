/**
 * V9.26 先卖后买挂钩（H）：裸卖 → 高位批次的人工分配，纯派生语义。
 *
 * 口径（用户 2026-10-25 拍板，V9.36 修订）：
 *   挂钩期间：被挂份额退出待卖，按（卖价−买价）暂记负盈利挂到批次行上；
 *             裸卖自身盈利暂缓；全额挂住不算敞口（交割股由批次提供）。
 *   回补一部分：**那部分永久了结**——高位批次不再复活（否则 10 元批次 + 6 元回补
 *             批次会双算成 1000 股），按卖出价记下的亏损留在合计盈利里，交给
 *             「回本链」用后续归属交易的已实现净盈利逐笔冲抵（V9.46）；还没买回的那截继续挂着。
 *   全部买回：整批了结，只剩回补批次在待卖，实物股数对得上。
 *   一直不买回：暂记的负盈利就是真实亏损（计入合计盈利）。
 */
import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { isHedgeable } from './hedge'
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

describe('可挂判定（V9.32：与有没有待买订单解耦；V9.33：部分买回仍可挂）', () => {
  it('裸卖 + 还有没买回的股数 → 可挂（P 列空也算，因为不看订单）', () => {
    expect(isHedgeable({ buyPriceCents: null, soldQty: 500 }, 0)).toBe(true)
    // 有买入批次 → 不是裸卖
    expect(isHedgeable({ buyPriceCents: 1000, soldQty: 500 }, 0)).toBe(false)
    // 没有卖出量
    expect(isHedgeable({ buyPriceCents: null, soldQty: 0 }, 0)).toBe(false)
    // 买回了一部分：剩下的还能挂
    expect(isHedgeable({ buyPriceCents: null, soldQty: 500 }, 100)).toBe(true)
    // 全部买回 → 挂钩自动解除，不再给入口
    expect(isHedgeable({ buyPriceCents: null, soldQty: 500 }, 500)).toBe(false)
  })
})

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

  it('回补后高位批次永久了结、不复活：待卖只剩回补批次，股数对得上（V9.36）', () => {
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
    // 高位批次 500 股全部了结：剩余 0、退出待卖（不再复活成另一笔 500 股待卖）
    const lot = led.lots.find((l) => l.sourceRow === 2)
    expect(lot?.remainingQty).toBe(0)
    expect(lot?.soldQty).toBe(500)
    expect(led.targets.filter((t) => t.lotId === 'lot:2')).toHaveLength(0)
    // 了结卖出挂到批次行：7.00 卖 / 10.00 成本 → −1,500，且标 hedgeClosed
    const closed = led.sells.find((s) => s.id === 'sell:closed:3:2')
    expect(closed).toMatchObject({ sourceRow: 2, qty: 500, profitCents: -150000, hedgeClosed: true })
    // 没有「暂记」那一截了（全部买回）
    expect(led.sells.find((s) => s.id === 'sell:hedged:3:2')).toBeUndefined()
    // 裸卖自身盈利仍暂缓（股份由批次交割）
    const naked = led.sells.find((s) => s.sourceRow === 3)
    expect(naked?.profitCents).toBeNull()
    expect(naked?.hedgedHold).toBe(true)
    // 回补批次 6.5 × 500 进待卖，目标 = 6.5 + 0.5 = 7；待卖合计 500（不是 1000）
    const vl = led.lots.find((l) => l.id.startsWith('lot:exec:'))
    expect(vl).toMatchObject({ buyPriceCents: 650, qty: 500 })
    expect(led.targets.find((t) => t.lotId === vl?.id)?.priceCents).toBe(700)
    expect(led.totals.targetQty).toBe(500)
    expect(led.totals.netQty).toBe(500)
    expect(led.totals.exposureQty).toBe(0)
    // 合计盈利：留着了结那笔 −1,500（不是复原成 +250）
    expect(led.totals.profitCents).toBe(-150000)
    expect(led.checks.every((c) => c.ok)).toBe(true)
    // 回本链（V9.46）：7.00 了结即成链，亏 −1,500 全挂在链上；回补 6.50 的 0.50/股
    // 只是「回补节省」，那 500 股还没再卖出 → 进度 0，还差 1,500
    expect(led.repairChains).toHaveLength(1)
    const chain = led.repairChains[0]
    expect(chain).toMatchObject({
      anchorRow: 2,
      anchorQty: 500,
      anchorCostCents: 1000,
      closedAtCents: 700,
      lossCents: -150000,
      profitCents: 0,
      netCents: -150000,
      savingCents: 25000,
      gapCents: 150000,
      done: false,
      holdingQty: 500,
      plannedQty: 0,
      relatedSellRows: [3],
    })
    expect(chain.branches).toHaveLength(1)
    expect(chain.branches[0]).toMatchObject({
      kind: 'rebuy',
      row: null,
      buyPriceCents: 650,
      qty: 500,
      remainingQty: 500,
      sellQty: 0,
      profitCents: 0,
      savingCents: 25000,
      allocatedLossCents: -150000,
    })
  })

  it('用户场景：10 买 500 挂 7 卖 500，6 回补 → 只记 6 买 7 卖，高位那笔不再回来（V9.36）', () => {
    // 回补价改成 6.00（差 1 元/股）
    const exec: RebuyExecution = {
      id: 'exec:rb:sell:3:1',
      orderId: 'rb:sell:3',
      sellExecId: 'sell:3',
      stockId: STOCK.id,
      stockName: STOCK.name,
      qty: 500,
      priceCents: 600,
      rewardQty: 0,
      groupKeyAtExecution: `${STOCK.id}|600`,
      at: 46020,
    }
    const led = buildLedger(records(), [STOCK], { hedges: [LINK], executions: [exec] })
    // 高位 10 元批次彻底离场，账上只剩回补的 500 股（成本 6，目标 6.5）
    expect(led.lots.find((l) => l.sourceRow === 2)?.remainingQty).toBe(0)
    const vl = led.lots.find((l) => l.id.startsWith('lot:exec:'))
    expect(vl).toMatchObject({ buyPriceCents: 600, qty: 500 })
    expect(led.targets.find((t) => t.lotId === vl?.id)?.priceCents).toBe(650)
    expect(led.totals.targetQty).toBe(500)
    expect(led.totals.netQty).toBe(500)
    // 已实现：−1,500（10 元按 7 元了结）；6 元回补省下的 1.00/股只算「回补节省」
    expect(led.totals.profitCents).toBe(-150000)
    const chain = led.repairChains[0]
    expect(chain).toMatchObject({
      lossCents: -150000,
      profitCents: 0,
      savingCents: 50000,
      gapCents: 150000,
      holdingQty: 500,
      done: false,
    })
    // 结构上：gapCents 要靠这 500 股真的高价卖出兑现才归零
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('编辑补上买入价（行不再是裸卖）→ 绑定自动失效，先卖 + 后买回归一笔正常订单', () => {
    // 用户口径：这笔先卖后买「编辑完成买入」后，取消与高位的绑定
    const edited = records().map((r) =>
      r.sourceRow === 3 ? { ...r, buyPriceCents: 650, buyQtyRaw: 500, buyDateSerial: 46005 } : r,
    )
    const led = buildLedger(edited, [STOCK], { hedges: [LINK] })
    // 高位批次没被挂走：仍 500 股待卖、目标还是 11
    const lot2 = led.lots.find((l) => l.sourceRow === 2)
    expect(lot2?.remainingQty).toBe(500)
    expect(lot2?.soldQty).toBe(0)
    expect(led.sells.filter((s) => s.hedgedFromSellRow !== undefined)).toHaveLength(0)
    expect(led.targets.find((t) => t.lotId === 'lot:2')?.priceCents).toBe(1100)
    // 第 3 行自己成了批次：买 6.5 × 500，已卖 500 → 盈利 (7 − 6.5) × 500 = +250 元
    const lot3 = led.lots.find((l) => l.sourceRow === 3)
    expect(lot3).toMatchObject({ buyPriceCents: 650, qty: 500, remainingQty: 0 })
    const s3 = led.sells.find((s) => s.sourceRow === 3)
    expect(s3?.hedgedHold).toBeUndefined()
    expect(s3?.profitCents).toBe(25000)
    expect(led.totals.profitCents).toBe(25000)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('V9.33/V9.36 部分买回：买回那截永久了结，剩下 400 继续挂着', () => {
    // 挂 500 到 10.00 的批次；只买回 100 @6.50 → 100 股了结（−300），400 继续挂（暂记 −1,200）
    const exec: RebuyExecution = {
      id: 'exec:rb:sell:3:1',
      orderId: 'rb:sell:3',
      sellExecId: 'sell:3',
      stockId: STOCK.id,
      stockName: STOCK.name,
      qty: 100,
      priceCents: 650,
      rewardQty: 0,
      groupKeyAtExecution: `${STOCK.id}|650`,
      at: 46020,
    }
    const led = buildLedger(records(), [STOCK], { hedges: [LINK], executions: [exec] })
    // 批次 500 股全部离场（400 挂住 + 100 了结），不会留 100 股给自己
    const lot = led.lots.find((l) => l.sourceRow === 2)
    expect(lot?.remainingQty).toBe(0)
    expect(led.sells.find((s) => s.id === 'sell:hedged:3:2')).toMatchObject({ qty: 400, profitCents: -120000 })
    expect(led.sells.find((s) => s.id === 'sell:closed:3:2')).toMatchObject({
      qty: 100,
      profitCents: -30000,
      hedgeClosed: true,
    })
    // 裸卖：全部由批次交割，自身不再按 P 列记盈利
    const naked = led.sells.find((s) => s.sourceRow === 3)
    expect(naked?.profitCents).toBeNull()
    expect(naked?.hedgedHold).toBe(true)
    // 待卖只剩回补的 100 股；没买回的 400 已挂住 → 无敞口
    expect(led.totals.targetQty).toBe(100)
    expect(led.totals.netQty).toBe(100)
    expect(led.totals.exposureQty).toBe(0)
    expect(led.totals.profitCents).toBe(-150000)
    expect(led.anomalies.filter((a) => a.kind === 'hedgeMismatch' || a.kind === 'hedgeOverflow')).toHaveLength(0)
    expect(led.checks.every((c) => c.ok)).toBe(true)
    // 链只认「已了结」的 100 股：亏 −300；回补的 100 股还没再卖出 → 进度 0，节省 +50
    const chain = led.repairChains[0]
    expect(chain).toMatchObject({
      anchorQty: 100,
      lossCents: -30000,
      profitCents: 0,
      savingCents: 5000,
      gapCents: 30000,
      holdingQty: 100,
    })
  })

  it('V9.33 只挂一部分（没买回）：差额仍算敞口并标 hedgeMismatch，守恒式仍平', () => {
    const partial: HedgeLink = { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 300 }], at: 0 }
    const led = buildLedger(records(), [STOCK], { hedges: [partial] })
    expect(led.lots.find((l) => l.sourceRow === 2)?.remainingQty).toBe(200)
    // 没挂的 200 股照旧按 P 列：(7−6.5)×200 = +100
    expect(led.sells.find((s) => s.sourceRow === 3)?.profitCents).toBe(10000)
    expect(led.sells.find((s) => s.sourceRow === 3)?.hedgedHold).toBeUndefined()
    expect(led.anomalies.some((a) => a.kind === 'hedgeMismatch')).toBe(true)
    expect(led.totals.exposureQty).toBe(200)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('两张裸卖挂同一批次：可挂量不被重复扣减（V9.32 修）', () => {
    // 批次 500 股；裸卖 A 挂 200、裸卖 B 挂 300，合计正好 500 → 两张都该全额生效
    const recs = records()
    recs.push({
      sourceRow: 4,
      stockName: '柳工',
      buyDateSerial: null,
      buyPriceCents: null,
      buyQtyRaw: null,
      qtyNeedsDerive: false,
      targetPriceCents: 700,
      targetNeedsDerive: false,
      soldQty: 300,
      sellDateSerial: 46011,
      earlyBuyPriceCents: 650,
      rawProfitCents: null,
      importKey: 'k4',
    })
    // 原来的裸卖 500 股改成 200 股，两张挂 200 + 300 = 500
    const base = records().map((r) => (r.sourceRow === 3 ? { ...r, soldQty: 200 } : r))
    const hedges: HedgeLink[] = [
      { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 200 }], at: 1 },
      { id: 'hedge:4', sellRow: 4, items: [{ row: 2, qty: 300 }], at: 2 },
    ]
    const led = buildLedger([...base, recs[recs.length - 1]], [STOCK], { hedges })
    const lot = led.lots.find((l) => l.sourceRow === 2)
    expect(lot?.remainingQty).toBe(0)
    expect(lot?.soldQty).toBe(500)
    expect(led.anomalies.filter((a) => a.kind === 'hedgeOverflow' || a.kind === 'hedgeMismatch')).toHaveLength(0)
    // 两笔暂记：（7−10）×（200 + 300）= −1,500 元
    expect(led.sells.filter((s) => s.hedgedFromSellRow !== undefined).map((s) => s.qty).sort()).toEqual([200, 300])
    expect(led.totals.profitCents).toBe(-150000)
    expect(led.totals.exposureQty).toBe(0)
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

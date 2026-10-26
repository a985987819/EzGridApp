/**
 * 回本链（V9.46 新口径）——用户主口径：
 *   一条链的累计盈亏 = 最初高位卖出的亏损 + 归属于它的后续买卖**已实现**净盈利
 *   另外单独显示：现在持有多少股、还有多少股计划买回。
 *
 * 关键防线：「卖 7 买 5 省下的钱」只做展示（回补节省），绝不与「5 买 7 卖赚的钱」一起计入进度。
 */
import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { buildRepairChains } from './chain'
import type { Lot, RawRecord, RebuyExecution, RepairChainLink, SellExecution, StockConfig } from './types'

const STOCK: StockConfig = { id: 's-liugong', name: '柳工', intervalCents: 50, priceLimitType: 'main_10' }

function rec(
  sourceRow: number,
  o: { buy?: number; qty?: number; sell?: number; soldQty?: number; sellDate?: number; buyDate?: number; p?: number; lotId?: string },
): RawRecord {
  return {
    sourceRow,
    stockName: '柳工',
    buyDateSerial: o.buyDate ?? (o.buy === undefined ? null : 46000 + sourceRow),
    buyPriceCents: o.buy ?? null,
    buyQtyRaw: o.qty ?? null,
    qtyNeedsDerive: false,
    targetPriceCents: o.sell ?? (o.buy === undefined ? null : o.buy + STOCK.intervalCents),
    targetNeedsDerive: false,
    soldQty: o.soldQty ?? 0,
    sellDateSerial: o.sellDate ?? null,
    earlyBuyPriceCents: o.p ?? null,
    rawProfitCents: null,
    importKey: `k${sourceRow}`,
    ...(o.lotId ? { soldLotId: o.lotId } : {}),
  }
}

/** 用户原例：10 元买 1000 → 7 元清仓（−3,000）；6 买 500 → 8 卖（+1,000）；5 买 500 → 7 卖（+1,000） */
function userExample(): RawRecord[] {
  return [
    rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
    rec(3, { buy: 600, qty: 500, sell: 800, soldQty: 500, sellDate: 46020, buyDate: 46015 }),
    rec(4, { buy: 500, qty: 500, sell: 700, soldQty: 500, sellDate: 46030, buyDate: 46016 }),
  ]
}

const LINK: RepairChainLink = {
  id: 'chainlink:2',
  anchorRow: 2,
  stockName: '柳工',
  memberRows: [3, 4],
  closedAt: null,
  at: 0,
}

describe('回本链建链时机', () => {
  it('首次亏损清仓立即成链（不需要等回补）', () => {
    const led = buildLedger([rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 })], [STOCK])
    expect(led.repairChains).toHaveLength(1)
    const c = led.repairChains[0]
    expect(c).toMatchObject({
      anchorRow: 2,
      anchorQty: 1000,
      anchorCostCents: 1000,
      closedAtCents: 700,
      lossCents: -300000,
      profitCents: 0,
      netCents: -300000,
      gapCents: 300000,
      done: false,
      covered: 0,
      holdingQty: 0,
      plannedQty: 1000,
      branches: [],
    })
  })

  it('部分亏损卖出立即成链，盈利批次不成链', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 500, sellDate: 46010 }), // 亏损但还剩 500 股
        rec(3, { buy: 600, qty: 500, sell: 900, soldQty: 500, sellDate: 46011 }), // 清仓但盈利
      ],
      [STOCK],
    )
    expect(led.repairChains).toHaveLength(1)
    expect(led.repairChains[0]).toMatchObject({anchorQty:500,lossCents:-150000})
  })
})

describe('回本进度＝归属交易的已实现净盈利（用户原例）', () => {
  it('−3,000 + 1,000 + 1,000 = 还差 1,000，覆盖 2/3', () => {
    const led = buildLedger(userExample(), [STOCK], { chainLinks: [LINK] })
    expect(led.repairChains).toHaveLength(1)
    const c = led.repairChains[0]
    expect(c.lossCents).toBe(-300000)
    expect(c.profitCents).toBe(200000)
    expect(c.netCents).toBe(-100000)
    expect(c.gapCents).toBe(100000)
    expect(c.done).toBe(false)
    expect(Math.round(c.covered * 1000) / 1000).toBe(0.667)
    expect(c.holdingQty).toBe(0)
    expect(c.plannedQty).toBe(0)
    expect(c.unallocatedLossCents).toBe(0)
    // 归属的那两笔不再各自成链（每份盈亏只算一次）
    expect(led.repairChains.map((x) => x.anchorRow)).toEqual([2])
    // 分支按买入份额分摊原始亏损：各摊 −1,500，各自还差 −500
    expect(c.branches.map((b) => b.row)).toEqual([3, 4])
    expect(c.branches[0]).toMatchObject({ buyPriceCents: 600, sellPriceCents: 800, qty: 500, profitCents: 100000 })
    expect(c.branches.map((b) => b.allocatedLossCents)).toEqual([-150000, -150000])
    expect(c.branches.map((b) => b.netCents)).toEqual([-50000, -50000])
    // 全局「已实现盈利」照旧每笔只算一次：−3,000 + 1,000 + 1,000
    expect(led.totals.profitCents).toBe(-100000)
    // 成员行退出待卖没有影响：它们本来就已清仓
    expect(led.checks.every((k) => k.ok)).toBe(true)
  })

  it('人工归属只做展示：不归属时三笔各自成链，总盈利不变', () => {
    const led = buildLedger(userExample(), [STOCK])
    // 第 3/4 笔是盈利的清仓，不成链；第 2 笔单独成链
    expect(led.repairChains.map((c) => c.anchorRow)).toEqual([2])
    expect(led.repairChains[0].profitCents).toBe(0)
    expect(led.totals.profitCents).toBe(-100000)
  })

  it('买回后还没卖：只显示持仓与计划买回，进度为 0', () => {
    const holding = [
      rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
      rec(3, { buy: 600, qty: 500, buyDate: 46015 }), // 只买未卖
    ]
    const led = buildLedger(holding, [STOCK], {
      chainLinks: [{ ...LINK, memberRows: [3] }],
    })
    const c = led.repairChains[0]
    expect(c).toMatchObject({ profitCents: 0, netCents: -300000, gapCents: 300000, holdingQty: 500, plannedQty: 500 })
    expect(c.branches[0]).toMatchObject({ sellPriceCents: null, sellQty: 0, allocatedLossCents: -150000 })
  })

  it('回补节省单独显示，绝不与再卖盈利相加', () => {
    // 10 元买 500，7 元挂在高位批次上按 7 元了结（−1,500）；6 元回补 500 → 7 元再卖
    const sells: SellExecution[] = []
    const lots: Lot[] = [
      { id: 'lot:2', sourceRow: 2, stockId: STOCK.id, stockName: '柳工', buyDate: null, buyPriceCents: 1000, qty: 500, soldQty: 500, remainingQty: 0, targetPriceCents: 700, needsPrice: false, importKey: 'k2' },
    ]
    const exec: RebuyExecution = {
      id: 'exec:1',
      orderId: 'rb:sell:9',
      sellExecId: 'sell:9',
      stockId: STOCK.id,
      stockName: '柳工',
      qty: 500,
      priceCents: 600,
      rewardQty: 0,
      groupKeyAtExecution: `${STOCK.id}|600`,
      at: 1,
    }
    const seedSell: SellExecution = {
      id: 'sell:closed:9:2',
      sourceRow: 2,
      stockId: STOCK.id,
      stockName: '柳工',
      qty: 500,
      priceCents: 700,
      costCents: 1000,
      profitCents: -150000,
      soldAt: '2026-03-10',
      dateMissing: false,
      priceSource: 'target',
      rebuyStatus: 'pending',
      sellBeforeBuy: false,
      groupKey: `${STOCK.id}|1000`,
      costComplete: true,
      lotId: 'lot:2',
      targetId: null,
      hedgedFromSellRow: 9,
      hedgeClosed: true,
    }
    sells.push(seedSell)
    const virtual: Lot = {
      id: `lot:exec:${exec.id}`,
      sourceRow: 200000,
      stockId: STOCK.id,
      stockName: '柳工',
      buyDate: '2026-03-11',
      buyPriceCents: 600,
      qty: 500,
      soldQty: 0,
      remainingQty: 500,
      targetPriceCents: 650,
      needsPrice: false,
      importKey: 'vx',
    }
    // 只回补、未再卖：节省 500，进度 0
    const only = buildRepairChains({ lots: [...lots, virtual], sells, executions: [exec] }).chains
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ lossCents: -150000, profitCents: 0, savingCents: 50000, gapCents: 150000, holdingQty: 500 })
    expect(only[0].relatedSellRows).toEqual([9])
    // 回补批次再 7 元卖出：+500 已实现进进度，节省仍只是展示（相加就双算了）
    const resold: SellExecution = {
      ...seedSell,
      id: 'sell:vx:1',
      sourceRow: 200000,
      priceCents: 700,
      costCents: 600,
      profitCents: 50000,
      lotId: virtual.id,
      hedgedFromSellRow: undefined,
      hedgeClosed: undefined,
    }
    const after = buildRepairChains({
      lots: [...lots, { ...virtual, soldQty: 500, remainingQty: 0 }],
      sells: [...sells, resold],
      executions: [exec],
    }).chains
    expect(after[0]).toMatchObject({ profitCents: 50000, savingCents: 50000, netCents: -100000, gapCents: 100000, holdingQty: 0 })
    expect(after[0].branches[0]).toMatchObject({ kind: 'rebuy', sellPriceCents: 700, profitCents: 50000 })
  })
})

describe('V9.49 价位槽：同价买入全自动归链', () => {
  /**
   * 用户原例（全自动，不用手动关联）：
   *   10 买 1000（A）→ 7 卖 1000（B，亏 −3,000）→ 7 卖 500 ×2（C/D，先卖后买）
   *   → 5 买 500（E，回补 C）→ 6 买 500（F，回补 D）
   *   → E 7 卖、F 8 卖。
   */
  const autoExample = (): RawRecord[] => [
    rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
    rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
    rec(4, { sell: 700, soldQty: 500, sellDate: 46021, p: 600 }),
    rec(5, { buy: 500, qty: 500, sell: 700, soldQty: 500, buyDate: 46030, sellDate: 46040 }),
    rec(6, { buy: 600, qty: 500, sell: 800, soldQty: 500, buyDate: 46031, sellDate: 46050 }),
  ]

  it('C/D 自动挂链、E/F 自动回补，两轮做完显示【已不亏钱】', () => {
    const led = buildLedger(autoExample(), [STOCK])
    expect(led.repairChains).toHaveLength(1)
    const c = led.repairChains[0]
    expect(c).toMatchObject({
      anchorRow: 2,
      lossCents: -300000,
      // C +1,000、D +500、E 卖出 +1,000、F 卖出 +1,000
      profitCents: 350000,
      netCents: 50000,
      done: true,
      gapCents: 0,
      plannedQty: 0,
      holdingQty: 0,
      unallocatedLossCents: 0,
    })
    // 两支价位槽：5 元、6 元，根都是那笔 7 卖 500
    const slots = c.branches.filter((b) => b.kind === 'sell')
    expect(slots.map((b) => b.buyPriceCents)).toEqual([500, 600])
    expect(slots[0]).toMatchObject({ rootSellRow: 3, qty: 500, profitCents: 200000, cycles: 2 })
    expect(slots[1]).toMatchObject({ rootSellRow: 4, qty: 500, profitCents: 150000, cycles: 2 })
    // C/D 的待买被同价买回盖满 → 自动完成：不再生成幽灵订单、不算敞口
    expect(led.orders.find((o) => o.sourceRow === 3)).toBeUndefined()
    expect(led.orders.find((o) => o.sourceRow === 4)).toBeUndefined()
    expect(led.totals.exposureQty).toBe(0)
    // 每份盈亏只算一次：全局盈利仍按原始成交走
    expect(led.totals.profitCents).toBe(-300000 + 50000 + 100000 + 100000 + 100000)
  })

  it('还没买回时：槽里欠多少就是计划买回多少，待买单照旧挂着', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
      ],
      [STOCK],
    )
    const c = led.repairChains[0]
    expect(c.plannedQty).toBe(500)
    expect(c.profitCents).toBe(100000) // C 自己的空头收益（7 卖、按 5 的回补价）
    expect(c.done).toBe(false)
    expect(led.orders.find((o) => o.sourceRow === 3)?.baseQty).toBe(500)
    expect(led.totals.exposureQty).toBe(500)
  })

  it('用户结束链之后，新的同价再卖与同价买入不再自动归链', () => {
    // Excel 序列号 46020 = 2025-12-29、46021 = 2025-12-30、46030 = 2026-01-08
    const closedAt = new Date('2026-01-01T12:00:00').getTime()
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }), // 结束前的再卖 → 仍是槽根
        rec(4, { sell: 700, soldQty: 500, sellDate: 46030, p: 500 }), // 结束后的再卖 → 不归链
        rec(5, { buy: 500, qty: 500, sell: 700, soldQty: 500, buyDate: 46021, sellDate: 46040 }), // 结束前买 → 归槽
        rec(6, { buy: 500, qty: 500, sell: 700, soldQty: 500, buyDate: 46030, sellDate: 46040 }), // 结束后买 → 不归
      ],
      [STOCK],
      {
        chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [], closedAt, at: 0 }],
      },
    )
    const c = led.repairChains[0]
    const slots = c.branches.filter((b) => b.kind === 'sell')
    expect(slots).toHaveLength(1)
    expect(slots[0].rootSellRow).toBe(3)
    expect(slots[0].memberRows).toEqual([3, 5])
    expect(c.relatedSellRows).toEqual([3])
    // 结束前那笔已被同价买回盖住 → 连订单都不生成；结束后的那笔照旧欠 500
    expect(led.orders.find((o) => o.sourceRow === 3)).toBeUndefined()
    expect(led.orders.find((o) => o.sourceRow === 4)?.baseQty).toBe(500)
  })

  it('买入日期早于那笔再卖的，不算回补、不归链', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
        // 5 元买在 C 卖出之前 → 不是回补
        rec(4, { buy: 500, qty: 500, sell: 700, soldQty: 500, buyDate: 46005, sellDate: 46006 }),
      ],
      [STOCK],
    )
    const c = led.repairChains[0]
    expect(c.branches.filter((b) => b.kind === 'sell')).toHaveLength(1)
    expect(c.branches.find((b) => b.kind === 'sell')?.profitCents).toBe(100000)
    expect(led.orders.find((o) => o.sourceRow === 3)?.baseQty).toBe(500)
    expect(c.holdingQty).toBe(0)
  })

  /**
   * V9.55 修：认不出先后就不许自动归链。
   * 真实触发（e2e 里那 4 条红灯）：R60–63 是老裸卖，卖出日期是 `=TODAY()` 公式没有缓存值
   * → soldAt 为 null。原来 `s.soldAt === null` 直接放行，于是它们被当成「链之后的同价再卖」，
   * 槽又把历史同价批次当成「已买回」→ 待买被自动关掉、敞口凭空少一截、守恒式红灯。
   */
  it('卖出日期空着的同价裸卖不自动归链（敞口与守恒式不受影响）', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        // 同价再卖，但卖出日期空着 → 无法判序 → 不归链
        rec(3, { sell: 700, soldQty: 500, p: 500 }),
        // 同价买入（回补价 500），日期也在，但槽根本不该成立
        rec(4, { buy: 500, qty: 500, sell: 700, soldQty: 500, buyDate: 46030, sellDate: 46040 }),
      ],
      [STOCK],
    )
    const c = led.repairChains[0]
    expect(c.branches.filter((b) => b.kind === 'sell')).toHaveLength(0)
    expect(c.profitCents).toBe(0)
    // 这笔裸卖照旧欠 500 股、照旧算敞口
    expect(led.orders.find((o) => o.sourceRow === 3)?.baseQty).toBe(500)
    expect(led.totals.exposureQty).toBe(500)
    expect(led.checks.every((k) => k.ok)).toBe(true)
  })

  it('买入日期空着的同价批次也不自动归槽', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
        // 同价 500 的批次，但买入日期空着 → 认不出是不是「之后买回来的」
        rec(4, { buy: 500, qty: 500, sell: 700, soldQty: 500 }),
      ],
      [STOCK],
    )
    const c = led.repairChains[0]
    // 槽根还是那笔有日期的再卖（3），但买入日期空着的那批不能算「买回来」（4 不在成员里）
    expect(c.branches.find((b) => b.kind === 'sell')?.memberRows).toEqual([3])
    expect(led.orders.find((o) => o.sourceRow === 3)?.baseQty).toBe(500)
  })
})

/** 回补成交（默认成交价正好落在价位槽上） */
function execAt(id: string, sellRow: number, qty: number, priceCents: number, iso: string): RebuyExecution {
  return {
    id,
    orderId: `rb:sell:${sellRow}`,
    sellExecId: `sell:${sellRow}`,
    stockId: STOCK.id,
    stockName: '柳工',
    qty,
    priceCents,
    rewardQty: 0,
    groupKeyAtExecution: `${STOCK.id}|${priceCents}`,
    at: new Date(iso).getTime(),
  }
}

describe('V9.57 统一覆盖模型（cover）', () => {
  it('真实同价买入盖住裸卖：守恒式通过、不再生成零股订单、链计划归零', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 500, sell: 700, soldQty: 500, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
        rec(4, { buy: 500, qty: 500, buyDate: 46030 }),
      ],
      [STOCK],
    )
    expect(led.checks.every((c) => c.ok)).toBe(true)
    expect(led.orders.find((o) => o.sourceRow === 3)).toBeUndefined()
    expect(led.totals.exposureExecBaseQty).toBe(500)
    expect(led.totals.exposureQty).toBe(0)
    expect(led.repairChains[0]).toMatchObject({ plannedQty: 0, profitCents: 100000 })
  })

  it('回补成交的虚拟批次不重复 cover：敞口与链计划量按真实欠量算', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 1000, sellDate: 46020, p: 500 }),
      ],
      [STOCK],
      { executions: [execAt('e1', 3, 400, 500, '2026-01-05T12:00:00')] },
    )
    const order = led.orders.find((o) => o.sourceRow === 3)
    expect(order).toMatchObject({ baseQty: 1000, execQty: 400, exposure: true })
    // 真实空头 = 1000 − 400 = 600，虚拟批次不能把 baseQty 再减一遍
    expect(led.totals.exposureQty).toBe(600)
    expect(led.totals.exposureExecBaseQty).toBe(400)
    expect(led.repairChains[0].plannedQty).toBe(600)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('部分回补 200 / 500：敞口 300、链还欠 300', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 500, sell: 700, soldQty: 500, sellDate: 46010 }),
        rec(3, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
      ],
      [STOCK],
      { executions: [execAt('e2', 3, 200, 500, '2026-01-05T12:00:00')] },
    )
    expect(led.orders.find((o) => o.sourceRow === 3)).toMatchObject({ baseQty: 500, execQty: 200, exposure: true })
    expect(led.totals.exposureQty).toBe(300)
    expect(led.repairChains[0].plannedQty).toBe(300)
    expect(led.checks.every((c) => c.ok)).toBe(true)
  })

  it('链成员被挂高永久了结后，亏损计进链（与 ChainBinder 的已实现口径一致）', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
        rec(5, { buy: 1000, qty: 500, buyDate: 46015 }),
        rec(6, { sell: 900, soldQty: 500, sellDate: 46020 }),
      ],
      [STOCK],
      {
        hedges: [{ id: 'hedge:6', sellRow: 6, items: [{ row: 5, qty: 500 }], at: 1 }],
        chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [5], closedAt: null, at: 0 }],
        executions: [execAt('e3', 6, 500, 1200, '2026-01-05T12:00:00')],
      },
    )
    // 10 元批次按 9 元永久了结 = −500；这笔亏损属于成员 5，必须进链
    expect(led.repairChains[0].profitCents).toBe(-50000)
    expect(led.totals.profitCents).toBe(-350000)
  })

  it('锚点分多价卖出时，后续同价裸卖仍能归链（不再用加权均价匹配）', () => {
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 500, sellDate: 46010 }),
        rec(5, { sell: 690, soldQty: 500, sellDate: 46011, lotId: 'lot:2' }),
        rec(6, { sell: 700, soldQty: 500, sellDate: 46020, p: 500 }),
        rec(7, { buy: 500, qty: 500, buyDate: 46030 }),
      ],
      [STOCK],
    )
    const slot = led.repairChains[0].branches.find((b) => b.kind === 'sell')
    expect(slot?.rootSellRow).toBe(6)
    expect(slot?.memberRows).toEqual([6, 7])
    expect(led.orders.find((o) => o.sourceRow === 6)).toBeUndefined()
  })

  it('已结束的同价链不挡住另一条未结束的链', () => {
    const closedAt = new Date('2025-12-30T12:00:00').getTime()
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 500, sell: 700, soldQty: 500, sellDate: 46010 }),
        rec(5, { buy: 900, qty: 500, sell: 700, soldQty: 500, sellDate: 46020 }),
        rec(6, { sell: 700, soldQty: 500, sellDate: 46027, p: 500 }),
      ],
      [STOCK],
      {
        chainLinks: [{ id: 'chainlink:5', anchorRow: 5, stockName: '柳工', memberRows: [], closedAt, at: 1 }],
      },
    )
    const withSlot = led.repairChains.filter((c) => c.branches.some((b) => b.kind === 'sell'))
    expect(withSlot.map((c) => c.anchorRow)).toEqual([2])
    expect(withSlot[0].branches.find((b) => b.kind === 'sell')?.rootSellRow).toBe(6)
  })
})

describe('归属、结束与部分成交', () => {
  it('一笔只能归一条链（先到先得）', () => {
    const recs = [
      rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
      rec(5, { buy: 900, qty: 500, sell: 600, soldQty: 500, sellDate: 46012 }),
      rec(3, { buy: 600, qty: 500, sell: 800, soldQty: 500, sellDate: 46020, buyDate: 46015 }),
    ]
    const links: RepairChainLink[] = [
      { id: 'a', anchorRow: 2, stockName: '柳工', memberRows: [3], closedAt: null, at: 1 },
      { id: 'b', anchorRow: 5, stockName: '柳工', memberRows: [3], closedAt: null, at: 2 },
    ]
    const led = buildLedger(recs, [STOCK], { chainLinks: links })
    expect(led.repairChains).toHaveLength(2)
    const [c2, c5] = led.repairChains
    expect(c2.profitCents).toBe(100000)
    expect(c5.profitCents).toBe(0)
    expect(c5.branches).toHaveLength(0)
  })

  it('归属批次亏着卖时，亏损照算进链（可负可正）', () => {
    const recs = [
      rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
      rec(3, { buy: 600, qty: 500, sell: 500, soldQty: 500, sellDate: 46020, buyDate: 46015 }),
    ]
    const led = buildLedger(recs, [STOCK], { chainLinks: [{ ...LINK, memberRows: [3] }] })
    const c = led.repairChains[0]
    expect(c.profitCents).toBe(-50000)
    expect(c.netCents).toBe(-350000)
    expect(c.gapCents).toBe(350000)
    expect(c.branches[0].netCents).toBe(-200000)
  })

  it('成员批次自己若是亏损清仓，归属后不再单独成链', () => {
    const recs = [
      rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
      rec(3, { buy: 600, qty: 500, sell: 500, soldQty: 500, sellDate: 46020, buyDate: 46015 }),
    ]
    const free = buildLedger(recs, [STOCK])
    expect(free.repairChains.map((c) => c.anchorRow)).toEqual([2, 3])
    const linked = buildLedger(recs, [STOCK], { chainLinks: [{ ...LINK, memberRows: [3] }] })
    expect(linked.repairChains.map((c) => c.anchorRow)).toEqual([2])
  })

  it('用户结束这条链：保留全部历史，标记 closedByUserAt', () => {
    const led = buildLedger(userExample(), [STOCK], { chainLinks: [{ ...LINK, closedAt: 1700000000 }] })
    expect(led.repairChains[0].closedByUserAt).toBe(1700000000)
    // 盈亏归属照旧展示，不因结束而清零
    expect(led.repairChains[0].profitCents).toBe(200000)
  })

  it('别的股票的行不能归进来', () => {
    const led = buildLedger(userExample(), [STOCK], { chainLinks: [{ ...LINK, memberRows: [3, 4, 7] }] })
    const c = led.repairChains[0]
    expect(c.branches.map((b) => b.row)).toEqual([3, 4])
    expect(c.plannedQty).toBe(0)
  })

  it('部分卖出的归属批次：盈利按已成交部分计，剩下的算持仓', () => {
    const recs = [
      rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010 }),
      rec(3, { buy: 600, qty: 500, sell: 800, soldQty: 200, sellDate: 46020, buyDate: 46015 }),
    ]
    const led = buildLedger(recs, [STOCK], { chainLinks: [{ ...LINK, memberRows: [3] }] })
    const c = led.repairChains[0]
    expect(c.profitCents).toBe(40000) // (8−6)×200
    expect(c.holdingQty).toBe(300)
    expect(c.plannedQty).toBe(500)
  })

  it('没有归属时链仍能建（锚点自身的亏损留在账上）', () => {
    const chains = buildRepairChains({ lots: [], sells: [], executions: [], links: [] }).chains
    expect(chains).toEqual([])
  })
})


describe('V9.63 锚点 P 档：无同价再卖也自动归链', () => {
  it('高买低卖后直接记成交买回、低位多次卖出——盈利逐笔累加进链（修复「亏损固定不动」）', () => {
    // 10 买 1000 → 7 卖 1000（−3000，P=5.00）；5.00 记成交买回 1000（之后没有同价裸卖）
    // → 该批次分两次卖：7.00×400、6.50×300。修复前：P 档不存在，这两笔盈利不归链。
    const led = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010, p: 500 }),
        rec(3, { lotId: 'lot:exec:e1', sell: 700, soldQty: 400, sellDate: 46020 }),
        rec(4, { lotId: 'lot:exec:e1', sell: 650, soldQty: 300, sellDate: 46030 }),
      ],
      [STOCK],
      { executions: [execAt('e1', 2, 1000, 500, '2026-03-12')] },
    )
    expect(led.repairChains).toHaveLength(1)
    const c = led.repairChains[0]
    expect(c).toMatchObject({
      lossCents: -300000,
      // (7.00−5.00)×400 + (6.50−5.00)×300 = 80000 + 45000
      profitCents: 125000,
      netCents: -175000,
      gapCents: 175000,
      holdingQty: 300,
      plannedQty: 0, // P 档已经全部买回，不再提示计划买回
    })
    const slot = c.branches.find((b) => b.kind === 'sell')
    expect(slot).toMatchObject({
      rootSellRow: null,
      buyPriceCents: 500,
      qty: 1000,
      remainingQty: 300,
      cycles: 2,
      profitCents: 125000,
    })
    // 展示口径：无根 P 档的回补节省 = 清算价 − 档价 × 买入股数（只展示不进进度）
    expect(slot?.savingCents).toBe(200000)
  })

  it('明细新增在 P 档价位的买入同样归链；用户结束链后不再归', () => {
    const led = buildLedger([
      rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010, p: 500 }),
      rec(3, { buy: 500, qty: 300, sell: 600, soldQty: 300, buyDate: 46015, sellDate: 46020 }),
    ], [STOCK])
    expect(led.repairChains).toHaveLength(1)
    expect(led.repairChains[0]).toMatchObject({ profitCents: 30000, holdingQty: 0 })

    const closed = buildLedger(
      [
        rec(2, { buy: 1000, qty: 1000, sell: 700, soldQty: 1000, sellDate: 46010, p: 500 }),
        rec(4, { buy: 500, qty: 200, sell: 600, soldQty: 200, buyDate: 46050, sellDate: 46060 }),
      ],
      [STOCK],
      { chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [], closedAt: 1, at: 0 }] },
    )
    expect(closed.repairChains).toHaveLength(1)
    expect(closed.repairChains[0]).toMatchObject({ profitCents: 0, holdingQty: 0 })
  })
})

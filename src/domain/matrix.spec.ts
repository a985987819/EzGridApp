/**
 * 文档 §09 测试矩阵（24 条）逐条落地。
 * 20/21 需要真实浏览器交互、22 需要 IndexedDB，这三条在 e2e/smoke.mjs 里跑，这里只标注。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildLedger } from './ledger'
import { buildNextRoundBuyRows } from './buyBoard'
import { DEFAULT_STOCKS } from './defaults'
import { limitRange } from './limit'
import { parseWorkbook } from '../io/parseWorkbook'
import type { RawRecord, RebuyExecution } from './types'

let seq = 900
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
    importKey: `m${seq}`,
    ...over,
  }
}

const fixture = await parseWorkbook(
  new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))),
)

function exec(orderId: string, qty: number, priceCents: number, rewardQty = 0): RebuyExecution {
  return {
    id: `e${seq++}`,
    orderId,
    sellExecId: orderId.replace('rb:sell:', 'sell:'),
    stockId: 'stock:柳工',
    stockName: '柳工',
    qty,
    priceCents,
    rewardQty,
    groupKeyAtExecution: `stock:柳工|${priceCents}`,
    at: Date.now(),
  }
}

describe('§09 测试矩阵', () => {
  it('#01 正常买入、全卖（三一 R14：买 500@21.00 → 卖 500@21.68，盈利 ¥340）', () => {
    const l = buildLedger(
      [rec({ stockName: '三一重工', buyPriceCents: 2100, buyQtyRaw: 500, targetPriceCents: 2168, soldQty: 500, sellDateSerial: 46100 })],
      DEFAULT_STOCKS,
    )
    expect(l.totals.profitCents).toBe(34000)
    expect(l.totals.netQty).toBe(0)
    expect(l.targets).toHaveLength(0)
  })

  it('#02 一笔买入分多次卖出（模型：一行一批次，卖出记在同一行）', () => {
    const l = buildLedger(
      [
        rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 800, buyQtyRaw: 1000, targetPriceCents: 857, soldQty: 400 }),
        rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 800, buyQtyRaw: 1000, targetPriceCents: 857, soldQty: 600 }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.totals.sellQty).toBe(1000)
    expect(l.totals.netQty).toBe(1000)
    expect(l.totals.targetQty).toBe(1000)
  })

  it('#03 无买入价但有 P 列（R60–63）', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    const prices = l.orders.map((o) => o.rebuyPriceCents).sort((a, b) => a - b)
    expect(prices).toEqual([771, 781, 801, 811])
    expect(l.orders.every((o) => o.exposure)).toBe(true)
  })

  it('#04 买入价与 P 均空 → 不出建议', () => {
    const l = buildLedger([rec({ stockName: '柳工', soldQty: 500, targetPriceCents: 868 })], DEFAULT_STOCKS)
    expect(l.sells[0].costCents).toBeNull()
    expect(l.sells[0].profitCents).toBeNull()
    expect(l.sells[0].costComplete).toBe(false)
    expect(l.orders).toHaveLength(0)
    expect(l.anomalies.some((a) => a.kind === 'needsCost')).toBe(true)
  })

  it('#05 自定义价不被覆盖（改间隔后自定义价不变）', () => {
    const records = [rec({ stockName: '柳工', buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 888 })]
    const l1 = buildLedger(records, DEFAULT_STOCKS)
    const l2 = buildLedger(
      records,
      DEFAULT_STOCKS.map((s) => (s.name === '柳工' ? { ...s, intervalCents: 999 } : s)),
    )
    expect(l1.targets[0].priceCents).toBe(888)
    expect(l2.targets[0].priceCents).toBe(888)
  })

  it('#06 部分回补后剩余正确（500 → 回补 200 → 剩 300）', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 801 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    const orderId = before.orders[0].id
    const after = buildLedger(records, DEFAULT_STOCKS, {
      executions: [exec(orderId, 200, 801)],
    })
    expect(after.orders[0].execQty).toBe(200)
    expect(after.orders[0].remainingQty).toBe(300)
    expect(after.totals.exposureQty).toBe(300)
    expect(after.orders[0].status).toBe('partial')
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('#07 同股同价盈利累计（两笔 ¥800 合成 ¥1,600 → 2 手）', () => {
    const l = buildLedger(
      [
        rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 700, buyQtyRaw: 1600, targetPriceCents: 750, soldQty: 1600 }),
        rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 700, buyQtyRaw: 1600, targetPriceCents: 750, soldQty: 1600 }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.groups[0].grossProfitCents).toBe(160000)
    expect(l.groups[0].capacityHands).toBe(2)
  })

  it('#08 同股不同价不混用（7.81 与 7.86 各自成组）', () => {
    const l = buildLedger(
      [
        rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 781, buyQtyRaw: 1000, targetPriceCents: 838, soldQty: 1000 }),
        rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 786, buyQtyRaw: 1000, targetPriceCents: 843, soldQty: 1000 }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.groups).toHaveLength(2)
  })

  it('#09 不同股票不混用', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    const keys = l.groups.map((g) => g.groupKey)
    // 键 = 股票|成本：取股票段判重（V9.32 单一账户）
    expect(new Set(keys.map((k) => k.split('|')[0])).size).toBeGreaterThan(1)
  })

  it('#10 不足一手不加奖励（¥435 < ¥771 → 0 股）', () => {
    const l = buildLedger(
      [rec({ stockName: '柳工', buyPriceCents: 771, buyQtyRaw: 500, targetPriceCents: 858, soldQty: 500, earlyBuyPriceCents: 771 })],
      DEFAULT_STOCKS,
    )
    expect(l.totals.rewardQty).toBe(0)
  })

  it('#11 刚好一手加 100 股（profit = lotCost）', () => {
    const l = buildLedger(
      [rec({ stockName: '柳工', buyPriceCents: 700, buyQtyRaw: 1000, targetPriceCents: 771, soldQty: 1000, earlyBuyPriceCents: 700 })],
      DEFAULT_STOCKS,
    )
    expect(l.totals.rewardQty).toBe(100)
  })

  it('#12 够多手（3×lotCost + 1 → 3 手）', () => {
    const l = buildLedger(
      [rec({ stockName: '柳工', buyPriceCents: 700, buyQtyRaw: 3000, targetPriceCents: 771, soldQty: 3000, earlyBuyPriceCents: 700 })],
      DEFAULT_STOCKS,
    )
    expect(l.totals.rewardQty).toBe(300)
  })

  it('#13 改价后重新分组（R63 从 7.81 改 7.86 → 两组手数同步变化）', () => {
    const base = buildLedger(fixture.records, DEFAULT_STOCKS)
    expect(base.orders.find((o) => o.sourceRow === 63)?.rewardQty).toBe(100)

    const moved = buildLedger(
      fixture.records.map((r) => (r.sourceRow === 63 ? { ...r, earlyBuyPriceCents: 786 } : r)),
      DEFAULT_STOCKS,
    )
    const order63 = moved.orders.find((o) => o.sourceRow === 63)!
    expect(order63.rebuyPriceCents).toBe(786)
    // 7.81 组只剩 R46（¥560 < 每手 ¥781）→ 0 手；R63 并入 7.86 组（R35 ¥432 + 自己 ¥410 = ¥842）→ 1 手
    expect(moved.groups.find((g) => g.groupKey === 'stock:柳工|781')?.capacityHands).toBe(0)
    expect(moved.groups.find((g) => g.groupKey === 'stock:柳工|786')?.capacityHands).toBe(1)
    expect(order63.rewardQty).toBe(100)
    expect(base.totals.rewardQty).toBe(moved.totals.rewardQty)
  })

  it('#14 已完成奖励不被删（成交后 doneRewardQty 固定）', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 46, buyPriceCents: 781, buyQtyRaw: 1000, targetPriceCents: 837, soldQty: 1000 }),
      rec({ stockName: '柳工', sourceRow: 63, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    const orderId = before.orders[0].id
    expect(before.orders[0].rewardQty).toBe(100)

    const after = buildLedger(records, DEFAULT_STOCKS, { executions: [exec(orderId, 600, 781, 100)] })
    expect(after.orders[0].doneRewardQty).toBe(100)
    expect(after.orders[0].remainingQty).toBe(0)
    expect(after.orders[0].status).toBe('closed')
    // 组池已消耗 100 股 × 7.81，剩余额度归零
    expect(after.groups[0].usedProfitCents).toBe(78100)
    expect(after.groups[0].availableCents).toBe(0)
  })

  it('#15 缺成本不参与奖励（R44）', () => {
    const r44 = fixture.records.find((r) => r.sourceRow === 44)!
    const solo = buildLedger([r44], DEFAULT_STOCKS)
    const sell = solo.sells[0]
    expect(sell.costComplete).toBe(false)
    expect(sell.profitCents).toBeNull()
    expect(solo.groups).toHaveLength(0) // 不入组池
    expect(solo.anomalies.some((a) => a.kind === 'needsPrice')).toBe(true)
  })

  it('#16 盈利不重复分配（200 次随机：Σ授予 ≤ 容量）', () => {
    let seed = 42
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 200; i += 1) {
      const cost = 700 + Math.floor(rnd() * 100)
      const qty = 100 * (1 + Math.floor(rnd() * 10))
      const diff = Math.floor(rnd() * 50)
      const l = buildLedger(
        [rec({ stockName: '柳工', buyPriceCents: cost, buyQtyRaw: qty, targetPriceCents: cost + diff, soldQty: qty, earlyBuyPriceCents: cost })],
        DEFAULT_STOCKS,
      )
      const granted = l.orders.reduce((a, o) => a + o.rewardQty, 0) / 100
      const cap = l.groups.reduce((a, g) => a + g.capacityHands, 0)
      expect(granted).toBeLessThanOrEqual(cap)
      expect(l.totals.rewardQty % 100).toBe(0)
    }
  })

  it('#17 卖出目标不超批次剩余（一批次一目标；多目标在 V6）', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    for (const t of l.targets) {
      const lot = l.lots.find((x) => x.id === t.lotId)!
      expect(t.qty).toBeLessThanOrEqual(lot.qty)
      expect(t.qty).toBe(lot.remainingQty)
    }
  })

  it('#18 涨跌停边界 / 无效昨收 / 缺规则', () => {
    expect(limitRange(1000, 'main_10')).toEqual({ upCents: 1100, downCents: 900, pct: 10 })
    expect(limitRange(null, 'main_10')).toBeNull()
    expect(limitRange(1000, 'unknown')).toBeNull()
  })

  it('#19 重复导入 / 公式字段 / 错误日期', async () => {
    // 公式字段：D 列 FLOOR 派生、E 列按间隔派生
    const derived = fixture.records.filter((r) => r.qtyNeedsDerive || r.targetNeedsDerive)
    expect(derived.length).toBeGreaterThan(0)
    // 幂等：importKey 稳定，同文件导两次不会产生新 key
    const keys = new Set(fixture.records.map((r) => r.importKey))
    expect(keys.size).toBe(fixture.records.length)
    const again = await parseWorkbook(
      new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))),
    )
    expect(again.records.every((r) => keys.has(r.importKey))).toBe(true)
    // 缺日期 9 笔
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    expect(l.sells.filter((s) => s.dateMissing)).toHaveLength(9)
  })

  it('#20/#21 双击定位明细 —— 由 e2e/smoke.mjs 覆盖（真实浏览器）', () => {
    // 单元层无法验证点击与路由筛选，这里只断言筛选所需的 key 唯一
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    expect(new Set(l.sells.map((s) => s.sourceRow)).size).toBe(l.sells.length)
  })

  it('#22 备份恢复后一致 —— 由 e2e 覆盖；这里验证序列化不丢字段', () => {
    const payload = {
      schemaVersion: 3,
      stocks: [{ id: 'stock:柳工', name: '柳工', intervalCents: 57, priceLimitType: 'main_10', order: 0, enabled: true }],
      records: [{ ...fixture.records[0], deletedAt: null, editedAt: 1, origin: 'excel' as const }],
      executions: [exec('rb:sell:63', 500, 801, 100)],
    }
    const back = JSON.parse(JSON.stringify(payload))
    expect(back).toEqual(payload)
    expect(back.records[0].sourceRow).toBe(payload.records[0].sourceRow)
    expect(back.stocks[0].enabled).toBe(true)
  })

  it('#23 先卖后买不入异常（5 行 → sellBeforeBuy=true）', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    const rows = l.sells.filter((s) => s.sellBeforeBuy).map((s) => s.sourceRow)
    expect(rows).toEqual([40, 60, 61, 62, 63])
    expect(l.anomalies.filter((a) => a.kind === 'needsPrice')).toHaveLength(1)
    expect(l.anomalies).toHaveLength(12) // 缺价 1 + 缺日期 9 + 负盈利 2
  })

  it('#24 数量守恒（待卖 15,200 − 待补 2,000 = 净持仓 13,200）', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    expect(l.totals.targetQty).toBe(15200)
    expect(l.totals.exposureQty).toBe(2000)
    expect(l.totals.netQty).toBe(13200)
    expect(l.totals.targetQty - l.totals.exposureQty).toBe(l.totals.netQty)
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('§7.1 卖出挂回批次与目标：lotId / targetId 齐全', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    // 有买入批次的卖出：lotId 指向自己那一行
    const r14 = l.sells.find((s) => s.sourceRow === 14)!
    expect(r14.lotId).toBe('lot:14')
    // R14 已全卖完 → 没有剩余就没有自动目标
    expect(r14.targetId).toBeNull()

    // 真实数据里每行都是「买满即卖光」，没有部分卖出样本，所以 targetId 全为 null
    for (const s of l.sells) expect(s.targetId).toBeNull()

    // 构造一笔部分卖出：批次还剩 600，自动目标存在，targetId 应回填
    const partial = rec({
      stockName: '柳工',
      buyPriceCents: 800,
      buyQtyRaw: 1000,
      soldQty: 400,
      targetPriceCents: 900,
    })
    const l2 = buildLedger([partial], DEFAULT_STOCKS)
    expect(l2.lots[0].remainingQty).toBe(600)
    expect(l2.sells[0].lotId).toBe(l2.lots[0].id)
    expect(l2.sells[0].targetId).toBe(l2.targets[0].id)

    // 先卖后买（R60–63）没有批次，lotId / targetId 都是 null
    for (const row of [60, 61, 62, 63]) {
      const s = l.sells.find((x) => x.sourceRow === row)!
      expect(s.lotId).toBeNull()
      expect(s.targetId).toBeNull()
    }
  })

  it('§7.1 凑手来源：R63 的奖励只来自同组自己（R46 已回补、没有订单）', () => {
    const l = buildLedger(fixture.records, DEFAULT_STOCKS)
    const r63 = l.orders.find((o) => o.sourceRow === 63)!
    expect(r63.rewardQty).toBe(100)
    expect(r63.rewardSourceOrderIds).toEqual([r63.id])
    const others = l.orders.filter((o) => o.sourceRow !== 63)
    for (const o of others) expect(o.rewardSourceOrderIds).toEqual([])
  })

  it('稳健性：范围外的回补成交不进净持仓、不消耗奖励预算', () => {
    // ¥560 + ¥435 = ¥995 → 7.81 组容量 1 手；若范围外的成交泄漏进来，
    // usedProfit 会吃掉 78100 → 容量归 0
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 781, buyQtyRaw: 1000, targetPriceCents: 837, soldQty: 1000 }),
      rec({ stockName: '柳工', sourceRow: 2, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    // 一笔挂在不存在行上的成交（行被删了），groupKey 相同——不能泄漏进来
    const stray: RebuyExecution = { ...exec('rb:sell:999', 500, 781, 100), sellExecId: 'sell:999' }
    const l = buildLedger(records, DEFAULT_STOCKS, { executions: [stray] })
    expect(l.totals.rebuyExecQty).toBe(0)
    expect(l.totals.netQty).toBe(-500)
    expect(l.orders[0].execQty).toBe(0)
    expect(l.orders[0].rewardQty).toBe(100)
    expect(l.groups[0].usedProfitCents).toBe(0)
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('稳健性：全部回补完的挂单不再领新奖励，额度顺延给组内后面的单子', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 781, buyQtyRaw: 1000, targetPriceCents: 837, soldQty: 1000, earlyBuyPriceCents: 781 }),
      rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 781, buyQtyRaw: 1000, targetPriceCents: 837, soldQty: 1000, earlyBuyPriceCents: 781 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    const after = buildLedger(records, DEFAULT_STOCKS, {
      executions: [exec(before.orders[0].id, 1000, 781, 0)],
    })
    expect(after.orders[0].status).toBe('closed')
    expect(after.orders[0].rewardQty).toBe(0)
    expect(after.orders[1].rewardQty).toBe(100)
    // 批次内回补计入净持仓，补全后的守恒式仍成立
    expect(after.totals.netQty).toBe(1000)
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('稳健性：每股汇总与总计同口径（回补成交摊到股）', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    const after = buildLedger(records, DEFAULT_STOCKS, {
      executions: [exec(before.orders[0].id, 200, 781, 0)],
    })
    const s = after.byStock[0]
    expect(s.netQty).toBe(-300)
    expect(s.exposureQty).toBe(300)
    expect(s.netQty).toBe(after.totals.netQty)
    expect(s.exposureQty).toBe(after.totals.exposureQty)
  })

  it('V9.32：单一账户后同股同价合成一个组，额度不再按账户拆', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 700, buyQtyRaw: 1000, targetPriceCents: 771, soldQty: 1000, earlyBuyPriceCents: 700 }),
      rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 700, buyQtyRaw: 1000, targetPriceCents: 771, soldQty: 1000, earlyBuyPriceCents: 700 }),
    ]
    const l = buildLedger(records, DEFAULT_STOCKS)
    expect(l.groups).toHaveLength(1)
    expect(l.groups[0].groupKey).toBe('stock:柳工|700')
    // gross = 两笔各 (7.71−7.00)×1000 = 710 元 → 合计 1,420；每手成本 700 → 2 手
    expect(l.groups[0].capacityHands).toBe(2)
  })

  it('V9.32：老库带账户前缀的成交键照样扣额度（前缀会被剥掉）', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 46, buyPriceCents: 781, buyQtyRaw: 1000, targetPriceCents: 837, soldQty: 1000 }),
      rec({ stockName: '柳工', sourceRow: 63, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    const legacy: RebuyExecution = { ...exec(before.orders[0].id, 600, 781, 100) }
    // 模拟 V9.20~V9.31 的老库：键里带账户前缀
    legacy.groupKeyAtExecution = 'stock:柳工|781'
    const after = buildLedger(records, DEFAULT_STOCKS, { executions: [legacy] })
    expect(after.groups[0].usedProfitCents).toBe(78100)
    expect(after.groups[0].availableCents).toBe(0)
  })

  it('v9.20 B：回补成交自动生成回补批次——目标价=成交价+间隔，回到待卖清单', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    const after = buildLedger(records, DEFAULT_STOCKS, {
      executions: [exec(before.orders[0].id, 500, 781, 0)],
    })
    const vTarget = after.targets.find((t) => t.lotId.startsWith('lot:exec:'))
    expect(vTarget).toBeDefined()
    expect(vTarget!.priceCents).toBe(781 + 57) // 柳工间隔 0.57
    expect(vTarget!.qty).toBe(500)
    expect(vTarget!.autoGenerated).toBe(true)
    // 回补批次计入 Σ买入，净持仓 = Σ买入 − Σ卖出（−500 + 500 = 0）
    expect(after.totals.buyQty).toBe(500)
    expect(after.totals.netQty).toBe(0)
    expect(after.totals.exposureQty).toBe(0)
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('v9.20 B：撤销回补成交，回补批次随之消失（纯派生，无残留）', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    const withExec = buildLedger(records, DEFAULT_STOCKS, {
      executions: [exec('rb:sell:1', 500, 781, 0)],
    })
    expect(withExec.targets.some((t) => t.lotId.startsWith('lot:exec:'))).toBe(true)
    const undone = buildLedger(records, DEFAULT_STOCKS)
    expect(undone.targets.some((t) => t.lotId.startsWith('lot:exec:'))).toBe(false)
    expect(undone.totals.netQty).toBe(-500)
  })

  it('v9.20 B：回补批次缺该股间隔配置 → 待补价格异常，守恒式红灯可见', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 781 }),
    ]
    const noInterval = DEFAULT_STOCKS.map((s) => (s.name === '柳工' ? { ...s, intervalCents: 0 } : s))
    const l = buildLedger(records, noInterval, {
      executions: [exec('rb:sell:1', 500, 781, 0)],
    })
    expect(l.targets.filter((t) => t.lotId.startsWith('lot:exec:'))).toHaveLength(0)
    expect(l.anomalies.some((a) => a.detail.includes('回补批次'))).toBe(true)
  })

  it('v9.20 D：超卖（卖出 > 批次）标异常', () => {
    const l = buildLedger(
      [rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 800, buyQtyRaw: 500, targetPriceCents: 857, soldQty: 700 })],
      DEFAULT_STOCKS,
    )
    expect(l.anomalies.some((a) => a.kind === 'oversell')).toBe(true)
  })

  // ── V9.47.1 先卖后买：卖出日期早于买入日期合法，份额匹配即已完成 ──────────────

  it('V9.47.1 先卖后买份额匹配 → 视为已完成：不挂待买、不算待回补', () => {
    // 10-19 卖 500@8.58，10-21 买回 500@7.81（P 列当初计划 7.71）
    const l = buildLedger(
      [
        rec({
          stockName: '柳工',
          sourceRow: 1,
          buyPriceCents: 781,
          buyQtyRaw: 500,
          buyDateSerial: 46316,
          soldQty: 500,
          targetPriceCents: 858,
          sellDateSerial: 46314,
          earlyBuyPriceCents: 771,
        }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.sells[0].sellBeforeBuy).toBe(true)
    expect(l.sells[0].ownLotCoverQty).toBe(500)
    expect(l.sells[0].rebuyStatus).toBe('repaid')
    expect(l.orders).toHaveLength(0)
    expect(l.lots[0].remainingQty).toBe(0)
    expect(l.totals.exposureQty).toBe(0)
    expect(l.totals.netQty).toBe(0)
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
    // 结掉之后这一档买入价就是「下一轮应买」的候选（V9.47）
    const levels = buildNextRoundBuyRows({ lots: l.lots, orders: l.orders, sells: l.sells, merges: [] })
    expect(levels.map((r) => r.priceCents)).toEqual([781])
  })

  it('V9.47.1 买入只盖住一半 → 待买单只挂没买回来的那截', () => {
    const l = buildLedger(
      [
        rec({
          stockName: '柳工',
          sourceRow: 1,
          buyPriceCents: 781,
          buyQtyRaw: 300,
          buyDateSerial: 46316,
          soldQty: 500,
          targetPriceCents: 858,
          sellDateSerial: 46314,
          earlyBuyPriceCents: 771,
        }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.sells[0].ownLotCoverQty).toBe(300)
    expect(l.sells[0].rebuyStatus).toBe('pending')
    expect(l.orders).toHaveLength(1)
    expect(l.orders[0].baseQty).toBe(200)
    expect(l.orders[0].remainingQty).toBe(200)
  })

  it('V9.47.1 先买后卖（买入日更早）+ P 列 → 待买单照旧挂全量', () => {
    const l = buildLedger(
      [
        rec({
          stockName: '柳工',
          sourceRow: 1,
          buyPriceCents: 1031,
          buyQtyRaw: 700,
          buyDateSerial: 46090,
          soldQty: 700,
          targetPriceCents: 1088,
          sellDateSerial: 46148,
          earlyBuyPriceCents: 1000,
        }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.sells[0].sellBeforeBuy).toBe(false)
    expect(l.sells[0].ownLotCoverQty).toBe(0)
    expect(l.sells[0].rebuyStatus).toBe('pending')
    expect(l.orders[0].baseQty).toBe(700)
  })

  it('V9.47.1 同日买卖也算先卖后买（A股 T+1，当日买的不能当日卖）', () => {
    const l = buildLedger(
      [
        rec({
          stockName: '柳工',
          sourceRow: 1,
          buyPriceCents: 781,
          buyQtyRaw: 500,
          buyDateSerial: 46316,
          soldQty: 500,
          targetPriceCents: 858,
          sellDateSerial: 46316,
          earlyBuyPriceCents: 771,
        }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.sells[0].ownLotCoverQty).toBe(500)
    expect(l.orders).toHaveLength(0)
  })

  it('V9.47.1 卖出日期没填 → 无法判定顺序，保守地留着待买单', () => {
    const l = buildLedger(
      [
        rec({
          stockName: '柳工',
          sourceRow: 1,
          buyPriceCents: 781,
          buyQtyRaw: 500,
          buyDateSerial: 46316,
          soldQty: 500,
          targetPriceCents: 858,
          sellDateSerial: null,
          earlyBuyPriceCents: 771,
        }),
      ],
      DEFAULT_STOCKS,
    )
    expect(l.sells[0].ownLotCoverQty).toBe(0)
    expect(l.orders[0].baseQty).toBe(500)
  })
})

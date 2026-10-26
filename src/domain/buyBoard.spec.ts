import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildNextRoundBuyRows } from './buyBoard'
import { parseWorkbook } from '../io/parseWorkbook'
import { buildLedger } from './ledger'
import { DEFAULT_STOCKS } from './defaults'
import type { Lot, LotMergeLink, RebuyOrder, SellExecution } from './types'

/** 卖完的批次：remaining 与 ledger 同口径（超卖时夹到 0） */
function lot(row: number, buyPrice: number, qty: number, sold: number, buyDate: string | null = '2026-03-09', stock = '柳工'): Lot {
  return {
    id: `lot:${row}`,
    sourceRow: row,
    stockId: `stock:${stock}`,
    stockName: stock,
    buyDate,
    buyPriceCents: buyPrice,
    qty,
    soldQty: sold,
    remainingQty: Math.max(0, qty - sold),
    targetPriceCents: buyPrice + 57,
    needsPrice: false,
    importKey: `k:${row}`,
  }
}

function sell(row: number, soldAt: string | null): SellExecution {
  return {
    id: `sell:${row}`,
    sourceRow: row,
    stockId: 'stock:柳工',
    stockName: '柳工',
    qty: 500,
    priceCents: 1088,
    costCents: 1031,
    profitCents: 28500,
    soldAt,
    dateMissing: soldAt === null,
    priceSource: 'target',
    rebuyStatus: 'repaid',
    sellBeforeBuy: false,
    groupKey: null,
    costComplete: true,
    lotId: `lot:${row}`,
    targetId: null,
  }
}

function order(row: number, remaining: number, execQty: number): RebuyOrder {
  return {
    id: `rb:sell:${row}`,
    sellExecId: `sell:${row}`,
    sourceRow: row,
    stockId: 'stock:柳工',
    stockName: '柳工',
    rebuyPriceCents: 990,
    baseQty: 500,
    rewardQty: 0,
    execQty,
    doneRewardQty: 0,
    remainingQty: remaining,
    status: remaining === 0 ? 'closed' : 'open',
    groupKey: 'stock:柳工|990',
    grossProfitCents: 0,
    hands: 0,
    rewardSourceOrderIds: [],
    exposure: false,
    planPriceCents: null,
    planQty: null,
    createdAt: row,
  }
}

const merge: LotMergeLink = { id: 'merge:16', stockName: '柳工', priceCents: 961, rows: [16, 22], at: 1 }

describe('下一轮应买（V9.47）', () => {
  it('卖完的批次按买入价给一档，数量是这一轮的建仓量', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(3, 1031, 700, 700)],
      orders: [],
      sells: [sell(3, '2026-05-06')],
      merges: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'buy:3', priceCents: 1031, qty: 700, merged: false, repaid: false })
    expect(rows[0].amountCents).toBe(1031 * 700)
    expect(rows[0].lastSoldAt).toBe('2026-05-06')
  })

  it('还没卖完的批次不在这里提示（那是待卖的事）', () => {
    const rows = buildNextRoundBuyRows({ lots: [lot(3, 1031, 700, 200)], orders: [], sells: [], merges: [] })
    expect(rows).toHaveLength(0)
  })

  it('待买单还没回补完 → 不重复给一档', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(61, 781, 500, 500)],
      orders: [order(61, 500, 0)],
      sells: [sell(61, '2026-10-23')],
      merges: [],
    })
    expect(rows).toHaveLength(0)
  })

  it('待买单已回补完 → 重新提示，并标出回补过一轮', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(61, 781, 500, 500)],
      orders: [order(61, 0, 500)],
      sells: [sell(61, '2026-10-23')],
      merges: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ priceCents: 781, repaid: true })
  })

  it('回补虚拟批次不排下一轮（它自己的卖出才算数）', () => {
    const exec: Lot = { ...lot(200001, 771, 500, 500), id: 'lot:exec:x' }
    const rows = buildNextRoundBuyRows({ lots: [exec], orders: [], sells: [], merges: [] })
    expect(rows).toHaveLength(0)
  })

  it('V9.57：「记卖出」子成交已有待买 → 原批次不再排下一轮（同一笔钱不提示两次）', () => {
    // 第 2 行买入 500 股被第 10 行的「记卖出」卖掉，买回由 rb:sell:10 负责
    const child = { ...sell(10, '2026-10-21'), lotId: 'lot:2' }
    const rows = buildNextRoundBuyRows({
      lots: [lot(2, 1000, 500, 500)],
      orders: [order(10, 500, 0)],
      sells: [child],
      merges: [],
    })
    expect(rows).toHaveLength(0)
  })

  it('V9.57：子成交已经买回完（虚拟批次已持有）也不再提示原批次', () => {
    const child = { ...sell(10, '2026-10-21'), lotId: 'lot:2' }
    const rows = buildNextRoundBuyRows({
      lots: [lot(2, 1000, 500, 500)],
      orders: [order(10, 0, 500)],
      sells: [child],
      merges: [],
    })
    expect(rows).toHaveLength(0)
  })

  it('V9.57：子卖出没有待买（没填 P）→ 原批次照旧给下一轮', () => {
    const child = { ...sell(10, '2026-10-21'), lotId: 'lot:2' }
    const rows = buildNextRoundBuyRows({
      lots: [lot(2, 1000, 500, 500)],
      orders: [],
      sells: [child],
      merges: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'buy:2', priceCents: 1000, qty: 500 })
  })

  it('沙盒模拟行不参与', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(300001, 1031, 500, 500)],
      orders: [],
      sells: [],
      merges: [],
      sandboxRows: new Set([300001]),
    })
    expect(rows).toHaveLength(0)
  })

  it('同价且都卖完的两笔按 V9.45 的合并组合成一条：数量相加、日期取最早', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(16, 961, 200, 200, '2026-03-20'), lot(22, 961, 600, 600, '2026-05-12')],
      orders: [],
      sells: [sell(16, '2026-04-01'), sell(22, '2026-06-01')],
      merges: [merge],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'buy:merge:merge:16', priceCents: 961, qty: 800, merged: true })
    expect(rows[0].rows).toEqual([16, 22])
    expect(rows[0].earliestBuyDate).toBe('2026-03-20')
    expect(rows[0].anchorRow).toBe(16)
    expect(rows[0].lastSoldAt).toBe('2026-06-01')
  })

  it('组里只剩一笔卖完 → 散开逐笔显示，关联本身不动', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(16, 961, 200, 200, '2026-03-20'), lot(22, 961, 600, 100, '2026-05-12')],
      orders: [],
      sells: [],
      merges: [merge],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'buy:16', qty: 200, merged: false })
  })

  it('买入价被改掉的行退出合并（组内价格必须一致）', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(16, 961, 200, 200), lot(22, 900, 600, 600)],
      orders: [],
      sells: [],
      merges: [merge],
    })
    expect(rows.map((r) => r.merged)).toEqual([false, false])
  })

  it('按买入价从低到高排（跌到哪档先提示哪档）', () => {
    const rows = buildNextRoundBuyRows({
      lots: [lot(3, 1031, 500, 500), lot(4, 1041, 600, 600), lot(5, 781, 500, 500)],
      orders: [],
      sells: [],
      merges: [],
    })
    expect(rows.map((r) => r.priceCents)).toEqual([781, 1031, 1041])
  })

  it('超卖的行按建仓量给数量，不会把敞口算成新一轮要买的股数', () => {
    const rows = buildNextRoundBuyRows({ lots: [lot(9, 1000, 500, 800)], orders: [], sells: [], merges: [] })
    expect(rows[0].qty).toBe(500)
  })
})

describe('真实台账（26年网格记录.xlsx）', () => {
  it('卖完的老批次会重新出现在下一轮应买里', async () => {
    const buf = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))
    const parsed = await parseWorkbook(new Uint8Array(buf))
    const ledger = buildLedger(parsed.records, DEFAULT_STOCKS)
    const rows = buildNextRoundBuyRows({
      lots: ledger.lots,
      orders: ledger.orders,
      sells: ledger.sells,
      merges: [],
    })
    // 柳工 R2（11.48 买 500，全部卖出、没有 P 列待买）是典型：老口径里它彻底静默
    const hit = rows.find((r) => r.rows.includes(2))
    expect(hit?.priceCents).toBe(1148)
    expect(hit?.qty).toBe(500)
    // 手里还有剩余的批次不该出现（R3 买 700 只卖了 0）
    expect(rows.some((r) => r.rows.includes(3))).toBe(false)
    // 有未回补待买单的行也不出现（R60–63 是 rebuyCount 的来源）
    for (const o of ledger.orders) expect(rows.every((r) => !r.rows.includes(o.sourceRow))).toBe(true)
  })
})

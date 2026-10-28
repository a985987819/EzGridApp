import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCsvText } from '../io/parseWorkbook'
import { DEFAULT_STOCKS } from './defaults'
import { buildLedger } from './ledger'
import type { RawRecord, StockConfig } from './types'

const parsed = await parseCsvText(readFileSync(resolve('tests/fixtures/26年网格记录-交易记录.csv'), 'utf8'))
const csvLedger = buildLedger(parsed.records, DEFAULT_STOCKS)
const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const row = (sourceRow: number, fields: Partial<RawRecord>): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null,
  qtyNeedsDerive: false, targetPriceCents: null, targetNeedsDerive: false, soldQty: null,
  sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `k${sourceRow}`, ...fields,
})
const high = row(2, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 1200 })
const root = row(3, { sellDateSerial: 46010, targetPriceCents: 700, soldQty: 500 })
const flat = (l: ReturnType<typeof buildLedger>) => expect(l.checks.filter((c) => !c.ok)).toEqual([])

describe('用户确认的交易记录 CSV', () => {
  it('6 笔先卖后买，按日期和最高剩余成本分配，2100 股已回补、500 股待买', () => {
    expect(parsed.records).toHaveLength(62)
    expect(csvLedger.sells.filter((s) => s.sellBeforeBuy).map((s) => s.sourceRow)).toEqual([40, 57, 60, 61, 62, 63])
    expect(csvLedger.effectiveHedges.map((h) => [h.sellRow, h.items])).toEqual([
      [40, [{ row: 29, qty: 300 }]], [57, [{ row: 29, qty: 300 }]],
      [61, [{ row: 9, qty: 500 }]], [62, [{ row: 8, qty: 500 }]],
      [63, [{ row: 7, qty: 500 }]], [60, [{ row: 7, qty: 500 }]],
    ])
    expect(csvLedger.repairChains.filter((c) => c.relatedSellRows.some((r) => [40,57,60,61,62,63].includes(r))).map((c) => [c.anchorRow,c.lossCents,c.profitCents,c.plannedQty])).toEqual([
      [40,-3900,0,0], [57,-83700,0,0], [60,-106500,0,500],
      [61,-115500,0,0], [62,-106500,0,0], [63,-101500,0,0],
    ])
    expect(csvLedger.orders.filter((o) => o.sellFirst && o.remainingQty > 0).map((o) => [o.sourceRow,o.remainingQty,o.rebuyPriceCents])).toEqual([[60,500,801]])
    flat(csvLedger)
  })
})

describe('先卖后买的库存与回本', () => {
  it('仅卖出用默认间隔建议买入，未买回不提前盈利；两轮完成只累计实际买卖', () => {
    const low = row(4, { buyDateSerial: 46011, buyPriceCents: 500, buyQtyRaw: 500, targetPriceCents: 700 })
    let l = buildLedger([high, root], [stock])
    expect(l.orders[0]).toMatchObject({ rebuyPriceCents: 500, remainingQty: 500 })
    expect(l.repairChains[0]).toMatchObject({ lossCents: -150000, profitCents: 0, plannedQty: 500 })
    flat(l)
    l = buildLedger([high, root, low], [stock])
    expect(l.repairChains[0]).toMatchObject({ holdingQty: 500, profitCents: 0, plannedQty: 0 })
    flat(l)
    const completed = { ...low, soldQty: 500, sellDateSerial: 46012 }
    l = buildLedger([high, root, completed, { ...completed, sourceRow: 5, buyDateSerial: 46013, sellDateSerial: 46014 }], [stock])
    expect(l.repairChains[0]).toMatchObject({ profitCents: 200000, netCents: 50000, done: true })
    expect(l.totals.profitCents).toBe(50000)
    flat(l)
  })
  it('同一行回补留在持仓，P 列与实际买价不同时也不重复覆盖别的卖单', () => {
    const own = { ...root, buyDateSerial: 46011, buyPriceCents: 550, buyQtyRaw: 500, earlyBuyPriceCents: 500 }
    const later = { ...root, sourceRow: 4, sellDateSerial: 46012 }
    const l = buildLedger([high, own, later], [stock])
    expect(l.lots.find((v) => v.sourceRow === 3)).toMatchObject({ remainingQty: 500 })
    expect(l.orders.filter((o) => o.remainingQty > 0).map((o) => [o.sourceRow,o.remainingQty])).toEqual([[4,500]])
    expect(l.repairChains[0]).toMatchObject({ profitCents: 0, holdingQty: 500, plannedQty: 500 })
    flat(l)
  })
  it('没有高位买单也显示待关联链，未知日期不自动分配历史持仓', () => {
    const l = buildLedger([{ ...root, sellDateSerial: null }], [stock])
    expect(l.repairChains[0]).toMatchObject({ unlinkedQty: 500, done: false, lossCents: 0 })
    flat(l)
  })
})


describe('自动关联与历史人工关联的边界', () => {
  it('同日为先卖后买，未知买入日期不当成已经买回，也不用未知买价推建议', () => {
    const l = buildLedger([high, { ...root, buyDateSerial: 46010, buyPriceCents: 500, buyQtyRaw: 200 }], [stock])
    expect(l.sells.find((s) => s.sourceRow === 3)).toMatchObject({ sellBeforeBuy: true, ownLotCoverQty: 200 })
    expect(l.orders[0].remainingQty).toBe(300)
    flat(l)
    const unknown = buildLedger([{ ...root, buyPriceCents: 550, buyQtyRaw: 200 }], [stock])
    expect(unknown.orders[0]).toMatchObject({ rebuyPriceCents: 500, remainingQty: 500 })
    flat(unknown)
  })
  it('人工解除阻止自动挂回；改挂与已有根链的结束设置保留', () => {
    const second = { ...high, sourceRow: 4, buyPriceCents: 900 }
    let l = buildLedger([high, root, second], [stock], { hedges: [{ id: 'hedge:3', sellRow: 3, items: [], at: 1 }] })
    expect(l.effectiveHedges[0].items).toEqual([])
    expect(l.repairChains[0].unlinkedQty).toBe(500)
    flat(l)
    const closedAt = new Date('2026-12-01T12:00:00').getTime()
    l = buildLedger([high, root, second], [stock], {
      hedges: [{ id: 'hedge:3', sellRow: 3, items: [{ row: 4, qty: 500 }], at: 1 }],
      chainLinks: [{ id: 'chainlink:3', anchorRow: 3, stockName: 'T', memberRows: [], closedAt, at: 1 }],
    })
    expect(l.repairChains[0]).toMatchObject({ anchorRow: 3, lossCents: -100000, closedByUserAt: closedAt })
    flat(l)
  })
  it('高位批次已被子成交卖掉的份额不能再自动分配', () => {
    const child = row(4, { soldLotId: 'lot:2', soldQty: 300, targetPriceCents: 1200, sellDateSerial: 46005 })
    const l = buildLedger([high, root, child], [stock])
    expect(l.effectiveHedges[0].items).toEqual([{ row: 2, qty: 200 }])
    expect(l.repairChains[0]).toMatchObject({ lossCents: -60000, unlinkedQty: 300 })
    flat(l)
  })
  it('已存人工挂钩分到两个高位批次，独立同价买卖按份额各算一次', () => {
    const other = { ...high, sourceRow: 4, buyPriceCents: 1100 }
    const sell = { ...root, soldQty: 1000 }
    const low = row(5, { buyDateSerial: 46011, buyPriceCents: 500, buyQtyRaw: 1000, targetPriceCents: 700, soldQty: 1000, sellDateSerial: 46012 })
    const hedges = [{ id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 500 }, { row: 4, qty: 500 }], at: 1 }]
    let l = buildLedger([high, other, sell, low], [stock], { hedges })
    expect(l.repairChains.map((c) => [c.anchorRow, c.profitCents, c.plannedQty])).toEqual([[2,100000,0], [4,100000,0]])
    expect(l.orders).toHaveLength(0)
    expect(l.repairChains.every((c) => c.branches.some((b) => b.memberRows.includes(5)))).toBe(true)
    flat(l)
    l = buildLedger([high, other, sell], [stock], { hedges })
    expect(l.orders[0].remainingQty).toBe(1000)
    expect(l.repairChains.every((c) => c.profitCents === 0 && c.plannedQty === 500)).toBe(true)
    flat(l)
  })
  it('任意低位价成交不会混入匹配网格；记卖出子行也可追溯链', () => {
    const low = row(4, { buyDateSerial: 46011, buyPriceCents: 500, buyQtyRaw: 500, targetPriceCents: 700 })
    const child = row(5, { soldLotId: 'lot:4', soldQty: 200, targetPriceCents: 700, sellDateSerial: 46012 })
    const otherPrice = { ...child, sourceRow: 6, soldQty: 300, targetPriceCents: 800 }
    const l = buildLedger([high, root, low, child, otherPrice], [stock])
    // V9.67：归属库存任意卖价都累计：(7−5)×200 + (8−5)×300 = 400 + 900 = 1300
    expect(l.repairChains[0].profitCents).toBe(130000)
    expect(l.repairChains[0].branches[0].memberRows).toContain(5)
    // 全局盈利不变：-1500（高位亏损）+ 400 + 900 = -200
    expect(l.totals.profitCents).toBe(-20000)
    flat(l)
  })
  for (const own of [0, 100, 300, 500]) {
    for (const hedge of [0, 200, 500]) {
      it(`份额守恒：同行回补 ${own}、高位关联 ${hedge}、余量分为成交和独立买回`, () => {
        const execQty = Math.min(100, 500 - own)
        const realQty = Math.max(0, 500 - own - execQty)
        const rec = { ...root, buyDateSerial: own ? 46011 : null, buyPriceCents: own ? 500 : null, buyQtyRaw: own || null }
        const low = row(4, { buyDateSerial: 46012, buyPriceCents: 500, buyQtyRaw: realQty, targetPriceCents: 700 })
        const options = {
          hedges: [{ id: 'hedge:3', sellRow: 3, items: hedge ? [{ row: 2, qty: hedge }] : [], at: 1 }],
          executions: execQty ? [{ id: 'e1', orderId: 'rb:sell:3', sellExecId: 'sell:3', stockId: 'stock:T', stockName: 'T', priceCents: 500, qty: execQty, rewardQty: 0, groupKeyAtExecution: 'stock:T|500', at: new Date('2025-12-22T12:00:00').getTime() }] : [],
        }
        const l = buildLedger([high, rec, ...(realQty ? [low] : [])], [stock], options)
        flat(l)
      })
    }
  }
})


it('缺间隔无法推价仍保留敞口和链；不生成无效买单', () => {
  const l = buildLedger([root], [{ ...stock, intervalCents: 0 }])
  expect(l.orders).toHaveLength(0)
  expect(l.totals.exposureQty).toBe(500)
  expect(l.byStock[0].exposureQty).toBe(500)
  expect(l.repairChains[0].unlinkedQty).toBe(500)
  flat(l)
})

it('历史人工挂钩的同行回补不能被另一先卖单自动占用', () => {
  const own = { ...root, buyDateSerial: 46013, buyPriceCents: 500, buyQtyRaw: 500 }
  const other = { ...root, sourceRow: 4, sellDateSerial: 46012 }
  const l = buildLedger([high, own, other], [stock], { hedges: [{ id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 500 }], at: 1 }] })
  expect(l.orders.filter((o) => o.remainingQty > 0).map((o) => [o.sourceRow,o.remainingQty])).toEqual([[4,500]])
  expect(l.repairChains.find((c) => c.anchorRow === 2)?.holdingQty).toBe(500)
  flat(l)
})

it('两张历史人工挂钩同价卖单仍优先各自的同行买回', () => {
  const own = { ...root, buyDateSerial: 46013, buyPriceCents: 500, buyQtyRaw: 500 }
  const otherHigh = { ...high, sourceRow: 5, buyPriceCents: 1100 }
  const other = { ...root, sourceRow: 4, sellDateSerial: 46012 }
  const l = buildLedger([high, otherHigh, own, other], [stock], { hedges: [
    { id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 500 }], at: 1 },
    { id: 'hedge:4', sellRow: 4, items: [{ row: 5, qty: 500 }], at: 2 },
  ] })
  expect(l.orders.filter((o) => o.remainingQty > 0).map((o) => [o.sourceRow, o.remainingQty])).toEqual([[4, 500]])
  expect(l.repairChains.find((c) => c.anchorRow === 2)?.holdingQty).toBe(500)
  expect(l.repairChains.find((c) => c.anchorRow === 5)?.holdingQty).toBe(0)
  flat(l)
})

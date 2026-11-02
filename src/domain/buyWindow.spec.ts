import { describe, expect, it } from 'vitest'
import { buildBuyWindow, selectBuyWindow } from './buyWindow'
import { buildLedger } from './ledger'
import { buildBuySuggestions } from './suggestions'
import { buildNextRoundBuyRows } from './buyBoard'
import { limitRange } from './limit'
import type { Lot, RawRecord, StockConfig } from './types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 57, priceLimitType: 'main_10', enabled: true }
const lot = (price: number, remainingQty = 100, stockName = 'T'): Lot => ({
  id: `lot:${stockName}:${price}`, sourceRow: price, stockId: `stock:${stockName}`, stockName,
  buyPriceCents: price, buyDate: null, qty: 100, soldQty: 100 - remainingQty, remainingQty,
  targetPriceCents: price + 57, needsPrice: false, importKey: `lot:${price}`,
})
const row = (sourceRow: number, patch: Partial<RawRecord>): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: null, buyQtyRaw: null,
  qtyNeedsDerive: false, targetNeedsDerive: false,
  targetPriceCents: null, soldQty: 0, sellDateSerial: null, earlyBuyPriceCents: null,
  rawProfitCents: null, importKey: `row:${sourceRow}`, ...patch,
})
const windowOf = (lots: Lot[] = [lot(771)], range = limitRange(800, 'main_10')) =>
  buildBuyWindow({ lots, stockName: 'T', intervalCents: 57, range })

describe('最低未完成买单限定下一次买入', () => {
  it('以仍持仓的最低成本为参考，包含部分卖出与回补库存，不受其它股票和已卖光批次影响', () => {
    const virtual = { ...lot(771, 40), id: 'lot:exec:rebuy' }
    expect(windowOf([lot(850), lot(750, 0), lot(600, 100, 'U'), virtual])).toMatchObject({
      referenceCents: 771, nextGridCents: 714, todayRange: { downCents: 720, upCents: 770 },
    })
  })
  it('严格低于7.71并包含涨跌幅边界，高于或等于参考价不能混进区间外列表', () => {
    const prices = [880, 850, 771, 770, 750, 720, 719].map(priceCents => ({ priceCents }))
    const result = selectBuyWindow(prices, windowOf())
    expect(result.today.map(r => r.priceCents)).toEqual([770, 750, 720])
    expect(result.outside.map(r => r.priceCents)).toEqual([719])
    expect(result.excluded.map(r => r.priceCents)).toEqual([880, 850, 771])
  })
  it('真实账本的下一轮与欠股建议在改单、撞价合并后统一筛选，原账务不变', () => {
    const records = [
      row(2, { buyPriceCents: 771, buyQtyRaw: 500, targetPriceCents: 828 }),
      ...[850, 771, 750].map((p, i) => row(i + 3, { buyPriceCents: p, buyQtyRaw: 100, targetPriceCents: p + 57, soldQty: 100, sellDateSerial: 46001 })),
      row(6, { buyDateSerial: null, targetPriceCents: 830, soldQty: 100, sellDateSerial: 45990, earlyBuyPriceCents: 760 }),
    ]
    const ledger = buildLedger(records, [stock])
    const before = JSON.stringify(ledger)
    const next = buildNextRoundBuyRows({ ...ledger, merges: [] })
    const plans = [{ id: 'p', kind: 'buy' as const, refId: 'buy:optional:T:850', priceCents: 750, qty: 100, at: 1 }]
    const board = buildBuySuggestions(ledger.buySplits, next, plans)
    const result = selectBuyWindow(board, windowOf(ledger.lots))
    expect(result.today.map(r => [r.priceCents, r.qty])).toEqual([[760, 100], [750, 200]])
    expect(result.excluded.map(r => r.priceCents)).toEqual([771])
    expect(JSON.stringify(ledger)).toBe(before)
    const raised = buildBuySuggestions(ledger.buySplits, next, [{ ...plans[0], refId: 'buy:optional:T:750', priceCents: 800 }])
    expect(selectBuyWindow(raised, windowOf(ledger.lots)).today.every(r => r.priceCents < 771)).toBe(true)
  })
  it('卖完最低批次或新买更低一档后，参考价随当前库存重算', () => {
    expect(windowOf([lot(771, 0), lot(850)]).referenceCents).toBe(850)
    expect(windowOf([lot(771), lot(714)]).referenceCents).toBe(714)
  })
  it('真实回补成交生成的库存立即成为更低的买入参考', () => {
    const ledger = buildLedger([
      row(2, { buyPriceCents: 771, buyQtyRaw: 500, targetPriceCents: 828 }),
      row(3, { buyDateSerial: null, targetPriceCents: 800, soldQty: 100, sellDateSerial: 46001, earlyBuyPriceCents: 714 }),
    ], [stock], { executions: [{ id: 'rebuy', orderId: 'rb:sell:3', sellExecId: 'sell:3', stockId: stock.id,
      stockName: stock.name, qty: 100, priceCents: 714, rewardQty: 0, groupKeyAtExecution: 'T|714', at: Date.UTC(2026, 9, 22) }] })
    expect(ledger.lots.some(l => l.id.startsWith('lot:exec:') && l.remainingQty === 100)).toBe(true)
    expect(windowOf(ledger.lots).referenceCents).toBe(714)
  })
  it('没有持仓时不猜参考价，只按已确认的日内区间筛选', () => {
    const window = windowOf([lot(771, 0)])
    expect(window).toMatchObject({ referenceCents: null, nextGridCents: null, todayRange: { downCents: 720, upCents: 880 } })
    expect(selectBuyWindow([{ priceCents: 880 }, { priceCents: 881 }], window).today).toEqual([{ priceCents: 880 }])
  })
  it('未确认昨收/无涨跌幅配置不出今日推荐；日内最低价高于参考价时不倒置区间', () => {
    const unknown = windowOf([lot(771)], null)
    expect(unknown.todayRange).toBeNull()
    expect(selectBuyWindow([{ priceCents: 750 }], unknown)).toMatchObject({ today: [], outside: [] })
    expect(windowOf([lot(771)], limitRange(900, 'main_10')).todayRange).toBeNull()
  })
  it('手工涨跌停同样受参考上限约束；无间隔或下一档非正数不生成虚假价格', () => {
    expect(windowOf([lot(771)], { downCents: 700, upCents: 750, pct: 10 }).todayRange).toEqual({ downCents: 700, upCents: 750 })
    expect(buildBuyWindow({ lots: [lot(771)], stockName: 'T', intervalCents: null, range: null }).nextGridCents).toBeNull()
    expect(windowOf([lot(1)]).nextGridCents).toBeNull()
    expect(windowOf([lot(1)]).todayRange).toBeNull()
  })
})

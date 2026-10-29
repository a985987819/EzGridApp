import assert from 'node:assert/strict'
import { buildLedger } from '../../src/domain/ledger'
import { buildGridStats } from '../../src/domain/gridStats'
import { toCents, mulCents } from '../../src/domain/money'
import { isQty } from '../../src/domain/qty'
import { limitRange } from '../../src/domain/limit'
import { buildManualRecord } from '../../src/domain/manual'
import type { RawRecord, StockConfig } from '../../src/domain/types'

const stock: StockConfig = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' }
const rec = (sourceRow: number, p: Partial<RawRecord>): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null,
  qtyNeedsDerive: false, targetPriceCents: null, targetNeedsDerive: false,
  soldQty: null, sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null,
  importKey: `audit-root:${sourceRow}`, ...p,
})
const ledger = buildLedger([
  rec(1, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 1200 }),
  rec(2, { targetPriceCents: 700, soldQty: 500, sellDateSerial: 46010, earlyBuyPriceCents: 500 }),
], [stock])
const day = ledger.daily.find(d => !d.dateMissing)!
// StatsPage.CalendarCard currently reaggregates every ledger.sells item, including synthetic sells.
const calendarProjection = ledger.sells.filter(s => s.soldAt === day.day).reduce((a, s) => ({
  count: a.count + 1, qty: a.qty + s.qty, profitCents: a.profitCents + (s.profitCents ?? 0),
}), { count: 0, qty: 0, profitCents: 0 })
assert.equal(day.sellCount, 1)
assert.equal(day.sellQty, 500)
assert.equal(calendarProjection.count, 2)
assert.equal(calendarProjection.qty, 1000)
assert.equal(calendarProjection.profitCents, day.profitCents)
const grid = buildGridStats(ledger.lots, ledger.sells)
assert.equal(grid.realizedCents, -150000)
assert.equal(grid.doneRounds, 1)
assert(ledger.sells.some(s => s.hedgedFromSellRow !== undefined && !s.hedgeClosed))
assert(ledger.checks.every(c => c.ok))

const monthly = Array.from({ length: 13 }, (_, i) => ({
  month: `2025-${String(i + 1).padStart(2, '0')}`, profitCents: i, sellCount: 1,
}))
// Use 13 real months ending Jan 2026, plus the exact missing-date bucket sorted last by buildLedger.
monthly[12].month = '2026-01'
const withMissing = [...monthly, { month: '未填日期', profitCents: 123, sellCount: 1 }]
const recent = withMissing.slice(-12)
assert.equal(recent.at(-1)!.month, '未填日期')
assert.equal(recent.length, 12)
assert.equal(recent.filter(m => /^\d{4}-\d{2}$/.test(m.month)).length, 11)

const long = '9'.repeat(400)
assert.equal(toCents(long), Infinity)
assert.equal(isQty(1e20), true)
const cents = toCents('90071992547409.93')!
assert.equal(Number.isSafeInteger(cents), false)
assert.equal(Number.isSafeInteger(mulCents(1e10, 1e10)), false)
const custom = limitRange(1000, 'custom', 200)!
assert.equal(custom.downCents, -1000)
const unsafeInput = buildManualRecord({kind:'buy',stockName:'T',date:'2026-10-28',price:long,qty:'500'},100000)
assert.equal(unsafeInput.errors.length,0)
assert.equal(unsafeInput.record.buyPriceCents,Infinity)

console.log(JSON.stringify({
  calendar: { ledger: day, ui: calendarProjection },
  grid: { realizedCents: grid.realizedCents, doneRounds: grid.doneRounds, activeRounds: grid.activeRounds,
    avgProfitCents: grid.avgProfitCents, sells: ledger.sells.map(s => ({id:s.id,qty:s.qty,profit:s.profitCents,synthetic:s.hedgedFromSellRow!==undefined,closed:s.hedgeClosed??false})) },
  trend: { bucketCount:recent.length,datedCount:recent.filter(m=>/^\d{4}-\d{2}$/.test(m.month)).length, labels:recent.map(m=>m.month.slice(5)) },
  precision: { hugeStringProducesFinite:Number.isFinite(toCents(long)),quantity1e20Accepted:isQty(1e20),unsafeCents:String(cents),manualErrors:unsafeInput.errors,manualBuyPrice:String(unsafeInput.record.buyPriceCents) },
  customLimit: custom,
  conservation: ledger.checks.map(c=>({name:c.name,ok:c.ok})),
}, null, 2))

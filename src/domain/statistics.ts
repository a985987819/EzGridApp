import type { BookingReceipt } from './booking'
import { baseTRowSummary } from './gridStrategy'
import { isSellFirst } from './sellFirst'
import type { DayBucket, Ledger, MonthlyBucket, RawRecord } from './types'

export interface StatisticsEvent {
  id: string
  /** sale = 正常盈利卖出；rebuy = 先卖后买全部回补；baseT = 底仓做T的已实现价差 */
  kind: 'sale' | 'rebuy' | 'baseT'
  stockName: string
  sourceRows: number[]
  date: string | null
  originalSoldAt: string | null
  qty: number
  sellPriceCents: number
  buyPriceCents: number
  sellAmountCents: number
  buyAmountCents: number
  profitCents: number
}

export interface TradingStatistics {
  events: StatisticsEvent[]
  daily: DayBucket[]
  monthly: MonthlyBucket[]
  pendingRebuyCount: number
  unpricedCount: number
}

/** 网格表现视图：正收益卖出 + 全部回补后的实际价差；不回写总账、回本链或奖励池。 */
export function buildTradingStatistics(
  ledger: Pick<Ledger, 'sells' | 'lots'>,
  records: readonly RawRecord[],
  receipts: readonly BookingReceipt[] = [],
): TradingStatistics {
  const recordByRow = new Map(records.filter(r => !r.deletedAt).map(r => [r.sourceRow, r]))
  const lotById = new Map(ledger.lots.map(l => [l.id, l]))
  const realSells = ledger.sells.filter(s => s.hedgedFromSellRow === undefined && recordByRow.has(s.sourceRow))
  const sellByRow = new Map(realSells.map(s => [s.sourceRow, s]))
  const receiptByRow = new Map<number, string>()
  for (const receipt of receipts) {
    if (receipt.kind !== 'sell' || receipt.voidedAt) continue
    const parts = receipt.recordRows.flatMap(row => sellByRow.has(row) ? [sellByRow.get(row)!] : [])
    if (parts.length && parts.every(s => s.soldAt === parts[0].soldAt && s.priceCents === parts[0].priceCents && s.stockName === parts[0].stockName)) {
      for (const part of parts) receiptByRow.set(part.sourceRow, receipt.id)
    }
  }
  const grouped = new Map<string, StatisticsEvent>()
  let pendingRebuyCount = 0, unpricedCount = 0
  for (const sell of realSells) {
    const record = recordByRow.get(sell.sourceRow)!
    // repair 的低位后续卖出也继承 sellBeforeBuy 标记，但已完成的是正常买入后卖出。
    const lowRepairSale = sell.lotId !== null && lotById.get(sell.lotId)?.strategyOrigin?.mode === 'repair'
    const sellFirst = isSellFirst(record) || (sell.sellBeforeBuy && !lowRepairSale)
    /**
     * V9.72：显式「底仓做T」的先卖后买按**卖出日期**记录已实现做T价差。
     * 与普通先卖后买不同，这里不要求全部回补：买回多少就结算多少，每笔卖出单独一条；
     * 点击日历明细直接定位到这笔卖出（sourceRows 只放本行）。
     */
    if (isSellFirst(record) && sell.strategyMode === 'baseT') {
      const fills = sell.actualRebuyFills ?? []
      const summary = baseTRowSummary(sell)
      if (summary.boughtQty <= 0) continue
      if (sell.priceCents === null || fills.some((fill) => fill.priceCents === null)) { unpricedCount++; continue }
      const qty = summary.boughtQty
      const buyAmountCents = fills.reduce((sum, fill) => sum + fill.qty * fill.priceCents!, 0)
      const sellAmountCents = sell.priceCents * qty
      if (![buyAmountCents, sellAmountCents].every(Number.isSafeInteger) || qty <= 0) { unpricedCount++; continue }
      const date = sell.soldAt
      const id = `${sell.id}:baseT:${date ?? 'missing'}`
      grouped.set(id, {
        id, kind: 'baseT', stockName: sell.stockName, sourceRows: [sell.sourceRow], date, originalSoldAt: sell.soldAt,
        qty, sellPriceCents: sell.priceCents, buyPriceCents: Math.round(buyAmountCents / qty),
        sellAmountCents, buyAmountCents, profitCents: sellAmountCents - buyAmountCents,
      })
      continue
    }
    let date = sell.soldAt
    let buyAmountCents: number
    if (sellFirst) {
      if ((sell.actualRebuyQty ?? 0) < sell.qty) { pendingRebuyCount++; continue }
      const fills = sell.actualRebuyFills ?? []
      if (fills.reduce((sum, fill) => sum + fill.qty, 0) !== sell.qty || fills.some(fill => fill.priceCents === null)) {
        unpricedCount++; continue
      }
      buyAmountCents = fills.reduce((sum, fill) => sum + fill.qty * fill.priceCents!, 0)
      date = fills.some(fill => fill.date === null) ? null : fills.reduce((last, fill) => fill.date! > last ? fill.date! : last, '') || null
    } else {
      // 本视图不展示高买低卖亏损，也不把缺成本或未确认的盈利当成已赚。
      if (sell.profitCents === null || sell.profitCents <= 0 || sell.costCents === null) continue
      buyAmountCents = sell.costCents * sell.qty
    }
    if (sell.priceCents === null) { unpricedCount++; continue }
    const sellAmountCents = sell.priceCents * sell.qty
    if (![buyAmountCents, sellAmountCents].every(Number.isSafeInteger) || !Number.isSafeInteger(sell.qty) || sell.qty <= 0) { unpricedCount++; continue }
    const kind = sellFirst ? 'rebuy' : 'sale'
    // 同一回执若分配到不同完成日/方向，分别展示；不能把未回补部分并入完成记录。
    const id = `${receiptByRow.get(sell.sourceRow) ?? sell.id}:${kind}:${date ?? 'missing'}`
    const hit = grouped.get(id)
    if (hit) {
      hit.sourceRows.push(sell.sourceRow)
      hit.qty += sell.qty
      hit.buyAmountCents += buyAmountCents
      hit.sellAmountCents += sellAmountCents
      hit.profitCents += sellAmountCents - buyAmountCents
      hit.buyPriceCents = Math.round(hit.buyAmountCents / hit.qty)
    } else grouped.set(id, {
      id, kind, stockName: sell.stockName, sourceRows: [sell.sourceRow], date, originalSoldAt: sell.soldAt,
      qty: sell.qty, sellPriceCents: sell.priceCents, buyPriceCents: Math.round(buyAmountCents / sell.qty),
      sellAmountCents, buyAmountCents, profitCents: sellAmountCents - buyAmountCents,
    })
  }
  const events = [...grouped.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id))
  const days = new Map<string, DayBucket>(), months = new Map<string, MonthlyBucket>()
  for (const event of events) {
    const day = event.date ?? '未填日期', month = event.date?.slice(0, 7) ?? '未填日期'
    const daily = days.get(day) ?? { day, sellCount: 0, sellQty: 0, profitCents: 0, dateMissing: event.date === null }
    daily.sellCount++; daily.sellQty += event.qty; daily.profitCents += event.profitCents
    days.set(day, daily)
    const monthly = months.get(month) ?? { month, sellCount: 0, sellQty: 0, sellAmountCents: 0, profitCents: 0, dateMissing: event.date === null }
    monthly.sellCount++; monthly.sellQty += event.qty; monthly.sellAmountCents += event.sellAmountCents; monthly.profitCents += event.profitCents
    months.set(month, monthly)
  }
  return { events, daily: [...days.values()].sort((a,b) => a.day.localeCompare(b.day)),
    monthly: [...months.values()].sort((a,b) => a.month.localeCompare(b.month)), pendingRebuyCount, unpricedCount }
}

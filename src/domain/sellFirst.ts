import { serialToIso } from './defaults'
import type { HedgeLink, Lot, RawRecord, SellExecution } from './types'

/** 日期缺失时不把一笔未知时间的买入猜成已完成回补。 */
export function isSellFirst(rec: Pick<RawRecord, 'buyPriceCents' | 'buyDateSerial' | 'sellDateSerial' | 'soldQty' | 'soldLotId'>): boolean {
  if (rec.soldLotId || (rec.soldQty ?? 0) <= 0) return false
  const buy = serialToIso(rec.buyDateSerial)
  const sell = serialToIso(rec.sellDateSerial)
  return rec.buyPriceCents === null || (sell !== null && (buy === null || sell <= buy))
}

/** 人工关联先占额度；其余按卖出日、源行号，依次分配当时已买入的最高成本剩余股。 */
export function defaultHedges(records: readonly RawRecord[], lots: readonly Lot[], sells: readonly SellExecution[], manual: readonly HedgeLink[]): HedgeLink[] {
  const links = [...manual].sort((a, b) => a.at - b.at)
  const byRow = new Map(records.map((r) => [r.sourceRow, r]))
  const available = new Map(lots.map((l) => [l.sourceRow, l.remainingQty]))
  for (const s of sells) {
    const rec = byRow.get(s.sourceRow)
    if (rec?.soldLotId?.startsWith('lot:')) {
      const row = Number(rec.soldLotId.slice(4))
      available.set(row, Math.max(0, (available.get(row) ?? 0) - s.qty))
    }
  }
  for (const h of links) {
    const rec = byRow.get(h.sellRow)
    if (!rec || !isSellFirst(rec)) continue
    let left = rec.soldQty ?? 0
    for (const it of h.items) {
      const lot = lots.find((l) => l.sourceRow === it.row)
      const lotRec = byRow.get(it.row)
      if (!lot || !lotRec || lot.stockName !== rec.stockName || isSellFirst(lotRec)) continue
      const q = Math.min(left, Math.max(0, it.qty), available.get(it.row) ?? 0)
      available.set(it.row, (available.get(it.row) ?? 0) - q)
      left -= q
    }
  }
  const overridden = new Set(manual.map((h) => h.sellRow))
  const roots = sells.filter((s) => s.sellBeforeBuy && s.soldAt !== null && s.priceCents !== null && !overridden.has(s.sourceRow))
    .sort((a, b) => a.soldAt!.localeCompare(b.soldAt!) || a.sourceRow - b.sourceRow)
  for (const s of roots) {
    let left = s.qty
    const items: HedgeLink['items'] = []
    const candidates = lots.filter((l) => l.stockName === s.stockName && l.sourceRow !== s.sourceRow &&
      l.buyDate !== null && l.buyDate <= s.soldAt! && l.buyPriceCents > s.priceCents! &&
      byRow.has(l.sourceRow) && !isSellFirst(byRow.get(l.sourceRow)!))
      .sort((a, b) => b.buyPriceCents - a.buyPriceCents || a.sourceRow - b.sourceRow)
    for (const lot of candidates) {
      const q = Math.min(left, available.get(lot.sourceRow) ?? 0)
      if (q <= 0) continue
      items.push({ row: lot.sourceRow, qty: q })
      available.set(lot.sourceRow, (available.get(lot.sourceRow) ?? 0) - q)
      left -= q
      if (left === 0) break
    }
    if (items.length) links.push({ id: `hedge:${s.sourceRow}`, sellRow: s.sourceRow, items, at: 0 })
  }
  return links
}

import { serialToIso } from './defaults'
import type { RawRecord, RebuyExecution, SellExecution } from './types'
import { deriveBuyQty } from './qty'

export interface BookingOptions {
  commandId?: string
  externalRef?: string
  allowSimilar?: boolean
  anchorRow?: number
}

export function bookingPayload(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
/** 一次真实成交可分配到多个批次/订单；操作身份与这些分配记录分开保存。 */
export interface BookingReceipt {
  id: string
  payload: string
  kind: 'buy' | 'sell' | 'import'
  stockName: string
  qty: number
  priceCents: number
  date: string | null
  at: number
  recordRows: number[]
  executionIds: string[]
  externalRef?: string
  reviewedAt?: number
  voidedAt?: number
}

export interface TradeFact {
  id: string
  stockName: string
  side: 'buy' | 'sell'
  qty: number
  priceCents: number | null
  date: string | null
  rows: number[]
  executionIds: string[]
  source: string
  voided: boolean
  reviewed: boolean
  externalRef?: string
}

/** 统一成交流水只读取事实，不读链分支和合成成本分配。 */
export function tradeFacts(records: readonly RawRecord[], executions: readonly RebuyExecution[], receipts: readonly BookingReceipt[] = []): TradeFact[] {
  const out: TradeFact[] = []
  const covered = new Set<string>()
  const recordByRow = new Map(records.map(r => [r.sourceRow, r]))
  const execById = new Map(executions.map(e => [e.id, e]))
  for (const receipt of receipts) {
    if (receipt.kind === 'import') continue
    const existingRows = receipt.recordRows.map(row => recordByRow.get(row)).filter((r): r is RawRecord => Boolean(r))
    const existingExecs = receipt.executionIds.map(id => execById.get(id)).filter((e): e is RebuyExecution => Boolean(e))
    if (existingRows.length + existingExecs.length === 0 && !receipt.voidedAt) continue
    for (const row of existingRows) if (!receipt.voidedAt || row.deletedAt) covered.add(`${receipt.kind}:${row.sourceRow}`)
    for (const id of receipt.executionIds) covered.add(`exec:${id}`)
    const parts = [
      ...existingRows.filter(r => !r.deletedAt).map(r => ({ qty: (receipt.kind === 'buy' ? r.buyQtyRaw ?? (r.qtyNeedsDerive && r.buyPriceCents ? deriveBuyQty(r.buyPriceCents) : 0) : r.soldQty) ?? 0, price: receipt.kind === 'buy' ? r.buyPriceCents : r.targetPriceCents, date: serialToIso(receipt.kind === 'buy' ? r.buyDateSerial : r.sellDateSerial) })),
      ...existingExecs.map(e => ({ qty: e.qty, price: e.priceCents, date: new Date(e.at).toLocaleDateString('sv-SE') })),
    ]
    const voided = Boolean(receipt.voidedAt) || parts.length === 0
    const actualQty = voided ? receipt.qty : parts.reduce((sum, p) => sum + p.qty, 0)
    const actualPrice = voided ? receipt.priceCents : parts.every(p => p.price === parts[0].price) ? parts[0].price : null
    const actualDate = voided ? receipt.date : parts.every(p => p.date === parts[0].date) ? parts[0].date : null
    out.push({ id: receipt.id, stockName: receipt.stockName, side: receipt.kind, qty: actualQty, priceCents: actualPrice,
      date: actualDate, rows: receipt.recordRows.filter(row => !receipt.voidedAt || recordByRow.get(row)?.deletedAt), executionIds: receipt.executionIds, source: '成交回执', voided,
      reviewed: Boolean(receipt.reviewedAt) && actualQty === receipt.qty && actualPrice === receipt.priceCents && actualDate === receipt.date, externalRef: receipt.externalRef })
  }
  for (const r of records) {
    const buyQty = r.buyQtyRaw ?? (r.qtyNeedsDerive && r.buyPriceCents ? deriveBuyQty(r.buyPriceCents) : 0)
    if (!r.soldLotId && r.buyPriceCents !== null && buyQty > 0 && !covered.has(`buy:${r.sourceRow}`)) out.push({
      id: `buy:record:${r.sourceRow}`, stockName: r.stockName, side: 'buy', qty: buyQty, priceCents: r.buyPriceCents,
      date: serialToIso(r.buyDateSerial), rows: [r.sourceRow], executionIds: [], source: r.origin === 'manual' ? '手工记录' : '历史台账', voided: Boolean(r.deletedAt), reviewed: false,
    })
    if ((r.soldQty ?? 0) > 0 && !covered.has(`sell:${r.sourceRow}`)) out.push({
      id: `sell:record:${r.sourceRow}`, stockName: r.stockName, side: 'sell', qty: r.soldQty!, priceCents: r.targetPriceCents,
      date: serialToIso(r.sellDateSerial), rows: [r.sourceRow], executionIds: [], source: '原始卖出', voided: Boolean(r.deletedAt), reviewed: false,
    })
  }
  for (const e of executions) if (!covered.has(`exec:${e.id}`)) out.push({ id: `buy:execution:${e.id}`, stockName: e.stockName, side: 'buy', qty: e.qty,
    priceCents: e.priceCents, date: new Date(e.at).toLocaleDateString('sv-SE'), rows: [], executionIds: [e.id], source: '回补成交', voided: false, reviewed: false })
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id))
}

export function similarFacts(facts: readonly TradeFact[], side: 'buy' | 'sell', stockName: string, date: string | null, price: number, qty: number): TradeFact[] {
  return facts.filter(f => !f.voided && f.stockName === stockName && f.side === side && f.date === date && f.priceCents === price && f.qty === qty)
}

export function allocatePlan(members: readonly { key: string; qty: number }[], qty: number): { key: string; qty: number }[] {
  const total = members.reduce((sum, m) => sum + m.qty, 0)
  if (!Number.isSafeInteger(qty) || qty < members.length || qty > total) throw new Error(`合并计划量须在 ${members.length}～${total} 股之间；更小数量请逐来源改单`)
  let remaining = qty
  return members.map((m, i) => {
    const later = members.slice(i + 1)
    const minimum = Math.max(1, remaining - later.reduce((sum, other) => sum + other.qty, 0))
    const take = i === members.length - 1 ? remaining : Math.max(minimum, Math.min(m.qty, Math.round(qty * m.qty / total), remaining - later.length))
    remaining -= take
    return { key: m.key, qty: take }
  })
}

export function bookingContributions<T extends { qty: number }>(sources: readonly T[], qty: number): T[] {
  let left = Number.isSafeInteger(qty) && qty > 0 ? qty : 0
  return sources.flatMap(source => { const q = Math.min(left, source.qty); left -= q; return q > 0 ? [{ ...source, qty: q }] : [] })
}

/** 展示同一真实卖出一次，成本分配的盈亏仍保留；不改变总账输入。 */
export function saleFacts(sells: readonly SellExecution[], receipts: readonly BookingReceipt[] = []): SellExecution[] {
  const realSells = sells.filter(s => s.hedgedFromSellRow === undefined)
  const receiptByRow = new Map(receipts.filter(r => r.kind === 'sell' && !r.voidedAt).flatMap(r => {
    const parts = realSells.filter(s => r.recordRows.includes(s.sourceRow))
    return parts.every(s => s.soldAt === parts[0]?.soldAt && s.priceCents === parts[0]?.priceCents && s.stockName === parts[0]?.stockName)
      ? r.recordRows.map(row => [row, r.id] as const) : []
  }))
  const out = new Map<string, SellExecution>()
  for (const real of realSells) {
    const allocations = sells.filter(s => s.hedgedFromSellRow === real.sourceRow)
    const profit = real.profitCents === null && allocations.length === 0 ? null : (real.profitCents ?? 0) + allocations.reduce((sum, s) => sum + (s.profitCents ?? 0), 0)
    const key = receiptByRow.get(real.sourceRow) ?? real.id
    const previous = out.get(key)
    if (!previous) out.set(key, { ...real, id: key, profitCents: profit })
    else out.set(key, { ...previous, qty: previous.qty + real.qty, profitCents: previous.profitCents === null && profit === null ? null : (previous.profitCents ?? 0) + (profit ?? 0),
      priceCents: previous.priceCents === real.priceCents ? real.priceCents : null, costCents: previous.costCents === real.costCents ? real.costCents : null })
  }
  return [...out.values()]
}

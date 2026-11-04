import type { ActualRebuyFill, Lot, RealRebuyCoverSlice, RebuyExecution, SellExecution } from './types'

/**
 * 与 covers 的来源优先级一致：同行买入、显式回补基础股、独立真实买入覆盖。
 * 仅展开已经确认的来源；未知日期/价格保留缺失，不用计划价或高位交割补齐。
 */
export function buildActualRebuyFills(input: {
  sell: Pick<SellExecution, 'id' | 'sourceRow' | 'qty' | 'ownLotCoverQty'>
  lotsById: ReadonlyMap<string, Lot>
  executions: readonly RebuyExecution[]
  realCoverSlices?: readonly RealRebuyCoverSlice[]
}): ActualRebuyFill[] {
  const { sell, lotsById, executions, realCoverSlices = [] } = input
  const fills: ActualRebuyFill[] = []
  const usedBySource = new Map<string, number>()
  if (!Number.isSafeInteger(sell.qty) || sell.qty <= 0) return fills
  let left = sell.qty
  const validPrice = (price: number | null): number | null => price !== null && Number.isSafeInteger(price) && price > 0 ? price : null
  const validDate = (day: string | null): string | null => {
    if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
    const date = new Date(`${day}T12:00:00`)
    return Number.isFinite(date.getTime()) && date.toLocaleDateString('sv-SE') === day ? day : null
  }
  const take = (fill: ActualRebuyFill, capacity: number) => {
    if (!Number.isSafeInteger(fill.qty) || fill.qty <= 0 || !Number.isSafeInteger(capacity) || capacity <= 0) return
    const used = usedBySource.get(fill.sourceLotId) ?? 0
    const qty = Math.max(0, Math.min(left, fill.qty, capacity - used))
    if (qty <= 0) return
    fills.push({ ...fill, qty, priceCents: validPrice(fill.priceCents), date: validDate(fill.date) })
    usedBySource.set(fill.sourceLotId, used + qty)
    left -= qty
  }
  const ownId = `lot:${sell.sourceRow}`
  const own = lotsById.get(ownId)
  take({ sourceLotId: ownId, qty: sell.ownLotCoverQty ?? 0, priceCents: own?.buyPriceCents ?? null,
    date: own?.buyDate ?? null }, own?.qty ?? sell.ownLotCoverQty ?? 0)
  const seenExecutions = new Set<string>()
  for (const execution of executions.filter(e => e.sellExecId === sell.id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    if (seenExecutions.has(execution.id)) continue
    seenExecutions.add(execution.id)
    const baseQty = Math.max(0, execution.qty - execution.rewardQty)
    const date = new Date(execution.at)
    take({ sourceLotId: `lot:exec:${execution.id}`, qty: baseQty, priceCents: execution.priceCents,
      date: Number.isFinite(date.getTime()) ? date.toLocaleDateString('sv-SE') : null }, baseQty)
  }
  for (const slice of realCoverSlices) {
    const lot = lotsById.get(slice.lotId)
    take({ sourceLotId: slice.lotId, qty: slice.qty, priceCents: lot?.buyPriceCents ?? null,
      date: lot?.buyDate ?? null }, lot?.qty ?? slice.qty)
  }
  return fills
}

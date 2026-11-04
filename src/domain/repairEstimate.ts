import type { Ledger, Lot, RepairChain, SellExecution } from './types'

export type RepairRoundEstimate = {
  status: 'ready'
  rounds: number
  buyPriceCents: number
  sellPriceCents: number
  qty: number
  profitPerRoundCents: number
  source: 'actual' | 'target' | 'plan'
} | { status: 'done' | 'unlinked' | 'unavailable' }

type EstimateLedger = Pick<Ledger, 'lots' | 'sells' | 'targets' | 'orders'>
const positiveInteger = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * 一次统一按原亏损份额 anchorQty 股完成买卖；剩余次数只作参考，不计入链盈利。
 * 参考顺序：最近实际盈利成交 → 最近归属批次原卖出目标 → 根卖单回补计划。
 * 不累计历代分支股数/卖出次数，也不使用只改变展示的 P8 改单价。
 */
export function estimateRepairRounds(chain: RepairChain, ledger: EstimateLedger): RepairRoundEstimate {
  if ((chain.unlinkedQty ?? 0) > 0) return { status: 'unlinked' }
  if (chain.done || chain.gapCents === 0) return { status: 'done' }
  if (chain.closedByUserAt !== null || !positiveInteger(chain.anchorQty) || !positiveInteger(chain.gapCents)) return { status: 'unavailable' }

  const makeEstimate = (buyPriceCents: number | null, sellPriceCents: number | null, source: 'actual' | 'target' | 'plan'): RepairRoundEstimate => {
    if (!positiveInteger(buyPriceCents) || !positiveInteger(sellPriceCents) || sellPriceCents <= buyPriceCents) return { status: 'unavailable' }
    const profitPerRoundCents = (sellPriceCents - buyPriceCents) * chain.anchorQty
    if (!positiveInteger(profitPerRoundCents)) return { status: 'unavailable' }
    const rounds = Number((BigInt(chain.gapCents) + BigInt(profitPerRoundCents) - 1n) / BigInt(profitPerRoundCents))
    return { status: 'ready', rounds, buyPriceCents, sellPriceCents, qty: chain.anchorQty, profitPerRoundCents, source }
  }

  const lotsById = new Map(ledger.lots.filter(lot => lot.stockName === chain.stockName).map(lot => [lot.id, lot]))
  const rootRows = new Set([chain.anchorRow, ...chain.relatedSellRows,
    ...chain.branches.flatMap(branch => branch.rootSellRow === null ? [] : [branch.rootSellRow])])
  const realSells = ledger.sells.filter(sale => sale.stockName === chain.stockName && sale.hedgedFromSellRow === undefined)
  const roots = realSells.filter(sale => rootRows.has(sale.sourceRow))
  const highLotIds = new Set(roots.filter(sale => sale.lotId !== null && sale.priceCents !== null &&
    (lotsById.get(sale.lotId)?.buyPriceCents ?? 0) > sale.priceCents).map(sale => sale.lotId!))
  const referenceLots = new Map<string, Lot>()
  const wholeOwnedLots = new Set<string>()
  const slotSaleRows = new Set<number>()
  const addLot = (id: string, whole = false) => {
    const lot = lotsById.get(id)
    if (!lot || highLotIds.has(id) || lot.strategyOrigin?.mode === 'baseT' || !positiveInteger(lot.qty)) return
    referenceLots.set(id, lot)
    if (whole) wholeOwnedLots.add(id)
  }
  for (const branch of chain.branches) {
    if (branch.kind === 'record' && branch.row !== null) {
      const id = `lot:${branch.row}`
      addLot(id, branch.qty === lotsById.get(id)?.qty)
    } else if (branch.kind === 'rebuy' && branch.key.startsWith('exec:')) {
      const id = `lot:${branch.key}`
      addLot(id, branch.qty === lotsById.get(id)?.qty)
    } else if (branch.kind === 'sell') {
      for (const row of branch.memberRows) {
        addLot(`lot:${row}`, true)
        slotSaleRows.add(row)
      }
    }
  }
  // 价位槽尚未卖出的虚拟批次不在 memberRows 中；由已确认实际回补来源补齐。
  for (const root of roots) for (const fill of root.actualRebuyFills ?? []) addLot(fill.sourceLotId)
  for (const sale of realSells) if (slotSaleRows.has(sale.sourceRow) && sale.lotId !== null) addLot(sale.lotId)

  const newestSale = (a: SellExecution, b: SellExecution) =>
    (b.soldAt ?? '').localeCompare(a.soldAt ?? '') || b.sourceRow - a.sourceRow || b.id.localeCompare(a.id)
  const actual = realSells.filter(sale => {
    const lot = sale.lotId === null ? undefined : referenceLots.get(sale.lotId)
    return lot !== undefined && !rootRows.has(sale.sourceRow) && sale.soldAt !== null &&
      (wholeOwnedLots.has(lot.id) || slotSaleRows.has(sale.sourceRow)) && positiveInteger(sale.qty) &&
      positiveInteger(sale.profitCents) && positiveInteger(sale.priceCents) && positiveInteger(lot.buyPriceCents) && sale.priceCents > lot.buyPriceCents
  }).sort(newestSale)[0]
  if (actual?.lotId) return makeEstimate(referenceLots.get(actual.lotId)!.buyPriceCents, actual.priceCents, 'actual')

  const latestLot = [...referenceLots.values()].sort((a, b) =>
    (b.buyDate ?? '').localeCompare(a.buyDate ?? '') || b.sourceRow - a.sourceRow || b.id.localeCompare(a.id))[0]
  if (latestLot) {
    const target = ledger.targets.filter(item => item.lotId === latestLot.id && item.qty > 0 && item.strategyMode !== 'baseT')
      .slice().sort((a, b) => a.priceCents - b.priceCents || a.id.localeCompare(b.id))[0]
    // 实际买回成本已知时，不能回退到旧 P 计划买价冒充实际成本。
    return makeEstimate(latestLot.buyPriceCents, target?.priceCents ?? latestLot.targetPriceCents, 'target')
  }
  const root = roots.slice().sort(newestSale)[0]
  if (!root) return { status: 'unavailable' }
  const buyPrice = root.rebuyPriceCents ?? ledger.orders.find(order => order.sellExecId === root.id)?.rebuyPriceCents ?? null
  return makeEstimate(buyPrice, root.priceCents, 'plan')
}

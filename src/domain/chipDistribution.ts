import { tradeFacts, type BookingReceipt } from './booking'
import type { Ledger, RawRecord, RebuyExecution } from './types'

export interface ChipPriceLevel {
  priceCents: number
  tradeCount: number
  buyCount: number
  sellCount: number
  tradeQty: number
  holdingQty: number
  holdingLotCount: number
  tradeRows: number[]
  holdingRows: number[]
}

export interface FrequentTradeRange {
  loCents: number
  hiCents: number
  count: number
  qty: number
  buyCount: number
  sellCount: number
  sourceRows: number[]
}

export interface HeavyHoldingRange {
  loCents: number
  hiCents: number
  qty: number
  lotCount: number
  sourceRows: number[]
}

export interface ChipDistribution {
  stockName: string
  /** 区间允许的最大跨度；无有效间隔时只比较同价。 */
  widthCents: number
  totalTradeCount: number
  totalTradeQty: number
  totalHoldingQty: number
  totalHoldingLots: number
  /** 非正/缺失/混合价格或非法数量的事实不猜测一个价位。 */
  excludedTradeCount: number
  hotTrades: FrequentTradeRange | null
  heavyHoldings: HeavyHoldingRange | null
  levels: ChipPriceLevel[]
}

export interface ChipDistributionInput {
  stockName: string
  ledger: Pick<Ledger, 'lots' | 'sells'>
  records: readonly RawRecord[]
  executions: readonly RebuyExecution[]
  receipts?: readonly BookingReceipt[]
  intervalCents?: number | null
}

type MutableLevel = Omit<ChipPriceLevel, 'tradeRows' | 'holdingRows'> & {
  tradeRows: Set<number>
  holdingRows: Set<number>
}
const positiveInteger = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const sortedRows = (rows: Iterable<number>): number[] => [...new Set(rows)].sort((a, b) => a - b)

interface WindowResult {
  left: number
  right: number
  first: number
  second: number
  buys: number
  sells: number
}

/** 每个价位权重为正，双指针只扫描合法窗口；不按价格差逐分枚举。 */
function bestWindow(levels: readonly ChipPriceLevel[], width: number, holding: boolean): WindowResult | null {
  let left = 0, first = 0, second = 0, buys = 0, sells = 0
  let best: WindowResult | null = null
  for (let right = 0; right < levels.length; right++) {
    const point = levels[right]
    first += holding ? point.holdingQty : point.tradeCount
    second += holding ? point.holdingLotCount : point.tradeQty
    buys += point.buyCount
    sells += point.sellCount
    while (point.priceCents - levels[left].priceCents > width) {
      const old = levels[left++]
      first -= holding ? old.holdingQty : old.tradeCount
      second -= holding ? old.holdingLotCount : old.tradeQty
      buys -= old.buyCount
      sells -= old.sellCount
    }
    const span = point.priceCents - levels[left].priceCents
    const bestSpan = best ? levels[best.right].priceCents - levels[best.left].priceCents : 0
    if (!best || first > best.first || (first === best.first && (
      second > best.second || (second === best.second && (
        span < bestSpan || (span === bestSpan && levels[left].priceCents < levels[best.left].priceCents)
      ))
    ))) best = { left, right, first, second, buys, sells }
  }
  return best
}

/** 全历史真实买卖频次与当前未卖批次成本分布；只展示，不生成账务或计划。 */
export function buildChipDistribution({ stockName, ledger, records, executions, receipts = [], intervalCents }: ChipDistributionInput): ChipDistribution {
  const widthCents = positiveInteger(intervalCents) ? intervalCents : 0
  const liveRecords = records.filter(record => !record.deletedAt && record.stockName === stockName)
  const liveByRow = new Map(liveRecords.map(record => [record.sourceRow, record]))
  const lots = ledger.lots.filter(lot => lot.stockName === stockName)
  const realBuyRows = new Set(lots.filter(lot => lot.id === `lot:${lot.sourceRow}` && liveByRow.has(lot.sourceRow)).map(lot => lot.sourceRow))
  const realSells = ledger.sells.filter(sell => sell.stockName === stockName && sell.hedgedFromSellRow === undefined && liveByRow.has(sell.sourceRow))
  const realSellRows = new Set(realSells.map(sell => sell.sourceRow))
  const realSellById = new Map(realSells.map(sell => [sell.id, sell]))
  const virtualLots = new Set(lots.filter(lot => lot.id.startsWith('lot:exec:')).map(lot => lot.id))
  const scopedExecutions = executions.filter(execution => execution.stockName === stockName &&
    virtualLots.has(`lot:exec:${execution.id}`) && realSellById.has(execution.sellExecId))
  const executionById = new Map(scopedExecutions.map(execution => [execution.id, execution]))
  const rootOfExecution = new Map(scopedExecutions.map(execution => [execution.id, realSellById.get(execution.sellExecId)!.sourceRow]))
  // 断链子记录不能仅因 deletedAt 为空就重新成为成交；每一侧均以有效台账为门。
  const scopedRecords = liveRecords.filter(record => realBuyRows.has(record.sourceRow) || realSellRows.has(record.sourceRow)).map(record => ({
    ...record,
    ...(!realBuyRows.has(record.sourceRow) ? { buyPriceCents: null, buyQtyRaw: null, qtyNeedsDerive: false } : {}),
    ...(!realSellRows.has(record.sourceRow) ? { soldQty: null } : {}),
  }))
  const rawRecordByRow = new Map(records.map(record => [record.sourceRow, record]))
  const rawExecutionById = new Map(executions.map(execution => [execution.id, execution]))
  const scopedReceipts = receipts.filter(receipt => receipt.stockName === stockName)
  const wrongStockReceipts = new Set(scopedReceipts.filter(receipt =>
    receipt.recordRows.some(row => { const record = rawRecordByRow.get(row); return record && !record.deletedAt && record.stockName !== stockName }) ||
    receipt.executionIds.some(id => { const execution = rawExecutionById.get(id); return execution && execution.stockName !== stockName }),
  ).map(receipt => receipt.id))
  const levels = new Map<number, MutableLevel>()
  const levelAt = (priceCents: number): MutableLevel => {
    let level = levels.get(priceCents)
    if (!level) {
      level = { priceCents, tradeCount: 0, buyCount: 0, sellCount: 0, tradeQty: 0, holdingQty: 0, holdingLotCount: 0, tradeRows: new Set(), holdingRows: new Set() }
      levels.set(priceCents, level)
    }
    return level
  }
  let totalTradeCount = 0, totalTradeQty = 0, totalHoldingQty = 0, totalHoldingLots = 0, excludedTradeCount = 0
  for (const fact of tradeFacts(scopedRecords, scopedExecutions, scopedReceipts)) {
    if (fact.voided || fact.stockName !== stockName) continue
    if (!positiveInteger(fact.priceCents) || !positiveInteger(fact.qty) || wrongStockReceipts.has(fact.id) || !Number.isSafeInteger(totalTradeQty + fact.qty)) {
      excludedTradeCount++
      continue
    }
    const level = levelAt(fact.priceCents)
    level.tradeCount++
    level.tradeQty += fact.qty
    if (fact.side === 'buy') level.buyCount++
    else level.sellCount++
    for (const row of fact.rows) if (liveByRow.has(row) && (fact.side === 'buy' ? realBuyRows : realSellRows).has(row)) level.tradeRows.add(row)
    for (const id of fact.executionIds) {
      const row = rootOfExecution.get(id)
      if (row !== undefined) level.tradeRows.add(row)
    }
    totalTradeCount++
    totalTradeQty += fact.qty
  }
  for (const lot of lots) {
    if (!positiveInteger(lot.buyPriceCents) || !positiveInteger(lot.remainingQty) || !Number.isSafeInteger(totalHoldingQty + lot.remainingQty)) continue
    let sourceRow = lot.sourceRow
    if (lot.id.startsWith('lot:exec:')) {
      const executionId = lot.id.slice('lot:exec:'.length)
      if (!executionById.has(executionId)) continue
      sourceRow = rootOfExecution.get(executionId)!
    } else if (!realBuyRows.has(lot.sourceRow)) continue
    const level = levelAt(lot.buyPriceCents)
    level.holdingQty += lot.remainingQty
    level.holdingLotCount++
    level.holdingRows.add(sourceRow)
    totalHoldingQty += lot.remainingQty
    totalHoldingLots++
  }
  const ordered: ChipPriceLevel[] = [...levels.values()].sort((a, b) => a.priceCents - b.priceCents).map(level => ({ ...level, tradeRows: sortedRows(level.tradeRows), holdingRows: sortedRows(level.holdingRows) }))
  const traded = ordered.filter(level => level.tradeCount > 0)
  const held = ordered.filter(level => level.holdingQty > 0)
  const tradeWindow = bestWindow(traded, widthCents, false)
  const holdingWindow = bestWindow(held, widthCents, true)
  return {
    stockName, widthCents, totalTradeCount, totalTradeQty, totalHoldingQty, totalHoldingLots, excludedTradeCount,
    hotTrades: tradeWindow ? {
      loCents: traded[tradeWindow.left].priceCents, hiCents: traded[tradeWindow.right].priceCents,
      count: tradeWindow.first, qty: tradeWindow.second, buyCount: tradeWindow.buys, sellCount: tradeWindow.sells,
      sourceRows: sortedRows(traded.slice(tradeWindow.left, tradeWindow.right + 1).flatMap(level => level.tradeRows)),
    } : null,
    heavyHoldings: holdingWindow ? {
      loCents: held[holdingWindow.left].priceCents, hiCents: held[holdingWindow.right].priceCents,
      qty: holdingWindow.first, lotCount: holdingWindow.second,
      sourceRows: sortedRows(held.slice(holdingWindow.left, holdingWindow.right + 1).flatMap(level => level.holdingRows)),
    } : null,
    levels: ordered,
  }
}

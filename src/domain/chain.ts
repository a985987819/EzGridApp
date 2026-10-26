/**
 * 回本链（V9.46 新口径）——纯派生，不落库（归属关系除外）。
 *
 * 一条链 = 一次「亏着清仓」的原始亏损 + 后续归属交易的**已实现净盈利**。
 *
 *   建链：某个买入批次卖完了、且这笔卖出是亏的 → 立即成链（一直不买回，亏损也留在账上）。
 *        先卖后买被高位批次「了结」的那一截，同样按了结卖出建链（沿用 V9.36 的入口）。
 *   进度：只累计**已经完成的买卖净盈利**（归属批次自己的卖出盈亏）。
 *        「7 元卖、6 元买回」省下的 1 元/股单独算「回补节省」，绝不再计一次——
 *        否则省下的钱和再卖出的利润会双算，界面显示已回本、现金却还少。
 *   归属：真实买出行人工挂到链上（chainLinks 表）；从锚点卖出的「记成交」产生的
 *        回补批次自动作为分支计入持仓（未卖 = 盈利 0）。
 *   分支：原始亏损按「分支买入股数 / 锚点股数」分摊；没买回的份额留作未分摊亏损。
 */
import { mulCents } from './money'
import type {
  Lot,
  RebuyExecution,
  RepairBranch,
  RepairChain,
  RepairChainLink,
  SellExecution,
} from './types'

interface Seed {
  anchorRow: number
  stockName: string
  qty: number
  costSum: number
  closeSum: number
  lossCents: number
  relatedSellRows: number[]
  sells: SellExecution[]
}

function sum<T>(arr: readonly T[], f: (x: T) => number): number {
  return arr.reduce((a, x) => a + f(x), 0)
}

/** 加权平均（分）；股数为 0 时 null */
function weighted(sumCents: number, qty: number): number | null {
  return qty > 0 ? Math.round(sumCents / qty) : null
}

function latestDate(dates: (string | null)[]): string | null {
  let out: string | null = null
  for (const d of dates) if (d && (out === null || d > out)) out = d
  return out
}

/** 一条分支 = 一个买入批次（真实行或回补虚拟批次）+ 它自己的已实现卖出盈亏 */
function branchOf(
  key: string,
  kind: 'record' | 'rebuy',
  row: number | null,
  lot: Lot,
  sellsByLot: Map<string, SellExecution[]>,
): RepairBranch {
  const related = sellsByLot.get(lot.id) ?? []
  // 暂记（还没买回的那截）不算真实卖出；永久了结的是真亏，照算
  const realized = related.filter((s) => s.hedgedFromSellRow === undefined || s.hedgeClosed === true)
  const sellQty = sum(realized, (s) => s.qty)
  const soldAmount = sum(realized, (s) => (s.priceCents ?? 0) * s.qty)
  const pricesKnown = realized.every((s) => s.priceCents !== null)
  return {
    key,
    row,
    kind,
    buyDate: lot.buyDate,
    buyPriceCents: lot.buyPriceCents,
    qty: lot.qty,
    remainingQty: lot.remainingQty,
    sellPriceCents: sellQty > 0 && pricesKnown ? weighted(soldAmount, sellQty) : null,
    sellQty,
    soldAt: latestDate(realized.map((s) => s.soldAt)),
    profitCents: sum(realized, (s) => s.profitCents ?? 0),
    allocatedLossCents: 0,
    netCents: 0,
    savingCents: 0,
  }
}

/** 锚点：亏着清仓的真实批次 / 被先卖后买永久了结的批次 */
function collectSeeds(
  lots: readonly Lot[],
  sellsByLot: Map<string, SellExecution[]>,
  memberOwner: Map<number, RepairChainLink>,
): Map<number, Seed> {
  const seeds = new Map<number, Seed>()
  for (const lot of lots) {
    // 只认真实批次（回补批次是后续买入，不当锚点）
    if (lot.id !== `lot:${lot.sourceRow}`) continue
    // 这笔已经归属到别的链 → 它的盈亏只算一次，不再单独成链
    if (memberOwner.has(lot.sourceRow)) continue
    const related = sellsByLot.get(lot.id) ?? []
    const closed = related.filter((s) => s.hedgeClosed === true)
    // 先卖后买永久了结过的，按了结那截成链（可能批次还剩别的份额）
    // 否则只认「卖完了」的亏损清仓——没卖完的批次还在手上，谈不上回本
    const real = related.filter((s) => s.hedgedFromSellRow === undefined)
    const seedSells = closed.length > 0 ? closed : lot.remainingQty === 0 ? real : []
    if (seedSells.length === 0) continue
    const qty = sum(seedSells, (s) => s.qty)
    const lossCents = sum(seedSells, (s) => s.profitCents ?? 0)
    if (qty <= 0 || lossCents >= 0) continue
    const costSum = sum(seedSells, (s) => (s.costCents ?? 0) * s.qty)
    const closeSum = sum(seedSells, (s) => (s.priceCents ?? 0) * s.qty)
    seeds.set(lot.sourceRow, {
      anchorRow: lot.sourceRow,
      stockName: lot.stockName,
      qty,
      costSum,
      closeSum,
      lossCents,
      relatedSellRows: [...new Set(closed.map((s) => s.hedgedFromSellRow).filter((r): r is number => typeof r === 'number'))],
      sells: related,
    })
  }
  return seeds
}

export function buildRepairChains(opts: {
  lots: readonly Lot[]
  sells: readonly SellExecution[]
  executions: readonly RebuyExecution[]
  links?: readonly RepairChainLink[]
}): RepairChain[] {
  const { lots, sells, executions, links = [] } = opts
  const lotById = new Map(lots.map((l) => [l.id, l]))
  const sellsByLot = new Map<string, SellExecution[]>()
  for (const s of sells) {
    if (!s.lotId) continue
    const list = sellsByLot.get(s.lotId)
    if (list) list.push(s)
    else sellsByLot.set(s.lotId, [s])
  }

  // 一笔只能归一条链：按 links 顺序先到先得
  const linkByAnchor = new Map<number, RepairChainLink>()
  const memberOwner = new Map<number, RepairChainLink>()
  for (const l of links) {
    linkByAnchor.set(l.anchorRow, l)
    for (const r of l.memberRows) if (!memberOwner.has(r)) memberOwner.set(r, l)
  }

  const seeds = collectSeeds(lots, sellsByLot, memberOwner)
  const chains: RepairChain[] = []

  for (const seed of seeds.values()) {
    const link = linkByAnchor.get(seed.anchorRow) ?? null
    const branches: RepairBranch[] = []

    // 1) 归属的真实买入批次：它自己的已实现盈亏进链
    for (const row of link?.memberRows ?? []) {
      if (row === seed.anchorRow) continue
      if (memberOwner.get(row) !== link) continue
      const lot = lotById.get(`lot:${row}`)
      if (!lot || lot.stockName !== seed.stockName) continue
      branches.push(branchOf(`record:${row}`, 'record', row, lot, sellsByLot))
    }

    // 2) 锚点卖出订单上的回补成交：自动计入分支持仓；之后再卖出的盈亏也进链
    const orderIds = new Set<string>()
    for (const s of seed.sells) {
      orderIds.add(s.hedgedFromSellRow !== undefined ? `rb:sell:${s.hedgedFromSellRow}` : `rb:${s.id}`)
    }
    const closePrice = weighted(seed.closeSum, seed.qty)
    for (const e of executions) {
      if (!orderIds.has(e.orderId)) continue
      const vl = lotById.get(`lot:exec:${e.id}`)
      const b = vl
        ? branchOf(`exec:${e.id}`, 'rebuy', null, vl, sellsByLot)
        : {
            key: `exec:${e.id}`,
            row: null as number | null,
            kind: 'rebuy' as const,
            buyDate: null as string | null,
            buyPriceCents: e.priceCents,
            qty: e.qty,
            remainingQty: e.qty,
            sellPriceCents: null as number | null,
            sellQty: 0,
            soldAt: null as string | null,
            profitCents: 0,
            allocatedLossCents: 0,
            netCents: 0,
            savingCents: 0,
          }
      // 卖 7 买 6 省下的 1 元/股：给人看，不算回本进度（进了进度会和「再卖出的盈利」双算）
      b.savingCents = closePrice === null ? 0 : mulCents(closePrice - e.priceCents, e.qty)
      branches.push(b)
    }

    // 3) 原始亏损按买入份额分摊（分母是锚点股数：只买回一半就只分摊一半）
    let allocated = 0
    for (const b of branches) {
      const raw = Math.round((seed.lossCents * b.qty) / seed.qty)
      const alloc = Math.min(0, Math.max(seed.lossCents - allocated, raw))
      b.allocatedLossCents = alloc
      b.netCents = alloc + b.profitCents
      allocated += alloc
    }

    const profitCents = sum(branches, (b) => b.profitCents)
    const savingCents = sum(branches, (b) => b.savingCents)
    const holdingQty = sum(branches, (b) => b.remainingQty)
    const boughtQty = sum(branches, (b) => b.qty)
    const netCents = seed.lossCents + profitCents
    const need = Math.abs(seed.lossCents)
    chains.push({
      id: `chain:${seed.anchorRow}`,
      stockName: seed.stockName,
      anchorRow: seed.anchorRow,
      anchorQty: seed.qty,
      anchorCostCents: weighted(seed.costSum, seed.qty) ?? 0,
      closedAtCents: closePrice,
      lossCents: seed.lossCents,
      profitCents,
      netCents,
      gapCents: Math.max(0, -netCents),
      done: netCents >= 0,
      covered: need <= 0 ? 1 : Math.max(0, Math.min(1, profitCents / need)),
      savingCents,
      holdingQty,
      plannedQty: Math.max(0, seed.qty - boughtQty),
      unallocatedLossCents: seed.lossCents - allocated,
      closedByUserAt: link?.closedAt ?? null,
      relatedSellRows: seed.relatedSellRows,
      branches,
    })
  }

  return chains.sort((a, b) => a.anchorRow - b.anchorRow)
}

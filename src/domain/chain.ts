/**
 * 回本链（V9.49 自动分支口径）——纯派生，不落库。
 *
 * 一条链 = 一次「高买低卖」的原始亏损 + 之后属于这一轮的全部已实现净盈利。
 *
 *   建链：某个买入批次卖完了、且这笔卖出是亏的 → 立即成链（一直不买回，亏损也留在账上）。
 *        先卖后买被高位批次「了结」的那一截，同样按了结卖出建链（沿用 V9.36 的入口）。
 *   价位槽（V9.49 用户拍板）：链之后同股、**同卖出价**的裸卖单（先卖后买订单）自动挂回这条链，
 *        按它们的 P 列（回补价）各开一个槽；之后所有同股、**买入价正好等于这一档**的买入
 *        （回补成交、明细新增、导入导入）都自动进这个槽，盈亏一路累加——全自动，不手动勾。
 *        根裸卖的盈利按 P 列（空头回补）计，槽内买入批次的盈利按它们自己卖出时计，各算一次不重复。
 *   进度：只累计**已经完成的买卖净盈利**；买回没卖只算持仓。
 *        「回补节省」只展示，绝不再计一次（否则会双算）。
 *   人工归属（V9.46）保留：chainLinks.memberRows 优先于自动槽，可以显式控制。
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
  /** 这次亏损卖出的加权成交价（分）；用来认「同价再卖」的裸卖 */
  closePrice: number | null
  /** 锚点最早一笔卖出日期；后续「再卖」必须不早于它 */
  closeDate: string | null
  lossCents: number
  relatedSellRows: number[]
  sells: SellExecution[]
}

/** 价位槽：链下一档回补价位（P 列），根是「同价再卖」的裸卖单 */
interface PriceSlot {
  chainAnchor: number
  stockName: string
  priceCents: number
  roots: SellExecution[]
  /** 自动收编的买入批次（真实行 + 回补虚拟批次） */
  lots: Lot[]
  /** 根卖出的最早日期（买入日期早于它的不算回补） */
  date: string | null
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

function earliestDate(dates: (string | null)[]): string | null {
  let out: string | null = null
  for (const d of dates) if (d && (out === null || d < out)) out = d
  return out
}

/** 真实卖出（排除挂钩暂记/了结的合成成交） */
function plainSellsOf(lotId: string, sellsByLot: Map<string, SellExecution[]>): SellExecution[] {
  return (sellsByLot.get(lotId) ?? []).filter((s) => s.hedgedFromSellRow === undefined)
}

/** 一条分支 = 一个买入批次（真实行或回补虚拟批次）+ 它自己的已实现卖出盈亏 */
function branchOf(
  key: string,
  kind: 'record' | 'rebuy',
  row: number | null,
  lot: Lot,
  sellsByLot: Map<string, SellExecution[]>,
): RepairBranch {
  const realized = plainSellsOf(lot.id, sellsByLot)
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
    rootSellRow: null,
    cycles: realized.length,
    memberRows: row !== null ? [row] : [],
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
    if (related.length === 0) continue
    const qty = sum(related, (s) => s.qty)
    const lossCents = sum(related, (s) => s.profitCents ?? 0)
    if (qty <= 0 || lossCents >= 0) continue
    const costSum = sum(related, (s) => (s.costCents ?? 0) * s.qty)
    const closeSum = sum(related, (s) => (s.priceCents ?? 0) * s.qty)
    seeds.set(lot.sourceRow, {
      anchorRow: lot.sourceRow,
      stockName: lot.stockName,
      qty,
      costSum,
      closeSum,
      closePrice: weighted(closeSum, qty),
      closeDate: earliestDate(related.map((s) => s.soldAt)),
      lossCents,
      relatedSellRows: [...new Set(related.map((s) => s.hedgedFromSellRow).filter((r): r is number => typeof r === 'number'))],
      sells: related,
    })
  }
  return seeds
}

/**
 * 价位槽收集（V9.49）：链下同价再卖的裸卖 → 根；同股、同价的买入批次 → 槽成员。
 * cover 输出「每笔裸卖被自动回补覆盖的股数」，ledger 用它把待买单自动关掉。
 */
function collectPriceSlots(opts: {
  seeds: Map<number, Seed>
  lots: readonly Lot[]
  sells: readonly SellExecution[]
  executions: readonly RebuyExecution[]
  memberOwner: Map<number, RepairChainLink>
  anchorRows: Set<number>
}): { slots: PriceSlot[]; autoLotIds: Set<string>; cover: Map<number, number> } {
  const { seeds, lots, sells, executions, memberOwner, anchorRows } = opts
  const slots: PriceSlot[] = []
  const autoLotIds = new Set<string>()
  const cover = new Map<number, number>()

  // 有挂钩合成成交的裸卖走 V9.36 那条路径，不重复进价位槽
  const hedgedRows = new Set<number>()
  for (const s of sells) if (s.hedgedFromSellRow !== undefined) hedgedRows.add(s.hedgedFromSellRow)

  // 用户拍板：同一价位被多条链共享时，归给**锚点卖出日期最近**的那条（正在做的一轮）
  const chainsByDate = [...seeds.values()].sort((a, b) => (b.closeDate ?? '').localeCompare(a.closeDate ?? ''))

  for (const s of sells) {
    if (s.lotId !== null || s.hedgedFromSellRow !== undefined) continue
    if (hedgedRows.has(s.sourceRow)) continue
    if (s.priceCents === null) continue
    // 回补价位：P 列 > 卖出价 − 该股间隔（ledger 在生成 sell 时已经算好）
    const price = s.rebuyPriceCents ?? s.costCents
    if (price === null || price <= 0) continue
    const seed = chainsByDate.find(
      (x) =>
        x.stockName === s.stockName &&
        x.closePrice !== null &&
        s.priceCents === x.closePrice &&
        (x.closeDate === null || s.soldAt === null || s.soldAt >= x.closeDate),
    )
    if (!seed) continue
    let slot = slots.find((x) => x.chainAnchor === seed.anchorRow && x.priceCents === price)
    if (!slot) {
      slot = { chainAnchor: seed.anchorRow, stockName: seed.stockName, priceCents: price, roots: [], lots: [], date: null }
      slots.push(slot)
    }
    slot.roots.push(s)
  }

  for (const slot of slots) {
    slot.roots.sort((a, b) => (a.soldAt ?? '').localeCompare(b.soldAt ?? '') || a.sourceRow - b.sourceRow)
    slot.date = earliestDate(slot.roots.map((s) => s.soldAt))
  }

  // 买入批次自动归槽：同股 + 买入价正好等于槽价 + 买入日期不早于根卖出
  const slotsByDate = [...slots].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  for (const lot of lots) {
    // 锚点自己已经成链，不被别的链收编；人工归属优先
    if (anchorRows.has(lot.sourceRow)) continue
    if (memberOwner.has(lot.sourceRow)) continue
    const slot = slotsByDate.find(
      (x) =>
        x.stockName === lot.stockName &&
        x.priceCents === lot.buyPriceCents &&
        (x.date === null || lot.buyDate === null || lot.buyDate >= x.date),
    )
    if (!slot) continue
    slot.lots.push(lot)
    autoLotIds.add(lot.id)
  }

  // 覆盖量：槽里买回多少股，就盖住多少卖出（先盖最早的那笔）；已有回补成交的部分不重复算
  const execBySell = new Map<string, number>()
  for (const e of executions) {
    execBySell.set(e.sellExecId, (execBySell.get(e.sellExecId) ?? 0) + e.qty - e.rewardQty)
  }
  for (const slot of slots) {
    let left = sum(slot.lots, (l) => l.qty)
    for (const root of slot.roots) {
      const need = Math.max(0, root.qty - (execBySell.get(root.id) ?? 0))
      const q = Math.min(need, left)
      if (q <= 0) continue
      cover.set(root.sourceRow, (cover.get(root.sourceRow) ?? 0) + q)
      left -= q
    }
  }

  return { slots, autoLotIds, cover }
}

/** 价位槽 → 分支：根裸卖的空头收益 + 槽内锁仓批次自己的卖出盈亏 */
function slotBranch(slot: PriceSlot, sellsByLot: Map<string, SellExecution[]>): RepairBranch {
  const rootQty = sum(slot.roots, (s) => s.qty)
  const rootAmount = sum(slot.roots, (s) => (s.priceCents ?? 0) * s.qty)
  const rootProfit = sum(slot.roots, (s) => s.profitCents ?? 0)
  const sells = slot.lots.flatMap((l) => plainSellsOf(l.id, sellsByLot))
  return {
    key: `branch:${slot.chainAnchor}:${slot.priceCents}`,
    row: slot.roots.length > 0 ? slot.roots[0].sourceRow : null,
    kind: 'sell',
    buyDate: earliestDate(slot.lots.map((l) => l.buyDate)),
    buyPriceCents: slot.priceCents,
    qty: rootQty,
    remainingQty: sum(slot.lots, (l) => l.remainingQty),
    sellPriceCents: rootQty > 0 ? weighted(rootAmount, rootQty) : null,
    sellQty: rootQty + sum(sells, (s) => s.qty),
    soldAt: latestDate([...slot.roots.map((s) => s.soldAt), ...sells.map((s) => s.soldAt)]),
    profitCents: rootProfit + sum(sells, (s) => s.profitCents ?? 0),
    allocatedLossCents: 0,
    netCents: 0,
    // 根裸卖的盈利本身就是「卖价 − 回补价」，不再单独显示回补节省（会双算）
    savingCents: 0,
    rootSellRow: slot.roots.length > 0 ? slot.roots[0].sourceRow : null,
    cycles: slot.roots.length + sells.length,
    memberRows: [
      ...new Set([
        ...slot.roots.map((s) => s.sourceRow),
        ...slot.lots.filter((l) => l.id === `lot:${l.sourceRow}`).map((l) => l.sourceRow),
      ]),
    ],
  }
}

export function buildRepairChains(
  opts: {
    lots: readonly Lot[]
    sells: readonly SellExecution[]
    executions: readonly RebuyExecution[]
    links?: readonly RepairChainLink[]
  },
  /** 输出：每笔裸卖被价位槽自动回补覆盖的股数（ledger 用来把待买单自动关掉） */
  coverOut?: Map<number, number>,
): RepairChain[] {
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
  const possibleAnchors = new Set(
    lots
      .filter((l) => l.id === `lot:${l.sourceRow}` && sum(sellsByLot.get(l.id) ?? [], (s) => s.profitCents ?? 0) < 0)
      .map((l) => l.sourceRow),
  )
  for (const l of links) {
    if (!possibleAnchors.has(l.anchorRow)) continue
    if (links.some((other) => other.anchorRow !== l.anchorRow && other.memberRows.includes(l.anchorRow) && other.memberRows.length > 0)) continue
    linkByAnchor.set(l.anchorRow, l)
    for (const r of l.memberRows) if (r !== l.anchorRow && !memberOwner.has(r)) memberOwner.set(r, l)
  }

  const seeds = collectSeeds(lots, sellsByLot, memberOwner)
  // V9.49：价位槽自动分支（同股 + 同卖出价的裸卖 → 根；同价买入 → 成员）
  const auto = collectPriceSlots({
    seeds,
    lots,
    sells,
    executions,
    memberOwner,
    anchorRows: new Set(seeds.keys()),
  })
  if (coverOut) for (const [k, v] of auto.cover) coverOut.set(k, v)

  const chains: RepairChain[] = []
  // 所有权按股数区间传递：同一回补不能被两条链整笔认领。
  type Part = { anchor: number | null; qty: number }
  const slice = (parts: Part[], start: number, qty: number): Part[] => {
    const out: Part[] = []
    let pos = 0
    for (const p of parts) {
      const q = Math.max(0, Math.min(pos + p.qty, start + qty) - Math.max(pos, start))
      if (q > 0) out.push({ anchor: p.anchor, qty: q })
      pos += p.qty
    }
    return out
  }
  const owners = new Map<string, Part[]>()
  for (const seed of seeds.values()) owners.set(`lot:${seed.anchorRow}`, [{ anchor: seed.anchorRow, qty: lotById.get(`lot:${seed.anchorRow}`)?.qty ?? seed.qty }])
  for (const [row, link] of memberOwner) {
    if (!seeds.has(link.anchorRow)) continue
    const lot = lotById.get(`lot:${row}`)
    if (lot) owners.set(lot.id, [{ anchor: link.anchorRow, qty: lot.qty }])
  }
  const sellParts = new Map<string, Part[]>()
  // 挂钩卖出的整笔成交按实际挂住的来源批次拆分，未挂部分保留无归属。
  for (const naked of sells.filter((s) => !s.lotId)) {
    const parts: Part[] = []
    for (const s of sells.filter((x) => x.hedgedFromSellRow === naked.sourceRow)) {
      const anchor = s.lotId ? owners.get(s.lotId)?.[0]?.anchor ?? null : null
      parts.push({ anchor, qty: s.qty })
    }
    const used = sum(parts, (p) => p.qty)
    if (used < naked.qty) parts.push({ anchor: null, qty: naked.qty - used })
    const grouped: Part[] = []
    for (const p of parts) {
      const hit = grouped.find((v) => v.anchor === p.anchor)
      if (hit) hit.qty += p.qty
      else grouped.push({ ...p })
    }
    sellParts.set(naked.id, grouped)
  }
  // 纯函数调用也允许只传挂钩合成成交，没有裸卖行。
  for (const s of sells.filter((v) => v.hedgedFromSellRow !== undefined)) {
    const id = `sell:${s.hedgedFromSellRow}`
    if (sellParts.has(id)) continue
    const related = sells.filter((v) => v.hedgedFromSellRow === s.hedgedFromSellRow)
    sellParts.set(id, related.map((v) => ({ anchor: v.lotId ? owners.get(v.lotId)?.[0]?.anchor ?? null : null, qty: v.qty })))
  }
  const sortedExecs = [...executions].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  // 已被价位槽自动收编的回补成交，不再走人工/锚点归属（每份盈亏只算一次）
  const pending = new Set(sortedExecs.filter((e) => !auto.autoLotIds.has(`lot:exec:${e.id}`)))
  let changed = true
  while (changed) {
    changed = false
    // 对一个批次的多次卖出 FIFO 消耗所有权区间。
    for (const [lotId, parts] of owners) {
      let sold = 0
      for (const s of sellsByLot.get(lotId) ?? []) {
        if (s.hedgedFromSellRow !== undefined) continue
        sellParts.set(s.id, slice(parts, sold, s.qty))
        sold += s.qty
      }
    }
    const offsets = new Map<string, number>()
    for (const e of sortedExecs) {
      const offset = offsets.get(e.sellExecId) ?? 0
      offsets.set(e.sellExecId, offset + e.qty - e.rewardQty)
      if (!pending.has(e)) continue
      const parts = sellParts.get(e.sellExecId)
      if (!parts) continue
      let assigned = slice(parts, offset, e.qty - e.rewardQty)
      // 奖励股沿该次基础股的归属分配；整数余数给最后一份。
      let rewardLeft = e.rewardQty
      const base = sum(assigned, (p) => p.qty)
      assigned = assigned.map((p, i) => {
        const reward = i === assigned.length - 1 ? rewardLeft : Math.floor((e.rewardQty * p.qty) / Math.max(1, base))
        rewardLeft -= reward
        return { ...p, qty: p.qty + reward }
      })
      if (assigned.length === 0) assigned = [{ anchor: null, qty: e.qty }]
      assigned = assigned.map((p) => {
        const ended = p.anchor === null ? null : linkByAnchor.get(p.anchor)?.closedAt
        return ended && e.at > ended ? { ...p, anchor: null } : p
      })
      owners.set(`lot:exec:${e.id}`, assigned)
      pending.delete(e)
      changed = true
    }
  }

  for (const seed of seeds.values()) {
    const link = linkByAnchor.get(seed.anchorRow) ?? null
    const branches: RepairBranch[] = []
    const closePrice = weighted(seed.closeSum, seed.qty)
    let firstBoughtQty = 0
    for (const row of link?.memberRows ?? []) {
      if (memberOwner.get(row) !== link) continue
      const lot = lotById.get(`lot:${row}`)
      if (!lot || lot.stockName !== seed.stockName) continue
      branches.push(branchOf(`record:${row}`, 'record', row, lot, sellsByLot))
      firstBoughtQty += lot.qty
    }
    for (const e of executions) {
      const lot = lotById.get(`lot:exec:${e.id}`)
      // 可直接测试纯链函数；正常账本总有回补批次。
      const parts = owners.get(`lot:exec:${e.id}`) ?? []
      const qty = sum(parts.filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
      if (qty <= 0) continue
      const fallback: Lot = { id: `lot:exec:${e.id}`, sourceRow: 200000, stockId: e.stockId, stockName: e.stockName, buyDate: null, buyPriceCents: e.priceCents, qty: e.qty, soldQty: 0, remainingQty: e.qty, targetPriceCents: null, needsPrice: false, importKey: e.id }
      const b = branchOf(`exec:${e.id}`, 'rebuy', null, lot ?? fallback, sellsByLot)
      // 用所有权区间分别计算卖出和剩余，不能把整批股数/利润复制给每条链。
      let pos = 0
      let sold = 0
      let profit = 0
      let ownedSold = 0
      for (const sale of sellsByLot.get(b.key.replace('exec:', 'lot:exec:')) ?? []) {
        const mine = sum(slice(parts, sold, sale.qty).filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
        ownedSold += mine
        profit += sale.priceCents === null ? 0 : (sale.priceCents - e.priceCents) * mine
        sold += sale.qty
      }
      let remaining = 0
      for (const p of parts) {
        if (p.anchor === seed.anchorRow) remaining += Math.max(0, pos + p.qty - Math.max(pos, sold))
        pos += p.qty
      }
      b.qty = qty
      b.sellQty = ownedSold
      b.remainingQty = remaining
      b.profitCents = profit
      const initial = seed.sells.some((s) => (s.hedgedFromSellRow !== undefined ? `sell:${s.hedgedFromSellRow}` : s.id) === e.sellExecId)
      if (initial) firstBoughtQty += qty
      b.savingCents = initial && closePrice !== null ? mulCents(closePrice - e.priceCents, qty) : 0
      branches.push(b)
    }
    // V9.49：价位槽分支（同价再卖 + 之后所有同价买入），全自动归属
    const slots = auto.slots.filter((s) => s.chainAnchor === seed.anchorRow)
    for (const slot of slots) branches.push(slotBranch(slot, sellsByLot))

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
    const pendingQty = sells.reduce((total, s) => {
      const parts = sellParts.get(s.id) ?? []
      if (s.hedgedFromSellRow !== undefined) return total
      const base = s.qty - (s.ownLotCoverQty ?? 0)
      const execQty = sum(executions.filter((e) => e.sellExecId === s.id), (e) => e.qty - e.rewardQty)
      const q = sum(slice(parts, execQty, Math.max(0, base - execQty)).filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
      return total + (s.rebuyStatus === 'pending' ? q : 0)
    }, 0)
    // 价位槽里还没买回来的卖出量 = 这一轮还要买回的股数
    const slotPending = sum(slots, (slot) => {
      const sold = sum(slot.roots, (r) => r.qty)
      const covered = sum(slot.roots, (r) => auto.cover.get(r.sourceRow) ?? 0)
      return Math.max(0, sold - covered)
    })
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
      // V9.49：锚点这一轮已经完成（A/B 视为已完成）——有价位槽时只看槽里还欠多少；
      // 没有槽时沿用 V9.46「锚点股数 − 已归属买入」的提示。
      plannedQty: slots.length > 0 ? pendingQty + slotPending : Math.max(pendingQty, Math.max(0, seed.qty - firstBoughtQty)),
      unallocatedLossCents: seed.lossCents - allocated,
      closedByUserAt: link?.closedAt ?? null,
      relatedSellRows: [...new Set([...seed.relatedSellRows, ...slots.flatMap((s) => s.roots.map((r) => r.sourceRow))])],
      branches,
    })
  }

  return chains.sort((a, b) => a.anchorRow - b.anchorRow)
}

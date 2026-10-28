/**
 * 回本链（V9.49 自动分支口径）——纯派生，不落库。
 *
 * 一条链 = 一次「高买低卖」的原始亏损 + 之后属于这一轮的全部已实现净盈利。
 *
 *   建链：某个买入批次卖完了、且这笔卖出是亏的 → 立即成链（一直不买回，亏损也留在账上）。
 *        先卖后买被高位批次「了结」的那一截，同样按了结卖出建链（沿用 V9.36 的入口）。
 *   价位槽（V9.49 用户拍板）：链之后同股、**同卖出价**的裸卖单（先卖后买订单）自动挂回这条链，
 *        按它们的 P 列（回补价）各开一个槽；之后所有同股、**买入价正好等于这一档**的买入
 *        （回补成交、明细新增、导入）都自动进这个槽，盈亏一路累加——全自动，不手动勾。
 *        先卖订单不按计划回补价预记盈利；槽内批次按后续完成的同价网格卖出累计。
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
  /** 锚点出现过的全部真实卖出价；「同价再卖」按实际成交价匹配，不用加权均价 */
  closePrices: number[]
  /** 每个卖出价上最晚的一笔成交日期；再卖 / 买入必须不早于它 */
  closeDatesByPrice: Map<number, string | null>
  /** 锚点最晚一笔卖出日期（多链同价时「最近的一轮」优先） */
  closeDate: string | null
  lossCents: number
  relatedSellRows: number[]
  sells: SellExecution[]
  sellFirst?: boolean
  unlinkedQty?: number
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
  /** 用户结束这条链的本地日期（ISO）；之后的再卖 / 买入不再自动归进来 */
  endedIso: string | null
  sellPrices: number[]
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

/**
 * 一笔卖出算不算「已实现」——暂记的挂钩卖出（hold）只是临时视角，不算；
 * 已经买回、永久了结的挂钩卖出（hedgeClosed）是真亏，必须算，否则链会少记这笔亏损。
 */
export function isRealizedSale(s: SellExecution): boolean {
  return s.hedgedFromSellRow === undefined || s.hedgeClosed === true
}

/** 某一行（真实明细行）的已实现卖出盈亏；ChainBinder 与链分支共用同一口径 */
export function realizedProfitOf(sells: readonly SellExecution[], row: number): number {
  return sells
    .filter((s) => s.sourceRow === row && isRealizedSale(s))
    .reduce((a, s) => a + (s.profitCents ?? 0), 0)
}

/** 真实卖出（含已了结的挂钩卖出，排除挂钩暂记） */
function plainSellsOf(lotId: string, sellsByLot: Map<string, SellExecution[]>): SellExecution[] {
  return (sellsByLot.get(lotId) ?? []).filter(isRealizedSale)
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

/** 历史锚点：亏损真实批次 / 已存人工挂钩的高位批次 */
function collectSeeds(
  lots: readonly Lot[],
  sellsByLot: Map<string, SellExecution[]>,
  memberOwner: Map<number, RepairChainLink>,
  rootRows: Set<number>,
): Map<number, Seed> {
  const seeds = new Map<number, Seed>()
  for (const lot of lots) {
    // 只认真实批次（回补批次是后续买入，不当锚点）
    if (lot.id !== `lot:${lot.sourceRow}`) continue
    // 这笔已经归属到别的链 → 它的盈亏只算一次，不再单独成链
    if (memberOwner.has(lot.sourceRow)) continue
    const related = (sellsByLot.get(lot.id) ?? []).filter((s) => s.hedgedFromSellRow === undefined || !rootRows.has(s.hedgedFromSellRow))
    if (related.length === 0) continue
    const qty = sum(related, (s) => s.qty)
    const lossCents = sum(related, (s) => s.profitCents ?? 0)
    if (qty <= 0 || lossCents >= 0) continue
    const costSum = sum(related, (s) => (s.costCents ?? 0) * s.qty)
    const closeSum = sum(related, (s) => (s.priceCents ?? 0) * s.qty)
    /**
     * V9.57：锚点批次可能分多价卖出，「同价再卖」必须按**实际成交价**匹配，
     * 不能拿所有卖出的加权均价（7.00 + 6.90 卖成 6.95，后面 7.00 再卖就永远归不进链）。
     * 每个价位记录它最晚的一笔卖出日期；认不出日期（null）就 fail-closed 不归链。
     */
    const closeDatesByPrice = new Map<number, string | null>()
    for (const s of related) {
      if (s.priceCents === null) continue
      const prev = closeDatesByPrice.get(s.priceCents)
      const next =
        prev && s.soldAt ? (prev > s.soldAt ? prev : s.soldAt) : (prev ?? s.soldAt ?? null)
      closeDatesByPrice.set(s.priceCents, next)
    }
    seeds.set(lot.sourceRow, {
      anchorRow: lot.sourceRow,
      stockName: lot.stockName,
      qty,
      costSum,
      closeSum,
      closePrices: [...closeDatesByPrice.keys()],
      closeDatesByPrice,
      closeDate: latestDate(related.map((s) => s.soldAt)),
      lossCents,
      relatedSellRows: [...new Set(related.map((s) => s.hedgedFromSellRow).filter((r): r is number => typeof r === 'number'))],
      sells: related,
    })
  }
  return seeds
}

/**
 * 价位槽收集（V9.49）：链下同价再卖的裸卖 → 根；同股、同价的买入批次 → 槽成员。
 *
 * V9.57：
 * - cover 只统计**同价真实买入**（`lot:<行>`）；「记成交」生成的虚拟批次已经由
 *   execBaseQty 扣过一次，再算进 cover 会让 baseQty 被减两遍。
 * - 虚拟批次仍留在 slot.lots 里参与分支盈亏 / 持仓展示，只是不参与 cover / 计划量。
 */
function collectPriceSlots(opts: {
  seeds: Map<number, Seed>
  lots: readonly Lot[]
  sells: readonly SellExecution[]
  executions: readonly RebuyExecution[]
  memberOwner: Map<number, RepairChainLink>
  anchorRows: Set<number>
  linkByAnchor: Map<number, RepairChainLink>
  rootOwner: Map<number, number>
}): { slots: PriceSlot[]; autoLotIds: Set<string>; realCoverBySell: Map<number, number>; pending: Map<number, number> } {
  const { seeds, lots, sells, executions, memberOwner, anchorRows, linkByAnchor, rootOwner } = opts
  const slots: PriceSlot[] = []
  const autoLotIds = new Set<string>()
  /** 每笔裸卖被「同价真实买入」覆盖的股数（不含回补成交虚拟批次） */
  const realCover = new Map<number, number>()
  /** 每条链「槽里还没买回来」的股数（已成交的不算欠） */
  const pending = new Map<number, number>()

  /** 用户结束这条链的本地日期：之后发生的再卖 / 买入都算独立交易，不再自动归链 */
  const endedIsoByAnchor = new Map<number, string | null>()
  for (const [anchorRow, link] of linkByAnchor) {
    const at = link.closedAt
    if (!at) {
      endedIsoByAnchor.set(anchorRow, null)
      continue
    }
    const d = new Date(at)
    endedIsoByAnchor.set(
      anchorRow,
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  }

  // 有挂钩合成成交的裸卖走 V9.36 那条路径，不重复进价位槽
  const hedgedRows = new Set<number>()
  for (const s of sells) if (s.hedgedFromSellRow !== undefined) hedgedRows.add(s.hedgedFromSellRow)

  // 用户拍板：同一价位被多条链共享时，归给**锚点卖出日期最近**的那条（正在做的一轮）
  const chainsByDate = [...seeds.values()].sort((a, b) => (b.closeDate ?? '').localeCompare(a.closeDate ?? ''))

  for (const s of sells) {
    if (s.lotId !== null || s.hedgedFromSellRow !== undefined) continue
    if (hedgedRows.has(s.sourceRow) && !rootOwner.has(s.sourceRow)) continue
    if (s.priceCents === null) continue
    // 回补价位：P 列 > 同行实际回补价 > 卖出价 − 该股间隔（ledger 在生成 sell 时已经算好）
    const price = s.rebuyPriceCents ?? s.costCents
    if (price === null || price <= 0) continue
    const seed = seeds.get(rootOwner.get(s.sourceRow) ?? -1) ?? chainsByDate.find((x) => {
      if (x.stockName !== s.stockName) return false
      // V9.57：按锚点**实际卖出过的价位**匹配，不再拿全部卖出的加权均价
      if (!x.closePrices.includes(s.priceCents as number)) return false
      const closeAt = x.closeDatesByPrice.get(s.priceCents as number) ?? null
      /**
       * V9.55 修：**认不出先后就不归链**（fail-closed）。原来 `s.soldAt === null`
       * 也放行，于是「卖出日期是 =TODAY() 公式、没有缓存值」的老裸卖（R60–63 这种）
       * 会被当成链之后的同价再卖：它的待买被槽「买回」自动关掉 → 敞口凭空少 500 股、
       * 守恒式红灯，链的盈利还被这笔空头收益顶成「已不亏钱」（e2e 四条断言就是这么红的）。
       * 和 V9.47.1 一个口径：日期空着 → 无法判序 → 保守地保留整张单（想归链可以人工指定）。
       */
      if (closeAt === null || s.soldAt === null || s.soldAt < closeAt) return false
      // 用户结束的链不再收编之后的交易；V9.57：结束判据放进 find 里，
      // 这样「最近的一条已结束」不会把同价位另一条还在进行的链挡住。
      const ended = endedIsoByAnchor.get(x.anchorRow) ?? null
      return ended === null || s.soldAt <= ended
    })
    if (!seed) continue
    const ended = endedIsoByAnchor.get(seed.anchorRow) ?? null
    let slot = slots.find((x) => x.chainAnchor === seed.anchorRow && x.priceCents === price)
    if (!slot) {
      slot = { chainAnchor: seed.anchorRow, stockName: seed.stockName, priceCents: price, roots: [], lots: [], date: null, endedIso: ended, sellPrices: [] }
      slots.push(slot)
    }
    if (!slot.sellPrices.includes(s.priceCents)) slot.sellPrices.push(s.priceCents)
    slot.roots.push(s)
  }

  for (const slot of slots) {
    slot.roots.sort((a, b) => (a.soldAt ?? '').localeCompare(b.soldAt ?? '') || a.sourceRow - b.sourceRow)
    slot.date = earliestDate(slot.roots.map((s) => s.soldAt))
  }

  /**
   * V9.63：**锚点自己 P 列的回补价位也是一档**。原来档只能由「链之后的同价裸卖」创建——
   * 用户高买低卖后如果直接记成交买回（或明细新增 / 下一轮买入）、中间没有再出现同价裸卖，
   * P 档就永远不存在，之后买在这个价位的批次和它们的多次卖出全部不归链，
   * 表现为「亏损固定显示、低位盈利不与亏损相抵」。现在把锚点卖单的回补价（P 列）
   * 直接立为无根槽：日期边界 = 锚点最后一笔卖出日（fail-closed），用户结束的链不收。
   * 有根槽已存在的价位跳过（合并，避免同一档出现两条）。
   */
  for (const seed of seeds.values()) {
    const ended = endedIsoByAnchor.get(seed.anchorRow) ?? null
    const prices = [
      ...new Set(seed.sells.map((s) => s.rebuyPriceCents).filter((p): p is number => p != null && p > 0)),
    ]
    for (const price of prices) {
      if (slots.some((x) => x.chainAnchor === seed.anchorRow && x.priceCents === price)) continue
      if (seed.closeDate === null) continue
      slots.push({
        chainAnchor: seed.anchorRow,
        stockName: seed.stockName,
        priceCents: price,
        roots: [],
        lots: [],
        date: seed.closeDate,
        endedIso: ended,
        sellPrices: seed.closePrices,
      })
    }
  }

  // 买入批次自动归槽：同股 + 买入价正好等于槽价 + 买入日期不早于根卖出
  const slotsByDate = [...slots].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  for (const lot of lots) {
    // 锚点自己已经成链，不被别的链收编；人工归属优先
    const ownRoot = rootsForLot(lot)
    if (anchorRows.has(lot.sourceRow) && !ownRoot) continue
    if (memberOwner.has(lot.sourceRow)) continue
    const execution = executions.find((e) => lot.id === `lot:exec:${e.id}`)
    const execRoot = execution ? sells.find((s) => s.id === execution.sellExecId) : undefined
    const origin = ownRoot ?? execRoot
    const originAnchor = origin ? rootOwner.get(origin.sourceRow) ?? (seeds.has(origin.sourceRow) ? origin.sourceRow : undefined) : undefined
    // 已知成交来源优先沿原链；人工挂钩的成交留给后面的份额所有权递归分配。
    if (execution && originAnchor === undefined) continue
    const slot = (origin ? slotsByDate.find((x) => x.chainAnchor === originAnchor && x.priceCents === origin.rebuyPriceCents && (x.endedIso === null || (lot.buyDate !== null && lot.buyDate <= x.endedIso))) : undefined) ?? (!origin ? slotsByDate.find(
      (x) =>
        x.stockName === lot.stockName &&
        x.priceCents === lot.buyPriceCents &&
        // V9.55 修：买入日期认不出来也不能归槽（原来 null 直接放行，历史同价批次会被当成
        // 「之后买回来的」，槽的 cover 于是盖住了还没买回的裸卖待买）
        x.date !== null &&
        lot.buyDate !== null &&
        lot.buyDate >= x.date &&
        // 链结束之后的买入不再自动归链（和「结束后的算独立交易」同一口径）
        (x.endedIso === null || lot.buyDate <= x.endedIso),
    ) : undefined)
    if (!slot) continue
    slot.lots.push(lot)
    autoLotIds.add(lot.id)
  }

  function rootsForLot(lot: Lot): SellExecution | undefined {
    // 同行买回必须先留给自己的卖出，历史人工挂钩也一样。
    return sells.find((s) => s.sourceRow === lot.sourceRow && (s.ownLotCoverQty ?? 0) > 0)
  }

  // 覆盖量：槽里买回多少股，就盖住多少卖出（先盖最早的那笔）；已有回补成交的部分不重复算
  const execBySell = new Map<string, number>()
  for (const e of executions) {
    execBySell.set(e.sellExecId, (execBySell.get(e.sellExecId) ?? 0) + e.qty - e.rewardQty)
  }
  for (const slot of slots) {
    // V9.57：只有真实买入能「盖住」裸卖。回补成交的虚拟批次已经在 execQty 里扣过，
    // 算进来 === 同一笔股数被扣两次（敞口 / 链计划量因此少算）。
    const realLots = slot.lots.filter((l) => l.id === `lot:${l.sourceRow}`)
    const available = new Map(realLots.map((l) => [l.id, Math.max(0, l.qty - (rootsForLot(l)?.ownLotCoverQty ?? 0))]))
    let slotPending = 0
    for (const root of slot.roots) {
      const need = Math.max(0, root.qty - (root.ownLotCoverQty ?? 0) - (execBySell.get(root.id) ?? 0))
      let q = 0
      for (const lot of realLots) {
        if (root.soldAt === null || lot.buyDate === null || lot.buyDate < root.soldAt) continue
        const take = Math.min(need - q, available.get(lot.id) ?? 0)
        q += take
        available.set(lot.id, (available.get(lot.id) ?? 0) - take)
      }
      if (q > 0) {
        realCover.set(root.sourceRow, (realCover.get(root.sourceRow) ?? 0) + q)
      }
      // 已成交的部分不再是欠账，只把「没买回来」的算进计划量
      slotPending += Math.max(0, need - q)
    }
    pending.set(slot.chainAnchor, (pending.get(slot.chainAnchor) ?? 0) + slotPending)
  }

  return { slots, autoLotIds, realCoverBySell: realCover, pending }
}

/** 价位槽 → 分支：累计槽内批次所有已实现卖出盈亏（不限卖价） */
function slotBranch(slot: PriceSlot, sellsByLot: Map<string, SellExecution[]>): RepairBranch {
  const rootQty = sum(slot.roots, (s) => s.qty)
  const rootAmount = sum(slot.roots, (s) => (s.priceCents ?? 0) * s.qty)
  const lotsQty = sum(slot.lots, (l) => l.qty)
  // V9.67：归属确定后，后续任意实际卖价的盈利或亏损均累计到链中
  const sells = slot.lots.flatMap((l) => plainSellsOf(l.id, sellsByLot))
  return {
    key: `branch:${slot.chainAnchor}:${slot.priceCents}`,
    row: slot.roots.length > 0 ? slot.roots[0].sourceRow : null,
    kind: 'sell',
    buyDate: earliestDate(slot.lots.map((l) => l.buyDate)),
    buyPriceCents: slot.priceCents,
    // 有根槽按根的欠量分摊亏损；无根的 P 档（V9.63）没有根，按归进来的买入股数分摊
    qty: rootQty > 0 ? rootQty : lotsQty,
    remainingQty: sum(slot.lots, (l) => l.remainingQty),
    sellPriceCents: rootQty > 0 ? weighted(rootAmount, rootQty) : null,
    sellQty: rootQty + sum(sells, (s) => s.qty),
    soldAt: latestDate([...slot.roots.map((s) => s.soldAt), ...sells.map((s) => s.soldAt)]),
    profitCents: sum(sells, (s) => s.profitCents ?? 0),
    allocatedLossCents: 0,
    netCents: 0,
    // 同行实际回补价差仅作参考，绝不计入盈利。
    savingCents: sum(slot.lots, (l) => sum(slot.roots.filter((r) => r.sourceRow === l.sourceRow), (r) => ((r.priceCents ?? 0) - l.buyPriceCents) * (r.ownLotCoverQty ?? 0))),
    rootSellRow: slot.roots.length > 0 ? slot.roots[0].sourceRow : null,
    cycles: slot.roots.length + sells.length,
    memberRows: [
      ...new Set([
        ...slot.roots.map((s) => s.sourceRow),
        ...sells.map((s) => s.sourceRow),
        ...slot.lots.filter((l) => l.id === `lot:${l.sourceRow}`).map((l) => l.sourceRow),
      ]),
    ],
  }
}

export interface ChainBuildResult {
  chains: RepairChain[]
  /**
   * 每笔裸卖被「同价真实买入」自动回补覆盖的股数。
   * ledger 用它算待买基数 / 敞口 / 守恒式；不含回补成交虚拟批次（那些走 execQty）。
   */
  realCoverBySell: Map<number, number>
}

export function buildRepairChains(opts: {
  lots: readonly Lot[]
  sells: readonly SellExecution[]
  executions: readonly RebuyExecution[]
  links?: readonly RepairChainLink[]
  /** 已保存人工挂钩保留原锚点身份，避免已有链的结束/归属设置失效。 */
  legacyHedgeRows?: readonly number[]
}): ChainBuildResult {
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
  for (const s of sells) if (s.sellBeforeBuy && s.hedgedFromSellRow === undefined) possibleAnchors.add(s.sourceRow)
  for (const l of links) {
    if (!possibleAnchors.has(l.anchorRow)) continue
    if (links.some((other) => other.anchorRow !== l.anchorRow && other.memberRows.includes(l.anchorRow) && other.memberRows.length > 0)) continue
    linkByAnchor.set(l.anchorRow, l)
    for (const r of l.memberRows) if (r !== l.anchorRow && !memberOwner.has(r)) memberOwner.set(r, l)
  }

  const legacyRows = new Set((opts.legacyHedgeRows ?? []).filter((r) => !linkByAnchor.has(r)))
  const newRootRows = new Set(sells.filter((s) => s.sellBeforeBuy && !legacyRows.has(s.sourceRow)).map((s) => s.sourceRow))
  const seeds = collectSeeds(lots, sellsByLot, memberOwner, newRootRows)
  // 每笔先卖后买都能看链；同一低位网格的后续卖单沿用最早的链，盈亏只归属一次。
  const rootOwner = new Map<number, number>()
  const roots = sells.filter((s) => s.sellBeforeBuy && !s.lotId && s.hedgedFromSellRow === undefined)
    .sort((a, b) => (a.soldAt ?? '').localeCompare(b.soldAt ?? '') || a.sourceRow - b.sourceRow)
  for (const root of roots) {
    if (legacyRows.has(root.sourceRow) && sells.some((s) => s.hedgedFromSellRow === root.sourceRow)) continue
    const existing = [...seeds.values()].sort((a,b) => (b.closeDate ?? '').localeCompare(a.closeDate ?? '')).find((s) => root.soldAt !== null && s.closeDate !== null && s.closeDate <= root.soldAt &&
      s.stockName === root.stockName && s.closePrices.includes(root.priceCents ?? -1) &&
      (!s.sellFirst || s.sells[0].rebuyPriceCents === root.rebuyPriceCents) &&
      (!linkByAnchor.get(s.anchorRow)?.closedAt || new Date(linkByAnchor.get(s.anchorRow)!.closedAt!).toLocaleDateString('sv-SE') >= root.soldAt))
    const allocated = sells.filter((s) => s.hedgedFromSellRow === root.sourceRow)
    if (existing && !existing.sellFirst && allocated.length === 0) {
      rootOwner.set(root.sourceRow, existing.anchorRow)
      continue
    }
    const q = sum(allocated, (s) => s.qty)
    const seed: Seed = existing ?? {
      anchorRow: root.sourceRow, stockName: root.stockName, qty: 0, costSum: 0, closeSum: 0,
      closePrices: root.priceCents === null ? [] : [root.priceCents],
      closeDatesByPrice: new Map(root.priceCents === null ? [] : [[root.priceCents, root.soldAt]]),
      closeDate: root.soldAt, lossCents: 0, relatedSellRows: [], sells: [], sellFirst: true, unlinkedQty: 0,
    }
    seed.qty += root.qty
    seed.costSum += sum(allocated, (s) => (s.costCents ?? 0) * s.qty)
    seed.closeSum += (root.priceCents ?? 0) * root.qty
    seed.lossCents += sum(allocated, (s) => s.profitCents ?? 0)
    seed.unlinkedQty = (seed.unlinkedQty ?? 0) + Math.max(0, root.qty - q)
    seed.relatedSellRows.push(root.sourceRow, ...allocated.map((s) => s.sourceRow))
    seed.sells.push(root)
    seeds.set(seed.anchorRow, seed)
    rootOwner.set(root.sourceRow, seed.anchorRow)
  }
  // V9.49：价位槽自动分支（同股 + 同卖出价的裸卖 → 根；同价买入 → 成员）
  const auto = collectPriceSlots({
    seeds,
    lots,
    sells,
    executions,
    memberOwner,
    anchorRows: new Set(seeds.keys()),
    linkByAnchor,
    rootOwner,
  })

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
  for (const seed of seeds.values()) if (!seed.sellFirst) owners.set(`lot:${seed.anchorRow}`, [{ anchor: seed.anchorRow, qty: lotById.get(`lot:${seed.anchorRow}`)?.qty ?? seed.qty }])
  for (const [row, link] of memberOwner) {
    if (!seeds.has(link.anchorRow)) continue
    const lot = lotById.get(`lot:${row}`)
    if (lot) owners.set(lot.id, [{ anchor: link.anchorRow, qty: lot.qty }])
  }
  const sellParts = new Map<string, Part[]>()
  // 挂钩卖出的整笔成交按实际挂住的来源批次拆分，未挂部分保留无归属。
  for (const naked of sells.filter((s) => !s.lotId)) {
    const rootAnchor = rootOwner.get(naked.sourceRow)
    if (rootAnchor !== undefined) {
      sellParts.set(naked.id, [{ anchor: rootAnchor, qty: naked.qty }])
      continue
    }
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
  // 老人工挂钩保留高位锚点。独立导入的同价买入按原挂钩份额分配，
  // 与回补成交共用所有权区间，跨两条链也不能重复认领整批股数或盈利。
  const legacyRealLots = new Map<string, SellExecution>()
  const realBoughtByRoot = new Map<number, number>()
  for (const lot of lots) {
    if (lot.id !== `lot:${lot.sourceRow}` || owners.has(lot.id) || auto.autoLotIds.has(lot.id) || lot.buyDate === null) continue
    const matches = (r: SellExecution) => {
      if (!legacyRows.has(r.sourceRow) || r.stockName !== lot.stockName || r.soldAt === null || r.soldAt > lot.buyDate!) return false
      const own = r.sourceRow === lot.sourceRow && (r.ownLotCoverQty ?? 0) > 0
      if (!own && r.rebuyPriceCents !== lot.buyPriceCents) return false
      return (sellParts.get(r.id) ?? []).some((p) => {
        if (p.anchor === null) return false
        const ended = linkByAnchor.get(p.anchor)?.closedAt
        return !ended || new Date(`${lot.buyDate}T00:00:00`).getTime() <= ended
      })
    }
    const ownRoot = roots.find((r) => r.sourceRow === lot.sourceRow && (r.ownLotCoverQty ?? 0) > 0)
    const root = ownRoot ? (matches(ownRoot) ? ownRoot : undefined) : [...roots].reverse().find(matches)
    if (!root) continue
    const parts = sellParts.get(root.id) ?? []
    let left = lot.qty
    const assigned = parts.map((p, i) => {
      const q = i === parts.length - 1 ? left : Math.floor(lot.qty * p.qty / root.qty)
      left -= q
      const ended = p.anchor === null ? null : linkByAnchor.get(p.anchor)?.closedAt
      return { anchor: ended && new Date(`${lot.buyDate}T00:00:00`).getTime() > ended ? null : p.anchor, qty: q }
    })
    owners.set(lot.id, assigned)
    legacyRealLots.set(lot.id, root)
    // 同行买回已由 ownLotCoverQty 扣过；只有独立买入可继续平欠量。
    if (root.sourceRow !== lot.sourceRow) realBoughtByRoot.set(root.sourceRow, (realBoughtByRoot.get(root.sourceRow) ?? 0) + lot.qty)
  }
  for (const root of roots) {
    const exec = sum(executions.filter((e) => e.sellExecId === root.id), (e) => e.qty - e.rewardQty)
    const q = Math.min(realBoughtByRoot.get(root.sourceRow) ?? 0, Math.max(0, root.qty - (root.ownLotCoverQty ?? 0) - exec))
    if (q > 0) auto.realCoverBySell.set(root.sourceRow, q)
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
    for (const [lotId, root] of legacyRealLots) {
      const lot = lotById.get(lotId)!
      const parts = owners.get(lotId) ?? []
      const qty = sum(parts.filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
      if (qty === 0) continue
      const b = branchOf(`record:${lot.sourceRow}`, 'record', lot.sourceRow, lot, sellsByLot)
      let sold = 0
      let ownSold = 0
      let profit = 0
      const memberRows = [lot.sourceRow, root.sourceRow]
      for (const sale of sellsByLot.get(lotId) ?? []) {
        const mine = sum(slice(parts, sold, sale.qty).filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
        ownSold += mine
        if (mine > 0) memberRows.push(sale.sourceRow)
        // V9.67：归属确定后，任意实际卖价的盈利或亏损均累计
        if (isRealizedSale(sale) && sale.priceCents !== null) profit += (sale.priceCents - lot.buyPriceCents) * mine
        sold += sale.qty
      }
      b.qty = qty
      b.sellQty = ownSold
      b.remainingQty = sum(slice(parts, sold, Math.max(0, lot.qty - sold)).filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
      b.profitCents = profit
      b.savingCents = ((root.priceCents ?? lot.buyPriceCents) - lot.buyPriceCents) * qty
      b.memberRows = [...new Set(memberRows)]
      firstBoughtQty += qty
      branches.push(b)
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
      b.memberRows = [...new Set((sellsByLot.get(lot?.id ?? `lot:exec:${e.id}`) ?? []).map((s) => s.sourceRow))]
      const initial = seed.sells.some((s) => (s.hedgedFromSellRow !== undefined ? `sell:${s.hedgedFromSellRow}` : s.id) === e.sellExecId)
      if (initial) firstBoughtQty += qty
      b.savingCents = initial && closePrice !== null ? mulCents(closePrice - e.priceCents, qty) : 0
      branches.push(b)
    }
    // V9.49：价位槽分支（同价再卖 + 之后所有同价买入），全自动归属
    const slots = auto.slots.filter((s) => s.chainAnchor === seed.anchorRow)
    for (const slot of slots) {
      const b = slotBranch(slot, sellsByLot)
      /**
       * V9.63：无根的 P 档（锚点自己的回补价位）没有根裸卖的空头收益可展示，
       * 节省 = 锚点清算价 − 本档买价 × 归进来的买入股数——只展示、不进进度（决策 F）。
       * 有根槽只展示同行真实回补的节省；不把计划价差提前记为盈利。
       */
      if (slot.roots.length === 0 && closePrice !== null) {
        b.savingCents = mulCents(closePrice - slot.priceCents, sum(slot.lots, (l) => l.qty))
      }
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
    const pendingQty = sells.reduce((total, s) => {
      if (slots.some((slot) => slot.roots.some((r) => r.id === s.id))) return total
      const parts = sellParts.get(s.id) ?? []
      if (s.hedgedFromSellRow !== undefined) return total
      const base = s.qty - (s.ownLotCoverQty ?? 0)
      const execQty = sum(executions.filter((e) => e.sellExecId === s.id), (e) => e.qty - e.rewardQty) + (auto.realCoverBySell.get(s.sourceRow) ?? 0)
      const q = sum(slice(parts, execQty, Math.max(0, base - execQty)).filter((p) => p.anchor === seed.anchorRow), (p) => p.qty)
      return total + (s.rebuyStatus === 'pending' ? q : 0)
    }, 0)
    // 价位槽里还没买回来的卖出量 = 这一轮还要买回的股数（已成交的不算欠）
    const slotPending = auto.pending.get(seed.anchorRow) ?? 0
    /**
     * V9.63：「有槽」指**有根槽**（出现过同价再卖）。只有无根的 P 档时仍走
     * 「锚点股数 − 已归属买入」的旧口径——但已归属买入要算上 P 档里归进来的批次
     * （记成交 / 明细新增 / 下一轮），否则「已经 5 块买回 500 股」还提示计划再买 500。
     * 空日期裸卖那种「槽没形成」的欠量不在这里（它自己的待买单还在，V9.56）。
     */
    const hasRootedSlot = slots.some((s) => s.roots.length > 0)
    const slottedQty = sum(slots.flatMap((s) => s.lots), (l) => l.qty)
    const netCents = seed.lossCents + profitCents
    const need = Math.abs(seed.lossCents)
    chains.push({
      id: `chain:${seed.anchorRow}`,
      stockName: seed.stockName,
      anchorRow: seed.anchorRow,
      anchorQty: seed.qty,
      anchorCostCents: weighted(seed.costSum, seed.qty - (seed.unlinkedQty ?? 0)) ?? 0,
      closedAtCents: closePrice,
      lossCents: seed.lossCents,
      profitCents,
      netCents,
      gapCents: Math.max(0, -netCents),
      done: netCents >= 0 && !(seed.unlinkedQty ?? 0),
      unlinkedQty: seed.unlinkedQty,
      covered: need <= 0 ? 0 : Math.max(0, Math.min(1, profitCents / need)),
      savingCents,
      holdingQty,
      // V9.49：锚点这一轮已经完成（A/B 视为已完成）——有根槽时只看槽里还欠多少；
      // 只有无根 P 档时沿用「锚点股数 − 已归属买入」并计入 P 档批次。用户结束链后不再提示计划买回。
      plannedQty: link?.closedAt
        ? 0
        : hasRootedSlot
          ? pendingQty + slotPending
          : Math.max(pendingQty, Math.max(0, seed.qty - firstBoughtQty - slottedQty)),
      unallocatedLossCents: seed.lossCents - allocated,
      closedByUserAt: link?.closedAt ?? null,
      relatedSellRows: [...new Set([...seed.relatedSellRows, ...slots.flatMap((s) => s.roots.map((r) => r.sourceRow))])],
      branches,
    })
  }

  return {
    chains: chains.sort((a, b) => a.anchorRow - b.anchorRow),
    realCoverBySell: auto.realCoverBySell,
  }
}

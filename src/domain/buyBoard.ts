/**
 * 已完成批次的「下一轮应买」（V9.47）。
 *
 * 网格是一轮一轮做的：一个批次卖完之后，股价回到它的买入价那一档，同样该提醒买一次。
 * 原来待买只认 P 列的回补单（`ledger.orders`），卖完又没有 P 列的老批次从此在任何提醒里
 * 消失，明细页还默认把这种「已完成」行隐藏——用户根本看不到该动手的信号。
 *
 * 口径（用户拍板）：
 * - 应买价 = **批次买入价（C 列）**；数量 = 这一轮的建仓量。
 * - 纳入 = 卖完的批次（剩余 0）+ 待买单已回补完的批次；**还没回补完的不重复提示**
 *   （那张 P 列待买单已经在提醒了，价位也不同，并列会把同一笔钱算两遍）。
 * - 同价合并 = **复用 V9.45 的 merges 关联**：组内 ≥2 笔都是候选才合成一条，数量相加、
 *   买入日期取最早；只剩一笔自动散开，关联保留。
 *
 * **只做提醒，不碰账**：这些档位不进 `ledger.orders`、不进待买剩余金额 / 组池奖励 /
 * 守恒式，也不改任何 records。
 */
import type { Lot, LotMergeLink, RebuyOrder, SellExecution } from './types'

export interface NextRoundBuyRow {
  /** 单笔 = buy:<行号>；合并 = buy:merge:<组 id> */
  key: string
  stockName: string
  /** 应买价 = 批次买入价（C 列，分） */
  priceCents: number
  /** 这一轮要买回的股数（合并行相加） */
  qty: number
  amountCents: number
  /** 涉及的明细行号（升序） */
  rows: number[]
  sourceQty?: Record<number, number>
  merged: boolean
  /** 点击跳转用：合并行取最早买入的那笔 */
  anchorRow: number
  earliestBuyDate: string | null
  /** 这一轮最后一次卖出的日期 */
  lastSoldAt: string | null
  /** 这笔（或组内任一笔）有过已回补完的待买单 */
  repaid: boolean
}

/** 空日期排最后 */
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a <= b ? a : b
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a >= b ? a : b
}

export function buildNextRoundBuyRows(opts: {
  lots: readonly Lot[]
  orders: readonly RebuyOrder[]
  sells: readonly SellExecution[]
  merges: readonly LotMergeLink[]
  consumed?: ReadonlyMap<number, number>
  /** 沙盒模拟行（300000 段）：只活在预览里，不给它排下一轮 */
  sandboxRows?: ReadonlySet<number>
}): NextRoundBuyRow[] {
  const { lots, orders, sells, merges, sandboxRows, consumed } = opts

  /** 还有没回补完的卖单 → 那张 P 列待买已经在提醒，这里不再给一档 */
  const openRows = new Set(orders.filter((o) => o.remainingQty > 0).map((o) => o.sourceRow))
  const repaidRows = new Set(orders.filter((o) => o.remainingQty === 0 && o.execQty > 0).map((o) => o.sourceRow))
  /**
   * V9.57：「记卖出」子成交消耗掉的批次，买回由那张子卖出的待买负责。
   * 原批次自己不能再排「下一轮」——否则同一笔钱会被提示两次（一次待买、一次下一轮）：
   * 还没买回时两档同价并列，买回后又因为虚拟批次已经持有 500 股仍提示再买 500。
   */
  const orderSellIds = new Set(orders.map((o) => o.sellExecId))
  const childOrderLotIds = new Set<string>()
  for (const s of sells) {
    if (!s.lotId) continue
    if (s.lotId === `lot:${s.sourceRow}`) continue
    if (orderSellIds.has(s.id)) childOrderLotIds.add(s.lotId)
  }

  const soldAtByRow = new Map<number, string | null>()
  for (const s of sells) soldAtByRow.set(s.sourceRow, latest(soldAtByRow.get(s.sourceRow) ?? null, s.soldAt))

  const isCandidate = (l: Lot): boolean =>
    // 真实批次：回补虚拟批次（lot:exec:*）自己不卖，下一轮由它自己的卖出说了算
    l.id === `lot:${l.sourceRow}` &&
    l.remainingQty === 0 &&
    l.qty > 0 &&
    !openRows.has(l.sourceRow) &&
    !childOrderLotIds.has(l.id) &&
    !sandboxRows?.has(l.sourceRow)

  const candidates = lots.filter(isCandidate).map((l) => ({...l, qty: Math.max(0,l.qty-(consumed?.get(l.sourceRow)??0))})).filter((l)=>l.qty>0)
  const byRow = new Map(candidates.map((l) => [l.sourceRow, l]))

  /** 行号 → 同价合并组（组内 ≥2 笔候选才合） */
  const groupByRow = new Map<number, LotMergeLink>()
  for (const m of merges) {
    if (m.rows.length < 2) continue
    const members = m.rows
      .map((r) => byRow.get(r))
      .filter((l): l is Lot => Boolean(l && l.stockName === m.stockName && l.buyPriceCents === m.priceCents))
    if (members.length < 2) continue
    for (const l of members) groupByRow.set(l.sourceRow, m)
  }

  const rows: NextRoundBuyRow[] = []
  const groupIndex = new Map<string, NextRoundBuyRow>()

  const pushSingle = (l: Lot): void => {
    rows.push({
      key: `buy:${l.sourceRow}`,
      stockName: l.stockName,
      priceCents: l.buyPriceCents,
      qty: l.qty,
      amountCents: l.buyPriceCents * l.qty,
      rows: [l.sourceRow],
      sourceQty: {[l.sourceRow]:l.qty},
      merged: false,
      anchorRow: l.sourceRow,
      earliestBuyDate: l.buyDate,
      lastSoldAt: soldAtByRow.get(l.sourceRow) ?? null,
      repaid: repaidRows.has(l.sourceRow),
    })
  }

  for (const l of candidates) {
    const samePrice = candidates.filter((x) => x.stockName === l.stockName && x.buyPriceCents === l.buyPriceCents)
    const legacy = groupByRow.get(l.sourceRow)
    const group = legacy && samePrice.every((x) => groupByRow.get(x.sourceRow)?.id === legacy.id)
      ? legacy
      : { id: `auto:${l.stockName}:${l.buyPriceCents}`, stockName: l.stockName, priceCents: l.buyPriceCents,
          at: 0, rows: samePrice.map((x) => x.sourceRow) }
    if (group.rows.length < 2) {
      pushSingle(l)
      continue
    }
    const hit = groupIndex.get(group.id)
    if (hit) {
      hit.sourceQty = {...hit.sourceQty,[l.sourceRow]:l.qty}
      hit.qty += l.qty
      hit.amountCents += l.buyPriceCents * l.qty
      if (!hit.rows.includes(l.sourceRow)) hit.rows.push(l.sourceRow)
      const prevDate = hit.earliestBuyDate
      hit.earliestBuyDate = earlier(hit.earliestBuyDate, l.buyDate)
      hit.lastSoldAt = latest(hit.lastSoldAt, soldAtByRow.get(l.sourceRow) ?? null)
      // 锚 = 最早买入日、同日取小行号（原两段等价更新合并成一段，V9.64 审计清理）
      if (l.buyDate && (prevDate === null || l.buyDate < prevDate || (l.buyDate === prevDate && l.sourceRow < hit.anchorRow))) {
        hit.anchorRow = l.sourceRow
      }
      if (repaidRows.has(l.sourceRow)) hit.repaid = true
      continue
    }
    const row: NextRoundBuyRow = {
      key: `buy:merge:${group.id}`,
      stockName: l.stockName,
      priceCents: l.buyPriceCents,
      qty: l.qty,
      amountCents: l.buyPriceCents * l.qty,
      rows: [l.sourceRow],
      sourceQty: {[l.sourceRow]:l.qty},
      merged: true,
      anchorRow: l.sourceRow,
      earliestBuyDate: l.buyDate,
      lastSoldAt: soldAtByRow.get(l.sourceRow) ?? null,
      repaid: repaidRows.has(l.sourceRow),
    }
    groupIndex.set(group.id, row)
    rows.push(row)
  }

  for (const row of rows) row.rows.sort((a, b) => a - b)

  // 买入价从低到高（跌到哪一档就提示哪一档），同价按行号
  return rows.sort((a, b) => a.priceCents - b.priceCents || a.anchorRow - b.anchorRow)
}

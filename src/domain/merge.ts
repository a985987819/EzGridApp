/**
 * 同价买单合并的展示层（V9.45）。
 *
 * 关联只存在 `merges` 表里（records 一分不改）：几笔同股票、同买入价、还没卖完的
 * 批次绑成一组。挂单页的「待卖」提醒按（组 + 目标价）合成一条：数量、金额、
 * 预期盈利相加，日期取组内最早的那笔买入日期；解除关联立刻恢复逐笔显示。
 *
 * 只有组里还有 ≥2 笔在卖（未删除、有剩余）时才合并；卖到只剩一笔就自动散开，
 * 但关联本身保留（重新买回/恢复后又能合上）。
 */
import type { Lot, LotMergeLink, SellTarget, TradePlan } from './types'

/** 挂单页待卖清单的一行：可能是单笔，也可能是合并组里同一价位的几笔 */
export interface TargetRow {
  /** 单笔 = target id；合并 = merge:<组 id>|<目标价>（计划价也挂在这个 ref 上） */
  key: string
  targets: SellTarget[]
  /** 成员批次行号（合并行是全部贡献者；单笔行是 0~1 个） */
  lotRows: number[]
  lotIds: string[]
  priceCents: number
  qty: number
  amountCents: number
  expectProfitCents: number
  /** 是否真的合并了 ≥2 笔 */
  merged: boolean
  /** 点击 / data-row 用：合并行取最早买入的那笔 */
  anchorRow: number
  /** 合并后取最早的买入日期（YYYY-MM-DD） */
  earliestBuyDate: string | null
  buyPriceCents: number | null
  planPriceCents: number | null
  planQty: number | null
  sandbox: boolean
}

/** 行号 → 合并组：只有「还有 ≥2 笔在卖」的组才返回 */
export function activeMergeGroupOf(
  merges: readonly LotMergeLink[],
  lots: readonly Lot[],
): Map<number, LotMergeLink> {
  const lotByRow = new Map<number, Lot>()
  for (const l of lots) {
    if (l.id !== `lot:${l.sourceRow}`) continue
    if (l.remainingQty <= 0) continue
    lotByRow.set(l.sourceRow, l)
  }
  const byRow = new Map<number, LotMergeLink>()
  for (const m of merges) {
    const members = m.rows
      .map((r) => lotByRow.get(r))
      .filter(
        (l): l is Lot => Boolean(l && l.stockName === m.stockName && l.buyPriceCents === m.priceCents),
      )
    if (members.length < 2) continue
    for (const l of members) byRow.set(l.sourceRow, m)
  }
  return byRow
}

/** 比日期：空值排最后 */
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a <= b ? a : b
}

export function mergeTargetRows(opts: {
  targets: readonly SellTarget[]
  lots: readonly Lot[]
  merges: readonly LotMergeLink[]
  plans?: readonly TradePlan[]
  /** 沙盒模拟行（300000 段）：永远不参与合并 */
  sandboxRows?: ReadonlySet<number>
}): TargetRow[] {
  const { targets, lots, merges, plans = [], sandboxRows } = opts
  const lotById = new Map(lots.map((l) => [l.id, l]))
  const groupOf = activeMergeGroupOf(merges, lots)
  const rows: TargetRow[] = []
  const mergedIndex = new Map<string, TargetRow>()

  for (const t of targets) {
    const lot = lotById.get(t.lotId) ?? null
    const sandbox = Boolean(lot && sandboxRows?.has(lot.sourceRow))
    const group = lot && !sandbox ? groupOf.get(lot.sourceRow) ?? null : null

    if (!group || !lot) {
      const plan = plans.find((p) => p.kind === 'sell' && p.refId === t.id)
      rows.push({
        key: t.id,
        targets: [t],
        lotRows: lot ? [lot.sourceRow] : [],
        lotIds: [t.lotId],
        priceCents: t.priceCents,
        qty: t.qty,
        amountCents: t.amountCents,
        expectProfitCents: t.expectProfitCents,
        merged: false,
        anchorRow: lot?.sourceRow ?? Number(t.lotId.replace('lot:', '')),
        earliestBuyDate: lot?.buyDate ?? null,
        buyPriceCents: lot?.buyPriceCents ?? null,
        planPriceCents: t.planPriceCents ?? plan?.priceCents ?? null,
        planQty: t.planQty ?? plan?.qty ?? null,
        sandbox,
      })
      continue
    }

    const key = `${group.id}@${t.priceCents}`
    const hit = mergedIndex.get(key)
    if (hit) {
      hit.targets.push(t)
      hit.lotIds.push(t.lotId)
      if (!hit.lotRows.includes(lot.sourceRow)) hit.lotRows.push(lot.sourceRow)
      hit.qty += t.qty
      hit.amountCents += t.amountCents
      hit.expectProfitCents += t.expectProfitCents
      hit.earliestBuyDate = earlier(hit.earliestBuyDate, lot.buyDate)
      if (lot.sourceRow < hit.anchorRow) hit.anchorRow = lot.sourceRow
    } else {
      const row: TargetRow = {
        key,
        targets: [t],
        lotRows: [lot.sourceRow],
        lotIds: [t.lotId],
        priceCents: t.priceCents,
        qty: t.qty,
        amountCents: t.amountCents,
        expectProfitCents: t.expectProfitCents,
        merged: true,
        anchorRow: lot.sourceRow,
        earliestBuyDate: lot.buyDate,
        buyPriceCents: lot.buyPriceCents,
        planPriceCents: null,
        planQty: null,
        sandbox: false,
      }
      mergedIndex.set(key, row)
      rows.push(row)
    }
  }

  for (const row of rows) {
    if (!row.merged) continue
    // 同价只有一笔（其它成员的目标被拆到别的价位）：退回单笔显示
    if (row.lotRows.length < 2) {
      const t = row.targets[0]
      row.key = t.id
      row.merged = false
      row.planPriceCents = t.planPriceCents ?? null
      row.planQty = t.planQty ?? null
      continue
    }
    const plan = plans.find((p) => p.kind === 'sell' && p.refId === row.key)
    if (plan) {
      row.planPriceCents = plan.priceCents
      row.planQty = plan.qty
    } else if (row.targets.every((t) => t.planPriceCents != null)) {
      // 合并前每笔都设过计划价：同价就把数量加起来当合并行的计划；不同价就没法合成一张单
      const prices = new Set(row.targets.map((t) => t.planPriceCents))
      if (prices.size === 1) {
        row.planPriceCents = row.targets[0].planPriceCents ?? null
        row.planQty = row.targets.reduce((a, t) => a + (t.planQty ?? t.qty), 0)
      }
    }
  }
  return rows
}

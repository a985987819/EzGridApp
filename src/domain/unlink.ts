/**
 * 删掉（或整批回滚掉）某些行之后，**这些行号上的关联必须一起清掉**（V9.56）。
 *
 * 这些表全部以「行号」当外键：
 *   hedges.sellRow / hedges.items[].row    先卖后买挂钩（会计输入，会改变敞口与盈利）
 *   buyTargets.sellRow                     卖单拆多笔买入（决定挂单价与量）
 *   extraTargets.lotId = lot:<行号>         批次拆多目标（先占待卖额度）
 *   merges.rows[]                          同价买单合并（挂单页合并显示）
 *   chainLinks.anchorRow / memberRows[]    回本链归属（锚点与成员）
 *   plans.refId = target:lot:<行号> / rb:sell:<行号>   改单（计划价量）
 *
 * 为什么必须清：导入是按 Excel 行号分配 `sourceRow` 的（`importPlan` 见空就用原行号），
 * 回滚后再导一次，同一个行号可能是**另一笔交易**——旧挂钩/旧拆分档/旧计划价会静默套上去，
 * 账面数字没动但价格、挂单、亏损全错。所以：行没了，指向它的关联一律跟着没。
 *
 * 纯函数（不碰 IO），由 `store/useApp` 在事务里落库；挂单/概览/回本链都是派生，
 * 清完之后下一次 buildLedger 自然就对了。
 */
import type { ExtraBuyTarget, ExtraTarget, HedgeLink, LotMergeLink, RepairChainLink, TradePlan } from './types'

export interface RowLinkTables {
  hedges: readonly HedgeLink[]
  buyTargets: readonly ExtraBuyTarget[]
  extraTargets: readonly ExtraTarget[]
  merges: readonly LotMergeLink[]
  chainLinks: readonly RepairChainLink[]
  plans: readonly TradePlan[]
}

export interface RowLinkCleanup {
  hedges: HedgeLink[]
  buyTargets: ExtraBuyTarget[]
  extraTargets: ExtraTarget[]
  merges: LotMergeLink[]
  chainLinks: RepairChainLink[]
  plans: TradePlan[]
  /** 每张表「被删掉/被改过」的条数——写审计用 */
  changed: Record<keyof RowLinkTables, number>
  /** 被清掉的挂钩分配股数（提示用户「你的挂钩随行一起没了」） */
  hedgeQty: number
}

/** `lot:12` → 12；虚拟批次（`lot:exec:*`）认不出行号 → null（不动） */
function rowOfLotId(lotId: string): number | null {
  const m = /^lot:(\d+)$/.exec(lotId)
  return m ? Number(m[1]) : null
}

/** 计划身份里包着的行号：`target:lot:12` / `rb:sell:12`；价格型身份（`sell:股票:7.80`）认不出 → null */
function rowOfPlanRef(refId: string): number | null {
  const a = /^target:lot:(\d+)$/.exec(refId)
  if (a) return Number(a[1])
  const b = /^rb:sell:(\d+)$/.exec(refId)
  if (b) return Number(b[1])
  return null
}

export function cleanupRowLinks(rows: ReadonlySet<number>, tables: RowLinkTables): RowLinkCleanup {
  const changed: Record<keyof RowLinkTables, number> = {
    hedges: 0,
    buyTargets: 0,
    extraTargets: 0,
    merges: 0,
    chainLinks: 0,
    plans: 0,
  }
  let hedgeQty = 0

  const hedges: HedgeLink[] = []
  for (const h of tables.hedges) {
    if (rows.has(h.sellRow)) {
      // 卖出那笔没了 → 整条挂钩作废
      changed.hedges += 1
      hedgeQty += h.items.reduce((a, it) => a + it.qty, 0)
      continue
    }
    const items = h.items.filter((it) => it.row >= 0 && !rows.has(it.row))
    if (items.length === h.items.length) {
      hedges.push(h)
      continue
    }
    changed.hedges += 1
    hedgeQty += h.items.filter((it) => rows.has(it.row)).reduce((a, it) => a + it.qty, 0)
    // 挂的批次没了：剩下的条目照旧留着（合计对不上时 buildLedger 会标 hedgeMismatch）
    if (items.length > 0) hedges.push({ ...h, items })
  }

  const buyTargets = tables.buyTargets.filter((t) => {
    if (!rows.has(t.sellRow)) return true
    changed.buyTargets += 1
    return false
  })

  const extraTargets = tables.extraTargets.filter((t) => {
    const row = rowOfLotId(t.lotId)
    if (row === null || !rows.has(row)) return true
    changed.extraTargets += 1
    return false
  })

  const merges: LotMergeLink[] = []
  for (const m of tables.merges) {
    const kept = m.rows.filter((r) => !rows.has(r))
    if (kept.length === m.rows.length) {
      merges.push(m)
      continue
    }
    changed.merges += 1
    // 组内不足两笔就没有「合并」这回事了
    if (kept.length >= 2) merges.push({ ...m, rows: kept })
  }
  const aliveMergeIds = new Set(merges.map((m) => m.id))

  const chainLinks: RepairChainLink[] = []
  for (const c of tables.chainLinks) {
    if (rows.has(c.anchorRow)) {
      changed.chainLinks += 1
      continue
    }
    const kept = c.memberRows.filter((r) => !rows.has(r))
    if (kept.length === c.memberRows.length) {
      chainLinks.push(c)
      continue
    }
    changed.chainLinks += 1
    // 成员没了但锚点还在：保留「用户结束这条链」的时间，只摘掉失效成员
    chainLinks.push({ ...c, memberRows: kept })
  }

  const plans = tables.plans.filter((p) => {
    const row = rowOfPlanRef(p.refId)
    if (row !== null && rows.has(row)) {
      changed.plans += 1
      return false
    }
    // 合并组没了（或组 id 指向被删的行）→ 挂在它上面的计划价也一起清
    const m = /^(merge:\d+)@/.exec(p.refId)
    if (m && !aliveMergeIds.has(m[1])) {
      changed.plans += 1
      return false
    }
    return true
  })

  return { hedges, buyTargets, extraTargets, merges, chainLinks, plans, changed, hedgeQty }
}

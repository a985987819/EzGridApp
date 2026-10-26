/**
 * 网格进行度统计（V9.61）——统计页回答「我的网格做得怎么样」。
 *
 * 纯派生、无 IO：输入 ledger 的 lots / sells，输出进行度汇总与「高成交点位」排名。
 *
 * 「完成一轮」= 一个批次买入后**已卖光**（remainingQty === 0 且 qty > 0）。
 * 真实批次与回补虚拟批次（lot:exec:*）都算——回补买入也是真金白银的一轮；
 * 部分卖出、还有持仓的算「进行中」。裸卖（无批次）不是买单，不参与。
 *
 * 盈利口径：点位/进行度卡里的盈利 = **批次自身的卖出盈利**（sell.lotId 归属），
 * 不含裸卖盈利与挂钩暂记负盈利——那些不是「这一轮买」赚的。全局已实现盈利
 * （ledger.totals.profitCents）仍是总账口径，两边不混用。
 */
import type { Lot, SellExecution } from './types'

/** 一个「买单价位」：同股、同买入价的所有批次汇总 */
export interface HotLevelRow {
  stockName: string
  priceCents: number
  /** 已完成轮次（买过且已卖光的批次数） */
  doneCount: number
  /** 进行中批次数（还有剩余） */
  activeCount: number
  /** 该价位累计买入股数 */
  buyQty: number
  /** 该价位批次自身的已实现盈利（含部分卖出那截） */
  profitCents: number
}

export interface GridProgress {
  /** 完成轮次总数 */
  doneRounds: number
  /** 进行中批次数 */
  activeRounds: number
  /** 批次口径的已实现盈利合计（不含裸卖/挂钩暂记） */
  realizedCents: number
  /** 每完成一轮平均盈利 = 完成批次的盈利 / 完成轮次（没有完成轮次为 null） */
  avgProfitCents: number | null
  /** 完成批次的平均持仓天数 = 买入日 → 最后一笔卖出日（缺日期的不进平均） */
  avgHoldingDays: number | null
  /** 完成次数最多的价位（完成 0 轮时为 null） */
  hotTop: HotLevelRow | null
  /** 高成交点位排名：完成次数降序 → 盈利降序 → 价位升序 */
  levels: HotLevelRow[]
}

interface SellAgg {
  profit: number
  lastSoldAt: string | null
}

/** YYYY-MM-DD → 当天 UTC 0 点毫秒；认不出返回 null */
function dayMs(iso: string | null): number | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(ms) ? ms : null
}

export function buildGridStats(lots: readonly Lot[], sells: readonly SellExecution[]): GridProgress {
  // 卖出按批次聚合：批次自身盈利 + 最后一笔卖出日（持仓天数用）
  const sellAgg = new Map<string, SellAgg>()
  for (const s of sells) {
    if (!s.lotId) continue
    const hit = sellAgg.get(s.lotId) ?? { profit: 0, lastSoldAt: null }
    if (s.profitCents !== null) hit.profit += s.profitCents
    if (s.soldAt && (!hit.lastSoldAt || s.soldAt > hit.lastSoldAt)) hit.lastSoldAt = s.soldAt
    sellAgg.set(s.lotId, hit)
  }

  const map = new Map<string, HotLevelRow>()
  let doneRounds = 0
  let activeRounds = 0
  let realizedCents = 0
  let doneProfitCents = 0
  let holdingDays = 0
  let holdingSamples = 0

  for (const l of lots) {
    if (l.qty <= 0) continue
    const k = `${l.stockName}|${l.buyPriceCents}`
    let row = map.get(k)
    if (!row) {
      row = { stockName: l.stockName, priceCents: l.buyPriceCents, doneCount: 0, activeCount: 0, buyQty: 0, profitCents: 0 }
      map.set(k, row)
    }
    row.buyQty += l.qty
    const agg = sellAgg.get(l.id)
    row.profitCents += agg?.profit ?? 0
    realizedCents += agg?.profit ?? 0
    if (l.remainingQty === 0) {
      row.doneCount += 1
      doneRounds += 1
      doneProfitCents += agg?.profit ?? 0
      const from = dayMs(l.buyDate)
      const to = dayMs(agg?.lastSoldAt ?? null)
      if (from !== null && to !== null && to >= from) {
        holdingDays += (to - from) / 86400000
        holdingSamples += 1
      }
    } else {
      row.activeCount += 1
      activeRounds += 1
    }
  }

  const levels = [...map.values()].sort(
    (a, b) => b.doneCount - a.doneCount || b.profitCents - a.profitCents || a.priceCents - b.priceCents || a.stockName.localeCompare(b.stockName),
  )

  return {
    doneRounds,
    activeRounds,
    realizedCents,
    avgProfitCents: doneRounds > 0 ? Math.round(doneProfitCents / doneRounds) : null,
    avgHoldingDays: holdingSamples > 0 ? Math.round((holdingDays / holdingSamples) * 10) / 10 : null,
    hotTop: levels.find((l) => l.doneCount > 0) ?? null,
    levels,
  }
}

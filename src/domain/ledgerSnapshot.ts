import { buildLedger } from './ledger'
import { buildRecordNoIndex } from './recordNo'
import { buildNextRoundBuyRows } from './buyBoard'
import { buildBuySuggestions, consumedNextRounds } from './suggestions'
import { mergeTargetRows } from './merge'
import type { BookingReceipt } from './booking'
import type { AuditLog, ExtraBuyTarget, ExtraTarget, HedgeLink, LotMergeLink, RawRecord, RebuyExecution, RepairChainLink, StockConfig, TradePlan } from './types'

/** 全量交换格式：只保存派生输入，稳定身份沿用内部主键，与工作表行位置无关。 */
export interface LedgerSnapshot {
  schemaVersion: 11 | 12
  exportedAt: string
  settings: { deriveSellPrice: boolean }
  stocks: StockConfig[]
  records: RawRecord[]
  batches: { id: string; fileName: string; sheetName: string; importedAt: number; recordCount: number; addedCount: number; updatedCount?: number }[]
  auditLogs: AuditLog[]
  rebuyExecutions: RebuyExecution[]
  plans: TradePlan[]
  extraTargets: ExtraTarget[]
  buyTargets: ExtraBuyTarget[]
  hedges: HedgeLink[]
  merges: LotMergeLink[]
  chainLinks: RepairChainLink[]
  bookingReceipts?: BookingReceipt[]
}

export type SnapshotCell = string | number | boolean | null
export type SnapshotRow = Record<string, SnapshotCell>

/** 可见的只读核对表；人工表与自动有效关联分开，后者绝不写回 hedges/chainLinks。 */
export function snapshotViews(data: LedgerSnapshot): Record<string, SnapshotRow[]> {
  const ledger = buildLedger(data.records, data.stocks, {
    ...data.settings, executions: data.rebuyExecutions, plans: data.plans,
    extraTargets: data.extraTargets, buyTargets: data.buyTargets, hedges: data.hedges, chainLinks: data.chainLinks,
  })
  const scalar = (x: object): SnapshotRow => Object.fromEntries(Object.entries(x)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)))
  const no = buildRecordNoIndex(data.records)
  const buys = buildBuySuggestions(ledger.buySplits, buildNextRoundBuyRows({
    lots: ledger.lots, orders: ledger.orders, sells: ledger.sells, merges: data.merges,
    consumed: consumedNextRounds(data.records),
  }), data.plans)
  const sells = mergeTargetRows({ targets: ledger.targets, lots: ledger.lots, merges: data.merges, plans: data.plans })
  return {
    '核对_合计': [scalar(ledger.totals)],
    '核对_记录序号': data.records.map((r) => ({ 记录ID: r.sourceRow, 序号: no.of(r.sourceRow) })),
    '核对_高位关联': ledger.effectiveHedges.flatMap((h) => h.items.map((it) => ({
      卖出记录ID: h.sellRow, 买入记录ID: it.row, 股数: it.qty,
      来源: data.hedges.some((m) => m.sellRow === h.sellRow) ? '人工' : '自动',
    }))),
    '核对_回本链': ledger.repairChains.map(scalar),
    '核对_链分支': ledger.repairChains.flatMap((c) => c.branches.map((b) => ({ 链ID: c.id, ...scalar(b) }))),
    '核对_链成员': ledger.repairChains.flatMap((c) => [
      ...c.relatedSellRows.map((row) => ({ 链ID: c.id, 分支ID: '根卖出', 记录ID: row })),
      ...c.branches.flatMap((b) => b.memberRows.map((row) => ({ 链ID: c.id, 分支ID: b.key, 记录ID: row }))),
    ]),
    '核对_待买': ledger.orders.map(scalar),
    '核对_待买分档': ledger.buySplits.map(scalar),
    '核对_待卖': ledger.targets.map(scalar),
    '核对_买入建议': buys.map(scalar),
    '核对_买入来源': buys.flatMap((b) => b.sources.map((s) => ({ 建议ID: b.key, ...scalar(s) }))),
    '核对_卖出挂单': sells.map(scalar),
    '核对_组池奖励': ledger.groups.map(scalar),
    '核对_批次': ledger.lots.map(scalar),
    '核对_卖出': ledger.sells.map(scalar),
  }
}

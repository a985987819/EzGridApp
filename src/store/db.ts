import Dexie, { type Table } from 'dexie'
import type {
  AuditLog,
  ExtraTarget,
  HedgeLink,
  LotMergeLink,
  RawRecord,
  RebuyExecution,
  RepairChainLink,
  StockConfig,
  TradePlan,
} from '../domain/types'

export interface MetaRow {
  key: string
  value: string
}

export interface ImportBatch {
  id: string
  fileName: string
  sheetName: string
  importedAt: number
  recordCount: number
  addedCount: number
  /** 按行身份匹配更新的本地行数（v9.20 决策 C） */
  updatedCount?: number
}

class GridTradingDB extends Dexie {
  stocks!: Table<StockConfig, string>
  records!: Table<RawRecord, number>
  meta!: Table<MetaRow, string>
  batches!: Table<ImportBatch, string>
  auditLogs!: Table<AuditLog, number>
  rebuyExecutions!: Table<RebuyExecution, string>
  plans!: Table<TradePlan, string>
  extraTargets!: Table<ExtraTarget, string>
  hedges!: Table<HedgeLink, string>
  merges!: Table<LotMergeLink, string>
  chainLinks!: Table<RepairChainLink, string>

  constructor() {
    super('grid-trading')
    this.version(1).stores({
      stocks: 'id, name',
      records: 'sourceRow, importKey, stockName',
      meta: 'key',
      batches: 'id, importedAt',
    })
    // V2：加编辑审计表（P10）。老库自动升级，不需要手工迁移。
    this.version(2).stores({
      auditLogs: '++id, entity, entityId, at',
    })
    // V5：回补成交（S6/S8 的「记成交」）
    this.version(3).stores({
      rebuyExecutions: 'id, orderId, sellExecId, at',
    })
    // V6：计划价 + 批次拆多目标
    this.version(4).stores({
      plans: 'id, refId, kind',
      extraTargets: 'id, lotId',
    })
    // V7：账户维度
    this.version(5).stores({
      accounts: 'id, name',
    })
    // V9.26：先卖后买挂钩（裸卖 → 高位批次的分配，活跃与否纯派生）
    this.version(6).stores({
      hedges: 'id, sellRow',
    })
    // V9.32：删掉账户功能，只按一个账户做（accounts 表整表丢弃，老数据不用迁移）
    this.version(7).stores({
      accounts: null,
    })
    // V9.45：同价未卖完批次的合并关联（只影响挂单提醒的合并显示，不改 records）
    this.version(8).stores({
      merges: 'id, stockName',
    })
    // V9.46：回本链归属（锚点行 + 后续归属的真实买入行 + 用户结束时间），盈亏仍纯派生
    this.version(9).stores({
      chainLinks: 'id, anchorRow, stockName',
    })
  }
}

export const db = new GridTradingDB()

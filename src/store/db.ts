import Dexie, { type Table } from 'dexie'
import type { Account, AuditLog, ExtraTarget, RawRecord, RebuyExecution, StockConfig, TradePlan } from '../domain/types'

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
  accounts!: Table<Account, string>

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
  }
}

export const db = new GridTradingDB()

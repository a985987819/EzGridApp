import Dexie, { type Table } from 'dexie'
import type { AuditLog, RawRecord, RebuyExecution, StockConfig } from '../domain/types'

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
  }
}

export const db = new GridTradingDB()

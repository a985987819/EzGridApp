import { db } from './db'
import type { LedgerSnapshot } from '../domain/ledgerSnapshot'

/** 同一个只读事务取得全部派生输入及计算设置；读取本身不更新备份时间。 */
export async function readStoredAppState() {
  return db.transaction('r', db.tables, async () => {
    const [stocks, records, batches, auditLogs, rebuyExecutions, plans, extraTargets, buyTargets, hedges, merges, chainLinks, bookingReceipts, derive, backup, font] = await Promise.all([
      db.stocks.toArray(), db.records.toArray(), db.batches.orderBy('importedAt').reverse().toArray(), db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(), db.plans.toArray(), db.extraTargets.toArray(), db.buyTargets.toArray(),
      db.hedges.toArray(), db.merges.toArray(), db.chainLinks.toArray(), db.bookingReceipts.toArray(),
      db.meta.get('deriveSellPrice'), db.meta.get('lastBackupAt'), db.meta.get('useSystemFont'),
    ])
    const snapshot: LedgerSnapshot = {
      schemaVersion: 14, exportedAt: new Date().toISOString(), settings: { deriveSellPrice: derive?.value === 'true' },
      stocks, records, batches, auditLogs, rebuyExecutions, plans, extraTargets, buyTargets, hedges, merges, chainLinks, bookingReceipts,
    }
    return { snapshot, lastBackupAt: backup ? Number(backup.value) : null, systemFont: font?.value === '1' }
  })
}

export async function readLedgerSnapshot(): Promise<LedgerSnapshot> {
  const { snapshot } = await readStoredAppState()
  // 交换文件沿用主键顺序，页面批次列表才按时间倒序。
  return { ...snapshot, batches: [...snapshot.batches].sort((a, b) => a.id.localeCompare(b.id)) }
}

/** 写事务中的额度校验也从同一版本读取设置，不采用任何页面闭包。 */
export async function readLedgerInputs() {
  return db.transaction('r', [db.records, db.stocks, db.rebuyExecutions, db.hedges, db.extraTargets, db.chainLinks, db.buyTargets, db.meta], async () => {
    const [records, stocks, executions, hedges, extraTargets, chainLinks, buyTargets, derive] = await Promise.all([
      db.records.toArray(), db.stocks.toArray(), db.rebuyExecutions.toArray(), db.hedges.toArray(),
      db.extraTargets.toArray(), db.chainLinks.toArray(), db.buyTargets.toArray(), db.meta.get('deriveSellPrice'),
    ])
    return { records, stocks, options: { executions, hedges, extraTargets, chainLinks, buyTargets, deriveSellPrice: derive?.value === 'true' } }
  })
}

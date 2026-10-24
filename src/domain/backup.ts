/**
 * 恢复前的最小内容校验：schemaVersion 之外再兜一道。
 * 结构坏掉的备份（手改 JSON、半截文件）整包拒绝，
 * 配合「恢复前强制导出」，保证本地数据不会被坏备份覆盖。
 */

export interface BackupShape {
  schemaVersion?: number
  stocks?: unknown
  records?: unknown
  batches?: unknown
  auditLogs?: unknown
  rebuyExecutions?: unknown
  plans?: unknown
  extraTargets?: unknown
  accounts?: unknown
}

function checkRecords(records: unknown[]): string | null {
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as Record<string, unknown> | null
    if (!rec || typeof rec !== 'object') return `records[${i}] 不是对象`
    if (typeof rec.sourceRow !== 'number' || !Number.isInteger(rec.sourceRow)) return `records[${i}] 缺 sourceRow（行号）`
    if (typeof rec.importKey !== 'string' || rec.importKey === '') return `records[${i}] 缺 importKey`
    if (typeof rec.stockName !== 'string' || rec.stockName === '') return `records[${i}] 缺 stockName`
  }
  return null
}

function checkStocks(stocks: unknown[]): string | null {
  for (let i = 0; i < stocks.length; i += 1) {
    const s = stocks[i] as Record<string, unknown> | null
    if (!s || typeof s !== 'object') return `stocks[${i}] 不是对象`
    if (typeof s.id !== 'string' || s.id === '') return `stocks[${i}] 缺 id`
    if (typeof s.name !== 'string' || s.name === '') return `stocks[${i}] 缺 name`
    if (typeof s.intervalCents !== 'number' || !Number.isFinite(s.intervalCents)) return `stocks[${i}] 缺 intervalCents（绝对间隔）`
  }
  return null
}

function checkAccounts(accounts: unknown[]): string | null {
  for (let i = 0; i < accounts.length; i += 1) {
    const a = accounts[i] as Record<string, unknown> | null
    if (!a || typeof a !== 'object') return `accounts[${i}] 不是对象`
    if (typeof a.id !== 'string' || a.id === '') return `accounts[${i}] 缺 id`
    if (typeof a.name !== 'string') return `accounts[${i}] 缺 name`
  }
  return null
}

/** 通过返回 null；不通过返回中文原因，恢复方直接抛错 */
export function validateBackup(data: BackupShape): string | null {
  if (data.records !== undefined) {
    if (!Array.isArray(data.records)) return 'records 不是数组'
    const problem = checkRecords(data.records)
    if (problem) return problem
  }
  if (data.stocks !== undefined) {
    if (!Array.isArray(data.stocks)) return 'stocks 不是数组'
    const problem = checkStocks(data.stocks)
    if (problem) return problem
  }
  if (data.accounts !== undefined) {
    if (!Array.isArray(data.accounts)) return 'accounts 不是数组'
    const problem = checkAccounts(data.accounts)
    if (problem) return problem
  }
  return null
}

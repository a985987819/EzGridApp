import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { db, type ImportBatch } from './db'
import { buildLedger } from '../domain/ledger'
import { compareBaseline } from '../domain/baseline'
import { DEFAULT_STOCKS } from '../domain/defaults'
import { applyEdits, type EditableKey } from '../domain/edit'
import { applyOrder, normalizeStocks } from '../domain/stocks'
import { buildManualRecord, MANUAL_ROW_BASE, type ManualInput } from '../domain/manual'
import type { AuditLog, CheckResult, Ledger, RawRecord, RebuyExecution, RebuyOrder, StockConfig } from '../domain/types'
import type { ParseResult } from '../io/parseWorkbook'

export interface ImportOutcome {
  added: number
  duplicated: number
  batch: ImportBatch
}

interface AppContextValue {
  ready: boolean
  stocks: StockConfig[]
  records: RawRecord[]
  audits: AuditLog[]
  executions: RebuyExecution[]
  ledger: Ledger
  baseline: CheckResult[]
  deriveSellPrice: boolean
  setDeriveSellPrice: (v: boolean) => void
  preview: ParseResult | null
  setPreview: (p: ParseResult | null) => void
  batches: ImportBatch[]
  commitImport: (p: ParseResult, fileName: string) => Promise<ImportOutcome>
  rollbackBatch: (batchId: string) => Promise<number>
  editRecord: (sourceRow: number, draft: Partial<Record<EditableKey, string>>) => Promise<number>
  softDelete: (sourceRow: number) => Promise<void>
  restore: (sourceRow: number) => Promise<void>
  addManualRecord: (input: ManualInput) => Promise<number>
  reorderStocks: (orderedIds: string[]) => Promise<void>
  setStockEnabled: (id: string, enabled: boolean) => Promise<void>
  recordRebuy: (order: RebuyOrder, qty: number, priceCents: number, rewardQty: number, note?: string) => Promise<void>
  removeRebuy: (id: string) => Promise<void>
  historyOf: (sourceRow: number) => AuditLog[]
  updateStock: (s: StockConfig) => Promise<void>
  addStock: (s: StockConfig) => Promise<void>
  removeStock: (id: string) => Promise<void>
  resetAll: () => Promise<void>
  exportBackup: () => Promise<string>
  restoreBackup: (json: string) => Promise<void>
  basename: string
  lastBackupAt: number | null
}

const AppContext = createContext<AppContextValue | null>(null)

function audit(entityId: string, field: string, oldValue: string, newValue: string, source: string): AuditLog {
  return { entity: 'record', entityId, field, oldValue, newValue, at: Date.now(), source }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [stocks, setStocks] = useState<StockConfig[]>(DEFAULT_STOCKS)
  const [records, setRecords] = useState<RawRecord[]>([])
  const [audits, setAudits] = useState<AuditLog[]>([])
  const [executions, setExecutions] = useState<RebuyExecution[]>([])
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [deriveSellPrice, setDeriveSellPrice] = useState(false)
  const [preview, setPreview] = useState<ParseResult | null>(null)
  const [basename, setBasename] = useState('—')
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null)

  const reloadRecords = useCallback(async () => {
    const [r, a, x] = await Promise.all([
      db.records.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
    ])
    setRecords(r)
    setAudits(a)
    setExecutions(x)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      await db.open()
      if ((await db.stocks.count()) === 0) {
        await db.stocks.bulkPut(DEFAULT_STOCKS)
      }
      const [sRaw, r, a, b, x, backupMeta] = await Promise.all([
        db.stocks.toArray(),
        db.records.toArray(),
        db.auditLogs.toArray(),
        db.batches.orderBy('importedAt').reverse().toArray(),
        db.rebuyExecutions.toArray(),
        db.meta.get('lastBackupAt'),
      ])
      if (!alive) return
      // 老库补齐 order / enabled 并压平序号
      const s = normalizeStocks(sRaw.length ? sRaw : DEFAULT_STOCKS)
      const dirty = sRaw.some((x) => typeof x.order !== 'number' || typeof x.enabled !== 'boolean')
      if (dirty) await db.stocks.bulkPut(s)
      setStocks(s)
      setRecords(r)
      setAudits(a)
      setExecutions(x)
      setBatches(b)
      setBasename(b[0]?.fileName ?? '—')
      setLastBackupAt(backupMeta ? Number(backupMeta.value) : null)
      setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  const ledger = useMemo(
    () => buildLedger(records, stocks, { deriveSellPrice, executions }),
    [records, stocks, deriveSellPrice, executions],
  )

  const baseline = useMemo(() => compareBaseline(ledger), [ledger])

  const commitImport = useCallback(
    async (p: ParseResult, fileName: string): Promise<ImportOutcome> => {
      const existing = new Set((await db.records.toArray()).map((r) => r.importKey))
      const batchId = `batch:${Date.now()}`
      const fresh = p.records
        .filter((r) => !existing.has(r.importKey))
        .map((r) => ({ ...r, origin: 'excel' as const, batchId }))
      const duplicated = p.records.length - fresh.length
      const batch: ImportBatch = {
        id: batchId,
        fileName,
        sheetName: p.sheetName,
        importedAt: Date.now(),
        recordCount: p.records.length,
        addedCount: fresh.length,
      }
      await db.transaction('rw', db.records, db.batches, db.auditLogs, async () => {
        if (fresh.length) await db.records.bulkPut(fresh)
        await db.batches.put(batch)
        if (fresh.length) {
          await db.auditLogs.bulkAdd(
            fresh.map((r) => audit(`record:${r.sourceRow}`, '导入', '', `第 ${r.sourceRow} 行`, 'import')),
          )
        }
      })
      await reloadRecords()
      setBatches(await db.batches.orderBy('importedAt').reverse().toArray())
      setBasename(fileName)
      return { added: fresh.length, duplicated, batch }
    },
    [reloadRecords],
  )

  const rollbackBatch = useCallback(
    async (batchId: string) => {
      const rows = (await db.records.toArray()).filter((r) => r.batchId === batchId)
      await db.transaction('rw', db.records, db.batches, db.auditLogs, async () => {
        await db.records.bulkDelete(rows.map((r) => r.sourceRow))
        await db.batches.delete(batchId)
        if (rows.length) {
          await db.auditLogs.bulkAdd(
            rows.map((r) => audit(`record:${r.sourceRow}`, '回滚导入', `第 ${r.sourceRow} 行`, '已移除', 'rollback')),
          )
        }
      })
      await reloadRecords()
      const left = await db.batches.orderBy('importedAt').reverse().toArray()
      setBatches(left)
      setBasename(left[0]?.fileName ?? '—')
      return rows.length
    },
    [reloadRecords],
  )

  const editRecord = useCallback(
    async (sourceRow: number, draft: Partial<Record<EditableKey, string>>) => {
      const current = await db.records.get(sourceRow)
      if (!current) throw new Error(`找不到第 ${sourceRow} 行`)
      const { record, changes, errors } = applyEdits(current, draft)
      if (errors.length) throw new Error(errors.join('；'))
      if (changes.length === 0) return 0
      const entityId = `record:${sourceRow}`
      await db.transaction('rw', db.records, db.auditLogs, async () => {
        await db.records.put(record)
        await db.auditLogs.bulkAdd(
          changes.map((c) => audit(entityId, c.label, c.oldValue, c.newValue, 'edit')),
        )
      })
      await reloadRecords()
      return changes.length
    },
    [reloadRecords],
  )

  const softDelete = useCallback(
    async (sourceRow: number) => {
      const current = await db.records.get(sourceRow)
      if (!current) return
      await db.transaction('rw', db.records, db.auditLogs, async () => {
        await db.records.put({ ...current, deletedAt: Date.now() })
        await db.auditLogs.add(audit(`record:${sourceRow}`, '软删除', '有效', '已删除', 'delete'))
      })
      await reloadRecords()
    },
    [reloadRecords],
  )

  const restore = useCallback(
    async (sourceRow: number) => {
      const current = await db.records.get(sourceRow)
      if (!current) return
      await db.transaction('rw', db.records, db.auditLogs, async () => {
        await db.records.put({ ...current, deletedAt: null })
        await db.auditLogs.add(audit(`record:${sourceRow}`, '软删除', '已删除', '有效', 'restore'))
      })
      await reloadRecords()
    },
    [reloadRecords],
  )

  const addManualRecord = useCallback(
    async (input: ManualInput) => {
      const all = await db.records.toArray()
      const maxRow = all.reduce((a, r) => Math.max(a, r.sourceRow), MANUAL_ROW_BASE - 1)
      const sourceRow = Math.max(maxRow + 1, MANUAL_ROW_BASE)
      const { record, errors } = buildManualRecord(input, sourceRow)
      if (errors.length) throw new Error(errors.join('；'))
      await db.transaction('rw', db.records, db.auditLogs, async () => {
        await db.records.put(record)
        await db.auditLogs.add(
          audit(
            `record:${sourceRow}`,
            input.kind === 'buy' ? '新增买入' : '新增卖出',
            '',
            `${record.stockName} ${record.buyPriceCents ?? record.targetPriceCents ?? ''}`,
            'create',
          ),
        )
      })
      await reloadRecords()
      return sourceRow
    },
    [reloadRecords],
  )

  const reorderStocks = useCallback(async (orderedIds: string[]) => {
    const current = await db.stocks.toArray()
    const next = applyOrder(normalizeStocks(current), orderedIds)
    await db.stocks.bulkPut(next)
    setStocks(next)
  }, [])

  const setStockEnabled = useCallback(async (id: string, enabled: boolean) => {
    const current = await db.stocks.get(id)
    if (!current) return
    await db.stocks.put({ ...current, enabled })
    setStocks(normalizeStocks(await db.stocks.toArray()))
  }, [])

  const historyOf = useCallback(
    (sourceRow: number) =>
      audits
        .filter((a) => a.entityId === `record:${sourceRow}`)
        .sort((a, b) => b.at - a.at),
    [audits],
  )

  const recordRebuy = useCallback(
    async (order: RebuyOrder, qty: number, priceCents: number, rewardQty: number, note?: string) => {
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('回补股数必须是正整数')
      if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('回补价必须大于 0')
      if (qty > order.remainingQty) throw new Error(`最多还能回补 ${order.remainingQty} 股`)
      const exec: RebuyExecution = {
        id: `exec:${order.id}:${Date.now()}`,
        orderId: order.id,
        sellExecId: order.sellExecId,
        stockId: order.stockId,
        stockName: order.stockName,
        qty,
        priceCents,
        rewardQty: Math.min(rewardQty, qty),
        groupKeyAtExecution: order.groupKey,
        at: Date.now(),
        note,
      }
      await db.transaction('rw', db.rebuyExecutions, db.auditLogs, async () => {
        await db.rebuyExecutions.put(exec)
        await db.auditLogs.add({
          entity: 'order',
          entityId: order.id,
          field: '记回补成交',
          oldValue: `已回补 ${order.execQty}`,
          newValue: `已回补 ${order.execQty + qty}（${qty} 股 @ ${(priceCents / 100).toFixed(2)}）`,
          at: Date.now(),
          source: 'rebuy',
        })
      })
      await reloadRecords()
    },
    [reloadRecords],
  )

  const removeRebuy = useCallback(
    async (id: string) => {
      await db.transaction('rw', db.rebuyExecutions, db.auditLogs, async () => {
        const exec = await db.rebuyExecutions.get(id)
        await db.rebuyExecutions.delete(id)
        if (exec) {
          await db.auditLogs.add({
            entity: 'order',
            entityId: exec.orderId,
            field: '撤销回补成交',
            oldValue: `${exec.qty} 股 @ ${(exec.priceCents / 100).toFixed(2)}`,
            newValue: '已撤销',
            at: Date.now(),
            source: 'rebuy',
          })
        }
      })
      await reloadRecords()
    },
    [reloadRecords],
  )

  const updateStock = useCallback(async (s: StockConfig) => {
    await db.stocks.put(s)
    setStocks(normalizeStocks(await db.stocks.toArray()))
  }, [])

  const addStock = useCallback(async (s: StockConfig) => {
    const current = normalizeStocks(await db.stocks.toArray())
    await db.stocks.put({ ...s, order: current.length, enabled: s.enabled !== false })
    setStocks(normalizeStocks(await db.stocks.toArray()))
  }, [])

  const removeStock = useCallback(async (id: string) => {
    await db.stocks.delete(id)
    setStocks(normalizeStocks(await db.stocks.toArray()))
  }, [])

  const resetAll = useCallback(async () => {
    await Promise.all([
      db.records.clear(),
      db.batches.clear(),
      db.auditLogs.clear(),
      db.rebuyExecutions.clear(),
    ])
    setRecords([])
    setBatches([])
    setAudits([])
    setExecutions([])
    setBasename('—')
    setPreview(null)
  }, [])

  const exportBackup = useCallback(async () => {
    const [s, r, b, a, x] = await Promise.all([
      db.stocks.toArray(),
      db.records.toArray(),
      db.batches.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
    ])
    const stamp = String(Date.now())
    await db.meta.put({ key: 'lastBackupAt', value: stamp })
    setLastBackupAt(Number(stamp))
    return JSON.stringify(
      {
        schemaVersion: 3,
        exportedAt: new Date().toISOString(),
        stocks: s,
        records: r,
        batches: b,
        auditLogs: a,
        rebuyExecutions: x,
      },
      null,
      2,
    )
  }, [])

  const restoreBackup = useCallback(
    async (json: string) => {
      const data = JSON.parse(json) as {
        schemaVersion?: number
        stocks?: StockConfig[]
        records?: RawRecord[]
        batches?: ImportBatch[]
        auditLogs?: AuditLog[]
        rebuyExecutions?: RebuyExecution[]
      }
      const version = data.schemaVersion ?? 1
      if (version > 3) throw new Error('备份版本高于当前程序，拒绝导入（P11）')
      await db.transaction('rw', db.stocks, db.records, db.batches, db.auditLogs, db.rebuyExecutions, async () => {
        if (data.stocks) {
          await db.stocks.clear()
          await db.stocks.bulkPut(data.stocks)
        }
        if (data.records) {
          await db.records.clear()
          await db.records.bulkPut(data.records)
        }
        if (data.batches) {
          await db.batches.clear()
          await db.batches.bulkPut(data.batches)
        }
        await db.auditLogs.clear()
        if (data.auditLogs) {
          // 去掉自增 id，让 Dexie 重新分配
          await db.auditLogs.bulkAdd(
            data.auditLogs.map((a) => ({
              entity: a.entity,
              entityId: a.entityId,
              field: a.field,
              oldValue: a.oldValue,
              newValue: a.newValue,
              at: a.at,
              source: a.source,
            })),
          )
        }
      })
      setStocks(await db.stocks.toArray())
      setBatches(await db.batches.toArray())
      await reloadRecords()
    },
    [reloadRecords],
  )

  const value: AppContextValue = {
    ready,
    stocks,
    records,
    audits,
    executions,
    ledger,
    baseline,
    deriveSellPrice,
    setDeriveSellPrice,
    preview,
    setPreview,
    batches,
    commitImport,
    rollbackBatch,
    editRecord,
    softDelete,
    restore,
    addManualRecord,
    reorderStocks,
    setStockEnabled,
    recordRebuy,
    removeRebuy,
    historyOf,
    updateStock,
    addStock,
    removeStock,
    resetAll,
    exportBackup,
    restoreBackup,
    basename,
    lastBackupAt,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}

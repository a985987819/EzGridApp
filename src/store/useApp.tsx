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
import { filterByAccount } from '../domain/accounts'
import { buildManualRecord, MANUAL_ROW_BASE, type ManualInput } from '../domain/manual'
import { validateBackup } from '../domain/backup'
import { DEFAULT_ACCOUNT_ID } from '../domain/types'
import type {
  Account,
  AuditLog,
  CheckResult,
  ExtraTarget,
  Ledger,
  RawRecord,
  RebuyExecution,
  RebuyOrder,
  StockConfig,
  TradePlan,
} from '../domain/types'
import type { ParseResult } from '../io/parseWorkbook'

export interface ImportOutcome {
  added: number
  duplicated: number
  batch: ImportBatch
}

/**
 * 挂单页的临时状态（V9.10）：全部按股票记——昨收输入、已确认昨收、手工涨跌停、
 * 当前选中的股票。切股、切页、刷新（同标签页）都保留；关掉标签页才清。
 * 存 sessionStorage（会话级 Web Storage），不落 IndexedDB：昨收是行情信息，
 * 隔天失效，不该进备份。
 */
export interface OrdersSession {
  stockName: string
  /** 每只股票的昨收价输入框内容（未确认也留着） */
  closes: Record<string, string>
  /** 每只股票已确认的昨收（分）：区间与今日挂单的依据 */
  confirmedCents: Record<string, number>
  /** 每只股票的涨跌停手工覆盖区间（只影响挂单页判断） */
  overrides: Record<string, { up: number; down: number }>
}

const ORDERS_SESSION_KEY = 'grid-trading:orders-session'
const EMPTY_ORDERS_SESSION: OrdersSession = { stockName: '', closes: {}, confirmedCents: {}, overrides: {} }

/** 从 sessionStorage 恢复（结构坏掉就当空会话） */
function loadOrdersSession(): OrdersSession {
  try {
    const raw = sessionStorage.getItem(ORDERS_SESSION_KEY)
    if (!raw) return EMPTY_ORDERS_SESSION
    const p = JSON.parse(raw) as Partial<OrdersSession>
    return {
      stockName: typeof p.stockName === 'string' ? p.stockName : '',
      closes: p.closes && typeof p.closes === 'object' ? p.closes : {},
      confirmedCents: p.confirmedCents && typeof p.confirmedCents === 'object' ? p.confirmedCents : {},
      overrides: p.overrides && typeof p.overrides === 'object' ? p.overrides : {},
    }
  } catch {
    return EMPTY_ORDERS_SESSION
  }
}

interface AppContextValue {
  ready: boolean
  stocks: StockConfig[]
  records: RawRecord[]
  audits: AuditLog[]
  executions: RebuyExecution[]
  plans: TradePlan[]
  extraTargets: ExtraTarget[]
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
  setPlan: (kind: 'buy' | 'sell', refId: string, priceCents: number, qty: number) => Promise<void>
  clearPlan: (refId: string) => Promise<void>
  addExtraTarget: (lotId: string, priceCents: number, qty: number) => Promise<void>
  removeExtraTarget: (id: string) => Promise<void>
  historyOf: (sourceRow: number) => AuditLog[]
  updateStock: (s: StockConfig) => Promise<void>
  addStock: (s: StockConfig) => Promise<void>
  removeStock: (id: string) => Promise<void>
  resetAll: () => Promise<void>
  exportBackup: () => Promise<string>
  restoreBackup: (json: string) => Promise<void>
  basename: string
  lastBackupAt: number | null
  /** 当前账户筛选：'all' 或 accountId */
  activeAccountId: string
  accounts: Account[]
  scopedRecords: RawRecord[]
  setActiveAccount: (id: string) => Promise<void>
  addAccount: (name: string) => Promise<void>
  systemFont: boolean
  setSystemFont: (v: boolean) => Promise<void>
  ordersSession: OrdersSession
  patchOrdersSession: (p: Partial<OrdersSession>) => void
}

const AppContext = createContext<AppContextValue | null>(null)

const SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif'

/** 系统字体开关：把库的字体变量换掉，浏览器就不再下载那三份中文字体 */
export function applySystemFont(on: boolean): void {
  const root = document.documentElement
  if (on) root.style.setProperty('--animal-font-family', SYSTEM_FONT_STACK)
  else root.style.removeProperty('--animal-font-family')
}

function audit(entityId: string, field: string, oldValue: string, newValue: string, source: string): AuditLog {
  return { entity: 'record', entityId, field, oldValue, newValue, at: Date.now(), source }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [stocks, setStocks] = useState<StockConfig[]>(DEFAULT_STOCKS)
  const [records, setRecords] = useState<RawRecord[]>([])
  const [audits, setAudits] = useState<AuditLog[]>([])
  const [executions, setExecutions] = useState<RebuyExecution[]>([])
  const [plans, setPlans] = useState<TradePlan[]>([])
  const [extraTargets, setExtraTargets] = useState<ExtraTarget[]>([])
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [deriveSellPrice, setDeriveSellPrice] = useState(false)
  const [preview, setPreview] = useState<ParseResult | null>(null)
  const [basename, setBasename] = useState('—')
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [activeAccountId, setActiveAccountId] = useState('all')
  const [systemFont, setSystemFontState] = useState(false)
  const [ordersSession, setOrdersSession] = useState<OrdersSession>(loadOrdersSession)
  const patchOrdersSession = useCallback(
    (p: Partial<OrdersSession>) => setOrdersSession((s) => ({ ...s, ...p })),
    [],
  )
  // 会话级持久化：刷新/来回切页不清，关标签页由浏览器清
  useEffect(() => {
    try {
      sessionStorage.setItem(ORDERS_SESSION_KEY, JSON.stringify(ordersSession))
    } catch {
      // 隐私模式 / 存满：静默降级为内存态
    }
  }, [ordersSession])

  const reloadRecords = useCallback(async () => {
    const [r, a, x, pl, et] = await Promise.all([
      db.records.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
      db.plans.toArray(),
      db.extraTargets.toArray(),
    ])
    setRecords(r)
    setAudits(a)
    setExecutions(x)
    setPlans(pl)
    setExtraTargets(et)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      await db.open()
      if ((await db.stocks.count()) === 0) {
        await db.stocks.bulkPut(DEFAULT_STOCKS)
      }
      // 默认账户兜底
      if ((await db.accounts.count()) === 0) {
        await db.accounts.put({ id: DEFAULT_ACCOUNT_ID, name: '默认账户', createdAt: Date.now() })
      }
      const [sRaw, r, a, b, x, backupMeta, pl, et, accs, accMeta, fontMeta] = await Promise.all([
        db.stocks.toArray(),
        db.records.toArray(),
        db.auditLogs.toArray(),
        db.batches.orderBy('importedAt').reverse().toArray(),
        db.rebuyExecutions.toArray(),
        db.meta.get('lastBackupAt'),
        db.plans.toArray(),
        db.extraTargets.toArray(),
        db.accounts.toArray(),
        db.meta.get('activeAccountId'),
        db.meta.get('useSystemFont'),
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
      setPlans(pl)
      setExtraTargets(et)
      setBatches(b)
      setBasename(b[0]?.fileName ?? '—')
      setLastBackupAt(backupMeta ? Number(backupMeta.value) : null)
      setAccounts(accs)
      setActiveAccountId(accMeta?.value ?? 'all')
      const fontOn = fontMeta?.value === '1'
      setSystemFontState(fontOn)
      if (fontOn) applySystemFont(true)
      setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  // 账户筛选只影响展示与清单；不影响原始数据
  const scopedRecords = useMemo(() => filterByAccount(records, activeAccountId), [records, activeAccountId])

  const ledger = useMemo(
    () => buildLedger(scopedRecords, stocks, { deriveSellPrice, executions, plans, extraTargets }),
    [scopedRecords, stocks, deriveSellPrice, executions, plans, extraTargets],
  )

  const baseline = useMemo(() => compareBaseline(ledger), [ledger])

  const commitImport = useCallback(
    async (p: ParseResult, fileName: string): Promise<ImportOutcome> => {
      const existing = new Set((await db.records.toArray()).map((r) => r.importKey))
      const batchId = `batch:${Date.now()}`
      const fresh = p.records
        .filter((r) => !existing.has(r.importKey))
        .map((r) => ({
          ...r,
          origin: 'excel' as const,
          batchId,
          accountId: activeAccountId === 'all' ? DEFAULT_ACCOUNT_ID : activeAccountId,
        }))
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
    [reloadRecords, activeAccountId],
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
      const cfg = stocks.find((s) => s.name === input.stockName)
      const { record, errors } = buildManualRecord(input, sourceRow, {
        intervalCents: cfg?.intervalCents ?? 0,
      })
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
    [reloadRecords, stocks],
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

  const setPlan = useCallback(
    async (kind: 'buy' | 'sell', refId: string, priceCents: number, qty: number) => {
      if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('计划价不合法')
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('计划量不合法')
      await db.plans.put({ id: `plan:${refId}`, kind, refId, priceCents, qty, at: Date.now() })
      setPlans(await db.plans.toArray())
    },
    [],
  )

  const clearPlan = useCallback(async (refId: string) => {
    await db.plans.delete(`plan:${refId}`)
    setPlans(await db.plans.toArray())
  }, [])

  const addExtraTarget = useCallback(
    async (lotId: string, priceCents: number, qty: number) => {
      if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('目标价不合法')
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('目标股数不合法')
      await db.extraTargets.put({
        id: `et:${lotId}:${Date.now()}`,
        lotId,
        priceCents,
        qty,
        at: Date.now(),
      })
      setExtraTargets(await db.extraTargets.toArray())
    },
    [],
  )

  const removeExtraTarget = useCallback(async (id: string) => {
    await db.extraTargets.delete(id)
    setExtraTargets(await db.extraTargets.toArray())
  }, [])

  const setActiveAccount = useCallback(async (id: string) => {
    await db.meta.put({ key: 'activeAccountId', value: id })
    setActiveAccountId(id)
  }, [])

  const addAccount = useCallback(async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('账户名不能为空')
    await db.accounts.put({ id: `acc:${Date.now()}`, name: trimmed, createdAt: Date.now() })
    setAccounts(await db.accounts.toArray())
  }, [])

  const setSystemFont = useCallback(async (v: boolean) => {
    await db.meta.put({ key: 'useSystemFont', value: v ? '1' : '0' })
    setSystemFontState(v)
    applySystemFont(v)
  }, [])

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
      db.plans.clear(),
      db.extraTargets.clear(),
    ])
    setRecords([])
    setBatches([])
    setAudits([])
    setExecutions([])
    setPlans([])
    setExtraTargets([])
    setBasename('—')
    setPreview(null)
  }, [])

  const exportBackup = useCallback(async () => {
    const [s, r, b, a, x, pl, et, accs] = await Promise.all([
      db.stocks.toArray(),
      db.records.toArray(),
      db.batches.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
      db.plans.toArray(),
      db.extraTargets.toArray(),
      db.accounts.toArray(),
    ])
    const stamp = String(Date.now())
    await db.meta.put({ key: 'lastBackupAt', value: stamp })
    setLastBackupAt(Number(stamp))
    return JSON.stringify(
      {
        schemaVersion: 5,
        exportedAt: new Date().toISOString(),
        stocks: s,
        records: r,
        batches: b,
        auditLogs: a,
        rebuyExecutions: x,
        plans: pl,
        extraTargets: et,
        accounts: accs,
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
        plans?: TradePlan[]
        extraTargets?: ExtraTarget[]
        accounts?: Account[]
      }
      const version = data.schemaVersion ?? 1
      if (version > 5) throw new Error('备份版本高于当前程序，拒绝导入（P11）')
      // P11 之外的第二道闸：结构坏掉的备份整包拒绝，不让半截 JSON 污染本地库
      const problem = validateBackup(data)
      if (problem) throw new Error(`备份内容校验失败：${problem}`)
      await db.transaction(
        'rw',
        [db.stocks, db.records, db.batches, db.auditLogs, db.rebuyExecutions, db.plans, db.extraTargets, db.accounts],
        async () => {
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
        if (data.accounts) {
          await db.accounts.clear()
          await db.accounts.bulkPut(data.accounts)
        }
        await db.plans.clear()
        if (data.plans) await db.plans.bulkPut(data.plans)
        await db.extraTargets.clear()
        if (data.extraTargets) await db.extraTargets.bulkPut(data.extraTargets)
        // 回补成交与计划/拆分目标同级的派生输入：恢复时同样整表替换，
        // 否则旧库里残留的成交会污染恢复后的净持仓与奖励预算
        await db.rebuyExecutions.clear()
        if (data.rebuyExecutions) await db.rebuyExecutions.bulkPut(data.rebuyExecutions)
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
        },
      )
      setStocks(await db.stocks.toArray())
      setAccounts(await db.accounts.toArray())
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
    setPlan,
    clearPlan,
    addExtraTarget,
    removeExtraTarget,
    plans,
    extraTargets,
    historyOf,
    updateStock,
    addStock,
    removeStock,
    resetAll,
    exportBackup,
    restoreBackup,
    basename,
    lastBackupAt,
    activeAccountId,
    accounts,
    scopedRecords,
    setActiveAccount,
    addAccount,
    systemFont,
    ordersSession,
    patchOrdersSession,
    setSystemFont,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}

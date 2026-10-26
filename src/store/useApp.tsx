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
import { buildRecordNoIndex, type RecordNoIndex } from '../domain/recordNo'
import { compareBaseline } from '../domain/baseline'
import { DEFAULT_STOCKS } from '../domain/defaults'
import { applyEdits, type EditableKey } from '../domain/edit'
import { applyOrder, normalizeStocks } from '../domain/stocks'
import { buildManualRecord, MANUAL_ROW_BASE, type ManualInput } from '../domain/manual'
import {
  EMPTY_SANDBOX,
  makeSandboxItem,
  nextSandboxSeq,
  sandboxBuyInput,
  sandboxRowOf,
  sandboxSellInput,
  sandboxRecords as buildSandboxRecords,
  type SandboxDraft,
  type SandboxState,
} from '../domain/sandbox'
import { importDiffFields, IMPORT_FIELD_LABEL, importFieldValue, planImport } from '../domain/importPlan'
import { validateBackup } from '../domain/backup'
import type {
  AuditLog,
  CheckResult,
  ExtraTarget,
  HedgeLink,
  Ledger,
  LotMergeLink,
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
  /** 按行身份匹配到的本地行更新数（v9.20 决策 C） */
  updated: number
  batch: ImportBatch
}

/**
 * 挂单页的昨收状态（V9.10 起；V9.28 改持久）：全部按股票记——昨收输入、已确认
 * 昨收、手工涨跌停、当前选中的股票。V9.28 用户拍板：昨收不再随会话消失，改存
 * localStorage 跨会话保留（输入框自带 onClear 可一键清掉重填）；仍不落台账库/备份
 * ——昨收是行情信息，不该进数据备份。
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

/** 从 localStorage 恢复（V9.28 起跨会话保留；结构坏掉就当空会话） */
function loadOrdersSession(): OrdersSession {
  try {
    const raw = localStorage.getItem(ORDERS_SESSION_KEY)
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
  /** 先卖后买挂钩（V9.26）：裸卖 → 高位批次的人工分配 */
  hedges: HedgeLink[]
  /** 合并同价买单（V9.45）：只影响挂单页的合并显示，records 不改 */
  merges: LotMergeLink[]
  ledger: Ledger
  /** 界面行身份（V9.43）：按录入顺序派生的「第 N 笔」，Excel 行号退成追溯信息 */
  recordNo: RecordNoIndex
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
  /** 保存/替换一条裸卖的挂钩分配（合计应等于卖单股数，buildLedger 里还会再校验） */
  setHedgeLink: (sellRow: number, items: { row: number; qty: number }[]) => Promise<void>
  clearHedgeLink: (sellRow: number) => Promise<void>
  /** 保存一条同价买单合并（≥2 笔同股同买入价的真实行；自动从旧组里摘出来） */
  setLotMerge: (rows: number[]) => Promise<void>
  clearLotMerge: (row: number) => Promise<void>
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
  systemFont: boolean
  setSystemFont: (v: boolean) => Promise<void>
  ordersSession: OrdersSession
  patchOrdersSession: (p: Partial<OrdersSession>) => void
  /** 沙盒模式（V9.39）：模拟待买/待卖 + 模拟挂钩，纯预览不落库 */
  sandbox: SandboxState
  /** 真实 + 模拟的预览账本；没有模拟条目时就是 ledger */
  sandboxLedger: Ledger
  /** 真实 + 模拟的 RawRecord（含 300000 段模拟行），沙盒挂钩面板要用 */
  sandboxPreviewRecords: RawRecord[]
  setSandboxActive: (active: boolean) => void
  addSandboxItem: (draft: SandboxDraft) => void
  removeSandboxItem: (id: string) => void
  setSandboxHedge: (sellRow: number, items: { row: number; qty: number }[]) => void
  clearSandboxHedge: (sellRow: number) => void
  /** 记为成交：模拟条目（连同它挂钩的模拟买入批次）写成真实 records */
  commitSandboxItem: (id: string) => Promise<{ row: number; committed: number } | null>
  clearSandbox: () => void
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

function audit(
  entityId: string,
  field: string,
  oldValue: string,
  newValue: string,
  source: string,
  entity: AuditLog['entity'] = 'record',
): AuditLog {
  return { entity, entityId, field, oldValue, newValue, at: Date.now(), source }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [stocks, setStocks] = useState<StockConfig[]>(DEFAULT_STOCKS)
  const [records, setRecords] = useState<RawRecord[]>([])
  const [audits, setAudits] = useState<AuditLog[]>([])
  const [executions, setExecutions] = useState<RebuyExecution[]>([])
  const [plans, setPlans] = useState<TradePlan[]>([])
  const [extraTargets, setExtraTargets] = useState<ExtraTarget[]>([])
  const [hedges, setHedges] = useState<HedgeLink[]>([])
  const [merges, setMerges] = useState<LotMergeLink[]>([])
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [deriveSellPrice, setDeriveSellPrice] = useState(false)
  const [preview, setPreview] = useState<ParseResult | null>(null)
  const [basename, setBasename] = useState('—')
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null)
  const [systemFont, setSystemFontState] = useState(false)
  const [ordersSession, setOrdersSession] = useState<OrdersSession>(loadOrdersSession)
  /** 沙盒只活在本次会话：切页保留、刷新清空，不写库也不进备份 */
  const [sandbox, setSandbox] = useState<SandboxState>(EMPTY_SANDBOX)
  const patchOrdersSession = useCallback(
    (p: Partial<OrdersSession>) => setOrdersSession((s) => ({ ...s, ...p })),
    [],
  )
  // 持久化到 localStorage（V9.28）：昨收跨会话保留，重开浏览器还在
  useEffect(() => {
    try {
      localStorage.setItem(ORDERS_SESSION_KEY, JSON.stringify(ordersSession))
    } catch {
      // 隐私模式 / 存满：静默降级为内存态
    }
  }, [ordersSession])

  const reloadRecords = useCallback(async () => {
    const [r, a, x, pl, et, hd, mg] = await Promise.all([
      db.records.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
      db.plans.toArray(),
      db.extraTargets.toArray(),
      db.hedges.toArray(),
      db.merges.toArray(),
    ])
    setRecords(r)
    setAudits(a)
    setExecutions(x)
    setPlans(pl)
    setExtraTargets(et)
    setHedges(hd)
    setMerges(mg)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      await db.open()
      if ((await db.stocks.count()) === 0) {
        await db.stocks.bulkPut(DEFAULT_STOCKS)
      }
      // 单一账户（V9.32：账户功能已删除）
      const [sRaw, r, a, b, x, backupMeta, pl, et, fontMeta, hd, mg] = await Promise.all([
        db.stocks.toArray(),
        db.records.toArray(),
        db.auditLogs.toArray(),
        db.batches.orderBy('importedAt').reverse().toArray(),
        db.rebuyExecutions.toArray(),
        db.meta.get('lastBackupAt'),
        db.plans.toArray(),
        db.extraTargets.toArray(),
        db.meta.get('useSystemFont'),
        db.hedges.toArray(),
        db.merges.toArray(),
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
      setHedges(hd)
      setMerges(mg)
      setBatches(b)
      setBasename(b[0]?.fileName ?? '—')
      setLastBackupAt(backupMeta ? Number(backupMeta.value) : null)
      const fontOn = fontMeta?.value === '1'
      setSystemFontState(fontOn)
      if (fontOn) applySystemFont(true)
      setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  const ledger = useMemo(
    () => buildLedger(records, stocks, { deriveSellPrice, executions, plans, extraTargets, hedges }),
    [records, stocks, deriveSellPrice, executions, plans, extraTargets, hedges],
  )

  const recordNo = useMemo(() => buildRecordNoIndex(records), [records])

  const baseline = useMemo(() => compareBaseline(ledger), [ledger])

  const sandboxPreviewRecords = useMemo(
    () => (sandbox.items.length ? [...records, ...buildSandboxRecords(sandbox.items)] : records),
    [records, sandbox.items],
  )

  // 沙盒预览：真实 records + 模拟行、真实挂钩 + 模拟挂钩，走同一套 buildLedger。
  // 没有模拟内容时直接复用 ledger，避免白算一遍。
  const sandboxLedger = useMemo(() => {
    if (sandbox.items.length === 0 && sandbox.hedges.length === 0) return ledger
    return buildLedger(sandboxPreviewRecords, stocks, {
      deriveSellPrice,
      executions,
      plans,
      extraTargets,
      hedges: sandbox.hedges.length ? [...hedges, ...sandbox.hedges] : hedges,
    })
  }, [
    ledger,
    sandboxPreviewRecords,
    sandbox.items.length,
    sandbox.hedges,
    stocks,
    deriveSellPrice,
    executions,
    plans,
    extraTargets,
    hedges,
  ])

  const commitImport = useCallback(
    async (p: ParseResult, fileName: string): Promise<ImportOutcome> => {
      const existing = await db.records.toArray()
      // v9.20 决策 C：同 key 跳过之外，再按行身份（股票+买入日期+买入价+份额）
      // 匹配更新卖出侧字段——Excel 改了已卖行重导，更新而不是并存新旧行
      const plan = planImport(existing, p.records)
      const batchId = `batch:${Date.now()}`
      const fresh = plan.fresh.map((r) => ({
        ...r,
        origin: 'excel' as const,
        batchId,
      }))
      const batch: ImportBatch = {
        id: batchId,
        fileName,
        sheetName: p.sheetName,
        importedAt: Date.now(),
        recordCount: p.records.length,
        addedCount: fresh.length,
        updatedCount: plan.updates.length,
      }
      await db.transaction('rw', db.records, db.batches, db.auditLogs, async () => {
        if (fresh.length) await db.records.bulkPut(fresh)
        for (const u of plan.updates) {
          const to = { ...u.to, editedAt: Date.now() }
          await db.records.put(to)
          await db.auditLogs.bulkAdd(
            importDiffFields(u.from, u.to).map((k) =>
              audit(
                `record:${to.sourceRow}`,
                IMPORT_FIELD_LABEL[k],
                importFieldValue(u.from, k),
                importFieldValue(to, k),
                'import-update',
              ),
            ),
          )
        }
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
      return { added: fresh.length, duplicated: plan.unchanged, updated: plan.updates.length, batch }
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

  /** 真正写一条手动记录（不刷新内存态）：沙盒「记为成交」要连写多条再用一次 reload */
  const createManualRecord = useCallback(
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
      return sourceRow
    },
    [stocks],
  )

  const addManualRecord = useCallback(
    async (input: ManualInput) => {
      const sourceRow = await createManualRecord(input)
      await reloadRecords()
      return sourceRow
    },
    [createManualRecord, reloadRecords],
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

  const setHedgeLink = useCallback(
    async (sellRow: number, items: { row: number; qty: number }[]) => {
      for (const it of items) {
        if (!Number.isInteger(it.row) || !Number.isFinite(it.qty) || it.qty <= 0) {
          throw new Error('挂钩分配不合法（买入行号 / 股数）')
        }
      }
      const link: HedgeLink = { id: `hedge:${sellRow}`, sellRow, items, at: Date.now() }
      await db.transaction('rw', db.hedges, db.auditLogs, async () => {
        // V9.33：旧值写上一次的分配（改挂也能回溯），新值写这次的分配
        const prev = await db.hedges.get(`hedge:${sellRow}`)
        const fmt = (list: { row: number; qty: number }[]) =>
          list.length ? list.map((i) => `第${i.row}行×${i.qty}`).join(' + ') : '不挂'
        await db.hedges.put(link)
        await db.auditLogs.add(
          audit(`record:${sellRow}`, '挂钩分配', fmt(prev?.items ?? []), fmt(items), 'hedge'),
        )
      })
      setHedges(await db.hedges.toArray())
    },
    [],
  )

  const clearHedgeLink = useCallback(
    async (sellRow: number) => {
      const prev = await db.hedges.get(`hedge:${sellRow}`)
      await db.transaction('rw', db.hedges, db.auditLogs, async () => {
        await db.hedges.delete(`hedge:${sellRow}`)
        if (prev) {
          await db.auditLogs.add(
            audit(
              `record:${sellRow}`,
              '解除挂钩',
              prev.items.map((i) => `第${i.row}行×${i.qty}`).join(' + '),
              '',
              'hedge',
            ),
          )
        }
      })
      setHedges(await db.hedges.toArray())
    },
    [],
  )

  const setSandboxActive = useCallback((active: boolean) => {
    setSandbox((s) => ({ ...s, active }))
  }, [])

  // V9.45：同价未卖完批次的合并关联。只写 merges 表，records 一分不动。
  const setLotMerge = useCallback(async (rows: number[]) => {
    const picked = [...new Set(rows.filter((r) => Number.isInteger(r) && r > 0))]
    await db.transaction('rw', [db.records, db.merges, db.auditLogs], async () => {
      const recs = (await db.records.bulkGet(picked)).filter(
        (r): r is RawRecord => Boolean(r && !r.deletedAt && r.buyPriceCents !== null),
      )
      const first = recs[0]
      if (!first) throw new Error('没有可合并的批次')
      const members = recs.filter(
        (r) => r.stockName === first.stockName && r.buyPriceCents === first.buyPriceCents,
      )
      if (members.length < 2) throw new Error('至少要两笔同股票、同买入价且未删除的批次')
      const memberRows = new Set(members.map((r) => r.sourceRow))
      // 一笔只能在一个组里：先把选中的行从旧组摘出来，剩下不足两笔的旧组顺手删掉
      for (const m of await db.merges.toArray()) {
        if (!m.rows.some((r) => memberRows.has(r))) continue
        const rest = m.rows.filter((r) => !memberRows.has(r))
        if (rest.length >= 2) await db.merges.put({ ...m, rows: rest })
        else await db.merges.delete(m.id)
      }
      const anchor = [...members].sort(
        (a, b) =>
          (a.buyDateSerial ?? Number.POSITIVE_INFINITY) - (b.buyDateSerial ?? Number.POSITIVE_INFINITY) ||
          a.sourceRow - b.sourceRow,
      )[0]
      const link: LotMergeLink = {
        id: `merge:${anchor.sourceRow}`,
        stockName: first.stockName,
        priceCents: first.buyPriceCents as number,
        rows: [...memberRows].sort((a, b) => a - b),
        at: Date.now(),
      }
      await db.merges.put(link)
      await db.auditLogs.add(
        audit(link.id, '合并同价买单', '', link.rows.map((r) => `record:${r}`).join(','), 'merge', 'merge'),
      )
    })
    setMerges(await db.merges.toArray())
  }, [])

  const clearLotMerge = useCallback(async (row: number) => {
    const hit = (await db.merges.toArray()).find((m) => m.rows.includes(row))
    if (!hit) return
    await db.transaction('rw', db.merges, db.auditLogs, async () => {
      await db.merges.delete(hit.id)
      await db.auditLogs.add(
        audit(hit.id, '解除合并', hit.rows.map((r) => `record:${r}`).join(','), '', 'merge', 'merge'),
      )
    })
    setMerges(await db.merges.toArray())
  }, [])

  const addSandboxItem = useCallback((draft: SandboxDraft) => {
    setSandbox((s) => {
      const seq = nextSandboxSeq(s.items)
      return { ...s, active: true, items: [...s.items, makeSandboxItem(draft, seq)] }
    })
  }, [])

  const removeSandboxItem = useCallback((id: string) => {
    setSandbox((s) => {
      const item = s.items.find((i) => i.id === id)
      if (!item) return s
      const row = sandboxRowOf(item)
      return {
        ...s,
        items: s.items.filter((i) => i.id !== id),
        hedges: s.hedges
          .filter((h) => h.sellRow !== row)
          .map((h) => ({ ...h, items: h.items.filter((i) => i.row !== row) }))
          .filter((h) => h.items.length > 0),
      }
    })
  }, [])

  const setSandboxHedge = useCallback(
    (sellRow: number, items: { row: number; qty: number }[]) => {
      for (const it of items) {
        if (!Number.isInteger(it.row) || !Number.isFinite(it.qty) || it.qty <= 0) {
          throw new Error('模拟挂钩分配不合法（行号 / 股数）')
        }
      }
      setSandbox((s) => {
        const rest = s.hedges.filter((h) => h.sellRow !== sellRow)
        if (items.length === 0) return { ...s, hedges: rest }
        return {
          ...s,
          hedges: [...rest, { id: `sandbox-hedge:${sellRow}`, sellRow, items, at: Date.now() }],
        }
      })
    },
    [],
  )

  const clearSandboxHedge = useCallback((sellRow: number) => {
    setSandbox((s) => ({ ...s, hedges: s.hedges.filter((h) => h.sellRow !== sellRow) }))
  }, [])

  const clearSandbox = useCallback(() => {
    setSandbox((s) => ({ ...s, items: [], hedges: [] }))
  }, [])

  const commitSandboxItem = useCallback(
    async (id: string): Promise<{ row: number; committed: number } | null> => {
      const item = sandbox.items.find((i) => i.id === id)
      if (!item) return null
      const itemRow = sandboxRowOf(item)
      const link = item.kind === 'sell' ? sandbox.hedges.find((h) => h.sellRow === itemRow) ?? null : null
      const committedIds = new Set<string>([item.id])
      const remap = new Map<number, number>()

      // 模拟挂钩指向的模拟买入批次先转正，否则挂钩没有真实批次可落
      for (const it of link?.items ?? []) {
        const dep = sandbox.items.find((x) => x.kind === 'buy' && sandboxRowOf(x) === it.row)
        if (dep && !committedIds.has(dep.id)) {
          const row = await createManualRecord(sandboxBuyInput(dep))
          remap.set(sandboxRowOf(dep), row)
          committedIds.add(dep.id)
        }
      }

      const newRow = await createManualRecord(
        item.kind === 'sell' ? sandboxSellInput(item) : sandboxBuyInput(item),
      )
      remap.set(itemRow, newRow)

      // 这笔模拟卖挂过的位置跟着转正；指向模拟批次的项已 remap 到新行
      if (link) {
        const items = link.items
          .filter(
            (i) =>
              remap.has(i.row) ||
              records.some((r) => r.sourceRow === i.row && !r.deletedAt),
          )
          .map((i) => ({ row: remap.get(i.row) ?? i.row, qty: i.qty }))
        if (items.length > 0) {
          const realLink: HedgeLink = {
            id: `hedge:${newRow}`,
            sellRow: newRow,
            items,
            at: Date.now(),
          }
          await db.transaction('rw', db.hedges, db.auditLogs, async () => {
            await db.hedges.put(realLink)
            await db.auditLogs.add(
              audit(
                `record:${newRow}`,
                '沙盒挂钩转正',
                '模拟挂钩',
                items.map((i) => `第${i.row}行×${i.qty}`).join(' + '),
                'hedge',
              ),
            )
          })
          // 直接写库也要把挂钩状态拉回内存，否则转正后这一笔要到刷新才生效
          setHedges(await db.hedges.toArray())
        }
      }

      await reloadRecords()
      setSandbox((s) => ({
        ...s,
        items: s.items.filter((x) => !committedIds.has(x.id)),
        hedges: s.hedges
          .filter((h) => h.sellRow !== itemRow)
          .map((h) => ({
            ...h,
            items: h.items.map((i) => ({ ...i, row: remap.get(i.row) ?? i.row })),
          }))
          .filter((h) => h.items.length > 0),
      }))
      return { row: newRow, committed: committedIds.size }
    },
    [sandbox, createManualRecord, records, reloadRecords],
  )

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
      db.hedges.clear(),
      db.merges.clear(),
    ])
    setRecords([])
    setBatches([])
    setAudits([])
    setExecutions([])
    setPlans([])
    setExtraTargets([])
    setHedges([])
    setMerges([])
    setSandbox(EMPTY_SANDBOX)
    setBasename('—')
    setPreview(null)
  }, [])

  const exportBackup = useCallback(async () => {
    const [s, r, b, a, x, pl, et, hd, mg] = await Promise.all([
      db.stocks.toArray(),
      db.records.toArray(),
      db.batches.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
      db.plans.toArray(),
      db.extraTargets.toArray(),
      db.hedges.toArray(),
      db.merges.toArray(),
    ])
    const stamp = String(Date.now())
    await db.meta.put({ key: 'lastBackupAt', value: stamp })
    setLastBackupAt(Number(stamp))
    return JSON.stringify(
      {
        // V9.45：加 merges（同价买单合并关联）→ 版本 8
        schemaVersion: 8,
        exportedAt: new Date().toISOString(),
        stocks: s,
        records: r,
        batches: b,
        auditLogs: a,
        rebuyExecutions: x,
        plans: pl,
        extraTargets: et,
        hedges: hd,
        merges: mg,
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
        hedges?: HedgeLink[]
        merges?: LotMergeLink[]
      }
      const version = data.schemaVersion ?? 1
      if (version > 8) throw new Error('备份版本高于当前程序，拒绝导入（P11）')
      // P11 之外的第二道闸：结构坏掉的备份整包拒绝，不让半截 JSON 污染本地库
      const problem = validateBackup(data)
      if (problem) throw new Error(`备份内容校验失败：${problem}`)
      await db.transaction(
        'rw',
        [db.stocks, db.records, db.batches, db.auditLogs, db.rebuyExecutions, db.plans, db.extraTargets, db.hedges, db.merges],
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
        await db.plans.clear()
        if (data.plans) await db.plans.bulkPut(data.plans)
        await db.extraTargets.clear()
        if (data.extraTargets) await db.extraTargets.bulkPut(data.extraTargets)
        // 回补成交与计划/拆分目标同级的派生输入：恢复时同样整表替换，
        // 否则旧库里残留的成交会污染恢复后的净持仓与奖励预算
        await db.rebuyExecutions.clear()
        if (data.rebuyExecutions) await db.rebuyExecutions.bulkPut(data.rebuyExecutions)
        // 挂钩分配同样整表替换（V9.26）
        await db.hedges.clear()
        if (data.hedges) await db.hedges.bulkPut(data.hedges)
        // V9.45：合并关联同样整表替换（老备份没有这段就清空）
        await db.merges.clear()
        if (data.merges) await db.merges.bulkPut(data.merges)
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
      setBatches(await db.batches.toArray())
      await reloadRecords()
      setSandbox(EMPTY_SANDBOX)
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
    recordNo,
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
    setHedgeLink,
    clearHedgeLink,
    setLotMerge,
    clearLotMerge,
    addExtraTarget,
    removeExtraTarget,
    plans,
    extraTargets,
    hedges,
    merges,
    historyOf,
    updateStock,
    addStock,
    removeStock,
    resetAll,
    exportBackup,
    restoreBackup,
    basename,
    lastBackupAt,
    systemFont,
    ordersSession,
    patchOrdersSession,
    setSystemFont,
    sandbox,
    sandboxLedger,
    sandboxPreviewRecords,
    setSandboxActive,
    addSandboxItem,
    removeSandboxItem,
    setSandboxHedge,
    clearSandboxHedge,
    commitSandboxItem,
    clearSandbox,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}

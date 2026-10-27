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
import { activeDependents, validateExecutionInput } from '../domain/dependencies'
import { buildNextRoundBuyRows } from '../domain/buyBoard'
import { consumedNextRounds, type BuySource } from '../domain/suggestions'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'
import { buildLedger } from '../domain/ledger'
import { buildRecordNoIndex, recordNoLabel, type RecordNoIndex } from '../domain/recordNo'
import { cleanupRowLinks } from '../domain/unlink'
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
  ExtraBuyTarget,
  HedgeLink,
  Ledger,
  LotMergeLink,
  RawRecord,
  RebuyExecution,
  RebuyOrder,
  RepairChainLink,
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

/**
 * 记成交 / 记卖出 / 撤销 / 回滚这类事务的表清单。
 * 事务体里会调 `currentLedger()` 把整个账本重建一遍（用于额度校验），Dexie 规定
 * **事务只能访问声明过的表**，少写一张就抛 `NotFoundError: objectStore was not found`
 * （V9.53 修：加了 buyTargets 表却没同步这三个事务）。以后再加派生输入表，这里必须同步。
 */
const LEDGER_TX_TABLES = () => [
  db.records,
  db.stocks,
  db.rebuyExecutions,
  db.hedges,
  db.extraTargets,
  db.chainLinks,
  db.buyTargets,
  db.auditLogs,
]

/** `sell:12` → 12；合成卖出（sell:hedged:* / sell:closed:*）与沙盒行认不出 → null */
function sellRowOfExecId(id: string): number | null {
  const m = /^sell:(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
}

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
  /** 卖单拆多笔买入（V9.50）：只影响挂单展示与记成交取价，账务仍走 orders */
  buyTargets: ExtraBuyTarget[]
  /** 先卖后买挂钩（V9.26）：裸卖 → 高位批次的人工分配 */
  hedges: HedgeLink[]
  /** 合并同价买单（V9.45）：只影响挂单页的合并显示，records 不改 */
  merges: LotMergeLink[]
  /** 回本链归属（V9.46）：锚点行 + 后续归属的真实买出行；盈亏仍纯派生 */
  chainLinks: RepairChainLink[]
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
  recordLotSales: (sources: {lotId:string;qty:number}[], qty:number, priceCents:number, date:string) => Promise<void>
  recordBuySuggestion: (sources: BuySource[], qty:number, priceCents:number, date:string) => Promise<void>
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
  /** 回本链归属（V9.46）：把若干真实买出行挂到锚点链上（自动从别的链摘出来；空 = 解除） */
  setChainMembers: (anchorRow: number, memberRows: number[]) => Promise<void>
  /** 把某一行请出所属链（锚点本身 → 整条归属关系作废） */
  removeFromChain: (row: number) => Promise<void>
  /** 人为结束这条链（保留全部历史；之后再开新的独立交易） */
  closeRepairChain: (anchorRow: number) => Promise<void>
  reopenRepairChain: (anchorRow: number) => Promise<void>
  addExtraTarget: (lotId: string, priceCents: number, qty: number) => Promise<void>
  removeExtraTarget: (id: string) => Promise<void>
  /** V9.50 卖单拆买：给一笔先卖后买拆出一档买入（超欠量由 ledger 截断） */
  addBuyTarget: (sellRow: number, priceCents: number, qty: number) => Promise<void>
  removeBuyTarget: (id: string) => Promise<void>
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
  const [buyTargets, setBuyTargets] = useState<ExtraBuyTarget[]>([])
  const [hedges, setHedges] = useState<HedgeLink[]>([])
  const [merges, setMerges] = useState<LotMergeLink[]>([])
  const [chainLinks, setChainLinks] = useState<RepairChainLink[]>([])
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
    const [r, a, x, pl, et, hd, mg, cl, bt] = await Promise.all([
      db.records.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
      db.plans.toArray(),
      db.extraTargets.toArray(),
      db.hedges.toArray(),
      db.merges.toArray(),
      db.chainLinks.toArray(),
      db.buyTargets.toArray(),
    ])
    setRecords(r)
    setAudits(a)
    setExecutions(x)
    setPlans(pl)
    setExtraTargets(et)
    setHedges(hd)
    setMerges(mg)
    setChainLinks(cl)
    setBuyTargets(bt)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      await db.open()
      if ((await db.stocks.count()) === 0) {
        await db.stocks.bulkPut(DEFAULT_STOCKS)
      }
      // 单一账户（V9.32：账户功能已删除）
      const [sRaw, r, a, b, x, backupMeta, pl, et, fontMeta, hd, mg, cl, bt] = await Promise.all([
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
        db.chainLinks.toArray(),
        db.buyTargets.toArray(),
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
      setChainLinks(cl)
      setBuyTargets(bt)
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
    () =>
      buildLedger(records, stocks, { deriveSellPrice, executions, plans, extraTargets, buyTargets, hedges, chainLinks }),
    [records, stocks, deriveSellPrice, executions, plans, extraTargets, buyTargets, hedges, chainLinks],
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
      buyTargets,
      hedges: sandbox.hedges.length ? [...hedges.filter((h) => !sandbox.hedges.some((x) => x.sellRow === h.sellRow)), ...sandbox.hedges] : hedges,
      chainLinks,
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
    buyTargets,
    hedges,
    chainLinks,
  ])

  const commitImport = useCallback(
    async (p: ParseResult, fileName: string): Promise<ImportOutcome> => {
      const existing = await db.records.toArray()
      // v9.20 决策 C：同 key 跳过之外，再按行身份（股票+买入日期+买入价+份额）
      // 匹配更新卖出侧字段——Excel 改了已卖行重导，更新而不是并存新旧行
      const plan = planImport(existing, p.records)
      const execs=await db.rebuyExecutions.toArray()
      for(const u of plan.updates){
        if(activeDependents(u.from.sourceRow,existing,execs).length>0)throw new Error('导入将更改已有后续成交的记录，请先撤销后续成交再同步')
        const done=execs.filter((e)=>e.sellExecId===`sell:${u.from.sourceRow}`)
        if(done.length>0 && ((u.to.soldQty??0)<done.reduce((a,e)=>a+e.qty-e.rewardQty,0) || u.to.earlyBuyPriceCents===null))throw new Error('导入将减少已回补订单的卖出量或清空回补价，请先核对成交')
      }
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
      const all=await db.records.toArray()
      const rows = all.filter((r) => r.batchId === batchId)
      const rowSet = new Set(rows.map((r) => r.sourceRow))
      const execs=await db.rebuyExecutions.toArray()
      if(rows.some((r)=>activeDependents(r.sourceRow,all,execs).some((child)=>!rows.some((v)=>v.sourceRow===child.sourceRow))))throw new Error('这批导入已有后续卖出，请先撤销后续成交')
      /**
       * V9.56：这批上已经记过回补成交 / 卖出的，先撤销——回滚会把成交变成指向不存在行的孤儿，
       * 界面看不出问题，但备份里全是野引用。
       */
      const batchExecs = execs.filter((e) => rowSet.has(sellRowOfExecId(e.sellExecId) ?? -1))
      if (batchExecs.length) throw new Error(`这批里还有 ${batchExecs.length} 笔回补成交，先在挂单页撤销再回滚`)
      let cleaned: ReturnType<typeof cleanupRowLinks> | null = null
      await db.transaction(
        'rw',
        [db.records, db.batches, db.auditLogs, db.hedges, db.buyTargets, db.extraTargets, db.merges, db.chainLinks, db.plans],
        async () => {
          /**
           * V9.56：行号会被下一次导入复用（importPlan 见空就用 Excel 行号），所以指向这些行的
           * 挂钩 / 拆分档 / 合并组 / 归属 / 计划价必须一起清掉，否则旧关联静默套到另一笔交易上。
           */
          cleaned = cleanupRowLinks(rowSet, {
            hedges: await db.hedges.toArray(),
            buyTargets: await db.buyTargets.toArray(),
            extraTargets: await db.extraTargets.toArray(),
            merges: await db.merges.toArray(),
            chainLinks: await db.chainLinks.toArray(),
            plans: await db.plans.toArray(),
          })
          if (cleaned.changed.hedges) {
            await db.hedges.clear()
            if (cleaned.hedges.length) await db.hedges.bulkPut(cleaned.hedges)
          }
          if (cleaned.changed.buyTargets) {
            await db.buyTargets.clear()
            if (cleaned.buyTargets.length) await db.buyTargets.bulkPut(cleaned.buyTargets)
          }
          if (cleaned.changed.extraTargets) {
            await db.extraTargets.clear()
            if (cleaned.extraTargets.length) await db.extraTargets.bulkPut(cleaned.extraTargets)
          }
          if (cleaned.changed.merges) {
            await db.merges.clear()
            if (cleaned.merges.length) await db.merges.bulkPut(cleaned.merges)
          }
          if (cleaned.changed.chainLinks) {
            await db.chainLinks.clear()
            if (cleaned.chainLinks.length) await db.chainLinks.bulkPut(cleaned.chainLinks)
          }
          if (cleaned.changed.plans) {
            await db.plans.clear()
            if (cleaned.plans.length) await db.plans.bulkPut(cleaned.plans)
          }
          await db.records.bulkDelete(rows.map((r) => r.sourceRow))
          await db.batches.delete(batchId)
          if (rows.length) {
            await db.auditLogs.bulkAdd(
              rows.map((r) => audit(`record:${r.sourceRow}`, '回滚导入', `第 ${r.sourceRow} 行`, '已移除', 'rollback')),
            )
          }
          if (cleaned.changed.hedges + cleaned.changed.buyTargets + cleaned.changed.extraTargets + cleaned.changed.merges + cleaned.changed.chainLinks + cleaned.changed.plans > 0) {
            const parts = [
              cleaned.changed.hedges ? `挂钩 ${cleaned.changed.hedges}` : '',
              cleaned.changed.buyTargets ? `拆分买入 ${cleaned.changed.buyTargets}` : '',
              cleaned.changed.extraTargets ? `拆分卖出 ${cleaned.changed.extraTargets}` : '',
              cleaned.changed.merges ? `同价合并 ${cleaned.changed.merges}` : '',
              cleaned.changed.chainLinks ? `回本链归属 ${cleaned.changed.chainLinks}` : '',
              cleaned.changed.plans ? `计划价 ${cleaned.changed.plans}` : '',
            ].filter(Boolean)
            await db.auditLogs.add(
              audit(`batch:${batchId}`, '回滚导入', '关联', `一并清理：${parts.join(' · ')}${cleaned.hedgeQty ? `（挂钩 ${cleaned.hedgeQty} 股）` : ''}`, 'rollback'),
            )
          }
        },
      )
      await reloadRecords()
      const left = await db.batches.orderBy('importedAt').reverse().toArray()
      setBatches(left)
      setBasename(left[0]?.fileName ?? '—')
      return rows.length
    },
    [reloadRecords],
  )

  const currentLedger = useCallback(async () => {
    const [r,s,x,hd,et,cl,bt]=await Promise.all([db.records.toArray(),db.stocks.toArray(),db.rebuyExecutions.toArray(),db.hedges.toArray(),db.extraTargets.toArray(),db.chainLinks.toArray(),db.buyTargets.toArray()])
    return { records:r, ledger:buildLedger(r,s,{executions:x,hedges:hd,extraTargets:et,buyTargets:bt,chainLinks:cl}) }
  }, [])

  const editRecord = useCallback(
    async (sourceRow: number, draft: Partial<Record<EditableKey, string>>) => {
      const current = await db.records.get(sourceRow)
      if (!current) throw new Error(`找不到第 ${sourceRow} 行`)
      const { record, changes, errors } = applyEdits(current, draft)
      if (current.soldLotId && changes.some((c)=>['buyPrice','buyQty','buyDate'].includes(c.field))) throw new Error('关联卖出的买入成本来自原批次，请在原批次更正')
      if (current.buyPriceCents===null && record.buyPriceCents!==null &&
        ((await db.rebuyExecutions.where('sellExecId').equals(`sell:${sourceRow}`).count())>0 || await db.hedges.get(`hedge:${sourceRow}`))) {
        throw new Error('此笔已有回补成交或高位挂钩，请用挂单页记回补成交；不能重复补买入改写原成本')
      }
      if (errors.length) throw new Error(errors.join('；'))
      const savedExecs=await db.rebuyExecutions.where('sellExecId').equals(`sell:${sourceRow}`).toArray()
      if(savedExecs.length>0 && ((record.soldQty??0)<savedExecs.reduce((a,e)=>a+e.qty-e.rewardQty,0) || record.earlyBuyPriceCents===null))throw new Error('已有回补成交，不能减少卖出量至已回补量以下或清除回补价；请先撤销回补')
      if(current.soldLotId && changes.some((c)=>c.field==='soldQty')){
        const state=await currentLedger()
        const lot=state.ledger.lots.find((l)=>l.id===current.soldLotId)
        if(!lot || (record.soldQty??0)>lot.remainingQty+(current.soldQty??0))throw new Error('卖出数量超过来源批次可用量')
      }
      if(activeDependents(sourceRow,await db.records.toArray(),await db.rebuyExecutions.toArray()).length>0 && changes.some((c)=>['buyPrice','buyQty','buyDate','soldQty','earlyBuyPrice'].includes(c.field))) {
        throw new Error('这笔已有后续成交，请先撤销后续成交再更正数量或买入信息')
      }
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
    [reloadRecords,currentLedger],
  )

  const softDelete = useCallback(
    async (sourceRow: number) => {
      const current = await db.records.get(sourceRow)
      if (!current) return
      const allRows = await db.records.toArray()
      if(activeDependents(sourceRow,allRows,await db.rebuyExecutions.toArray()).length>0)throw new Error('这笔交易已有后续卖出，请先撤销后续成交')
      /**
       * V9.56：这一行正被裸卖挂钩占着股数时不许删。挂账是**会计输入**（批次暂记卖出、
       * 裸卖盈利暂缓、敞口归零），行一删 buildLedger 里 `lotByRow.get(it.row)` 找不到就直接
       * `continue`，挂账凭空消失、盈利从「暂缓」变回按 P 列结算——账面静默变，用户完全察觉不到。
       * 和「先撤销后续成交」一个道理：先把依赖解掉。
       */
      const hedgeHit = (await currentLedger()).ledger.effectiveHedges.find((h) => h.items.some((it) => it.row === sourceRow))
      if (hedgeHit) {
        const held = hedgeHit.items.filter((it) => it.row === sourceRow).reduce((a, it) => a + it.qty, 0)
        const label = recordNoLabel(hedgeHit.sellRow, buildRecordNoIndex(allRows))
        throw new Error(`这一行被「${label}」的裸卖挂钩占着 ${held} 股，先解除挂钩再删`)
      }
      await db.transaction('rw', db.records, db.auditLogs, async () => {
        await db.records.put({ ...current, deletedAt: Date.now() })
        await db.auditLogs.add(audit(`record:${sourceRow}`, '软删除', '有效', '已删除', 'delete'))
      })
      await reloadRecords()
    },
    [reloadRecords, currentLedger],
  )

  const restore = useCallback(
    async (sourceRow: number) => {
      const current = await db.records.get(sourceRow)
      if (!current) return
      if(current.soldLotId){
        const state=await currentLedger()
        const lot=state.ledger.lots.find((l)=>l.id===current.soldLotId)
        if(!lot || lot.remainingQty<(current.soldQty??0))throw new Error('来源批次不存在或剩余不足，不能恢复这笔卖出')
      }
      if(current.nextRoundOfRow!==undefined){
        const state=await currentLedger()
        const next=buildNextRoundBuyRows({...state.ledger,merges:[],consumed:consumedNextRounds(state.records)})
        if((next.find((n)=>n.rows.includes(current.nextRoundOfRow!))?.sourceQty?.[current.nextRoundOfRow]??0)<(current.buyQtyRaw??0))throw new Error('下一轮来源已被使用，不能重复恢复买入')
      }
      await db.transaction('rw', db.records, db.auditLogs, async () => {
        await db.records.put({ ...current, deletedAt: null })
        await db.auditLogs.add(audit(`record:${sourceRow}`, '软删除', '已删除', '有效', 'restore'))
      })
      await reloadRecords()
    },
    [reloadRecords,currentLedger],
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



  const recordLotSales = async (sources:{lotId:string;qty:number}[], qty:number, priceCents:number, date:string) => {
    if(!Number.isInteger(qty)||qty<=0||!Number.isInteger(priceCents)||priceCents<=0||isoToSerial(date)===null)throw new Error('成交数量、价格或日期不合法')
    await db.transaction('rw',LEDGER_TX_TABLES(),async()=>{
      const {records:r,ledger:l}=await currentLedger()
      const seen=new Set<string>()
      let left=qty
      let row=Math.max(MANUAL_ROW_BASE-1,...r.map((v)=>v.sourceRow))+1
      for(const source of sources) {
        if(left<=0)break
        if(seen.has(source.lotId))throw new Error('重复的成交来源')
        seen.add(source.lotId)
        const lot=l.lots.find((v)=>v.id===source.lotId)
        if(!lot || lot.remainingQty<source.qty)throw new Error('批次剩余已变化，请关闭弹窗后重试')
        const q=Math.min(left,source.qty)
        const result=buildManualRecord({kind:'sell',stockName:lot.stockName,date,price:String(priceCents/100),qty:String(q),rebuyPrice:String(lot.buyPriceCents/100)},row++,{intervalCents:0})
        if(result.errors.length)throw new Error(result.errors.join('；'))
        await db.records.add({...result.record,soldLotId:lot.id,buyPriceCents:lot.buyPriceCents,buyDateSerial:lot.buyDate?isoToSerial(lot.buyDate):null})
        await db.auditLogs.add(audit(`record:${result.record.sourceRow}`,'卖出成交','',`${lot.id} · ${q} 股 @ ${priceCents/100}`,'sell'))
        left-=q
      }
      if(left>0)throw new Error('成交数量超过可卖量')
    })
    await reloadRecords()
  }

  const recordBuySuggestion = async (sources:BuySource[],qty:number,priceCents:number,date:string) => {
    const serial=isoToSerial(date)
    if(!Number.isInteger(qty)||qty<=0||!Number.isInteger(priceCents)||priceCents<=0||serial===null)throw new Error('成交数量、价格或日期不合法')
    /**
     * V9.55 修：日期框认 `2026/1/5`、`2026.1.5`，但 `new Date('2026/1/5T12:00:00')` 是 Invalid
     * Date → `at: NaN` 落库 → 回补批次 buyDate 变 `NaN-NaN-NaN`，而且导出的备份里 NaN 经
     * JSON 变 null，恢复时会被 `validateBackup` 判「缺 at」整包拒绝（自己导的备份自己恢复不了）。
     * 统一先用 serialToIso 补零再拼时间，并兜一道有限性检查。
     */
    const dayIso=serialToIso(serial)
    const atNoon=dayIso===null?NaN:new Date(`${dayIso}T12:00:00`).getTime()
    if(!Number.isFinite(atNoon))throw new Error('成交日期不合法')
    await db.transaction('rw',LEDGER_TX_TABLES(),async()=>{
      const {records:r,ledger:l}=await currentLedger()
      const next=buildNextRoundBuyRows({...l,merges:[],consumed:consumedNextRounds(r)})
      let left=qty
      let row=Math.max(MANUAL_ROW_BASE-1,...r.map((v)=>v.sourceRow))+1
      const seen=new Set<string>()
      const timestamp=Date.now()
      for(const source of sources){
        if(left<=0)break
        const key=source.kind==='order'&&source.splitKey?source.splitKey:source.kind+':'+source.row
        if(seen.has(key))throw new Error('重复的买入来源')
        seen.add(key)
        if(source.kind==='order') {
          const o=l.orders.find((v)=>v.id===source.id)
          if(!o || o.remainingQty<source.qty)throw new Error('待买数量已变化，请关闭弹窗后重试')
          const q=Math.min(left,source.qty)
          const baseLeft=Math.max(0,o.baseQty-(o.execQty-o.doneRewardQty))
          const reward=Math.max(0,q-baseLeft)
          validateExecutionInput(q,priceCents,reward,o.remainingQty,Math.max(0,o.rewardQty-o.doneRewardQty))
          const e:RebuyExecution={id:`exec:${o.id}:${timestamp}:${row++}`,orderId:o.id,sellExecId:o.sellExecId,stockId:o.stockId,stockName:o.stockName,qty:q,priceCents,rewardQty:reward,groupKeyAtExecution:o.groupKey,at:atNoon}
          await db.rebuyExecutions.add(e)
          await db.auditLogs.add(audit(o.id,'记回补成交','',`${q} 股 @ ${priceCents/100}`,'rebuy','order'))
          left-=q
        } else {
          const n=next.find((v)=>v.rows.includes(source.row))
          const cap=n?.sourceQty?.[source.row]??0
          if(!n||cap<source.qty)throw new Error('下一轮建议数量已变化，请关闭弹窗后重试')
          const q=Math.min(left,source.qty)
          const result=buildManualRecord({kind:'buy',stockName:n.stockName,date,price:String(priceCents/100),qty:String(q)},row++)
          if(result.errors.length)throw new Error(result.errors.join('；'))
          await db.records.add({...result.record,nextRoundOfRow:source.row})
          const owner=l.repairChains.find((c)=>c.anchorRow===source.row || c.branches.some((b)=>b.row===source.row))
          if(owner && owner.closedByUserAt===null){
            const id=`chainlink:${owner.anchorRow}`
            const prev=await db.chainLinks.get(id)
            await db.chainLinks.put({id,anchorRow:owner.anchorRow,stockName:owner.stockName,memberRows:[...new Set([...(prev?.memberRows??[]),result.record.sourceRow])],closedAt:null,at:timestamp})
          }
          await db.auditLogs.add(audit(`record:${result.record.sourceRow}`,'下一轮买入','',`record:${source.row} · ${q} 股 @ ${priceCents/100}`,'buy'))
          left-=q
        }
      }
      if(left>0)throw new Error('成交数量超过建议数量')
    })
    await reloadRecords()
  }

  const recordRebuy = useCallback(
    async (order: RebuyOrder, qty: number, priceCents: number, rewardQty: number, note?: string) => {
      await db.transaction('rw',LEDGER_TX_TABLES(),async()=>{
        const {ledger:l}=await currentLedger()
        const fresh=l.orders.find((o)=>o.id===order.id)
        if(!fresh)throw new Error('待买单已变化，请刷新后重试')
        validateExecutionInput(qty,priceCents,rewardQty,fresh.remainingQty,Math.max(0,fresh.rewardQty-fresh.doneRewardQty))
        const exec:RebuyExecution={id:`exec:${fresh.id}:${crypto.randomUUID()}`,orderId:fresh.id,sellExecId:fresh.sellExecId,stockId:fresh.stockId,stockName:fresh.stockName,qty,priceCents,rewardQty,groupKeyAtExecution:fresh.groupKey,at:Date.now(),note}
        await db.rebuyExecutions.add(exec)
        await db.auditLogs.add(audit(fresh.id,'记回补成交',`已回补 ${fresh.execQty}`,`已回补 ${fresh.execQty+qty}（${qty} 股 @ ${(priceCents/100).toFixed(2)}）`,'rebuy','order'))
      })
      await reloadRecords()
    },
    [reloadRecords,currentLedger],
  )

  const removeRebuy = useCallback(
    async (id: string) => {
      await db.transaction('rw', db.records, db.rebuyExecutions, db.auditLogs, async () => {
        const exec = await db.rebuyExecutions.get(id)
        const children=(await db.records.toArray()).some((r)=>!r.deletedAt && r.soldLotId===`lot:exec:${id}`)
        if(children)throw new Error('该回补批次已有卖出，请先撤销后续卖出')
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

  /** V9.50 卖单拆买：给一笔先卖后买拆出一档买入（总量超出欠量时由 ledger 截断并标异常） */
  const addBuyTarget = useCallback(async (sellRow: number, priceCents: number, qty: number) => {
    if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('买入价不合法')
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('买入股数不合法')
    await db.buyTargets.put({
      id: `buytarget:${sellRow}:${Date.now()}`,
      sellRow,
      priceCents,
      qty,
      at: Date.now(),
    })
    setBuyTargets(await db.buyTargets.toArray())
  }, [])

  const removeBuyTarget = useCallback(async (id: string) => {
    await db.buyTargets.delete(id)
    setBuyTargets(await db.buyTargets.toArray())
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
      const prev = (await currentLedger()).ledger.effectiveHedges.find((h) => h.sellRow === sellRow)
      await db.transaction('rw', db.hedges, db.auditLogs, async () => {
        // 空关联是明确的人工解除，避免重算时又自动挂回最高价批次。
        await db.hedges.put({ id: `hedge:${sellRow}`, sellRow, items: [], at: Date.now() })
        await db.auditLogs.add(
            audit(
              `record:${sellRow}`,
              '解除挂钩',
              (prev?.items ?? []).map((i) => `第${i.row}行×${i.qty}`).join(' + '),
              '',
              'hedge',
            ),
        )
      })
      setHedges(await db.hedges.toArray())
    },
    [currentLedger],
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

  // V9.46：回本链归属。只写 chainLinks 表，records 一分不动——盈亏仍每次重算、纯派生。
  const upsertChainLink = useCallback(
    async (anchorRow: number, memberRows: number[], closedAt: number | null) => {
      const anchor = await db.records.get(anchorRow)
      if (!anchor || anchor.deletedAt) throw new Error('锚点行不存在或已删除')
      const link: RepairChainLink = {
        id: `chainlink:${anchorRow}`,
        anchorRow,
        stockName: anchor.stockName,
        memberRows,
        closedAt,
        at: Date.now(),
      }
      await db.chainLinks.put(link)
      return link
    },
    [],
  )

  const setChainMembers = useCallback(
    async (anchorRow: number, memberRows: number[]) => {
      const picked = [...new Set(memberRows.filter((r) => Number.isInteger(r) && r > 0 && r !== anchorRow))].sort(
        (a, b) => a - b,
      )
      await db.transaction('rw', [db.records, db.chainLinks, db.auditLogs], async () => {
        const prev = await db.chainLinks.get(`chainlink:${anchorRow}`)
        const all=await db.chainLinks.toArray()
        if(all.some((l)=>l.memberRows.includes(anchorRow)))throw new Error('链成员不能再作为另一条链的锚点')
        if(all.some((l)=>picked.includes(l.anchorRow) && l.memberRows.length>0))throw new Error('不能归入有后续交易的另一条链，请先解除其归属')
        // 一笔只归一条链：先把选中的行从别的链摘出来，空了且没结束的旧链顺手删掉
        for (const l of await db.chainLinks.toArray()) {
          if (l.anchorRow === anchorRow) continue
          if (!l.memberRows.some((r) => picked.includes(r))) continue
          const rest = l.memberRows.filter((r) => !picked.includes(r))
          if (rest.length > 0 || l.closedAt !== null) await db.chainLinks.put({ ...l, memberRows: rest })
          else await db.chainLinks.delete(l.id)
        }
        if (picked.length === 0 && (prev?.closedAt ?? null) === null) {
          await db.chainLinks.delete(`chainlink:${anchorRow}`)
        } else {
          await upsertChainLink(anchorRow, picked, prev?.closedAt ?? null)
        }
        const fmt = (rows: number[]) => (rows.length ? rows.map((r) => `record:${r}`).join(',') : '无')
        await db.auditLogs.add(
          audit(`chainlink:${anchorRow}`, '回本链归属', fmt(prev?.memberRows ?? []), fmt(picked), 'chain', 'chain'),
        )
      })
      setChainLinks(await db.chainLinks.toArray())
    },
    [upsertChainLink],
  )

  /** 把某一行请出所属链；请的是锚点 → 整条归属关系作废（成员各自回去 own 自己的账） */
  const removeFromChain = useCallback(
    async (row: number) => {
      const hit = (await db.chainLinks.toArray()).find((l) => l.anchorRow === row || l.memberRows.includes(row))
      if (!hit) return
      await db.transaction('rw', db.chainLinks, db.auditLogs, async () => {
        if (hit.anchorRow === row) {
          await db.chainLinks.delete(hit.id)
        } else {
          const rest = hit.memberRows.filter((r) => r !== row)
          if (rest.length === 0 && hit.closedAt === null) await db.chainLinks.delete(hit.id)
          else await db.chainLinks.put({ ...hit, memberRows: rest, at: Date.now() })
        }
        await db.auditLogs.add(audit(hit.id, '移出回本链', `record:${row}`, '', 'chain', 'chain'))
      })
      setChainLinks(await db.chainLinks.toArray())
    },
    [],
  )

  const closeRepairChain = useCallback(
    async (anchorRow: number) => {
      await db.transaction('rw', [db.records, db.chainLinks, db.auditLogs], async () => {
        const prev = await db.chainLinks.get(`chainlink:${anchorRow}`)
        await upsertChainLink(anchorRow, prev?.memberRows ?? [], Date.now())
        await db.auditLogs.add(audit(`chainlink:${anchorRow}`, '结束回本链', '进行中', '已结束', 'chain', 'chain'))
      })
      setChainLinks(await db.chainLinks.toArray())
    },
    [upsertChainLink],
  )

  const reopenRepairChain = useCallback(
    async (anchorRow: number) => {
      await db.transaction('rw', db.chainLinks, db.auditLogs, async () => {
        const prev = await db.chainLinks.get(`chainlink:${anchorRow}`)
        if (!prev) return
        if (prev.memberRows.length === 0) await db.chainLinks.delete(prev.id)
        else await db.chainLinks.put({ ...prev, closedAt: null, at: Date.now() })
        await db.auditLogs.add(audit(`chainlink:${prev.id}`, '重开回本链', '已结束', '进行中', 'chain', 'chain'))
      })
      setChainLinks(await db.chainLinks.toArray())
    },
    [],
  )

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
        return {
          ...s,
          hedges: [...rest, { id: `sandbox-hedge:${sellRow}`, sellRow, items, at: Date.now() }],
        }
      })
    },
    [],
  )

  const clearSandboxHedge = useCallback((sellRow: number) => {
    setSandbox((s) => ({ ...s, hedges: [...s.hedges.filter((h) => h.sellRow !== sellRow), { id: `sandbox-hedge:${sellRow}`, sellRow, items: [], at: Date.now() }] }))
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
      db.buyTargets.clear(),
      db.hedges.clear(),
      db.merges.clear(),
      db.chainLinks.clear(),
    ])
    setRecords([])
    setBatches([])
    setAudits([])
    setExecutions([])
    setPlans([])
    setExtraTargets([])
    setHedges([])
    setMerges([])
    setChainLinks([])
    // V9.57：清库时把拆分买入也清掉（原来只清表、忘了清内存，行号复用时旧档会静默套上）
    setBuyTargets([])
    setSandbox(EMPTY_SANDBOX)
    setBasename('—')
    setPreview(null)
  }, [])

  const exportBackup = useCallback(async () => {
    const [s, r, b, a, x, pl, et, hd, mg, cl, bt] = await Promise.all([
      db.stocks.toArray(),
      db.records.toArray(),
      db.batches.toArray(),
      db.auditLogs.toArray(),
      db.rebuyExecutions.toArray(),
      db.plans.toArray(),
      db.extraTargets.toArray(),
      db.hedges.toArray(),
      db.merges.toArray(),
      db.chainLinks.toArray(),
      db.buyTargets.toArray(),
    ])
    const stamp = String(Date.now())
    await db.meta.put({ key: 'lastBackupAt', value: stamp })
    setLastBackupAt(Number(stamp))
    return JSON.stringify(
      {
        // 版本 11：V9.50 加卖单拆买（buyTargets）；旧版本恢复时会丢掉这些分段。
        schemaVersion: 11,
        exportedAt: new Date().toISOString(),
        stocks: s,
        records: r,
        batches: b,
        auditLogs: a,
        rebuyExecutions: x,
        plans: pl,
        extraTargets: et,
        buyTargets: bt,
        hedges: hd,
        merges: mg,
        chainLinks: cl,
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
        buyTargets?: ExtraBuyTarget[]
        hedges?: HedgeLink[]
        merges?: LotMergeLink[]
        chainLinks?: RepairChainLink[]
      }
      const version = data.schemaVersion ?? 1
      if (version > 11) throw new Error('备份版本高于当前程序，拒绝导入（P11）')
      // P11 之外的第二道闸：结构坏掉的备份整包拒绝，不让半截 JSON 污染本地库
      const problem = validateBackup(data)
      if (problem) throw new Error(`备份内容校验失败：${problem}`)
      await db.transaction(
        'rw',
        [db.stocks, db.records, db.batches, db.auditLogs, db.rebuyExecutions, db.plans, db.extraTargets, db.hedges, db.merges, db.chainLinks, db.buyTargets],
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
        // V9.50：卖单拆买同样整表替换
        await db.buyTargets.clear()
        if (data.buyTargets) await db.buyTargets.bulkPut(data.buyTargets)
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
        // V9.46：回本链归属同样整表替换（老备份没有这段就清空）
        await db.chainLinks.clear()
        if (data.chainLinks) await db.chainLinks.bulkPut(data.chainLinks)
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
    recordLotSales,
    recordBuySuggestion,
    removeRebuy,
    setPlan,
    clearPlan,
    setHedgeLink,
    clearHedgeLink,
    setLotMerge,
    clearLotMerge,
    setChainMembers,
    removeFromChain,
    closeRepairChain,
    reopenRepairChain,
    addExtraTarget,
    removeExtraTarget,
    addBuyTarget,
    removeBuyTarget,
    plans,
    extraTargets,
    buyTargets,
    hedges,
    merges,
    chainLinks,
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

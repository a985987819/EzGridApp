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
import type { CheckResult, Ledger, RawRecord, StockConfig } from '../domain/types'
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
  ledger: Ledger
  baseline: CheckResult[]
  deriveSellPrice: boolean
  setDeriveSellPrice: (v: boolean) => void
  preview: ParseResult | null
  setPreview: (p: ParseResult | null) => void
  commitImport: (p: ParseResult, fileName: string) => Promise<ImportOutcome>
  updateStock: (s: StockConfig) => Promise<void>
  addStock: (s: StockConfig) => Promise<void>
  removeStock: (id: string) => Promise<void>
  resetAll: () => Promise<void>
  exportBackup: () => Promise<string>
  restoreBackup: (json: string) => Promise<void>
  basename: string
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [stocks, setStocks] = useState<StockConfig[]>(DEFAULT_STOCKS)
  const [records, setRecords] = useState<RawRecord[]>([])
  const [deriveSellPrice, setDeriveSellPrice] = useState(false)
  const [preview, setPreview] = useState<ParseResult | null>(null)
  const [basename, setBasename] = useState('—')

  useEffect(() => {
    let alive = true
    void (async () => {
      await db.open()
      if ((await db.stocks.count()) === 0) {
        await db.stocks.bulkPut(DEFAULT_STOCKS)
      }
      const [s, r, b] = await Promise.all([
        db.stocks.toArray(),
        db.records.toArray(),
        db.batches.orderBy('importedAt').reverse().first(),
      ])
      if (!alive) return
      setStocks(s.length ? s : DEFAULT_STOCKS)
      setRecords(r)
      setBasename(b?.fileName ?? '—')
      setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  const ledger = useMemo(
    () => buildLedger(records, stocks, { deriveSellPrice }),
    [records, stocks, deriveSellPrice],
  )

  const baseline = useMemo(() => compareBaseline(ledger), [ledger])

  const commitImport = useCallback(
    async (p: ParseResult, fileName: string): Promise<ImportOutcome> => {
      const existing = new Set((await db.records.toArray()).map((r) => r.importKey))
      const fresh = p.records.filter((r) => !existing.has(r.importKey))
      const duplicated = p.records.length - fresh.length
      if (fresh.length) await db.records.bulkPut(fresh)
      const batch: ImportBatch = {
        id: `batch:${Date.now()}`,
        fileName,
        sheetName: p.sheetName,
        importedAt: Date.now(),
        recordCount: p.records.length,
        addedCount: fresh.length,
      }
      await db.batches.put(batch)
      setRecords(await db.records.toArray())
      setBasename(fileName)
      return { added: fresh.length, duplicated, batch }
    },
    [],
  )

  const updateStock = useCallback(async (s: StockConfig) => {
    await db.stocks.put(s)
    setStocks(await db.stocks.toArray())
  }, [])

  const addStock = useCallback(async (s: StockConfig) => {
    await db.stocks.put(s)
    setStocks(await db.stocks.toArray())
  }, [])

  const removeStock = useCallback(async (id: string) => {
    await db.stocks.delete(id)
    setStocks(await db.stocks.toArray())
  }, [])

  const resetAll = useCallback(async () => {
    await Promise.all([db.records.clear(), db.batches.clear()])
    setRecords([])
    setBasename('—')
    setPreview(null)
  }, [])

  const exportBackup = useCallback(async () => {
    const [s, r, b] = await Promise.all([db.stocks.toArray(), db.records.toArray(), db.batches.toArray()])
    return JSON.stringify(
      { schemaVersion: 1, exportedAt: new Date().toISOString(), stocks: s, records: r, batches: b },
      null,
      2,
    )
  }, [])

  const restoreBackup = useCallback(async (json: string) => {
    const data = JSON.parse(json) as {
      schemaVersion?: number
      stocks?: StockConfig[]
      records?: RawRecord[]
      batches?: ImportBatch[]
    }
    if ((data.schemaVersion ?? 0) > 1) throw new Error('备份版本高于当前程序，拒绝导入（P11）')
    await db.transaction('rw', db.stocks, db.records, db.batches, async () => {
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
    })
    setStocks(await db.stocks.toArray())
    setRecords(await db.records.toArray())
  }, [])

  const value: AppContextValue = {
    ready,
    stocks,
    records,
    ledger,
    baseline,
    deriveSellPrice,
    setDeriveSellPrice,
    preview,
    setPreview,
    commitImport,
    updateStock,
    addStock,
    removeStock,
    resetAll,
    exportBackup,
    restoreBackup,
    basename,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}

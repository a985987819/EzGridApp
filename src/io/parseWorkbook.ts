/**
 * 导入解析：只读第 1 个工作表「交易记录」（D7）。
 * 只负责把单元格原始状态读出来（值 / 是否公式 / 是否无缓存值），
 * 规则派生全部留给 domain/ledger.ts，这样改间隔能立即重算。
 */

import { toCents } from '../domain/money'
import { makeImportKey } from '../domain/defaults'
import type { RawRecord } from '../domain/types'

type XlsxModule = typeof import('xlsx')
type WorkSheet = import('xlsx').WorkSheet
type CellObject = import('xlsx').CellObject

/**
 * SheetJS 动态导入：只有导入页真正解析文件时才下载这个 chunk（xlsx 约占主包一半体积）。
 * 模块级 XLSX 只在 parseWorkbook 内 await loadXlsx() 之后才会被触达，helpers 可以直接读。
 */
let XLSX: XlsxModule
let xlsxReady: Promise<XlsxModule> | null = null
function loadXlsx(): Promise<XlsxModule> {
  xlsxReady ??= import('xlsx').then((m) => {
    XLSX = m
    return m
  })
  return xlsxReady
}

export interface ParseResult {
  sheetName: string
  records: RawRecord[]
  skippedRows: number[]
  missingColumns: string[]
}

/**
 * 列名别名：中文原表 + 常见券商/英文导出（V7 模板兼容）。
 * 匹配时先找第一行（表头），命中第一个别名即用。
 */
const COL = {
  stock: ['股票', '证券名称', '证券代码', 'stock', 'symbol', 'ticker', 'security'],
  buyDate: ['日期', '买入日期', 'date', 'buy date', 'buyDate', 'trade date'],
  buyPrice: ['买入价', '买入价格', 'buy price', 'buyprice', 'cost', 'avg price'],
  buyQty: ['买入份额', '份额', '数量', 'shares', 'qty', 'quantity', 'buy qty'],
  target: ['目标售价', '目标价', 'target', 'target price', 'sell price'],
  soldQty: ['实现份数', '卖出数量', 'sold', 'sold qty', 'sold shares'],
  profit: ['实现盈利', '盈亏', 'profit', 'realized', 'realized pnl'],
  sellDate: ['卖出日期', 'sell date', 'sold date', 'close date'],
  earlyBuy: ['提前卖的买价', '回补价', '提前买价', 'rebuy', 'rebuy price', 'early buy price'],
} as const

type ColKey = keyof typeof COL

function rawCell(sheet: WorkSheet, r: number, c: number): CellObject | undefined {
  return sheet[XLSX.utils.encode_cell({ r, c })] as CellObject | undefined
}

/** 空单元格 / 只有公式没有缓存值 → SheetJS 给的 stub（t='z'，v=0） */
function isBlank(cell: CellObject | undefined): boolean {
  if (!cell) return true
  if (cell.t === 'z') return true
  return cell.v === undefined || cell.v === null || cell.v === ''
}

function cellText(sheet: WorkSheet, r: number, c: number): string {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return ''
  return String(cell!.v).trim()
}

/** 只有「真公式」才算公式；Excel 里损坏成 '=' 的一律当空 */
function cellFormula(sheet: WorkSheet, r: number, c: number): string | null {
  const cell = rawCell(sheet, r, c)
  if (!cell || typeof cell.f !== 'string') return null
  const f = cell.f.trim()
  if (f === '' || f === '=') return null
  return f
}

function numOrNull(sheet: WorkSheet, r: number, c: number): number | null {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return null
  if (typeof cell!.v === 'number') return Number.isFinite(cell!.v) ? cell!.v : null
  const s = String(cell!.v).trim().replace(/,/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function centsOrNull(sheet: WorkSheet, r: number, c: number): number | null {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return null
  return toCents(typeof cell!.v === 'number' ? cell!.v : String(cell!.v))
}

function resolveHeader(sheet: WorkSheet, aliases: readonly string[]): number | null {
  const range = XLSX.utils.decode_range(sheet['!ref'] as string)
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    if (aliases.includes(cellText(sheet, range.s.r, c))) return c
  }
  return null
}

export async function parseWorkbook(buffer: ArrayBuffer | Uint8Array): Promise<ParseResult> {
  await loadXlsx()
  // sheetStubs: 只有公式、没有缓存值的单元格也会保留（否则整格丢失）
  const wb = XLSX.read(buffer, {
    type: 'array',
    sheetStubs: true,
    cellFormula: true,
    cellNF: false,
    cellDates: false,
  })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('工作簿里没有任何工作表')
  const sheet = wb.Sheets[sheetName]
  if (!sheet || !sheet['!ref']) throw new Error('第 1 个工作表是空的')

  const idx = {} as Record<ColKey, number | null>
  for (const k of Object.keys(COL) as ColKey[]) {
    idx[k] = resolveHeader(sheet, COL[k])
  }
  const missingColumns = (Object.keys(COL) as ColKey[]).filter((k) => idx[k] === null && k !== 'profit')

  const range = XLSX.utils.decode_range(sheet['!ref'] as string)
  const records: RawRecord[] = []
  const skippedRows: number[] = []
  // 完全相同的两行（例如 R60/R61 都是「柳工 卖500 @8.58」）字段会撞 key，
  // 这里按出现次序加 #n，既保证行级唯一，又保证同一文件重复导入仍然幂等
  const keyCount = new Map<string, number>()

  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const sheetRow = r + 1
    const stockCol = idx.stock
    const stock = stockCol === null ? '' : cellText(sheet, r, stockCol)
    if (!stock || stock === '=' || stock.startsWith('=')) {
      skippedRows.push(sheetRow)
      continue
    }

    const buyPrice = idx.buyPrice === null ? null : centsOrNull(sheet, r, idx.buyPrice)
    const buyQtyRaw = idx.buyQty === null ? null : numOrNull(sheet, r, idx.buyQty)
    const targetRaw = idx.target === null ? null : centsOrNull(sheet, r, idx.target)
    const soldQty = idx.soldQty === null ? null : numOrNull(sheet, r, idx.soldQty)

    const qtyFormula = idx.buyQty === null ? null : cellFormula(sheet, r, idx.buyQty)
    const targetFormula = idx.target === null ? null : cellFormula(sheet, r, idx.target)

    // D 列：公式无缓存值 → 按 FLOOR(6000/买入价,100) 重算
    const qtyNeedsDerive = buyQtyRaw === null && qtyFormula !== null && /FLOOR/i.test(qtyFormula)
    // E 列：公式无缓存值 → 待卖目标价可按 买入价+间隔 重算（成交价另见 ledger 的开关）
    const targetNeedsDerive = targetRaw === null && targetFormula !== null && targetFormula.includes('+')

    if (buyPrice === null && buyQtyRaw === null && soldQty === null && targetRaw === null) {
      skippedRows.push(sheetRow)
      continue
    }

    const buyDateSerial = idx.buyDate === null ? null : numOrNull(sheet, r, idx.buyDate)
    const sellDateSerial = idx.sellDate === null ? null : numOrNull(sheet, r, idx.sellDate)
    // 日期格是 =TODAY() 公式、且文件里没存计算结果 → 标记出来，
    // 这类格子打开 Excel 会显示「当天」，不是真实成交日，不能拿来当数据
    const buyDateFormula = idx.buyDate === null ? null : cellFormula(sheet, r, idx.buyDate)
    const sellDateFormula = idx.sellDate === null ? null : cellFormula(sheet, r, idx.sellDate)
    const buyDateNeedsToday = buyDateSerial === null && buyDateFormula !== null && /TODAY\s*\(/i.test(buyDateFormula)
    const sellDateNeedsToday = sellDateSerial === null && sellDateFormula !== null && /TODAY\s*\(/i.test(sellDateFormula)
    const earlyBuyPriceCents = idx.earlyBuy === null ? null : centsOrNull(sheet, r, idx.earlyBuy)
    const rawProfitCents = idx.profit === null ? null : centsOrNull(sheet, r, idx.profit)

    const rec: RawRecord = {
      sourceRow: sheetRow,
      stockName: stock,
      buyDateSerial,
      buyPriceCents: buyPrice,
      buyQtyRaw,
      qtyNeedsDerive,
      targetPriceCents: targetRaw,
      targetNeedsDerive,
      soldQty,
      sellDateSerial,
      earlyBuyPriceCents,
      rawProfitCents,
      buyDateNeedsToday,
      sellDateNeedsToday,
      importKey: '',
    }
    const base = makeImportKey(rec)
    const n = (keyCount.get(base) ?? 0) + 1
    keyCount.set(base, n)
    rec.importKey = n === 1 ? base : `${base}#${n}`
    records.push(rec)
  }

  return { sheetName, records, skippedRows, missingColumns }
}

export async function parseWorkbookFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  return parseWorkbook(new Uint8Array(buf))
}

/**
 * 导入解析：只读第 1 个工作表「交易记录」（D7）。
 * 只负责把单元格原始状态读出来（值 / 是否公式 / 是否无缓存值），
 * 规则派生全部留给 domain/ledger.ts，这样改间隔能立即重算。
 */

import * as XLSX from 'xlsx'
import { toCents } from '../domain/money'
import { makeImportKey } from '../domain/defaults'
import type { RawRecord } from '../domain/types'

export interface ParseResult {
  sheetName: string
  records: RawRecord[]
  skippedRows: number[]
  missingColumns: string[]
}

const COL = {
  stock: ['股票'],
  buyDate: ['日期', '买入日期'],
  buyPrice: ['买入价'],
  buyQty: ['买入份额'],
  target: ['目标售价'],
  soldQty: ['实现份数'],
  profit: ['实现盈利'],
  sellDate: ['卖出日期'],
  earlyBuy: ['提前卖的买价', '回补价', '提前买价'],
} as const

type ColKey = keyof typeof COL

function rawCell(sheet: XLSX.WorkSheet, r: number, c: number): XLSX.CellObject | undefined {
  return sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
}

/** 空单元格 / 只有公式没有缓存值 → SheetJS 给的 stub（t='z'，v=0） */
function isBlank(cell: XLSX.CellObject | undefined): boolean {
  if (!cell) return true
  if (cell.t === 'z') return true
  return cell.v === undefined || cell.v === null || cell.v === ''
}

function cellText(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return ''
  return String(cell!.v).trim()
}

/** 只有「真公式」才算公式；Excel 里损坏成 '=' 的一律当空 */
function cellFormula(sheet: XLSX.WorkSheet, r: number, c: number): string | null {
  const cell = rawCell(sheet, r, c)
  if (!cell || typeof cell.f !== 'string') return null
  const f = cell.f.trim()
  if (f === '' || f === '=') return null
  return f
}

function numOrNull(sheet: XLSX.WorkSheet, r: number, c: number): number | null {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return null
  if (typeof cell!.v === 'number') return Number.isFinite(cell!.v) ? cell!.v : null
  const s = String(cell!.v).trim().replace(/,/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function centsOrNull(sheet: XLSX.WorkSheet, r: number, c: number): number | null {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return null
  return toCents(typeof cell!.v === 'number' ? cell!.v : String(cell!.v))
}

function resolveHeader(sheet: XLSX.WorkSheet, aliases: readonly string[]): number | null {
  const range = XLSX.utils.decode_range(sheet['!ref'] as string)
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    if (aliases.includes(cellText(sheet, range.s.r, c))) return c
  }
  return null
}

export function parseWorkbook(buffer: ArrayBuffer | Uint8Array): ParseResult {
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
      importKey: '',
    }
    rec.importKey = makeImportKey(rec)
    records.push(rec)
  }

  return { sheetName, records, skippedRows, missingColumns }
}

export async function parseWorkbookFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  return parseWorkbook(new Uint8Array(buf))
}

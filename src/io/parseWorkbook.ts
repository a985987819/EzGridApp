/**
 * 普通导入：xlsx 只读第 1 个工作表「交易记录」（D7）；CSV 整表读入。完整台账由 ledgerWorkbook 识别与恢复。
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
 * 模块级 XLSX 只在 parseWorkbook / parseCsvText 内 await loadXlsx() 之后才会被触达，helpers 可以直接读。
 */
let XLSX: XlsxModule
let xlsxReady: Promise<XlsxModule> | null = null
export function loadXlsx(): Promise<XlsxModule> {
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

/**
 * 日期列：xlsx 里是序列号数字；CSV 导出后是「2026/1/28」这类文本（SheetJS 读 CSV 全按字符串）。
 * Excel 错误值（#VALUE! 等）与乱串一律 null，绝不抛错。
 */
const DATE_RE = /^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/

function dateOrNull(sheet: WorkSheet, r: number, c: number): number | null {
  const cell = rawCell(sheet, r, c)
  if (isBlank(cell)) return null
  if (typeof cell!.v === 'number') {
    // 序列号阈值：Excel 1954-07 起才算日期（~20000）。列错位时价格（如 8.58）
    // 会被当成 1900 年的怪日期，这里直接拒收按缺失处理
    return Number.isFinite(cell!.v) && cell!.v >= 20000 ? cell!.v : null
  }
  const s = String(cell!.v).trim().replace(/,/g, '')
  if (s === '') return null
  const m = DATE_RE.exec(s)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    // 与 defaults.serialToIso 互逆的 1900 系统（1900-03-01 起的虚闰年误差不影响 2000 年后的日期）
    return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86400000)
  }
  const n = Number(s)
  return Number.isFinite(n) && n >= 20000 ? n : null
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

/** 单表解析核心：xlsx 的第 1 个表和 CSV 的唯一表都走这里 */
function parseSheet(sheet: WorkSheet, sheetName: string): ParseResult {
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

    const buyDateSerial = idx.buyDate === null ? null : dateOrNull(sheet, r, idx.buyDate)
    const sellDateSerial = idx.sellDate === null ? null : dateOrNull(sheet, r, idx.sellDate)
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
  if (wb.SheetNames.some((n) => n === '台账说明' || n === '交易数据' || n.startsWith('核对_'))) {
    throw new Error('这是完整台账，请使用完整台账恢复预览，不能按普通交易表导入')
  }
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('工作簿里没有任何工作表')
  const sheet = wb.Sheets[sheetName]
  if (!sheet || !sheet['!ref']) throw new Error('第 1 个工作表是空的')
  return parseSheet(sheet, sheetName)
}

/**
 * CSV 文本 → 单表解析。SheetJS 读 CSV 全按字符串（含日期），数值/日期列的
 * 字符串转换由 numOrNull / dateOrNull / centsOrNull 负责；#VALUE! 等 Excel
 * 错误串在这三个入口都自然落到 null。
 */
export async function parseCsvText(text: string): Promise<ParseResult> {
  await loadXlsx()
  const clean = text.replace(/^\uFEFF/, '')
  if (clean.trim() === '') throw new Error('CSV 是空的')
  const wb = XLSX.read(clean, { type: 'string', cellFormula: false, cellDates: false, raw: true })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('CSV 里没有工作表')
  const sheet = wb.Sheets[sheetName]
  if (!sheet || !sheet['!ref']) throw new Error('CSV 是空的')
  return parseSheet(sheet, sheetName)
}

/** CSV 文件：UTF-8 带 BOM 为主（Excel 导出默认），出现替换符回退 GBK，FF FE 开头按 UTF-16LE */
export async function parseCsvFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let text: string
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buf)
  } else {
    text = new TextDecoder('utf-8').decode(buf)
    if (text.includes('\uFFFD')) {
      try {
        text = new TextDecoder('gbk').decode(buf)
      } catch {
        // 环境没有 GBK 解码器就保留 UTF-8 结果（中文列名会失配而报缺列，不至于崩）
      }
    }
  }
  return parseCsvText(text)
}

export async function parseWorkbookFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  return parseWorkbook(new Uint8Array(buf))
}

/**
 * 【交易记录】模板表头（V9.64）：与上方解析别名一一对应，顺序即用户原 Excel 的列序。
 * 模板下载与明细导出共用这一份表头，改列名只改这里。
 */
export const TEMPLATE_HEADERS = [
  '股票',
  '日期',
  '买入价',
  '买入份额',
  '目标售价',
  '实现份数',
  '实现盈利',
  '卖出日期',
  '提前卖的买价',
] as const

const TEMPLATE_GUIDE: (string | number)[][] = [
  ['列名', '说明', '必填'],
  ['股票', '一行一笔交易；同一股票可以有很多行（每行一批买入）', '必填'],
  ['日期', '买入日期。2026/1/5、2026-01-05、Excel 日期格都可以', '可空（纯先卖后买行）'],
  ['买入价', '这批买入的成交价', '可空（纯先卖后买行）'],
  ['买入份额', '买入股数。可填公式 FLOOR(6000/买入价,100)，文件没存计算结果也能解析', '可空（纯先卖后买行）'],
  ['目标售价', '待卖目标价（E 列）。留空按「买入价 + 间隔」推导', '可空'],
  ['实现份数', '已卖出的数量；留空 = 还没卖', '可空'],
  ['实现盈利', '可留空——台账按买卖价自动重算，本列只是留档', '可空'],
  ['卖出日期', '留空 = 未卖出。先卖后买允许卖出日期早于买入日期', '可空'],
  ['提前卖的买价（P 列）', '先卖后买要买回的价位；留空按「卖出价 − 间隔」推导', '可空'],
  ['', '', ''],
  ['说明', '只读第一个工作表；多加的行直接留空股票格即可；改完保存为 .xlsx 导入', ''],
]

/** V9.64：下载模板（表头 + 填写说明两个工作表；导入只读第一个） */
export async function buildTemplateWorkbook(): Promise<Uint8Array> {
  await loadXlsx()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS]]), '交易记录')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(TEMPLATE_GUIDE), '填写说明')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
}

/** V9.64：把明细行（已按表头顺序拼好）导出为【交易记录】格式的 xlsx 字节 */
export async function exportRecordsWorkbook(rows: (string | number | null)[][]): Promise<Uint8Array> {
  await loadXlsx()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS], ...rows]), '交易记录')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
}

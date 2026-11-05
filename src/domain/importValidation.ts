import type { RawRecord } from './types'
import { validateFinancialTotals } from './financialSafety'

export type ImportQuantityField = 'buyQtyRaw' | 'soldQty'
export type ImportField = ImportQuantityField | 'buyDateSerial' | 'sellDateSerial' | 'buyPriceCents' | 'targetPriceCents' | 'earlyBuyPriceCents' | 'rawProfitCents' | 'sourceRow' | 'stockName' | 'qtyNeedsDerive' | 'targetNeedsDerive'
export interface ImportIssue {
  sourceRow: number
  field: ImportField
  value: string
  message: string
}

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  buyQtyRaw: '买入份额',
  soldQty: '实现份数',
  buyDateSerial: '买入日期', sellDateSerial: '卖出日期',
  buyPriceCents: '买入价', targetPriceCents: '目标售价', earlyBuyPriceCents: '回补价', rawProfitCents: '实现盈利',
  sourceRow: '记录身份', stockName: '股票', qtyNeedsDerive: '推定买入股数', targetNeedsDerive: '推定售价',
}

/** 文本先按十进制精确判定，避免 Number 把微小小数舍成整数、下溢成 0。 */
export function parseImportQuantity(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().replaceAll(',', '')
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!match) return null
  const fraction = match[3] ?? match[4] ?? ''
  const digits = ((match[2] ?? '') + fraction).replace(/^0+/, '')
  if (!digits) return 0
  if (match[1] === '-') return null
  const shift = Number(match[5] ?? 0) - fraction.length
  const length = digits.length + shift
  if (!Number.isSafeInteger(shift) || length < 1 || length > 16) return null
  if (shift < 0 && /[1-9]/.test(digits.slice(length))) return null
  const integer = shift < 0 ? digits.slice(0, length) : digits + '0'.repeat(shift)
  const result = Number(integer)
  return Number.isSafeInteger(result) ? result : null
}

export function importIssue(sourceRow: number, field: ImportField, value: unknown, message: string): ImportIssue {
  const text = String(value)
  return {
    sourceRow, field, value: text.length > 100 ? `${text.slice(0, 100)}…` : text,
    message,
  }
}

export const importQuantityIssue = (sourceRow: number, field: ImportQuantityField, value: unknown): ImportIssue =>
  importIssue(sourceRow, field, value, '须为非负安全整数股数，不能包含小数或超出范围')

/** 提交入口独立检查全部输入，不信任预览标记或只校验本次新增行。 */
export function validateImportRecords(records: readonly RawRecord[]): ImportIssue[] {
  const issues: ImportIssue[] = []
  for (const record of records) {
    const row = record.excelRow ?? record.sourceRow
    if (!Number.isSafeInteger(record.sourceRow) || record.sourceRow <= 0) issues.push(importIssue(row, 'sourceRow', record.sourceRow, '须为正的安全整数'))
    if (typeof record.stockName !== 'string' || !record.stockName.trim()) issues.push(importIssue(row, 'stockName', record.stockName, '不能为空'))
    for (const field of ['qtyNeedsDerive', 'targetNeedsDerive'] as const) if (typeof record[field] !== 'boolean') issues.push(importIssue(row, field, record[field], '须为布尔值'))
    for (const field of ['buyQtyRaw', 'soldQty'] as const) {
      const value = record[field]
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) issues.push(importQuantityIssue(row, field, value))
    }
    for (const field of ['buyPriceCents', 'targetPriceCents', 'earlyBuyPriceCents', 'rawProfitCents'] as const) {
      const value = record[field]
      if (value !== null && (!Number.isSafeInteger(value) || (field !== 'rawProfitCents' && value < 0))) {
        issues.push(importIssue(row, field, value, '金额须为有限安全整数分，价格不能为负数'))
      }
    }
    for (const field of ['buyDateSerial', 'sellDateSerial'] as const) {
      const value = record[field]
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2958465)) {
        issues.push(importIssue(row, field, value, '日期序列值超出有效范围'))
      }
    }
    for (const [price, quantity] of [['buyPriceCents', 'buyQtyRaw'], ['targetPriceCents', 'soldQty']] as const) {
      if (record[price] !== null && record[quantity] !== null && !Number.isSafeInteger(record[price] * record[quantity])) {
        issues.push(importIssue(row, price, record[price], '价格乘股数的金额超出安全整数范围'))
      }
    }
  }
  if (issues.length === 0 && records.length) {
    const totals = validateFinancialTotals(records)
    if (totals) issues.push(importIssue(records[0].sourceRow, 'buyQtyRaw', '整份文件', totals))
  }
  return issues
}

export function formatImportIssue(issue: ImportIssue): string {
  return `Excel 第 ${issue.sourceRow} 行「${IMPORT_FIELD_LABELS[issue.field]}」${issue.message}（当前：${issue.value}）`
}

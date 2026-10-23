import { centsToYuan, formatMoney } from '../domain/money'

/** 人民币金额 */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `¥${formatMoney(cents)}`
}

/** 带符号金额：盈利红/亏损绿 */
export function signedMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const sign = cents > 0 ? '+' : ''
  return `${sign}¥${formatMoney(cents)}`
}

export function price(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return centsToYuan(cents)
}

export function qty(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('zh-CN')
}

/** 涨/盈红、跌/亏绿（A 股习惯） */
export function tone(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || cents === 0) return 'flat'
  return cents > 0 ? 'up' : 'down'
}

export function isoDate(iso: string | null): string {
  return iso ?? '待补'
}

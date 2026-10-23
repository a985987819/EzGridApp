import type { RawRecord, StockConfig } from './types'
import { deriveBuyQty, floorToHundred } from './qty'
import { mulCents } from './money'

export const STOCK_PREFIX = 'stock:'

export function stockIdOf(name: string): string {
  return `${STOCK_PREFIX}${name}`
}

/** 26 年网格记录里出现的 4 只票，默认间隔来自 S0 勘察 */
export const DEFAULT_STOCKS: StockConfig[] = [
  { id: stockIdOf('柳工'), name: '柳工', intervalCents: 57, priceLimitType: 'main_10', order: 0, enabled: true },
  { id: stockIdOf('三一重工'), name: '三一重工', intervalCents: 107, priceLimitType: 'main_10', order: 1, enabled: true },
  { id: stockIdOf('奥佳华'), name: '奥佳华', intervalCents: 37, priceLimitType: 'main_10', order: 2, enabled: true },
  { id: stockIdOf('安道麦'), name: '安道麦', intervalCents: 37, priceLimitType: 'main_10', order: 3, enabled: true },
]

/** 文档 §03 的 8 个基准数（仅对 26 年数据集适用，用作回归红线） */
export const BASELINE = {
  rows: 62,
  buyQty: 31800,
  buyAmountCents: 36032000,
  sellCount: 33,
  sellQty: 18600,
  sellAmountCents: 19055900,
  profitCents: 983100,
  targetCount: 29,
  targetQty: 15200,
  targetAmountCents: 20228400,
  expectProfitCents: 1251500,
  rebuyCount: 4,
  rebuyBaseQty: 2000,
  rebuyRewardQty: 100,
  rebuyQty: 2100,
  rebuyAmountCents: 1660100,
  rewardQty: 100,
  netQty: 13200,
  exposureQty: 2000,
} as const

export const BASE_BUY_AMOUNT_YUAN = 6000

export { deriveBuyQty, floorToHundred }

/** Excel 序列号 → ISO 日期（1900 系统） */
export function serialToIso(serial: number | null): string | null {
  if (serial === null || !Number.isFinite(serial) || serial <= 0) return null
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/** 稳定的幂等键：股票+买入日期+买入价+份额+目标价（P9） */
export function makeImportKey(r: Pick<RawRecord, 'stockName' | 'buyDateSerial' | 'buyPriceCents' | 'buyQtyRaw' | 'targetPriceCents' | 'soldQty' | 'sellDateSerial' | 'sourceRow'>): string {
  return [
    r.stockName,
    r.buyDateSerial ?? '',
    r.buyPriceCents ?? '',
    r.buyQtyRaw ?? '',
    r.targetPriceCents ?? '',
    r.soldQty ?? '',
    r.sellDateSerial ?? '',
  ].join('|')
}

export function mulPrice(priceCents: number, qty: number): number {
  return mulCents(priceCents, qty)
}

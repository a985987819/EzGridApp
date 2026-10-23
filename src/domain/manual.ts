/** 手动新增一笔：买入 或 卖出（卖出可以先不填买入信息，之后再补）。 */

import { applyEdits } from './edit'
import { stockIdOf } from './defaults'
import type { RawRecord } from './types'

export type ManualKind = 'buy' | 'sell'

export interface ManualInput {
  kind: ManualKind
  stockName: string
  /** 买入日期 / 卖出日期（YYYY-MM-DD） */
  date: string
  /** 买入价 / 成交价（元） */
  price: string
  /** 买入份额 / 卖出数量（股） */
  qty: string
  /** 买入时的目标售价，空则按「买入价 + 间隔」派生 */
  targetPrice?: string
  /** 卖出时的回补价 P，空则视为已回补 */
  rebuyPrice?: string
  /** 卖出时可选：顺手补上买入批次信息 */
  buyPrice?: string
  buyQty?: string
  buyDate?: string
}

export const MANUAL_ROW_BASE = 100000

export interface ManualResult {
  record: RawRecord
  errors: string[]
}

export function buildManualRecord(input: ManualInput, sourceRow: number): ManualResult {
  const stockName = input.stockName.trim()
  const base: RawRecord = {
    sourceRow,
    stockName,
    buyDateSerial: null,
    buyPriceCents: null,
    buyQtyRaw: null,
    qtyNeedsDerive: false,
    targetPriceCents: null,
    targetNeedsDerive: false,
    soldQty: null,
    sellDateSerial: null,
    earlyBuyPriceCents: null,
    rawProfitCents: null,
    importKey: `manual:${stockIdOf(stockName)}:${sourceRow}:${Date.now()}`,
    origin: 'manual',
    batchId: null,
  }

  const errors: string[] = []
  if (!stockName) errors.push('请选择股票')

  const draft =
    input.kind === 'buy'
      ? {
          buyDate: input.date,
          buyPrice: input.price,
          buyQty: input.qty,
          targetPrice: input.targetPrice ?? '',
        }
      : {
          sellDate: input.date,
          soldQty: input.qty,
          targetPrice: input.price,
          earlyBuyPrice: input.rebuyPrice ?? '',
          ...(input.buyPrice ? { buyPrice: input.buyPrice } : {}),
          ...(input.buyQty ? { buyQty: input.buyQty } : {}),
          ...(input.buyDate ? { buyDate: input.buyDate } : {}),
        }

  const applied = applyEdits(base, draft)
  errors.push(...applied.errors)
  const record = applied.record

  if (input.kind === 'buy') {
    if (!input.price.trim()) errors.push('买入价不能为空')
    if (!input.qty.trim()) errors.push('买入份额不能为空')
    // 目标售价留空 → 交给 ledger 按「买入价 + 该股间隔」派生
    if (record.targetPriceCents === null && record.buyPriceCents !== null) {
      record.targetNeedsDerive = true
    }
  } else {
    if (!input.price.trim()) errors.push('成交价不能为空')
    if (!input.qty.trim()) errors.push('卖出数量不能为空')
    if (record.soldQty === null || record.soldQty <= 0) errors.push('卖出数量必须大于 0')
    if (record.targetPriceCents === null) errors.push('成交价必须大于 0')
    if (
      record.buyQtyRaw !== null &&
      record.soldQty !== null &&
      record.soldQty > record.buyQtyRaw
    ) {
      errors.push('卖出数量不能大于买入份额')
    }
  }

  if (errors.length === 0) record.editedAt = Date.now()
  return { record, errors }
}

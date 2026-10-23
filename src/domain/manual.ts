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
  /** 卖出时的回补价 P，空则按 R3 优先级推导 */
  rebuyPrice?: string
  /** 勾上「这笔已回补」→ 不推导回补价、不生成待买（R2 的 repaid） */
  repaid?: boolean
  /** 卖出时可选：顺手补上买入批次信息 */
  buyPrice?: string
  buyQty?: string
  buyDate?: string
}

export const MANUAL_ROW_BASE = 100000

export interface ManualOptions {
  /** 该股的默认卖出间隔（整数分），R3 第 4 级要用 */
  intervalCents?: number
}

export interface ManualResult {
  record: RawRecord
  errors: string[]
}

/**
 * 回补价四级优先级（R3）：
 *   自定义（手填）> 关联买入价 > P 列 > 卖出价 − 默认间隔 > 无解
 * 手动新增的卖出默认都生成待买，只有显式勾「已回补」才走 repaid（D2 的"不生成"只针对那 33 笔历史）。
 */
export function deriveRebuyPrice(
  record: RawRecord,
  intervalCents: number,
): { cents: number | null; source: 'custom' | 'lot' | 'sellMinusInterval' | null } {
  if (record.earlyBuyPriceCents !== null) return { cents: record.earlyBuyPriceCents, source: 'custom' }
  if (record.buyPriceCents !== null) return { cents: record.buyPriceCents, source: 'lot' }
  if (
    record.targetPriceCents !== null &&
    intervalCents > 0 &&
    record.targetPriceCents - intervalCents > 0
  ) {
    return { cents: record.targetPriceCents - intervalCents, source: 'sellMinusInterval' }
  }
  return { cents: null, source: null }
}

export function buildManualRecord(
  input: ManualInput,
  sourceRow: number,
  opts: ManualOptions = {},
): ManualResult {
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

    // R3：默认都生成待买；只有显式「已回补」才不生成
    if (input.repaid) {
      record.earlyBuyPriceCents = null
      record.rebuyPriceSource = 'repaid'
    } else {
      const derived = deriveRebuyPrice(record, opts.intervalCents ?? 0)
      if (derived.cents === null || derived.source === null) {
        errors.push('算不出回补价：请填「回补价」，或勾上「这笔已回补」')
      } else {
        record.earlyBuyPriceCents = derived.cents
        record.rebuyPriceSource = derived.source === 'custom' ? 'custom' : derived.source
      }
    }
  }

  if (errors.length === 0) record.editedAt = Date.now()
  return { record, errors }
}

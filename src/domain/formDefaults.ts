import type { ManualInput } from './manual'
import { centsToYuan, toCents } from './money'

/** 只给空白输入补默认值；非法但非空的输入仍交给原有校验拒绝。 */
export function inputOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback
}

/** 同一份默认值同时用于占位提示与提交，不从 DOM 或提示文案解析金额。 */
export function manualFormDefaults(input: ManualInput, today: string, intervalCents: number) {
  const price = input.kind === 'buy' ? '8.01' : '8.58'
  const qty = '700'
  const buyPrice = '8.30'
  const hasBuy = input.kind === 'sell' && [input.buyPrice, input.buyQty, input.buyDate].some((v) => v?.trim())
  const actualPrice = toCents(inputOrDefault(input.price, price))
  const linkedCost = hasBuy ? toCents(inputOrDefault(input.buyPrice, buyPrice)) : null
  const target = actualPrice !== null && intervalCents > 0 ? actualPrice + intervalCents : null
  const rebuy = linkedCost ?? (actualPrice !== null && intervalCents > 0 ? actualPrice - intervalCents : null)
  return {
    date: today,
    price,
    qty,
    buyPrice,
    buyQty: inputOrDefault(input.qty, qty),
    buyDate: today,
    targetPrice: target !== null && target > 0 ? centsToYuan(target) : '',
    rebuyPrice: rebuy !== null && rebuy > 0 ? centsToYuan(rebuy) : '',
    hasBuy,
  }
}

/** 仅新增表单采用建议值，普通编辑仍允许清空字段。派生价继续由 domain 原口径生成。 */
export function resolveManualForm(input: ManualInput, today: string, intervalCents: number): ManualInput {
  const defaults = manualFormDefaults(input, today, intervalCents)
  return {
    ...input,
    date: inputOrDefault(input.date, defaults.date),
    price: inputOrDefault(input.price, defaults.price),
    qty: inputOrDefault(input.qty, defaults.qty),
    ...(defaults.hasBuy ? {
      buyPrice: inputOrDefault(input.buyPrice, defaults.buyPrice),
      buyQty: inputOrDefault(input.buyQty, defaults.buyQty),
      buyDate: inputOrDefault(input.buyDate, defaults.buyDate),
    } : { buyPrice: '', buyQty: '', buyDate: '' }),
  }
}

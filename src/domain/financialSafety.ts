import type { RawRecord, RebuyExecution } from './types'
import { deriveBuyQty } from './qty'

/** 按真实输入累加现金和股数；先比较剩余额度，避免先产生不精确的累计值。 */
export function validateFinancialTotals(records: readonly RawRecord[], executions: readonly RebuyExecution[] = []): string | null {
  const totals = { buyQty: 0, soldQty: 0, buyAmount: 0, soldAmount: 0 }
  const labels = { buyQty: '买入股数', soldQty: '卖出股数', buyAmount: '买入金额', soldAmount: '卖出金额' }
  const add = (key: keyof typeof totals, value: number): string | null => {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - totals[key]) return `累计${labels[key]}超出安全整数范围`
    totals[key] += value
    return null
  }
  const buy = (price: number | null | undefined, qty: number): string | null => add('buyQty', qty) ?? (price == null ? null : add('buyAmount', price * qty))
  const rows = new Map(records.map(record => [record.sourceRow, record]))
  for (const record of records) {
    if (record.deletedAt) continue
    const buyQty = record.buyQtyRaw ?? (record.qtyNeedsDerive && record.buyPriceCents ? deriveBuyQty(record.buyPriceCents) : 0)
    // 子卖出的成本来自来源批次；同一买入不能再次计入现金。
    const bought = record.soldLotId ? null : buy(record.buyPriceCents, buyQty)
    if (bought) return bought
    const soldQty = record.soldQty ?? 0
    const sold = add('soldQty', soldQty) ?? (record.targetPriceCents == null ? null : add('soldAmount', record.targetPriceCents * soldQty))
    if (sold) return sold
  }
  for (const execution of executions) {
    const match = /^sell:(\d+)$/.exec(execution.sellExecId)
    const source = match ? rows.get(Number(match[1])) : undefined
    if (!source || source.deletedAt || (source.soldQty ?? 0) <= 0) continue
    const bought = buy(execution.priceCents, execution.qty)
    if (bought) return bought
  }
  return null
}

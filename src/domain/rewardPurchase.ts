import type { GroupPool } from './types'

/** 成交按整行基础份额优先，再使用整手奖励；不能让前一来源的奖励抢走后一来源基础量。 */
export function allocateRewardPurchase<T extends { qty: number; baseQty: number; rewardQty: number }>(sources: readonly T[], qty: number): (T & { buyQty: number; buyRewardQty: number })[] {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('成交数量必须是正整数')
  const result = sources.map(source => {
    if (![source.qty, source.baseQty, source.rewardQty].every(Number.isSafeInteger) || source.qty <= 0 || source.baseQty < 0 || source.rewardQty < 0 || source.rewardQty % 100 !== 0 || source.baseQty + source.rewardQty !== source.qty) throw new Error('建议来源基础或奖励额度不合法，请刷新后重试')
    return { ...source, buyQty: 0, buyRewardQty: 0 }
  })
  let left = qty
  for (const source of result) { const take = Math.min(left, source.baseQty); source.buyQty = take; left -= take }
  for (const source of result) {
    if (left <= 0) break
    const take = Math.min(left, source.rewardQty)
    if (take % 100 !== 0) throw new Error('奖励买入须为100股的整手；请调整本次成交数量')
    source.buyQty += take; source.buyRewardQty = take; left -= take
  }
  if (left > 0) throw new Error('成交数量超过建议数量')
  return result.filter(source => source.buyQty > 0)
}

/** 同一事务的所有来源共用这份余额；使用实际成交价而非建议价检查资金。 */
export function rewardBudget(groups: readonly GroupPool[]) {
  const remaining = new Map(groups.map(group => {
    const available = group.grossProfitCents - group.usedProfitCents
    return [group.groupKey, Number.isSafeInteger(available) ? Math.max(0, available) : 0] as const
  }))
  return (groupKey: string, rewardQty: number, priceCents: number) => {
    if (!Number.isSafeInteger(rewardQty) || rewardQty < 0 || rewardQty % 100 !== 0 || !Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error('奖励股数或成交价不合法')
    if (rewardQty === 0) return
    const amount = rewardQty * priceCents
    const available = remaining.get(groupKey) ?? 0
    if (!Number.isSafeInteger(amount) || amount > available) throw new Error('当前价位可用累计盈利不足以支付本次奖励股，请降低成交价或奖励股数后重试')
    remaining.set(groupKey, available - amount)
  }
}

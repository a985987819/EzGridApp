/** 数量内核：正整数股，奖励量必须是 100 的整数倍（规范 §7.2）。 */

import { HAND } from './money'

export function isQty(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

export function isHundredMultiple(n: number): boolean {
  return Number.isInteger(n) && n % HAND === 0
}

/** 向下取整到整手 */
export function floorToHundred(n: number): number {
  return Math.floor(n / HAND) * HAND
}

/** D 列缺失时的派生：FLOOR(6000 / 买入价, 100) 手数化 */
export function deriveBuyQty(buyPriceCents: number, baseAmountYuan = 6000): number {
  if (!buyPriceCents || buyPriceCents <= 0) return 0
  const shares = Math.floor((baseAmountYuan * 100) / buyPriceCents)
  return floorToHundred(shares)
}

/** 手数 = floor(可用额度 / 每组每手成本) */
export function handsFromBudget(budgetCents: number, lotCostCents: number): number {
  if (!Number.isFinite(budgetCents) || lotCostCents <= 0) return 0
  const b = Math.max(0, budgetCents)
  return Math.floor(b / lotCostCents)
}

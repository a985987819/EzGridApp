/** 基准快照校验：文档 §03 / S2 验收的 8 个数字，任一不符即红灯。 */

import { BASELINE } from './defaults'
import { centsToYuan, formatMoney } from './money'
import type { CheckResult, Ledger } from './types'

/** 文档原值用浮点算的，安道麦 E 列是 6.331（三位小数），
 * 按 §7.2 归到整数分后该股金额/盈利各差 ¥1，故给 ±1 元容差。 */
const YUAN_TOLERANCE_CENTS = 100

function exact(name: string, actual: number, expected: number, unit = ''): CheckResult {
  return {
    name,
    ok: actual === expected,
    actual: `${actual}${unit}`,
    expected: `${expected}${unit}`,
  }
}

function money(name: string, actual: number, expected: number, tolerance = 0): CheckResult {
  const diff = Math.abs(actual - expected)
  return {
    name,
    ok: diff <= tolerance,
    actual: `¥${formatMoney(actual)}`,
    expected: `¥${formatMoney(expected)}`,
    detail: diff === 0 ? undefined : `差 ¥${centsToYuan(diff)}（E 列三位小数按整数分取整）`,
  }
}

export function compareBaseline(ledger: Ledger): CheckResult[] {
  const t = ledger.totals
  const b = BASELINE
  return [
    exact('有效行数', t.rows, b.rows, ' 行'),
    exact('买入股数', t.buyQty, b.buyQty, ' 股'),
    money('买入金额', t.buyAmountCents, b.buyAmountCents),
    exact('卖出笔数', t.sellCount, b.sellCount, ' 笔'),
    exact('卖出股数', t.sellQty, b.sellQty, ' 股'),
    money('卖出金额', t.sellAmountCents, b.sellAmountCents, YUAN_TOLERANCE_CENTS),
    money('实现盈利', t.profitCents, b.profitCents, YUAN_TOLERANCE_CENTS),
    exact('待卖条数', t.targetCount, b.targetCount, ' 条'),
    exact('待卖股数', t.targetQty, b.targetQty, ' 股'),
    money('待卖目标金额', t.targetAmountCents, b.targetAmountCents),
    money('待卖预期收益', t.expectProfitCents, b.expectProfitCents),
    exact('待买条数', t.rebuyCount, b.rebuyCount, ' 条'),
    exact('待买股数（含奖励）', t.rebuyQty, b.rebuyQty, ' 股'),
    money('待买金额', t.rebuyAmountCents, b.rebuyAmountCents),
    exact('奖励股数', t.rewardQty, b.rewardQty, ' 股'),
    exact('净持仓', t.netQty, b.netQty, ' 股'),
  ]
}

export function baselinePassed(checks: CheckResult[]): boolean {
  return checks.every((c) => c.ok)
}

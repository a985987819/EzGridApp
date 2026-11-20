/**
 * 单纯做T（V9.68）：先卖后买用多笔买入把卖出份额买回，
 * 买回量 = 卖出量之后，这一笔不再走回本链，直接按每一笔实际买入价记价差。
 *
 * 这是纯派生判定：不写回 sell.profitCents、不改总账、不动奖励池。
 * 收益口径与网格表现视图一致——Σ(实际卖价 − 每笔实际买入价) × 每笔基础股数。
 */
import type { SellExecution } from './types'

/** 只认已经确认的来源：本行买入盖住的份额 + 真实回补成交；不拿计划价或链里分配的份额凑数。 */
function confirmedFills(sell: SellExecution) {
  return (sell.actualRebuyFills ?? []).filter(
    (f) => f.sourceLotId === `lot:${sell.sourceRow}` || f.sourceLotId.startsWith('lot:exec:'),
  )
}

/** 这笔先卖后买是否已经按真实成交买回全部卖出份额（奖励股不算基础回补）。 */
export function isSimpleT(row: number, ledger: { sells: readonly SellExecution[] }): boolean {
  // 标记由 buildLedger 统一算出：多笔真实成交买满、没挂高位批次、也没选显式策略档
  return ledger.sells.some((s) => s.sourceRow === row && s.simpleT === true)
}

/**
 * 单纯做T 的价差收益：每一笔买入按它自己的成交价和数量算，再汇总。
 * 返回 null 表示还缺价格/来源，不把未确认的估算当盈利。
 */
export function simpleTProfitCents(sell: SellExecution): number | null {
  if (!sell.sellBeforeBuy || sell.priceCents === null) return null
  const fills = confirmedFills(sell)
  if (fills.length === 0 || fills.some((f) => f.priceCents === null)) return null
  if (fills.reduce((sum, f) => sum + f.qty, 0) < sell.qty) return null
  return fills.reduce((sum, f) => sum + (sell.priceCents! - f.priceCents!) * f.qty, 0)
}

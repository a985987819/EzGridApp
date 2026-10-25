/**
 * 先卖后买挂钩（V9.26 口径，V9.32 把「能不能挂」的判定抽成纯函数）。
 *
 * 为什么要抽出来：明细页原来是从「待买订单」反推哪些行能挂，没填 P 列（回补价）的裸卖
 * 根本没有订单 → 行上不给入口，但抽屉里其实能挂，两个入口不一致。
 * 现在统一按「这行本身是不是裸卖 + 有没有回补过」判定，和有没有待买订单无关。
 */
import type { RawRecord } from './types'

/** 能挂/能改挂的裸卖：没有买入批次、还有没买回的股数（execQty 传该行待买已成交股数） */
export function isHedgeable(
  rec: Pick<RawRecord, 'buyPriceCents' | 'soldQty'>,
  execQty: number,
): boolean {
  return rec.buyPriceCents === null && (rec.soldQty ?? 0) - execQty > 0
}

/** 还需要挂的股数 = 卖出量 − 已买回（V9.33：买回来的那截不参与挂钩） */
export function hedgeRemainQty(soldQty: number, execQty: number): number {
  return Math.max(0, soldQty - Math.max(0, execQty))
}

/**
 * 先卖后买挂钩（V9.26 口径，V9.32 把「能不能挂」的判定抽成纯函数）。
 *
 * 为什么要抽出来：明细页原来是从「待买订单」反推哪些行能挂，没填 P 列（回补价）的裸卖
 * 根本没有订单 → 行上不给入口，但抽屉里其实能挂，两个入口不一致。
 * 现在统一按「这行是不是先卖后买」判定；已回补仍可改挂，和有没有待买订单无关。
 */
import type { RawRecord } from './types'
import { isSellFirst } from './sellFirst'

/** 先卖后买均可关联原始高位成本，包括同行已买回的记录。execQty 保留旧调用接口。 */
export function isHedgeable(
  rec: Pick<RawRecord, 'buyPriceCents' | 'soldQty'> & Partial<Pick<RawRecord, 'buyDateSerial' | 'sellDateSerial' | 'soldLotId'>>,
  execQty: number,
): boolean {
  return Number.isFinite(execQty) && isSellFirst({ ...rec, buyDateSerial: rec.buyDateSerial ?? null, sellDateSerial: rec.sellDateSerial ?? null })
}

/** 还需要挂的股数 = 卖出量 − 已买回（V9.33：买回来的那截不参与挂钩） */
export function hedgeRemainQty(soldQty: number, execQty: number): number {
  return Math.max(0, soldQty - Math.max(0, execQty))
}

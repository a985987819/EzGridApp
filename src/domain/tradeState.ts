import type { Lot, RawRecord, SellExecution } from './types'

export interface TradeRow {
  rec: RawRecord
  lot: Lot | null
  sell: SellExecution | null
}

export function isSoldOut(r: TradeRow): boolean {
  return r.lot ? r.lot.soldQty > 0 && r.lot.remainingQty === 0 : r.sell !== null
}

/** 子卖出单独保留回补状态；父批次没有余股即已完成本轮卖出。 */
export function isDone(r: TradeRow): boolean {
  return isSoldOut(r) && r.sell?.rebuyStatus !== 'pending'
}

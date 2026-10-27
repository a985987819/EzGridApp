import type { ExtraTarget, RawRecord } from './types'

/** 新成交认来源档；旧成交只按同价分配，避免已成交的档再次出现。 */
export function remainingSellTargets(targets: readonly ExtraTarget[], records: readonly RawRecord[]): ExtraTarget[] {
  const rows = targets.map((t) => ({ ...t }))
  const active = records.filter((r) => !r.deletedAt && r.soldLotId && (r.soldQty ?? 0) > 0)
  // 明确来源优先，旧成交不能先占掉其份额。
  for (const explicit of [true, false]) for (const r of active) {
    if (Boolean(r.soldTargetId) !== explicit) continue
    let left = r.soldQty ?? 0
    for (const t of rows) {
      if (t.lotId !== r.soldLotId || (explicit ? `target:${t.id}` !== r.soldTargetId : t.priceCents !== r.targetPriceCents)) continue
      const take = Math.min(left, t.qty)
      t.qty -= take
      left -= take
      if (left <= 0) break
    }
  }
  return rows
}

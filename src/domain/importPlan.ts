/**
 * 导入写库计划（v9.20 用户决策 C）：P9 幂等键之外再按「行身份」匹配。
 *
 * 身份 = 股票 + 买入日期 + 买入价 + 有效买入份额（D 列公式派生的份额折算回来参与身份，
 * 避免「老文件没存公式缓存值、新文件存了」被误判成两批买入）。
 * - importKey 完全一致 → 完全同内容，跳过；
 * - 身份相同但卖出侧字段（已卖/卖出日期/目标价/回补价/盈利留痕）变了 → 更新本地行，
 *   importKey 与 nanoId 保持不变（P9：导入后永不改写）；
 * - 身份都对不上 → 新增。
 * 卖出侧字段不参与身份：卖了多少、哪天卖的本来就是导入时要同步的最新状态。
 */

import { centsToYuan } from './money'
import { deriveBuyQty } from './qty'
import { serialToIso } from './defaults'
import type { RawRecord } from './types'

export interface ImportUpdate {
  from: RawRecord
  to: RawRecord
}

export interface ImportPlan {
  fresh: RawRecord[]
  updates: ImportUpdate[]
  /** 同 key 跳过 + 身份命中但内容无变化的行数 */
  unchanged: number
}

export function identityKeyOf(
  r: Pick<RawRecord, 'stockName' | 'buyDateSerial' | 'buyPriceCents' | 'buyQtyRaw' | 'qtyNeedsDerive'>,
): string {
  // D 列公式无缓存值的行，按派生份额参与身份，和缓存了同一结果的文件相等
  const qty = r.qtyNeedsDerive && r.buyPriceCents ? deriveBuyQty(r.buyPriceCents) : r.buyQtyRaw
  return [r.stockName, r.buyDateSerial ?? '', r.buyPriceCents ?? '', qty ?? ''].join('|')
}

/** 卖出侧可被文件更新进本地行的字段 */
const UPDATABLE_KEYS = [
  'soldQty',
  'sellDateSerial',
  'targetPriceCents',
  'targetNeedsDerive',
  'earlyBuyPriceCents',
  'rawProfitCents',
  'sellDateNeedsToday',
] as const

export function importDiffFields(from: RawRecord, to: RawRecord): ImportUpdatableKey[] {
  return UPDATABLE_KEYS.filter((k) => (from[k] ?? null) !== (to[k] ?? null))
}

export type ImportUpdatableKey = (typeof UPDATABLE_KEYS)[number]

/** 审计日志里的字段名（对齐 edit.ts 的叫法） */
export const IMPORT_FIELD_LABEL: Record<ImportUpdatableKey, string> = {
  soldQty: '已卖份额',
  sellDateSerial: '卖出日期',
  targetPriceCents: '目标售价',
  targetNeedsDerive: '目标价按公式派生',
  earlyBuyPriceCents: '回补价',
  rawProfitCents: '实现盈利（留痕）',
  sellDateNeedsToday: '卖出日期是 =TODAY() 公式',
}

/** 审计日志里的值格式化：分 → 元、序列号 → ISO 日期 */
export function importFieldValue(r: RawRecord, k: ImportUpdatableKey): string {
  const v = r[k]
  if (v === null || v === undefined) return '（空）'
  if (k === 'sellDateSerial') return serialToIso(v as number) ?? String(v)
  if (k === 'targetPriceCents' || k === 'earlyBuyPriceCents' || k === 'rawProfitCents') return centsToYuan(v as number)
  if (k === 'targetNeedsDerive' || k === 'sellDateNeedsToday') return v ? '是' : '否'
  return String(v)
}

export function planImport(existing: RawRecord[], incoming: RawRecord[]): ImportPlan {
  // 身份 → 本地行队列：同一身份多行（例如同价同日多笔买入）按出现次序配对，不串行
  const byIdentity = new Map<string, RawRecord[]>()
  for (const r of existing) {
    const k = identityKeyOf(r)
    const list = byIdentity.get(k)
    if (list) list.push(r)
    else byIdentity.set(k, [r])
  }

  const fresh: RawRecord[] = []
  const updates: ImportUpdate[] = []
  let unchanged = 0
  for (const r of incoming) {
    const local = byIdentity.get(identityKeyOf(r))?.shift()
    if (!local) {
      fresh.push(r)
      continue
    }
    const merged: RawRecord = {
      ...local,
      soldQty: r.soldQty,
      sellDateSerial: r.sellDateSerial,
      sellDateNeedsToday: r.sellDateNeedsToday,
      targetPriceCents: r.targetPriceCents,
      targetNeedsDerive: r.targetNeedsDerive,
      earlyBuyPriceCents: r.earlyBuyPriceCents,
      rawProfitCents: r.rawProfitCents,
    }
    if (importDiffFields(local, merged).length > 0) updates.push({ from: local, to: merged })
    else unchanged += 1
  }
  return { fresh, updates, unchanged }
}

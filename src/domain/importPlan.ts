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
import { similarFacts, type TradeFact } from './booking'

export interface ImportUpdate {
  from: RawRecord
  to: RawRecord
}

export interface ImportPlan {
  fresh: RawRecord[]
  updates: ImportUpdate[]
  /** 同 key 跳过 + 身份命中但内容无变化的行数 */
  unchanged: number
  conflicts: { incoming: RawRecord; candidates: RawRecord[]; reason: string }[]
}
export type ImportChoices = Record<number, number | 'new' | 'skip'>

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

export function planImport(existing: RawRecord[], incoming: RawRecord[], missingColumns: readonly string[] = [], choices: ImportChoices = {}, facts: readonly TradeFact[] = []): ImportPlan {
  // 身份 → 本地行队列：同一身份多行（例如同价同日多笔买入）按出现次序配对，不串行
  const byIdentity = new Map<string, RawRecord[]>()
  for (const r of existing) {
    if (r.soldLotId) continue
    const k = identityKeyOf(r)
    const list = byIdentity.get(k)
    if (list) list.push(r)
    else byIdentity.set(k, [r])
  }

  const used = new Set(existing.map((r) => r.sourceRow))
  const reserved = new Set(incoming.map((r) => r.sourceRow))
  let nextId = Math.max(0, ...existing.filter((r) => r.sourceRow < 100000).map((r) => r.sourceRow),
    ...incoming.map((r) => r.sourceRow)) + 1
  const fresh: RawRecord[] = []
  const updates: ImportUpdate[] = []
  let unchanged = 0
  const conflicts: ImportPlan['conflicts'] = []
  const claimed = new Set<number>()
  // 先预留所有精确匹配，子集/重排不能被较早的模糊行抢占。
  const exact = new Map<RawRecord, RawRecord>()
  for (const r of incoming) {
    const matches = existing.filter(local => !claimed.has(local.sourceRow) && !local.soldLotId && local.importKey === r.importKey && identityKeyOf(local) === identityKeyOf(r))
    if (matches.length === 1) { exact.set(r, matches[0]); claimed.add(matches[0].sourceRow) }
  }
  for (const r of incoming) {
    if (choices[r.sourceRow] === 'skip') { const reservedMatch = exact.get(r); if (reservedMatch) claimed.delete(reservedMatch.sourceRow); unchanged++; continue }
    const choice = choices[r.sourceRow]
    const candidates = (byIdentity.get(identityKeyOf(r)) ?? []).filter(local => !claimed.has(local.sourceRow))
    let local = exact.get(r)
    if (choice === 'new') { if (local) claimed.delete(local.sourceRow); local = undefined }
    else if (typeof choice === 'number') {
      const selected = existing.find(local => local.sourceRow === choice && !local.soldLotId && identityKeyOf(local) === identityKeyOf(r))
      if (!selected || (claimed.has(choice) && selected !== local)) {
        conflicts.push({ incoming: r, candidates, reason: '所选来源已变化或被其它行使用，请重新核对' }); continue
      }
      if (local && local !== selected) claimed.delete(local.sourceRow)
      local = selected
    } else if (!local) {
      // 同内容多重性也可能是合法重复成交，不能靠队列顺序判断哪一笔。
      const identical = candidates.filter(candidate => importDiffFields(candidate, r).length === 0)
      if (candidates.some(c => c.deletedAt) || candidates.length > 1 || (r.buyPriceCents === null && candidates.length > 0 && identical.length === 0)) {
        conflicts.push({ incoming: r, candidates, reason: '同身份存在多个记录、已删除历史或裸卖缺稳定身份，需选择已有记录或明确新增' }); continue
      }
      local = candidates[0]
    }
    if (local?.deletedAt && choice === undefined) { conflicts.push({ incoming: r, candidates: [local], reason: '这笔已删除，请选择跳过或核对后另记，不能自动恢复' }); continue }
    if (local) claimed.add(local.sourceRow)
    if (!local) {
      const similar = [
        ...(r.buyPriceCents !== null && r.buyQtyRaw ? similarFacts(facts, 'buy', r.stockName, serialToIso(r.buyDateSerial), r.buyPriceCents, r.buyQtyRaw) : []),
        ...(r.targetPriceCents !== null && r.soldQty ? similarFacts(facts, 'sell', r.stockName, serialToIso(r.sellDateSerial), r.targetPriceCents, r.soldQty) : []),
      ]
      if (choice !== 'new' && similar.length) {
        conflicts.push({ incoming: r, candidates: [], reason: `已存在相似成交 ${similar.map(f => f.id).join('、')}；若已记过请选择跳过，确为另一笔才新增` }); continue
      }
      let id = r.sourceRow
      if (used.has(id)) {
        while (used.has(nextId) || reserved.has(nextId)) nextId++
        if (nextId >= 100000) throw new Error('导入记录 ID 空间已满')
        id = nextId++
      }
      used.add(id)
      fresh.push({ ...r, sourceRow: id, excelRow: r.excelRow ?? r.sourceRow })
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
    // 缺列与显式留空不同：没有提供的字段保留原值，避免重导时清掉已成交数据。
    const protectedKeys: Record<string, ImportUpdatableKey[]> = {
      soldQty: ['soldQty'], sellDate: ['sellDateSerial', 'sellDateNeedsToday'],
      target: ['targetPriceCents', 'targetNeedsDerive'], earlyBuy: ['earlyBuyPriceCents'], profit: ['rawProfitCents'],
    }
    for (const column of missingColumns) for (const key of protectedKeys[column] ?? []) {
      Object.assign(merged, { [key]: local[key] })
    }
    if (importDiffFields(local, merged).length > 0) updates.push({ from: local, to: merged })
    else unchanged += 1
  }
  return { fresh, updates, unchanged, conflicts }
}

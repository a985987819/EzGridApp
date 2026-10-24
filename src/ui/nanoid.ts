/**
 * nanoId：行级身份的短 id，明细展示、筛选与跨页跳转的唯一依据（TradesQuery.id）。
 *
 * 生成规则 = importKey 的 cyrb53 哈希 → base36（约 10~11 位）：
 * - importKey 导入后永不改写（P9），所以 nanoId 稳定，刷新 / 换会话 / 重新解析都一致；
 * - 不落库、无需迁移，历史数据即取即用；
 * - 同库内唯一性由 buildNanoIdIndex 兜底：极小概率撞哈希时按行号序追加 -2/-3。
 */

import type { RawRecord } from '../domain/types'

export function nanoIdOf(importKey: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < importKey.length; i += 1) {
    const ch = importKey.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  // 53 位 = h2 低 21 位拼 h1 全 32 位；base36 后 10~11 个字符
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export interface NanoIdIndex {
  /** nanoId → 原始行 */
  byId: Map<string, RawRecord>
  /** Excel 行号 → nanoId（挂单 / 统计这些手里只有 sourceRow 的跳转方用） */
  rowToId: Map<number, string>
}

/**
 * 一个数据集内的 nanoId 索引。按行号序遍历，撞哈希的后来者追加 -2/-3，
 * 同一批数据下结果确定，重复渲染不会漂移。
 */
export function buildNanoIdIndex(records: readonly RawRecord[]): NanoIdIndex {
  const byId = new Map<string, RawRecord>()
  const rowToId = new Map<number, string>()
  const seen = new Map<string, number>()
  const ordered = [...records].sort((a, b) => a.sourceRow - b.sourceRow)
  for (const rec of ordered) {
    const base = nanoIdOf(rec.importKey)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const id = n === 1 ? base : `${base}-${n}`
    byId.set(id, rec)
    rowToId.set(rec.sourceRow, id)
  }
  return { byId, rowToId }
}

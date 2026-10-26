/**
 * 记录序号（V9.43）：界面统一用「第 N 笔」称呼一条记录，Excel 行号只做追溯。
 *
 * 序号按录入顺序派生，不落库、无需迁移：
 * - 导入批次写入时带 `batchId = batch:<ts>`，同批按 Excel 行号排；
 * - 手工新增的 importKey 尾部带毫秒时间戳；
 * - 软删除的行仍占号，删一笔不会让后面的整体跳号；
 * - 老备份里没有 batchId 的行视为最早录入，排在最前面。
 *
 * 后导入的 Excel 批次即使行号更小，也整体排在已录入数据之后——
 * Excel 只是初始化，之后以项目自己的录入顺序为准。
 */

import { isSandboxRow } from './sandbox'
import type { RawRecord } from './types'

const BATCH_AT = /^batch:(\d+)$/
const MANUAL_AT = /^manual:.*:(\d+)$/

export interface RecordNoIndex {
  /** sourceRow → 第几笔（软删除的行也在内） */
  byRow: Map<number, number>
  /** 已有记录数（含软删除；新记录追加即 total + 1） */
  total: number
  of(row: number): number | null
}

function enteredAt(r: RawRecord): number {
  const batch = r.batchId ? BATCH_AT.exec(r.batchId) : null
  if (batch) return Number(batch[1])
  if (r.origin === 'manual') {
    const manual = MANUAL_AT.exec(r.importKey)
    if (manual) return Number(manual[1])
  }
  return 0
}

export function buildRecordNoIndex(records: readonly RawRecord[]): RecordNoIndex {
  const ordered = [...records].sort(
    (a, b) => enteredAt(a) - enteredAt(b) || a.sourceRow - b.sourceRow,
  )
  const byRow = new Map<number, number>()
  ordered.forEach((r, i) => byRow.set(r.sourceRow, i + 1))
  return { byRow, total: ordered.length, of: (row) => byRow.get(row) ?? null }
}

/** 界面称呼：第 N 笔 / 模拟批次 / 回补批次；找不到序号时用 fallback */
export function recordNoLabel(row: number, index: RecordNoIndex, fallback = '记录'): string {
  if (isSandboxRow(row)) return '模拟批次'
  const n = index.of(row)
  if (n !== null) return `第 ${n} 笔`
  if (row >= 200000) return '回补批次'
  return fallback
}

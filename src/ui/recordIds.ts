/** URL 中的记录 ID 列表；保留未知 ID，让无效深链继续匹配为空而非串成全列表。 */
export function normalizeRecordIds(value: string | null | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(id => id.trim()).filter(Boolean))]
}

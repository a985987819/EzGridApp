/** 账户筛选（V7）：只影响展示与清单，不改原始数据。 */

import { DEFAULT_ACCOUNT_ID } from './types'
import type { RawRecord } from './types'

export function accountIdOf(r: Pick<RawRecord, 'accountId'>): string {
  return r.accountId ?? DEFAULT_ACCOUNT_ID
}

/** activeId = 'all' 时不筛 */
export function filterByAccount<T extends Pick<RawRecord, 'accountId'>>(records: T[], activeId: string): T[] {
  if (activeId === 'all') return records
  return records.filter((r) => accountIdOf(r) === activeId)
}

export function countByAccount(records: RawRecord[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of records) {
    if (r.deletedAt) continue
    const id = accountIdOf(r)
    map.set(id, (map.get(id) ?? 0) + 1)
  }
  return map
}

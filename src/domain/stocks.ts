/** 股票排序与启用：一份顺序，全站共用。 */

import type { StockConfig } from './types'

/** 补齐 order / enabled 并压平序号（0 起，连续） */
export function normalizeStocks(list: StockConfig[]): StockConfig[] {
  return list
    .map((s, i) => ({
      ...s,
      order: typeof s.order === 'number' ? s.order : i,
      enabled: s.enabled !== false,
    }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s, i) => ({ ...s, order: i }))
}

/** 参与展示与清单的股票（停用的不出现） */
export function activeStocks(list: StockConfig[]): StockConfig[] {
  return normalizeStocks(list).filter((s) => s.enabled)
}

export function activeStockNames(list: StockConfig[]): string[] {
  return activeStocks(list).map((s) => s.name)
}

export function stockOrderMap(list: StockConfig[]): Map<string, number> {
  const map = new Map<string, number>()
  normalizeStocks(list).forEach((s, i) => map.set(s.name, i))
  return map
}

/** 把 from 位置的元素移到 to（数组下标，越界自动收敛） */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list
  const target = Math.max(0, Math.min(list.length - 1, to))
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/** 按 id 顺序重排并压平 order，返回可直接落库的数组 */
export function applyOrder(list: StockConfig[], orderedIds: string[]): StockConfig[] {
  const byId = new Map(list.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const result: StockConfig[] = []
  orderedIds.forEach((id) => {
    const s = byId.get(id)
    if (s && !seen.has(id)) {
      seen.add(id)
      result.push({ ...s, order: result.length })
    }
  })
  // 兜底：orderedIds 里没提到的股票按原 order 追加到末尾
  list
    .filter((s) => !seen.has(s.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((s) => result.push({ ...s, order: result.length }))
  return result
}

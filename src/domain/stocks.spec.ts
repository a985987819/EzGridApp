import { describe, expect, it } from 'vitest'
import { activeStocks, applyOrder, moveItem, normalizeStocks, stockOrderMap } from './stocks'
import type { StockConfig } from './types'

function stock(name: string, order?: number, enabled?: boolean): StockConfig {
  return {
    id: `stock:${name}`,
    name,
    intervalCents: 57,
    priceLimitType: 'main_10',
    ...(order === undefined ? {} : { order }),
    ...(enabled === undefined ? {} : { enabled }),
  }
}

describe('股票排序 / 启停', () => {
  it('老数据补 order 与 enabled，并按 order 排序、压平序号', () => {
    // A 没有 order → 用所在下标 0；C 有 1；B 有 5 → A, C, B
    const out = normalizeStocks([stock('A'), stock('B', 5), stock('C', 1)])
    expect(out.map((s) => s.name)).toEqual(['A', 'C', 'B'])
    expect(out.map((s) => s.order)).toEqual([0, 1, 2])
    expect(out.every((s) => s.enabled === true)).toBe(true)
  })

  it('停用的股票不进 activeStocks，但仍在全量里', () => {
    const list = normalizeStocks([stock('A', 0, false), stock('B', 1, true)])
    expect(activeStocks(list).map((s) => s.name)).toEqual(['B'])
    expect(list).toHaveLength(2)
  })

  it('moveItem 上移下移与越界收敛', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('applyOrder 按给定 id 顺序重排并落 order', () => {
    const list = normalizeStocks([stock('A'), stock('B'), stock('C')])
    const out = applyOrder(list, ['stock:C', 'stock:A', 'stock:B'])
    expect(out.map((s) => s.name)).toEqual(['C', 'A', 'B'])
    expect(out.map((s) => s.order)).toEqual([0, 1, 2])
  })

  it('applyOrder 漏掉的股票兜底追加到末尾', () => {
    const list = normalizeStocks([stock('A'), stock('B'), stock('C')])
    const out = applyOrder(list, ['stock:B'])
    expect(out.map((s) => s.name)).toEqual(['B', 'A', 'C'])
    expect(out.map((s) => s.order)).toEqual([0, 1, 2])
  })

  it('stockOrderMap 给每个名字一个稳定序号', () => {
    const list = normalizeStocks([stock('A'), stock('B', 3), stock('C', 1)])
    const map = stockOrderMap(list)
    expect(map.get('A')).toBe(0)
    expect(map.get('C')).toBe(1)
    expect(map.get('B')).toBe(2)
  })
})

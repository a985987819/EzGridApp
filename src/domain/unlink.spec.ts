/**
 * 删行/回滚导入之后，指向这些行号的关联必须一起清（V9.56）。
 * 关键点：导入会复用 Excel 行号，旧关联不清就会被下一笔交易「继承」。
 */
import { describe, expect, it } from 'vitest'
import { cleanupRowLinks, type RowLinkTables } from './unlink'
import type { ExtraBuyTarget, ExtraTarget, HedgeLink, LotMergeLink, RepairChainLink, TradePlan } from './types'

const empty = (): RowLinkTables => ({
  hedges: [],
  buyTargets: [],
  extraTargets: [],
  merges: [],
  chainLinks: [],
  plans: [],
})

const hedge = (sellRow: number, items: { row: number; qty: number }[]): HedgeLink => ({
  id: `hedge:${sellRow}`,
  sellRow,
  items,
  at: 1,
})

describe('删行后的关联清理', () => {
  it('卖出那笔没了 → 整条挂钩作废，并统计被清掉的股数', () => {
    const out = cleanupRowLinks(new Set([9]), {
      ...empty(),
      hedges: [hedge(9, [{ row: 2, qty: 300 }, { row: 3, qty: 200 }]), hedge(10, [{ row: 2, qty: 100 }])],
    })
    expect(out.hedges.map((h) => h.sellRow)).toEqual([10])
    expect(out.changed.hedges).toBe(1)
    expect(out.hedgeQty).toBe(500)
  })

  it('只删了被挂的一个批次 → 摘掉那条 item，挂钩本身留着', () => {
    const out = cleanupRowLinks(new Set([3]), {
      ...empty(),
      hedges: [hedge(9, [{ row: 2, qty: 300 }, { row: 3, qty: 200 }])],
    })
    expect(out.hedges).toHaveLength(1)
    expect(out.hedges[0].items).toEqual([{ row: 2, qty: 300 }])
    expect(out.changed.hedges).toBe(1)
    expect(out.hedgeQty).toBe(200)
  })

  it('拆分买入 / 拆分卖出 / 计划价：按行号清掉', () => {
    const bt: ExtraBuyTarget[] = [
      { id: 'bt:9:1', sellRow: 9, priceCents: 500, qty: 100, at: 1 },
      { id: 'bt:10:1', sellRow: 10, priceCents: 500, qty: 100, at: 2 },
    ]
    const et: ExtraTarget[] = [
      { id: 'et:2', lotId: 'lot:2', priceCents: 900, qty: 100, at: 1 },
      { id: 'et:exec', lotId: 'lot:exec:abc', priceCents: 900, qty: 100, at: 2 },
    ]
    const plans: TradePlan[] = [
      { id: 'p1', kind: 'buy', refId: 'rb:sell:9', priceCents: 500, qty: 100, at: 1 },
      { id: 'p2', kind: 'sell', refId: 'target:lot:2', priceCents: 900, qty: 100, at: 2 },
      { id: 'p3', kind: 'sell', refId: 'sell:柳工:780', priceCents: 780, qty: 100, at: 3 },
    ]
    const out = cleanupRowLinks(new Set([9, 2]), { ...empty(), buyTargets: bt, extraTargets: et, plans })
    expect(out.buyTargets.map((t) => t.sellRow)).toEqual([10])
    // 虚拟回补批次（lot:exec:*）认不出行号 → 不碰
    expect(out.extraTargets.map((t) => t.lotId)).toEqual(['lot:exec:abc'])
    // 价格型计划身份认不出属于哪一行 → 留着（宁可不删，也不能误删别人的改单）
    expect(out.plans.map((p) => p.id)).toEqual(['p3'])
    expect(out.changed).toMatchObject({ buyTargets: 1, extraTargets: 1, plans: 2 })
  })

  it('合并组少了成员：剩 1 笔就散组，挂在组上的计划价一起清', () => {
    const merges: LotMergeLink[] = [
      { id: 'merge:16', stockName: '柳工', priceCents: 961, rows: [16, 22], at: 1 },
      { id: 'merge:30', stockName: '柳工', priceCents: 900, rows: [30, 31, 32], at: 2 },
    ]
    const plans: TradePlan[] = [
      { id: 'pA', kind: 'sell', refId: 'merge:16@961', priceCents: 961, qty: 200, at: 1 },
      { id: 'pB', kind: 'sell', refId: 'merge:30@900', priceCents: 900, qty: 300, at: 2 },
    ]
    const out = cleanupRowLinks(new Set([22, 32]), { ...empty(), merges, plans })
    expect(out.merges.map((m) => m.rows)).toEqual([[30, 31]])
    expect(out.plans.map((p) => p.id)).toEqual(['pB'])
    expect(out.changed).toMatchObject({ merges: 2, plans: 1 })
  })

  it('回本链归属：锚点没了整条删；成员没了只摘成员、保留「已结束」', () => {
    const chainLinks: RepairChainLink[] = [
      { id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [3, 4], closedAt: null, at: 1 },
      { id: 'chainlink:5', anchorRow: 5, stockName: '柳工', memberRows: [6], closedAt: 123, at: 2 },
    ]
    const out = cleanupRowLinks(new Set([2, 6]), { ...empty(), chainLinks })
    expect(out.chainLinks.map((c) => [c.id, c.memberRows, c.closedAt])).toEqual([['chainlink:5', [], 123]])
    expect(out.changed.chainLinks).toBe(2)
  })

  it('没涉及的表原样返回（不复制、不重排）', () => {
    const tables: RowLinkTables = {
      hedges: [hedge(9, [{ row: 2, qty: 100 }])],
      buyTargets: [],
      extraTargets: [],
      merges: [],
      chainLinks: [],
      plans: [],
    }
    const out = cleanupRowLinks(new Set([999]), tables)
    expect(out.hedges[0]).toBe(tables.hedges[0])
    expect(Object.values(out.changed).every((n) => n === 0)).toBe(true)
    expect(out.hedgeQty).toBe(0)
  })
})

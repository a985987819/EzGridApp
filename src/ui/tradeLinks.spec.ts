import { describe, expect, it } from 'vitest'
import type { RawRecord } from '../domain/types'
import { buildNanoIdIndex } from './nanoid'
import { buildTradeSourceIndex, tradeSourceLink } from './tradeLinks'

const records = [
  { sourceRow: 3, stockName: '柳工', importKey: 'a' },
  { sourceRow: 5, stockName: '柳工', importKey: 'b', deletedAt: 1 },
  { sourceRow: 6, stockName: '其它', importKey: 'c' },
] as RawRecord[]
const nano = buildNanoIdIndex(records)
const lots = [
  { id: 'lot:3', sourceRow: 3 },
  { id: 'lot:5', sourceRow: 5 },
  { id: 'lot:exec:a', sourceRow: 200000 },
  { id: 'lot:exec:b', sourceRow: 200001 },
  { id: 'lot:exec:lost', sourceRow: 200002 },
]
const executions = [{ id: 'a', sellExecId: 'sell:5' }, { id: 'b', sellExecId: 'sell:5' }]
const index = buildTradeSourceIndex(nano, lots, executions)

describe('挂单来源跳明细', () => {
  it('合并的多笔只带实际来源，重复拆档去重，软删源仍可追溯', () => {
    const link = tradeSourceLink('柳工', [3, 5, 3], index)
    expect(link).toEqual({ query: { stock: '柳工', id: `${nano.rowToId.get(3)},${nano.rowToId.get(5)}` }, rows: [3, 5], missing: false })
  })

  it('虚拟回补批次解析至原卖出记录，多批次同源不重复', () => {
    const link = tradeSourceLink('柳工', [
      { sourceRow: 3, lotId: 'lot:3' },
      { sourceRow: 200000, lotId: 'lot:exec:a' },
      { sourceRow: 200001, lotId: 'lot:exec:b' },
    ], index)
    expect(link.rows).toEqual([3, 5])
    expect(link.query?.id).toBe(`${nano.rowToId.get(3)},${nano.rowToId.get(5)}`)
    expect(tradeSourceLink('柳工', [200000], index).rows).toEqual([5])
  })

  it('lot身份优先于虚拟段行号，避免真实手工行与虚拟行号冲突', () => {
    const collisionNano = buildNanoIdIndex([...records, { sourceRow: 200000, stockName: '柳工', importKey: 'real' } as RawRecord])
    const collision = buildTradeSourceIndex(collisionNano, lots, executions)
    expect(tradeSourceLink('柳工', [{ sourceRow: 200000, lotId: 'lot:exec:a' }], collision).rows).toEqual([5])
    expect(tradeSourceLink('柳工', [200000], collision).rows).toEqual([200000])
  })

  it('空来源、部分失联或错股均不退成整股查询', () => {
    for (const refs of [[], [3, 999], [3, 6], [{ sourceRow: 200002, lotId: 'lot:exec:lost' }]]) {
      const link = tradeSourceLink('柳工', refs, index)
      expect(link.query).toBeNull()
      expect(link.missing).toBe(true)
    }
  })

  it('非法执行来源不猜原记录，输入保持不变', () => {
    const before = JSON.stringify({ records, lots, executions })
    const invalid = buildTradeSourceIndex(nano, lots, [{ id: 'a', sellExecId: 'sell:hedged:5' }])
    expect(tradeSourceLink('柳工', [200000], invalid).query).toBeNull()
    expect(JSON.stringify({ records, lots, executions })).toBe(before)
  })
})

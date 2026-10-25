import { describe, expect, it } from 'vitest'
import { monthRange, parseTradesQuery, serializeTradesQuery } from './nav'

describe('明细筛选的 URL 序列化（S7）', () => {
  it('serialize → parse round-trip 保留全部条件', () => {
    const q = {
      stock: '柳工',
      status: ['pending', 'sellDateMissing'],
      price: 801,
      from: '2026-02-01',
      to: '2026-02-28',
      id: 'k3x09v2f',
      sort: 'profitDesc',
      del: true,
      showDone: true,
    }
    expect(parseTradesQuery(serializeTradesQuery(q))).toEqual(q)
  })

  it('中文股票名编解码无损', () => {
    const back = parseTradesQuery(serializeTradesQuery({ stock: '三一重工' }))
    expect(back.stock).toBe('三一重工')
  })

  it('空条件序列化为空串；parse 空串得空对象', () => {
    expect(serializeTradesQuery({})).toBe('')
    expect(parseTradesQuery('')).toEqual({})
  })

  it('parse 忽略未知参数（向前兼容）', () => {
    const back = parseTradesQuery('stock=柳工&futureFlag=1')
    expect(back).toEqual({ stock: '柳工' })
  })
})

describe('monthRange（月度成交 → 明细日期区间）', () => {
  it('平年 2 月 / 闰年 2 月 / 12 月', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('非法输入返回空区间', () => {
    expect(monthRange('bad')).toEqual({ from: '', to: '' })
  })
})

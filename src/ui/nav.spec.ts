import { describe, expect, it } from 'vitest'
import { buildManageHash, monthRange, parseManageQuery, parseTradesQuery, serializeTradesQuery } from './nav'

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

describe('管理页和指南的深链', () => {
  it('刷新/分享保留文档、搜索和阅读锚点', () => {
    const query = { section: 'guide' as const, doc: 'boundaries', anchor: 'c01', mode: 'issues' as const, q: '回本 库存', category: '回本链' }
    const hash = buildManageHash(query)
    expect(parseManageQuery(hash.split('?')[1])).toEqual(query)
    expect(buildManageHash()).toBe('#/manage')
    expect(parseManageQuery('section=backup&doc=irrelevant')).toEqual({ section: 'backup' })
  })
  it('未知管理入口回菜单，不把恶意长查询直接带进阅读状态', () => {
    expect(parseManageQuery('section=unknown&doc=guide')).toEqual({})
    expect(parseManageQuery(`section=guide&q=${'a'.repeat(500)}`).q).toHaveLength(160)
    expect(parseManageQuery('section=guide&mode=unknown')).toEqual({ section: 'guide' })
  })
})

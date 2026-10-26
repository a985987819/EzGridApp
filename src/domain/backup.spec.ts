import { describe, expect, it } from 'vitest'
import { validateBackup, type BackupShape } from './backup'

const goodRecord = { sourceRow: 1, importKey: 'k1', stockName: '柳工' }
const goodStock = { id: 'stock:柳工', name: '柳工', intervalCents: 57 }

describe('恢复前的备份内容校验', () => {
  it('合法备份通过', () => {
    expect(validateBackup({ schemaVersion: 5, records: [goodRecord], stocks: [goodStock] })).toBeNull()
  })

  it('只带部分表的备份（空对象）也通过', () => {
    expect(validateBackup({})).toBeNull()
  })

  it('records 非数组拒绝', () => {
    expect(validateBackup({ records: 'nope' })).toBe('records 不是数组')
  })

  it('records 缺 importKey / sourceRow / stockName 拒绝', () => {
    expect(validateBackup({ records: [{ sourceRow: 1, stockName: '柳工' }] })).toContain('importKey')
    expect(validateBackup({ records: [{ importKey: 'k', stockName: '柳工' }] })).toContain('sourceRow')
    expect(validateBackup({ records: [{ sourceRow: 1, importKey: 'k' }] })).toContain('stockName')
  })

  it('stocks 缺 intervalCents 拒绝', () => {
    expect(validateBackup({ stocks: [{ id: 's', name: '柳工' }] })).toContain('intervalCents')
  })

  it('挂钩分配 items 缺失/坏掉要拒绝（否则恢复后 buildLedger 会抛异常）', () => {
    // V9.32：以前完全没校验 —— hedges: [{}] 能过，恢复后 for..of h.items 直接 TypeError
    expect(validateBackup({ hedges: [{ id: 'hedge:3', sellRow: 3 }] })).toContain('items')
    expect(validateBackup({ hedges: [{ id: 'hedge:3', sellRow: 3, items: [{ qty: 100 }] }] })).toContain('row')
    expect(validateBackup({ hedges: [{ sellRow: 3, items: [] }] })).toContain('id')
    expect(validateBackup({ hedges: 'nope' })).toBe('hedges 不是数组')
    expect(
      validateBackup({ hedges: [{ id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 500 }] }] }),
    ).toBeNull()
  })

  it('回补成交/计划/拆分目标缺关键字段也拒绝', () => {
    expect(validateBackup({ rebuyExecutions: [{ id: 'e1', orderId: 'rb:sell:3' }] })).toContain('sellExecId')
    expect(validateBackup({ plans: [{ id: 'p1', refId: 'rb:sell:3', priceCents: 780 }] })).toContain('qty')
    expect(validateBackup({ extraTargets: [{ id: 'et1', lotId: 'lot:2', priceCents: 900 }] })).toContain('qty')
  })

  it('老备份里的 accounts 段直接忽略（账户功能已删除）', () => {
    // V9.32 删账户：老备份的 accounts 段不再是已知字段，但绝不能因此拒收
    const legacy = { schemaVersion: 6, accounts: [{ name: '2027 年' }] } as unknown as BackupShape
    expect(validateBackup(legacy)).toBeNull()
  })

  it('合并同价买单 rows 至少两笔、必须是整数行号（V9.45）', () => {
    expect(validateBackup({ merges: [{ id: 'merge:16', stockName: '柳工', priceCents: 961, rows: [16] }] })).toContain('rows')
    expect(
      validateBackup({ merges: [{ id: 'merge:16', stockName: '柳工', priceCents: 961, rows: [16, 'x'] }] }),
    ).toContain('整数行号')
    expect(validateBackup({ merges: [{ id: 'merge:16', priceCents: 961, rows: [16, 22] }] })).toContain('stockName')
    expect(
      validateBackup({ merges: [{ id: 'merge:16', stockName: '柳工', priceCents: 961, rows: [16, 22] }] }),
    ).toBeNull()
    expect(validateBackup({ merges: 'nope' })).toBe('merges 不是数组')
  })

  it('回本链归属缺 anchorRow/memberRows 拒绝，空成员（仅结束标记）放行（V9.46）', () => {
    expect(validateBackup({ chainLinks: [{ id: 'chainlink:2', stockName: '柳工' }] })).toContain('anchorRow')
    expect(
      validateBackup({ chainLinks: [{ id: 'chainlink:2', anchorRow: 2, memberRows: [3] }] }),
    ).toContain('stockName')
    expect(
      validateBackup({ chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: ['x'] }] }),
    ).toContain('整数行号')
    expect(
      validateBackup({
        chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [3], closedAt: 'nope' }],
      }),
    ).toContain('closedAt')
    expect(
      validateBackup({ chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [], closedAt: 1 }] }),
    ).toBeNull()
    expect(validateBackup({ chainLinks: 'nope' })).toBe('chainLinks 不是数组')
  })
})

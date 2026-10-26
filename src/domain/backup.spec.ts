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

  /**
   * V9.56：结构对 ≠ 引用对。指向不存在的行时 buildLedger 是静默跳过的（挂钩失效、
   * soldLotId 找不到成本 → 盈亏变 null 不计入），界面却提示恢复成功 —— 宁可整包拒绝。
   */
  it('引用不存在的行一律拒绝（V9.56）', () => {
    const records = [
      { sourceRow: 2, importKey: 'k2', stockName: '柳工' },
      { sourceRow: 3, importKey: 'k3', stockName: '柳工' },
    ]
    expect(
      validateBackup({ records, hedges: [{ id: 'hedge:9', sellRow: 9, items: [{ row: 2, qty: 500 }] }] }),
    ).toContain('不存在的卖出行 9')
    expect(
      validateBackup({ records, hedges: [{ id: 'hedge:3', sellRow: 3, items: [{ row: 77, qty: 500 }] }] }),
    ).toContain('不存在的买入行 77')
    expect(validateBackup({ records, buyTargets: [{ id: 'bt', sellRow: 9, priceCents: 500, qty: 100 }] })).toContain('buyTargets[0]')
    expect(
      validateBackup({ records, extraTargets: [{ id: 'et', lotId: 'lot:9', priceCents: 500, qty: 100, at: 1 }] }),
    ).toContain('extraTargets[0]')
    expect(
      validateBackup({ records, merges: [{ id: 'merge:2', stockName: '柳工', priceCents: 500, rows: [2, 9], at: 1 }] }),
    ).toContain('merges[0].rows[1]')
    expect(
      validateBackup({
        records,
        chainLinks: [{ id: 'chainlink:2', anchorRow: 2, stockName: '柳工', memberRows: [9], closedAt: null, at: 0 }],
      }),
    ).toContain('memberRows[0]')
    expect(
      validateBackup({ records, plans: [{ id: 'p', kind: 'buy', refId: 'rb:sell:9', priceCents: 500, qty: 100, at: 1 }] }),
    ).toContain('plans[0]')
    expect(
      validateBackup({
        records,
        rebuyExecutions: [
          { id: 'e', orderId: 'rb:sell:9', sellExecId: 'sell:9', stockId: 's', stockName: '柳工', qty: 100, priceCents: 500, rewardQty: 0, groupKeyAtExecution: 'k', at: 1 },
        ],
      }),
    ).toContain('rebuyExecutions[0]')
    // 全部指到存在的行 → 放行（虚拟批次 lot:exec:* 与价格型计划身份认不出，不拦）
    expect(
      validateBackup({
        records,
        hedges: [{ id: 'hedge:3', sellRow: 3, items: [{ row: 2, qty: 500 }] }],
        extraTargets: [{ id: 'et', lotId: 'lot:exec:abc', priceCents: 500, qty: 100, at: 1 }],
        plans: [
          { id: 'p', kind: 'buy', refId: 'rb:sell:3', priceCents: 500, qty: 100, at: 1 },
          { id: 'q', kind: 'sell', refId: 'sell:柳工:780', priceCents: 780, qty: 100, at: 2 },
        ],
      }),
    ).toBeNull()
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

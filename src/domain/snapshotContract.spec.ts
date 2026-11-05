import { describe, expect, it } from 'vitest'
import { prepareBackup, validateBackup } from './backup'
import { DEFAULT_STOCKS } from './defaults'
import type { LedgerSnapshot } from './ledgerSnapshot'

function validSnapshot(): LedgerSnapshot {
  return {
    schemaVersion: 14, exportedAt: '2026-11-05T00:00:00.000Z', settings: { deriveSellPrice: false },
    stocks: structuredClone(DEFAULT_STOCKS),
    records: [{ sourceRow: 1, importKey: 'snapshot:1', stockName: '柳工', buyDateSerial: 46000,
      buyPriceCents: 500, buyQtyRaw: 500, qtyNeedsDerive: false, targetPriceCents: 700,
      targetNeedsDerive: false, soldQty: null, sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null }],
    batches: [], auditLogs: [], rebuyExecutions: [], plans: [], extraTargets: [], buyTargets: [],
    hedges: [], merges: [], chainLinks: [], bookingReceipts: [],
  }
}

describe('当前快照的完整契约', () => {
  it('结构14缺少必需交易字段必须拒绝，不能把不完整数据当成正常记录', () => {
    const snapshot = validSnapshot()
    expect(validateBackup(snapshot)).toBeNull()
    snapshot.records = [{ sourceRow: 1, stockName: '柳工', importKey: 'incomplete' }] as typeof snapshot.records
    expect(validateBackup(snapshot)).toContain('buyDateSerial')
  })

  it('当前文件所有交易必需字段和表都必须齐全，未知交易字段显式为null', () => {
    for (const key of ['buyDateSerial', 'buyPriceCents', 'buyQtyRaw', 'targetPriceCents', 'soldQty', 'sellDateSerial', 'earlyBuyPriceCents', 'rawProfitCents', 'qtyNeedsDerive', 'targetNeedsDerive']) {
      const snapshot = validSnapshot()
      delete (snapshot.records[0] as unknown as Record<string, unknown>)[key]
      expect(validateBackup(snapshot), key).toContain(key)
    }
    for (const key of Object.keys(validSnapshot()).filter(key => !['schemaVersion', 'exportedAt'].includes(key))) {
      const snapshot = validSnapshot() as unknown as Record<string, unknown>
      delete snapshot[key]
      expect(() => prepareBackup(snapshot), key).toThrow()
    }
  })

  it('零、负数和超安全整数的行身份都拒绝，不靠Number.isInteger放行', () => {
    for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const snapshot = validSnapshot(); snapshot.records[0].sourceRow = value
      expect(validateBackup(snapshot)).toContain('sourceRow')
    }
  })

  it('JSON和完整Excel共用来源股票约束，跨股票引用不能静默变成本缺失', () => {
    const snapshot = validSnapshot()
    snapshot.records.push({ ...snapshot.records[0], sourceRow: 2, stockName: '三一重工', importKey: 'child', soldLotId: 'lot:1', buyQtyRaw: null, soldQty: 100 })
    expect(validateBackup(snapshot)).toContain('股票不一致')
  })

  it('旧格式先补明确缺省再检查，迁移不修改原对象或挪用本机另一份台账设置', () => {
    const legacy = { schemaVersion: 13, records: [{ sourceRow: 1, stockName: '柳工', importKey: 'old' }] }
    const original = structuredClone(legacy)
    const snapshot = prepareBackup(legacy)
    expect(legacy).toEqual(original)
    expect(snapshot).toMatchObject({ schemaVersion: 14, settings: { deriveSellPrice: false }, batches: [], rebuyExecutions: [], plans: [], bookingReceipts: [] })
    expect(snapshot.records[0]).toMatchObject({ buyDateSerial: null, buyQtyRaw: null, soldQty: null, qtyNeedsDerive: false, targetNeedsDerive: false })
    expect(validateBackup(snapshot)).toBeNull()
    expect(() => prepareBackup({ ...legacy, settings: null })).toThrow()
  })

  it('单笔与全账累计金额超限都在恢复前拒绝', () => {
    const snapshot = validSnapshot()
    snapshot.records[0] = { ...snapshot.records[0], buyPriceCents: 10 ** 10, buyQtyRaw: 10 ** 10 }
    expect(validateBackup(snapshot)).toContain('金额超出')
    snapshot.records = [1, 2, 3].map(sourceRow => ({ ...snapshot.records[0], sourceRow, importKey: `large:${sourceRow}`, buyPriceCents: 4 * 10 ** 15, buyQtyRaw: 1 }))
    expect(validateBackup(snapshot)).toContain('累计买入金额')
  })

  it('数量派生标记不能覆盖已有实际股数而绕过现金校验', () => {
    const snapshot = validSnapshot()
    snapshot.records[0] = { ...snapshot.records[0], qtyNeedsDerive: true, buyPriceCents: 10 ** 10, buyQtyRaw: 10 ** 10 }
    expect(validateBackup(snapshot)).toContain('金额超出')
  })

  it('回补成交不能引用一条从未卖出的纯买入记录', () => {
    const snapshot = validSnapshot()
    snapshot.rebuyExecutions = [{ id: 'orphan', orderId: 'rb:sell:1', sellExecId: 'sell:1', stockId: 'stock:柳工', stockName: '柳工', qty: 100, priceCents: 500, rewardQty: 0, groupKeyAtExecution: 'stock:柳工|500', at: 1000 }]
    expect(validateBackup(snapshot)).toContain('没有实际卖出股数')
  })
})

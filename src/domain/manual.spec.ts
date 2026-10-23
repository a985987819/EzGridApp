import { describe, expect, it } from 'vitest'
import { buildManualRecord, type ManualInput } from './manual'
import { applyEdits } from './edit'
import { buildLedger } from './ledger'
import { DEFAULT_STOCKS } from './defaults'

const base: ManualInput = { kind: 'buy', stockName: '柳工', date: '', price: '', qty: '' }

describe('手动新增：买入', () => {
  it('目标价留空 → 标记派生，ledger 按「买入价 + 间隔」算待卖', () => {
    const { record, errors } = buildManualRecord({ ...base, date: '2026-10-20', price: '8.01', qty: '700' }, 100001)
    expect(errors).toHaveLength(0)
    expect(record.targetPriceCents).toBeNull()
    expect(record.targetNeedsDerive).toBe(true)
    expect(record.buyPriceCents).toBe(801)
    expect(record.buyQtyRaw).toBe(700)

    const l = buildLedger([record], DEFAULT_STOCKS)
    expect(l.targets).toHaveLength(1)
    // 8.01 + 0.57 = 8.58
    expect(l.targets[0].priceCents).toBe(858)
    expect(l.totals.targetQty).toBe(700)
  })

  it('目标价填了就直接用，不再派生', () => {
    const { record } = buildManualRecord({ ...base, date: '2026-10-20', price: '8.01', qty: '700', targetPrice: '8.88' }, 100002)
    expect(record.targetPriceCents).toBe(888)
    expect(record.targetNeedsDerive).toBe(false)
    expect(buildLedger([record], DEFAULT_STOCKS).targets[0].priceCents).toBe(888)
  })

  it('缺价 / 缺量 / 缺股票都会被拒', () => {
    expect(buildManualRecord({ ...base, stockName: '' }, 1).errors.length).toBeGreaterThan(0)
    expect(buildManualRecord({ ...base, price: '' }, 1).errors).toContain('买入价不能为空')
    expect(buildManualRecord({ ...base, price: '8', qty: '' }, 1).errors).toContain('买入份额不能为空')
  })
})

describe('手动新增：卖出（先卖后买）', () => {
  it('不填买入信息 → 无批次卖出，进待补敞口', () => {
    const { record, errors } = buildManualRecord(
      { kind: 'sell', stockName: '柳工', date: '2026-10-21', price: '8.68', qty: '500', rebuyPrice: '8.01' },
      100003,
    )
    expect(errors).toHaveLength(0)
    expect(record.buyPriceCents).toBeNull()
    expect(record.soldQty).toBe(500)

    const l = buildLedger([record], DEFAULT_STOCKS)
    expect(l.sells).toHaveLength(1)
    expect(l.sells[0].sellBeforeBuy).toBe(true)
    expect(l.sells[0].rebuyStatus).toBe('pending')
    expect(l.orders).toHaveLength(1)
    expect(l.orders[0].exposure).toBe(true)
    expect(l.totals.exposureQty).toBe(500)
    expect(l.totals.netQty).toBe(-500)
    expect(l.totals.targetQty - l.totals.exposureQty).toBe(l.totals.netQty)
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('之后补上买入信息 → 生成批次与待卖，守恒仍成立', () => {
    const first = buildManualRecord(
      { kind: 'sell', stockName: '柳工', date: '2026-10-21', price: '8.68', qty: '500', rebuyPrice: '8.01' },
      100004,
    ).record
    const patched = applyEdits(first, { buyPrice: '8.01', buyQty: '500', buyDate: '2026-10-22' })
    expect(patched.errors).toHaveLength(0)

    const l = buildLedger([patched.record], DEFAULT_STOCKS)
    expect(l.lots).toHaveLength(1)
    expect(l.lots[0].remainingQty).toBe(0) // 买入 500 全部卖出
    expect(l.totals.netQty).toBe(0)
    expect(l.sells[0].sellBeforeBuy).toBe(true) // 卖出 10-21 早于买入 10-22
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('卖出时直接带买入信息 → 回补价取关联买入价（R3 第 2 级）', () => {
    const { record, errors } = buildManualRecord(
      {
        kind: 'sell',
        stockName: '柳工',
        date: '2026-10-21',
        price: '8.68',
        qty: '500',
        rebuyPrice: '',
        buyPrice: '8.01',
        buyQty: '500',
        buyDate: '2026-10-20',
      },
      100005,
      { intervalCents: 57 },
    )
    expect(errors).toHaveLength(0)
    expect(record.earlyBuyPriceCents).toBe(801)
    expect(record.rebuyPriceSource).toBe('lot')

    const l = buildLedger([record], DEFAULT_STOCKS)
    expect(l.sells[0].costCents).toBe(801)
    expect(l.sells[0].profitCents).toBe(33500) // (8.68-8.01)*500
    // R3：新增卖出默认生成待买；有批次所以不是空头敞口，是「回补再买入」
    expect(l.sells[0].rebuyStatus).toBe('pending')
    expect(l.orders).toHaveLength(1)
    expect(l.orders[0].rebuyPriceCents).toBe(801)
    expect(l.orders[0].exposure).toBe(false)
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('勾「已回补」→ 不生成待买（repaid）', () => {
    const { record, errors } = buildManualRecord(
      {
        kind: 'sell',
        stockName: '柳工',
        date: '2026-10-21',
        price: '8.68',
        qty: '500',
        rebuyPrice: '',
        repaid: true,
        buyPrice: '8.01',
        buyQty: '500',
        buyDate: '2026-10-20',
      },
      100008,
      { intervalCents: 57 },
    )
    expect(errors).toHaveLength(0)
    expect(record.earlyBuyPriceCents).toBeNull()
    expect(record.rebuyPriceSource).toBe('repaid')
    const l = buildLedger([record], DEFAULT_STOCKS)
    expect(l.sells[0].rebuyStatus).toBe('repaid')
    expect(l.orders).toHaveLength(0)
  })

  it('无买入信息、无回补价 → 卖出价 − 该股间隔（R3 第 4 级）', () => {
    const { record, errors } = buildManualRecord(
      { kind: 'sell', stockName: '柳工', date: '2026-10-21', price: '8.68', qty: '500' },
      100009,
      { intervalCents: 57 },
    )
    expect(errors).toHaveLength(0)
    // 8.68 − 0.57 = 8.11
    expect(record.earlyBuyPriceCents).toBe(811)
    expect(record.rebuyPriceSource).toBe('sellMinusInterval')

    const l = buildLedger([record], DEFAULT_STOCKS)
    expect(l.orders).toHaveLength(1)
    expect(l.orders[0].rebuyPriceCents).toBe(811)
    expect(l.orders[0].exposure).toBe(true) // 无批次 → 空头敞口
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('推不出回补价 → 报错要求手填（R3 无解）', () => {
    const { errors } = buildManualRecord(
      { kind: 'sell', stockName: '柳工', date: '2026-10-21', price: '8.68', qty: '500' },
      100010,
      { intervalCents: 0 },
    )
    expect(errors.join('｜')).toContain('算不出回补价')
  })

  it('卖出数量大于买入份额被拒', () => {
    const { errors } = buildManualRecord(
      { kind: 'sell', stockName: '柳工', date: '2026-10-21', price: '8.68', qty: '900', buyPrice: '8.01', buyQty: '500' },
      100006,
    )
    expect(errors.join('｜')).toContain('卖出数量不能大于买入份额')
  })

  it('卖出缺成交价被拒', () => {
    const { errors } = buildManualRecord({ kind: 'sell', stockName: '柳工', date: '2026-10-21', price: '', qty: '500' }, 100007)
    expect(errors).toContain('成交价不能为空')
  })
})

import { describe, expect, it } from 'vitest'
import { buildManualRecord, type ManualInput } from './manual'
import { buildLedger } from './ledger'
import { DEFAULT_STOCKS, serialToIso } from './defaults'
import { manualFormDefaults, resolveManualForm } from './formDefaults'

const today = '2026-10-26'
const blank: ManualInput = { kind: 'buy', stockName: '柳工', date: '', price: '', qty: '' }

function submit(input: ManualInput) {
  return buildManualRecord(resolveManualForm(input, today, 57), 100000, { intervalCents: 57 })
}

describe('表单留空采用占位默认值', () => {
  it('新增买入留空/仅空格，按界面默认价量和今天生成持仓及待卖', () => {
    const { record, errors } = submit({ ...blank, date: ' ', price: ' ', qty: ' ', targetPrice: ' ' })
    expect(errors).toEqual([])
    expect(record.buyPriceCents).toBe(801)
    expect(record.buyQtyRaw).toBe(700)
    expect(serialToIso(record.buyDateSerial)).toBe(today)
    expect(buildLedger([record], DEFAULT_STOCKS).targets[0]).toMatchObject({ priceCents: 858, qty: 700 })
  })

  it('新增卖出留空使用卖出默认价量，但不会凭空生成可选买入批次', () => {
    const { record, errors } = submit({ ...blank, kind: 'sell', buyPrice: ' ', buyQty: '', buyDate: ' ' })
    expect(errors).toEqual([])
    expect(record).toMatchObject({ targetPriceCents: 858, soldQty: 700, earlyBuyPriceCents: 801, buyPriceCents: null, buyQtyRaw: null, buyDateSerial: null })
    expect(buildLedger([record], DEFAULT_STOCKS).lots).toEqual([])
  })

  it('手填价格覆盖默认值，目标价/回补价随实际输入重新推导', () => {
    const buy = submit({ ...blank, price: '6', qty: '500' })
    expect(buildLedger([buy.record], DEFAULT_STOCKS).targets[0]).toMatchObject({ priceCents: 657, qty: 500 })
    const sell = submit({ ...blank, kind: 'sell', price: '7', qty: '500' })
    expect(sell.record.earlyBuyPriceCents).toBe(643)
    expect(manualFormDefaults({ ...blank, kind: 'sell', price: '7' }, today, 57).rebuyPrice).toBe('6.43')
  })

  it('显式目标价和回补价优先于默认推导值', () => {
    expect(submit({ ...blank, targetPrice: '9' }).record.targetPriceCents).toBe(900)
    expect(submit({ ...blank, kind: 'sell', rebuyPrice: '5' }).record.earlyBuyPriceCents).toBe(500)
  })

  it('开始填买入信息后，剩余买入字段按当前卖出数量和今天补齐', () => {
    const { record, errors } = submit({ ...blank, kind: 'sell', qty: '500', buyPrice: '6' })
    expect(errors).toEqual([])
    expect(record).toMatchObject({ buyPriceCents: 600, buyQtyRaw: 500, earlyBuyPriceCents: 600 })
    expect(serialToIso(record.buyDateSerial)).toBe(today)
    expect(manualFormDefaults({ ...blank, kind: 'sell', buyPrice: '6' }, today, 57).rebuyPrice).toBe('6.00')
  })

  it('仅填写可选买入份额时，采用显示的默认买入价和今天', () => {
    const { record, errors } = submit({ ...blank, kind: 'sell', qty: '500', buyQty: '500' })
    expect(errors).toEqual([])
    expect(record).toMatchObject({ buyPriceCents: 830, buyQtyRaw: 500, earlyBuyPriceCents: 830 })
  })

  it('非法但非空输入与显式 0 继续报错，不被默认值掩盖', () => {
    for (const input of [
      { ...blank, price: '错误' },
      { ...blank, price: '0' },
      { ...blank, qty: '12.5' },
      { ...blank, date: '2026-02-30' },
      { ...blank, targetPrice: 'abc' },
    ]) expect(submit(input).errors.length).toBeGreaterThan(0)
  })

  it('已回补开关继续优先于回补默认值', () => {
    const { record, errors } = submit({ ...blank, kind: 'sell', repaid: true })
    expect(errors).toEqual([])
    expect(record.earlyBuyPriceCents).toBeNull()
    expect(buildLedger([record], DEFAULT_STOCKS).orders).toEqual([])
  })
})

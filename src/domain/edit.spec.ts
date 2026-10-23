import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyEdits, fieldText, isoToSerial } from './edit'
import { serialToIso } from './defaults'
import { buildLedger } from './ledger'
import { DEFAULT_STOCKS } from './defaults'
import { parseWorkbook } from '../io/parseWorkbook'
import type { RawRecord } from './types'

let seq = 500
function rec(over: Partial<RawRecord> & { stockName: string }): RawRecord {
  seq += 1
  return {
    sourceRow: over.sourceRow ?? seq,
    buyDateSerial: 46000,
    buyPriceCents: null,
    buyQtyRaw: null,
    qtyNeedsDerive: false,
    targetPriceCents: null,
    targetNeedsDerive: false,
    soldQty: null,
    sellDateSerial: null,
    earlyBuyPriceCents: null,
    rawProfitCents: null,
    importKey: `k${seq}`,
    ...over,
  }
}

describe('日期序列号往返', () => {
  it('2026-10-23 → serial → 2026-10-23', () => {
    const serial = isoToSerial('2026-10-23')
    expect(serial).not.toBeNull()
    expect(serialToIso(serial)).toBe('2026-10-23')
  })
  it('空串 → null；坏格式 → null', () => {
    expect(isoToSerial('')).toBeNull()
    expect(isoToSerial('2026/10/23')).toBeNull()
    expect(isoToSerial('2026-13-45')).toBeNull()
  })
})

describe('行内编辑（P10）', () => {
  const base = rec({ stockName: '柳工', buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 857, targetNeedsDerive: true })

  it('改目标价：草稿 → 记录，并清掉「由公式派生」标记', () => {
    const { record, changes, errors } = applyEdits(base, { targetPrice: '8.68' })
    expect(errors).toHaveLength(0)
    expect(record.targetPriceCents).toBe(868)
    expect(record.targetNeedsDerive).toBe(false)
    expect(record.editedAt).toBeTypeOf('number')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ label: '目标售价', oldValue: '8.57', newValue: '8.68' })
  })

  it('清空字段 = 置 null，不是写 0', () => {
    const { record } = applyEdits(base, { targetPrice: '' })
    expect(record.targetPriceCents).toBeNull()
  })

  it('非法输入不进库，返回中文错误', () => {
    const bad = applyEdits(base, { buyPrice: '八块', buyQty: '1.5' })
    expect(bad.errors.length).toBe(2)
    expect(bad.errors[0]).toContain('买入价')
    expect(bad.changes).toHaveLength(0)
  })

  it('没有改动就不写 audit', () => {
    const same = applyEdits(base, { buyPrice: fieldText(base, 'buyPrice') })
    expect(same.changes).toHaveLength(0)
    expect(same.record.editedAt).toBeUndefined()
  })

  it('负数价格被拒', () => {
    expect(applyEdits(base, { buyPrice: '-8' }).errors.length).toBe(1)
  })
})

describe('编辑后重算仍然自洽', () => {
  it('给「有批次」的卖出补 P：生成待买但不占敞口，守恒式不破', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 857 }),
      rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 857, soldQty: 700 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    expect(before.orders).toHaveLength(0)
    expect(before.totals.exposureQty).toBe(0)

    const edited = applyEdits(records[1], { earlyBuyPrice: '8.00' })
    expect(edited.errors).toHaveLength(0)
    const after = buildLedger([records[0], edited.record], DEFAULT_STOCKS)

    expect(after.orders).toHaveLength(1)
    expect(after.orders[0].exposure).toBe(false)
    expect(after.totals.rebuyBaseQty).toBe(700)
    expect(after.totals.exposureQty).toBe(0)
    expect(after.totals.targetQty).toBe(700)
    expect(after.totals.netQty).toBe(700)
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('无批次的卖出（先卖后买）才计入敞口', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 857 }),
      rec({ stockName: '柳工', sourceRow: 2, soldQty: 500, targetPriceCents: 868, earlyBuyPriceCents: 801 }),
    ]
    const l = buildLedger(records, DEFAULT_STOCKS)
    expect(l.orders[0].exposure).toBe(true)
    expect(l.totals.exposureQty).toBe(500)
    expect(l.totals.netQty).toBe(200)
    expect(l.totals.targetQty - l.totals.exposureQty).toBe(200)
    for (const c of l.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('软删除的行不参与计算', () => {
    const records = [
      rec({ stockName: '柳工', sourceRow: 1, buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 857 }),
      rec({ stockName: '柳工', sourceRow: 2, buyPriceCents: 800, buyQtyRaw: 700, targetPriceCents: 857 }),
    ]
    const before = buildLedger(records, DEFAULT_STOCKS)
    expect(before.totals.targetQty).toBe(1400)
    const after = buildLedger([records[0], { ...records[1], deletedAt: Date.now() }], DEFAULT_STOCKS)
    expect(after.totals.rows).toBe(1)
    expect(after.totals.targetQty).toBe(700)
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })
})

describe('真实文件上的编辑', () => {
  const buf = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))
  const parsed = parseWorkbook(new Uint8Array(buf))

  it('给 R44 补一个目标售价：盈利补算，守恒仍成立', () => {
    const r44 = parsed.records.find((r) => r.sourceRow === 44)!
    expect(r44).toBeTruthy()
    const before = buildLedger(parsed.records, DEFAULT_STOCKS)
    expect(before.totals.profitCents).toBe(983000)

    const fixed = applyEdits(r44, { targetPrice: '19.88' })
    expect(fixed.errors).toHaveLength(0)
    const after = buildLedger(
      parsed.records.map((r) => (r.sourceRow === 44 ? fixed.record : r)),
      DEFAULT_STOCKS,
    )
    expect(after.totals.profitCents).toBe(983000 + 32100)
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })

  it('删掉一条买入批次：待卖跟着少，守恒仍成立', () => {
    const target = parsed.records.find((r) => r.sourceRow === 16)!
    const after = buildLedger(
      parsed.records.map((r) => (r.sourceRow === 16 ? { ...r, deletedAt: 1 } : r)),
      DEFAULT_STOCKS,
    )
    expect(after.totals.targetQty).toBe(15200 - (target.buyQtyRaw ?? 0))
    for (const c of after.checks) expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { buildRecordNoIndex, recordNoLabel } from './recordNo'
import type { RawRecord } from './types'

function rec(
  sourceRow: number,
  extra: Partial<RawRecord> = {},
): RawRecord {
  return {
    sourceRow,
    stockName: '柳工',
    buyDateSerial: null,
    buyPriceCents: null,
    buyQtyRaw: null,
    qtyNeedsDerive: false,
    targetPriceCents: null,
    targetNeedsDerive: false,
    soldQty: null,
    sellDateSerial: null,
    earlyBuyPriceCents: null,
    rawProfitCents: null,
    importKey: `key:${sourceRow}`,
    ...extra,
  }
}

const excel = (sourceRow: number, batchAt: number): RawRecord =>
  rec(sourceRow, { origin: 'excel', batchId: `batch:${batchAt}` })

const manual = (sourceRow: number, at: number): RawRecord =>
  rec(sourceRow, {
    origin: 'manual',
    importKey: `manual:liugong:${sourceRow}:${at}`,
  })

describe('buildRecordNoIndex', () => {
  it('同一批导入按 Excel 行号编号', () => {
    const idx = buildRecordNoIndex([excel(3, 1000), excel(2, 1000), excel(4, 1000)])
    expect(idx.of(2)).toBe(1)
    expect(idx.of(3)).toBe(2)
    expect(idx.of(4)).toBe(3)
    expect(idx.total).toBe(3)
  })

  it('手工新增排在导入之后', () => {
    const idx = buildRecordNoIndex([manual(100001, 2000), excel(2, 1000), manual(100000, 1500)])
    expect(idx.of(2)).toBe(1)
    expect(idx.of(100000)).toBe(2)
    expect(idx.of(100001)).toBe(3)
  })

  it('后导入的批次整体追加在末尾，即使 Excel 行号更小', () => {
    const idx = buildRecordNoIndex([excel(50, 1000), excel(51, 1000), manual(100000, 2000), excel(2, 3000)])
    expect(idx.of(2)).toBe(4)
  })

  it('后导入批次的行号比旧批次大时正常追加', () => {
    const idx = buildRecordNoIndex([excel(2, 1000), excel(3, 1000), manual(100000, 2000), excel(500, 3000)])
    expect(idx.of(500)).toBe(4)
  })

  it('软删除的行仍占号，不会让后面的整体前移', () => {
    const records = [excel(2, 1000), excel(3, 1000), manual(100000, 2000)]
    const idx = buildRecordNoIndex(records)
    records[0].deletedAt = 9999
    const again = buildRecordNoIndex(records)
    expect(again.of(3)).toBe(idx.of(3))
    expect(again.of(100000)).toBe(idx.of(100000))
  })

  it('老备份里没有 batchId 的行排在最前，按行号排', () => {
    const idx = buildRecordNoIndex([manual(100000, 2000), rec(5), rec(2)])
    expect(idx.of(2)).toBe(1)
    expect(idx.of(5)).toBe(2)
    expect(idx.of(100000)).toBe(3)
  })

  it('同一毫秒的手工新增按行号稳定排序', () => {
    const idx = buildRecordNoIndex([manual(100001, 2000), manual(100000, 2000)])
    expect(idx.of(100000)).toBe(1)
    expect(idx.of(100001)).toBe(2)
  })
})

describe('recordNoLabel', () => {
  const idx = buildRecordNoIndex([excel(2, 1000), excel(3, 1000)])

  it('记录显示第 N 笔', () => {
    expect(recordNoLabel(2, idx)).toBe('第 1 笔')
    expect(recordNoLabel(3, idx)).toBe('第 2 笔')
  })

  it('沙盒与回补批次单独称呼', () => {
    expect(recordNoLabel(300001, idx)).toBe('模拟批次')
    expect(recordNoLabel(200001, idx)).toBe('回补批次')
  })

  it('找不到对应记录时用兜底称呼', () => {
    expect(recordNoLabel(999, idx)).toBe('记录')
    expect(recordNoLabel(999, idx, 'Excel 行')).toBe('Excel 行')
  })
})

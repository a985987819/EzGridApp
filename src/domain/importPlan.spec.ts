import { describe, expect, it } from 'vitest'
import { identityKeyOf, importFieldValue, planImport } from './importPlan'
import { serialToIso } from './defaults'
import type { RawRecord } from './types'

let seq = 0
function rec(over: Partial<RawRecord> & { stockName: string }): RawRecord {
  seq += 1
  return {
    sourceRow: seq,
    buyDateSerial: 46000,
    buyPriceCents: 800,
    buyQtyRaw: 700,
    qtyNeedsDerive: false,
    targetPriceCents: 857,
    targetNeedsDerive: false,
    soldQty: null,
    sellDateSerial: null,
    earlyBuyPriceCents: null,
    rawProfitCents: null,
    importKey: `k${seq}`,
    ...over,
  }
}

describe('导入按行身份匹配更新（v9.20 决策 C）', () => {
  it('空本地库：全部新增', () => {
    const plan = planImport([], [rec({ stockName: '柳工' })])
    expect(plan.fresh).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  it('importKey 相同 → 无变化跳过', () => {
    const local = rec({ stockName: '柳工', importKey: 'same' })
    const file = rec({ stockName: '柳工', importKey: 'same' })
    const plan = planImport([local], [file])
    expect(plan.fresh).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  it('同身份、卖出字段变了 → 更新本地行，importKey/sourceRow 不变', () => {
    const local = rec({ stockName: '柳工', sourceRow: 7, soldQty: null, sellDateSerial: null, importKey: 'old' })
    const file = rec({ stockName: '柳工', soldQty: 700, sellDateSerial: 46100, importKey: 'new-key' })
    const plan = planImport([local], [file])
    expect(plan.fresh).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].to.sourceRow).toBe(7)
    expect(plan.updates[0].to.importKey).toBe('old')
    expect(plan.updates[0].to.soldQty).toBe(700)
    expect(plan.updates[0].to.sellDateSerial).toBe(46100)
  })

  it('身份对不上 → 新增（新旧并存只发生在买入侧真的不同时）', () => {
    const local = rec({ stockName: '柳工', buyPriceCents: 800 })
    const file = rec({ stockName: '柳工', buyPriceCents: 810, importKey: 'x' })
    const plan = planImport([local], [file])
    expect(plan.fresh).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  it('同身份多行有歧义时必须选择，不能按次序更新', () => {
    const a = rec({ stockName: '柳工', sourceRow: 60, buyPriceCents: null, buyQtyRaw: null, soldQty: 500 })
    const b = rec({ stockName: '柳工', sourceRow: 61, buyPriceCents: null, buyQtyRaw: null, soldQty: 500, sellDateSerial: 46101 })
    const fileA = rec({ stockName: '柳工', buyPriceCents: null, buyQtyRaw: null, soldQty: 500, importKey: 'fa' })
    const fileB = rec({ stockName: '柳工', buyPriceCents: null, buyQtyRaw: null, soldQty: 600, importKey: 'fb' })
    const plan = planImport([a, b], [fileA, fileB])
    expect(plan.updates).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(2)
    const resolved = planImport([a, b], [fileA, fileB], [], { [fileA.sourceRow]: 61 })
    expect(resolved.conflicts.length).toBeGreaterThan(0)
  })

  it('D 列公式派生的份额参与身份：老文件无缓存值、新文件有 → 还是同一批买入', () => {
    const local = rec({ stockName: '柳工', buyQtyRaw: null, qtyNeedsDerive: true })
    const file = rec({ stockName: '柳工', buyQtyRaw: 700, qtyNeedsDerive: false, importKey: 'cached' })
    // 800 分 → FLOOR(6000/8,100) = 700 股，与文件缓存一致
    expect(identityKeyOf(local)).toBe(identityKeyOf(file))
    const plan = planImport([local], [file])
    expect(plan.fresh).toHaveLength(0)
  })

  it('回补价差异（同 key 检测场景）也会更新', () => {
    const local = rec({ stockName: '柳工', importKey: 'same', earlyBuyPriceCents: null })
    const file = rec({ stockName: '柳工', importKey: 'same', earlyBuyPriceCents: 781 })
    const plan = planImport([local], [file])
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].to.earlyBuyPriceCents).toBe(781)
  })

  it('审计值格式化：分→元、序列号→ISO、空→（空）', () => {
    const r = rec({ stockName: '柳工', soldQty: 700, sellDateSerial: 46100, targetPriceCents: 857 })
    expect(importFieldValue(r, 'soldQty')).toBe('700')
    expect(importFieldValue(r, 'sellDateSerial')).toBe(serialToIso(46100))
    expect(importFieldValue(r, 'targetPriceCents')).toBe('8.57')
    expect(importFieldValue(r, 'earlyBuyPriceCents')).toBe('（空）')
  })
})

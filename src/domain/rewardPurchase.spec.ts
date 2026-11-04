import { describe, expect, it } from 'vitest'
import { allocateRewardPurchase, rewardBudget } from './rewardPurchase'
import type { GroupPool } from './types'

const pool = (groupKey: string, grossProfitCents: number, usedProfitCents = 0): GroupPool => ({ groupKey, stockId: 'stock:T', rebuyPriceCents: 500, grossProfitCents, usedProfitCents, capacityHands: 0, grantedHands: 0, availableCents: 0, lotCostCents: 50000 })

describe('奖励实际成交分配与资金约束', () => {
  it('整行先买所有基础份额，再买整手奖励，来源顺序不抢占后续基础量', () => {
    const sources = [{ id: 'a', qty: 400, baseQty: 300, rewardQty: 100 }, { id: 'b', qty: 300, baseQty: 300, rewardQty: 0 }]
    const before = JSON.stringify(sources)
    expect(allocateRewardPurchase(sources, 500).map(source => [source.id, source.buyQty, source.buyRewardQty])).toEqual([['a', 300, 0], ['b', 200, 0]])
    expect(allocateRewardPurchase(sources, 700).map(source => [source.id, source.buyQty, source.buyRewardQty])).toEqual([['a', 400, 100], ['b', 300, 0]])
    expect(JSON.stringify(sources)).toBe(before)
  })
  it('基础可任意部分成交，奖励仅整手；超出建议和非法来源拒绝', () => {
    const sources = [{ qty: 700, baseQty: 500, rewardQty: 200 }]
    expect(allocateRewardPurchase(sources, 50)[0]).toMatchObject({ buyQty: 50, buyRewardQty: 0 })
    expect(allocateRewardPurchase(sources, 600)[0]).toMatchObject({ buyQty: 600, buyRewardQty: 100 })
    expect(() => allocateRewardPurchase(sources, 550)).toThrow('整手')
    expect(() => allocateRewardPurchase(sources, 800)).toThrow('超过')
    expect(() => allocateRewardPurchase([{ qty: 550, baseQty: 500, rewardQty: 50 }], 500)).toThrow('额度不合法')
  })
  it('同价组跨来源共享实际费用余额，不因每份单独合法而超支', () => {
    const spend = rewardBudget([pool('stock:T|500', 100000, 20000)])
    spend('stock:T|500', 100, 400)
    spend('stock:T|500', 100, 400)
    expect(() => spend('stock:T|500', 100, 400)).toThrow('累计盈利不足')
  })
  it('按实际成交价收费；数量可授但改为高价仍拒绝；不同组不串用', () => {
    const spend = rewardBudget([pool('stock:T|500', 50000), pool('stock:U|500', 100000)])
    expect(() => spend('stock:T|500', 100, 501)).toThrow('累计盈利不足')
    spend('stock:T|500', 100, 500)
    expect(() => spend('stock:missing|500', 100, 100)).toThrow('累计盈利不足')
    spend('stock:U|500', 200, 500)
  })
  it('历史已用超预算保留，不能再授；非法或溢出费用拒绝', () => {
    const spend = rewardBudget([pool('stock:T|500', 100, 500)])
    spend('stock:T|500', 0, 500)
    expect(() => spend('stock:T|500', 100, 1)).toThrow('累计盈利不足')
    expect(() => spend('stock:T|500', 50, 1)).toThrow('不合法')
    expect(() => spend('stock:T|500', 100, Number.MAX_SAFE_INTEGER)).toThrow('累计盈利不足')
  })
  it('不明确或溢出的历史余额不能用于支付新奖励', () => {
    for (const gross of [Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => rewardBudget([pool('stock:T|500', gross)])('stock:T|500', 100, 1)).toThrow('累计盈利不足')
    }
  })
})

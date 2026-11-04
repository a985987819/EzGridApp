import { describe, expect, it } from 'vitest'
import { buildNextRoundBuyRows, type NextRoundBuyRow } from './buyBoard'
import { buildBuySuggestions, capBuySplitRewardCash, consumedNextRounds } from './suggestions'
import type { BuySplit, GroupPool, Lot, RawRecord, TradePlan } from './types'

const group = (priceCents = 500, fields: Partial<GroupPool> = {}): GroupPool => ({
  groupKey: `stock:T|${priceCents}`, stockId: 'stock:T', rebuyPriceCents: priceCents,
  grossProfitCents: 100000, usedProfitCents: 0, capacityHands: 2, grantedHands: 0,
  availableCents: 100000, lotCostCents: priceCents * 100, ...fields,
})
const lot = (sourceRow: number, qty = 500, fields: Partial<Lot> = {}): Lot => ({
  id: `lot:${sourceRow}`, sourceRow, stockId: 'stock:T', stockName: 'T', buyDate: '2026-01-01',
  buyPriceCents: 500, qty, soldQty: qty, remainingQty: 0, targetPriceCents: 700, needsPrice: false,
  importKey: `lot:${sourceRow}`, ...fields,
})
const next = (fields: Partial<NextRoundBuyRow> = {}): NextRoundBuyRow => ({
  key: 'buy:2', stockName: 'T', priceCents: 500, baseQty: 500, rewardQty: 200,
  rewardGroupKey: 'stock:T|500', sourceRewardQty: { 2: 200 }, qty: 700, amountCents: 350000,
  rows: [2], sourceQty: { 2: 500 }, merged: false, anchorRow: 2, earliestBuyDate: '2026-01-01',
  lastSoldAt: '2026-02-01', repaid: false, ...fields,
})
const split = (fields: Partial<BuySplit> = {}): BuySplit => ({
  key: 'rb:sell:9', orderId: 'rb:sell:9', sellExecId: 'sell:9', sourceRow: 9, stockName: 'T',
  priceCents: 500, qty: 700, baseRemainingQty: 500, plannedQty: 500, executedQty: 0,
  split: false, targetId: null, sellFirst: true, rewardGroupKey: 'stock:T|500', ...fields,
})
const plan = (refId: string, qty: number, priceCents = 500): TradePlan => ({
  id: `plan:${refId}`, kind: 'buy', refId, qty, priceCents, at: 1,
})
const record = (sourceRow: number, fields: Partial<RawRecord> = {}): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: 500, buyQtyRaw: 500,
  qtyNeedsDerive: false, targetPriceCents: 700, targetNeedsDerive: false, soldQty: null,
  sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `record:${sourceRow}`, ...fields,
})

describe('下一轮与回补共享价位盈利奖励', () => {
  it('5元价位盈利1000元可多买200股，基础来源仍为500股', () => {
    const [row] = buildNextRoundBuyRows({ lots: [lot(2)], orders: [], sells: [], merges: [], groups: [group()] })
    expect(row).toMatchObject({ qty: 700, baseQty: 500, rewardQty: 200, rewardGroupKey: 'stock:T|500', sourceQty: { 2: 500 }, sourceRewardQty: { 2: 200 } })
    const [suggestion] = buildBuySuggestions([], [row], [], [group()])
    expect(suggestion).toMatchObject({ qty: 700, rewardQty: 200, originalQty: 700, originalAmountCents: 350000 })
    expect(suggestion.sources).toEqual([{ kind: 'next', id: 'buy:2', row: 2, qty: 700, rewardQty: 200, rewardGroupKey: 'stock:T|500' }])
  })

  it('回补订单已领取的两手不再发给同价下一轮', () => {
    const [row] = buildNextRoundBuyRows({ lots: [lot(2)], orders: [], sells: [], merges: [], groups: [group(500, { grantedHands: 2, availableCents: 0 })] })
    expect(row).toMatchObject({ qty: 500, baseQty: 500, rewardQty: 0 })
    expect(row.sourceRewardQty).toBeUndefined()
  })

  it('价组仍余两手时仅发余量，同价多来源只领取一次并保持稳定', () => {
    const lots = [lot(3, 300), lot(2, 200)]
    const before = JSON.stringify(lots)
    const pools = [group(500, { capacityHands: 3, grantedHands: 1 })]
    const opts = { lots, orders: [], sells: [], merges: [], groups: pools }
    const [row] = buildNextRoundBuyRows(opts)
    expect(row).toMatchObject({ qty: 700, baseQty: 500, rewardQty: 200, rows: [2, 3], sourceQty: { 2: 200, 3: 300 }, sourceRewardQty: { 3: 200 } })
    expect(buildNextRoundBuyRows({ ...opts, lots: [...lots].reverse() })).toEqual([row])
    expect(JSON.stringify(lots)).toBe(before)
  })

  it('基础已买完仍可单独买剩余奖励；奖励成交不再重复消耗基础来源', () => {
    const paid = record(10, { nextRoundOfRow: 2, buyQtyRaw: 600, profitRewardQty: 100, profitRewardGroupKey: 'stock:T|500' })
    const consumed = consumedNextRounds([paid, record(11, { nextRoundOfRow: 2, buyQtyRaw: 100, deletedAt: 1 })])
    expect(consumed.get(2)).toBe(500)
    const pools = [group(500, { usedProfitCents: 50000, capacityHands: 1, availableCents: 50000 })]
    const [row] = buildNextRoundBuyRows({ lots: [lot(2)], orders: [], sells: [], merges: [], consumed, groups: pools })
    expect(row).toMatchObject({ qty: 100, baseQty: 0, rewardQty: 100, sourceQty: { 2: 0 }, sourceRewardQty: { 2: 100 } })
    expect(buildBuySuggestions([], [row], [], pools)[0].sources).toMatchObject([{ row: 2, qty: 100, rewardQty: 100 }])
    expect(buildNextRoundBuyRows({ lots: [lot(2)], orders: [], sells: [], merges: [], consumed, groups: [group(500, { usedProfitCents: 100000, capacityHands: 0, availableCents: 0 })] })).toEqual([])
  })

  it('没有实际贡献的耗尽来源不混进奖励行的来源标签', () => {
    const [row] = buildNextRoundBuyRows({ lots: [lot(2), lot(3)], orders: [], sells: [], merges: [], consumed: new Map([[2, 500], [3, 500]]), groups: [group()] })
    expect(row).toMatchObject({ key: 'buy:3', rows: [3], anchorRow: 3, qty: 200, baseQty: 0, rewardQty: 200, merged: false })
  })

  it('不同股票和价位不共享盈利，不传组池仍保持旧基础提醒', () => {
    const t500 = lot(2), t600 = lot(3, 500, { buyPriceCents: 600 }), u500 = lot(4, 500, { stockId: 'stock:U', stockName: 'U' })
    const opts = { lots: [t500, t600, u500], orders: [], sells: [], merges: [] }
    expect(buildNextRoundBuyRows(opts).map(row => row.qty)).toEqual([500, 500, 500])
    const rows = buildNextRoundBuyRows({ ...opts, groups: [group()] })
    expect(rows.find(row => row.stockName === 'T' && row.priceCents === 500)?.qty).toBe(700)
    expect(rows.filter(row => row.stockName !== 'T' || row.priceCents !== 500).map(row => row.qty)).toEqual([500, 500])
  })
})

describe('改单按最终价格收敛奖励与真实来源贡献', () => {
  it('沙盒直接拆档按高价裁奖励，保留基础量、身份和原价且不修改输入', () => {
    const source = split({ priceCents: 1000, originalPriceCents: 500, qty: 700 })
    const before = JSON.stringify(source)
    const [shown] = capBuySplitRewardCash([source], [group(500, { grantedHands: 2 })])
    expect(shown).toEqual({ ...source, qty: 600 })
    expect(shown.baseRemainingQty).toBe(500)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('沙盒同组多个拆档只使用一次现金，显示单档订单仍可使用整个订单预算', () => {
    const first = split({ key: 'a', qty: 300, baseRemainingQty: 200, priceCents: 1000 })
    const second = split({ key: 'b', qty: 400, baseRemainingQty: 300, priceCents: 1000 })
    const rows = capBuySplitRewardCash([first, second], [group(500, { grantedHands: 2 })])
    expect(rows.map(row => [row.key, row.qty, row.baseRemainingQty])).toEqual([['a', 300, 200], ['b', 300, 300]])
    expect(capBuySplitRewardCash([first], [group(500, { grantedHands: 2 })])[0].qty).toBe(300)
  })

  it('旧整单计划按200股缩量，显示、金额和来源一致且原推荐保留500股', () => {
    const source = split({ qty: 500, priceCents: 550, originalPriceCents: 500 })
    const plans = [plan(source.orderId, 200, 550)]
    const [suggestion] = buildBuySuggestions([source], [], plans, [])
    expect(suggestion).toMatchObject({ qty: 200, priceCents: 550, amountCents: 110000, originalQty: 500, originalAmountCents: 250000, edited: true })
    expect(suggestion.sources).toMatchObject([{ qty: 200, id: source.orderId }])
    expect(suggestion.planRefs).toContain(source.orderId)
    expect(capBuySplitRewardCash([source], [], plans)[0]).toEqual({ ...source, qty: 200 })
  })

  it('母单多拆档共享一次旧计划上限，零贡献档不重复扩大原推荐与预算', () => {
    const first = split({ key: 'a', qty: 200, baseRemainingQty: 200, priceCents: 500 })
    const second = split({ key: 'b', qty: 300, baseRemainingQty: 300, priceCents: 500 })
    const plans = [plan(first.orderId, 200)]
    const [suggestion] = buildBuySuggestions([first, second], [], plans, [])
    expect(suggestion).toMatchObject({ qty: 200, originalQty: 500, originalAmountCents: 250000, edited: true })
    expect(suggestion.sources.map(source => [source.kind === 'order' ? source.splitKey : '', source.qty])).toEqual([['a', 200]])
    expect(suggestion.planRefs).toContain(first.orderId)
    expect(capBuySplitRewardCash([first, second], [], plans).map(row => row.qty)).toEqual([200, 0])
  })

  it('5元组原授200奖励，旧计划600股@5.50可保留100奖励不被虚假保留预算裁掉', () => {
    const source = split({ priceCents: 550, originalPriceCents: 500 })
    const plans = [plan(source.orderId, 600, 550)], pools = [group(500, { grantedHands: 2 })]
    const [suggestion] = buildBuySuggestions([source], [], plans, pools)
    expect(suggestion).toMatchObject({ qty: 600, rewardQty: 100, amountCents: 330000, originalQty: 700, originalAmountCents: 350000 })
    expect(suggestion.sources[0]).toMatchObject({ qty: 600, rewardQty: 100 })
    expect(capBuySplitRewardCash([source], pools, plans)[0].qty).toBe(600)
  })

  it('旧整单缩量时先保留其它档基础，再用剩余空间给整手奖励', () => {
    const first = split({ key: 'a', qty: 300, baseRemainingQty: 100, priceCents: 550 })
    const second = split({ key: 'b', qty: 400, baseRemainingQty: 400, priceCents: 550 })
    const plans = [plan(first.orderId, 600, 550)], pools = [group(500, { grantedHands: 2 })]
    const [suggestion] = buildBuySuggestions([first, second], [], plans, pools)
    expect(suggestion).toMatchObject({ qty: 600, rewardQty: 100 })
    expect(suggestion.sources.map(source => [source.kind === 'order' ? source.splitKey : '', source.qty, source.rewardQty ?? 0])).toEqual([['a', 200, 100], ['b', 400, 0]])
    expect(capBuySplitRewardCash([first, second], pools, plans).map(row => row.qty)).toEqual([200, 400])
  })

  it('下一轮合并缩到600股先保留全部可用基础贡献，不提前留下奖励', () => {
    const row = next({ qty: 1200, baseQty: 1000, amountCents: 600000, rows: [2, 3], sourceQty: { 2: 500, 3: 500 }, sourceRewardQty: { 3: 200 }, merged: true })
    const [suggestion] = buildBuySuggestions([], [row], [plan(row.key, 600)], [group()])
    expect(suggestion).toMatchObject({ qty: 600, originalQty: 1200, originalAmountCents: 600000 })
    expect(suggestion.sources.map(source => [source.row, source.qty, source.rewardQty ?? 0])).toEqual([[2, 500, 0], [3, 100, 0]])
  })

  it('基础1000加奖励200缩至1050时只留1000，不能保存50股碎片奖励', () => {
    const row = next({ qty: 1200, baseQty: 1000, amountCents: 600000, rows: [2, 3], sourceQty: { 2: 500, 3: 500 }, sourceRewardQty: { 3: 200 }, merged: true })
    const [suggestion] = buildBuySuggestions([], [row], [plan('buy:optional:T:500', 1050)], [group()])
    expect(suggestion).toMatchObject({ qty: 1000, rewardQty: 0, originalQty: 1200, amountCents: 500000 })
    expect(suggestion.members).toEqual([{ key: 'buy:optional:T:500', qty: 1000 }])
  })

  it('多个订单来源缩量时基础优先于前一来源的奖励', () => {
    const first = split({ sourceRow: 8, key: 'a', orderId: 'a' })
    const second = split({ sourceRow: 9, key: 'b', orderId: 'b', qty: 500 })
    const [suggestion] = buildBuySuggestions([first, second], [], [plan('buy:cover:T:500', 700)], [group()])
    expect(suggestion).toMatchObject({ qty: 700, rewardQty: 0 })
    expect(suggestion.sources.map(source => [source.row, source.qty, source.rewardQty ?? 0])).toEqual([[8, 500, 0], [9, 200, 0]])
  })

  it('改单将5元提高为10元，1000元预算只能保留100奖励股', () => {
    const row = next(), plans = [plan('buy:optional:T:500', 700, 1000)], pools = [group()]
    const before = JSON.stringify({ row, plans, pools })
    const [suggestion] = buildBuySuggestions([], [row], plans, pools)
    expect(suggestion).toMatchObject({ priceCents: 1000, qty: 600, rewardQty: 100, amountCents: 600000, originalQty: 700, originalAmountCents: 350000 })
    expect(suggestion.sources[0]).toMatchObject({ qty: 600, rewardQty: 100, rewardGroupKey: 'stock:T|500' })
    expect(suggestion.members).toEqual([{ key: 'buy:optional:T:500', qty: 600 }])
    expect(JSON.stringify({ row, plans, pools })).toBe(before)
  })

  it('提高到20元时奖励不足整手全裁，基本买入不被裁掉', () => {
    const [suggestion] = buildBuySuggestions([], [next()], [plan('buy:optional:T:500', 700, 2000)], [group()])
    expect(suggestion).toMatchObject({ qty: 500, rewardQty: 0, originalQty: 700 })
    expect(suggestion.sources[0]).toMatchObject({ qty: 500, rewardQty: 0 })
  })

  it('最终价降低也不能扩大原来只分配到的一手奖励', () => {
    const [suggestion] = buildBuySuggestions([], [next({ qty: 600, rewardQty: 100, sourceRewardQty: { 2: 100 } })], [plan('buy:optional:T:500', 600, 250)], [group()])
    expect(suggestion).toMatchObject({ qty: 600, rewardQty: 100, priceCents: 250 })
  })

  it('P列与下一轮共享同价现金且优先已分配的订单奖励，不会各领同一笔盈利', () => {
    const pools = [group(500, { grantedHands: 2 })]
    const board = buildBuySuggestions([split()], [next()], [], pools)
    expect(board).toHaveLength(2)
    expect(board.find(row => row.sellFirst)).toMatchObject({ qty: 700, rewardQty: 200 })
    expect(board.find(row => !row.sellFirst)).toMatchObject({ qty: 500, rewardQty: 0 })
    expect(board.reduce((sum, row) => sum + (row.rewardQty ?? 0), 0)).toBe(200)
  })

  it('未传入的已授订单仍保留预算，改单的下一轮不能抢占它的现金', () => {
    const pools = [group(500, { grantedHands: 1 })]
    const [suggestion] = buildBuySuggestions([], [next({ qty: 600, rewardQty: 100, sourceRewardQty: { 2: 100 } })], [plan('buy:optional:T:500', 600, 1000)], pools)
    expect(suggestion).toMatchObject({ qty: 500, rewardQty: 0 })
  })

  it('不同原成本改单撞价合并后，奖励仍各自归原价组而不混预算', () => {
    const first = next({ qty: 300, baseQty: 100, sourceQty: { 2: 100 } })
    const second = next({ key: 'buy:3', priceCents: 600, qty: 200, baseQty: 100, rewardQty: 100, sourceQty: { 3: 100 }, sourceRewardQty: { 3: 100 }, rewardGroupKey: 'stock:T|600', rows: [3], anchorRow: 3 })
    const pools = [group(), group(600, { grossProfitCents: 60000, capacityHands: 1 })]
    const [suggestion] = buildBuySuggestions([], [first, second], [plan('buy:optional:T:600', 200, 500)], pools)
    expect(suggestion).toMatchObject({ qty: 500, rewardQty: 300, originalQty: 500, originalAmountCents: 270000 })
    expect(suggestion.sources.map(source => [source.row, source.qty, source.rewardQty, source.rewardGroupKey])).toEqual([[2, 300, 200, 'stock:T|500'], [3, 200, 100, 'stock:T|600']])
    expect(suggestion.members).toEqual([{ key: 'buy:optional:T:500', qty: 300 }, { key: 'buy:optional:T:600', qty: 200 }])
  })

  it('缺失或未知组池不能伪造奖励额度，但保留基础数量和原推荐对照', () => {
    const [suggestion] = buildBuySuggestions([], [next()], [], [])
    expect(suggestion).toMatchObject({ qty: 500, rewardQty: 0, originalQty: 700 })
    const [oldCaller] = buildBuySuggestions([], [next()], [])
    expect(oldCaller).toMatchObject({ qty: 700, rewardQty: 200 })
  })
})

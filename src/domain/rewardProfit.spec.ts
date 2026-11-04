import { describe, expect, it } from 'vitest'
import { buildRewardProfit } from './rewardProfit'
import type { ChainProfitSlice } from './chain'
import type { RepairChain, SellExecution } from './types'

const sale = (id: string, costCents: number, profitCents: number, fields: Partial<SellExecution> = {}): SellExecution => ({
  id, sourceRow: Number(id.replace(/\D/g, '')) || 1, stockId: 'stock:T', stockName: 'T', qty: 500,
  priceCents: costCents + Math.round(profitCents / 500), costCents, profitCents, soldAt: '2026-01-10', dateMissing: false,
  priceSource: 'target', rebuyStatus: 'repaid', sellBeforeBuy: false, groupKey: `stock:T|${costCents}`, costComplete: true,
  lotId: `lot:${id}`, targetId: null, ...fields,
})
const chain = (netCents: number, fields: Partial<RepairChain> = {}): RepairChain => ({
  id: 'chain:1', stockName: 'T', anchorRow: 1, anchorQty: 500, anchorCostCents: 1000, closedAtCents: 700,
  lossCents: -150000, profitCents: netCents + 150000, netCents, gapCents: Math.max(0, -netCents), done: netCents >= 0,
  covered: netCents >= 0 ? 1 : 0, savingCents: 99999999, holdingQty: 0, plannedQty: 0, unallocatedLossCents: 0,
  closedByUserAt: null, relatedSellRows: [], branches: [], ...fields,
})
const slice = (sold: SellExecution, fields: Partial<ChainProfitSlice> = {}): ChainProfitSlice => ({
  chainId: 'chain:1', chainAnchor: 1, sellId: sold.id, lotId: sold.lotId, stockId: sold.stockId, stockName: sold.stockName,
  qty: sold.qty, profitCents: sold.profitCents!, costCents: sold.costCents!, kind: 'branch', ...fields,
})
const at = (rows: ReturnType<typeof buildRewardProfit>, price: number) => rows.find(row => row.priceCents === price)!

describe('价位可奖励累计盈利：回本只释放净超额', () => {
  it('无链沿用同股成本价净盈利，亏损也抵扣；不混其它股票', () => {
    const rows = buildRewardProfit([sale('s1', 500, 20000), sale('s2', 500, -5000), sale('s3', 600, 9000),
      sale('s4', 500, 7000, { stockId: 'stock:U', stockName: 'U', groupKey: 'stock:U|500' })], { chains: [], profitSlices: [] })
    expect(at(rows, 500)).toMatchObject({ rawProfitCents: 15000, grossProfitCents: 15000, chainLockedCents: 0, chainReleasedCents: 0 })
    expect(rows.find(row => row.stockName === 'U')?.grossProfitCents).toBe(7000)
  })

  it('未回本链、人工结束但仍亏损及缺成本链全部锁定，回补节省不入池', () => {
    const sold = sale('s2', 500, 100000)
    for (const current of [chain(-50000), chain(-50000, { closedByUserAt: 1 }), chain(50000, { unlinkedQty: 100, done: false })]) {
      expect(at(buildRewardProfit([sold], { chains: [current], profitSlices: [slice(sold)] }), 500)).toMatchObject({
        rawProfitCents: 100000, grossProfitCents: 0, chainLockedCents: 100000, chainReleasedCents: 0,
      })
    }
  })

  it('2000盈利先抵1500亏损，只放行500；原始亏损从普通高位池移出避免双扣', () => {
    const seed = sale('s1', 1000, -150000), gain = sale('s2', 500, 200000)
    const rows = buildRewardProfit([seed, gain], { chains: [chain(50000)], profitSlices: [slice(seed, { kind: 'seed' }), slice(gain)] })
    expect(at(rows, 1000)).toMatchObject({ rawProfitCents: -150000, grossProfitCents: 0, chainLockedCents: -150000 })
    expect(at(rows, 500)).toMatchObject({ rawProfitCents: 200000, grossProfitCents: 50000, chainLockedCents: 150000, chainReleasedCents: 50000 })
    expect(rows.reduce((sum, row) => sum + row.grossProfitCents, 0)).toBe(50000)
    expect(rows.every(row => row.rawProfitCents === row.grossProfitCents + row.chainLockedCents)).toBe(true)
  })

  it('先卖后买合成原始亏损未进普通池，不额外扣减；恰好回本不释放', () => {
    const seed = sale('s1', 1000, -150000, { groupKey: null, hedgedFromSellRow: 9, hedgeClosed: true })
    const gain = sale('s2', 500, 150000)
    const rows = buildRewardProfit([seed, gain], { chains: [chain(0)], profitSlices: [slice(seed, { kind: 'seed' }), slice(gain)] })
    expect(rows.some(row => row.priceCents === 1000)).toBe(false)
    expect(at(rows, 500).grossProfitCents).toBe(0)
  })

  it('各成本价位先算净贡献，正权重按最大余数分摊，整数分不丢也不重复', () => {
    const a = sale('s2', 500, 100001), b = sale('s3', 600, 100001), c = sale('s4', 700, -50000)
    const rows = buildRewardProfit([a, b, c], { chains: [chain(5, { lossCents: -149997, profitCents: 150002 })], profitSlices: [slice(a), slice(b), slice(c)] })
    expect(at(rows, 500).chainReleasedCents).toBe(3)
    expect(at(rows, 600).chainReleasedCents).toBe(2)
    expect(at(rows, 700).chainReleasedCents).toBe(0)
    expect(rows.reduce((sum, row) => sum + row.grossProfitCents, 0)).toBe(5)
  })

  it('同一成本价位正负贡献先抵消，再参与跨价分配，不能只用正卖出利润当权重', () => {
    const a = sale('s2', 500, 200000), b = sale('s3', 500, -100000), c = sale('s4', 600, 300000)
    const rows = buildRewardProfit([a, b, c], { chains: [chain(100000, { lossCents: -300000, profitCents: 400000 })], profitSlices: [slice(a), slice(b), slice(c)] })
    expect(at(rows, 500).chainReleasedCents).toBe(25000)
    expect(at(rows, 600).chainReleasedCents).toBe(75000)
  })

  it('两链共享同笔卖出，精确锁500/100股；未归链的400股正常累计', () => {
    const sold = sale('s2', 500, 200000, { qty: 1000 })
    const slices = [slice(sold, { qty: 500, profitCents: 100000 }), slice(sold, { chainId: 'chain:3', chainAnchor: 3, qty: 100, profitCents: 20000 })]
    const rows = buildRewardProfit([sold], { chains: [chain(-50000), chain(-10000, { id: 'chain:3', anchorRow: 3 })], profitSlices: slices })
    expect(at(rows, 500)).toMatchObject({ rawProfitCents: 200000, grossProfitCents: 80000, chainLockedCents: 120000 })
  })

  it('同笔同链的重复元数据不重复锁定或释放；不同链的份额可以独立释放', () => {
    const sold = sale('s2', 500, 200000)
    const owned = slice(sold, { qty: 250, profitCents: 100000 })
    const other = slice(sold, { chainId: 'chain:3', chainAnchor: 3, qty: 250, profitCents: 100000 })
    const rows = buildRewardProfit([sold], { chains: [chain(50000), chain(10000, { id: 'chain:3', anchorRow: 3 })], profitSlices: [owned, owned, other] })
    expect(at(rows, 500)).toMatchObject({ grossProfitCents: 60000, chainReleasedCents: 60000, chainLockedCents: 140000 })
  })

  it('后续亏损使链重新未完成时，先前净额重新锁定，已买奖励的消耗由调用者永久保留', () => {
    const sold = sale('s2', 500, 200000), loss = sale('s3', 500, -60000)
    const complete = buildRewardProfit([sold], { chains: [chain(50000)], profitSlices: [slice(sold)] })
    expect(at(complete, 500).grossProfitCents).toBe(50000)
    const incomplete = buildRewardProfit([sold, loss], { chains: [chain(-10000)], profitSlices: [slice(sold), slice(loss)] })
    expect(at(incomplete, 500).grossProfitCents).toBe(0)
  })

  it('分配乘积超过安全Number仍按BigInt算精确整数分，不依赖输入顺序', () => {
    const a = sale('s2', 500, 3000000001), b = sale('s3', 600, 3000000000)
    const current = chain(1000000001, { lossCents: -5000000000, profitCents: 6000000001 })
    const slices = [slice(a), slice(b)]
    const before = JSON.stringify({ a, b, current, slices })
    const rows = buildRewardProfit([a, b], { chains: [current], profitSlices: slices })
    expect(rows.reduce((sum, row) => sum + row.chainReleasedCents, 0)).toBe(1000000001)
    expect(at(rows, 500).chainReleasedCents).toBe(500000001)
    expect(buildRewardProfit([b, a], { chains: [current], profitSlices: [...slices].reverse() })).toEqual(rows)
    expect(JSON.stringify({ a, b, current, slices })).toBe(before)
  })
})

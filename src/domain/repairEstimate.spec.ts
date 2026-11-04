import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { estimateRepairRounds } from './repairEstimate'
import type { RawRecord, RebuyExecution, RepairChain } from './types'

const stock = { id: 'stock:T', name: 'T', intervalCents: 200, priceLimitType: 'main_10' as const }
const row = (sourceRow: number, patch: Partial<RawRecord>): RawRecord => ({
  sourceRow, stockName: 'T', buyDateSerial: null, buyPriceCents: null, buyQtyRaw: null,
  qtyNeedsDerive: false, targetPriceCents: null, targetNeedsDerive: false, soldQty: 0,
  sellDateSerial: null, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `estimate:${sourceRow}`, ...patch,
})
const high = row(2, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 1200 })
const root = row(3, { sellDateSerial: 46001, targetPriceCents: 700, soldQty: 500, earlyBuyPriceCents: 500 })
const execution = (priceCents = 500): RebuyExecution => ({
  id: 'e1', orderId: 'rb:sell:3', sellExecId: 'sell:3', stockId: stock.id, stockName: 'T',
  qty: 500, rewardQty: 0, priceCents, groupKeyAtExecution: 'T|500', at: new Date('2025-12-15T12:00:00').getTime(),
})
const resold = (qty = 500, sellPrice = 700) => row(4, { soldLotId: 'lot:exec:e1',
  buyPriceCents: 500, buyDateSerial: 46006, targetPriceCents: sellPrice, soldQty: qty, sellDateSerial: 46010 })
const make = (records = [high, root], executions: RebuyExecution[] = []) => {
  const ledger = buildLedger(records, [stock], { executions })
  const chain = ledger.repairChains.find(item => item.anchorRow === 3)!
  expect(chain).toBeDefined()
  return { ledger, chain }
}
const estimate = (fixture: ReturnType<typeof make>, chain: RepairChain = fixture.chain) => {
  const before = JSON.stringify({ chain, ledger: fixture.ledger })
  const result = estimateRepairRounds(chain, fixture.ledger)
  expect(JSON.stringify({ chain, ledger: fixture.ledger })).toBe(before)
  return result
}

describe('回本链剩余循环次数', () => {
  it('10买7卖亏1500，计划5买7卖每500股赚1000，向上取整仍需2次', () => {
    const fixture = make()
    expect(estimate(fixture)).toEqual({ status: 'ready', rounds: 2, buyPriceCents: 500,
      sellPriceCents: 700, qty: 500, profitPerRoundCents: 100000, source: 'plan' })
  })

  it('买回但未卖出不提前减次数，完成一次5买7卖后剩余1次', () => {
    const bought = make([high, root], [execution()])
    expect(estimate(bought)).toMatchObject({ rounds: 2, source: 'target', profitPerRoundCents: 100000 })
    const sold = make([high, root, resold()], [execution()])
    expect(sold.chain.gapCents).toBe(50000)
    expect(estimate(sold)).toMatchObject({ rounds: 1, source: 'actual', qty: 500, profitPerRoundCents: 100000 })
  })

  it('部分成交只减少实际已赚的缺口，参考每轮仍按原500股而非100股', () => {
    const fixture = make([high, root, resold(100)], [execution()])
    expect(fixture.chain.gapCents).toBe(130000)
    expect(estimate(fixture)).toMatchObject({ rounds: 2, source: 'actual', qty: 500, profitPerRoundCents: 100000 })
  })

  it('实际5.5元买回成本优先于旧计划5元，不把旧计划价当成实际基准', () => {
    const fixture = make([high, root], [execution(550)])
    expect(estimate(fixture)).toMatchObject({ buyPriceCents: 550, sellPriceCents: 750, rounds: 2, source: 'target' })
  })

  it('最近实际盈利成交优先于旧实际样本及未来目标', () => {
    const records = [
      row(2, { buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 500, targetPriceCents: 700, soldQty: 500, sellDateSerial: 46001 }),
      row(5, { buyDateSerial: 46002, buyPriceCents: 500, buyQtyRaw: 100, targetPriceCents: 700, soldQty: 100, sellDateSerial: 46003 }),
      row(6, { buyDateSerial: 46004, buyPriceCents: 550, buyQtyRaw: 100, targetPriceCents: 700, soldQty: 100, sellDateSerial: 46005 }),
      row(7, { buyDateSerial: 46006, buyPriceCents: 400, buyQtyRaw: 100, targetPriceCents: 800 }),
    ]
    const ledger = buildLedger(records, [stock], { chainLinks: [{ id: 'chainlink:2', anchorRow: 2,
      stockName: 'T', memberRows: [5, 6, 7], closedAt: null, at: 1 }] })
    expect(estimateRepairRounds(ledger.repairChains[0], ledger)).toMatchObject({ source: 'actual', buyPriceCents: 550,
      sellPriceCents: 700, qty: 500, profitPerRoundCents: 75000, rounds: 2 })
  })

  it('多代及重复展示分支不累计股数或cycles作为单轮盈利', () => {
    const fixture = make([high, root, resold()], [execution()])
    const repeated = { ...fixture.chain, branches: [...fixture.chain.branches, ...fixture.chain.branches].map(branch => ({ ...branch, cycles: 100 })) }
    expect(estimate(fixture, repeated)).toEqual(estimate(fixture))
  })

  it('第二代回补仍以同一500股一轮估算，不把历代1000股当单轮份额', () => {
    const second: RebuyExecution = { ...execution(), id: 'e2', sellExecId: 'sell:4', orderId: 'rb:sell:4',
      at: new Date('2025-12-22T12:00:00').getTime() }
    const ledger = buildLedger([high, root, { ...resold(), earlyBuyPriceCents: 500 }], [stock], { executions: [execution(), second],
      extraTargets: [{ id: 'grid-mode:3', lotId: 'lot:2', priceCents: 700, qty: 0, at: 1,
        strategy: { mode: 'repair', sellRow: 3, rebuyPriceCents: 500, nextSellPriceCents: 700, groupId: 'grid-mode:3' } }] })
    const fixture = { ledger, chain: ledger.repairChains.find(chain => chain.anchorRow === 3)! }
    expect(ledger.lots.filter(lot => lot.id.startsWith('lot:exec:')).reduce((sum, lot) => sum + lot.qty, 0)).toBe(1000)
    expect(estimate(fixture)).toMatchObject({ rounds: 1, source: 'actual', qty: 500, profitPerRoundCents: 100000 })
  })

  it('同股票其它链或独立交易的更晚盈利不得冒充本链参考', () => {
    const fixture = make([high, root, resold(), row(8, { buyDateSerial: 46015, buyPriceCents: 100,
      buyQtyRaw: 100, targetPriceCents: 900, soldQty: 100, sellDateSerial: 46020 })], [execution()])
    expect(estimate(fixture)).toMatchObject({ buyPriceCents: 500, sellPriceCents: 700, source: 'actual', rounds: 1 })
  })

  it('共享回补批次只归本链250股时，不凭整批memberRows误认另一份最新实际卖价', () => {
    const fixture = make([high, root, resold(100, 900)], [execution()])
    const branch = fixture.chain.branches[0]
    const sharedChain: RepairChain = { ...fixture.chain, profitCents: 0, netCents: -150000, gapCents: 150000,
      branches: [{ ...branch, kind: 'rebuy', key: 'exec:e1', row: null, qty: 250,
        remainingQty: 250, sellQty: 0, profitCents: 0, memberRows: [4] }] }
    expect(estimate(fixture, sharedChain)).toMatchObject({ source: 'target', buyPriceCents: 500,
      sellPriceCents: 700, qty: 500, profitPerRoundCents: 100000, rounds: 2 })
  })

  it('只取原目标价，忽略P8改单展示价格和缩量', () => {
    const fixture = make([high, root], [execution()])
    fixture.ledger.targets = fixture.ledger.targets.map(target => ({ ...target, planPriceCents: 2000, planQty: 1 }))
    expect(estimate(fixture)).toMatchObject({ buyPriceCents: 500, sellPriceCents: 700, qty: 500,
      profitPerRoundCents: 100000, source: 'target' })
  })

  it('已回本为0状态，未补全高位成本和人工结束分别保守展示', () => {
    const fixture = make()
    expect(estimate(fixture, { ...fixture.chain, done: true, gapCents: 0 })).toEqual({ status: 'done' })
    expect(estimate(fixture, { ...fixture.chain, unlinkedQty: 100 })).toEqual({ status: 'unlinked' })
    expect(estimate(fixture, { ...fixture.chain, closedByUserAt: 1 })).toEqual({ status: 'unavailable' })
  })

  it('参考价差为零或负、缺价或非法数值不产生虚假次数', () => {
    const fixture = make()
    for (const rebuyPriceCents of [700, 800, null, Infinity]) {
      const ledger = { ...fixture.ledger, sells: fixture.ledger.sells.map(sale => sale.sourceRow === 3 ? { ...sale, rebuyPriceCents } : sale), orders: [] }
      expect(estimateRepairRounds(fixture.chain, ledger)).toEqual({ status: 'unavailable' })
    }
    expect(estimate(fixture, { ...fixture.chain, anchorQty: NaN })).toEqual({ status: 'unavailable' })
    expect(estimate(fixture, { ...fixture.chain, gapCents: Infinity })).toEqual({ status: 'unavailable' })
  })

  it('安全整数边界使用整数向上取整，单轮金额溢出则停止估算', () => {
    const fixture = make()
    const ledger = { ...fixture.ledger, sells: fixture.ledger.sells.map(sale => sale.sourceRow === 3 ? { ...sale, priceCents: 2, rebuyPriceCents: 1 } : sale) }
    expect(estimateRepairRounds({ ...fixture.chain, anchorQty: 1, gapCents: Number.MAX_SAFE_INTEGER }, ledger))
      .toMatchObject({ status: 'ready', rounds: Number.MAX_SAFE_INTEGER, profitPerRoundCents: 1 })
    expect(estimate(fixture, { ...fixture.chain, anchorQty: Number.MAX_SAFE_INTEGER })).toEqual({ status: 'unavailable' })
  })
})

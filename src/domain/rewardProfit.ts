import type { ChainBuildResult, ChainProfitSlice } from './chain'
import type { SellExecution } from './types'

export interface RewardProfitRow {
  groupKey: string
  stockId: string
  stockName: string
  priceCents: number
  /** 不含回本占用、包含已经回本后的净超额；尚未扣已买奖励花费。 */
  grossProfitCents: number
  /** 原有真实盈利口径，用于解释原始收益与可奖励累计的差异。 */
  rawProfitCents: number
  /** 本价位已实现但仍被回本消耗/锁定的净贡献，可为负。 */
  chainLockedCents: number
  /** 已回本链按价位正净贡献分配的净超额。 */
  chainReleasedCents: number
}

const validPrice = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value > 0
const validSlice = (slice: ChainProfitSlice) => validPrice(slice.costCents) && Number.isSafeInteger(slice.profitCents) && Number.isSafeInteger(slice.qty) && slice.qty > 0

/**
 * 同一分只供一次再买：链内份额先移出普通盈利，已回本链再释放扣完原亏损的净额。
 * 多成本价位按各价位「后续正净贡献」分配超额；最大余数法保证整数分合计精确。
 */
export function buildRewardProfit(
  sells: readonly SellExecution[],
  chainBuild: Pick<ChainBuildResult, 'chains' | 'profitSlices'>,
): RewardProfitRow[] {
  const rows = new Map<string, RewardProfitRow>()
  const rowFor = (stockId: string, stockName: string, priceCents: number) => {
    const groupKey = `${stockId}|${priceCents}`
    let row = rows.get(groupKey)
    if (!row) {
      row = { groupKey, stockId, stockName, priceCents, grossProfitCents: 0, rawProfitCents: 0, chainLockedCents: 0, chainReleasedCents: 0 }
      rows.set(groupKey, row)
    }
    return row
  }
  const salesById = new Map(sells.map(sale => [sale.id, sale]))
  const eligibleSales = new Map<string, RewardProfitRow>()
  for (const sale of sells) {
    // 原始规则只累计已知成本/利润的组。暂记合成成本没有 groupKey，不变成新收益。
    if (!sale.costComplete || sale.groupKey === null || sale.profitCents === null || !Number.isSafeInteger(sale.profitCents) || !validPrice(sale.costCents)) continue
    const row = rowFor(sale.stockId, sale.stockName, sale.costCents)
    row.rawProfitCents += sale.profitCents
    row.grossProfitCents += sale.profitCents
    eligibleSales.set(sale.id, row)
  }

  const chainById = new Map(chainBuild.chains.map(chain => [chain.id, chain]))
  const slicesByChain = new Map<string, ChainProfitSlice[]>()
  const seen = new Set<string>()
  for (const slice of chainBuild.profitSlices) {
    const chain = chainById.get(slice.chainId)
    const sale = salesById.get(slice.sellId)
    if (!chain || !sale || !validSlice(slice) || slice.stockName !== chain.stockName || slice.stockName !== sale.stockName || slice.stockId !== sale.stockId) continue
    const identity = `${slice.chainId}|${slice.sellId}|${slice.lotId ?? ''}|${slice.kind}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const own = slicesByChain.get(slice.chainId) ?? []
    own.push(slice)
    slicesByChain.set(slice.chainId, own)
    // 只分流原本在普通组里的盈利。合成亏损本就没入池，不再凭空扣第二遍。
    const ordinary = eligibleSales.get(slice.sellId)
    if (ordinary) {
      ordinary.grossProfitCents -= slice.profitCents
      ordinary.chainLockedCents += slice.profitCents
    }
    // 无可分配的收益也保留价位行，便于明细解释当前仍在回本。
    if (slice.kind === 'branch') rowFor(slice.stockId, slice.stockName, slice.costCents)
  }

  for (const chain of chainBuild.chains) {
    if (!chain.done || (chain.unlinkedQty ?? 0) > 0 || !Number.isSafeInteger(chain.netCents) || chain.netCents <= 0) continue
    const contributions = new Map<string, { row: RewardProfitRow; cents: bigint }>()
    for (const slice of slicesByChain.get(chain.id) ?? []) {
      if (slice.kind !== 'branch') continue
      const row = rowFor(slice.stockId, slice.stockName, slice.costCents)
      const contribution = contributions.get(row.groupKey) ?? { row, cents: 0n }
      contribution.cents += BigInt(slice.profitCents)
      contributions.set(row.groupKey, contribution)
    }
    const weights = [...contributions.values()].filter(contribution => contribution.cents > 0n)
    const total = weights.reduce((sum, contribution) => sum + contribution.cents, 0n)
    const budget = BigInt(chain.netCents)
    // 不完整的归属不能把超过实际正贡献的金额伪造成可奖励收益。
    if (total < budget || total === 0n) continue
    const allocations = weights.map(contribution => {
      const product = budget * contribution.cents
      return { row: contribution.row, cents: product / total, remainder: product % total }
    })
    allocations.sort((a, b) => a.remainder === b.remainder
      ? a.row.priceCents - b.row.priceCents || a.row.groupKey.localeCompare(b.row.groupKey)
      : a.remainder > b.remainder ? -1 : 1)
    let remainder = budget - allocations.reduce((sum, allocation) => sum + allocation.cents, 0n)
    for (const allocation of allocations) {
      const cents = Number(allocation.cents + (remainder > 0n ? 1n : 0n))
      if (remainder > 0n) remainder--
      allocation.row.grossProfitCents += cents
      allocation.row.chainReleasedCents += cents
      allocation.row.chainLockedCents -= cents
    }
  }
  return [...rows.values()].sort((a, b) => a.stockName.localeCompare(b.stockName) || a.priceCents - b.priceCents || a.groupKey.localeCompare(b.groupKey))
}

import type { Lot, RebuyExecution } from '../domain/types'
import type { NanoIdIndex } from './nanoid'
import type { TradesQuery } from './nav'

export type TradeSourceRef = number | { sourceRow: number; lotId?: string }

export interface TradeSourceIndex {
  nano: NanoIdIndex
  rowByLot: ReadonlyMap<string, number>
  rowByVirtualRow: ReadonlyMap<number, number>
}

export interface TradeSourceLink {
  query: TradesQuery | null
  /** 已解析到的真实记录，重复拆档及多次回补共用的来源只列一次。 */
  rows: number[]
  missing: boolean
}

/** 回补批次没有明细行，跳转应回到生成它的真实卖出记录，而非虚拟行号。 */
export function buildTradeSourceIndex(
  nano: NanoIdIndex,
  lots: readonly Pick<Lot, 'id' | 'sourceRow'>[],
  executions: readonly Pick<RebuyExecution, 'id' | 'sellExecId'>[],
): TradeSourceIndex {
  const executionRows = new Map<string, number>()
  for (const execution of executions) {
    const match = /^sell:(\d+)$/.exec(execution.sellExecId)
    if (match) executionRows.set(`lot:exec:${execution.id}`, Number(match[1]))
  }
  const rowByLot = new Map<string, number>()
  const rowByVirtualRow = new Map<number, number>()
  for (const lot of lots) {
    const row = lot.id.startsWith('lot:exec:') ? executionRows.get(lot.id) : lot.sourceRow
    if (row === undefined || !nano.rowToId.has(row)) continue
    rowByLot.set(lot.id, row)
    if (lot.id.startsWith('lot:exec:')) rowByVirtualRow.set(lot.sourceRow, row)
  }
  return { nano, rowByLot, rowByVirtualRow }
}

/** 来源必须全部可追溯，避免缺失 id 时意外打开整只股票的列表。 */
export function tradeSourceLink(
  stockName: string,
  refs: readonly TradeSourceRef[],
  index: TradeSourceIndex,
): TradeSourceLink {
  const rows: number[] = []
  const ids = new Set<string>()
  let missing = refs.length === 0
  for (const ref of refs) {
    const sourceRow = typeof ref === 'number' ? ref : ref.sourceRow
    const row = typeof ref !== 'number' && ref.lotId
      ? index.rowByLot.get(ref.lotId)
      : index.nano.rowToId.has(sourceRow) ? sourceRow : index.rowByVirtualRow.get(sourceRow)
    const id = row === undefined ? undefined : index.nano.rowToId.get(row)
    if (row === undefined || !id || index.nano.byId.get(id)?.stockName !== stockName) {
      missing = true
      continue
    }
    if (!ids.has(id)) {
      ids.add(id)
      rows.push(row)
    }
  }
  return { query: missing ? null : { stock: stockName, id: [...ids].join(',') }, rows, missing }
}

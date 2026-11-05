import type { LedgerSnapshot } from './ledgerSnapshot'

export function validateSnapshotRelations(s: LedgerSnapshot): void {
  const rows = new Map(s.records.map((r) => [r.sourceRow, r]))
  const execs = new Set(s.rebuyExecutions.map((e) => e.id))
  const batches = new Set(s.batches.map((b) => b.id))
  const executionsById = new Map(s.rebuyExecutions.map(e => [e.id, e]))
  const stockOfLot = (id: string): string | undefined => id.startsWith('lot:exec:')
    ? executionsById.get(id.slice(9))?.stockName : rows.get(Number(id.slice(4)))?.stockName
  const positive = (v: number, location: string, allowZero = false) => {
    if (!Number.isSafeInteger(v) || v < (allowZero ? 0 : 1)) throw new Error(`${location}：必须为${allowZero ? '非负' : '正'}整数`)
  }
  for (const r of s.records) {
    positive(r.sourceRow, `交易数据 记录ID ${r.sourceRow}`)
    for (const key of ['buyQtyRaw', 'soldQty', 'buyPriceCents', 'targetPriceCents', 'earlyBuyPriceCents'] as const) {
      if (r[key] !== null) positive(r[key], `交易数据 记录ID ${r.sourceRow} ${key}`, true)
    }
    if (r.batchId && !batches.has(r.batchId)) throw new Error(`交易数据 记录ID ${r.sourceRow}：导入批次 ${r.batchId} 不存在`)
    if (r.nextRoundOfRow === r.sourceRow) throw new Error(`交易数据 记录ID ${r.sourceRow}：不能引用自身为下一轮来源`)
    if (r.soldLotId && stockOfLot(r.soldLotId) !== r.stockName) throw new Error(`交易数据 记录ID ${r.sourceRow}：卖出来源批次股票不一致`)
    if (r.nextRoundOfRow !== undefined && rows.get(r.nextRoundOfRow)?.stockName !== r.stockName) throw new Error(`交易数据 记录ID ${r.sourceRow}：下一轮来源股票不一致`)
  }
  const lot = (id: string, location: string) => {
    if (id.startsWith('lot:exec:') ? !execs.has(id.slice(9)) : !/^lot:\d+$/.test(id) || !rows.has(Number(id.slice(4)))) throw new Error(`${location}：批次ID ${id} 不存在`)
  }
  for (const t of s.extraTargets) lot(t.lotId, `买单拆卖 ${t.id}`)
  for (const p of s.plans) {
    if (p.id !== `plan:${p.refId}`) throw new Error(`挂单计划 ${p.id}：计划ID 与挂单身份不一致`)
    if (p.refId.startsWith('target:lot:')) lot(p.refId.slice(7), `挂单计划 ${p.id}`)
    if (p.refId.startsWith('merge:') && !s.merges.some((m) => p.refId.startsWith(`${m.id}@`))) throw new Error(`挂单计划 ${p.id}：合并关联不存在`)
  }
  // 防止手改造成批次/成交依赖环，派生时这些行会不可达而静默少记。
  const visiting = new Set<number>(), visited = new Set<number>()
  const walk = (row: number) => {
    if (visiting.has(row)) throw new Error(`交易数据 记录ID ${row}：卖出来源批次形成循环引用`)
    if (visited.has(row)) return
    visiting.add(row)
    const id = rows.get(row)?.soldLotId
    if (id) {
      const parent = id.startsWith('lot:exec:')
        ? Number(s.rebuyExecutions.find((e) => e.id === id.slice(9))?.sellExecId.slice(5))
        : Number(id.slice(4))
      if (rows.has(parent)) walk(parent)
    }
    visiting.delete(row); visited.add(row)
  }
  for (const row of rows.keys()) walk(row)
  for (const h of s.hedges) {
    if (h.id !== `hedge:${h.sellRow}`) throw new Error(`人工高位关联 ${h.id}：关联ID 与卖出记录ID 不一致`)
    for (const it of h.items) {
      positive(it.qty, `人工高位分配 ${h.id}`)
      if (rows.get(it.row)?.stockName !== rows.get(h.sellRow)?.stockName || it.row === h.sellRow) throw new Error(`人工高位分配 ${h.id}：记录 ${it.row} 必须为同股票的其他记录`)
    }
  }
  const membership = new Set<number>()
  for (const c of s.chainLinks) {
    if (c.id !== `chainlink:${c.anchorRow}`) throw new Error(`人工回本链 ${c.id}：关联ID 与锚点记录ID 不一致`)
    for (const row of [c.anchorRow, ...c.memberRows]) if (rows.get(row)?.stockName !== c.stockName) throw new Error(`人工回本链 ${c.id}：记录 ${row} 股票不一致`)
    for (const row of c.memberRows) {
      if (row === c.anchorRow || membership.has(row)) throw new Error(`人工回本链 ${c.id}：成员记录 ${row} 重复归属或引用自身`)
      membership.add(row)
    }
  }
  for (const m of s.merges) for (const row of m.rows) if (rows.get(row)?.stockName !== m.stockName) throw new Error(`批次合并 ${m.id}：记录 ${row} 股票不一致`)
  const names = new Set<string>()
  for (const stock of s.stocks) {
    if (names.has(stock.name)) throw new Error(`股票设置：股票 ${stock.name} 重复`)
    names.add(stock.name)
    positive(stock.intervalCents, `股票设置 ${stock.name} 默认间隔`, true)
  }
  for (const e of s.rebuyExecutions) {
    if (e.orderId !== `rb:${e.sellExecId}` || !/^sell:\d+$/.test(e.sellExecId)) throw new Error(`回补成交 ${e.id}：订单ID 与卖出成交ID 不一致`)
    if (rows.get(Number(e.sellExecId.slice(5)))?.stockName !== e.stockName) throw new Error(`回补成交 ${e.id}：股票与卖出记录不一致`)
    if ((rows.get(Number(e.sellExecId.slice(5)))?.soldQty ?? 0) <= 0) throw new Error(`回补成交 ${e.id}：来源记录没有实际卖出股数`)
    const stock = s.stocks.find((st) => st.name === e.stockName)
    if (stock && stock.id !== e.stockId) throw new Error(`回补成交 ${e.id}：股票ID 与股票设置不一致`)
    positive(e.qty, `回补成交 ${e.id} 股数`)
    positive(e.priceCents, `回补成交 ${e.id} 价格`)
    positive(e.rewardQty, `回补成交 ${e.id} 奖励股数`, true)
    if (e.rewardQty > e.qty) throw new Error(`回补成交 ${e.id}：奖励股数大于成交股数`)
    if (e.rewardQty % 100 !== 0) throw new Error(`回补成交 ${e.id}：奖励股数必须为整手`)
  }
  for (const [label, list] of [['挂单计划', s.plans], ['买单拆卖', s.extraTargets], ['卖单拆买', s.buyTargets]] as const) {
    for (const t of list) { positive(t.qty, `${label} ${t.id} 股数`, 'strategy' in t && Boolean(t.strategy)); positive(t.priceCents, `${label} ${t.id} 价格`) }
  }
}

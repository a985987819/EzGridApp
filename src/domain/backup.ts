/**
 * 恢复前的最小内容校验：schemaVersion 之外再兜一道。
 * 结构坏掉的备份（手改 JSON、半截文件）整包拒绝，
 * 配合「恢复前强制导出」，保证本地数据不会被坏备份覆盖。
 *
 * V9.32：补齐派生输入表（回补成交 / 计划 / 拆分目标 / 挂钩分配）的结构校验。
 * 这些表以前完全不校验，`hedges: [{}]` 这种半截数据能通过校验，
 * 恢复后 buildLedger 里 `for (const it of h.items)` 直接抛异常 → 白屏。
 * 账户功能已删除：老备份里的 accounts 段直接忽略，不再校验。
 */

export interface BackupShape {
  schemaVersion?: number
  stocks?: unknown
  records?: unknown
  batches?: unknown
  auditLogs?: unknown
  rebuyExecutions?: unknown
  plans?: unknown
  extraTargets?: unknown
  /** V9.50：卖单拆出来的买入目标 */
  buyTargets?: unknown
  hedges?: unknown
  merges?: unknown
  chainLinks?: unknown
  bookingReceipts?: unknown
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isRow = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function checkRecords(records: unknown[]): string | null {
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as Obj | null
    if (!isObj(rec)) return `records[${i}] 不是对象`
    if (typeof rec.sourceRow !== 'number' || !Number.isInteger(rec.sourceRow)) return `records[${i}] 缺 sourceRow（行号）`
    if(rec.excelRow!==undefined && !isRow(rec.excelRow))return `records[${i}] Excel 行号不合法`
    if(rec.soldLotId!==undefined && (typeof rec.soldLotId!=='string'||!rec.soldLotId.startsWith('lot:')))return `records[${i}] 关联批次不合法`
    if(rec.soldTargetId!==undefined && (typeof rec.soldTargetId!=='string'||!rec.soldTargetId.startsWith('target:')||!rec.soldLotId))return `records[${i}] 卖出来源档不合法`
    if(rec.nextRoundOfRow!==undefined && !isRow(rec.nextRoundOfRow))return `records[${i}] 下一轮来源不合法`
    if (typeof rec.importKey !== 'string' || rec.importKey === '') return `records[${i}] 缺 importKey`
    if (typeof rec.stockName !== 'string' || rec.stockName === '') return `records[${i}] 缺 stockName`
    for (const key of ['buyPriceCents', 'buyQtyRaw', 'soldQty', 'targetPriceCents', 'earlyBuyPriceCents', 'rawProfitCents'] as const) {
      if (rec[key] !== undefined && rec[key] !== null && (!Number.isSafeInteger(rec[key]) || (key !== 'rawProfitCents' && (rec[key] as number) < 0))) return `records[${i}] ${key} 必须是有限安全整数`
    }
    for (const key of ['buyDateSerial', 'sellDateSerial', 'deletedAt', 'editedAt']) if (rec[key] !== undefined && rec[key] !== null && !isNum(rec[key])) return `records[${i}] ${key} 不合法`
  }
  return null
}

function checkStocks(stocks: unknown[]): string | null {
  for (let i = 0; i < stocks.length; i += 1) {
    const s = stocks[i] as Obj | null
    if (!isObj(s)) return `stocks[${i}] 不是对象`
    if (typeof s.id !== 'string' || s.id === '') return `stocks[${i}] 缺 id`
    if (typeof s.name !== 'string' || s.name === '') return `stocks[${i}] 缺 name`
    if (!isNum(s.intervalCents)) return `stocks[${i}] 缺 intervalCents（绝对间隔）`
  }
  return null
}

/** 回补成交：orderId / sellExecId / 股数 / 成交价缺一不可（缺了净持仓和奖励预算都会算歪） */
function checkExecutions(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i] as Obj | null
    if (!isObj(e)) return `rebuyExecutions[${i}] 不是对象`
    if (typeof e.id !== 'string' || e.id === '') return `rebuyExecutions[${i}] 缺 id`
    if (typeof e.orderId !== 'string' || e.orderId === '') return `rebuyExecutions[${i}] 缺 orderId`
    if (typeof e.sellExecId !== 'string' || e.sellExecId === '') return `rebuyExecutions[${i}] 缺 sellExecId`
    if (!isNum(e.qty)) return `rebuyExecutions[${i}] 缺 qty`
    if (!isNum(e.priceCents)) return `rebuyExecutions[${i}] 缺 priceCents`
    if (!isNum(e.at)) return `rebuyExecutions[${i}] 缺 at`
    if (typeof e.groupKeyAtExecution !== 'string') return `rebuyExecutions[${i}] 缺 groupKeyAtExecution`
    if (e.buyTargetId !== undefined && (typeof e.buyTargetId !== 'string' || e.buyTargetId === '')) return `rebuyExecutions[${i}] 买入来源档不合法`
    if (!Number.isSafeInteger(e.qty) || (e.qty as number) <= 0 || !Number.isSafeInteger(e.priceCents) || (e.priceCents as number) <= 0 || !Number.isSafeInteger(e.rewardQty) || (e.rewardQty as number) < 0 || (e.rewardQty as number) > (e.qty as number) || (e.rewardQty as number) % 100 !== 0) return `rebuyExecutions[${i}] 股数、价格或奖励不合法`
  }
  return null
}

function checkPlans(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i] as Obj | null
    if (!isObj(p)) return `plans[${i}] 不是对象`
    if (typeof p.id !== 'string' || p.id === '') return `plans[${i}] 缺 id`
    if (typeof p.refId !== 'string' || p.refId === '') return `plans[${i}] 缺 refId`
    if (!isNum(p.priceCents)) return `plans[${i}] 缺 priceCents`
    if (!isNum(p.qty)) return `plans[${i}] 缺 qty`
  }
  return null
}

function checkExtraTargets(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i] as Obj | null
    if (!isObj(t)) return `extraTargets[${i}] 不是对象`
    if (typeof t.id !== 'string' || t.id === '') return `extraTargets[${i}] 缺 id`
    if (typeof t.lotId !== 'string' || t.lotId === '') return `extraTargets[${i}] 缺 lotId`
    if (!isNum(t.priceCents)) return `extraTargets[${i}] 缺 priceCents`
    if (!isNum(t.qty)) return `extraTargets[${i}] 缺 qty`
  }
  return null
}

/** 挂钩分配：sellRow + items[{row,qty}] 是 buildLedger 直接 for..of 的结构，缺了会抛异常 */
function checkHedges(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const h = list[i] as Obj | null
    if (!isObj(h)) return `hedges[${i}] 不是对象`
    if (typeof h.id !== 'string' || h.id === '') return `hedges[${i}] 缺 id`
    if (!isRow(h.sellRow)) return `hedges[${i}] 缺 sellRow（卖出所在行号）`
    if (!Array.isArray(h.items)) return `hedges[${i}].items 不是数组`
    for (let j = 0; j < h.items.length; j += 1) {
      const it = h.items[j] as Obj | null
      if (!isObj(it)) return `hedges[${i}].items[${j}] 不是对象`
      if (!isRow(it.row)) return `hedges[${i}].items[${j}] 缺 row（买入所在行号）`
      if (!isNum(it.qty)) return `hedges[${i}].items[${j}] 缺 qty`
    }
  }
  return null
}

/** 合并同价买单（V9.45）：rows 是组内批次行号，缺了会让挂单页合并显示报错 */
function checkMerges(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i] as Obj | null
    if (!isObj(m)) return `merges[${i}] 不是对象`
    if (typeof m.id !== 'string' || m.id === '') return `merges[${i}] 缺 id`
    if (typeof m.stockName !== 'string' || m.stockName === '') return `merges[${i}] 缺 stockName`
    if (!isNum(m.priceCents)) return `merges[${i}] 缺 priceCents`
    if (!Array.isArray(m.rows) || m.rows.length < 2) return `merges[${i}].rows 至少要有两笔行号`
    for (let j = 0; j < m.rows.length; j += 1) {
      if (!isRow(m.rows[j])) return `merges[${i}].rows[${j}] 不是整数行号`
    }
  }
  return null
}

/** 回本链归属（V9.46）：anchorRow + memberRows 直接喂给 buildRepairChains，缺了会白屏 */
function checkChainLinks(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i] as Obj | null
    if (!isObj(c)) return `chainLinks[${i}] 不是对象`
    if (typeof c.id !== 'string' || c.id === '') return `chainLinks[${i}] 缺 id`
    if (!isRow(c.anchorRow)) return `chainLinks[${i}] 缺 anchorRow（锚点行号）`
    if (typeof c.stockName !== 'string' || c.stockName === '') return `chainLinks[${i}] 缺 stockName`
    if (!Array.isArray(c.memberRows)) return `chainLinks[${i}].memberRows 不是数组`
    for (let j = 0; j < c.memberRows.length; j += 1) {
      if (!isRow(c.memberRows[j])) return `chainLinks[${i}].memberRows[${j}] 不是整数行号`
    }
    if (c.closedAt !== null && !isNum(c.closedAt)) return `chainLinks[${i}] 的 closedAt 只能是数字或 null`
  }
  return null
}

/** 卖单拆买（V9.50）：sellRow + 价位 + 股数，缺了会让挂单页分段报错 */
function checkBuyTargets(list: unknown[]): string | null {
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i] as Obj | null
    if (!isObj(t)) return `buyTargets[${i}] 不是对象`
    if (typeof t.id !== 'string' || t.id === '') return `buyTargets[${i}] 缺 id`
    if (!isRow(t.sellRow)) return `buyTargets[${i}] 缺 sellRow（卖单所在行号）`
    if (!isNum(t.priceCents)) return `buyTargets[${i}] 缺 priceCents`
    if (!isNum(t.qty)) return `buyTargets[${i}] 缺 qty`
  }
  return null
}

/** 每张表：是数组 + 逐项校验；键不存在就跳过（老备份允许缺表） */
const TABLES: { key: keyof BackupShape; label: string; check: (list: unknown[]) => string | null }[] = [
  { key: 'records', label: 'records', check: checkRecords },
  { key: 'stocks', label: 'stocks', check: checkStocks },
  { key: 'rebuyExecutions', label: '回补成交', check: checkExecutions },
  { key: 'plans', label: '计划价', check: checkPlans },
  { key: 'extraTargets', label: '拆分目标', check: checkExtraTargets },
  { key: 'buyTargets', label: '拆分买入', check: checkBuyTargets },
  { key: 'hedges', label: '挂钩分配', check: checkHedges },
  { key: 'merges', label: '合并买单', check: checkMerges },
  { key: 'chainLinks', label: '回本链归属', check: checkChainLinks },
]

/**
 * V9.56：结构对 ≠ 引用对。上面这些表全部以「行号 / 批次号」当外键，指向不存在的行时
 * buildLedger 是**静默跳过**的（挂钩失效、soldLotId 找不到成本 → 那笔卖出的 profitCents
 * 变 null 直接不计入合计），界面却提示「恢复成功」——账面就这么静默少算了。
 * 所以恢复前把引用关系也走一遍：宁可整包拒绝，也不让半截备份把本地账算歪。
 */
function checkReferences(data: BackupShape): string | null {
  if (!Array.isArray(data.records)) return null
  const recordList = data.records as Obj[]
  const rows = new Set(recordList.map((r) => r.sourceRow as number))
  const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : [])
  const execs = list(data.rebuyExecutions)
  const execIds = new Set(execs.map((e) => e.id).filter((id): id is string => typeof id === 'string'))
  const lotRow = (id: unknown): number | null => {
    if (typeof id !== 'string') return null
    const m = /^lot:(\d+)$/.exec(id)
    return m ? Number(m[1]) : null
  }
  const planRow = (refId: unknown): number | null => {
    if (typeof refId !== 'string') return null
    const a = /^target:lot:(\d+)$/.exec(refId)
    if (a) return Number(a[1])
    const b = /^rb:sell:(\d+)$/.exec(refId)
    if (b) return Number(b[1])
    return null
  }
  const execRow = (id: unknown): number | null => {
    if (typeof id !== 'string') return null
    const m = /^sell:(\d+)$/.exec(id)
    return m ? Number(m[1]) : null
  }

  /**
   * V9.57：records 自己的两个引用也要查——V9.56 只查了关联表。
   * - soldLotId 指向不存在的批次 / 回补成交 → 那笔卖出的成本变 null，盈利静默不计；
   * - nextRoundOfRow 指向不存在的行 → 下一轮买入的「已消耗额度」对不上。
   */
  for (let i = 0; i < recordList.length; i += 1) {
    const sold = recordList[i].soldLotId
    if (sold !== undefined) {
      if (typeof sold !== 'string') return `records[${i}].soldLotId 不是字符串`
      if (sold.startsWith('lot:exec:')) {
        if (!execIds.has(sold.slice('lot:exec:'.length))) {
          return `records[${i}].soldLotId 指向不存在的回补成交 ${sold}`
        }
      } else {
        const row = lotRow(sold)
        if (row === null || !rows.has(row)) return `records[${i}].soldLotId 指向不存在的批次 ${sold}`
      }
    }
    const next = recordList[i].nextRoundOfRow
    if (next !== undefined && !rows.has(next as number)) {
      return `records[${i}].nextRoundOfRow 指向不存在的行 ${String(next)}`
    }
  }

  const hedges = list(data.hedges)
  for (let i = 0; i < hedges.length; i += 1) {
    const h = hedges[i]
    if (!rows.has(h.sellRow as number)) return `hedges[${i}] 指向不存在的卖出行 ${String(h.sellRow)}`
    const items = list(h.items)
    for (let j = 0; j < items.length; j += 1) {
      if (!rows.has(items[j].row as number)) return `hedges[${i}].items[${j}] 指向不存在的买入行 ${String(items[j].row)}`
    }
  }

  const buyTargets = list(data.buyTargets)
  for (let i = 0; i < buyTargets.length; i += 1) {
    if (!rows.has(buyTargets[i].sellRow as number)) return `buyTargets[${i}] 指向不存在的卖出行 ${String(buyTargets[i].sellRow)}`
  }

  const extraTargets = list(data.extraTargets)
  for (let i = 0; i < extraTargets.length; i += 1) {
    const row = lotRow(extraTargets[i].lotId)
    if (row !== null && !rows.has(row)) return `extraTargets[${i}] 指向不存在的批次 ${String(extraTargets[i].lotId)}`
  }

  const merges = list(data.merges)
  for (let i = 0; i < merges.length; i += 1) {
    const members = Array.isArray(merges[i].rows) ? (merges[i].rows as number[]) : []
    for (let j = 0; j < members.length; j += 1) {
      if (!rows.has(members[j])) return `merges[${i}].rows[${j}] 指向不存在的行 ${String(members[j])}`
    }
  }

  const chainLinks = list(data.chainLinks)
  for (let i = 0; i < chainLinks.length; i += 1) {
    if (!rows.has(chainLinks[i].anchorRow as number)) return `chainLinks[${i}] 的锚点行 ${String(chainLinks[i].anchorRow)} 不存在`
    const members = Array.isArray(chainLinks[i].memberRows) ? (chainLinks[i].memberRows as number[]) : []
    for (let j = 0; j < members.length; j += 1) {
      if (!rows.has(members[j])) return `chainLinks[${i}].memberRows[${j}] 指向不存在的行 ${String(members[j])}`
    }
  }

  for (let i = 0; i < execs.length; i += 1) {
    const row = execRow(execs[i].sellExecId)
    if (row !== null && !rows.has(row)) return `rebuyExecutions[${i}] 指向不存在的卖出行 ${String(execs[i].sellExecId)}`
  }

  const plans = list(data.plans)
  for (let i = 0; i < plans.length; i += 1) {
    const row = planRow(plans[i].refId)
    if (row !== null && !rows.has(row)) return `plans[${i}] 的计划身份指向不存在的行 ${String(plans[i].refId)}`
  }

  return null
}

/** 通过返回 null；不通过返回中文原因，恢复方直接抛错 */
export function validateBackup(data: BackupShape): string | null {
  if (!isObj(data)) return '备份必须是对象'
  for (const t of TABLES) {
    const value = data[t.key]
    if (value === undefined) continue
    if (!Array.isArray(value)) return `${t.key} 不是数组`
    const problem = t.check(value)
    if (problem) return problem
    const keys = new Set<unknown>()
    for (const row of value as Obj[]) {
      const key = row.sourceRow ?? row.id
      if (keys.has(key)) return `${t.key} 主键重复：${String(key)}`
      keys.add(key)
    }
  }
  if (data.bookingReceipts !== undefined) {
    if (!Array.isArray(data.bookingReceipts)) return 'bookingReceipts 不是数组'
    const ids = new Set<string>(), refs = new Set<string>(), allocations = new Set<string>()
    for (const r of data.bookingReceipts as Obj[]) {
      if (!isObj(r) || typeof r.id !== 'string' || !r.id || ids.has(r.id) || typeof r.payload !== 'string' || !['buy','sell','import'].includes(String(r.kind)) || typeof r.stockName !== 'string' || !r.stockName.trim() || !isNum(r.at) || !Number.isSafeInteger(r.qty) || !Number.isSafeInteger(r.priceCents) || !Array.isArray(r.recordRows) || !Array.isArray(r.executionIds) || r.recordRows.some(row => !isRow(row)) || r.executionIds.some(id => typeof id !== 'string') || (r.date !== null && (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)))) return 'bookingReceipts 回执结构或唯一身份不合法'
      ids.add(r.id)
      if ((r.qty as number) <= 0 || (r.priceCents as number) <= 0 || new Set(r.recordRows as number[]).size !== r.recordRows.length || new Set(r.executionIds as string[]).size !== r.executionIds.length || ['reviewedAt','voidedAt'].some(key => r[key] !== undefined && !isNum(r[key]))) return 'bookingReceipts 价量、状态或分配身份不合法'
      if (!r.voidedAt && (r.recordRows as number[]).length + (r.executionIds as string[]).length === 0) return 'bookingReceipts 缺少来源分配'
      if (!r.voidedAt) for (const key of [...(r.recordRows as number[]).map(row => `${String(r.kind)}:${row}`), ...(r.executionIds as string[]).map(id => `execution:${id}`)]) {
        if (allocations.has(key)) return `bookingReceipts 来源分配重复：${key}`
        allocations.add(key)
      }
      if (r.externalRef !== undefined) {
        if (typeof r.externalRef !== 'string' || !r.externalRef || refs.has(r.externalRef)) return 'bookingReceipts 凭据身份重复或不合法'
        refs.add(r.externalRef)
      }
      if (!r.voidedAt && Array.isArray(data.records) && r.recordRows.some(row => !(data.records as Obj[]).some(record => record.sourceRow === row))) return `bookingReceipts ${r.id} 记录分配来源不存在`
      if (!r.voidedAt && Array.isArray(data.rebuyExecutions) && r.executionIds.some(id => !(data.rebuyExecutions as Obj[]).some(e => e.id === id))) return `bookingReceipts ${r.id} 回补分配来源不存在`
    }
  }
  if (Array.isArray(data.records)) {
    const rows = new Map((data.records as Obj[]).map(r => [r.sourceRow, r]))
    const execs = Array.isArray(data.rebuyExecutions) ? data.rebuyExecutions as Obj[] : []
    const visiting = new Set<unknown>(), visited = new Set<unknown>()
    const walk = (id: unknown): boolean => {
      if (visiting.has(id)) return false
      if (visited.has(id)) return true
      visiting.add(id)
      const r = rows.get(id)
      if (r?.nextRoundOfRow !== undefined && !walk(r.nextRoundOfRow)) return false
      if (typeof r?.soldLotId === 'string') {
        const parent = r.soldLotId.startsWith('lot:exec:') ? Number(String(execs.find(e => e.id === r.soldLotId!.toString().slice(9))?.sellExecId).slice(5)) : Number(r.soldLotId.slice(4))
        if (rows.has(parent) && !walk(parent)) return false
      }
      visiting.delete(id); visited.add(id); return true
    }
    for (const id of rows.keys()) if (!walk(id)) return `records 记录 ${String(id)} 来源形成循环引用`
  }
  return checkReferences(data)
}

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
  hedges?: unknown
  merges?: unknown
  chainLinks?: unknown
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
    if (typeof rec.importKey !== 'string' || rec.importKey === '') return `records[${i}] 缺 importKey`
    if (typeof rec.stockName !== 'string' || rec.stockName === '') return `records[${i}] 缺 stockName`
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

/** 每张表：是数组 + 逐项校验；键不存在就跳过（老备份允许缺表） */
const TABLES: { key: keyof BackupShape; label: string; check: (list: unknown[]) => string | null }[] = [
  { key: 'records', label: 'records', check: checkRecords },
  { key: 'stocks', label: 'stocks', check: checkStocks },
  { key: 'rebuyExecutions', label: '回补成交', check: checkExecutions },
  { key: 'plans', label: '计划价', check: checkPlans },
  { key: 'extraTargets', label: '拆分目标', check: checkExtraTargets },
  { key: 'hedges', label: '挂钩分配', check: checkHedges },
  { key: 'merges', label: '合并买单', check: checkMerges },
  { key: 'chainLinks', label: '回本链归属', check: checkChainLinks },
]

/** 通过返回 null；不通过返回中文原因，恢复方直接抛错 */
export function validateBackup(data: BackupShape): string | null {
  for (const t of TABLES) {
    const value = data[t.key]
    if (value === undefined) continue
    if (!Array.isArray(value)) return `${t.key} 不是数组`
    const problem = t.check(value)
    if (problem) return problem
  }
  return null
}

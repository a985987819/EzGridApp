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

import { isSellFirst } from './sellFirst'
import type { RawRecord } from './types'
import type { LedgerSnapshot } from './ledgerSnapshot'
import { DEFAULT_STOCKS } from './defaults'
import { validateSnapshotRelations } from './snapshotRelations'
import { validateFinancialTotals } from './financialSafety'

export interface BackupShape {
  schemaVersion?: number
  exportedAt?: unknown
  settings?: unknown
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
const isRow = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isTime = (v: unknown): v is number => isNonNegative(v) && v <= 8640000000000000
const NULLABLE_RECORD_FIELDS = ['buyDateSerial', 'buyPriceCents', 'buyQtyRaw', 'targetPriceCents', 'soldQty', 'sellDateSerial', 'earlyBuyPriceCents', 'rawProfitCents'] as const

function checkRecords(records: unknown[]): string | null {
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as Obj | null
    if (!isObj(rec)) return `records[${i}] 不是对象`
    if (!isRow(rec.sourceRow)) return `records[${i}] sourceRow（行号）必须是正的安全整数`
    if(rec.excelRow!==undefined && !isRow(rec.excelRow))return `records[${i}] Excel 行号不合法`
    if(rec.soldLotId!==undefined && (typeof rec.soldLotId!=='string'||!rec.soldLotId.startsWith('lot:')))return `records[${i}] 关联批次不合法`
    if(rec.soldTargetId!==undefined && (typeof rec.soldTargetId!=='string'||!rec.soldTargetId.startsWith('target:')||!rec.soldLotId))return `records[${i}] 卖出来源档不合法`
    if(rec.nextRoundOfRow!==undefined && !isRow(rec.nextRoundOfRow))return `records[${i}] 下一轮来源不合法`
    if (typeof rec.importKey !== 'string' || !rec.importKey.trim()) return `records[${i}] 缺 importKey`
    if (typeof rec.stockName !== 'string' || !rec.stockName.trim()) return `records[${i}] 缺 stockName`
    for (const key of ['buyPriceCents', 'buyQtyRaw', 'soldQty', 'targetPriceCents', 'earlyBuyPriceCents', 'rawProfitCents'] as const) {
      if (rec[key] !== undefined && rec[key] !== null && (!Number.isSafeInteger(rec[key]) || (key !== 'rawProfitCents' && (rec[key] as number) < 0))) return `records[${i}] ${key} 必须是有限安全整数`
    }
    for (const key of ['buyDateSerial', 'sellDateSerial']) if (rec[key] !== undefined && rec[key] !== null && (!isNum(rec[key]) || rec[key] <= 0 || rec[key] > 2958465)) return `records[${i}] ${key} 不合法`
    for (const key of ['deletedAt', 'editedAt']) if (rec[key] !== undefined && rec[key] !== null && !isTime(rec[key])) return `records[${i}] ${key} 不合法`
    for (const key of ['qtyNeedsDerive', 'targetNeedsDerive', 'buyDateNeedsToday', 'sellDateNeedsToday']) if (rec[key] !== undefined && typeof rec[key] !== 'boolean') return `records[${i}] ${key} 必须是布尔值`
    if (rec.origin !== undefined && !['excel', 'manual'].includes(String(rec.origin))) return `records[${i}] origin 不合法`
    if (rec.rebuyPriceSource !== undefined && !['custom', 'lot', 'p', 'sellMinusInterval', 'repaid'].includes(String(rec.rebuyPriceSource))) return `records[${i}] rebuyPriceSource 不合法`
    if (rec.batchId !== undefined && rec.batchId !== null && (typeof rec.batchId !== 'string' || !rec.batchId)) return `records[${i}] batchId 不合法`
    for (const [price, qty] of [['buyPriceCents', 'buyQtyRaw'], ['targetPriceCents', 'soldQty']] as const) {
      if (isNum(rec[price]) && isNum(rec[qty]) && !Number.isSafeInteger(rec[price] * rec[qty])) return `records[${i}] ${price} × ${qty} 金额超出安全整数范围`
    }
    if (rec.profitRewardQty !== undefined) {
      const reward = rec.profitRewardQty
      if (!Number.isSafeInteger(reward) || (reward as number) < 0 || (reward as number) % 100 !== 0 || !Number.isSafeInteger(rec.buyQtyRaw) || (reward as number) > (rec.buyQtyRaw as number)) return `records[${i}] 盈利奖励股数须为买入量内的非负整手`
      if ((reward as number) > 0 && (typeof rec.profitRewardGroupKey !== 'string' || !rec.profitRewardGroupKey || !isRow(rec.nextRoundOfRow) || rec.soldLotId !== undefined || !Number.isSafeInteger(rec.buyPriceCents) || (rec.buyPriceCents as number) <= 0)) return `records[${i}] 盈利奖励缺少有效价组或下一轮买入来源`
      if ((reward as number) > 0 && !Number.isSafeInteger((reward as number) * (rec.buyPriceCents as number))) return `records[${i}] 盈利奖励金额超出安全整数范围`
    }
    if (rec.profitRewardGroupKey !== undefined && (typeof rec.profitRewardGroupKey !== 'string' || !rec.profitRewardGroupKey || !Number.isSafeInteger(rec.profitRewardQty) || (rec.profitRewardQty as number) <= 0)) return `records[${i}] 盈利奖励价组须对应有效奖励股数`
  }
  return null
}

function checkStocks(stocks: unknown[]): string | null {
  for (let i = 0; i < stocks.length; i += 1) {
    const s = stocks[i] as Obj | null
    if (!isObj(s)) return `stocks[${i}] 不是对象`
    if (typeof s.id !== 'string' || !s.id.trim()) return `stocks[${i}] 缺 id`
    if (typeof s.name !== 'string' || !s.name.trim()) return `stocks[${i}] 缺 name`
    if (['code', 'note'].some(key => s[key] !== undefined && typeof s[key] !== 'string')) return `stocks[${i}] 代码或备注不合法`
    if (!isNonNegative(s.intervalCents)) return `stocks[${i}] intervalCents（绝对间隔）必须是非负安全整数`
    if (s.priceLimitType !== undefined && !['main_10', 'gem_20', 'star_20', 'bse_30', 'st_5', 'custom', 'unknown'].includes(String(s.priceLimitType))) return `stocks[${i}] priceLimitType 不合法`
    if (s.order !== undefined && !isNonNegative(s.order)) return `stocks[${i}] order 不合法`
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') return `stocks[${i}] enabled 不合法`
    if (s.customLimitPct !== undefined && s.customLimitPct !== null && (!isNum(s.customLimitPct) || s.customLimitPct <= 0)) return `stocks[${i}] customLimitPct 不合法`
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
    if (!isTime(e.at) || typeof e.stockName !== 'string' || !e.stockName.trim() || typeof e.stockId !== 'string' || !e.stockId || typeof e.groupKeyAtExecution !== 'string' || !Number.isSafeInteger((e.qty as number) * (e.priceCents as number))) return `rebuyExecutions[${i}] 股票、时间或成交金额不合法`
    if ((e.note !== undefined && typeof e.note !== 'string') || (e.buyTargetId !== undefined && (typeof e.buyTargetId !== 'string' || !e.buyTargetId.trim()))) return `rebuyExecutions[${i}] 备注或买入来源档不合法`
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
    if (!isRow(p.priceCents) || !isRow(p.qty) || (p.kind !== undefined && !['buy', 'sell'].includes(String(p.kind))) || (p.at !== undefined && !isTime(p.at))) return `plans[${i}] 价量、方向或时间不合法`
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
    if (!isRow(t.priceCents) || !isNonNegative(t.qty) || (t.qty === 0 && t.strategy === undefined) || (t.at !== undefined && !isTime(t.at))) return `extraTargets[${i}] 价量或时间不合法`
    if (t.strategy !== undefined) {
      const s = t.strategy
      if (!isObj(s) || !['repair','baseT'].includes(String(s.mode)) || typeof s.groupId !== 'string' || !s.groupId
        || !Number.isSafeInteger(s.rebuyPriceCents) || (s.rebuyPriceCents as number) <= 0
        || !Number.isSafeInteger(s.nextSellPriceCents) || (s.nextSellPriceCents as number) <= 0
        || !Number.isSafeInteger(t.qty) || (t.qty as number) < 0 || !Number.isSafeInteger(t.priceCents) || (t.priceCents as number) <= 0) return `extraTargets[${i}] 策略模式或价量不合法`
      if (s.sellRow !== undefined && !isRow(s.sellRow)) return `extraTargets[${i}] 策略卖出来源不合法`
      if (!isNum(t.at) || (s.inputSignature !== undefined && typeof s.inputSignature !== 'string')) return `extraTargets[${i}] 策略身份或时间不合法`
      if (s.sellRow !== undefined && (s.mode !== 'baseT' || t.qty !== 0 || !/^lot:\d+$/.test(String(t.lotId)))) return `extraTargets[${i}] 已有先卖模式关联不合法`
    }
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
      if (!isRow(it.qty)) return `hedges[${i}].items[${j}] qty 必须是正的安全整数`
    }
    if (h.at !== undefined && !isTime(h.at)) return `hedges[${i}] at 不合法`
    if (new Set((h.items as Obj[]).map(item => item.row)).size !== h.items.length) return `hedges[${i}] 分配来源重复`
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
    if (!isRow(m.priceCents) || (m.at !== undefined && !isTime(m.at))) return `merges[${i}] 价格或时间不合法`
    if (!Array.isArray(m.rows) || m.rows.length < 2) return `merges[${i}].rows 至少要有两笔行号`
    for (let j = 0; j < m.rows.length; j += 1) {
      if (!isRow(m.rows[j])) return `merges[${i}].rows[${j}] 不是整数行号`
    }
    if (new Set(m.rows).size !== m.rows.length) return `merges[${i}].rows 成员重复`
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
    if (c.closedAt !== null && !isTime(c.closedAt)) return `chainLinks[${i}] 的 closedAt 只能是有效时间戳或 null`
    if (c.at !== undefined && !isTime(c.at)) return `chainLinks[${i}] at 不合法`
    if (new Set(c.memberRows).size !== c.memberRows.length) return `chainLinks[${i}].memberRows 成员重复`
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
    if (!isRow(t.qty) || !isRow(t.priceCents) || (t.at !== undefined && !isTime(t.at))) return `buyTargets[${i}] 价量或时间不合法`
  }
  return null
}

function checkBatches(list: unknown[]): string | null {
  for (const [i, batch] of list.entries()) {
    if (!isObj(batch) || typeof batch.id !== 'string' || !batch.id || typeof batch.fileName !== 'string' || !batch.fileName.trim() || typeof batch.sheetName !== 'string' || !batch.sheetName.trim() || !isTime(batch.importedAt) || !isNonNegative(batch.recordCount) || !isNonNegative(batch.addedCount) || (batch.updatedCount !== undefined && !isNonNegative(batch.updatedCount))) return `batches[${i}] 批次结构、时间或数量不合法`
  }
  return null
}

function checkAudits(list: unknown[]): string | null {
  for (const [i, audit] of list.entries()) {
    if (!isObj(audit) || (audit.id !== undefined && !isRow(audit.id)) || !['record', 'stock', 'order', 'merge', 'chain'].includes(String(audit.entity)) || !isTime(audit.at) || ['entityId', 'field', 'oldValue', 'newValue', 'source'].some(key => typeof audit[key] !== 'string')) return `auditLogs[${i}] 审计结构或时间不合法`
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
  { key: 'batches', label: '导入批次', check: checkBatches },
  { key: 'auditLogs', label: '审计记录', check: checkAudits },
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
    const rewardKey = recordList[i].profitRewardGroupKey
    if (typeof rewardKey === 'string') {
      const cleanKey = rewardKey.replace(/^acc:[^|]*\|/, '')
      const separator = cleanKey.lastIndexOf('|')
      const stockId = cleanKey.slice(0, separator), priceText = cleanKey.slice(separator + 1)
      const stock = list(data.stocks).find(candidate => candidate.name === recordList[i].stockName)
      if (separator < 1 || stockId !== (stock?.id ?? `stock:${String(recordList[i].stockName)}`) || !/^\d+$/.test(priceText) || !Number.isSafeInteger(Number(priceText)) || Number(priceText) <= 0) return `records[${i}] 盈利奖励价组与股票或成本不匹配`
      const parent = recordList.find(record => record.sourceRow === recordList[i].nextRoundOfRow)
      if (!parent || parent.stockName !== recordList[i].stockName) return `records[${i}] 盈利奖励下一轮来源必须属于同一股票`
    }
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
  const modeRows = new Set<number>()
  for (let i = 0; i < extraTargets.length; i += 1) {
    const row = lotRow(extraTargets[i].lotId)
    if (row !== null && !rows.has(row)) return `extraTargets[${i}] 指向不存在的批次 ${String(extraTargets[i].lotId)}`
    const strategy = extraTargets[i].strategy as Obj | undefined
    if (strategy?.sellRow !== undefined && !rows.has(strategy.sellRow as number)) return `extraTargets[${i}] 策略卖出来源不存在`
    if (strategy?.sellRow !== undefined) {
      const sellRow = strategy.sellRow as number
      if (modeRows.has(sellRow)) return `extraTargets[${i}] 同一先卖单存在重复模式关联`
      modeRows.add(sellRow)
      const sell = recordList.find(r=>r.sourceRow===sellRow), source = recordList.find(r=>r.sourceRow===row)
      if (!sell || !source || sell.stockName!==source.stockName || sell.soldLotId || !isSellFirst(sell as unknown as RawRecord) || !isNum(sell.soldQty) || sell.soldQty<=0) return `extraTargets[${i}] 已有先卖单模式与来源不匹配`
    }
    if (strategy && String(extraTargets[i].lotId).startsWith('lot:exec:') && !execIds.has(String(extraTargets[i].lotId).slice(9))) return `extraTargets[${i}] 批次不存在 ${String(extraTargets[i].lotId)}`
  }

  for (const record of recordList) if (String(record.soldTargetId ?? '').startsWith('target:grid:')) {
    const target = extraTargets.find(t=>`target:${String(t.id)}`===record.soldTargetId)
    if (!target?.strategy || target.lotId!==record.soldLotId) return `records 策略档来源缺失或批次不匹配：${String(record.soldTargetId)}`
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
  if (data.schemaVersion === 14) {
    for (const key of [...TABLES.map(table => table.key), 'batches', 'auditLogs', 'bookingReceipts'] as const) {
      if (!Array.isArray(data[key])) return `当前结构14缺少完整的 ${key} 表`
    }
    if (!isObj(data.settings) || typeof data.settings.deriveSellPrice !== 'boolean') return '当前结构14缺少有效的计算设置 settings'
    if (typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt))) return '当前结构14缺少有效的导出时间 exportedAt'
    for (const [i, record] of (data.records as unknown[]).entries()) {
      if (!isObj(record)) return `records[${i}] 不是对象`
      for (const key of NULLABLE_RECORD_FIELDS) if (!(key in record) || record[key] === undefined) return `records[${i}] 缺少必需字段 ${key}（未知值须显式为 null）`
      for (const key of ['qtyNeedsDerive', 'targetNeedsDerive']) if (typeof record[key] !== 'boolean') return `records[${i}] ${key} 必须是布尔值`
    }
    for (const [i, stock] of (data.stocks as unknown[]).entries()) if (isObj(stock) && typeof stock.priceLimitType !== 'string') return `stocks[${i}] 缺少必需字段 priceLimitType`
    for (const key of ['plans', 'extraTargets', 'buyTargets', 'hedges', 'merges', 'chainLinks'] as const) {
      for (const [i, item] of (data[key] as unknown[]).entries()) if (!isObj(item) || !isTime(item.at)) return `${key}[${i}] 缺少有效的 at 时间戳`
    }
    for (const [i, plan] of (data.plans as unknown[]).entries()) if (!isObj(plan) || !['buy', 'sell'].includes(String(plan.kind))) return `plans[${i}] 缺少有效的买卖方向 kind`
  }
  for (const t of TABLES) {
    const value = data[t.key]
    if (value === undefined) continue
    if (!Array.isArray(value)) return `${t.key} 不是数组`
    const problem = t.check(value)
    if (problem) return problem
    const keys = new Set<unknown>()
    for (const row of value as Obj[]) {
      const key = row.sourceRow ?? row.id
      if (key === undefined && t.key === 'auditLogs') continue
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
  const references = checkReferences(data)
  if (references) return references
  if (Array.isArray(data.records)) {
    const totals = validateFinancialTotals(data.records as RawRecord[], Array.isArray(data.rebuyExecutions) ? data.rebuyExecutions : [])
    if (totals) return totals
  }
  if ([...TABLES.map(table => table.key), 'batches', 'auditLogs'].every(key => Array.isArray(data[key as keyof BackupShape]))) {
    try { validateSnapshotRelations(data as unknown as LedgerSnapshot) }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  return null
}

/** 旧格式只补明确缺省值；当前格式缺字段不得借迁移掩盖。整个过程无写库副作用。 */
export function prepareBackup(value: unknown): LedgerSnapshot {
  if (!isObj(value)) throw new Error('备份必须是对象')
  const version = value.schemaVersion ?? 1
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error('备份结构版本不合法')
  if ((version as number) > 14) throw new Error('备份版本高于当前程序，拒绝导入（P11）')
  if (!Array.isArray(value.records)) throw new Error('这不是完整备份：缺少交易记录表，拒绝混合恢复')
  let data: Obj = value
  if ((version as number) < 14) {
    data = { ...value, schemaVersion: 14,
      exportedAt: value.exportedAt === undefined ? '1970-01-01T00:00:00.000Z' : value.exportedAt,
      settings: value.settings === undefined ? { deriveSellPrice: false } : value.settings,
      stocks: value.stocks === undefined ? DEFAULT_STOCKS.map(stock => ({ ...stock })) : Array.isArray(value.stocks)
        ? value.stocks.map(stock => isObj(stock) ? { ...stock, priceLimitType: stock.priceLimitType === undefined ? 'unknown' : stock.priceLimitType } : stock) : value.stocks,
      records: value.records.map(record => {
        if (!isObj(record)) return record
        const migrated = { ...record }
        for (const key of NULLABLE_RECORD_FIELDS) if (migrated[key] === undefined) migrated[key] = null
        for (const key of ['qtyNeedsDerive', 'targetNeedsDerive']) if (migrated[key] === undefined) migrated[key] = false
        return migrated
      }),
    }
    for (const key of [...TABLES.map(table => table.key), 'batches', 'auditLogs', 'bookingReceipts']) if (data[key] === undefined) data[key] = []
    for (const key of ['plans', 'extraTargets', 'buyTargets', 'hedges', 'merges', 'chainLinks']) if (Array.isArray(data[key])) {
      data[key] = data[key].map(item => isObj(item) ? { ...item, at: item.at === undefined ? 0 : item.at, ...(key === 'chainLinks' && item.closedAt === undefined ? { closedAt: null } : {}) } : item)
    }
  }
  const problem = validateBackup(data)
  if (problem) throw new Error(`备份内容校验失败：${problem}`)
  return data as unknown as LedgerSnapshot
}

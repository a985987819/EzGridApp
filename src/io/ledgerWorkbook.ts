import type { WorkBook } from 'xlsx'
import { validateBackup } from '../domain/backup'
import { snapshotViews, type LedgerSnapshot, type SnapshotCell, type SnapshotRow } from '../domain/ledgerSnapshot'
import { loadXlsx } from './parseWorkbook'

const FORMAT = 'EzGridApp 完整台账'
const VERSION = 1
const VIEW_LABELS: Record<string, string> = {
  id: '固定ID', key: '分支或挂单ID', stockName: '股票', stockId: '股票ID', sourceRow: '记录ID',
  anchorRow: '锚点记录ID', anchorQty: '锚点股数', anchorCostCents: '高位成本（分）', closedAtCents: '初始卖出价（分）',
  lossCents: '原始亏损（分）', profitCents: '已实现净盈利（分）', netCents: '实际累计盈亏（分）', gapCents: '还差回本（分）',
  done: '已回本', covered: '回本比例', holdingQty: '当前持股', plannedQty: '计划待回补股数', savingCents: '回补节省展示额（分）',
  unallocatedLossCents: '未分摊亏损（分）', unlinkedQty: '未找到高位成本股数', closedByUserAt: '人工结束时间戳',
  rootSellRow: '根卖出记录ID', row: '成员记录ID', kind: '分支或来源类型', cycles: '已完成卖出次数',
  buyDate: '买入日期', soldAt: '卖出日期', buyPriceCents: '买入价（分）', priceCents: '价格（分）',
  rebuyPriceCents: '回补价（分）', qty: '股数', remainingQty: '剩余股数', amountCents: '金额（分）',
  baseQty: '基础回补股数', rewardQty: '奖励股数', execQty: '已成交股数', doneRewardQty: '已成交奖励股数',
  sellFirst: '先卖后买', status: '订单状态', exposure: '空头敞口', lotId: '批次ID', orderId: '订单ID',
  groupKey: '奖励价组', targetQty: '待卖股数', rebuyRemainingQty: '待回补股数',
}
const viewHeader = (key: string) => VIEW_LABELS[key] ? `${VIEW_LABELS[key]} [${key}]` : key
export const LEDGER_META_SHEET = '台账说明'
type Row = Record<string, unknown>
// 类型：s 非空文本 / t 可空文本 / i 安全整数 / n 有限数 / b 布尔；? 可缺省，~ 可 null。
type Column = { key: string; label: string; type: string; values?: string[] }
const cols = (spec: string): Column[] => spec.split(';').map((s) => {
  const [key, label, type, enums] = s.split('|')
  return { key, label, type, values: enums?.split(',') }
})
const TABLES = [
  { key: 'records', name: '交易数据', columns: cols('sourceRow|记录ID|i;excelRow|原Excel行号|i?;soldLotId|卖出来源批次ID|s?;nextRoundOfRow|下一轮来源记录ID|i?;stockName|股票|s;buyDateSerial|买入日期序列值|n~;buyPriceCents|买入价（分）|i~;buyQtyRaw|买入股数|i~;qtyNeedsDerive|推定买入股数|b;targetPriceCents|目标或成交售价（分）|i~;targetNeedsDerive|推定售价|b;soldQty|卖出股数|i~;sellDateSerial|卖出日期序列值|n~;earlyBuyPriceCents|回补价（分）|i~;rebuyPriceSource|回补价来源|s?|custom,lot,p,sellMinusInterval,repaid;rawProfitCents|原表盈利（分）|i~;importKey|原始身份键|s;origin|录入来源|s?|excel,manual;deletedAt|软删除时间戳|i?~;editedAt|编辑时间戳|i?~;buyDateNeedsToday|原买入日期为TODAY|b?;sellDateNeedsToday|原卖出日期为TODAY|b?;batchId|导入批次ID|s?~') },
  { key: 'stocks', name: '股票设置', columns: cols('id|股票ID|s;name|股票|s;code|代码|t?;intervalCents|默认间隔（分）|i;priceLimitType|涨跌幅类型|s|main_10,gem_20,star_20,bse_30,st_5,custom,unknown;customLimitPct|自定义百分比|n?~;note|备注|t?;order|排序|i?;enabled|启用|b?') },
  { key: 'rebuyExecutions', name: '回补成交', columns: cols('id|成交ID|s;orderId|订单ID|s;sellExecId|卖出成交ID|s;stockId|股票ID|s;stockName|股票|s;qty|成交股数|i;priceCents|成交价（分）|i;rewardQty|奖励股数|i;groupKeyAtExecution|原奖励价组|t;at|成交时间戳|i;note|备注|t?') },
  { key: 'hedges', name: '人工高位关联', columns: cols('id|关联ID|s;sellRow|卖出记录ID|i;at|设置时间戳|i') },
  { key: 'hedgeItems', name: '人工高位分配', columns: cols('parentId|关联ID|s;row|买入记录ID|i;qty|分配股数|i') },
  { key: 'chainLinks', name: '人工回本链', columns: cols('id|关联ID|s;anchorRow|锚点记录ID|i;stockName|股票|s;closedAt|结束时间戳|i~;at|设置时间戳|i') },
  { key: 'chainMembers', name: '人工链成员', columns: cols('parentId|关联ID|s;row|成员记录ID|i') },
  { key: 'merges', name: '批次合并', columns: cols('id|合并ID|s;stockName|股票|s;priceCents|成本价（分）|i;at|设置时间戳|i') },
  { key: 'mergeMembers', name: '合并成员', columns: cols('parentId|合并ID|s;row|成员记录ID|i') },
  { key: 'plans', name: '挂单计划', columns: cols('id|计划ID|s;kind|买卖方向|s|buy,sell;refId|挂单身份|s;priceCents|计划价（分）|i;qty|计划股数|i;at|设置时间戳|i') },
  { key: 'extraTargets', name: '买单拆卖', columns: cols('id|分档ID|s;lotId|批次ID|s;priceCents|售价（分）|i;qty|股数|i;at|设置时间戳|i') },
  { key: 'buyTargets', name: '卖单拆买', columns: cols('id|分档ID|s;sellRow|卖出记录ID|i;priceCents|买价（分）|i;qty|股数|i;at|设置时间戳|i') },
  { key: 'batches', name: '导入批次', columns: cols('id|批次ID|s;fileName|原文件名|s;sheetName|原工作表|s;importedAt|导入时间戳|i;recordCount|记录数|i;addedCount|新增数|i;updatedCount|更新数|i?') },
  { key: 'auditLogs', name: '操作历史', columns: cols('id|审计ID|i?;entity|实体类型|s|record,stock,order,merge,chain;entityId|实体ID|s;field|字段|t;oldValue|旧值|t;newValue|新值|t;at|时间戳|i;source|来源|t') },
] as const
const ORDER = '原始顺序（勿改）'
const NULL = '〈null〉'
const EMPTY = '〈空字符串〉'
const TEXT = '〈文字〉'
const encode = (v: unknown, c: Column): SnapshotCell => v === undefined ? null
  : v === null ? (c.type.includes('?') ? NULL : null) : v === '' ? EMPTY
    : typeof v === 'string' && v.startsWith('〈') ? TEXT + v : v as SnapshotCell

export interface LedgerWorkbookPreview {
  snapshot: LedgerSnapshot
  differences: { sheet: string; before: number; after: number; examples: string[] }[]
  views: ReturnType<typeof snapshotViews>
}

export function isLedgerWorkbook(wb: WorkBook): boolean {
  // 缺说明表的残包也不能降级成普通导入，静默丢失关联。
  return wb.SheetNames.some((n) => n === LEDGER_META_SHEET || n === '交易数据' || n.startsWith('核对_'))
}

function sourceTables(s: LedgerSnapshot): Record<string, Row[]> {
  const raw = Object.fromEntries(TABLES.filter((t) => t.key in s).map((t) => [t.key, s[t.key as keyof LedgerSnapshot]]))
  return { ...raw,
    hedges: s.hedges.map((h) => ({ id: h.id, sellRow: h.sellRow, at: h.at })),
    hedgeItems: s.hedges.flatMap((h) => h.items.map((it) => ({ parentId: h.id, ...it }))),
    chainLinks: s.chainLinks.map((c) => ({ id: c.id, anchorRow: c.anchorRow, stockName: c.stockName, closedAt: c.closedAt, at: c.at })),
    chainMembers: s.chainLinks.flatMap((c) => c.memberRows.map((row) => ({ parentId: c.id, row }))),
    merges: s.merges.map((m) => ({ id: m.id, stockName: m.stockName, priceCents: m.priceCents, at: m.at })),
    mergeMembers: s.merges.flatMap((m) => m.rows.map((row) => ({ parentId: m.id, row }))),
  }
}

export async function exportLedgerWorkbook(snapshot: LedgerSnapshot): Promise<Uint8Array> {
  const X = await loadXlsx()
  const wb = X.utils.book_new()
  const append = (name: string, rows: SnapshotCell[][]) => {
    const ws = X.utils.aoa_to_sheet(rows)
    ws['!cols'] = (rows[0] ?? []).map((h) => ({ wch: Math.min(40, Math.max(16, String(h).length * 1.5)) }))
    if (rows.length > 1) ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) }
    X.utils.book_append_sheet(wb, ws, name)
  }
  append(LEDGER_META_SHEET, [
    ['项目', '值'], ['格式', FORMAT], ['格式版本', VERSION], ['计算口径版本', 1],
    ['导出时间', snapshot.exportedAt], ['推定已成交售价', snapshot.settings.deriveSellPrice],
    ['恢复方式', '整库替换，不增量合并；恢复前自动下载当前 JSON 快照。'],
    ['编辑范围', '交易数据、股票设置、人工关联、成交和挂单计划可编辑；核对_ 开头的表仅为快照，恢复时重新计算。'],
    ['固定身份', '记录ID、关联ID、批次ID、原始身份键、原始顺序请勿修改。排序工作表不会改变关联或记账顺序。'],
    ['金额和日期', '金额全部为整数分；日期为 Excel 1900 序列值；时间戳为 Unix 毫秒。'],
    ['留空', '必填列不得空；可缺省列留空表示未设置；〈null〉保留显式空值，〈空字符串〉保留空文本。布尔只接受 TRUE/FALSE。'],
    ['自动关联', '核对_高位关联与核对_链成员仅供查看。自动结果不会写成人工关联；人工高位关联保留空父行表示禁止自动分配。'],
    ['删除', '交易软删除用软删除时间戳；物理删行必须同时清除引用。人工关联清空需同时删对应父行与成员行。'],
    ['回本金额', '核对_回本链：lossCents 原始亏损、profitCents 后续净盈利、netCents 实际盈亏、gapCents 还差多少，单位分。'],
    ['核对说明', '核对表不在 Excel 内计算。编辑数据后，导入预览会显示与原快照的差异，请核对后恢复。'],
  ])
  const tables = sourceTables(snapshot)
  for (const t of TABLES) append(t.name, [[ORDER, ...t.columns.map((c) => c.label)],
    ...tables[t.key].map((r, i) => [i + 1, ...t.columns.map((c) => encode(r[c.key], c))])])
  for (const [name, rows] of Object.entries(snapshotViews(snapshot))) {
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort()
    // 空表也有明确列头，保证删表/漏表不被当作空数据。
    append(name, [headers.length ? headers.map(viewHeader) : ['（无数据）'], ...rows.map((r) => headers.map((h) => r[h] ?? null))])
  }
  return new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx', compression: true }))
}

/** 完整格式严禁公式：缓存值可能过期，不能用它悄悄覆盖真实台账。 */
async function readRows(wb: WorkBook, name: string): Promise<unknown[][]> {
  const X = await loadXlsx()
  const ws = wb.Sheets[name]
  if (!ws?.['!ref']) throw new Error(`工作表「${name}」缺失或为空`)
  for (const [address, cell] of Object.entries(ws)) {
    if (!address.startsWith('!') && (cell as { f?: string }).f) throw new Error(`工作表「${name}」${address}：完整台账不接受公式，请填实际值`)
    if (!address.startsWith('!') && (cell as { t?: string }).t === 'e') throw new Error(`工作表「${name}」${address}：单元格错误`)
  }
  return X.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true, blankrows: false })
}

function decode(v: unknown, c: Column, location: string): unknown {
  const fail = () => { throw new Error(`${location}「${c.label}」：值不合法（${String(v)}）`) }
  if (v === null || v === undefined || v === '') {
    if (c.type.includes('?')) return undefined
    if (c.type.includes('~')) return null
    if (c.type.startsWith('t')) return ''
    return fail()
  }
  if (v === NULL && c.type.includes('~')) return null
  if (/[st]/.test(c.type[0])) {
    const value = typeof v === 'string' && v.startsWith(TEXT) ? v.slice(TEXT.length) : v === EMPTY ? '' : v
    if (typeof value !== 'string' || (c.type[0] === 's' && !value.trim()) || (c.values && !c.values.includes(value))) return fail()
    return value
  }
  if (c.type[0] === 'b') {
    if (v === true || v === 'TRUE') return true
    if (v === false || v === 'FALSE') return false
    return fail()
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || (c.type[0] === 'i' && !Number.isSafeInteger(v))) return fail()
  return v
}

function signature(rows: SnapshotRow[]): string {
  return JSON.stringify(rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort())
}

export async function parseLedgerWorkbook(buffer: ArrayBuffer | Uint8Array): Promise<LedgerWorkbookPreview | null> {
  const X = await loadXlsx()
  const wb = X.read(buffer, { type: 'array', cellFormula: true, cellDates: false })
  if (!isLedgerWorkbook(wb)) return null
  const metaRows = await readRows(wb, LEDGER_META_SHEET)
  const meta = new Map(metaRows.slice(1).map((r) => [r[0], r[1]]))
  for (const key of ['格式', '格式版本', '计算口径版本', '导出时间', '推定已成交售价']) {
    if (metaRows.filter((r) => r[0] === key).length !== 1) throw new Error(`台账说明：${key} 缺失或重复`)
  }
  if (meta.get('格式') !== FORMAT || meta.get('格式版本') !== VERSION || meta.get('计算口径版本') !== 1) throw new Error('台账说明：不支持的完整台账格式或计算口径版本')
  if (typeof meta.get('推定已成交售价') !== 'boolean') throw new Error('台账说明：推定已成交售价必须为布尔值')
  if (typeof meta.get('导出时间') !== 'string' || !Number.isFinite(Date.parse(meta.get('导出时间') as string))) throw new Error('台账说明：导出时间不合法')
  const tables: Record<string, Row[]> = {}
  for (const t of TABLES) {
    const [headers, ...rows] = await readRows(wb, t.name)
    const columns = [{ key: '__order', label: ORDER, type: 'i' }, ...t.columns]
    const indices = columns.map((c) => {
      const index = headers.indexOf(c.label)
      if (index < 0 || headers.lastIndexOf(c.label) !== index) throw new Error(`工作表「${t.name}」：列「${c.label}」缺失或重复`)
      return index
    })
    const seen = new Set<unknown>()
    const ordered = new Set<unknown>()
    tables[t.key] = rows.map((r, i) => {
      const location = `工作表「${t.name}」第 ${i + 2} 行（ID ${String(r[indices[1]] ?? '?')}）`
      const out: Row = {}
      columns.forEach((c, j) => {
        const value = decode(r[indices[j]], c, location)
        if (value !== undefined) out[c.key] = value
      })
      if ((out.__order as number) <= 0 || ordered.has(out.__order)) throw new Error(`${location}：原始顺序重复或小于 1`)
      ordered.add(out.__order)
      const id = out.id ?? out.sourceRow
      if (id !== undefined) {
        if (seen.has(id)) throw new Error(`${location}：ID ${String(id)} 重复`)
        seen.add(id)
      }
      return out
    }).sort((a, b) => (a.__order as number) - (b.__order as number)).map((r) => { delete r.__order; return r })
  }
  const attach = (parents: string, children: string, property: string, objects: boolean) => {
    const p = new Map(tables[parents].map((r) => [r.id, r]))
    for (const r of p.values()) r[property] = []
    const seen = new Set<string>()
    for (const child of tables[children]) {
      const parent = p.get(child.parentId)
      const name = TABLES.find((t) => t.key === children)!.name
      if (!parent) throw new Error(`工作表「${name}」：关联ID ${String(child.parentId)} 不存在`)
      const key = `${String(child.parentId)}:${String(child.row)}`
      if (seen.has(key)) throw new Error(`工作表「${name}」：成员 ${key} 重复`)
      seen.add(key)
      ;(parent[property] as unknown[]).push(objects ? { row: child.row, qty: child.qty } : child.row)
    }
    delete tables[children]
  }
  attach('hedges', 'hedgeItems', 'items', true)
  attach('chainLinks', 'chainMembers', 'memberRows', false)
  attach('merges', 'mergeMembers', 'rows', false)
  const snapshot = { ...tables, schemaVersion: 11, exportedAt: meta.get('导出时间'), settings: { deriveSellPrice: meta.get('推定已成交售价') } } as unknown as LedgerSnapshot
  const problem = validateBackup(snapshot)
  if (problem) {
    const match = /^(\w+)\[(\d+)\]/.exec(problem)
    const table = TABLES.find((t) => t.key === match?.[1])
    const record = match ? tables[match[1]]?.[Number(match[2])] : undefined
    throw new Error(`${table ? `工作表「${table.name}」记录 ${String(record?.id ?? record?.sourceRow ?? '?')}：` : ''}${problem}`)
  }
  validateRelations(snapshot)
  const views = snapshotViews(snapshot)
  const differences: LedgerWorkbookPreview['differences'] = []
  for (const [name, current] of Object.entries(views)) {
    const [rawHeaders, ...rows] = await readRows(wb, name)
    const headers = rawHeaders.map((h) => {
      const key = typeof h === 'string' ? /\[([^\]]+)\]$/.exec(h)?.[1] : undefined
      return key && viewHeader(key) === h ? key : h
    })
    if (new Set(headers).size !== headers.length) throw new Error(`工作表「${name}」：核对列重复`)
    const before = rows.map((r) => Object.fromEntries(headers.flatMap((h, i) => r[i] === null || r[i] === undefined ? [] : [[String(h), r[i]]])) as SnapshotRow)
    const normalized = current.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)))
    if (signature(before) !== signature(normalized)) {
      const identity = (r: SnapshotRow) => String(r.id ?? r.key ?? r.记录ID ?? r.groupKey ?? JSON.stringify(r))
      const previous = new Map(before.map((r) => [identity(r), r]))
      const next = new Map(normalized.map((r) => [identity(r), r]))
      const examples: string[] = []
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        const a = previous.get(id), b = next.get(id)
        if (!a || !b) examples.push(`${id}：${a ? '移除' : '新增'}`)
        else for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (a[key] !== b[key]) examples.push(`${id} · ${key}：${String(a[key] ?? '空')} → ${String(b[key] ?? '空')}`)
        }
        if (examples.length >= 12) break
      }
      differences.push({ sheet: name, before: before.length, after: current.length, examples: examples.slice(0, 12) })
    }
  }
  return { snapshot, views, differences }
}

function validateRelations(s: LedgerSnapshot): void {
  const rows = new Map(s.records.map((r) => [r.sourceRow, r]))
  const execs = new Set(s.rebuyExecutions.map((e) => e.id))
  const batches = new Set(s.batches.map((b) => b.id))
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
    const stock = s.stocks.find((st) => st.name === e.stockName)
    if (stock && stock.id !== e.stockId) throw new Error(`回补成交 ${e.id}：股票ID 与股票设置不一致`)
    positive(e.qty, `回补成交 ${e.id} 股数`)
    positive(e.priceCents, `回补成交 ${e.id} 价格`)
    positive(e.rewardQty, `回补成交 ${e.id} 奖励股数`, true)
    if (e.rewardQty > e.qty) throw new Error(`回补成交 ${e.id}：奖励股数大于成交股数`)
    if (e.rewardQty % 100 !== 0) throw new Error(`回补成交 ${e.id}：奖励股数必须为整手`)
  }
  for (const [label, list] of [['挂单计划', s.plans], ['买单拆卖', s.extraTargets], ['卖单拆买', s.buyTargets]] as const) {
    for (const t of list) { positive(t.qty, `${label} ${t.id} 股数`); positive(t.priceCents, `${label} ${t.id} 价格`) }
  }
}

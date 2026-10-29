/**
 * 哈希路由（S7：URL query 承载筛选）。
 *
 * 没有 react-router，5 个 tab 用 location.hash 就够了：
 *   #/overview   #/trades?stock=柳工&status=pending,sellDateMissing&from=…&row=63
 *
 - 跨页跳转 = navigate()，写 hash 并进历史记录（浏览器返回键可用）；
 - 明细页自己改筛选 = replaceRoute()，只替换当前历史条目，不产生一堆回退步。
 */

export type Tab = 'overview' | 'trades' | 'orders' | 'stats' | 'manage'

const TABS: readonly Tab[] = ['overview', 'trades', 'orders', 'stats', 'manage']

/** 明细页 URL 上能携带的筛选条件（与 TradesPage 的 state 一一对应） */
export interface TradesQuery {
  stock?: string
  /** 状态多选，取交集；序列化时逗号分隔 */
  status?: string[]
  /** 价格档（整数分） */
  price?: number
  /** 价格区间（整数分，含两端）：价格树聚合枝点击跳转用；单档跳转仍用 price */
  priceLo?: number
  priceHi?: number
  /** 日期区间（卖出日期优先，其次买入日期） */
  from?: string
  to?: string
  /** 目标行的 nanoId（行级唯一短 id，见 ui/nanoid.ts；筛选与跳转都以它为准） */
  id?: string
  sort?: string
  /** 显示已删除行 */
  del?: boolean
  /** 放开「隐藏已完成」：默认隐藏已完成行，勾上 = 已完成的也显示 */
  showDone?: boolean
}

export interface Route {
  tab: Tab
  query: TradesQuery
  manage?: ManageQuery
}

export type ManageSection = 'stocks' | 'import' | 'checks' | 'backup' | 'guide'
export type GuideMode = 'questions' | 'scenarios' | 'documents' | 'issues'
export interface ManageQuery {
  section?: ManageSection
  doc?: string
  topic?: string
  scenario?: string
  anchor?: string
  q?: string
  mode?: GuideMode
  category?: string
}
const MANAGE_SECTIONS: readonly string[] = ['stocks', 'import', 'checks', 'backup', 'guide']
const GUIDE_MODES: readonly string[] = ['questions', 'scenarios', 'documents', 'issues']

export function parseManageQuery(search: string): ManageQuery {
  const p = new URLSearchParams(search)
  const section = p.get('section') ?? ''
  if (!MANAGE_SECTIONS.includes(section)) return {}
  const query: ManageQuery = { section: section as ManageSection }
  if (section !== 'guide') return query
  for (const key of ['doc', 'topic', 'scenario', 'anchor', 'q', 'category'] as const) {
    const value = p.get(key)?.trim().slice(0, key === 'q' ? 160 : 120)
    if (value) query[key] = value
  }
  const mode = p.get('mode') ?? ''
  if (GUIDE_MODES.includes(mode)) query.mode = mode as GuideMode
  return query
}

export function buildManageHash(query: ManageQuery = {}): string {
  const p = new URLSearchParams()
  if (query.section && MANAGE_SECTIONS.includes(query.section)) p.set('section', query.section)
  if (query.section === 'guide') {
    for (const key of ['doc', 'topic', 'scenario', 'anchor', 'q', 'mode', 'category'] as const) {
      if (query[key]) p.set(key, query[key]!)
    }
  }
  const search = p.toString()
  return `#/manage${search ? `?${search}` : ''}`
}

export function navigateManage(query: ManageQuery = {}): void {
  const next = buildManageHash(query)
  if (window.location.hash !== next) window.location.hash = next
}

/** 指南搜索只替换当前历史，不让每次输入都成为一次浏览器返回。 */
export function replaceManageRoute(query: ManageQuery): void {
  history.replaceState(null, '', buildManageHash(query))
}

export function serializeTradesQuery(q: TradesQuery): string {
  const p = new URLSearchParams()
  if (q.stock) p.set('stock', q.stock)
  if (q.status && q.status.length > 0) p.set('status', q.status.join(','))
  if (typeof q.price === 'number') p.set('price', String(q.price))
  if (typeof q.priceLo === 'number') p.set('priceLo', String(q.priceLo))
  if (typeof q.priceHi === 'number') p.set('priceHi', String(q.priceHi))
  if (q.from) p.set('from', q.from)
  if (q.to) p.set('to', q.to)
  if (q.id) p.set('id', q.id)
  if (q.sort) p.set('sort', q.sort)
  if (q.del) p.set('del', '1')
  if (q.showDone) p.set('showDone', '1')
  return p.toString()
}

export function parseTradesQuery(search: string): TradesQuery {
  const p = new URLSearchParams(search)
  const q: TradesQuery = {}
  const stock = p.get('stock')
  if (stock) q.stock = stock
  const status = p.get('status')
  if (status) q.status = status.split(',').filter(Boolean)
  /**
   * V9.55 修：空串也会 `Number('') === 0` 且 `Number.isFinite(0)`，于是 `?price=` 被当成
   * 「价格为 0 分」的筛选，列表被筛空、还会自己把 `price=0` 写回 URL 卡住——先挡掉空值。
   */
  const num = (key: string): number | null => {
    const raw = p.get(key)
    if (raw === null || raw.trim() === '') return null
    const v = Number(raw)
    return Number.isFinite(v) ? v : null
  }
  const price = num('price')
  if (price !== null) q.price = price
  const priceLo = num('priceLo')
  if (priceLo !== null) q.priceLo = priceLo
  const priceHi = num('priceHi')
  if (priceHi !== null) q.priceHi = priceHi
  const from = p.get('from')
  if (from) q.from = from
  const to = p.get('to')
  if (to) q.to = to
  const id = p.get('id')
  if (id) q.id = id
  const sort = p.get('sort')
  if (sort) q.sort = sort
  if (p.get('del') === '1') q.del = true
  if (p.get('showDone') === '1') q.showDone = true
  return q
}

export function buildHash(tab: Tab, query?: TradesQuery): string {
  const s = tab === 'trades' ? serializeTradesQuery(query ?? {}) : ''
  return `#/${tab}${s ? `?${s}` : ''}`
}

export function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [tabRaw, search = ''] = raw.split('?')
  const tab = (TABS as readonly string[]).includes(tabRaw) ? (tabRaw as Tab) : 'overview'
  return { tab, query: tab === 'trades' ? parseTradesQuery(search) : {},
    ...(tab === 'manage' ? { manage: parseManageQuery(search) } : {}) }
}

/** 跨页跳转：写 hash，触发 hashchange（会进浏览器历史） */
export function navigate(tab: Tab, query?: TradesQuery): void {
  const next = buildHash(tab, query)
  if (window.location.hash === next) return
  window.location.hash = next
}

/** 明细页内部筛选同步：替换当前历史条目，不触发 hashchange */
export function replaceRoute(tab: Tab, query?: TradesQuery): void {
  const next = buildHash(tab, query)
  if (window.location.hash === next) return
  history.replaceState(null, '', next)
}

/** YYYY-MM → 该月起止日期（跨数据跳转：月度成交某月 → 明细日期区间） */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return { from: '', to: '' }
  const last = new Date(y, m, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

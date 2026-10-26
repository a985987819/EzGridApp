import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Card, Drawer, Input, Modal, Switch, Tag, notificationOpen } from 'animal-island-ui'
import { Select } from '../ui/Select'
import { useApp } from '../store/useApp'
import { serialToIso } from '../domain/defaults'
import { EDITABLE, fieldText, type EditableKey } from '../domain/edit'
import { activeStocks } from '../domain/stocks'
import { sellsByRecord } from '../domain/suggestions'
import { isHedgeable } from '../domain/hedge'
import type { ManualInput } from '../domain/manual'
import { inputOrDefault, manualFormDefaults, resolveManualForm } from '../domain/formDefaults'
import type { RawRecord, RepairChain } from '../domain/types'
import { isoDate, money, price, qty, signedMoney, todayIso, tone } from '../ui/format'
import { replaceRoute, type TradesQuery } from '../ui/nav'
import { buildNanoIdIndex } from '../ui/nanoid'
import { centsToYuan, toCents } from '../domain/money'
import { downloadBytes, downloadText, toCsv } from '../ui/csv'
import { exportRecordsWorkbook } from '../io/parseWorkbook'
import { useFlashOnAppear } from '../ui/motion'
import { useKeyboardInset } from '../ui/viewport'
import { useScrollHold } from '../ui/scrollHold'
import { enterSubmit } from '../ui/enterSave'
import { DateField } from '../ui/DateField'
import { TradeItem, buyDateOf, isDone, sellDateOf, type TradeRow } from '../components/TradeItem'
import { HedgeBinder, HedgeSheet } from '../components/HedgeBinder'
import { LotMergeBinder } from '../components/LotMergeBinder'
import { RepairChainCard } from '../components/RepairChainCard'
import { ChainBinder } from '../components/ChainBinder'

/** 状态筛选可多选（V9 可叠加）：命中的行要满足每一个勾选的状态 */
const STATUS_KEYS = ['holding', 'soldout', 'pending', 'exposure', 'buyDateMissing', 'sellDateMissing', 'needsPrice'] as const
type StatusKey = (typeof STATUS_KEYS)[number]

const STATUS_LABEL: Record<StatusKey, string> = {
  holding: '有剩余',
  soldout: '已卖完',
  pending: '待回补',
  exposure: '空头敞口',
  buyDateMissing: '缺买入日期',
  sellDateMissing: '缺卖出日期',
  needsPrice: '缺价格',
}

function isStatusKey(v: string): v is StatusKey {
  return (STATUS_KEYS as readonly string[]).includes(v)
}

type SortBy =
  | 'rowDesc'
  | 'rowAsc'
  | 'buyDateDesc'
  | 'buyDateAsc'
  | 'sellDateDesc'
  | 'sellDateAsc'
  | 'profitDesc'
  | 'profitAsc'

/** 行集合 = record + 派生 lot / sell（V9.25 起行卡片本体在 components/TradeItem） */
type Row = TradeRow

const SORT_KEYS: readonly string[] = ['rowDesc', 'rowAsc', 'buyDateDesc', 'buyDateAsc', 'sellDateDesc', 'sellDateAsc', 'profitDesc', 'profitAsc']

/**
 * 排序平铺（V9.4）：4 个维度像表头一样直接可见。
 * 点击循环：默认（录入顺序 新→旧）→ 该维度主方向 → 反序 → 回默认。
 */
const SORT_CHIPS: { key: string; label: string; desc: SortBy; asc: SortBy }[] = [
  { key: 'row', label: '录入顺序', desc: 'rowDesc', asc: 'rowAsc' },
  { key: 'buyDate', label: '买入日期', desc: 'buyDateDesc', asc: 'buyDateAsc' },
  { key: 'sellDate', label: '卖出日期', desc: 'sellDateDesc', asc: 'sellDateAsc' },
  { key: 'profit', label: '盈利', desc: 'profitDesc', asc: 'profitAsc' },
]

/** 日期区间筛选用：卖出日期优先，其次买入日期 */
function tradeDate(r: Row): string | null {
  return sellDateOf(r) ?? buyDateOf(r)
}

/** 升序比较：空值永远排最后 */
function cmpDate(a: string | null, b: string | null, dir: 1 | -1): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -dir : dir
}

/** 单个状态的判定；多选时取交集 */
function statusMatch(r: Row, key: StatusKey): boolean {
  switch (key) {
    case 'holding':
      return (r.lot?.remainingQty ?? 0) > 0
    case 'soldout':
      return r.sell !== null && (r.lot?.remainingQty ?? 0) === 0
    case 'pending':
      return r.sell?.rebuyStatus === 'pending'
    // 空头敞口：待回补且无买入批次（与概览「卖满后 X 股敞口」同口径，ledger 的 order.exposure）
    case 'exposure':
      return r.sell?.rebuyStatus === 'pending' && r.rec.buyPriceCents === null
    case 'buyDateMissing':
      return buyDateOf(r) === null
    case 'sellDateMissing':
      return r.sell !== null && sellDateOf(r) === null
    case 'needsPrice':
      return (r.sell !== null && r.sell.priceCents === null) || r.lot?.needsPrice === true
  }
}

/** 已完成行的判定与隐藏口径在 components/TradeItem（明细行与价格树 hover 共用） */

/** 日期区间的 chip 文案：恰好整月就写成「月份 2026-02」（统计页月度/日历跳转都是整月或单日） */
function dateChipLabel(from: string, to: string): string {
  const m = from.match(/^(\d{4}-\d{2})-01$/)
  if (m && to.startsWith(`${m[1]}-`)) {
    const lastDay = new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0).getDate()
    if (Number(to.slice(8, 10)) === lastDay) return `月份 ${m[1]}`
  }
  return `日期 ${from || '…'} → ${to || '…'}`
}

const BLANK_DRAFT = Object.fromEntries(EDITABLE.map((f) => [f.key, ''])) as Record<EditableKey, string>

const BLANK_FORM: ManualInput = {
  kind: 'buy',
  stockName: '',
  date: '',
  price: '',
  qty: '',
  targetPrice: '',
  rebuyPrice: '',
  repaid: false,
  buyPrice: '',
  buyQty: '',
  buyDate: '',
}

/** 新增一笔的空白表单（V9.35）：日期默认今天，股票默认当前筛选/第一只，少填两个格子 */
function blankForm(stockName: string): ManualInput {
  return { ...BLANK_FORM, stockName, date: todayIso() }
}

/** 先卖后买：没有买入批次的卖出行（这类行补买入侧时有一堆可复用的数据） */
function isNakedSell(rec: RawRecord): boolean {
  return !rec.soldLotId && rec.buyPriceCents === null && (rec.soldQty ?? 0) > 0
}

/**
 * V9.50 用户拍板：成交数量是既成事实——已落库的买入/卖出份额只读，只放开对手价
 * （买单改预期卖出价、卖单改预期买入价）。「补买入」的空买入侧仍可填，那是新增不是修改。
 */
function lockedField(key: EditableKey, row: TradeRow): boolean {
  if (key === 'buyQty') return row.lot !== null || row.rec.buyQtyRaw !== null
  if (key === 'soldQty') return (row.rec.soldQty ?? 0) > 0
  return false
}

export function TradesPage({ urlQuery }: { urlQuery: TradesQuery }) {
  const {
    ledger,
    records,
    executions,
    recordNo,
    stocks,
    editRecord,
    softDelete,
    restore,
    addManualRecord,
    historyOf,
    addExtraTarget,
    removeExtraTarget,
    extraTargets,
    addBuyTarget,
    removeBuyTarget,
    buyTargets,
    hedges,
    chainLinks,
    setChainMembers,
  } = useApp()
  const [stockFilter, setStockFilter] = useState(urlQuery.stock ?? 'all')
  const [statuses, setStatuses] = useState<StatusKey[]>(() => (urlQuery.status ?? []).filter(isStatusKey))
  const [priceFilter, setPriceFilter] = useState<number | null>(
    typeof urlQuery.price === 'number' ? urlQuery.price : null,
  )
  // 价格区间（V9.25）：价格树聚合枝点击跳转——lo..hi 含两端；单档仍走 price 精确匹配
  const [priceLo, setPriceLo] = useState<number | null>(
    typeof urlQuery.priceLo === 'number' ? urlQuery.priceLo : null,
  )
  const [priceHi, setPriceHi] = useState<number | null>(
    typeof urlQuery.priceHi === 'number' ? urlQuery.priceHi : null,
  )
  const [fromDate, setFromDate] = useState(urlQuery.from ?? '')
  const [toDate, setToDate] = useState(urlQuery.to ?? '')
  const [idFilter, setIdFilter] = useState<string | null>(urlQuery.id ?? null)
  const [sortBy, setSortBy] = useState<SortBy>(() =>
    SORT_KEYS.includes(urlQuery.sort ?? '') ? (urlQuery.sort as SortBy) : 'rowDesc',
  )
  const [showDeleted, setShowDeleted] = useState(urlQuery.del === true)
  // V9.5：默认隐藏「已完成」行（卖完且无待回补），URL 带 showDone=1 时放开
  const [hideDone, setHideDone] = useState(urlQuery.showDone !== true)
  // V9.42：往下滑把股票 tab / 状态筛选收起来，只留标题计数；回顶才展开。阈值留回差防抖
  const [filtersHidden, setFiltersHidden] = useState(false)
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setFiltersHidden((wasHidden) => (wasHidden ? y > 24 : y > 96))
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const [openRow, setOpenRow] = useState<number | null>(null)
  // V9.40/V9.55：弹层打开时库会把 body 锁成 overflow:hidden，文档高度塌回一屏、scrollY 被清零；
  // 打开前记下位置、全关掉后补回去——否则编辑完一笔要从头往下划才能找回这一行。
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<EditableKey, string>>(BLANK_DRAFT)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<ManualInput>(BLANK_FORM)
  /** V9.46：从回本链点的「＋ 新增一笔」——新行落库后自动归入这条链 */
  const [pendingChainAnchor, setPendingChainAnchor] = useState<number | null>(null)

  const [tpPrice, setTpPrice] = useState('')
  const [tpQty, setTpQty] = useState('')
  /** V9.50 卖单拆买的输入（先卖后买 → 多笔买入） */
  const [bpPrice, setBpPrice] = useState('')
  const [bpQty, setBpQty] = useState('')

  /**
   * V9.51 用户拍板：拆分默认量 = **还能拆的量**（剩余 − 已经拆出去的档），
   * 输入超过就直接夹到剩余量，绝不允许拆出超额。留空点确认即可完成一笔拆分。
   */
  const splitLeftOf = (lotId: string | null): number => {
    if (!lotId) return 0
    const lot = ledger.lots.find((l) => l.id === lotId)
    if (!lot) return 0
    const used = extraTargets.filter((t) => t.lotId === lotId).reduce((a, t) => a + t.qty, 0)
    return Math.max(0, lot.remainingQty - used)
  }
  const buySplitLeftOf = (sellRow: number): number => {
    // 上限与账务一致：用待买单的 baseQty（已扣本行买入与回本链同价回补覆盖的量）
    const o = ledger.orders.find((x) => x.sourceRow === sellRow)
    if (!o) return 0
    const used = buyTargets.filter((t) => t.sellRow === sellRow).reduce((a, t) => a + t.qty, 0)
    return Math.max(0, o.baseQty - used)
  }
  /** 还没回补的基础股（不含组池奖励，和拆分上限同一口径） */
  const rebuyLeftOf = (sellRow: number): number => {
    const o = ledger.orders.find((x) => x.sourceRow === sellRow)
    if (!o) return 0
    return Math.max(0, o.baseQty - o.execQty)
  }
  /** V9.62：该股的网格间隔（拆分价缺省推导用） */
  const intervalOf = (stock: string): number =>
    stockList.find((s) => s.name === stock)?.intervalCents ?? 0

  // 外部跳转 / 浏览器前进后退：hash 变了就把筛选整体换过去（跨数据跳转的落点）
  const urlKey = JSON.stringify(urlQuery)
  useEffect(() => {
    const q = JSON.parse(urlKey) as TradesQuery
    setStockFilter(q.stock ?? 'all')
    setStatuses((q.status ?? []).filter(isStatusKey))
    setPriceFilter(typeof q.price === 'number' ? q.price : null)
    setPriceLo(typeof q.priceLo === 'number' ? q.priceLo : null)
    setPriceHi(typeof q.priceHi === 'number' ? q.priceHi : null)
    setFromDate(q.from ?? '')
    setToDate(q.to ?? '')
    setIdFilter(typeof q.id === 'string' && q.id ? q.id : null)
    setSortBy(SORT_KEYS.includes(q.sort ?? '') ? (q.sort as SortBy) : 'rowDesc')
    setShowDeleted(q.del === true)
    setHideDone(q.showDone !== true)
  }, [urlKey])

  // 反向同步：筛选变化写回 hash（replaceState，不产生历史条目）
  useEffect(() => {
    replaceRoute('trades', {
      stock: stockFilter === 'all' ? undefined : stockFilter,
      status: statuses.length > 0 ? statuses : undefined,
      price: priceFilter ?? undefined,
      priceLo: priceLo ?? undefined,
      priceHi: priceHi ?? undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
      id: idFilter ?? undefined,
      sort: sortBy === 'rowDesc' ? undefined : sortBy,
      del: showDeleted || undefined,
      showDone: !hideDone || undefined,
    })
    }, [stockFilter, statuses, priceFilter, priceLo, priceHi, fromDate, toDate, idFilter, sortBy, showDeleted, hideDone])

  // nanoId 索引：展示 / 筛选 / 跳转的唯一行级 id（V9.4）
  const nano = useMemo(() => buildNanoIdIndex(records), [records])

  // 股票顺序 / 启停都来自「管理 · 股票」
  const stockList = useMemo(() => activeStocks(stocks), [stocks])
  const stockNames = useMemo(() => stockList.map((s) => s.name), [stockList])
  // V9.35 新增表单的「按间隔自动算出来」提示：成交价改了 placeholder 就跟着变，省得自己减
  const formInterval = stockList.find((s) => s.name === form.stockName)?.intervalCents ?? 0
  const formDefaults = manualFormDefaults(form, todayIso(), formInterval)
  const autoTarget = formDefaults.targetPrice
  const autoRebuy = formDefaults.rebuyPrice
  const enabledSet = useMemo(() => new Set(stockNames), [stockNames])
  const hiddenStockCount = useMemo(
    () => new Set(records.map((r) => r.stockName).filter((n) => !enabledSet.has(n))).size,
    [records, enabledSet],
  )

  const rows = useMemo<Row[]>(() => {
    const lotMap = new Map(ledger.lots.map((l) => [l.sourceRow, l]))
    const sellMap = sellsByRecord(ledger)
    return records.map((rec) => ({
      rec,
      lot: lotMap.get(rec.sourceRow) ?? null,
      sell: sellMap.get(rec.sourceRow) ?? null,
    }))
  }, [records, ledger])

  // 过滤 + 顺带统计「没有日期、被日期区间条件排除」的行数（空态时提示用）
  const { filtered, noDateHidden } = useMemo(() => {
    let hidden = 0
    /**
     * V9.46 回本链的锚点（亏着清仓的那笔）与归属成员：它们都还「欠着账」，
     * 不是真的完成——默认 hideDone 也留着，否则用户找不到那笔 10 元买入去哪了。
     * V9.49：价位槽里每一笔同价买入（根卖单 + 槽内真实批次）同样保留——点开能看到整条链的账。
     */
    const chainRows = new Set<number>()
    for (const c of ledger.repairChains) {
      chainRows.add(c.anchorRow)
      for (const row of c.relatedSellRows) chainRows.add(row)
      for (const b of c.branches) for (const row of b.memberRows) chainRows.add(row)
    }
    const list = rows.filter((r) => {
      // nanoId 深链要能命中已软删的行，showDeleted 的门对目标行放行
      const rId = nano.rowToId.get(r.rec.sourceRow)
      if (!showDeleted && r.rec.deletedAt && rId !== idFilter) return false
      if (stockFilter === 'all') {
        // 停用的股票不出现在明细里
        if (!enabledSet.has(r.rec.stockName)) return false
      } else if (r.rec.stockName !== stockFilter) return false
      if (priceFilter !== null) {
        const prices = [r.rec.targetPriceCents, r.rec.buyPriceCents, r.sell?.priceCents ?? null, r.rec.earlyBuyPriceCents]
        if (!prices.includes(priceFilter)) return false
      }
      // 价格区间（聚合枝跳转）：四个价格字段任一落进 [lo, hi] 即命中（与精确 price 同口径的 OR）
      if (priceLo !== null || priceHi !== null) {
        const prices = [r.rec.targetPriceCents, r.rec.buyPriceCents, r.sell?.priceCents ?? null, r.rec.earlyBuyPriceCents]
        const hit = prices.some(
          (p) => p !== null && (priceLo === null || p >= priceLo) && (priceHi === null || p <= priceHi),
        )
        if (!hit) return false
      }
      if (idFilter !== null && rId !== idFilter) return false
      /** 深链指到的那一行要一定看得见：软删（上面已放行）和「已完成」都不能把它藏掉 */
      const deepLink = idFilter !== null && rId === idFilter
      // 状态多选取交集：勾了几个状态，行必须全都满足
      if (statuses.length > 0 && !statuses.every((k) => statusMatch(r, k))) return false
      // V9.5：默认隐藏已完成；勾「已卖完」或深链带该状态时自动放开，避免空列表陷阱
      // V9.36：回本链锚点不算完成（还欠着一笔要补），继续显示
      if (hideDone && !deepLink && !statuses.includes('soldout') && isDone(r) && !chainRows.has(r.rec.sourceRow)) return false
      // 日期区间：卖出日期优先，其次买入日期；没日期的行在有区间条件时直接排除
      if (fromDate || toDate) {
        const d = tradeDate(r)
        if (d === null) {
          hidden += 1
          return false
        }
        if (fromDate && d < fromDate) return false
        if (toDate && d > toDate) return false
      }
      return true
    })
    return { filtered: list, noDateHidden: hidden }
  }, [rows, stockFilter, priceFilter, priceLo, priceHi, statuses, showDeleted, enabledSet, fromDate, toDate, idFilter, nano, hideDone, ledger.repairChains])

  /** 已生效的条件 chips：每颗都能单独点掉 */
  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = []
    if (stockFilter !== 'all')
      chips.push({ key: 'stock', label: `股票 ${stockFilter}`, clear: () => setStockFilter('all') })
    for (const k of statuses)
      chips.push({ key: `st-${k}`, label: STATUS_LABEL[k], clear: () => setStatuses((s) => s.filter((x) => x !== k)) })
    if (priceFilter !== null)
      chips.push({ key: 'price', label: `价格 ${(priceFilter / 100).toFixed(2)}`, clear: () => setPriceFilter(null) })
    if (priceLo !== null || priceHi !== null)
      chips.push({
        key: 'priceRange',
        label: `价格 ${(priceLo ?? 0) / 100}~${(priceHi ?? 0) / 100}`,
        clear: () => {
          setPriceLo(null)
          setPriceHi(null)
        },
      })
    if (fromDate || toDate)
      chips.push({
        key: 'date',
        label: dateChipLabel(fromDate, toDate),
        clear: () => {
          setFromDate('')
          setToDate('')
        },
      })
    if (idFilter !== null) {
      const rec = nano.byId.get(idFilter)
      const n = rec ? recordNo.of(rec.sourceRow) : null
      chips.push({
        key: 'id',
        label: n !== null ? `第 ${n} 笔` : `#${idFilter}`,
        clear: () => setIdFilter(null),
      })
    }
    return chips
  }, [stockFilter, statuses, priceFilter, priceLo, priceHi, fromDate, toDate, idFilter, nano, recordNo])

  /** 一键复位：股票 / 状态 / 日期 / 价格（含区间）/ nanoId 全清（排序与已删除开关不动），已完成恢复默认隐藏 */
  function resetFilters() {
    setStockFilter('all')
    setStatuses([])
    setPriceFilter(null)
    setPriceLo(null)
    setPriceHi(null)
    setFromDate('')
    setToDate('')
    setIdFilter(null)
    setHideDone(true)
  }

  /** 排序后的可见列表（S3：录入顺序 / 买入日期 / 卖出日期 / 盈利，各升降一档） */
  const visible = useMemo(() => {
    const arr = [...filtered]
    const profitOf = (r: Row) => r.sell?.profitCents ?? 0
    const noOf = (r: Row) => recordNo.of(r.rec.sourceRow) ?? 0
    switch (sortBy) {
      case 'rowAsc':
        return arr.sort((a, b) => noOf(a) - noOf(b))
      case 'buyDateDesc':
        return arr.sort((a, b) => cmpDate(buyDateOf(a), buyDateOf(b), -1))
      case 'buyDateAsc':
        return arr.sort((a, b) => cmpDate(buyDateOf(a), buyDateOf(b), 1))
      case 'sellDateDesc':
        return arr.sort((a, b) => cmpDate(sellDateOf(a), sellDateOf(b), -1))
      case 'sellDateAsc':
        return arr.sort((a, b) => cmpDate(sellDateOf(a), sellDateOf(b), 1))
      case 'profitDesc':
        return arr.sort((a, b) => profitOf(b) - profitOf(a))
      case 'profitAsc':
        return arr.sort((a, b) => profitOf(a) - profitOf(b))
      default:
        return arr.sort((a, b) => noOf(b) - noOf(a))
    }
  }, [filtered, sortBy, recordNo])

  const current = visible.find((r) => r.rec.sourceRow === openRow) ?? null
  const drawerOpen = current !== null

  /**
   * V9.62 拆分价缺省推导：**能推出来的价都当 placeholder + 留空默认值**，理想情况拆一档只需要点确认。
   * - 卖出目标：批次填了 E 列用 E 列；没填按 V9.49 口径「买入价 + 该股间隔」兜底。
   * - 买入拆分：优先卖单已派生的回补价（P 列 > 卖价−间隔）；连推导条件都不满足才要求手填。
   */
  const tpFallback =
    current?.lot == null
      ? null
      : (current.lot.targetPriceCents ??
        (current.lot.buyPriceCents > 0 && intervalOf(current.lot.stockName) > 0
          ? current.lot.buyPriceCents + intervalOf(current.lot.stockName)
          : null))
  const bpFallback = (() => {
    if (current?.sell == null) return null
    if (current.sell.rebuyPriceCents != null) return current.sell.rebuyPriceCents
    const step = intervalOf(current.rec.stockName)
    const p = current.sell.priceCents
    return p != null && step > 0 && p - step > 0 ? p - step : null
  })()

  // V9.40 输入法避让：抽屉打开期间把键盘高度写进 CSS 变量（面板挂 body 上，不会自己缩）
  useKeyboardInset(drawerOpen)

  // ---------- V9.37 动效状态：新增落位 / 删除滑出 / 刚完成洗色 ----------
  /** 刚新增的那一行：弹入 + 微光，1.8s 后自动摘掉（「弹窗收成一行」的观感由它承担） */
  const [flashRow, setFlashRow] = useState<number | null>(null)
  /** 正在滑出删除的行：留在列表里播完 300ms 动画再真删 */
  const [leaving, setLeaving] = useState<Set<number>>(() => new Set())
  /** 刚变成「已完成」的行：整行洗一层青，提示状态变了 */
  const justDone = useFlashOnAppear(
    useMemo(() => visible.filter(isDone).map((r) => r.rec.sourceRow), [visible]),
  )

  // ---------- V9.26 先卖后买挂钩（V9.30 起入口独立：行上「裸卖待挂钩」标签 → 弹层） ----------
  const hedgeOf = useMemo(() => new Map(hedges.map((h) => [h.sellRow, h])), [hedges])
  /** 有挂钩异常（失效 / 超挂 / 挂不满）的卖出行（V9.33）：行上标红，点开面板能看到原因 */
  const hedgeIssues = useMemo(
    () => new Set(ledger.anomalies.filter((a) => a.kind.startsWith('hedge')).map((a) => a.sourceRow)),
    [ledger.anomalies],
  )
  /** 还没回补过的裸卖单（可挂/可改挂）：按行本身判定，不看有没有待买订单（V9.32） */
  const hedgeableRows = useMemo(() => {
    const execByRow = new Map<number, number>()
    // V9.57：挂钩只作用在「基础股」上；奖励股是额外买入，不算已买回欠量
    for (const o of ledger.orders) execByRow.set(o.sourceRow, Math.max(0, o.execQty - o.doneRewardQty))
    const set = new Set<number>()
    for (const r of records) if (isHedgeable(r, execByRow.get(r.sourceRow) ?? 0)) set.add(r.sourceRow)
    return set
  }, [ledger.orders, records])
  /** 点标签打开的「裸卖待挂钩」弹层（null = 关着） */
  const [hedgeRow, setHedgeRow] = useState<number | null>(null)
  // V9.55：抽屉 / 新增弹窗 / 挂钩弹层统一保滚动位置（原来只护了抽屉）
  useScrollHold(drawerOpen || adding || hedgeRow !== null)

  /** V9.46 回本链：高位批次行号 → 那条链（用于行上标签 + 抽屉里的进度卡） */
  const repairByAnchor = useMemo(
    () => new Map(ledger.repairChains.map((c) => [c.anchorRow, c])),
    [ledger.repairChains],
  )
  /** 归属成员行 → 它归进去的那条链（V9.49：价位槽里每一笔同价买入都算，点开就能看整条链） */
  const repairByMember = useMemo(() => {
    const m = new Map<number, RepairChain>()
    for (const c of ledger.repairChains) {
      for (const b of c.branches) {
        for (const r of b.memberRows) m.set(r, c)
      }
    }
    return m
  }, [ledger.repairChains])
  /** V9.49 价位槽的行（同价再卖 / 同价买回）：行上单独标「回本链 · 同价回补」 */
  const branchRows = useMemo(() => {
    const s = new Set<number>()
    for (const c of ledger.repairChains) {
      for (const b of c.branches) if (b.kind === 'sell') for (const r of b.memberRows) s.add(r)
    }
    return s
  }, [ledger.repairChains])
  /** 回本链的另一个入口：这笔裸卖（先卖后买）自己身上也能看到它牵连的那条链 */
  const repairBySell = useMemo(() => {
    const m = new Map<number, RepairChain[]>()
    for (const c of ledger.repairChains) {
      for (const sellRow of c.relatedSellRows) {
        const arr = m.get(sellRow) ?? []
        if (!arr.some((x) => x.id === c.id)) arr.push(c)
        m.set(sellRow, arr)
      }
    }
    return m
  }, [ledger.repairChains])

  function open(r: Row) {
    const next = { ...BLANK_DRAFT }
    for (const f of EDITABLE) next[f.key] = fieldText(r.rec, f.key)
    setDraft(next)
    setEditing(false)
    setOpenRow(r.rec.sourceRow)
  }

  /**
   * 进入编辑（V9.35）：backfill=true 是「补买入」——先卖后买的行点它，买入价=回补价、
   * 份额=卖出量、日期=今天，一次填好。普通「编辑」不动这三格：
   * 只想改卖出侧的人不该因为保存而把买入写进台账（这是账，不能靠"记得清空"）。
   */
  function startEdit(backfill = false) {
    if (backfill && current) {
      const rec = current.rec
      const next = { ...draft }
      if (rec.earlyBuyPriceCents !== null) next.buyPrice = centsToYuan(rec.earlyBuyPriceCents)
      if ((rec.soldQty ?? 0) > 0) next.buyQty = String(rec.soldQty)
      if (!next.buyDate) next.buyDate = todayIso()
      setDraft(next)
    }
    setEditing(true)
  }

  async function save() {
    if (openRow === null) return
    try {
      const n = await editRecord(openRow, draft)
      setEditing(false)
      notificationOpen({
        message: n === 0 ? '没有改动' : '已保存',
        description: n === 0 ? undefined : `${n} 个字段进入变更历史`,
        type: n === 0 ? 'info' : 'success',
      })
    } catch (e) {
      notificationOpen({ message: '保存失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function onDelete(row: number) {
    const n = recordNo.of(row)
    if (!window.confirm(`把${n !== null ? `第 ${n} 笔` : `第 ${row} 行`}标记为删除？软删除，可恢复。`)) return
    setOpenRow(null)
    // V9.37：先让这一行滑出、高度收掉，再真删——否则列表会「啪」地跳一下
    setLeaving((s) => new Set(s).add(row))
    await new Promise((r) => window.setTimeout(r, 280))
    try {await softDelete(row)} catch(e){
      setLeaving((s)=>{const n=new Set(s);n.delete(row);return n})
      notificationOpen({message:'无法删除',description:e instanceof Error?e.message:String(e),type:'error'})
      return
    }
    setLeaving((s) => {
      const n = new Set(s)
      n.delete(row)
      return n
    })
    notificationOpen({
      message: `${recordNoLabelOf(row)}已删除`,
      description: '勾「显示已删除」可以恢复',
      type: 'info',
    })
  }

  async function onRestore(row: number) {
    try {
      await restore(row)
      notificationOpen({ message: `${recordNoLabelOf(row)}已恢复`, type: 'success' })
    }catch(e){notificationOpen({message:'无法恢复',description:e instanceof Error?e.message:String(e),type:'error'})}
  }

  function recordNoLabelOf(row: number): string {
    const n = recordNo.of(row)
    return n !== null ? `第 ${n} 笔` : `第 ${row} 行`
  }

  /** 链上「＋ 新增一笔归入本链」：按锚点股票打开新增表单，记住锚点等落库后自动归属 */
  function startAddIntoChain(anchorRow: number) {
    const rec = records.find((r) => r.sourceRow === anchorRow)
    setPendingChainAnchor(anchorRow)
    setForm(blankForm(rec?.stockName ?? (stockFilter === 'all' ? stockNames[0] ?? '' : stockFilter)))
    setOpenRow(null)
    setAdding(true)
  }

  async function onAdd() {
    try {
      const row = await addManualRecord(resolveManualForm(form, todayIso(), formInterval))
      setAdding(false)
      const anchor = pendingChainAnchor
      setPendingChainAnchor(null)
      setForm(blankForm(form.stockName))
      // V9.46：链上「＋ 新增一笔」→ 新行自动继承归属，不用回头再勾一次
      if (anchor !== null) {
        const link = chainLinks.find((l) => l.anchorRow === anchor)
        await setChainMembers(anchor, [...(link?.memberRows ?? []), row])
      }
      // V9.37：新行弹入 + 微光，承接「弹窗收成一条明细」的观感
      setFlashRow(row)
      window.setTimeout(() => setFlashRow((cur) => (cur === row ? null : cur)), 1800)
      if (anchor !== null) {
        notificationOpen({
          message: `已新增并归入 ${recordNoLabelOf(anchor)} 的回本链`,
          description: '它的已实现盈亏之后会自动累加到那条链',
          type: 'success',
        })
        return
      }
      notificationOpen({
        message: `已新增第 ${recordNo.total + 1} 笔`,
        description: form.kind === 'sell' && !form.buyPrice ? '先卖后买：之后可在明细里补买入信息' : undefined,
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '新增失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  function exportCsv() {
    const head = ['序号', 'Excel行号', '股票', '买入日期', '买入价', '买入份额', '已卖', '剩余', '目标售价', '回补价', '卖出日期', '成交价', '实现盈利', '标记']
    const body = visible.map((r) => [
      recordNo.of(r.rec.sourceRow) ?? '',
      r.rec.origin === 'excel' ? r.rec.excelRow ?? r.rec.sourceRow : '',
      r.rec.stockName,
      r.lot ? isoDate(r.lot.buyDate) : serialToIso(r.rec.buyDateSerial) ?? '',
      r.rec.buyPriceCents === null ? '' : (r.rec.buyPriceCents / 100).toFixed(2),
      r.lot?.qty ?? r.rec.buyQtyRaw ?? '',
      r.rec.soldQty ?? '',
      r.lot?.remainingQty ?? '',
      r.lot?.targetPriceCents == null ? '' : (r.lot.targetPriceCents / 100).toFixed(2),
      r.rec.earlyBuyPriceCents === null ? '' : (r.rec.earlyBuyPriceCents / 100).toFixed(2),
      r.sell?.soldAt ?? '',
      r.sell?.priceCents == null ? '' : (r.sell.priceCents / 100).toFixed(2),
      r.sell?.profitCents == null ? '' : (r.sell.profitCents / 100).toFixed(2),
      [r.sell?.rebuyStatus === 'pending' ? '待回补' : '', r.sell?.sellBeforeBuy ? '先卖后买' : '', r.rec.deletedAt ? '已删除' : '']
        .filter(Boolean)
        .join(' '),
    ])
    downloadText('交易明细.csv', toCsv([head, ...body]), 'text/csv;charset=utf-8')
  }

  /**
   * V9.64：按【交易记录】原表头逐列导出当前筛选的明细（xlsx），列序与导入模板一一对应——
   * 导出的文件可以直接改完再导入（行身份按 股票+买入日期+买入价+份额 匹配，同身份更新卖出侧）。
   * 日期写 YYYY-MM-DD 文本（解析器两种都认），价格写数字。
   */
  async function exportExcel() {
    const body = visible.map((r) => [
      r.rec.stockName,
      r.lot ? isoDate(r.lot.buyDate) : serialToIso(r.rec.buyDateSerial) ?? '',
      r.rec.buyPriceCents === null ? null : r.rec.buyPriceCents / 100,
      r.lot?.qty ?? r.rec.buyQtyRaw ?? null,
      (r.lot?.targetPriceCents ?? r.rec.targetPriceCents) == null
        ? null
        : (r.lot?.targetPriceCents ?? r.rec.targetPriceCents)! / 100,
      r.rec.soldQty ?? null,
      (r.rec.rawProfitCents ?? r.sell?.profitCents) == null
        ? null
        : (r.rec.rawProfitCents ?? r.sell!.profitCents!) / 100,
      r.sell?.soldAt ?? serialToIso(r.rec.sellDateSerial) ?? '',
      r.rec.earlyBuyPriceCents === null ? null : r.rec.earlyBuyPriceCents / 100,
    ])
    const data = await exportRecordsWorkbook(body)
    downloadBytes(`交易明细-${todayIso()}.xlsx`, data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    notificationOpen({ message: '已导出 Excel', description: `${visible.length} 行 · 【交易记录】表头可直接改完再导入`, type: 'success' })
  }

  return (
    <div className="stack">
      <div className={`page-sticky trades-sticky${filtersHidden ? ' is-condensed' : ''}`} data-sticky="trades">
        <div className="page-title">
          <h2>明细</h2>
          <p>{filtered.length} / {rows.length} 笔</p>
        </div>

        {/* V9.60：收起改连续收放动画（grid-rows，同挂单页 V9.44）——[hidden] 瞬切会让吸顶高度跳变 */}
        <div className={`trades-collapse${filtersHidden ? ' closed' : ''}`} aria-hidden={filtersHidden}>
          <div className="trades-collapse-inner">
            <div className="trades-filters">
        <div className="stock-tabs" style={{ marginBottom: 8 }}>
          <Tag
            size="medium"
            variant={stockFilter === 'all' ? 'solid' : 'soft'}
            color={stockFilter === 'all' ? 'app-teal' : 'default'}
            onClick={() => setStockFilter('all')}
          >
            全部
          </Tag>
          {stockNames.map((n) => (
            <Tag
              key={n}
              size="medium"
              variant={stockFilter === n ? 'solid' : 'soft'}
              color={stockFilter === n ? 'app-teal' : 'default'}
              onClick={() => setStockFilter(n)}
            >
              {n}
            </Tag>
          ))}
        </div>

        {/* 状态可多选（V9 可叠加）：命中的行要满足每个勾选的状态；单行横滑省吸顶高度 */}
        <div className="filter-chips status-chips scroll" role="group" aria-label="按状态筛选">
          {STATUS_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`filter-chip toggle${statuses.includes(k) ? ' on' : ''}`}
              aria-pressed={statuses.includes(k)}
              onClick={() => {
                // 「已卖完」和「隐藏已完成」天然互斥：勾已卖完时自动放开隐藏，避免空列表
                if (k === 'soldout' && !statuses.includes(k)) setHideDone(false)
                setStatuses((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))
              }}
            >
              {STATUS_LABEL[k]}
            </button>
          ))}
          {/* V9.5：已完成默认排除，点一下找回（URL 记住 showDone=1） */}
          <button
            type="button"
            className={`filter-chip toggle${hideDone ? ' on' : ''}`}
            aria-pressed={hideDone}
            data-action="hide-done"
            onClick={() => setHideDone((v) => !v)}
          >
            隐藏已完成
          </button>
        </div>

        {/* S3：日期区间筛选不设页面组件（V9.11 删）——只用年月：从「统计 · 月度成交 / 成交日历」跳转带入 from/to，条件 chip 可点掉 */}

        {/* 已生效条件 chips + 一键复位（每颗 chip 可单独点掉） */}
        {activeChips.length > 0 && (
          <div className="filter-chips" data-testid="active-chips">
            {activeChips.map((c) => (
              <button key={c.key} type="button" className="filter-chip" onClick={c.clear}>
                {c.label}
                <span className="x" aria-hidden>
                  ×
                </span>
              </button>
            ))}
            <button type="button" className="filter-chip reset" onClick={resetFilters} data-action="reset-filters">
              清空筛选
            </button>
          </div>
        )}
            </div>
          </div>
        </div>
      </div>

      <Card>
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <Switch size="small" checked={showDeleted} onChange={setShowDeleted} aria-label="显示已删除" />
            显示已删除
          </label>
          <div className="spacer" />
          <Button size="small" data-action="export-excel" onClick={() => void exportExcel()}>
            导出 Excel
          </Button>
          <Button size="small" onClick={exportCsv}>导出 CSV</Button>
        </div>
        {/* 排序平铺（V9.4）：像表头一样直接可见；同项单击反序，再点回默认「录入顺序 新→旧」 */}
        <div className="filter-chips sort-chips" role="group" aria-label="排序">
          {SORT_CHIPS.map((c) => {
            const active = sortBy === c.desc || sortBy === c.asc
            return (
              <button
                key={c.key}
                type="button"
                className={`filter-chip toggle${active ? ' on' : ''}`}
                aria-pressed={active}
                onClick={() => {
                  if (sortBy === c.desc) setSortBy(c.asc)
                  else if (sortBy === c.asc) setSortBy('rowDesc')
                  else setSortBy(c.desc)
                }}
              >
                {c.label}
                {active && <span aria-hidden>{sortBy === c.asc ? '↑' : '↓'}</span>}
              </button>
            )
          })}
        </div>
        <Button
          block
          type="primary"
          style={{ marginTop: 8 }}
          onClick={() => {
            setForm(blankForm(stockFilter === 'all' ? stockNames[0] ?? '' : stockFilter))
            setAdding(true)
          }}
        >
          新增一笔
        </Button>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <div className="empty-box">
            没有匹配的行
            {noDateHidden > 0 && (
              <span className="tiny" style={{ display: 'block', marginTop: 4 }}>
                另有 {noDateHidden} 行没有任何日期，被日期区间条件排除
              </span>
            )}
          </div>
        </Card>
      ) : (
        visible.map((r) => {
          // V9.30 挂钩状态标签（可点）：未回补的裸卖 → 「裸卖待挂钩」/「已挂钩 · 改挂」，
          // 点一下直接弹绑定面板（不用先开抽屉）；被挂的高位批次 → 「挂钩暂记 · 原目标 x」
          // V9.33：这条挂钩有异常（失效 / 超挂 / 挂不满）→ 标签变红，点进去看红条
          let hedgeTag: ReactNode = null
          if (r.rec.buyPriceCents === null && (r.rec.soldQty ?? 0) > 0) {
            if (hedgeableRows.has(r.rec.sourceRow)) {
              const linked = hedgeOf.has(r.rec.sourceRow)
              const broken = hedgeIssues.has(r.rec.sourceRow)
              hedgeTag = (
                <span
                  data-hedge={r.rec.sourceRow}
                  style={{ display: 'inline-flex', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation() // 别顺手把抽屉也打开
                    setHedgeRow(r.rec.sourceRow)
                  }}
                >
                  <Tag size="small" variant="soft" color={broken ? 'app-red' : linked ? 'app-teal' : 'app-yellow'}>
                    {broken ? '挂钩异常 · 改挂' : linked ? '已挂钩 · 改挂' : '裸卖待挂钩'}
                  </Tag>
                </span>
              )
            }
          } else if (r.sell && r.sell.hedgedFromSellRow !== undefined) {
            // V9.46：回补过的截 = 高位批次「亏着清仓」，成了回本链的锚点（一直不回本就一直欠着）
            const chain = repairByAnchor.get(r.rec.sourceRow)
            hedgeTag = r.sell.hedgeClosed ? (
              <Tag size="small" variant="soft" color={chain?.done ? 'app-green' : 'app-red'}>
                {chain?.done
                  ? '回本链 · 已不亏钱'
                  : chain
                    ? `回本链 · 还差 ${money(chain.gapCents)}`
                    : '高位已了结'}
              </Tag>
            ) : (
              <Tag size="small" variant="soft" color="app-orange">
                挂钩暂记{r.lot ? ` · 原目标 ${price(r.lot.targetPriceCents)}` : ''}
              </Tag>
            )
          }
          // V9.46：这笔买入被归进某条回本链 → 行上标出来，点进抽屉能「移出回本链」
          const anchorChain = repairByAnchor.get(r.rec.sourceRow)
          const memberChain = repairByMember.get(r.rec.sourceRow)
          const isBranch = branchRows.has(r.rec.sourceRow)
          const chainTag: ReactNode = hedgeTag
            ? null
            : anchorChain
              ? (
                <Tag size="small" variant="soft" color={anchorChain.done ? 'app-green' : 'app-red'}>
                  {anchorChain.done ? '回本链 · 已不亏钱' : `回本链 · 还差 ${money(anchorChain.gapCents)}`}
                </Tag>
              )
              : memberChain
                ? (
                  <Tag size="small" variant="soft" color="app-teal">
                    {isBranch ? '回本链 · 同价回补' : '归入回本链'}
                  </Tag>
                )
                : null
          const anim = leaving.has(r.rec.sourceRow)
            ? 'leaving'
            : flashRow === r.rec.sourceRow
              ? 'new'
              : justDone.has(r.rec.sourceRow)
                ? 'done'
                : undefined
          return (
            <TradeItem
              key={r.rec.sourceRow}
              row={r}
              no={recordNo.of(r.rec.sourceRow)}
              onClick={() => open(r)}
              // V9.49：价位槽的行先亮回本链（它已经是这条链的一环，不必再提示「裸卖待挂钩」）
              extraTag={isBranch && memberChain ? chainTag : (hedgeTag ?? chainTag)}
              anim={anim}
              chain={anchorChain ? 'anchor' : memberChain ? (isBranch ? 'branch' : 'member') : undefined}
            />
          )
        })
      )}

      <p className="tiny muted" style={{ textAlign: 'center' }}>
        共 {visible.length} 笔 · 合计盈利 {money(visible.reduce((a, r) => a + (r.sell?.profitCents ?? 0), 0))}
        {hiddenStockCount > 0 && stockFilter === 'all' && ` · 已隐藏 ${hiddenStockCount} 只停用股票`}
      </p>

      <Drawer
        open={current !== null}
        placement="bottom"
        height="var(--ed-h, 84vh)"
        // V9.34：抽屉和主内容列同宽（见 styles.css .trades-edit-drawer），不再占满整屏
        className="trades-edit-drawer"
        title={
          current
            ? `${current.rec.stockName} · ${recordNoLabelOf(current.rec.sourceRow)}`
            : ''
        }
        onClose={() => setOpenRow(null)}
        footer={
          current ? (
            <div className="row nowrap" style={{ gap: 8 }}>
              {editing ? (
                <>
                  <Button type="primary" style={{ flex: 1 }} onClick={() => void save()}>保存</Button>
                  <Button onClick={() => setEditing(false)}>取消</Button>
                </>
              ) : (
                <>
                  <Button type="primary" style={{ flex: 1 }} onClick={() => startEdit()}>编辑</Button>
                  {/* V9.35：先卖后买的行，一键把买入侧按回补价填好再进编辑 */}
                  {isNakedSell(current.rec) && !current.rec.deletedAt && (
                    <Button onClick={() => startEdit(true)}>补买入</Button>
                  )}
                  {current.rec.deletedAt ? (
                    <Button onClick={() => void onRestore(current.rec.sourceRow)}>恢复</Button>
                  ) : (
                    <Button danger onClick={() => void onDelete(current.rec.sourceRow)}>删除</Button>
                  )}
                </>
              )}
            </div>
          ) : null
        }
      >
        {current && (
          <div className="stack">
            {editing ? (
              <>
              <div className="form-grid">
                {EDITABLE.map((f) => {
                  // V9.50 用户拍板：成交数量是既成事实——买入/卖出份额只能看不能改，只放开对手价
                  const locked = lockedField(f.key, current)
                  return (
                    <label key={f.key}>
                      <span>
                        {f.label}
                        {locked && (
                          <b className="tiny muted" style={{ fontWeight: 400 }}>
                            {' '}
                            · 成交数量不可改
                          </b>
                        )}
                        {/* V9.35：日期给个「今天」快捷键，省得手打；输入框也认 2026/10/25 */}
                        {f.kind === 'date' && !locked && (
                          <button
                            type="button"
                            className="date-today"
                            onClick={() => setDraft({ ...draft, [f.key]: todayIso() })}
                          >
                            今天
                          </button>
                        )}
                      </span>
                      {f.kind === 'date' ? (
                        <DateField
                          value={draft[f.key]}
                          placeholder="YYYY-MM-DD 或 YYYY/MM/DD"
                          onChange={(v) => setDraft({ ...draft, [f.key]: v })}
                          data-field={f.key}
                        />
                      ) : (
                        <Input
                          value={draft[f.key]}
                          placeholder={f.kind === 'qty' ? '股数' : '元'}
                          onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                          data-field={f.key}
                          data-locked={locked ? '1' : undefined}
                          disabled={locked}
                        />
                      )}
                    </label>
                  )
                })}
                <p className="tiny muted" style={{ margin: 0 }}>
                  成交价由 E 列（目标售价）决定；成本优先取买入价，无批次时取 P 列。
                </p>
                {isNakedSell(current.rec) && (
                  <p className="tiny muted" style={{ margin: 0 }}>
                    先卖后买：点「补买入」会按「回补价 / 卖出量 / 今天」把买入三格填好，
                    你只需改成实际成交价；只想改卖出侧就别填这三格。
                  </p>
                )}
              </div>
              <LotMergeBinder key={`merge-edit-${current.rec.sourceRow}`} row={current.rec.sourceRow} />
              </>
            ) : (
              <>
                <div className="detail-kv">
                  <div className="item">
                    <div className="k">买入日期</div>
                    <div className="v">{isoDate(current.lot?.buyDate ?? serialToIso(current.rec.buyDateSerial))}</div>
                  </div>
                  <div className="item">
                    <div className="k">买入价 / 份额</div>
                    <div className="v">
                      {price(current.rec.buyPriceCents)} / {qty(current.lot?.qty ?? current.rec.buyQtyRaw)}
                    </div>
                  </div>
                  <div className="item">
                    <div className="k">目标售价</div>
                    <div className="v">{price(current.lot?.targetPriceCents ?? current.rec.targetPriceCents)}</div>
                  </div>
                  <div className="item">
                    <div className="k">回补价 P</div>
                    <div className="v">{price(current.rec.earlyBuyPriceCents)}</div>
                  </div>
                  <div className="item">
                    <div className="k">已卖 / 剩余</div>
                    <div className="v">
                      {qty(current.rec.soldQty)} / {current.lot ? qty(current.lot.remainingQty) : '—'}
                    </div>
                  </div>
                  <div className="item">
                    <div className="k">成交价</div>
                    <div className="v">{price(current.sell?.priceCents)}</div>
                  </div>
                  <div className="item">
                    <div className="k">卖出日期</div>
                    <div className="v">{current.sell ? isoDate(current.sell.soldAt) : '—'}</div>
                  </div>
                  <div className="item">
                    <div className="k">实现盈利</div>
                    <div className={`v ${tone(current.sell?.profitCents ?? null)}`}>
                      {signedMoney(current.sell?.profitCents)}
                    </div>
                  </div>
                </div>

                {current.sell?.hedgedHold === true && (
                  <p className="tiny muted" style={{ margin: '0 0 4px' }}>
                    已挂钩：盈利暂缓计算——买回后由高位批次按卖出价了结，亏损进「回本链」，
                    靠低位继续做T的价差冲平；一直不买回则挂钩暂记就是真实亏损。
                  </p>
                )}
                {current.sell?.hedgedFromSellRow !== undefined && (
                  <p className="tiny muted" style={{ margin: '0 0 4px' }}>
                    {current.sell.hedgeClosed
                      ? `已了结：本批次有 ${qty(current.sell.qty)} 股按${recordNoLabelOf(current.sell.hedgedFromSellRow)}裸卖的卖出价兑现了，份额不再回到待卖——亏损挂在「回本链」上等低位回血。`
                      : `挂钩暂记：这是${recordNoLabelOf(current.sell.hedgedFromSellRow)}裸卖暂挂到本批次的份额；买回后这批份额按卖出价永久了结，不再复活。`}
                  </p>
                )}

                <div className="tag-row">
                  {current.sell?.rebuyStatus === 'pending' && <Tag size="small" variant="soft" color="app-orange">待回补</Tag>}
                  {current.rec.rebuyPriceSource === 'lot' && (
                    <Tag size="small" variant="soft" color="purple">回补价 = 关联买入价</Tag>
                  )}
                  {current.rec.rebuyPriceSource === 'sellMinusInterval' && (
                    <Tag size="small" variant="soft" color="purple">回补价 = 卖出价 − 间隔</Tag>
                  )}
                  {current.rec.rebuyPriceSource === 'repaid' && (
                    <Tag size="small" variant="soft">已回补</Tag>
                  )}
                  {current.sell?.sellBeforeBuy && <Tag size="small" variant="soft" color="app-teal">先卖后买</Tag>}
                  {current.rec.origin === 'excel' && (
                    <Tag size="small" variant="soft">Excel 第 {current.rec.excelRow ?? current.rec.sourceRow} 行</Tag>
                  )}
                  {current.sell?.dateMissing && <Tag size="small" variant="soft" color="app-yellow">缺日期</Tag>}
                  {current.sell && current.sell.priceCents === null && <Tag size="small" variant="soft" color="app-red">缺价格</Tag>}
                  {current.rec.deletedAt && <Tag size="small" variant="soft" color="app-red">已删除</Tag>}
                </div>

                {current.lot && current.lot.remainingQty > 0 && (
                  <div className="divider-top">
                    <div className="sec-head sm">
                      <strong>卖出目标</strong>
                      <div className="spacer" />
                      <span className="sec-sub">
                        批次剩余 {qty(current.lot.remainingQty)} 股
                      </span>
                    </div>
                    <div className="data-block">
                    {ledger.targets
                      .filter((t) => t.lotId === current.lot!.id)
                      .map((t) => (
                        <div key={t.id} className="line">
                          <div className="left">
                            <div className="t1 num">
                              {price(t.priceCents)} × {qty(t.qty)}
                            </div>
                            <div className="t2">
                              {t.autoGenerated ? '自动（E 列）' : '手动拆分'}
                              {` · 预期 ${signedMoney(t.expectProfitCents)}`}
                            </div>
                          </div>
                          {!t.autoGenerated && (
                            <Button
                              size="small"
                              danger
                              onClick={() => void removeExtraTarget(t.id.replace('target:', ''))}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                    {ledger.targets.filter((t) => t.lotId === current.lot!.id).length === 0 && (
                      <p className="tiny muted" style={{ margin: '0 0 6px' }}>
                        还没有目标（缺目标售价）
                      </p>
                    )}
                    <div className="row nowrap" style={{ gap: 6, marginTop: 6 }}>
                      <Input
                        className="grow"
                        value={tpPrice}
                        onChange={(e) => setTpPrice(e.target.value)}
                        // V9.62：批次没填目标价时，按 V9.49 口径用「买入价 + 该股间隔」兜底——留空也能拆
                        placeholder={
                          tpFallback === null ? '拆分目标价' : centsToYuan(tpFallback)
                        }
                        aria-label="拆分目标价"
                      />
                      <Input
                        className="grow"
                        value={tpQty}
                        onChange={(e) => setTpQty(e.target.value)}
                        placeholder={String(splitLeftOf(current.lot.id))}
                        aria-label="拆分股数"
                      />
                      <Button
                        size="small"
                        onClick={() => {
                          if (!current.lot) return
                          const p = toCents(inputOrDefault(tpPrice, tpFallback === null ? '' : centsToYuan(tpFallback)))
                          const left = splitLeftOf(current.lot.id)
                          const raw = Number(inputOrDefault(tpQty, String(left)))
                          if (p === null || p <= 0 || !Number.isInteger(raw) || raw <= 0) {
                            notificationOpen({ message: '拆分价和股数都要填', type: 'warning' })
                            return
                          }
                          if (left <= 0) {
                            notificationOpen({ message: '这批已经没有可拆的份额了', type: 'warning' })
                            return
                          }
                          // V9.51：超过剩余量直接夹住，绝不拆出超额（不再靠事后截断报异常）
                          const qn = Math.min(raw, left)
                          void addExtraTarget(current.lot.id, p, qn).then(() => {
                            setTpPrice('')
                            setTpQty('')
                            notificationOpen({
                              message: '已拆分目标',
                              description:
                                raw > left ? `超过还能拆的 ${left} 股，已按剩余量拆分` : '自动目标按剩余量缩减',
                              type: 'success',
                            })
                          })
                        }}
                      >
                        拆分
                      </Button>
                    </div>
                    <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                      留空采用框内默认值（股数默认「还能拆的量」）。分批止盈：手动目标先占份额，剩下的仍挂在 E 列价上；超过还能拆的量会自动按剩余量拆分。
                    </p>
                  </div>
                )}

                {/* V9.50 卖单拆买：先卖后买拆成多笔买入，挂单页与概览只显示拆出来的档 */}
                {isNakedSell(current.rec) && (current.sell?.qty ?? 0) > 0 && (
                  <div className="divider-top" data-testid="buy-split-section">
                    <div className="sec-head sm">
                      <strong>买入拆分</strong>
                      <div className="spacer" />
                      <span className="sec-sub">
                        还没回补 {qty(rebuyLeftOf(current.rec.sourceRow))} 股
                      </span>
                    </div>
                    <div className="data-block">
                      {(() => {
                        const mine = ledger.buySplits.filter((b) => b.sourceRow === current.rec.sourceRow && b.split)
                        return mine.map((b, i) => (
                          <div key={b.key} className="line" data-buy-split={b.key}>
                            <div className="left">
                              <div className="t1 num">
                                第 {i + 1}/{mine.length} 档 · {price(b.priceCents)} × {qty(b.plannedQty)}
                              </div>
                              <div className="t2">
                                手动拆分
                                {b.executedQty > 0 ? ` · 已回补 ${qty(b.executedQty)} · 还剩 ${qty(b.qty)}` : ''}
                              </div>
                            </div>
                            {b.targetId && (
                              <Button size="small" danger onClick={() => void removeBuyTarget(b.targetId!)}>
                                删除
                              </Button>
                            )}
                          </div>
                        ))
                      })()}
                    </div>
                    <div className="row nowrap" style={{ gap: 6, marginTop: 6 }}>
                      <Input
                        className="grow"
                        value={bpPrice}
                        onChange={(e) => setBpPrice(e.target.value)}
                        // V9.62：回补价派生不出来时按「卖价 − 该股间隔」兜底，能推就当留空默认值
                        placeholder={bpFallback === null ? '拆分买入价' : centsToYuan(bpFallback)}
                        aria-label="拆分买入价"
                      />
                      <Input
                        className="grow"
                        value={bpQty}
                        onChange={(e) => setBpQty(e.target.value)}
                        placeholder={String(buySplitLeftOf(current.rec.sourceRow))}
                        aria-label="拆分买入股数"
                      />
                      <Button
                        size="small"
                        onClick={() => {
                          const p = toCents(inputOrDefault(bpPrice, bpFallback === null ? '' : centsToYuan(bpFallback)))
                          const left = buySplitLeftOf(current.rec.sourceRow)
                          const raw = Number(inputOrDefault(bpQty, String(left)))
                          if (p === null || p <= 0 || !Number.isInteger(raw) || raw <= 0) {
                            notificationOpen({ message: '拆分价和股数都要填', type: 'warning' })
                            return
                          }
                          if (left <= 0) {
                            notificationOpen({ message: '这笔已经没有可拆的回补份额了', type: 'warning' })
                            return
                          }
                          // V9.51：超过还没回补的股数直接夹住
                          const qn = Math.min(raw, left)
                          void addBuyTarget(current.rec.sourceRow, p, qn).then(() => {
                            setBpPrice('')
                            setBpQty('')
                            notificationOpen({
                              message: '已拆分买入',
                              description:
                                raw > left ? `超过还能拆的 ${left} 股，已按剩余量拆分` : '挂单页按拆出来的档显示',
                              type: 'success',
                            })
                          })
                        }}
                      >
                        拆分
                      </Button>
                    </div>
                    <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                      留空采用框内默认值（股数默认「还能拆的量」）。合计不能超过还没回补的股数，超过会自动按剩余量拆分；拆分后挂单页和概览只显示拆出来的买单。
                    </p>
                  </div>
                )}

                {/* V9.45：同股同买入价、还没卖完的批次可以合并——只影响挂单提醒的显示 */}
                <LotMergeBinder key={`merge-${current.rec.sourceRow}`} row={current.rec.sourceRow} />

                {/* V9.26 先卖后买挂钩：裸卖未回补时人工指定未完成买单（V9.30 面板抽成 HedgeBinder） */}
                {current.rec.buyPriceCents === null && (current.rec.soldQty ?? 0) > 0 && (
                  <div className="divider-top" data-testid="hedge-section">
                    <div className="sec-head sm">
                      <strong>裸卖待挂钩</strong>
                      <div className="spacer" />
                      <span className="sec-sub">卖出 {qty(current.rec.soldQty ?? 0)} 股</span>
                    </div>
                    <HedgeBinder sellRow={current.rec.sourceRow} />
                  </div>
                )}

                {/* V9.46 回本链：亏损清仓当场成链，进度只累计归属交易的已实现净盈利 */}
                {(repairByAnchor.has(current.rec.sourceRow) ||
                  repairBySell.has(current.rec.sourceRow) ||
                  repairByMember.has(current.rec.sourceRow)) && (
                  <div className="divider-top" data-testid="chain-section">
                    {[
                      repairByAnchor.get(current.rec.sourceRow),
                      ...(repairBySell.get(current.rec.sourceRow) ?? []),
                      repairByMember.get(current.rec.sourceRow),
                    ]
                      .filter((c): c is RepairChain => Boolean(c))
                      .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i)
                      .map((c) => (
                        <RepairChainCard key={c.id} chain={c} rowLabel={recordNoLabelOf} />
                      ))}
                    <ChainBinder
                      key={`chain-binder-${current.rec.sourceRow}`}
                      row={current.rec.sourceRow}
                      onAddToChain={startAddIntoChain}
                    />
                  </div>
                )}

                <div className="divider-top" data-testid="related-executions">
                  <strong>关联成交</strong>
                  {ledger.sells.filter((v)=>v.lotId===current.lot?.id || v.sourceRow===current.rec.sourceRow).map((v)=><div key={v.id} className="line tiny"><span>{v.soldAt??'未填日期'} · 卖 {price(v.priceCents)} × {qty(v.qty)}{v.hedgedFromSellRow!==undefined?' · 挂钩分配':''}</span><span>{signedMoney(v.profitCents)}</span></div>)}
                  {executions.filter((e)=>e.sellExecId===`sell:${current.rec.sourceRow}`).map((e)=><div key={e.id} className="line tiny"><span>回补 {price(e.priceCents)} × {qty(e.qty)}</span><span>{new Date(e.at).toLocaleDateString()}</span></div>)}
                  {current.rec.soldLotId && <p className="tiny muted">来源批次：{current.rec.soldLotId.startsWith('lot:exec:')?'回补批次':recordNoLabelOf(Number(current.rec.soldLotId.replace('lot:','')))}</p>}
                </div>
                <div className="divider-top">
                  <div className="sec-head sm">
                    <strong>变更历史</strong>
                    <div className="spacer" />
                    <span className="tiny muted">{historyOf(current.rec.sourceRow).length} 条</span>
                  </div>
                  {historyOf(current.rec.sourceRow).length === 0 ? (
                    <p className="tiny muted" style={{ margin: 0 }}>还没改过</p>
                  ) : (
                    <ul className="hist-list">
                      {historyOf(current.rec.sourceRow).map((a, i) => (
                        <li key={a.id ?? i}>
                          <span className="when mono">
                            {new Date(a.at).toLocaleString('zh-CN', {
                              hour12: false,
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                          <span className="field">{a.field}</span>
                          <span>{a.oldValue} → {a.newValue}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>

      {/* V9.30 裸卖待挂钩弹层：行上标签点开，直接选未完成买单 → 绑定 */}
      <HedgeSheet sellRow={hedgeRow} onClose={() => setHedgeRow(null)} />

      <Modal
        open={adding}
        title="新增一笔"
        typewriter={false}
        onClose={() => setAdding(false)}
        footer={
          <div className="row nowrap" style={{ gap: 8 }}>
            <Button type="primary" style={{ flex: 1 }} onClick={() => void onAdd()}>保存</Button>
            <Button onClick={() => setAdding(false)}>取消</Button>
          </div>
        }
      >
        <div className="stack tight" onKeyDown={enterSubmit(() => void onAdd())}>
          <div className="type-toggle">
            <Button
              type={form.kind === 'buy' ? 'primary' : 'default'}
              onClick={() => setForm({ ...form, kind: 'buy' })}
            >
              买入
            </Button>
            <Button
              type={form.kind === 'sell' ? 'primary' : 'default'}
              onClick={() => setForm({ ...form, kind: 'sell' })}
            >
              卖出
            </Button>
          </div>

          <div className="form-grid">
            <label>
              <span>股票</span>
              <Select
                options={[{ key: '', label: '选择…' }, ...stockNames.map((n) => ({ key: n, label: n }))]}
                value={form.stockName}
                onChange={(v) => setForm({ ...form, stockName: v })}
                placeholder="选择股票"
                aria-label="股票"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入日期' : '卖出日期'}</span>
              <DateField
                value={form.date}
                placeholder={formDefaults.date}
                onChange={(v) => setForm({ ...form, date: v })}
                data-field="date"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入价' : '成交价'}</span>
              <Input
                value={form.price}
                placeholder={formDefaults.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                data-field="price"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入份额' : '卖出数量'}</span>
              <Input
                value={form.qty}
                placeholder={formDefaults.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                data-field="qty"
              />
            </label>

            {form.kind === 'buy' ? (
              <label>
                <span>目标售价（可空，空则按「买入价 + 间隔」派生）</span>
                <Input
                  value={form.targetPrice ?? ''}
                  placeholder={autoTarget || '留空＝买入价 + 该股间隔'}
                  onChange={(e) => setForm({ ...form, targetPrice: e.target.value })}
                  data-field="targetPrice"
                />
              </label>
            ) : (
              <>
                <label>
                  <span>回补价 P（可空，按 R3 自动推导）</span>
                  <Input
                    value={form.rebuyPrice ?? ''}
                    placeholder={autoRebuy ? `留空＝${autoRebuy}` : '留空则按优先级推导'}
                    onChange={(e) => setForm({ ...form, rebuyPrice: e.target.value })}
                    data-field="rebuyPrice"
                  />
                </label>
                <label className="row" style={{ gap: 8, fontSize: 12 }}>
                  <Switch
                    size="small"
                    checked={form.repaid === true}
                    onChange={(v) => setForm({ ...form, repaid: v })}
                    aria-label="这笔已回补"
                  />
                  这笔已回补（不生成待买）
                </label>
                <p className="tiny muted" style={{ margin: 0 }}>
                  新增卖出默认都生成待买。回补价留空时按「关联买入价 → 卖出价 − 该股间隔」推导，
                  都推不出会让你手填。卖的是已有批次就勾上「已回补」。
                </p>
                <div className="row nowrap">
                  <label style={{ flex: 1 }}>
                    <span>买入价（选填）</span>
                    <Input
                      value={form.buyPrice ?? ''}
                      placeholder={formDefaults.buyPrice}
                      onChange={(e) => {
                        const v = e.target.value
                        // V9.35：开始填买入价（=这笔回补）时，份额默认=卖出数量、日期默认=今天
                        setForm((f) => ({
                          ...f,
                          buyPrice: v,
                          buyQty: f.buyQty || (v.trim() ? inputOrDefault(f.qty, formDefaults.qty) : ''),
                          buyDate: f.buyDate || (v.trim() ? todayIso() : ''),
                        }))
                      }}
                      data-field="buyPrice"
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <span>买入份额（选填）</span>
                    <Input
                      value={form.buyQty ?? ''}
                      placeholder={formDefaults.buyQty}
                      onChange={(e) => setForm({ ...form, buyQty: e.target.value })}
                      data-field="buyQty"
                    />
                  </label>
                </div>
                <label>
                  <span>买入日期（选填）</span>
                  <DateField
                    value={form.buyDate ?? ''}
                    placeholder={formDefaults.buyDate}
                    onChange={(v) => setForm({ ...form, buyDate: v })}
                    data-field="buyDate"
                  />
                </label>
              </>
            )}
            <p className="tiny muted" style={{ margin: 0 }}>
              留空采用框内默认值；选填买入信息全部留空时不新增买入，开始填写后其余项采用默认值。
              新增后和导入的数据完全同构，按录入顺序编号；Excel 行号只在抽屉里做追溯。
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}

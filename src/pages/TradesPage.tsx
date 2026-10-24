import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Drawer, Input, Modal, Select, Switch, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { serialToIso } from '../domain/defaults'
import { EDITABLE, fieldText, type EditableKey } from '../domain/edit'
import { activeStocks } from '../domain/stocks'
import type { ManualInput } from '../domain/manual'
import { isoDate, money, price, qty, signedMoney, tone } from '../ui/format'
import { replaceRoute, type TradesQuery } from '../ui/nav'
import { buildNanoIdIndex } from '../ui/nanoid'
import { toCents } from '../domain/money'
import { downloadText, toCsv } from '../ui/csv'
import type { Lot, RawRecord, SellExecution } from '../domain/types'

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

interface Row {
  rec: RawRecord
  lot: Lot | null
  sell: SellExecution | null
}

const SORT_KEYS: readonly string[] = ['rowDesc', 'rowAsc', 'buyDateDesc', 'buyDateAsc', 'sellDateDesc', 'sellDateAsc', 'profitDesc', 'profitAsc']

/**
 * 排序平铺（V9.4）：4 个维度像表头一样直接可见。
 * 点击循环：默认（行号 高→低）→ 该维度主方向 → 反序 → 回默认。
 */
const SORT_CHIPS: { key: string; label: string; desc: SortBy; asc: SortBy }[] = [
  { key: 'row', label: '行号', desc: 'rowDesc', asc: 'rowAsc' },
  { key: 'buyDate', label: '买入日期', desc: 'buyDateDesc', asc: 'buyDateAsc' },
  { key: 'sellDate', label: '卖出日期', desc: 'sellDateDesc', asc: 'sellDateAsc' },
  { key: 'profit', label: '盈利', desc: 'profitDesc', asc: 'profitAsc' },
]

/** 行上的买入日期（可空） */
function buyDateOf(r: Row): string | null {
  return r.lot?.buyDate ?? serialToIso(r.rec.buyDateSerial)
}

/** 行上的卖出日期（可空） */
function sellDateOf(r: Row): string | null {
  return r.sell?.soldAt ?? null
}

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

export function TradesPage({ urlQuery }: { urlQuery: TradesQuery }) {
  const {
    ledger,
    scopedRecords,
    records,
    stocks,
    editRecord,
    softDelete,
    restore,
    addManualRecord,
    historyOf,
    addExtraTarget,
    removeExtraTarget,
  } = useApp()
  const [stockFilter, setStockFilter] = useState(urlQuery.stock ?? 'all')
  const [statuses, setStatuses] = useState<StatusKey[]>(() => (urlQuery.status ?? []).filter(isStatusKey))
  const [keyword, setKeyword] = useState(urlQuery.q ?? '')
  const [priceFilter, setPriceFilter] = useState<number | null>(
    typeof urlQuery.price === 'number' ? urlQuery.price : null,
  )
  const [fromDate, setFromDate] = useState(urlQuery.from ?? '')
  const [toDate, setToDate] = useState(urlQuery.to ?? '')
  const [idFilter, setIdFilter] = useState<string | null>(urlQuery.id ?? null)
  const [sortBy, setSortBy] = useState<SortBy>(() =>
    SORT_KEYS.includes(urlQuery.sort ?? '') ? (urlQuery.sort as SortBy) : 'rowDesc',
  )
  const [showDeleted, setShowDeleted] = useState(urlQuery.del === true)
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<EditableKey, string>>(BLANK_DRAFT)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<ManualInput>(BLANK_FORM)
  const [tpPrice, setTpPrice] = useState('')
  const [tpQty, setTpQty] = useState('')

  // 外部跳转 / 浏览器前进后退：hash 变了就把筛选整体换过去（跨数据跳转的落点）
  const urlKey = JSON.stringify(urlQuery)
  useEffect(() => {
    const q = JSON.parse(urlKey) as TradesQuery
    setStockFilter(q.stock ?? 'all')
    setStatuses((q.status ?? []).filter(isStatusKey))
    setKeyword(q.q ?? '')
    setPriceFilter(typeof q.price === 'number' ? q.price : null)
    setFromDate(q.from ?? '')
    setToDate(q.to ?? '')
    setIdFilter(typeof q.id === 'string' && q.id ? q.id : null)
    setSortBy(SORT_KEYS.includes(q.sort ?? '') ? (q.sort as SortBy) : 'rowDesc')
    setShowDeleted(q.del === true)
  }, [urlKey])

  // 反向同步：筛选变化写回 hash（replaceState，不产生历史条目）
  useEffect(() => {
    replaceRoute('trades', {
      stock: stockFilter === 'all' ? undefined : stockFilter,
      status: statuses.length > 0 ? statuses : undefined,
      q: keyword || undefined,
      price: priceFilter ?? undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
      id: idFilter ?? undefined,
      sort: sortBy === 'rowDesc' ? undefined : sortBy,
      del: showDeleted || undefined,
    })
  }, [stockFilter, statuses, keyword, priceFilter, fromDate, toDate, idFilter, sortBy, showDeleted])

  // nanoId 索引：展示 / 筛选 / 跳转的唯一行级 id（V9.4）
  const nano = useMemo(() => buildNanoIdIndex(scopedRecords), [scopedRecords])

  // 股票顺序 / 启停都来自「管理 · 股票」
  const stockList = useMemo(() => activeStocks(stocks), [stocks])
  const stockNames = useMemo(() => stockList.map((s) => s.name), [stockList])
  const enabledSet = useMemo(() => new Set(stockNames), [stockNames])
  const hiddenStockCount = useMemo(
    () => new Set(records.map((r) => r.stockName).filter((n) => !enabledSet.has(n))).size,
    [records, enabledSet],
  )

  const rows = useMemo<Row[]>(() => {
    const lotMap = new Map(ledger.lots.map((l) => [l.sourceRow, l]))
    const sellMap = new Map(ledger.sells.map((s) => [s.sourceRow, s]))
    return scopedRecords.map((rec) => ({
      rec,
      lot: lotMap.get(rec.sourceRow) ?? null,
      sell: sellMap.get(rec.sourceRow) ?? null,
    }))
  }, [scopedRecords, ledger])

  // 过滤 + 顺带统计「没有日期、被日期区间条件排除」的行数（空态时提示用）
  const { filtered, noDateHidden } = useMemo(() => {
    let hidden = 0
    const list = rows.filter((r) => {
      // nanoId 深链要能命中已软删的行，showDeleted 的门对目标行放行
      const rId = nano.rowToId.get(r.rec.sourceRow)
      if (!showDeleted && r.rec.deletedAt && rId !== idFilter) return false
      if (stockFilter === 'all') {
        // 停用的股票不出现在明细里
        if (!enabledSet.has(r.rec.stockName)) return false
      } else if (r.rec.stockName !== stockFilter) return false
      if (keyword && !String(r.rec.sourceRow).includes(keyword) && !r.rec.stockName.includes(keyword) && !(rId ?? '').includes(keyword)) return false
      if (priceFilter !== null) {
        const prices = [r.rec.targetPriceCents, r.rec.buyPriceCents, r.sell?.priceCents ?? null, r.rec.earlyBuyPriceCents]
        if (!prices.includes(priceFilter)) return false
      }
      if (idFilter !== null && rId !== idFilter) return false
      // 状态多选取交集：勾了几个状态，行必须全都满足
      if (statuses.length > 0 && !statuses.every((k) => statusMatch(r, k))) return false
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
  }, [rows, stockFilter, keyword, priceFilter, statuses, showDeleted, enabledSet, fromDate, toDate, idFilter, nano])

  /** 已生效的条件 chips：每颗都能单独点掉 */
  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = []
    if (stockFilter !== 'all')
      chips.push({ key: 'stock', label: `股票 ${stockFilter}`, clear: () => setStockFilter('all') })
    for (const k of statuses)
      chips.push({ key: `st-${k}`, label: STATUS_LABEL[k], clear: () => setStatuses((s) => s.filter((x) => x !== k)) })
    if (priceFilter !== null)
      chips.push({ key: 'price', label: `价格 ${(priceFilter / 100).toFixed(2)}`, clear: () => setPriceFilter(null) })
    if (fromDate || toDate)
      chips.push({
        key: 'date',
        label: `日期 ${fromDate || '…'} → ${toDate || '…'}`,
        clear: () => {
          setFromDate('')
          setToDate('')
        },
      })
    if (keyword) chips.push({ key: 'q', label: `搜索 ${keyword}`, clear: () => setKeyword('') })
    if (idFilter !== null) {
      const rec = nano.byId.get(idFilter)
      chips.push({ key: 'id', label: rec ? `行 ${rec.sourceRow}` : `#${idFilter}`, clear: () => setIdFilter(null) })
    }
    return chips
  }, [stockFilter, statuses, priceFilter, fromDate, toDate, keyword, idFilter, nano])

  /** 一键复位：股票 / 状态 / 日期 / 价格 / 关键词 / nanoId 全清（排序与已删除开关不动） */
  function resetFilters() {
    setStockFilter('all')
    setStatuses([])
    setPriceFilter(null)
    setFromDate('')
    setToDate('')
    setKeyword('')
    setIdFilter(null)
  }

  /** 排序后的可见列表（S3：行号 / 买入日期 / 卖出日期 / 盈利，各升降一档） */
  const visible = useMemo(() => {
    const arr = [...filtered]
    const profitOf = (r: Row) => r.sell?.profitCents ?? 0
    switch (sortBy) {
      case 'rowAsc':
        return arr.sort((a, b) => a.rec.sourceRow - b.rec.sourceRow)
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
        return arr.sort((a, b) => b.rec.sourceRow - a.rec.sourceRow)
    }
  }, [filtered, sortBy])

  const current = visible.find((r) => r.rec.sourceRow === openRow) ?? null

  function open(r: Row) {
    const next = { ...BLANK_DRAFT }
    for (const f of EDITABLE) next[f.key] = fieldText(r.rec, f.key)
    setDraft(next)
    setEditing(false)
    setOpenRow(r.rec.sourceRow)
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
    if (!window.confirm(`把第 ${row} 行标记为删除？软删除，可恢复。`)) return
    await softDelete(row)
    setOpenRow(null)
    notificationOpen({ message: `第 ${row} 行已删除`, description: '勾「显示已删除」可以恢复', type: 'info' })
  }

  async function onRestore(row: number) {
    await restore(row)
    notificationOpen({ message: `第 ${row} 行已恢复`, type: 'success' })
  }

  async function onAdd() {
    try {
      const row = await addManualRecord(form)
      setAdding(false)
      setForm(BLANK_FORM)
      notificationOpen({
        message: `已新增第 ${row} 行`,
        description: form.kind === 'sell' && !form.buyPrice ? '先卖后买：之后可在明细里补买入信息' : undefined,
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '新增失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  function exportCsv() {
    const head = ['行号', '来源', '股票', '买入日期', '买入价', '买入份额', '已卖', '剩余', '目标售价', '回补价', '卖出日期', '成交价', '实现盈利', '标记']
    const body = visible.map((r) => [
      r.rec.sourceRow,
      r.rec.origin === 'manual' ? '手动' : 'Excel',
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

  return (
    <div className="stack">
      <div className="page-sticky" data-sticky="trades">
        <div className="page-title">
          <h2>明细</h2>
          <p>{filtered.length} / {rows.length} 行</p>
        </div>

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

        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜股票名 / 行号"
          allowClear
          onClear={() => setKeyword('')}
          aria-label="搜索"
        />

        {/* 状态可多选（V9 可叠加）：命中的行要满足每个勾选的状态；单行横滑省吸顶高度 */}
        <div className="filter-chips status-chips scroll" role="group" aria-label="按状态筛选">
          {STATUS_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`filter-chip toggle${statuses.includes(k) ? ' on' : ''}`}
              aria-pressed={statuses.includes(k)}
              onClick={() => setStatuses((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))}
            >
              {STATUS_LABEL[k]}
            </button>
          ))}
        </div>

        {/* S3：日期区间筛选（卖出日期优先，其次买入日期） */}
        <div className="row nowrap date-row">
          <input
            type="date"
            className="date-input"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            aria-label="起始日期"
          />
          <span className="tiny muted">→</span>
          <input
            type="date"
            className="date-input"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            aria-label="结束日期"
          />
          {(fromDate || toDate) && (
            <Button
              size="small"
              type="text"
              onClick={() => {
                setFromDate('')
                setToDate('')
              }}
            >
              清除
            </Button>
          )}
        </div>

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

      <Card>
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <Switch size="small" checked={showDeleted} onChange={setShowDeleted} aria-label="显示已删除" />
            显示已删除
          </label>
          <div className="spacer" />
          <Button size="small" onClick={exportCsv}>导出 CSV</Button>
        </div>
        {/* 排序平铺（V9.4）：像表头一样直接可见；同项单击反序，再点回默认「行号 高→低」 */}
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
            setForm({ ...BLANK_FORM, stockName: stockFilter === 'all' ? stockNames[0] ?? '' : stockFilter })
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
          const deleted = Boolean(r.rec.deletedAt)
          return (
            <Card
              key={r.rec.sourceRow}
              hoverable
              onClick={() => open(r)}
              className={`trade-item${deleted ? ' deleted' : ''}`}
              data-row={r.rec.sourceRow}
            >
              <div className="head">
                <Tag size="small" variant="soft">{r.rec.origin === 'manual' ? '手动' : `行 ${r.rec.sourceRow}`}</Tag>
                <span className="tiny muted mono" title={`nanoId ${nano.rowToId.get(r.rec.sourceRow)}`}>
                  #{nano.rowToId.get(r.rec.sourceRow)}
                </span>
                <span className="name">{r.rec.stockName}</span>
                <div className="spacer" />
                <span className={`profit ${tone(r.sell?.profitCents ?? null)}`}>
                  {r.sell ? signedMoney(r.sell.profitCents) : '—'}
                </span>
              </div>
              <div className="mid">
                <span className="path num">
                  {r.rec.buyPriceCents !== null ? `买 ${price(r.rec.buyPriceCents)}` : '无买入批次'}
                  {r.lot ? ` × ${qty(r.lot.qty)}` : r.rec.soldQty ? ` · 卖 ${qty(r.rec.soldQty)}` : ''}
                  {' → '}
                  目标 {price(r.lot?.targetPriceCents ?? r.rec.targetPriceCents)}
                </span>
                <span className="tiny muted num">
                  {r.lot ? `剩余 ${qty(r.lot.remainingQty)}` : r.rec.soldQty ? `已卖 ${qty(r.rec.soldQty)}` : ''}
                </span>
              </div>
              {/* 买入 / 卖出日期都显示；没有就显示 —（R60–63 是先卖后买，买入日期本来就空） */}
              <div className="dates num">
                <span className={buyDateOf(r) === null ? 'missing' : undefined}>
                  买入 <b>{buyDateOf(r) ?? '—'}</b>
                </span>
                <span className="sep" aria-hidden />
                <span className={sellDateOf(r) === null ? 'missing' : undefined}>
                  卖出 <b>{sellDateOf(r) ?? '—'}</b>
                </span>
              </div>
              <div className="tag-row">
                {r.sell?.rebuyStatus === 'pending' && <Tag size="small" variant="soft" color="app-orange">待回补</Tag>}
                {r.sell?.sellBeforeBuy && <Tag size="small" variant="soft" color="app-teal">先卖后买</Tag>}
                {r.sell?.dateMissing && <Tag size="small" variant="soft" color="app-yellow">缺卖出日期</Tag>}
                {buyDateOf(r) === null && (r.lot !== null || r.rec.buyPriceCents !== null) && (
                  <Tag size="small" variant="soft" color="app-yellow">缺买入日期</Tag>
                )}
                {r.sell && r.sell.priceCents === null && <Tag size="small" variant="soft" color="app-red">缺价格</Tag>}
                {r.rec.editedAt && <Tag size="small" variant="soft" color="purple">改过</Tag>}
                {deleted && <Tag size="small" variant="soft" color="app-red">已删除</Tag>}
              </div>
            </Card>
          )
        })
      )}

      <p className="tiny muted" style={{ textAlign: 'center' }}>
        共 {visible.length} 行 · 合计盈利 {money(visible.reduce((a, r) => a + (r.sell?.profitCents ?? 0), 0))}
        {hiddenStockCount > 0 && stockFilter === 'all' && ` · 已隐藏 ${hiddenStockCount} 只停用股票`}
      </p>

      <Drawer
        open={current !== null}
        placement="bottom"
        height="84vh"
        title={
          current
            ? `${current.rec.stockName} · ${current.rec.origin === 'manual' ? '手动' : `第 ${current.rec.sourceRow} 行`} · #${nano.rowToId.get(current.rec.sourceRow)}`
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
                  <Button type="primary" style={{ flex: 1 }} onClick={() => setEditing(true)}>编辑</Button>
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
              <div className="form-grid">
                {EDITABLE.map((f) => (
                  <label key={f.key}>
                    <span>{f.label}</span>
                    <Input
                      value={draft[f.key]}
                      placeholder={f.kind === 'date' ? 'YYYY-MM-DD' : f.kind === 'qty' ? '股数' : '元'}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      data-field={f.key}
                    />
                  </label>
                ))}
                <p className="tiny muted" style={{ margin: 0 }}>
                  成交价由 E 列（目标售价）决定；成本优先取买入价，无批次时取 P 列。
                </p>
              </div>
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
                        placeholder="拆分价，如 9.20"
                        aria-label="拆分目标价"
                      />
                      <Input
                        className="grow"
                        value={tpQty}
                        onChange={(e) => setTpQty(e.target.value)}
                        placeholder="股数"
                        aria-label="拆分股数"
                      />
                      <Button
                        size="small"
                        onClick={() => {
                          if (!current.lot) return
                          const p = toCents(tpPrice)
                          const qn = Number(tpQty)
                          if (p === null || !Number.isFinite(qn) || qn <= 0) {
                            notificationOpen({ message: '拆分价和股数都要填', type: 'warning' })
                            return
                          }
                          void addExtraTarget(current.lot.id, p, qn).then(() => {
                            setTpPrice('')
                            setTpQty('')
                            notificationOpen({ message: '已拆分目标', description: '自动目标按剩余量缩减', type: 'success' })
                          })
                        }}
                      >
                        拆分
                      </Button>
                    </div>
                    <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                      分批止盈：手动目标先占份额，剩下的仍挂在 E 列价上；合计超过批次剩余会被截断并标红。
                    </p>
                  </div>
                )}

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
        <div className="stack tight">
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
              <Input
                value={form.date}
                placeholder="2026-10-23"
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                data-field="date"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入价' : '成交价'}</span>
              <Input
                value={form.price}
                placeholder={form.kind === 'buy' ? '8.01' : '8.58'}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                data-field="price"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入份额' : '卖出数量'}</span>
              <Input
                value={form.qty}
                placeholder="700"
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                data-field="qty"
              />
            </label>

            {form.kind === 'buy' ? (
              <label>
                <span>目标售价（可空，空则按「买入价 + 间隔」派生）</span>
                <Input
                  value={form.targetPrice ?? ''}
                  placeholder="8.58"
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
                    placeholder="留空则按优先级推导"
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
                      placeholder="8.30"
                      onChange={(e) => setForm({ ...form, buyPrice: e.target.value })}
                      data-field="buyPrice"
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <span>买入份额（选填）</span>
                    <Input
                      value={form.buyQty ?? ''}
                      placeholder="700"
                      onChange={(e) => setForm({ ...form, buyQty: e.target.value })}
                      data-field="buyQty"
                    />
                  </label>
                </div>
                <label>
                  <span>买入日期（选填）</span>
                  <Input
                    value={form.buyDate ?? ''}
                    placeholder="2026-10-22"
                    onChange={(e) => setForm({ ...form, buyDate: e.target.value })}
                    data-field="buyDate"
                  />
                </label>
              </>
            )}
            <p className="tiny muted" style={{ margin: 0 }}>
              手动新增的行号从 100000 起，不打乱 Excel 行号回溯。
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}

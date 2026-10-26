import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Input, Modal, Tag, notificationOpen } from 'animal-island-ui'
import { Select } from '../ui/Select'
import { useApp } from '../store/useApp'
import { activeStocks } from '../domain/stocks'
import { recordNoLabel, type RecordNoIndex } from '../domain/recordNo'
import { isHedgeable } from '../domain/hedge'
import { limitRange } from '../domain/limit'
import { toCents } from '../domain/money'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'
import { sandboxRowOf, type SandboxItem, type SandboxKind } from '../domain/sandbox'
import { mergeTargetRows, type TargetRow } from '../domain/merge'
import { buildNanoIdIndex } from '../ui/nanoid'
import { downloadText, toCsv } from '../ui/csv'
import { useFlashOnAppear } from '../ui/motion'
import { todayIso, money, price, qty, signedMoney, tone } from '../ui/format'
import { DateField } from '../ui/DateField'
import type { TradesQuery } from '../ui/nav'
import type { RebuyOrder } from '../domain/types'
import { HedgeSheet } from '../components/HedgeBinder'

/** 行内按钮不让冒泡到整行的「跳明细」点击上 */
function stopWith(fn: () => void) {
  return (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    fn()
  }
}

/** 从按股票记录的表里摘掉一只（返回新表，不改原表） */
function dropStock<T>(rec: Record<string, T>, stock: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const k of Object.keys(rec)) if (k !== stock) next[k] = rec[k]
  return next
}

/** 批次显示名：真实批次用「第 N 笔」；虚拟回补批次单独标注（V9.43） */
function lotLabel(lotId: string, index: RecordNoIndex): string {
  if (lotId.startsWith('lot:exec:')) return '回补批次'
  return recordNoLabel(Number(lotId.replace('lot:', '')), index)
}

export function OrdersPage({
  goTrades,
  goOverview,
}: {
  goTrades: (q: TradesQuery) => void
  goOverview?: () => void
}) {
  const {
    ledger,
    recordNo,
    stocks,
    executions,
    records,
    ordersSession,
    patchOrdersSession,
    recordRebuy,
    removeRebuy,
    setPlan,
    clearPlan,
    hedges,
    merges,
    plans,
    sandbox,
    sandboxLedger,
    sandboxPreviewRecords,
    setSandboxActive,
    addSandboxItem,
    removeSandboxItem,
    commitSandboxItem,
    clearSandbox,
  } = useApp()
  /** 点「裸卖待挂钩」标签打开的绑定弹层（V9.30；null = 关着） */
  const [hedgeRow, setHedgeRow] = useState<number | null>(null)
  /** 沙盒模拟行的挂钩弹层（只改模拟挂钩，不写库） */
  const [sandboxHedgeRow, setSandboxHedgeRow] = useState<number | null>(null)
  // 顺序与启停都跟随「管理 · 股票」
  const stockNames = useMemo(() => activeStocks(stocks).map((s) => s.name), [stocks])
  const { stockName } = ordersSession

  // 跳明细以 nanoId 定位（V9.4）：行级唯一 id，与明细页筛选同源
  const nano = useMemo(() => buildNanoIdIndex(records), [records])
  const idFor = (row: number | null | undefined): string | undefined =>
    row === null || row === undefined ? undefined : nano.rowToId.get(row)

  const effectiveStock = stockNames.includes(stockName) ? stockName : stockNames[0] ?? ''
  const cfg = stocks.find((s) => s.name === effectiveStock)
  // 昨收按股票记在会话里（V9.10）：切股再切回来，输入和确认结果都还在
  const lastClose = ordersSession.closes[effectiveStock] ?? ''
  const confirmedCents = ordersSession.confirmedCents[effectiveStock]
  const confirmed = confirmedCents != null ? { stock: effectiveStock, closeCents: confirmedCents } : null
  const ov = ordersSession.overrides[effectiveStock]
  const limitOverride = ov ? { stock: effectiveStock, up: ov.up, down: ov.down } : null

  const computedRange =
    confirmedCents != null
      ? limitRange(confirmedCents, cfg?.priceLimitType ?? 'unknown', cfg?.customLimitPct ?? null)
      : null

  // §10：涨跌停允许手工覆盖，只影响挂单页的区间判断，不改股票配置
  const [editingLimit, setEditingLimit] = useState(false)
  const [upText, setUpText] = useState('')
  const [downText, setDownText] = useState('')

  // V9.42：往下滑把吸顶设置收成一行摘要，回顶才展开。阈值留回差，避免在临界点反复收放
  // V9.44：收放是「文档高度变化」，必须禁用滚动锚定（styles.css）+ 动画过渡，
  // 否则浏览器补偿滚动会把 scrollY 拉回阈值内，收→放→收 连环触发（表现为顶部抽搐闪烁）
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const y = window.scrollY
        setCompact((wasCompact) => (wasCompact ? y > 24 : y > 96))
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const range =
    limitOverride && limitOverride.stock === effectiveStock
      ? { upCents: limitOverride.up, downCents: limitOverride.down, pct: computedRange?.pct ?? 0 }
      : computedRange

  /** 沙盒开启时看预览账本（真实 + 模拟条目 + 模拟挂钩）；关掉就是真实台账 */
  const view = sandbox.active ? sandboxLedger : ledger
  const previewRecords = sandbox.active ? sandboxPreviewRecords : records
  const targets = view.targets.filter((t) => t.stockName === effectiveStock)
  const orders = view.orders.filter((o) => o.stockName === effectiveStock)
  /** V9.37：刚记了回补成交的待买单闪一下——状态变了给个落点提示 */
  const justRebought = useFlashOnAppear(
    useMemo(() => orders.filter((o) => o.execQty > 0).map((o) => o.sourceRow), [orders]),
  )
  const summary = view.byStock.find((s) => s.stockName === effectiveStock)
  /** 模拟条目按预览行号索引（300000 段），用来标记「这是沙盒里的，不是真台账」 */
  const sandboxByRow = useMemo(() => {
    const m = new Map<number, SandboxItem>()
    for (const i of sandbox.items) m.set(sandboxRowOf(i), i)
    return m
  }, [sandbox.items])
  const sandboxCount = sandbox.items.filter((i) => i.stockName === effectiveStock).length
  /** 可挂钩 / 可改挂的裸卖：没买入批次、有卖出量、一次都没回补（与有没有待买订单无关，V9.32） */
  const nakedOpenRows = useMemo(() => {
    const execByRow = new Map<number, number>()
    for (const o of orders) execByRow.set(o.sourceRow, o.execQty)
    const set = new Set<number>()
    for (const r of previewRecords) {
      if (r.deletedAt || r.stockName !== effectiveStock) continue
      if (isHedgeable(r, execByRow.get(r.sourceRow) ?? 0)) set.add(r.sourceRow)
    }
    return set
  }, [orders, previewRecords, effectiveStock])

  const within = (p: number) => (range ? p >= range.downCents && p <= range.upCents : false)
  const zone = (p: number): '区间内' | '无区间' | '越界' => (range ? (within(p) ? '区间内' : '越界') : '无区间')

  /** V9.45：同价未卖完批次在提醒里合成一条（数量相加、日期取最早）；沙盒模拟行不合并 */
  const targetRows = useMemo(
    () =>
      mergeTargetRows({
        targets: view.targets.filter((t) => t.stockName === effectiveStock),
        lots: view.lots,
        merges,
        plans,
        sandboxRows: new Set(sandboxByRow.keys()),
      }),
    [view.targets, view.lots, effectiveStock, merges, plans, sandboxByRow],
  )

  const buyToday = range ? orders.filter((o) => within(o.rebuyPriceCents) && o.remainingQty > 0) : []
  const sellToday = range ? targetRows.filter((r) => within(r.priceCents)) : []
  const buyOut = range ? orders.filter((o) => !within(o.rebuyPriceCents) && o.remainingQty > 0).length : 0
  const sellOut = range ? targetRows.filter((r) => !within(r.priceCents)).length : 0
  const buyTodayAmount = buyToday.reduce((a, o) => a + o.rebuyPriceCents * o.remainingQty, 0)
  const sellTodayAmount = sellToday.reduce((a, r) => a + r.amountCents, 0)

  /** 待卖行的身份文案：合并行报「合并 N 笔 + 最早买入日期」，单笔行还是「第 N 笔 · 买入价」 */
  const sellRowLabel = (r: TargetRow) =>
    r.merged
      ? `合并 ${r.lotRows.length} 笔 · 买入 ${price(r.buyPriceCents)}${r.earliestBuyDate ? ` · 最早 ${r.earliestBuyDate}` : ''}`
      : `${lotLabel(r.targets[0].lotId, recordNo)} · 买入 ${price(r.buyPriceCents)}`
  /** 复制 / CSV 里的短标签 */
  const sellRowShort = (r: TargetRow) =>
    r.merged
      ? `合并 ${r.lotRows.length} 笔（${r.lotRows.map((row) => recordNoLabel(row, recordNo)).join(' + ')}）`
      : lotLabel(r.targets[0].lotId, recordNo)

  const rebuyTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * o.remainingQty, 0)
  const rewardTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * Math.max(0, o.rewardQty - o.doneRewardQty), 0)
  const targetTotal = targets.reduce((a, t) => a + t.amountCents, 0)
  const availableProfit = view.groups
    .filter((g) => g.stockId === (summary?.stockId ?? ''))
    .reduce((a, g) => a + g.availableCents, 0)

  // 记成交
  const [planRef, setPlanRef] = useState<{
    kind: 'buy' | 'sell'
    refId: string
    title: string
    suggestPrice: number
  } | null>(null)
  const [planPrice, setPlanPrice] = useState('')
  const [planQty, setPlanQty] = useState('')

  // 记成交
  const [execOrder, setExecOrder] = useState<RebuyOrder | null>(null)
  const [execQty, setExecQty] = useState('')
  const [execPrice, setExecPrice] = useState('')
  const [execReward, setExecReward] = useState('')

  // 沙盒：新增模拟待买 / 待卖（只活在内存，刷新即清空）
  const [sbKind, setSbKind] = useState<SandboxKind | null>(null)
  const [sbDate, setSbDate] = useState(todayIso())
  const [sbPrice, setSbPrice] = useState('')
  const [sbQty, setSbQty] = useState('100')
  const [sbExtra, setSbExtra] = useState('')
  const [committing, setCommitting] = useState<string | null>(null)

  function openPlan(kind: 'buy' | 'sell', refId: string, title: string, suggestPrice: number, planPriceCents?: number | null, planQtyValue?: number | null) {
    setPlanRef({ kind, refId, title, suggestPrice })
    setPlanPrice((planPriceCents ?? suggestPrice) === 0 ? '' : ((planPriceCents ?? suggestPrice) / 100).toFixed(2))
    setPlanQty(planQtyValue ? String(planQtyValue) : '')
  }

  async function savePlan() {
    if (!planRef) return
    try {
      const p = toCents(planPrice)
      const q = Number(planQty)
      if (p === null) throw new Error('计划价不合法')
      if (!Number.isFinite(q) || q <= 0) throw new Error('计划量要填正整数')
      await setPlan(planRef.kind, planRef.refId, p, q)
      setPlanRef(null)
      notificationOpen({ message: '计划已保存', description: '只影响显示与导出，不动真实成交', type: 'success' })
    } catch (e) {
      notificationOpen({ message: '保存失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  function openExec(o: RebuyOrder) {
    setExecOrder(o)
    setExecQty(String(o.remainingQty))
    setExecPrice((o.rebuyPriceCents / 100).toFixed(2))
    setExecReward(String(Math.max(0, o.rewardQty - o.doneRewardQty)))
  }

  async function saveExec() {
    if (!execOrder) return
    try {
      const q = Number(execQty)
      const p = toCents(execPrice)
      const r = Number(execReward || 0)
      if (!Number.isFinite(q) || q <= 0) throw new Error('股数要填正整数')
      if (p === null) throw new Error('回补价不合法')
      if (!Number.isFinite(r) || r < 0) throw new Error('奖励股数不合法')
      await recordRebuy(execOrder, q, p, r)
      setExecOrder(null)
      notificationOpen({
        message: '已记回补成交',
        description: execOrder.exposure
          ? `${q} 股 @ ${execPrice}，敞口减少，已生成回补批次进待卖`
          : `${q} 股 @ ${execPrice}，已生成回补批次进待卖`,
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '记录失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function undoExec(orderId: string) {
    const list = executions.filter((e) => e.orderId === orderId).sort((a, b) => b.at - a.at)
    const last = list[0]
    if (!last) return
    if (!window.confirm(`撤销最后一笔回补成交（${last.qty} 股 @ ${(last.priceCents / 100).toFixed(2)}）？`)) return
    await removeRebuy(last.id)
    notificationOpen({ message: '已撤销', type: 'info' })
  }

  function openSandboxForm(kind: SandboxKind) {
    const step = cfg?.intervalCents ?? 0
    setSbKind(kind)
    setSbDate(todayIso())
    setSbPrice(confirmedCents != null ? (confirmedCents / 100).toFixed(2) : '')
    setSbQty('100')
    setSbExtra(
      confirmedCents == null || step <= 0
        ? ''
        : kind === 'sell'
          ? confirmedCents - step > 0
            ? ((confirmedCents - step) / 100).toFixed(2)
            : ''
          : ((confirmedCents + step) / 100).toFixed(2),
    )
  }

  function saveSandboxForm() {
    if (!sbKind) return
    const serial = isoToSerial(sbDate)
    const p = toCents(sbPrice)
    const q = Number(sbQty)
    const extraText = sbExtra.trim()
    const extra = extraText === '' ? null : toCents(extraText)
    try {
      if (serial === null) throw new Error('日期写成 YYYY-MM-DD，或点日历选')
      if (p === null || p <= 0) throw new Error('价格要填大于 0 的数')
      if (!Number.isInteger(q) || q <= 0) throw new Error('股数要填正整数')
      if (extraText !== '' && (extra === null || extra <= 0)) {
        throw new Error(sbKind === 'sell' ? '回补价要填大于 0 的数' : '目标售价要填大于 0 的数')
      }
      addSandboxItem({
        kind: sbKind,
        stockName: effectiveStock,
        date: serialToIso(serial) ?? sbDate,
        priceCents: p,
        qty: q,
        targetPriceCents: sbKind === 'buy' ? extra : null,
        rebuyPriceCents: sbKind === 'sell' ? extra : null,
      })
      notificationOpen({
        message: '已加入沙盒',
        description:
          sbKind === 'sell'
            ? '模拟待买只用于预演；点右侧「记为成交」才写进明细'
            : '模拟待卖只用于预演；点右侧「记为成交」才写进明细',
        type: 'success',
      })
      setSbKind(null)
    } catch (e) {
      notificationOpen({ message: '加不进沙盒', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function commitSandbox(item: SandboxItem) {
    if (committing) return
    setCommitting(item.id)
    try {
      const res = await commitSandboxItem(item.id)
      if (res) {
        notificationOpen({
          message: '已记为成交',
          description: `已写入明细（第 ${recordNo.total + res.committed} 笔）${
            res.committed > 1 ? `，连同 ${res.committed - 1} 笔模拟批次一起转正` : ''
          }`,
          type: 'success',
        })
      }
    } catch (e) {
      notificationOpen({ message: '记为成交失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setCommitting(null)
    }
  }

  function removeSandbox(item: SandboxItem) {
    removeSandboxItem(item.id)
    notificationOpen({ message: '已从沙盒移除', type: 'info' })
  }

  function confirmClose() {
    const cents = toCents(lastClose)
    if (cents === null || cents <= 0) {
      notificationOpen({ message: '先填昨收价', description: '比如 8.10', type: 'warning' })
      return
    }
    if (!cfg || cfg.priceLimitType === 'unknown') {
      notificationOpen({
        message: '这只票没设涨跌幅',
        description: '去「管理 · 股票」设好再来算区间',
        type: 'warning',
      })
      return
    }
    // 昨收按股票记在会话（V9.10）：切股 / 切页 / 刷新都保留，关标签页才清
    patchOrdersSession({
      closes: { ...ordersSession.closes, [effectiveStock]: lastClose },
      confirmedCents: { ...ordersSession.confirmedCents, [effectiveStock]: cents },
      overrides: dropStock(ordersSession.overrides, effectiveStock),
    })
    setEditingLimit(false)
  }

  function copyList() {
    const lines: string[] = [`${effectiveStock} 挂单清单${sandbox.active ? '（沙盒预览）' : ''}`]
    if (range && confirmed && confirmed.stock === effectiveStock) {
      lines.push(
        `昨收 ${(confirmed.closeCents / 100).toFixed(2)} · 区间 ${(range.downCents / 100).toFixed(2)}~${(range.upCents / 100).toFixed(2)}`,
      )
    }
    if (buyToday.length) {
      lines.push('【今日可挂买】')
      for (const o of buyToday) {
        lines.push(`  ${recordNoLabel(o.sourceRow, recordNo)}  ${price(o.planPriceCents ?? o.rebuyPriceCents)} × ${o.planQty ?? o.remainingQty} 股`)
      }
    }
    if (sellToday.length) {
      lines.push('【今日可挂卖】')
      for (const r of sellToday) {
        lines.push(`  ${sellRowShort(r)}  ${price(r.planPriceCents ?? r.priceCents)} × ${r.planQty ?? r.qty} 股`)
      }
    }
    if (!range) {
      lines.push('（未确认昨收价，以下是全部待买/待卖）')
      for (const o of orders) lines.push(`  待买 ${price(o.rebuyPriceCents)} × ${o.remainingQty}`)
      for (const r of targetRows) lines.push(`  待卖 ${sellRowShort(r)} ${price(r.priceCents)} × ${r.qty}`)
    }
    void navigator.clipboard?.writeText(lines.filter(Boolean).join('\n'))
    notificationOpen({ message: '清单已复制', type: 'success' })
  }

  function exportCsv() {
    const rows: (string | number)[][] = [['类型', '序号', '价格', '股数', '金额', '区间']]
    for (const o of orders) {
      const p = o.planPriceCents ?? o.rebuyPriceCents
      const q = o.planQty ?? o.remainingQty
      const sim = sandboxByRow.has(o.sourceRow)
      rows.push([
        sim ? '待买（模拟）' : '待买',
        recordNoLabel(o.sourceRow, recordNo),
        price(p),
        q,
        ((p * q) / 100).toFixed(2),
        zone(p),
      ])
    }
    for (const r of targetRows) {
      const p = r.planPriceCents ?? r.priceCents
      const q = r.planQty ?? r.qty
      rows.push([
        r.sandbox ? '待卖（模拟）' : '待卖',
        sellRowShort(r),
        price(p),
        q,
        ((p * q) / 100).toFixed(2),
        zone(p),
      ])
    }
    downloadText(`${effectiveStock}-挂单清单.csv`, toCsv(rows), 'text/csv;charset=utf-8')
  }

  if (stockNames.length === 0) {
    return (
      <Card>
        <div className="empty-box">
          <strong>没有启用的股票</strong>
          去「管理 · 股票」打开启用开关，或先导入数据。
        </div>
      </Card>
    )
  }

  if (!sandbox.active && ledger.targets.length === 0 && ledger.orders.length === 0) {
    return (
      <Card>
        <div className="empty-box">
          <strong>没有可挂的单</strong>
          先去「管理 · 导入」把交易记录写进本地；想先预演，可以打开页面右上角的「沙盒」。
        </div>
      </Card>
    )
  }

  return (
    <div className="stack">
      <div className={`page-sticky orders-sticky${compact ? ' is-compact' : ''}`} data-sticky="orders">
      <div className="orders-compact-slot" aria-hidden={!compact}>
        <div className="orders-compact-inner">
          <button
            type="button"
            className="orders-compact"
            data-testid="orders-compact"
            tabIndex={compact ? 0 : -1}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            aria-label="回到顶部展开挂单设置"
          >
            <span className="oc-stock">{effectiveStock || '未选股'}</span>
            <span className="oc-piece">昨收 <b>{confirmed ? price(confirmed.closeCents) : lastClose.trim() || '—'}</b></span>
            {range ? (
              <>
                <span className="oc-piece oc-up">涨停 <b>{price(range.upCents)}</b></span>
                <span className="oc-piece oc-down">跌停 <b>{price(range.downCents)}</b></span>
              </>
            ) : (
              <span className="oc-piece oc-muted">涨跌停未确认</span>
            )}
            {sandbox.active && <span className="oc-chip">沙盒</span>}
            <span className="oc-expand" aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
      <div className="orders-setup-collapse">
        <div className="orders-setup-collapse-inner">
      <div className="orders-setup">
      <div className="page-title">
        <h2>挂单</h2>
        <div className="row" style={{ gap: 6 }}>
          <Button
            size="small"
            type={sandbox.active ? 'primary' : 'default'}
            data-sandbox-toggle
            onClick={() => {
              setSandboxActive(!sandbox.active)
              setSandboxHedgeRow(null)
            }}
          >
            {sandbox.active ? '退出沙盒' : '沙盒'}
          </Button>
          <Button size="small" onClick={copyList}>复制</Button>
          <Button size="small" onClick={exportCsv}>CSV</Button>
        </div>
      </div>

      {/* 0. 沙盒预览条：模拟条目只改这里的数字与概览图，不动真实台账 */}
      {sandbox.active && (
        <Card className="sandbox-panel" data-testid="sandbox-panel">
          <div className="sec-head">
            <strong>沙盒预览</strong>
            <Tag size="small" variant="soft" color="purple">未写库</Tag>
            <div className="spacer" />
            {goOverview && (
              <Button size="small" onClick={goOverview}>去概览看树</Button>
            )}
            <Button size="small" onClick={clearSandbox}>清空模拟</Button>
          </div>
          <div className="grid-4 metric-strip two-col">
            <div>
              <div className="k">已实现盈利</div>
              <div className={`v money ${tone(summary?.profitCents ?? 0)}`} data-sandbox-metric="profit">
                {signedMoney(summary?.profitCents ?? 0)}
              </div>
            </div>
            <div>
              <div className="k">理想可卖到</div>
              <div className="v money" data-sandbox-metric="max">
                {summary?.targetMaxPriceCents != null ? `${price(summary.targetMaxPriceCents)} 元` : '—'}
              </div>
            </div>
            <div>
              <div className="k">理想剩余可赚</div>
              <div className={`v money ${tone(summary?.expectProfitCents ?? 0)}`} data-sandbox-metric="expect">
                {signedMoney(summary?.expectProfitCents ?? 0)}
              </div>
            </div>
            <div>
              <div className="k">模拟条目</div>
              <div className="v" data-sandbox-metric="count">{sandboxCount}</div>
            </div>
          </div>
          <p className="tiny muted" style={{ margin: '8px 0 0' }}>
            自动给出的待买/待卖也一起算进沙盒：加几条模拟单、再和真实/模拟买单挂钩，就能看到
            已实现盈利、理想可卖到和剩余可赚怎么变。只有点每行右侧「记为成交」才写进明细，
            其余刷新即清空。
          </p>
        </Card>
      )}

      {/* 1. 选股 + 昨收 + 确认 */}
      <Card>
        <div className="stack tight">
          <Select
            options={stockNames.map((s) => ({ key: s, label: s }))}
            value={effectiveStock}
            onChange={(v) => {
              // 数据都按股票记，切股只动 stockName；回来时昨收 / 确认 / 手工区间都还在
              patchOrdersSession({ stockName: v })
              setEditingLimit(false)
            }}
            aria-label="选择股票"
          />
          <div className="row nowrap">
            <Input
              className="grow"
              value={lastClose}
              onChange={(e) => {
                patchOrdersSession({
                  closes: { ...ordersSession.closes, [effectiveStock]: e.target.value },
                  confirmedCents: dropStock(ordersSession.confirmedCents, effectiveStock),
                  overrides: dropStock(ordersSession.overrides, effectiveStock),
                })
                setEditingLimit(false)
              }}
              placeholder="昨收价，如 8.10"
              allowClear
              onClear={() => {
                patchOrdersSession({
                  closes: { ...ordersSession.closes, [effectiveStock]: '' },
                  confirmedCents: dropStock(ordersSession.confirmedCents, effectiveStock),
                  overrides: dropStock(ordersSession.overrides, effectiveStock),
                })
                setEditingLimit(false)
              }}
              aria-label="昨收价"
            />
            <Button type="primary" data-action="confirm-close" onClick={confirmClose}>确认</Button>
          </div>

          {/* V9.13：涨跌幅档位是配置细节、确认引导是自明的——都不再占界面；有区间才显示这一行 */}
          {range && (
            <div className="row divider-top" style={{ gap: 6 }}>
              <span data-tag="limit-up">
                <Tag size="medium" variant="soft" color="app-red">涨停价 {price(range.upCents)}</Tag>
              </span>
              <span data-tag="limit-down">
                <Tag size="medium" variant="soft" color="app-green">跌停价 {price(range.downCents)}</Tag>
              </span>
              {limitOverride && limitOverride.stock === effectiveStock ? (
                <>
                  <Tag size="small" variant="soft" color="purple" data-tag="limit-manual">手工区间</Tag>
                  <Button
                    size="small"
                    type="text"
                    onClick={() => {
                      patchOrdersSession({ overrides: dropStock(ordersSession.overrides, effectiveStock) })
                      setEditingLimit(false)
                      notificationOpen({ message: '已回到按涨跌幅算的区间', type: 'info' })
                    }}
                  >
                    恢复
                  </Button>
                </>
              ) : (
                <Button
                  size="small"
                  type="text"
                  onClick={() => {
                    setUpText(price(range.upCents))
                    setDownText(price(range.downCents))
                    setEditingLimit(true)
                  }}
                >
                  手工调整
                </Button>
              )}
            </div>
          )}

          {editingLimit && range && (
            <div className="stack tight divider-top">
              <div className="row nowrap" style={{ gap: 6 }}>
                <Input
                  className="grow"
                  value={downText}
                  onChange={(e) => setDownText(e.target.value)}
                  placeholder="跌停价"
                  aria-label="手工跌停价"
                />
                <span className="tiny muted">~</span>
                <Input
                  className="grow"
                  value={upText}
                  onChange={(e) => setUpText(e.target.value)}
                  placeholder="涨停价"
                  aria-label="手工涨停价"
                />
              </div>
              <div className="row nowrap" style={{ gap: 6 }}>
                <Button
                  size="small"
                  type="primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const up = toCents(upText)
                    const down = toCents(downText)
                    if (up === null || down === null || up <= 0 || down <= 0) {
                      notificationOpen({ message: '两个价都要填正数', type: 'warning' })
                      return
                    }
                    if (down >= up) {
                      notificationOpen({ message: '跌停价要低于涨停价', type: 'warning' })
                      return
                    }
                    patchOrdersSession({
                      overrides: { ...ordersSession.overrides, [effectiveStock]: { up, down } },
                    })
                    setEditingLimit(false)
                    notificationOpen({ message: '已按手工区间挂单', description: '只影响本页判断，不改股票配置', type: 'success' })
                  }}
                >
                  应用
                </Button>
                <Button size="small" onClick={() => setEditingLimit(false)}>取消</Button>
              </div>
            </div>
          )}
        </div>
      </Card>
      </div>
      </div>
      </div>
      </div>

      {/* 2. 今日挂单 */}
      <Card>
        <div className="sec-head">
          <strong>今日挂单</strong>
          {range && (
            <>
              <Tag size="small" variant="soft" color="app-teal">可挂买 {buyToday.length}</Tag>
              <Tag size="small" variant="soft" color="app-orange">可挂卖 {sellToday.length}</Tag>
            </>
          )}
          <div className="spacer" />
          <span className="sec-sub">{effectiveStock}</span>
        </div>

        {!range ? (
          <div className="empty-box">填昨收价并点「确认」后，这里列出今天价格区间内能挂的单</div>
        ) : (
          <>
            <div className="grid-4 metric-strip two-col" style={{ marginBottom: 10 }}>
              <div>
                <div className="k">可挂买</div>
                <div className="v">{money(buyTodayAmount)}</div>
              </div>
              <div>
                <div className="k">可挂卖</div>
                <div className="v">{money(sellTodayAmount)}</div>
              </div>
              <div>
                <div className="k">越界</div>
                <div className="v" style={{ color: buyOut + sellOut > 0 ? 'var(--up)' : undefined }}>
                  {buyOut + sellOut}
                </div>
              </div>
              <div>
                <div className="k">可分配</div>
                <div className="v">{money(availableProfit)}</div>
              </div>
            </div>

            {buyToday.length === 0 && sellToday.length === 0 ? (
              <div className="empty-box">这个区间里没有可挂的单（{buyOut} 买 / {sellOut} 卖 越界）</div>
            ) : (
              <>
                {buyToday.length > 0 && (
                  <>
                    <div className="group-label">可挂买 · {buyToday.length} 条</div>
                    <div className="data-block">
                      {buyToday.map((o) => {
                        const sim = sandboxByRow.get(o.sourceRow)
                        return (
                          <div
                            key={`t-${o.id}`}
                            // V9.29.1：左侧状态边框（蓝=买 / 红=卖），与明细页 trade-item 同一套语义
                            className={`line wrap-row pending-buy ${sim ? 'sandbox-row' : 'clickable'}`}
                            data-row={o.sourceRow}
                            data-sandbox-row={sim ? o.sourceRow : undefined}
                            onClick={sim ? undefined : () => goTrades({ id: idFor(o.sourceRow), stock: o.stockName })}
                          >
                            <div className="left">
                              <div className="t1 num">
                                {sim && <span className="sandbox-mark">模拟 · </span>}
                                买 {price(o.rebuyPriceCents)} × {qty(o.remainingQty)}
                              </div>
                              <div className="t2">
                                {sim ? `沙盒模拟单 · 计划 ${o.baseQty} 股` : `${recordNoLabel(o.sourceRow, recordNo)} · 计划 ${o.baseQty}`}
                                {o.rewardQty > 0 && ` · 含奖励 ${o.rewardQty}`}
                                {o.execQty > 0 && ` · 已回补 ${o.execQty}`}
                              </div>
                              {o.planPriceCents != null && (
                                <div className="tag-row" style={{ marginTop: 4 }}>
                                  <Tag size="small" variant="soft" color="purple">
                                    计划 {price(o.planPriceCents)} × {qty(o.planQty ?? o.remainingQty)}
                                  </Tag>
                                </div>
                              )}
                            </div>
                            <div className="right num" style={{ fontWeight: 600 }}>
                              {money(o.rebuyPriceCents * o.remainingQty)}
                            </div>
                            <div className="acts">
                              {sim ? (
                                <>
                                  <Button
                                    size="small"
                                    type="primary"
                                    data-action="sandbox-commit"
                                    disabled={committing === sim.id}
                                    onClick={stopWith(() => void commitSandbox(sim))}
                                  >
                                    记为成交
                                  </Button>
                                  <Button size="small" onClick={stopWith(() => removeSandbox(sim))}>删除</Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    size="small"
                                    onClick={stopWith(() => openPlan('buy', o.id, `买 ${o.stockName}`, o.rebuyPriceCents, o.planPriceCents, o.planQty))}
                                  >
                                    计划
                                  </Button>
                                  <Button size="small" onClick={stopWith(() => openExec(o))}>记成交</Button>
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}

                {sellToday.length > 0 && (
                  <>
                    <div className="group-label">可挂卖 · {sellToday.length} 条</div>
                    <div className="data-block">
                      {sellToday.map((r) => {
                        const sim = sandboxByRow.get(r.anchorRow)
                        return (
                          <div
                            key={`s-${r.key}`}
                            className={`line wrap-row pending-sell ${sim ? 'sandbox-row' : 'clickable'}`}
                            data-row={r.anchorRow}
                            data-merge-group={r.merged ? r.key : undefined}
                            data-sandbox-row={sim ? r.anchorRow : undefined}
                            onClick={
                              sim
                                ? undefined
                                : () =>
                                    goTrades({
                                      id: idFor(r.anchorRow),
                                      stock: r.targets[0].stockName,
                                    })
                            }
                          >
                            <div className="left">
                              <div className="t1 num">
                                {sim && <span className="sandbox-mark">模拟 · </span>}
                                {r.merged && <span className="merge-mark">合并 · </span>}
                                卖 {price(r.priceCents)} × {qty(r.qty)}
                              </div>
                              <div className="t2">
                                {r.merged
                                  ? `${sellRowLabel(r)} · 预期 ${signedMoney(r.expectProfitCents)}`
                                  : `${sim ? '沙盒模拟批次' : lotLabel(r.targets[0].lotId, recordNo)} · 预期 ${signedMoney(r.expectProfitCents)}`}
                              </div>
                              {r.planPriceCents != null && (
                                <div className="tag-row" style={{ marginTop: 4 }}>
                                  <Tag size="small" variant="soft" color="purple">
                                    计划 {price(r.planPriceCents)} × {qty(r.planQty ?? r.qty)}
                                  </Tag>
                                </div>
                              )}
                            </div>
                            <div className="right num" style={{ fontWeight: 600 }}>
                              {money(r.amountCents)}
                            </div>
                            <div className="acts">
                              {sim ? (
                                <>
                                  <Button
                                    size="small"
                                    type="primary"
                                    data-action="sandbox-commit"
                                    disabled={committing === sim.id}
                                    onClick={stopWith(() => void commitSandbox(sim))}
                                  >
                                    记为成交
                                  </Button>
                                  <Button size="small" onClick={stopWith(() => removeSandbox(sim))}>删除</Button>
                                </>
                              ) : (
                                <Button
                                  size="small"
                                  onClick={stopWith(() =>
                                    openPlan(
                                      'sell',
                                      r.key,
                                      `卖 ${r.targets[0].stockName}`,
                                      r.priceCents,
                                      r.planPriceCents,
                                      r.planQty ?? (r.merged ? r.qty : null),
                                    ),
                                  )}
                                >
                                  计划
                                </Button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </Card>

      {/* 3. 待买（常驻，不藏页签，§04） */}
      <Card>
        <div className="sec-head">
          <strong>待买</strong>
          <Tag size="small" variant="soft" color="purple">{orders.length} 条</Tag>
          <div className="spacer" />
          {sandbox.active && (
            <Button size="small" type="text" data-action="sandbox-add-sell" onClick={() => openSandboxForm('sell')}>
              ＋ 模拟待买
            </Button>
          )}
        </div>
        {orders.length === 0 ? (
          <div className="empty-box">
            {sandbox.active ? '该股没有待买单，点右上「＋ 模拟待买」加一条' : '该股没有待买单'}
          </div>
        ) : (
          <div className="data-block">
            {orders.map((o) => {
              const z = zone(o.rebuyPriceCents)
              const sim = sandboxByRow.get(o.sourceRow)
              const link = sim
                ? sandbox.hedges.find((h) => h.sellRow === o.sourceRow)
                : hedges.find((h) => h.sellRow === o.sourceRow)
              return (
                <div
                  key={o.id}
                  className={`line ${sim ? 'sandbox-row' : 'clickable'}`}
                  data-row={o.sourceRow}
                  data-sandbox-row={sim ? o.sourceRow : undefined}
                  data-anim={justRebought.has(o.sourceRow) ? 'done' : undefined}
                  onClick={sim ? undefined : () => goTrades({ id: idFor(o.sourceRow), stock: o.stockName })}
                >
                  <div className="left">
                    <div className="t1 num">
                      {sim && <span className="sandbox-mark">模拟 · </span>}
                      {price(o.rebuyPriceCents)}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                        {' '}× {qty(o.remainingQty)} 股
                      </span>
                      {o.remainingQty === 0 && (
                        <Tag size="small" variant="soft" color="app-green" style={{ marginLeft: 6 }}>已回补完</Tag>
                      )}
                    </div>
                    <div className="t2">
                      {sim ? `沙盒模拟单 · 计划 ${o.baseQty}` : `${recordNoLabel(o.sourceRow, recordNo)} · 计划 ${o.baseQty}`}
                      {o.rewardQty > 0 && ` + 奖励 ${o.rewardQty}`}
                      {o.execQty > 0 && ` · 已回补 ${o.execQty}`}
                      {/* V9.33：这笔卖已挂到高位买单上，那这张买入单其实可以撤（买了也会自动解挂） */}
                      {link && !sim && ' · 已挂高位，这张买单可撤'}
                      {sim ? ' · 只用于沙盒预览' : ` · 组池 ${money(o.grossProfitCents)} / ${o.hands} 手`}
                    </div>
                    <div className="tag-row" style={{ marginTop: 4 }}>
                      <Tag size="small" variant="soft" color={o.exposure ? 'app-red' : 'app-teal'}>
                        {o.exposure ? '空头敞口' : '回补再买入'}
                      </Tag>
                      <Tag
                        size="small"
                        variant="soft"
                        color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}
                      >
                        {z}
                      </Tag>
                      {!sim && o.execQty > 0 && (
                        <Button size="small" type="text" onClick={stopWith(() => void undoExec(o.id))}>撤销最后一笔</Button>
                      )}
                      {/* V9.30 裸卖待挂钩：还没回补的裸卖，点一下就能挂到未完成买单上 */}
                      {sim ? (
                        <>
                          <Tag
                            size="small"
                            variant="soft"
                            color={link ? 'app-teal' : 'app-yellow'}
                            onClick={stopWith(() => setSandboxHedgeRow(o.sourceRow))}
                            className="hedge-entry"
                            data-sandbox-hedge={o.sourceRow}
                          >
                            {link ? '模拟已挂钩 · 改挂' : '模拟待挂钩'}
                          </Tag>
                          <Button
                            size="small"
                            type="primary"
                            data-action="sandbox-commit"
                            disabled={committing === sim.id}
                            onClick={stopWith(() => void commitSandbox(sim))}
                          >
                            记为成交
                          </Button>
                          <Button size="small" type="text" onClick={stopWith(() => removeSandbox(sim))}>删除</Button>
                        </>
                      ) : (
                        nakedOpenRows.has(o.sourceRow) && (
                          <Tag
                            size="small"
                            variant="soft"
                            color={link ? 'app-teal' : 'app-yellow'}
                            onClick={stopWith(() => setHedgeRow(o.sourceRow))}
                            className="hedge-entry"
                          >
                            {link ? '已挂钩 · 改挂' : '裸卖待挂钩'}
                          </Tag>
                        )
                      )}
                    </div>
                  </div>
                  <div className="right num" style={{ fontWeight: 600 }}>
                    {money(o.rebuyPriceCents * o.remainingQty)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          待买剩余 {money(rebuyTotal)}（其中奖励 {money(rewardTotal)}） · 待补敞口{' '}
          {qty(summary?.exposureQty ?? 0)} 股
        </p>
      </Card>

      {/* 4. 待卖（常驻） */}
      <Card>
        <div className="sec-head">
          <strong>待卖</strong>
          <Tag size="small" variant="soft" color="app-teal">{targetRows.length} 条</Tag>
          <div className="spacer" />
          {sandbox.active && (
            <Button size="small" type="text" data-action="sandbox-add-buy" onClick={() => openSandboxForm('buy')}>
              ＋ 模拟待卖
            </Button>
          )}
        </div>
        {targetRows.length === 0 ? (
          <div className="empty-box">
            {sandbox.active ? '该股批次已全部卖完，点右上「＋ 模拟待卖」加一笔' : '该股批次已全部卖完'}
          </div>
        ) : (
          <div className="data-block">
            {targetRows.map((r) => {
              const z = zone(r.priceCents)
              const sim = sandboxByRow.get(r.anchorRow)
              return (
                <div
                  key={r.key}
                  className={`line ${sim ? 'sandbox-row' : 'clickable'}`}
                  data-row={r.anchorRow}
                  data-merge-group={r.merged ? r.key : undefined}
                  data-sandbox-row={sim ? r.anchorRow : undefined}
                  onClick={
                    sim
                      ? undefined
                      : () =>
                          goTrades({
                            id: idFor(r.anchorRow),
                            stock: r.targets[0].stockName,
                          })
                  }
                >
                  <div className="left">
                    <div className="t1 num">
                      {sim && <span className="sandbox-mark">模拟 · </span>}
                      {r.merged && <span className="merge-mark">合并 · </span>}
                      {price(r.priceCents)}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> × {qty(r.qty)} 股</span>
                    </div>
                    <div className="t2">
                      {sim ? '沙盒模拟批次' : sellRowLabel(r)}
                    </div>
                    <div className="tag-row" style={{ marginTop: 4 }}>
                      <Tag
                        size="small"
                        variant="soft"
                        color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}
                      >
                        {z}
                      </Tag>
                      {r.merged && (
                        <Tag size="small" variant="soft" color="purple">同价 {r.lotRows.length} 笔</Tag>
                      )}
                      {sim && (
                        <>
                          <Button
                            size="small"
                            type="primary"
                            data-action="sandbox-commit"
                            disabled={committing === sim.id}
                            onClick={stopWith(() => void commitSandbox(sim))}
                          >
                            记为成交
                          </Button>
                          <Button size="small" type="text" onClick={stopWith(() => removeSandbox(sim))}>删除</Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="right">
                    <div className="num" style={{ fontWeight: 600 }}>{money(r.amountCents)}</div>
                    <div className="tiny up num">{signedMoney(r.expectProfitCents)}</div>
                  </div>
                </div>
              )
            })}
            <div className="line">
              <div className="left t1">合计</div>
              <div className="right num" style={{ fontWeight: 600 }}>
                {money(targetTotal)}
                <div className="tiny up num">{signedMoney(targetRows.reduce((a, r) => a + r.expectProfitCents, 0))}</div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {summary && summary.exposureQty > 0 && (
        <Card>
          <p className="hint-block" style={{ margin: 0 }}>
            <b>敞口提示：</b>{summary.stockName} 可卖 {qty(summary.targetQty)} 股，净持仓 {qty(summary.netQty)} 股。
            待卖全部执行完，还会有 <b style={{ color: 'var(--up)' }}>{qty(summary.exposureQty)} 股</b> 需要通过待买回补
            ——这部分不是持仓，是在加空。
          </p>
        </Card>
      )}

      <Modal
        open={planRef !== null}
        title="挂单计划"
        typewriter={false}
        onClose={() => setPlanRef(null)}
        footer={
          <div className="row nowrap" style={{ gap: 8 }}>
            <Button type="primary" style={{ flex: 1 }} onClick={() => void savePlan()}>保存</Button>
            <Button onClick={() => setPlanRef(null)}>取消</Button>
          </div>
        }
      >
        {planRef && (
          <div className="stack tight">
            <p className="hint-block" style={{ margin: 0 }}>
              {planRef.title} · 建议 {price(planRef.suggestPrice)}。计划价只用于显示和导出，
              <b>不参与盈亏、清单与守恒式的任何计算</b>。
            </p>
            <div className="form-grid">
              <label>
                <span>计划价</span>
                <Input value={planPrice} onChange={(e) => setPlanPrice(e.target.value)} data-field="planPrice" />
              </label>
              <label>
                <span>计划量（股）</span>
                <Input value={planQty} onChange={(e) => setPlanQty(e.target.value)} data-field="planQty" />
              </label>
            </div>
            <Button
              size="small"
              onClick={() => {
                if (!planRef) return
                void clearPlan(planRef.refId).then(() => {
                  setPlanRef(null)
                  notificationOpen({ message: '已清除计划', type: 'info' })
                })
              }}
            >
              清除这个计划
            </Button>
          </div>
        )}
      </Modal>

      <Modal
        open={execOrder !== null}
        title="记回补成交"
        typewriter={false}
        onClose={() => setExecOrder(null)}
        footer={
          <div className="row nowrap" style={{ gap: 8 }}>
            <Button type="primary" style={{ flex: 1 }} onClick={() => void saveExec()}>保存</Button>
            <Button onClick={() => setExecOrder(null)}>取消</Button>
          </div>
        }
      >
        {execOrder && (
          <div className="stack tight">
            <p className="hint-block" style={{ margin: 0 }}>
              {execOrder.stockName} · {recordNoLabel(execOrder.sourceRow, recordNo)} · 计划 {execOrder.baseQty}
              {execOrder.rewardQty > 0 && ` + 奖励 ${execOrder.rewardQty}`} 股，还能回补 {execOrder.remainingQty} 股。
            </p>
            <div className="form-grid">
              <label>
                <span>本次回补股数</span>
                <Input value={execQty} onChange={(e) => setExecQty(e.target.value)} data-field="execQty" />
              </label>
              <label>
                <span>成交价</span>
                <Input value={execPrice} onChange={(e) => setExecPrice(e.target.value)} data-field="execPrice" />
              </label>
              <label>
                <span>其中奖励股数（已成交不可撤）</span>
                <Input value={execReward} onChange={(e) => setExecReward(e.target.value)} data-field="execReward" />
              </label>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              回补成交会平掉空头敞口，并按「成交价 + 该股间隔」自动生成一笔可卖批次（回到待卖）。
              这笔卖如果挂着高位买单，成交后绑定自动解除，先卖 + 后买就是一笔正常完成的订单。
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={sbKind !== null}
        title={sbKind === 'sell' ? '模拟一笔待买（先卖后买）' : '模拟一笔待卖（假设买入）'}
        typewriter={false}
        onClose={() => setSbKind(null)}
        footer={
          <div className="row nowrap" style={{ gap: 8 }}>
            <Button type="primary" style={{ flex: 1 }} data-action="sandbox-save" onClick={saveSandboxForm}>
              加到沙盒
            </Button>
            <Button onClick={() => setSbKind(null)}>取消</Button>
          </div>
        }
      >
        {sbKind && (
          <div className="stack tight">
            <p className="hint-block" style={{ margin: 0 }}>
              {sbKind === 'sell'
                ? `只做预览：${effectiveStock} 先按成交价卖出一笔，再按回补价留一张待买单；还能挂到未卖的高位批次上预演这笔亏损。`
                : `只做预览：${effectiveStock} 假设买入一批，目标价出现在待卖里，也能被模拟的「先卖后买」挂在头上。`}
              点这一行的「记为成交」之前，不写明细、不进备份。
            </p>
            <div className="form-grid">
              <label>
                <span>{sbKind === 'sell' ? '卖出日期' : '买入日期'}</span>
                <DateField value={sbDate} onChange={setSbDate} data-field="sandboxDate" aria-label="沙盒日期" />
              </label>
              <label>
                <span>{sbKind === 'sell' ? '卖出成交价' : '买入价'}</span>
                <Input
                  value={sbPrice}
                  onChange={(e) => setSbPrice(e.target.value)}
                  data-field="sandboxPrice"
                  placeholder="如 8.10"
                />
              </label>
              <label>
                <span>股数</span>
                <Input
                  value={sbQty}
                  onChange={(e) => setSbQty(e.target.value)}
                  data-field="sandboxQty"
                  placeholder="100"
                />
              </label>
              <label>
                <span>{sbKind === 'sell' ? '回补价 P（可空，按间隔推）' : '目标售价（可空，按间隔推）'}</span>
                <Input
                  value={sbExtra}
                  onChange={(e) => setSbExtra(e.target.value)}
                  data-field="sandboxExtra"
                />
              </label>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              {sbKind === 'sell'
                ? '回补价留空时，按「卖出价 − 该股间隔」自动生成待买。'
                : '目标价留空时，按「买入价 + 该股间隔」自动生成待卖。'}
            </p>
          </div>
        )}
      </Modal>

      {/* V9.30 裸卖待挂钩弹层（与明细页同一个面板） */}
      <HedgeSheet sellRow={hedgeRow} onClose={() => setHedgeRow(null)} />
      {/* 沙盒模拟行的挂钩预演：只改模拟挂钩 */}
      <HedgeSheet sellRow={sandboxHedgeRow} onClose={() => setSandboxHedgeRow(null)} mode="sandbox" />
    </div>
  )
}

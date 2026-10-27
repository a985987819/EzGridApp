import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Input, Modal, Tag, notificationOpen } from 'animal-island-ui'
import { Select } from '../ui/Select'
import { useApp } from '../store/useApp'
import { activeStocks } from '../domain/stocks'
import { recordNoLabel, type RecordNoIndex } from '../domain/recordNo'
import { isHedgeable } from '../domain/hedge'
import { limitRange } from '../domain/limit'
import { centsToYuan, toCents } from '../domain/money'
import { inputOrDefault } from '../domain/formDefaults'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'
import { sandboxRowOf, type SandboxItem, type SandboxKind } from '../domain/sandbox'
import { mergeTargetRows, type TargetRow } from '../domain/merge'
import { buildBuySuggestions, compareSellFirstOnly, consumedNextRounds, splitBuySuggestions, type BuySuggestion } from '../domain/suggestions'
import { buildNextRoundBuyRows, type NextRoundBuyRow } from '../domain/buyBoard'
import { buildNanoIdIndex } from '../ui/nanoid'
import { downloadText, toCsv } from '../ui/csv'
import { useFlashOnAppear } from '../ui/motion'
import { todayIso, money, price, qty, signedMoney, tone } from '../ui/format'
import { DateField } from '../ui/DateField'
import { useScrollHold } from '../ui/scrollHold'
import { enterSubmit } from '../ui/enterSave'
import type { TradesQuery } from '../ui/nav'
import type { BuySplit, RebuyOrder } from '../domain/types'
import { HedgeSheet } from '../components/HedgeBinder'
import { SplitModal } from '../components/SplitModal'

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
    recordLotSales,
    recordBuySuggestion,
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
  const orders = view.orders.filter((o) => o.stockName === effectiveStock)
  /** V9.37：刚记了回补成交的待买单闪一下——状态变了给个落点提示 */
  const justRebought = useFlashOnAppear(
    useMemo(() => orders.filter((o) => o.execQty > 0).map((o) => o.sourceRow), [orders]),
  )
  /**
   * V9.54：待买逐笔列表也把先卖后买排最前（欠的股是真欠，先看它）。
   * sort 是稳定的，同组内保持账本原来的顺序，不用另设排序。
   */
  const orderedRebuys = useMemo(
    () => [...orders].sort(compareSellFirstOnly),
    [orders],
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
    // V9.57：挂钩只作用在「基础股」上；奖励股是额外买入，不算已买回欠量
    for (const o of orders) execByRow.set(o.sourceRow, Math.max(0, o.execQty - o.doneRewardQty))
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

  const buySplits = view.buySplits
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const sellShown = range ? targetRows.filter((r) => within(r.priceCents)) : targetRows
  const sellOutRows = range ? targetRows.filter((r) => !within(r.priceCents)) : []
  const sellAmount = sellShown.reduce((a, r) => a + r.amountCents, 0)

  /**
   * V9.47：卖完的老批次，股价回到买入价那一档也要提醒买一次（网格一轮一轮做）。
   * 只做提醒——不进 orders、不计待买剩余金额、不参与组池奖励与守恒式。
   */
  const nextRound = useMemo(
    () =>
      buildNextRoundBuyRows({
        lots: view.lots,
        orders: view.orders,
        sells: view.sells,
        merges,
        consumed: consumedNextRounds(records),
        sandboxRows: new Set(sandboxByRow.keys()),
      }).filter((r) => r.stockName === effectiveStock),
    [view.lots, view.orders, view.sells, merges, sandboxByRow, effectiveStock, records],
  )
  const buySuggestions = buildBuySuggestions(buySplits, nextRound, plans)
  /**
   * V9.58 挂单页三组：**应该买入** = 先卖后买（或带敞口）的档——卖出拿回来的钱就欠着这些股；
   * **锦上添花** = 已完成批次的下一轮应买 + 先买后卖行里 P 列填了价的待回补（「P 列再买」），
   * 是拿这一轮的钱再投一轮。切分口径在 `domain/suggestions` 的 `splitBuySuggestions`。
   */
  const exposedOrderIds = useMemo(() => new Set(orders.filter((o) => o.exposure).map((o) => o.id)), [orders])
  const { mustBuy, bonus } = splitBuySuggestions(buySuggestions, exposedOrderIds)
  const mustToday = range ? mustBuy.filter((r) => within(r.priceCents)) : mustBuy
  const mustOut = range ? mustBuy.filter((r) => !within(r.priceCents)) : []
  const bonusToday = range ? bonus.filter((r) => within(r.priceCents)) : bonus
  const bonusOut = range ? bonus.filter((r) => !within(r.priceCents)) : []
  const mustAmount = mustToday.reduce((a, r) => a + r.amountCents, 0)
  const bonusAmount = bonusToday.reduce((a, r) => a + r.amountCents, 0)
  /**
   * 沙盒预览不走 buildBuySuggestions（模拟行要保留自己的「记为成交/删除」按钮），按同一口径切两组：
   * 先卖后买单 → 应该买入；其余买单 + 下一轮档 → 锦上添花。
   */
  const sbBuyAll = buySplits.filter((b) => b.qty > 0).sort((a, b) => Number(b.sellFirst === true) - Number(a.sellFirst === true))
  const sbBuyIn = range ? sbBuyAll.filter((b) => within(b.priceCents)) : sbBuyAll
  const sbBuyOut = range ? sbBuyAll.filter((b) => !within(b.priceCents)) : []
  const sbMustIn = sbBuyIn.filter((b) => b.sellFirst === true)
  const sbBonusIn = sbBuyIn.filter((b) => b.sellFirst !== true)
  const sbMustOut = sbBuyOut.filter((b) => b.sellFirst === true)
  const sbBonusOut = sbBuyOut.filter((b) => b.sellFirst !== true)
  const levelIn = range ? nextRound.filter((r) => within(r.priceCents)) : nextRound
  const levelOut = range ? nextRound.filter((r) => !within(r.priceCents)) : []
  const sbMustAmount = sbMustIn.reduce((a, b) => a + b.priceCents * b.qty, 0)
  const sbBonusAmount =
    sbBonusIn.reduce((a, b) => a + b.priceCents * b.qty, 0) + levelIn.reduce((a, r) => a + r.amountCents, 0)
  /** V9.58：越界档无法成交，折叠行只报数量与价格界 */
  const outSummary = (rows: readonly { priceCents: number; qty: number }[]) => {
    const lo = Math.min(...rows.map((r) => r.priceCents))
    const hi = Math.max(...rows.map((r) => r.priceCents))
    return `${rows.length} 档 · ${qty(rows.reduce((a, r) => a + r.qty, 0))} 股（价 ${price(lo)}~${price(hi)}）`
  }
  const [trade,setTrade]=useState<{side:'buy'|'sell';buy?:BuySuggestion;sell?:TargetRow}|null>(null)
  /** V9.66：行内拆分弹窗（免跳明细抽屉） */
  const [splitTarget,setSplitTarget]=useState<{kind:'buy'|'sell';sellRow?:number;lotId?:string}|null>(null)
  const [tradePrice,setTradePrice]=useState('')
  const [tradeQty,setTradeQty]=useState('')
  const [tradeDate,setTradeDate]=useState(todayIso())
  const [savingTrade,setSavingTrade]=useState(false)
  function openTrade(side:'buy'|'sell',row:BuySuggestion|TargetRow){
    setTrade(side==='buy'?{side,buy:row as BuySuggestion}:{side,sell:row as TargetRow})
    setTradePrice(centsToYuan(row.priceCents));setTradeQty(String(row.qty));setTradeDate(todayIso())
  }
  async function saveTrade(){
    if(!trade||savingTrade)return
    const r=trade.buy??trade.sell!
    setSavingTrade(true)
    try{
      const p=toCents(inputOrDefault(tradePrice,centsToYuan(r.priceCents)))
      const q=Number(inputOrDefault(tradeQty,String(r.qty)))
      if(p===null)throw new Error('成交价不合法')
      if(q>r.qty)throw new Error(`本次最多记录 ${r.qty} 股`)
      if(trade.buy)await recordBuySuggestion(trade.buy.sources,q,p,tradeDate||todayIso())
      else {
        const sources=new Map<string,number>()
        for(const t of trade.sell!.targets)sources.set(t.lotId,(sources.get(t.lotId)??0)+t.qty)
        await recordLotSales([...sources].map(([lotId,qty])=>({lotId,qty})),q,p,tradeDate||todayIso())
      }
      setTrade(null)
      notificationOpen({message:'成交已记录',description:'已按来源分配数量，更新持仓与回本链',type:'success'})
    }catch(e){notificationOpen({message:'记录失败',description:e instanceof Error?e.message:String(e),type:'error'})}
    finally{setSavingTrade(false)}
  }
  /**
   * V9.53：记成交默认量跟随「改单」——有计划的按计划量，再夹到还没成交的量。
   * 价格不用管，`buySplits` 的 priceCents 已经是 `计划价 > 回补价`（ledger 里定好）。
   */
  const execQtyOf=(b:BuySplit,o?:RebuyOrder|null)=>o?.planQty!=null?Math.min(o.planQty,b.qty):b.qty
  const buySuggestionLine=(r:BuySuggestion)=>(
    <div key={r.key} className="line wrap-row pending-buy clickable" data-testid="buy-suggestion" data-row={r.sources[0]?.row} data-price={r.priceCents} data-edited={r.edited ? '1' : undefined} data-sell-first={r.sellFirst ? '1' : undefined}
      // V9.58：锦上添花里全部来源都是「下一轮」的档保留深链身份（点行跳已完成那笔，不被 hideDone 挡）
      data-buy-level={r.sources.every((v) => v.kind === 'next') ? r.sources[0]?.row : undefined}
      onClick={(e) => {
        // 行上按钮（改单/记成交/来源明细跳转）各自有归宿，别整行跳走
        if ((e.target as HTMLElement).closest('button, summary, a, input, label')) return
        goTrades({ id: idFor(r.sources[0]?.row), stock: r.stockName })
      }}>
      <div className="left"><div className="t1 num">买 {price(r.priceCents)} × {qty(r.qty)}</div>
        {/* V9.58：三组之后行上仍要能看出这笔的身份——先卖后买 / 下一轮 / P 列再买（每组必有其一） */}
        <div className="tag-row" style={{ marginTop: 4 }}>
            {r.sellFirst && <Tag size="small" variant="soft" color="app-teal" data-testid="suggestion-sell-first">先卖后买</Tag>}
            {!r.sellFirst && r.sources.every((v) => v.kind === 'next') && (
              <Tag size="small" variant="soft" color="app-blue" data-testid="suggestion-next-round">下一轮</Tag>
            )}
            {!r.sellFirst && r.sources.some((v) => v.kind === 'order') && (
              <Tag size="small" variant="soft" color="app-blue" data-testid="suggestion-p-rebuy">P 列再买</Tag>
            )}
            {r.edited && (
              <>
                <Tag size="small" variant="soft" color="purple">已改单</Tag>
                <span className="tiny muted">只改这一条推荐，来源没动</span>
              </>
            )}
        </div>
        {/* V9.54：推荐挂单默认展开来源——点开才知道这档是从哪几笔欠出来的 */}
        <details open><summary className="tiny muted">{r.sources.length} 笔来源 · 查看明细</summary>
          {/* V9.55 修：同一张卖单拆出的两档共用 sourceRow，撞价合并后会并进同一条建议 →
              key 只用「类型+行号」会重复；带上拆分段身份/股数才唯一 */}
          {r.sources.map((v)=><div key={`${v.kind}:${v.row}:${v.kind==='order'?(v.splitKey??''):''}:${v.qty}`} className="tiny"><Button type="text" size="small" onClick={()=>goTrades({id:idFor(v.row),stock:r.stockName})}>{recordNoLabel(v.row,recordNo)}</Button> · {v.kind==='next'?'下一轮':(v.sellFirst?'先卖后买':'待回补')}{v.kind==='order' && v.splitKey ? ` 第 ${v.splitKey.split('#')[1] ?? '?'} 档` : ''} {qty(v.qty)} 股</div>)}
        </details>
      </div>
      <div className="right num">{money(r.amountCents)}</div>
      <div className="acts">
        {/* V9.53：改这一条推荐挂单（价格/数量），保存后行与记成交默认值都按改后的走，但不成交 */}
        <Button
          size="small"
          data-action="suggestion-plan"
          onClick={stopWith(() => {
            const plan = plans.find((p) => p.kind === 'buy' && p.refId === r.key)
            /**
             * V9.55 修：合并行不能拿「某个成员」的计划量当默认值——计划是按成员身份存的，
             * 拿到的是那一份的股数（两条各 400 合并成 800 时预填 400），
             * 用户「打开→不动→保存」就会把合计量砍掉一半。合并行一律用整行现价现量。
             */
            const merged = (r.members?.length ?? 0) > 1
            openPlan('buy', r.key, `买 ${r.stockName}`, r.priceCents, r.qty, merged ? null : plan?.priceCents, merged ? null : plan?.qty, r.members)
          })}
        >
          改单
        </Button>
        <Button size="small" data-action="suggestion-buy" onClick={()=>{const source=r.sources[0];const order=source?.kind==='order'?orders.find((o)=>o.id===source.id):null;if(!order)return openTrade('buy',r);const split=buySplits.find((b)=>b.orderId===order.id&&(source.kind!=='order'||b.key===source.splitKey))??buySplits.find((b)=>b.orderId===order.id);openExec(order,{qty:split?execQtyOf(split,order):r.qty,priceCents:r.priceCents})}}>记成交</Button>
        {(() => {
          // V9.66：单一张订单的档可以直接行内拆分（撞价合并的行来源不唯一，去明细拆）
          const src = r.sources.length === 1 ? r.sources[0] : null
          const order = src?.kind === 'order' ? orders.find((o) => o.id === src.id) : null
          return src?.kind === 'order' && order && order.remainingQty > 0 ? (
            <Button size="small" data-action="split-open" onClick={() => setSplitTarget({ kind: 'buy', sellRow: src.row })}>
              拆分
            </Button>
          ) : null
        })()}
      </div>
    </div>
  )
  /** 下一轮应买的一行：沙盒/区间外展开区里用；正常的锦上添花档走 buySuggestionLine（V9.58） */
  const levelLine = (r: NextRoundBuyRow, inToday: boolean) => {
    const z = zone(r.priceCents)
    return (
      <div
        key={r.key}
        className="line wrap-row pending-buy clickable"
        data-buy-level={r.anchorRow}
        data-merge-group={r.merged ? r.key : undefined}
        data-testid={inToday ? undefined : 'next-round-row'}
        onClick={() => goTrades({ id: idFor(r.anchorRow), stock: r.stockName })}
      >
        <div className="left">
          <div className="t1 num">
            {r.merged && <span className="merge-mark">合并 · </span>}
            买 {price(r.priceCents)} × {qty(r.qty)}
          </div>
          <div className="t2">
            {r.merged
              ? `合并 ${r.rows.length} 笔 · 最早 ${r.earliestBuyDate ?? '—'}`
              : `${recordNoLabel(r.anchorRow, recordNo)} · 买入 ${r.earliestBuyDate ?? '—'}`}
            {r.lastSoldAt && ` · 已卖完于 ${r.lastSoldAt}`}
            {r.repaid && ' · 回补过一轮'}
          </div>
          <div className="tag-row" style={{ marginTop: 4 }}>
            <Tag size="small" variant="soft" color="app-blue">下一轮</Tag>
            <Tag
              size="small"
              variant="soft"
              color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}
            >
              {z}
            </Tag>
            {r.merged && <Tag size="small" variant="soft" color="purple">同价 {r.rows.length} 笔</Tag>}
          </div>
        </div>
        <div className="right num" style={{ fontWeight: 600 }}>
          {money(r.amountCents)}
        </div>
      </div>
    )
  }

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

  /** V9.49：卖单行 → 它所属的回本链（待买行上标「回本链 第 N 笔」） */
  const chainOfSell = useMemo(() => {
    const m = new Map<number, (typeof view.repairChains)[number]>()
    for (const c of view.repairChains) for (const row of c.relatedSellRows) m.set(row, c)
    return m
  }, [view])

  /**
   * V9.58：沙盒买档行（原「今日挂单」内联渲染抽出）。沙盒不走 buildBuySuggestions——
   * 模拟行要保留「记为成交 / 删除」，且模拟/真实同价不能并成一条。
   */
  const sbBuyLine = (b: BuySplit) => {
    const sim = sandboxByRow.get(b.sourceRow)
    const o = orderById.get(b.orderId)
    return (
      <div
        key={`t-${b.key}`}
        // V9.29.1：左侧状态边框（蓝=买 / 红=卖），与明细页 trade-item 同一套语义
        className={`line wrap-row pending-buy ${sim ? 'sandbox-row' : 'clickable'}`}
        data-row={b.sourceRow}
        data-split-key={b.split ? b.key : undefined}
        data-sandbox-row={sim ? b.sourceRow : undefined}
        onClick={sim ? undefined : () => goTrades({ id: idFor(b.sourceRow), stock: b.stockName })}
      >
        <div className="left">
          <div className="t1 num">
            {sim && <span className="sandbox-mark">模拟 · </span>}
            买 {price(b.priceCents)} × {qty(b.qty)}
            {b.split && <span className="merge-mark"> · 拆档</span>}
          </div>
          <div className="t2">
            {sim ? `沙盒模拟单 · 计划 ${b.plannedQty} 股` : `${recordNoLabel(b.sourceRow, recordNo)} · 计划 ${b.plannedQty}`}
            {!b.split && (o?.rewardQty ?? 0) > 0 && ` · 含奖励 ${o!.rewardQty}`}
            {b.executedQty > 0 && ` · 已回补 ${b.executedQty}`}
          </div>
          {!b.split && o?.planPriceCents != null && (
            <div className="tag-row" style={{ marginTop: 4 }}>
              <Tag size="small" variant="soft" color="purple">
                计划 {price(o.planPriceCents)} × {qty(o.planQty ?? o.remainingQty)}
              </Tag>
            </div>
          )}
          {/* V9.49：这笔待买的身份——回补哪一笔卖出；属于回本链的再标出来 */}
          <div className="tag-row" style={{ marginTop: 4 }}>
            <Tag size="small" variant="soft" color="app-teal" data-testid="rebuy-of">
              回补 {recordNoLabel(b.sourceRow, recordNo)}
            </Tag>
            {b.sellFirst && (
              <Tag size="small" variant="soft" color="app-teal" data-testid="split-sell-first">先卖后买</Tag>
            )}
            {chainOfSell.has(b.sourceRow) && (
              <Tag size="small" variant="soft" color="app-yellow" data-testid="rebuy-chain">
                回本链 {recordNoLabel(chainOfSell.get(b.sourceRow)!.anchorRow, recordNo)}
              </Tag>
            )}
          </div>
        </div>
        <div className="right num" style={{ fontWeight: 600 }}>
          {money(b.priceCents * b.qty)}
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
              {!b.split && o && (
                <Button
                  size="small"
                  data-action="buy-plan"
                  onClick={stopWith(() => openPlan('buy', o.id, `买 ${o.stockName}`, o.rebuyPriceCents, o.remainingQty, o.planPriceCents, o.planQty))}
                >
                  改单
                </Button>
              )}
              <Button
                size="small"
                disabled={!o}
                onClick={stopWith(() => o && openExec(o, { qty: execQtyOf(b, o), priceCents: b.priceCents }))}
              >
                记成交
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  /** V9.58：卖出行渲染（原「今日挂单·可挂卖」内联渲染抽出），真实/模拟共用 */
  const sellLine = (r: TargetRow) => {
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
            <><Button size="small" data-action="sell-execution" onClick={stopWith(()=>openTrade('sell',r))}>记卖出</Button><Button
              size="small"
              data-action="sell-plan"
              onClick={stopWith(() =>
                openPlan(
                  'sell',
                  r.key,
                  `卖 ${r.targets[0].stockName}`,
                  r.priceCents,
                  r.qty,
                  r.planPriceCents,
                  r.planQty ?? (r.merged ? r.qty : null),
                  undefined,
                  r.planRefs,
                ),
              )}
            >
              改单
            </Button>
            {(() => {
              // V9.66：单一批次的待卖可以行内拆分（合并行涉及多个批次，去明细拆）
              const lotId = r.targets[0]?.lotId
              const lot = view.lots.find((l) => l.id === lotId)
              return !r.merged && lot && lot.remainingQty > 0 ? (
                <Button size="small" data-action="split-open" onClick={stopWith(() => setSplitTarget({ kind: 'sell', lotId }))}>
                  拆分
                </Button>
              ) : null
            })()}</>
          )}
        </div>
      </div>
    )
  }

  const rebuyTotal = buySplits.reduce((a, b) => a + b.priceCents * b.qty, 0)
  const rewardTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * Math.max(0, o.rewardQty - o.doneRewardQty), 0)
  /**
   * V9.55 修：待卖「合计」原来直接累加 `view.targets`（真实目标价 × 目标量），而上面每一行显示的
   * 是**计划后**的价量，右边的预期收益也已经按计划口径累加——改单之后同一张卡片里「行加起来 ≠ 合计」。
   * V9.53 的口径本来就是「金额合计也走改后的价量」，这里改成按行金额相加。
   */
  const targetTotal = targetRows.reduce((a, r) => a + r.amountCents, 0)
  const availableProfit = view.groups
    .filter((g) => g.stockId === (summary?.stockId ?? ''))
    .reduce((a, g) => a + g.availableCents, 0)

  // 记成交
  const [planRef, setPlanRef] = useState<{
    kind: 'buy' | 'sell'
    refId: string
    title: string
    suggestPrice: number
    suggestQty: number
    /** V9.55：这条推荐是改单撞价合并出来的，改单/清除要按份写回（见 savePlan） */
    members?: { key: string; qty: number }[]
    /** V9.55：卖单行读过的计划身份（含改价后追下去的那串），清除时要一起删 */
    planRefs?: string[]
  } | null>(null)
  const [planPrice, setPlanPrice] = useState('')
  const [planQty, setPlanQty] = useState('')

  // 记成交
  const [execOrder, setExecOrder] = useState<RebuyOrder | null>(null)
  const [execQty, setExecQty] = useState('')
  const [execPrice, setExecPrice] = useState('')
  const [execReward, setExecReward] = useState('')
  const [execDefaults,setExecDefaults]=useState({qty:0,priceCents:0,reward:0})
  /** V9.55：保存回补成交在途保护（连点两下会记两笔） */
  const [savingExec, setSavingExec] = useState(false)

  // 沙盒：新增模拟待买 / 待卖（只活在内存，刷新即清空）
  const [sbKind, setSbKind] = useState<SandboxKind | null>(null)
  const [sbDate, setSbDate] = useState(todayIso())
  const [sbPrice, setSbPrice] = useState('')
  const [sbQty, setSbQty] = useState('100')
  const [sbExtra, setSbExtra] = useState('')
  const [committing, setCommitting] = useState<string | null>(null)
  /**
   * V9.55：这一页所有编辑弹层（记成交 / 改单 / 记回补 / 沙盒 / 挂钩）合并成一个开关，
   * 关掉后把页面滚回原处——不然改完一笔要从顶上重新往下找。
   */
  useScrollHold(
    trade !== null || planRef !== null || execOrder !== null || sbKind !== null || hedgeRow !== null || sandboxHedgeRow !== null || splitTarget !== null,
  )

  const sbDefaults = {
    date: todayIso(),
    price: confirmedCents == null ? '8.10' : centsToYuan(confirmedCents),
    qty: '100',
  }
  const sbEffectivePrice = toCents(inputOrDefault(sbPrice, sbDefaults.price))
  const sbStep = cfg?.intervalCents ?? 0
  const sbDerivedExtra = sbEffectivePrice === null || sbStep <= 0 ? null : sbEffectivePrice + (sbKind === 'sell' ? -sbStep : sbStep)
  const sbDefaultExtra = sbDerivedExtra !== null && sbDerivedExtra > 0 ? centsToYuan(sbDerivedExtra) : ''

  function openPlan(
    kind: 'buy' | 'sell',
    refId: string,
    title: string,
    suggestPrice: number,
    suggestQty: number,
    planPriceCents?: number | null,
    planQtyValue?: number | null,
    members?: { key: string; qty: number }[],
    planRefs?: string[],
  ) {
    setPlanRef({ kind, refId, title, suggestPrice, suggestQty, members, planRefs })
    setPlanPrice((planPriceCents ?? suggestPrice) === 0 ? '' : ((planPriceCents ?? suggestPrice) / 100).toFixed(2))
    setPlanQty(planQtyValue ? String(planQtyValue) : '')
  }

  async function savePlan() {
    if (!planRef) return
    try {
      const p = toCents(inputOrDefault(planPrice, centsToYuan(planRef.suggestPrice)))
      const q = Number(inputOrDefault(planQty, String(planRef.suggestQty)))
      if (p === null || p <= 0) throw new Error('计划价不合法')
      if (!Number.isInteger(q) || q <= 0) throw new Error('计划量要填正整数')
      const members = planRef.members && planRef.members.length > 1 ? planRef.members : null
      if (!members) {
        await setPlan(planRef.kind, planRef.refId, p, q)
      } else {
        /**
         * V9.55：合并行要**按份写回**——每条原来的身份各挂一份计划价（同价），数量按各自份额
         * 分配、合计正好等于填的计划量。否则只有半边动：改完价合并行又会被拆回两行。
         * 每份至少 1 股（`setPlan` 不收 0），所以计划量比来源条数还小时按条数兜底。
         */
        const total = members.reduce((a, m) => a + m.qty, 0)
        const target = Math.min(q, total)
        let remain = target
        for (let i = 0; i < members.length; i += 1) {
          const m = members[i]
          const rest = members.length - i - 1
          // 比例分配；给后面每条至少留 1 股（setPlan 不收 0），最后一条吃掉余数
          const even = i === members.length - 1 ? remain : Math.round((target * m.qty) / total)
          const take = Math.max(1, Math.min(m.qty, even, Math.max(1, remain - rest)))
          remain = Math.max(0, remain - take)
          await setPlan(planRef.kind, m.key, p, take)
        }
      }
      setPlanRef(null)
      notificationOpen({
        message: '已改单',
        description: members ? `合并的 ${members.length} 条来源一起改，合计 ${q} 股` : '只改这一条推荐的显示与记成交默认值，来源没动',
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '保存失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  function openExec(o: RebuyOrder, suggestion?: {qty:number;priceCents:number}) {
    setExecOrder(o)
    const baseLeft=Math.max(0,o.baseQty-o.execQty+o.doneRewardQty)
    const defaults={qty:suggestion?.qty??o.remainingQty,priceCents:suggestion?.priceCents??o.rebuyPriceCents,reward:suggestion?Math.max(0,suggestion.qty-baseLeft):Math.max(0,o.rewardQty-o.doneRewardQty)}
    setExecDefaults(defaults)
    setExecQty(String(defaults.qty))
    setExecPrice(centsToYuan(defaults.priceCents))
    setExecReward(String(defaults.reward))
  }

  async function saveExec() {
    if (!execOrder) return
    // V9.55 修：这个弹窗原来没有在途保护，连点两下「保存」会记两笔回补成交
    // （部分成交时第二次仍满足 remainingQty 校验）——敞口/持仓/回补批次一起多算。
    if (savingExec) return
    setSavingExec(true)
    try {
      const q = Number(inputOrDefault(execQty, String(execDefaults.qty)))
      const priceText = inputOrDefault(execPrice, centsToYuan(execDefaults.priceCents))
      const p = toCents(priceText)
      const r = Number(inputOrDefault(execReward, String(execDefaults.reward)))
      if (!Number.isInteger(q) || q <= 0) throw new Error('股数要填正整数')
      if (p === null || p <= 0) throw new Error('回补价不合法')
      if (!Number.isInteger(r) || r < 0) throw new Error('奖励股数不合法')
      await recordRebuy(execOrder, q, p, r)
      setExecOrder(null)
      notificationOpen({
        message: '已记回补成交',
        description: execOrder.exposure
          ? `${q} 股 @ ${priceText}，敞口减少，已生成回补批次进待卖`
          : `${q} 股 @ ${priceText}，已生成回补批次进待卖`,
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '记录失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setSavingExec(false)
    }
  }

  async function undoExec(orderId: string) {
    const list = executions.filter((e) => e.orderId === orderId).sort((a, b) => b.at - a.at)
    const last = list[0]
    if (!last) return
    if (!window.confirm(`撤销最后一笔回补成交（${last.qty} 股 @ ${(last.priceCents / 100).toFixed(2)}）？`)) return
    try {
      await removeRebuy(last.id)
      notificationOpen({ message: '已撤销', type: 'info' })
    }catch(e){notificationOpen({message:'无法撤销',description:e instanceof Error?e.message:String(e),type:'error'})}
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
    const serial = isoToSerial(inputOrDefault(sbDate, sbDefaults.date))
    const p = toCents(inputOrDefault(sbPrice, sbDefaults.price))
    const q = Number(inputOrDefault(sbQty, sbDefaults.qty))
    const extraText = inputOrDefault(sbExtra, sbDefaultExtra)
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
    /** V9.58：复制清单按三组顺序（应该买入 → 锦上添花 → 应该卖出），区间外只报数量 */
    const musts = range ? mustToday : mustBuy
    const bonuses = range ? bonusToday : bonus
    if (musts.length) {
      lines.push('【应该买入】')
      for (const r of musts) lines.push(`  ${price(r.priceCents)} × ${r.qty} 股（${r.sources.length} 笔来源${r.sellFirst ? ' · 先卖后买' : ''}）`)
    }
    if (bonuses.length) {
      lines.push('【锦上添花】')
      for (const r of bonuses) lines.push(`  ${price(r.priceCents)} × ${r.qty} 股（${r.sources.length} 笔来源）`)
    }
    const sells = range ? sellShown : targetRows
    if (sells.length) {
      lines.push('【应该卖出】')
      for (const r of sells) {
        lines.push(`  ${sellRowShort(r)}  ${price(r.planPriceCents ?? r.priceCents)} × ${r.planQty ?? r.qty} 股`)
      }
    }
    if (range) {
      const outBuys = [...mustOut, ...bonusOut]
      if (outBuys.length || sellOutRows.length) {
        lines.push(`【区间外 · 今日无法成交】买 ${outBuys.length} 档 · 卖 ${sellOutRows.length} 档`)
      }
    } else {
      lines.push('（未确认昨收价，以上是全部待买/待卖）')
    }
    void navigator.clipboard?.writeText(lines.filter(Boolean).join('\n'))
    notificationOpen({ message: '清单已复制', type: 'success' })
  }

  function exportCsv() {
    const mustKeys = new Set(mustBuy.map((r) => r.key))
    const rows: (string | number)[][] = [['类型', '序号', '价格', '股数', '金额', '区间']]
    for (const r of buySuggestions) rows.push([mustKeys.has(r.key) ? '应该买入' : '锦上添花',r.sources.map((v)=>recordNoLabel(v.row,recordNo)).join(' + '),price(r.priceCents),r.qty,(r.amountCents/100).toFixed(2),zone(r.priceCents)])
    for (const r of targetRows) {
      const p = r.planPriceCents ?? r.priceCents
      const q = r.planQty ?? r.qty
      rows.push([
        r.sandbox ? '应该卖出（模拟）' : '应该卖出',
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
            {/* V9.58：模拟入口从原待买/待卖卡挪进沙盒面板，三组卡片不再各挂一套 */}
            <Button size="small" type="text" data-action="sandbox-add-sell" onClick={() => openSandboxForm('sell')}>
              ＋ 模拟待买
            </Button>
            <Button size="small" type="text" data-action="sandbox-add-buy" onClick={() => openSandboxForm('buy')}>
              ＋ 模拟待卖
            </Button>
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

      {/* 2. 应该买入：先卖后买/带敞口的欠股——卖出拿回来的钱就是留给它们的（V9.58） */}
      <Card data-testid="must-buy-card">
        <div className="sec-head">
          <strong>应该买入</strong>
          <Tag size="small" variant="soft" color="app-red">
            {sandbox.active ? sbMustIn.length : mustToday.length} 档
          </Tag>
          <div className="spacer" />
          <span className="sec-sub">
            {effectiveStock}
            {(sandbox.active ? sbMustAmount : mustAmount) > 0 && ` · ${money(sandbox.active ? sbMustAmount : mustAmount)}`}
          </span>
        </div>
        {sandbox.active ? (
          sbMustIn.length === 0 ? (
            <div className="empty-box">区间里没有先卖后买的欠单</div>
          ) : (
            <div className="data-block">{sbMustIn.map(sbBuyLine)}</div>
          )
        ) : mustToday.length === 0 ? (
          <div className="empty-box">区间里没有该先买回的欠股</div>
        ) : (
          <div className="data-block">{mustToday.map(buySuggestionLine)}</div>
        )}
        {sandbox.active && sbMustOut.length > 0 && (
          <details className="divider-top" data-testid="must-out">
            <summary className="tiny muted">区间外 · {outSummary(sbMustOut)}</summary>
            <div className="data-block">{sbMustOut.map(sbBuyLine)}</div>
          </details>
        )}
        {!sandbox.active && mustOut.length > 0 && (
          <details className="divider-top" data-testid="must-out">
            <summary className="tiny muted">区间外 · {outSummary(mustOut)}</summary>
            <div className="data-block">{mustOut.map(buySuggestionLine)}</div>
          </details>
        )}
        {availableProfit > 0 && (
          <p className="tiny muted" style={{ margin: '8px 0 0' }}>
            组池可分配 {money(availableProfit)}，记成交时可以带奖励股。
          </p>
        )}
        {summary && summary.exposureQty > 0 && (
          <p className="tiny muted" style={{ margin: '6px 0 0' }}>
            <b>敞口提示：</b>可卖 {qty(summary.targetQty)} 股、净持仓 {qty(summary.netQty)} 股；待卖全部执行完还有{' '}
            <b style={{ color: 'var(--up)' }}>{qty(summary.exposureQty)} 股</b> 要靠这里的买单回补——不是持仓，是在加空。
          </p>
        )}
      </Card>

      {/* 3. 锦上添花：已完成批次的下一轮 + P 列再买——拿这一轮的钱再投一轮（V9.58） */}
      <Card data-testid="bonus-card">
        <div className="sec-head">
          <strong>锦上添花</strong>
          <Tag size="small" variant="soft" color="app-blue">
            {sandbox.active ? sbBonusIn.length + levelIn.length : bonusToday.length} 档
          </Tag>
          <div className="spacer" />
          <span className="sec-sub">
            {effectiveStock}
            {(sandbox.active ? sbBonusAmount : bonusAmount) > 0 && ` · ${money(sandbox.active ? sbBonusAmount : bonusAmount)}`}
          </span>
        </div>
        {sandbox.active ? (
          sbBonusIn.length + levelIn.length === 0 ? (
            <div className="empty-box">区间里没有可再买一轮的档</div>
          ) : (
            <>
              {sbBonusIn.length > 0 && <div className="data-block">{sbBonusIn.map(sbBuyLine)}</div>}
              {levelIn.length > 0 && <div className="data-block">{levelIn.map((r) => levelLine(r, true))}</div>}
            </>
          )
        ) : bonusToday.length === 0 ? (
          <div className="empty-box">区间里没有可再买一轮的档</div>
        ) : (
          <div className="data-block">{bonusToday.map(buySuggestionLine)}</div>
        )}
        {sandbox.active && sbBonusOut.length + levelOut.length > 0 && (
          <details className="divider-top" data-testid="bonus-out">
            <summary className="tiny muted">区间外 · {outSummary([...sbBonusOut, ...levelOut])}</summary>
            <div className="data-block">
              {sbBonusOut.map(sbBuyLine)}
              {levelOut.map((r) => levelLine(r, false))}
            </div>
          </details>
        )}
        {!sandbox.active && bonusOut.length > 0 && (
          <details className="divider-top" data-testid="bonus-out">
            <summary className="tiny muted">区间外 · {outSummary(bonusOut)}</summary>
            <div className="data-block">{bonusOut.map(buySuggestionLine)}</div>
          </details>
        )}
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          已完成批次回到买入价那一档再买一轮；先买后卖行里 P 列填了价的待回补也归这里。下一轮档不参与组池奖励。
        </p>
      </Card>

      {/* 4. 应该卖出：未完成买单的所有可卖份额（V9.58） */}
      <Card data-testid="should-sell-card">
        <div className="sec-head">
          <strong>应该卖出</strong>
          <Tag size="small" variant="soft" color="app-orange">{sellShown.length} 档</Tag>
          <div className="spacer" />
          <span className="sec-sub">
            {effectiveStock}
            {sellAmount > 0 && ` · ${money(sellAmount)}`}
          </span>
        </div>
        {sellShown.length === 0 ? (
          <div className="empty-box">
            {sandbox.active ? '该股批次已全部卖完，沙盒面板可加模拟待卖' : '该股批次已全部卖完'}
          </div>
        ) : (
          <div className="data-block">{sellShown.map(sellLine)}</div>
        )}
        {sellOutRows.length > 0 && (
          <details className="divider-top" data-testid="sell-out">
            <summary className="tiny muted">区间外 · {outSummary(sellOutRows)}</summary>
            <div className="data-block">{sellOutRows.map(sellLine)}</div>
          </details>
        )}
        {targetRows.length > 0 && (
          <div className="data-block">
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

      {/* 5. 台账：逐笔回补的状态、撤销与挂钩入口——审计工具，默认收起（V9.58） */}
      <Card>
        <details data-testid="rebuy-ledger">
          <summary className="tiny muted">台账 · 逐笔回补 {orders.length} 条（状态 / 撤销 / 挂钩）</summary>
          {orders.length === 0 ? (
            <div className="empty-box">
              {sandbox.active ? '该股没有待买单，沙盒面板可加一条模拟待买' : '该股没有待买单'}
            </div>
          ) : (
            <div className="data-block">
              {orderedRebuys.map((o) => {
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
                        {/* V9.54：先卖后买的待买单独标出来（明细页/明细卡同一个标签），敞口照旧提醒 */}
                        {o.sellFirst ? (
                          <Tag size="small" variant="soft" color="app-teal" data-testid="rebuys-sell-first">先卖后买</Tag>
                        ) : (
                          <Tag size="small" variant="soft" color={o.exposure ? 'app-red' : 'app-teal'}>
                            {o.exposure ? '空头敞口' : '回补再买入'}
                          </Tag>
                        )}
                        {o.sellFirst && o.exposure && (
                          <Tag size="small" variant="soft" color="app-red">空头敞口</Tag>
                        )}
                        <Tag
                          size="small"
                          variant="soft"
                          color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}
                        >
                          {z}
                        </Tag>
                        {!sim && o.remainingQty > 0 && <Button size="small" data-action="rebuy-execution" onClick={stopWith(()=>openExec(o))}>记成交</Button>}
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
        </details>
      </Card>

      <Modal open={trade!==null} title={trade?.side==='sell'?'记卖出成交':'记买入成交'} typewriter={false} onClose={()=>!savingTrade&&setTrade(null)}
        footer={<div className="row"><Button type="primary" disabled={savingTrade} onClick={()=>void saveTrade()}>保存成交</Button><Button disabled={savingTrade} onClick={()=>setTrade(null)}>取消</Button></div>}>
        <div onKeyDown={enterSubmit(() => void saveTrade())}>
        <div className="form-grid">
          <label><span>实际成交价</span><Input value={tradePrice} onChange={(e)=>setTradePrice(e.target.value)} data-field="tradePrice" /></label>
          <label><span>实际成交量</span><Input value={tradeQty} onChange={(e)=>setTradeQty(e.target.value)} data-field="tradeQty" /></label>
          <label><span>成交日期</span><DateField value={tradeDate} onChange={setTradeDate} /></label>
        </div>
        <p className="tiny muted">
          {trade && (
            <>
              这条挂单 {qty(trade.buy ? trade.buy.qty : trade.sell!.qty)} 股：成交量填小一点就是部分成交，剩下的继续挂着。
              <br />
            </>
          )}
          同价来源按列表顺序分配，部分成交仅扣减本次成交的数量。
        </p>
        </div>
      </Modal>

      <Modal
        open={planRef !== null}
        title="改这一笔挂单"
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
          <div className="stack tight" onKeyDown={enterSubmit(() => void savePlan())}>
            <p className="hint-block" style={{ margin: 0 }}>
              {planRef.title} · 建议 {price(planRef.suggestPrice)}。改单只硬改这一条推荐：
              <b>计划价只用于显示和导出</b>，不回写明细、不改待买/待卖来源，也不动真实盈亏与守恒式；
              今日挂单按计划价校验区间。改完点「记成交 / 记卖出」会默认用改后的价和量，
              数量还能再往下改——那就是部分成交。
              {planRef.members && planRef.members.length > 1 && (
                <>
                  <br />
                  这一条是<b>改单撞价合并</b>出来的 {planRef.members.length} 条：改价/改量会
                  <b>一起作用到每一条来源</b>（数量按各自份额分，合计等于填的量），来源不动。
                </>
              )}
            </p>
            <div className="form-grid">
              <label>
                <span>计划价</span>
                <Input value={planPrice} placeholder={centsToYuan(planRef.suggestPrice)} onChange={(e) => setPlanPrice(e.target.value)} data-field="planPrice" />
              </label>
              <label>
                <span>计划量（股）</span>
                <Input value={planQty} placeholder={String(planRef.suggestQty)} onChange={(e) => setPlanQty(e.target.value)} data-field="planQty" />
              </label>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>留空采用框内默认值。</p>
            <Button
              size="small"
              onClick={() => {
                if (!planRef) return
                /**
                 * V9.55：合并行要把每一条成员的计划一起清掉（否则只有半边回到建议价）；
                 * 卖单行则要把「改价追下去的那串计划」一起清掉——行 key 是当前价派生的，
                 * 只删当前 key 根本删不到东西（按钮点了没反应）。
                 */
                const refs = new Set<string>([planRef.refId])
                if (planRef.members && planRef.members.length > 1) for (const m of planRef.members) refs.add(m.key)
                for (const ref of planRef.planRefs ?? []) refs.add(ref)
                void Promise.all([...refs].map((ref) => clearPlan(ref))).then(() => {
                  setPlanRef(null)
                  notificationOpen({ message: '已恢复建议价量', type: 'info' })
                })
              }}
            >
              清除改单（恢复建议）
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
            <Button type="primary" style={{ flex: 1 }} disabled={savingExec} onClick={() => void saveExec()}>保存</Button>
            <Button disabled={savingExec} onClick={() => setExecOrder(null)}>取消</Button>
          </div>
        }
      >
        {execOrder && (
          <div className="stack tight" onKeyDown={enterSubmit(() => void saveExec())}>
            <p className="hint-block" style={{ margin: 0 }}>
              {execOrder.stockName} · {recordNoLabel(execOrder.sourceRow, recordNo)} · 计划 {execOrder.baseQty}
              {execOrder.rewardQty > 0 && ` + 奖励 ${execOrder.rewardQty}`} 股，还能回补 {execOrder.remainingQty} 股。
            </p>
            <div className="form-grid">
              <label>
                <span>本次回补股数</span>
                <Input value={execQty} placeholder={String(execDefaults.qty)} onChange={(e) => setExecQty(e.target.value)} data-field="execQty" />
              </label>
              <label>
                <span>成交价</span>
                <Input value={execPrice} placeholder={centsToYuan(execDefaults.priceCents)} onChange={(e) => setExecPrice(e.target.value)} data-field="execPrice" />
              </label>
              <label>
                <span>其中奖励股数（已成交不可撤）</span>
                <Input value={execReward} placeholder={String(execDefaults.reward)} onChange={(e) => setExecReward(e.target.value)} data-field="execReward" />
              </label>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              留空采用框内默认值；奖励股数填 0 表示本次不买奖励股。
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
          <div className="stack tight" onKeyDown={enterSubmit(saveSandboxForm)}>
            <p className="hint-block" style={{ margin: 0 }}>
              {sbKind === 'sell'
                ? `只做预览：${effectiveStock} 先按成交价卖出一笔，再按回补价留一张待买单；还能挂到未卖的高位批次上预演这笔亏损。`
                : `只做预览：${effectiveStock} 假设买入一批，目标价出现在待卖里，也能被模拟的「先卖后买」挂在头上。`}
              点这一行的「记为成交」之前，不写明细、不进备份。
            </p>
            <div className="form-grid">
              <label>
                <span>{sbKind === 'sell' ? '卖出日期' : '买入日期'}</span>
                <DateField value={sbDate} placeholder={sbDefaults.date} onChange={setSbDate} data-field="sandboxDate" aria-label="沙盒日期" />
              </label>
              <label>
                <span>{sbKind === 'sell' ? '卖出成交价' : '买入价'}</span>
                <Input
                  value={sbPrice}
                  onChange={(e) => setSbPrice(e.target.value)}
                  data-field="sandboxPrice"
                  placeholder={sbDefaults.price}
                />
              </label>
              <label>
                <span>股数</span>
                <Input
                  value={sbQty}
                  onChange={(e) => setSbQty(e.target.value)}
                  data-field="sandboxQty"
                  placeholder={sbDefaults.qty}
                />
              </label>
              <label>
                <span>{sbKind === 'sell' ? '回补价 P（可空，按间隔推）' : '目标售价（可空，按间隔推）'}</span>
                <Input
                  value={sbExtra}
                  placeholder={sbDefaultExtra || '按该股间隔推导'}
                  onChange={(e) => setSbExtra(e.target.value)}
                  data-field="sandboxExtra"
                />
              </label>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              留空采用框内默认值。
              {sbKind === 'sell'
                ? '回补价留空时，按「卖出价 − 该股间隔」自动生成待买。'
                : '目标价留空时，按「买入价 + 该股间隔」自动生成待卖。'}
            </p>
          </div>
        )}
      </Modal>

      {/* V9.66 行内拆分弹层（免跳明细抽屉） */}
      {splitTarget && (
        <SplitModal kind={splitTarget.kind} sellRow={splitTarget.sellRow} lotId={splitTarget.lotId} onClose={() => setSplitTarget(null)} />
      )}

      {/* V9.30 裸卖待挂钩弹层（与明细页同一个面板） */}
      <HedgeSheet sellRow={hedgeRow} onClose={() => setHedgeRow(null)} />
      {/* 沙盒模拟行的挂钩预演：只改模拟挂钩 */}
      <HedgeSheet sellRow={sandboxHedgeRow} onClose={() => setSandboxHedgeRow(null)} mode="sandbox" />
    </div>
  )
}

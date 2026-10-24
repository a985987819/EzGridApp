import { useMemo, useState } from 'react'
import { Button, Card, Input, Modal, Select, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { activeStocks } from '../domain/stocks'
import { LIMIT_PCT, limitRange } from '../domain/limit'
import { toCents } from '../domain/money'
import { buildNanoIdIndex } from '../ui/nanoid'
import { downloadText, toCsv } from '../ui/csv'
import { money, price, qty, signedMoney } from '../ui/format'
import type { TradesQuery } from '../ui/nav'
import type { RebuyOrder } from '../domain/types'

/** 行内按钮不让冒泡到整行的「跳明细」点击上 */
function stopWith(fn: () => void) {
  return (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    fn()
  }
}

export function OrdersPage({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
  const { ledger, stocks, executions, scopedRecords, ordersSession, patchOrdersSession, recordRebuy, removeRebuy, setPlan, clearPlan } = useApp()
  // 顺序与启停都跟随「管理 · 股票」
  const stockNames = useMemo(() => activeStocks(stocks).map((s) => s.name), [stocks])
  const { stockName, lastClose, confirmed, limitOverride } = ordersSession

  // 跳明细以 nanoId 定位（V9.4）：行级唯一 id，与明细页筛选同源
  const nano = useMemo(() => buildNanoIdIndex(scopedRecords), [scopedRecords])
  const idFor = (row: number | null | undefined): string | undefined =>
    row === null || row === undefined ? undefined : nano.rowToId.get(row)

  const effectiveStock = stockNames.includes(stockName) ? stockName : stockNames[0] ?? ''
  const cfg = stocks.find((s) => s.name === effectiveStock)

  const limitLabel = !cfg
    ? '未配置'
    : cfg.priceLimitType === 'custom'
      ? `自定义 ${cfg.customLimitPct ?? 0}%`
      : cfg.priceLimitType === 'unknown'
        ? '未设置'
        : `${LIMIT_PCT[cfg.priceLimitType]}%`

  const computedRange =
    confirmed && confirmed.stock === effectiveStock
      ? limitRange(confirmed.closeCents, cfg?.priceLimitType ?? 'unknown', cfg?.customLimitPct ?? null)
      : null

  // §10：涨跌停允许手工覆盖，只影响挂单页的区间判断，不改股票配置
  const [editingLimit, setEditingLimit] = useState(false)
  const [upText, setUpText] = useState('')
  const [downText, setDownText] = useState('')

  const range =
    limitOverride && limitOverride.stock === effectiveStock
      ? { upCents: limitOverride.up, downCents: limitOverride.down, pct: computedRange?.pct ?? 0 }
      : computedRange

  const targets = ledger.targets.filter((t) => t.stockName === effectiveStock)
  const orders = ledger.orders.filter((o) => o.stockName === effectiveStock)
  const summary = ledger.byStock.find((s) => s.stockName === effectiveStock)

  const within = (p: number) => (range ? p >= range.downCents && p <= range.upCents : false)
  const zone = (p: number): '区间内' | '无区间' | '越界' => (range ? (within(p) ? '区间内' : '越界') : '无区间')

  const buyToday = range ? orders.filter((o) => within(o.rebuyPriceCents) && o.remainingQty > 0) : []
  const sellToday = range ? targets.filter((t) => within(t.priceCents)) : []
  const buyOut = range ? orders.filter((o) => !within(o.rebuyPriceCents) && o.remainingQty > 0).length : 0
  const sellOut = range ? targets.filter((t) => !within(t.priceCents)).length : 0
  const buyTodayAmount = buyToday.reduce((a, o) => a + o.rebuyPriceCents * o.remainingQty, 0)
  const sellTodayAmount = sellToday.reduce((a, t) => a + t.amountCents, 0)

  const rebuyTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * o.remainingQty, 0)
  const rewardTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * Math.max(0, o.rewardQty - o.doneRewardQty), 0)
  const targetTotal = targets.reduce((a, t) => a + t.amountCents, 0)
  const availableProfit = ledger.groups
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
        description: `${q} 股 @ ${execPrice}，敞口减少 ${q} 股`,
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
    // 昨收只记在会话里（V9.4 起不再写 db.meta）：跳明细往返保留，刷新即清
    patchOrdersSession({ lastClose, confirmed: { stock: effectiveStock, closeCents: cents }, limitOverride: null })
    setEditingLimit(false)
  }

  function copyList() {
    const lines: string[] = [`${effectiveStock} 挂单清单`]
    if (range && confirmed && confirmed.stock === effectiveStock) {
      lines.push(
        `昨收 ${(confirmed.closeCents / 100).toFixed(2)} · 区间 ${(range.downCents / 100).toFixed(2)}~${(range.upCents / 100).toFixed(2)}`,
      )
    }
    if (buyToday.length) {
      lines.push('【今日可挂买】')
      for (const o of buyToday) {
        lines.push(`  行${o.sourceRow}  ${price(o.planPriceCents ?? o.rebuyPriceCents)} × ${o.planQty ?? o.remainingQty} 股`)
      }
    }
    if (sellToday.length) {
      lines.push('【今日可挂卖】')
      for (const t of sellToday) {
        lines.push(`  批次${t.lotId.replace('lot:', '')}  ${price(t.planPriceCents ?? t.priceCents)} × ${t.planQty ?? t.qty} 股`)
      }
    }
    if (!range) {
      lines.push('（未确认昨收价，以下是全部待买/待卖）')
      for (const o of orders) lines.push(`  待买 ${price(o.rebuyPriceCents)} × ${o.remainingQty}`)
      for (const t of targets) lines.push(`  待卖 ${price(t.priceCents)} × ${t.qty}`)
    }
    void navigator.clipboard?.writeText(lines.filter(Boolean).join('\n'))
    notificationOpen({ message: '清单已复制', type: 'success' })
  }

  function exportCsv() {
    const rows: (string | number)[][] = [['类型', '来源行', '价格', '股数', '金额', '区间']]
    for (const o of orders) {
      const p = o.planPriceCents ?? o.rebuyPriceCents
      const q = o.planQty ?? o.remainingQty
      rows.push(['待买', o.sourceRow, price(p), q, ((p * q) / 100).toFixed(2), zone(p)])
    }
    for (const t of targets) {
      const p = t.planPriceCents ?? t.priceCents
      const q = t.planQty ?? t.qty
      rows.push(['待卖', Number(t.lotId.replace('lot:', '')), price(p), q, ((p * q) / 100).toFixed(2), zone(p)])
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

  if (ledger.targets.length === 0 && ledger.orders.length === 0) {
    return (
      <Card>
        <div className="empty-box">
          <strong>没有可挂的单</strong>
          先去「管理 · 导入」把交易记录写进本地。
        </div>
      </Card>
    )
  }

  return (
    <div className="stack">
      <div className="page-sticky" data-sticky="orders">
      <div className="page-title">
        <h2>挂单</h2>
        <div className="row" style={{ gap: 6 }}>
          <Button size="small" onClick={copyList}>复制</Button>
          <Button size="small" onClick={exportCsv}>CSV</Button>
        </div>
      </div>

      {/* 1. 选股 + 昨收 + 确认 */}
      <Card>
        <div className="stack tight">
          <Select
            options={stockNames.map((s) => ({ key: s, label: s }))}
            value={effectiveStock}
            onChange={(v) => {
              patchOrdersSession({ stockName: v, confirmed: null, limitOverride: null })
              setEditingLimit(false)
            }}
            aria-label="选择股票"
          />
          <div className="row nowrap">
            <Input
              className="grow"
              value={lastClose}
              onChange={(e) => {
                patchOrdersSession({ lastClose: e.target.value, confirmed: null, limitOverride: null })
                setEditingLimit(false)
              }}
              placeholder="昨收价，如 8.10"
              allowClear
              onClear={() => {
                patchOrdersSession({ lastClose: '', confirmed: null, limitOverride: null })
                setEditingLimit(false)
              }}
              aria-label="昨收价"
            />
            <Button type="primary" onClick={confirmClose}>确认</Button>
          </div>

          <div className="row divider-top" style={{ gap: 6 }}>
            <Tag size="medium" variant="soft" color="app-blue">涨跌幅 {limitLabel}</Tag>
            {range ? (
              <>
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
                        patchOrdersSession({ limitOverride: null })
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
              </>
            ) : (
              <span className="tiny muted">填完昨收点「确认」，才算涨停/跌停</span>
            )}
          </div>

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
                    patchOrdersSession({ limitOverride: { stock: effectiveStock, up, down } })
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
                      {buyToday.map((o) => (
                        <div
                          key={`t-${o.id}`}
                          className="line wrap-row clickable"
                          onClick={() => goTrades({ id: idFor(o.sourceRow), stock: o.stockName })}
                        >
                          <div className="left">
                            <div className="t1 num">买 {price(o.rebuyPriceCents)} × {qty(o.remainingQty)}</div>
                            <div className="t2">
                              行{o.sourceRow}
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
                            <Button
                              size="small"
                              onClick={stopWith(() => openPlan('buy', o.id, `买 ${o.stockName}`, o.rebuyPriceCents, o.planPriceCents, o.planQty))}
                            >
                              计划
                            </Button>
                            <Button size="small" onClick={stopWith(() => openExec(o))}>记成交</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {sellToday.length > 0 && (
                  <>
                    <div className="group-label">可挂卖 · {sellToday.length} 条</div>
                    <div className="data-block">
                      {sellToday.map((t) => (
                        <div
                          key={`s-${t.id}`}
                          className="line wrap-row clickable"
                          onClick={() =>
                            goTrades({
                              id: idFor(ledger.lots.find((l) => l.id === t.lotId)?.sourceRow ?? Number(t.lotId.replace('lot:', ''))),
                              stock: t.stockName,
                            })
                          }
                        >
                          <div className="left">
                            <div className="t1 num">卖 {price(t.priceCents)} × {qty(t.qty)}</div>
                            <div className="t2">批次 {t.lotId.replace('lot:', '')} · 预期 {signedMoney(t.expectProfitCents)}</div>
                            {t.planPriceCents != null && (
                              <div className="tag-row" style={{ marginTop: 4 }}>
                                <Tag size="small" variant="soft" color="purple">
                                  计划 {price(t.planPriceCents)} × {qty(t.planQty ?? t.qty)}
                                </Tag>
                              </div>
                            )}
                          </div>
                          <div className="right num" style={{ fontWeight: 600 }}>
                            {money(t.amountCents)}
                          </div>
                          <div className="acts">
                            <Button
                              size="small"
                              onClick={stopWith(() => openPlan('sell', t.id, `卖 ${t.stockName}`, t.priceCents, t.planPriceCents, t.planQty))}
                            >
                              计划
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {(buyOut > 0 || sellOut > 0) && (
              <p className="tiny" style={{ margin: '8px 0 0', color: 'var(--up)' }}>
                有 {buyOut} 条待买、{sellOut} 条待卖在今日区间外（涨跌停之外挂不进去），下面列表里标红。
              </p>
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
          <span className="sec-sub">空头敞口要一直看得见</span>
        </div>
        {orders.length === 0 ? (
          <div className="empty-box">该股没有待买单</div>
        ) : (
          <div className="data-block">
            {orders.map((o) => {
              const z = zone(o.rebuyPriceCents)
              return (
                <div
                  key={o.id}
                  className="line clickable"
                  onClick={() => goTrades({ id: idFor(o.sourceRow), stock: o.stockName })}
                >
                  <div className="left">
                    <div className="t1 num">
                      {price(o.rebuyPriceCents)}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                        {' '}× {qty(o.remainingQty)} 股
                      </span>
                      {o.remainingQty === 0 && (
                        <Tag size="small" variant="soft" color="app-green" style={{ marginLeft: 6 }}>已回补完</Tag>
                      )}
                    </div>
                    <div className="t2">
                      行{o.sourceRow} · 计划 {o.baseQty}
                      {o.rewardQty > 0 && ` + 奖励 ${o.rewardQty}`}
                      {o.execQty > 0 && ` · 已回补 ${o.execQty}`}
                      {` · 组池 ${money(o.grossProfitCents)} / ${o.hands} 手`}
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
                      {o.execQty > 0 && (
                        <Button size="small" type="text" onClick={stopWith(() => void undoExec(o.id))}>撤销最后一笔</Button>
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
          <Tag size="small" variant="soft" color="app-teal">{targets.length} 条</Tag>
          <div className="spacer" />
          <span className="sec-sub">量不超批次剩余</span>
        </div>
        {targets.length === 0 ? (
          <div className="empty-box">该股批次已全部卖完</div>
        ) : (
          <div className="data-block">
            {targets.map((t) => {
              const z = zone(t.priceCents)
              const lot = ledger.lots.find((l) => l.id === t.lotId)
              return (
                <div
                  key={t.id}
                  className="line clickable"
                  onClick={() =>
                    goTrades({
                      id: idFor(lot?.sourceRow ?? Number(t.lotId.replace('lot:', ''))),
                      stock: t.stockName,
                    })
                  }
                >
                  <div className="left">
                    <div className="t1 num">
                      {price(t.priceCents)}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> × {qty(t.qty)} 股</span>
                    </div>
                    <div className="t2">批次 {t.lotId.replace('lot:', '')} · 买入 {price(lot?.buyPriceCents ?? null)}</div>
                    <div className="tag-row" style={{ marginTop: 4 }}>
                      <Tag
                        size="small"
                        variant="soft"
                        color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}
                      >
                        {z}
                      </Tag>
                    </div>
                  </div>
                  <div className="right">
                    <div className="num" style={{ fontWeight: 600 }}>{money(t.amountCents)}</div>
                    <div className="tiny up num">{signedMoney(t.expectProfitCents)}</div>
                  </div>
                </div>
              )
            })}
            <div className="line">
              <div className="left t1">合计</div>
              <div className="right num" style={{ fontWeight: 600 }}>
                {money(targetTotal)}
                <div className="tiny up num">{signedMoney(targets.reduce((a, t) => a + t.expectProfitCents, 0))}</div>
              </div>
            </div>
          </div>
        )}
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          待卖合计 {money(targetTotal)}
        </p>
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
              <b>不参与盈亏、清单与守恒式的任何计算</b>（P8）。
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
              {execOrder.stockName} · 行 {execOrder.sourceRow} · 计划 {execOrder.baseQty}
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
              回补成交只平掉空头敞口，不会新增可卖批次；要重新挂卖，请到明细里另建一笔买入。
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}

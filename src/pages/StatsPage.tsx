import { useMemo, useState } from 'react'
import { Button, Calendar, Card, Tag } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { activeStocks } from '../domain/stocks'
import { buildGridStats } from '../domain/gridStats'
import { money, price, qty, signedMoney, tone } from '../ui/format'
import { monthRange, type TradesQuery } from '../ui/nav'
import { recordNoLabel } from '../domain/recordNo'
import { buildNanoIdIndex } from '../ui/nanoid'

export function StatsPage({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
  const { ledger, stocks } = useApp()
  const t = ledger.totals
  const active = activeStocks(stocks)
  const enabledNames = new Set(active.map((s) => s.name))
  const enabledIds = useMemo(() => new Set(active.map((s) => s.id)), [active])
  const byStock = ledger.byStock.filter((s) => enabledNames.has(s.stockName))
  const groups = ledger.groups.filter((g) => enabledIds.has(g.stockId))
  const hiddenCount = ledger.byStock.length - byStock.length
  const stockNameOf = (id: string) => stocks.find((s) => s.id === id)?.name ?? ''
  /**
   * V9.61 网格进行度：完成轮次 / 高成交点位 / 平均持仓——纯派生（domain/gridStats）。
   * 盈利口径是「批次自身的卖出盈利」，不含裸卖与挂钩暂记，别和上面的实现盈利总账对数。
   */
  const grid = useMemo(() => {
    const enabledLotIds = new Set(
      ledger.lots.filter((l) => enabledIds.has(l.stockId)).map((l) => l.id),
    )
    return buildGridStats(
      ledger.lots.filter((l) => enabledLotIds.has(l.id)),
      ledger.sells.filter((s) => s.lotId !== null && enabledLotIds.has(s.lotId)),
    )
  }, [ledger.lots, ledger.sells, enabledIds])
  const pendingRebuyQty = ledger.orders.reduce((a, o) => a + o.remainingQty, 0)

  return (
    <div className="stack">
      <div className="page-title">
        <h2>统计</h2>
        <p>按卖出日期归月，缺日期单列 · 点行可跳明细</p>
      </div>

      <Card>
        <div className="metrics">
          <div>
            <div className="k">买入</div>
            <div className="v money">{money(t.buyAmountCents)}</div>
            <div className="s">{qty(t.buyQty)} 股</div>
          </div>
          <div>
            <div className="k">卖出</div>
            <div className="v money">{money(t.sellAmountCents)}</div>
            <div className="s">{t.sellCount} 笔 / {qty(t.sellQty)} 股</div>
          </div>
          <div>
            <div className="k">实现盈利</div>
            <div className={`v money ${tone(t.profitCents)}`}>{signedMoney(t.profitCents)}</div>
            <div className="s">未扣费用</div>
          </div>
        </div>
      </Card>

      {/* V9.61 网格进行度：一眼看清做到哪一步了 */}
      <Card data-testid="grid-progress">
        <div className="sec-head">
          <strong>网格进行度</strong>
          <div className="spacer" />
          <span className="sec-sub">完成一轮 = 买入后已卖光</span>
        </div>
        <div className="grid-4 metric-strip two-col">
          <div>
            <div className="k">完成轮次</div>
            <div className="v">{grid.doneRounds}</div>
          </div>
          <div>
            <div className="k">进行中批次</div>
            <div className="v">{grid.activeRounds}</div>
          </div>
          <div>
            <div className="k">每轮均盈</div>
            <div className={`v money ${tone(grid.avgProfitCents ?? 0)}`}>
              {grid.avgProfitCents === null ? '—' : signedMoney(grid.avgProfitCents)}
            </div>
          </div>
          <div>
            <div className="k">平均持仓</div>
            <div className="v">{grid.avgHoldingDays === null ? '—' : `${grid.avgHoldingDays} 天`}</div>
          </div>
          <div>
            <div className="k">待卖股数</div>
            <div className="v">{qty(t.targetQty)}</div>
          </div>
          <div>
            <div className="k">待回补股数</div>
            <div className="v">{qty(pendingRebuyQty)}</div>
          </div>
          <div>
            <div className="k">空头敞口</div>
            <div className="v" style={{ color: t.exposureQty > 0 ? 'var(--up)' : undefined }}>
              {qty(t.exposureQty)}
            </div>
          </div>
          <div>
            <div className="k">最热价位</div>
            <div className="v" style={{ fontSize: 14 }}>
              {grid.hotTop ? `${grid.hotTop.stockName} ${price(grid.hotTop.priceCents)} · ${grid.hotTop.doneCount} 轮` : '—'}
            </div>
          </div>
        </div>
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          「每轮均盈」与下面的高成交点位用批次自身盈利口径（不含裸卖与挂钩暂记），和总账的实现盈利不是同一个数。
        </p>
      </Card>

      {/* V9.61 高成交点位：已完成次数最多的买入价位——网格踩得最熟的档 */}
      <Card data-testid="hot-levels">
        <div className="sec-head">
          <strong>高成交点位</strong>
          <div className="spacer" />
          <span className="sec-sub">按已完成轮次排名</span>
        </div>
        {grid.levels.length === 0 ? (
          <div className="empty-box">还没有已完成的买入批次</div>
        ) : (
          <div className="data-block">
            {grid.levels.map((l, i) => {
              const max = Math.max(1, ...grid.levels.map((x) => x.doneCount))
              return (
                <div
                  key={`${l.stockName}|${l.priceCents}`}
                  className="line clickable hot-row"
                  onClick={() => goTrades({ stock: l.stockName, price: l.priceCents, showDone: true })}
                >
                  <div className="left" style={{ flex: 1, minWidth: 0 }}>
                    <div className="t1 num">
                      {i === 0 && l.doneCount > 0 && (
                        <Tag size="small" variant="soft" color="app-orange" style={{ marginRight: 6 }}>最热</Tag>
                      )}
                      {l.stockName} {price(l.priceCents)}
                    </div>
                    <div className="t2 num">
                      完成 {l.doneCount} 轮 · 在手 {l.activeCount} 批 · 累计买 {qty(l.buyQty)} 股
                    </div>
                    <div className="hot-bar" aria-hidden>
                      <i style={{ width: `${Math.round((l.doneCount / max) * 100)}%` }} />
                    </div>
                  </div>
                  <div className="right">
                    <div className={`num ${tone(l.profitCents)}`} style={{ fontWeight: 700 }}>
                      {signedMoney(l.profitCents)}
                    </div>
                    <div className="tiny muted num">该价位已实现</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* V9.61 近 12 个月盈利趋势：红盈绿亏，条高按绝对值 */}
      <TrendCard monthly={ledger.monthly} />

      <CalendarCard goTrades={goTrades} />

      <Card>
        <div className="sec-head">
          <strong>月度成交</strong>
          <div className="spacer" />
          <span className="sec-sub">收益率 = 盈利 / 卖出额</span>
        </div>
        <div className="data-block">
        {ledger.monthly.map((m) => (
          <div
            key={m.month}
            className="line clickable"
            onClick={() =>
              // 月度成交本身就是已成交数据的汇总：跳明细时放开「隐藏已完成」，行数才对得上标签
              goTrades(
                m.dateMissing
                  ? { status: ['sellDateMissing'], showDone: true }
                  : { from: monthRange(m.month).from, to: monthRange(m.month).to, showDone: true },
              )
            }
          >
            <div className="left">
              <div className="t1">
                {m.month}
                {m.dateMissing && (
                  <Tag size="small" variant="soft" color="app-yellow" style={{ marginLeft: 6 }}>
                    待补日期
                  </Tag>
                )}
              </div>
              <div className="t2 num">{m.sellCount} 笔 · {qty(m.sellQty)} 股 · {money(m.sellAmountCents)}</div>
            </div>
            <div className="right">
              <div className={`num ${tone(m.profitCents)}`} style={{ fontWeight: 700 }}>
                {signedMoney(m.profitCents)}
              </div>
              <div className="tiny muted num">
                {m.sellAmountCents ? `${((m.profitCents / m.sellAmountCents) * 100).toFixed(2)}%` : '—'}
              </div>
            </div>
          </div>
        ))}
        </div>
      </Card>

      <Card>
        <div className="sec-head">
          <strong>按股票</strong>
        </div>
        <div className="data-block">
        {byStock.map((s) => (
          <div key={s.stockName} className="line clickable" onClick={() => goTrades({ stock: s.stockName })}>
            <div className="left" style={{ flex: 1 }}>
              <div className="t1">
                {s.stockName}
                <span className="t2" style={{ marginLeft: 6, fontWeight: 400 }}>{s.rows} 条 · {s.sellCount} 笔卖出</span>
              </div>
              <div className="grid-4" style={{ marginTop: 4, textAlign: 'left' }}>
                <div>
                  <div className="k">买</div>
                  <div className="v" style={{ fontSize: 13 }}>{qty(s.buyQty)}</div>
                </div>
                <div>
                  <div className="k">卖</div>
                  <div className="v" style={{ fontSize: 13 }}>{qty(s.sellQty)}</div>
                </div>
                <div>
                  <div className="k">待卖</div>
                  <div className="v" style={{ fontSize: 13 }}>{qty(s.targetQty)}</div>
                </div>
                <div>
                  <div className="k">净持仓</div>
                  <div className="v" style={{ fontSize: 13 }}>{qty(s.netQty)}</div>
                </div>
              </div>
            </div>
            <div className="right">
              <div className={`num ${tone(s.profitCents)}`} style={{ fontWeight: 700 }}>
                {signedMoney(s.profitCents)}
              </div>
              {s.exposureQty > 0 && <div className="tiny" style={{ color: 'var(--up)' }}>敞口 {s.exposureQty}</div>}
            </div>
          </div>
        ))}
        <div className="line">
          <div className="left t1">
            合计
            {hiddenCount > 0 && <span className="tiny muted" style={{ fontWeight: 400 }}> · 另有 {hiddenCount} 只停用股票计入合计</span>}
          </div>
          <div className={`right num ${tone(t.profitCents)}`} style={{ fontWeight: 700 }}>{signedMoney(t.profitCents)}</div>
        </div>
        </div>
      </Card>

      <Card>
        <div className="sec-head">
          <strong>组池（同股同回补价）</strong>
          <div className="spacer" />
          <span className="sec-sub">R4 全部卖出入池</span>
        </div>
        {groups.length === 0 ? (
          <div className="empty-box">没有可分配的组池</div>
        ) : (
          <div className="data-block">
          {groups.map((g) => (
            <div
              key={g.groupKey}
              className="line clickable"
              onClick={() => goTrades({ stock: stockNameOf(g.stockId), price: g.rebuyPriceCents, showDone: true })}
            >
              <div className="left">
                <div className="t1 mono" style={{ fontSize: 12.5 }}>{g.groupKey.replace('stock:', '')}</div>
                <div className="t2">
                  每手 {money(g.lotCostCents)} · 容量 {g.capacityHands} 手 · 已授予 {g.grantedHands} 手
                </div>
              </div>
              <div className="right">
                <div className={`num ${tone(g.grossProfitCents)}`} style={{ fontWeight: 600 }}>{money(g.grossProfitCents)}</div>
                <div className="tiny muted num">可动用 {money(g.availableCents)}</div>
              </div>
            </div>
          ))}
          </div>
        )}
      </Card>
    </div>
  )
}


/** V9.61 近 12 个月盈利趋势：一格一个月，条高 = |盈利| 占最大值比例，红盈绿亏 */
function TrendCard({ monthly }: { monthly: { month: string; profitCents: number; sellCount: number }[] }) {
  const recent = monthly.slice(-12)
  const maxAbs = Math.max(1, ...recent.map((m) => Math.abs(m.profitCents)))
  return (
    <Card data-testid="profit-trend">
      <div className="sec-head">
        <strong>近 12 个月盈利</strong>
        <div className="spacer" />
        <span className="sec-sub">条高按绝对值 · 红盈绿亏</span>
      </div>
      {recent.length === 0 ? (
        <div className="empty-box">还没有按月归集的卖出</div>
      ) : (
        <div className="trend-chart">
          {recent.map((m) => (
            <div key={m.month} className="trend-col" title={`${m.month} · ${signedMoney(m.profitCents)} · ${m.sellCount} 笔`}>
              <div
                className={`trend-bar ${tone(m.profitCents)}`}
                style={{ height: `${Math.max(3, Math.round((Math.abs(m.profitCents) / maxAbs) * 100))}%` }}
              />
              <div className="trend-month num">{m.month.slice(5)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 日历格用的紧凑盈利：+196 / -120（元，四舍五入到整数） */
function compactYuan(cents: number): string {
  const yuan = Math.round(Math.abs(cents) / 100)
  return `${cents >= 0 ? '+' : '-'}${yuan}`
}

function price2(cents: number | null): string {
  return cents === null ? '—' : (cents / 100).toFixed(2)
}

/** 成交日历：按月看每天卖出了什么、赚了多少（红盈绿亏） */
function CalendarCard({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
  const { ledger, records, recordNo } = useApp()
  const nano = useMemo(() => buildNanoIdIndex(records), [records])
  const today = new Date()
  // 本地时区的今天：toISOString 是 UTC，东八区早上 8 点前会落到昨天
  const localIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const [panel, setPanel] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`)
  const [selected, setSelected] = useState(localIso)

  // 年 / 月累计盈利跟随日历面板（V9.10）：翻月 / 翻年就重算，不再钉死今天。
  // 口径不变：从月度桶里取，未填日期的卖出不进累计。
  const panelYear = panel.slice(0, 4)
  const yearProfit = useMemo(
    () => ledger.monthly.filter((m) => m.month.startsWith(panelYear)).reduce((a, m) => a + m.profitCents, 0),
    [ledger.monthly, panelYear],
  )
  const monthProfit = useMemo(
    () => ledger.monthly.find((m) => m.month === panel)?.profitCents ?? 0,
    [ledger.monthly, panel],
  )

  // 按天聚合：一个格子一条「左当日总盈利 / 右成交笔数」（V9.7 修正口径）
  const events = useMemo(() => {
    const byDay = new Map<string, { count: number; qty: number; profit: number }>()
    for (const s of ledger.sells) {
      if (s.soldAt === null) continue
      const old = byDay.get(s.soldAt)
      const next = old ?? { count: 0, qty: 0, profit: 0 }
      next.count += 1
      next.qty += s.qty
      next.profit += s.profitCents ?? 0
      byDay.set(s.soldAt, next)
    }
    return [...byDay.entries()].map(([day, b]) => ({
      start: day,
      color: b.profit >= 0 ? ('coral' as const) : ('green' as const),
      title: (
        <span
          className="cal-day-stat"
          title={`当日盈利 ${signedMoney(b.profit)} · ${b.qty} 股`}
        >
          <span className="amt">{compactYuan(b.profit)}</span>
          <span className="q">{b.count}笔</span>
        </span>
      ),
    }))
  }, [ledger.sells])

  const daySells = ledger.sells.filter((s) => s.soldAt === selected)
  const missing = ledger.sells.filter((s) => s.dateMissing).length

  return (
    <Card>
      <div className="sec-head">
        <strong>成交日历</strong>
        <div className="spacer" />
        {missing > 0 && (
          <Tag size="small" variant="soft" color="app-yellow" onClick={() => goTrades({ status: ['sellDateMissing'], showDone: true })}>
            {missing} 笔缺日期
          </Tag>
        )}
      </div>
      {/* 年 / 月累计盈利随面板翻动（V9.10）：看的哪个月就算哪个月 */}
      <div className="grid-4 metric-strip two-col" style={{ marginBottom: 8 }}>
        <div>
          <div className="k">年累计盈利（{panelYear}）</div>
          <div className={`v ${tone(yearProfit)}`}>{signedMoney(yearProfit)}</div>
        </div>
        <div>
          <div className="k">月累计盈利（{panel}）</div>
          <div className={`v ${tone(monthProfit)}`}>{signedMoney(monthProfit)}</div>
        </div>
      </div>
      <Calendar
        value={selected}
        onChange={setSelected}
        panelValue={panel}
        onPanelChange={setPanel}
        events={events}
        showEventTime={false}
        aria-label="成交日历"
      />
      <div className="divider-top">
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="tiny muted">{selected}</span>
          <div className="spacer" />
          <span className="tiny muted">{daySells.length} 笔卖出</span>
          <Button size="small" type="text" onClick={() => goTrades({ from: selected, to: selected, showDone: true })}>
            看这天明细
          </Button>
        </div>
        {daySells.length === 0 ? (
          <p className="tiny muted" style={{ margin: 0 }}>这天没有成交</p>
        ) : (
          <div className="data-block" data-testid="cal-day-sells">
            {daySells.map((s) => (
              <div
                key={s.id}
                className="line clickable"
                onClick={() => goTrades({ id: nano.rowToId.get(s.sourceRow), stock: s.stockName })}
              >
                <div className="left">
                  <div className="t1" style={{ fontSize: 13 }}>
                    {/* V9.41 日历只按卖出日归集；行首标明方向，免得只看到价格和盈利分不清买还是卖 */}
                    <span className="side-chip sell">卖出</span>
                    {s.stockName} · {price2(s.priceCents)} × {s.qty}
                  </div>
                  <div className="t2">{recordNoLabel(s.sourceRow, recordNo)} · 买入成本 {price2(s.costCents)}</div>
                </div>
                <div className={`right num ${tone(s.profitCents)}`} style={{ fontWeight: 700 }}>
                  {signedMoney(s.profitCents)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

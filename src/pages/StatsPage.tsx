import { useMemo, useState } from 'react'
import { Calendar, Card, Tag } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { activeStocks } from '../domain/stocks'
import { money, qty, signedMoney, tone } from '../ui/format'

export function StatsPage() {
  const { ledger, stocks } = useApp()
  const t = ledger.totals
  const active = activeStocks(stocks)
  const enabledNames = new Set(active.map((s) => s.name))
  const enabledIds = new Set(active.map((s) => s.id))
  const byStock = ledger.byStock.filter((s) => enabledNames.has(s.stockName))
  const groups = ledger.groups.filter((g) => enabledIds.has(g.stockId))
  const hiddenCount = ledger.byStock.length - byStock.length

  return (
    <div className="stack">
      <div className="page-title">
        <h2>统计</h2>
        <p>按卖出日期归月，缺日期单列</p>
      </div>

      <Card>
        <div className="metrics">
          <div>
            <div className="k">买入</div>
            <div className="v" style={{ fontSize: 16 }}>{money(t.buyAmountCents)}</div>
            <div className="s">{qty(t.buyQty)} 股</div>
          </div>
          <div>
            <div className="k">卖出</div>
            <div className="v" style={{ fontSize: 16 }}>{money(t.sellAmountCents)}</div>
            <div className="s">{t.sellCount} 笔 / {qty(t.sellQty)} 股</div>
          </div>
          <div>
            <div className="k">实现盈利</div>
            <div className={`v ${tone(t.profitCents)}`} style={{ fontSize: 16 }}>{signedMoney(t.profitCents)}</div>
            <div className="s">未扣费用</div>
          </div>
        </div>
      </Card>

      <CalendarCard />

      <Card>
        <div className="row" style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>月度成交</strong>
          <div className="spacer" />
          <span className="tiny muted">收益率 = 盈利 / 卖出额</span>
        </div>
        {ledger.monthly.map((m) => (
          <div key={m.month} className="line">
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
      </Card>

      <Card>
        <div className="row" style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>按股票</strong>
        </div>
        {byStock.map((s) => (
          <div key={s.stockName} className="line">
            <div className="left" style={{ flex: 1 }}>
              <div className="t1">
                {s.stockName}
                <span className="t2" style={{ marginLeft: 6, fontWeight: 400 }}>{s.rows} 行 · {s.sellCount} 笔</span>
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
      </Card>

      <Card>
        <div className="row" style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>组池（同股同回补价）</strong>
          <div className="spacer" />
          <span className="tiny muted">R4 全部卖出入池</span>
        </div>
        {groups.length === 0 ? (
          <div className="empty-box">没有可分配的组池</div>
        ) : (
          groups.map((g) => (
            <div key={g.groupKey} className="line">
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
          ))
        )}
      </Card>
    </div>
  )
}


/** 成交日历：按月看每天卖出了什么、赚了多少（红盈绿亏） */
function CalendarCard() {
  const { ledger } = useApp()
  const today = new Date()
  const [panel, setPanel] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`)
  const [selected, setSelected] = useState(today.toISOString().slice(0, 10))

  const events = useMemo(
    () =>
      ledger.sells
        .filter((s) => s.soldAt !== null && s.profitCents !== null)
        .map((s) => ({
          title: signedMoney(s.profitCents),
          start: s.soldAt as string,
          color: (s.profitCents ?? 0) >= 0 ? ('coral' as const) : ('green' as const),
        })),
    [ledger.sells],
  )

  const daySells = ledger.sells.filter((s) => s.soldAt === selected)
  const missing = ledger.sells.filter((s) => s.dateMissing).length

  return (
    <Card>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>成交日历</strong>
        <div className="spacer" />
        {missing > 0 && <Tag size="small" variant="soft" color="app-yellow">{missing} 笔缺日期</Tag>}
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
      <div style={{ marginTop: 10 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <span className="tiny muted">{selected}</span>
          <div className="spacer" />
          <span className="tiny muted">{daySells.length} 笔</span>
        </div>
        {daySells.length === 0 ? (
          <p className="tiny muted" style={{ margin: 0 }}>这天没有成交</p>
        ) : (
          daySells.map((s) => (
            <div key={s.id} className="line">
              <div className="left">
                <div className="t1" style={{ fontSize: 13 }}>
                  {s.stockName} · {price2(s.priceCents)} × {s.qty}
                </div>
                <div className="t2">行 {s.sourceRow} · 成本 {price2(s.costCents)}</div>
              </div>
              <div className={`right num ${tone(s.profitCents)}`} style={{ fontWeight: 700 }}>
                {signedMoney(s.profitCents)}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}

function price2(cents: number | null): string {
  return cents === null ? '—' : (cents / 100).toFixed(2)
}

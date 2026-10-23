import { useMemo, useState } from 'react'
import { Button, Card, Input, Select, Tabs, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { limitRange, type PriceLimitType } from '../domain/limit'
import { toCents } from '../domain/money'
import { downloadText, toCsv } from '../ui/csv'
import { money, price, qty, signedMoney } from '../ui/format'

const LIMIT_OPTIONS: { key: PriceLimitType; label: string }[] = [
  { key: 'main_10', label: '主板 10%' },
  { key: 'gem_20', label: '创业板 20%' },
  { key: 'star_20', label: '科创板 20%' },
  { key: 'bse_30', label: '北交所 30%' },
  { key: 'st_5', label: 'ST 5%' },
  { key: 'unknown', label: '未设置（阻断）' },
]

export function OrdersPage() {
  const { ledger, stocks } = useApp()
  const stockNames = ledger.byStock.map((s) => s.stockName)
  const [stockName, setStockName] = useState(stockNames[0] ?? '')
  const cfg = stocks.find((s) => s.name === stockName)
  const [lastClose, setLastClose] = useState('')
  const [limitType, setLimitType] = useState<PriceLimitType>(cfg?.priceLimitType ?? 'main_10')

  const effectiveStock = stockName || stockNames[0] || ''
  const range = useMemo(
    () => limitRange(toCents(lastClose), limitType, cfg?.customLimitPct ?? null),
    [lastClose, limitType, cfg],
  )

  const targets = ledger.targets.filter((t) => t.stockName === effectiveStock)
  const orders = ledger.orders.filter((o) => o.stockName === effectiveStock)
  const summary = ledger.byStock.find((s) => s.stockName === effectiveStock)

  const rebuyTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * (o.baseQty + o.rewardQty), 0)
  const rewardTotal = orders.reduce((a, o) => a + o.rebuyPriceCents * o.rewardQty, 0)
  const targetTotal = targets.reduce((a, t) => a + t.amountCents, 0)
  const availableProfit = ledger.groups
    .filter((g) => g.stockId === (summary?.stockId ?? ''))
    .reduce((a, g) => a + g.availableCents, 0)

  function zone(p: number): '区间内' | '无区间' | '越界' {
    if (!range) return '无区间'
    return p > range.upCents || p < range.downCents ? '越界' : '区间内'
  }

  function copyList() {
    const lines: string[] = [`${effectiveStock} 挂单清单`]
    if (orders.length) {
      lines.push('【待买】')
      for (const o of orders) {
        lines.push(`  行${o.sourceRow}  ${price(o.rebuyPriceCents)} × ${o.baseQty + o.rewardQty} 股（基础 ${o.baseQty} + 奖励 ${o.rewardQty}）`)
      }
    }
    if (targets.length) {
      lines.push('【待卖】')
      for (const t of targets) {
        lines.push(`  批次${t.lotId.replace('lot:', '')}  ${price(t.priceCents)} × ${t.qty} 股`)
      }
    }
    void navigator.clipboard?.writeText(lines.join('\n'))
    notificationOpen({ message: '清单已复制', type: 'success' })
  }

  function exportCsv() {
    const rows: (string | number)[][] = [['类型', '来源行', '价格', '股数', '金额', '区间']]
    for (const o of orders) {
      rows.push(['待买', o.sourceRow, price(o.rebuyPriceCents), o.baseQty + o.rewardQty, ((o.rebuyPriceCents * (o.baseQty + o.rewardQty)) / 100).toFixed(2), zone(o.rebuyPriceCents)])
    }
    for (const t of targets) {
      rows.push(['待卖', Number(t.lotId.replace('lot:', '')), price(t.priceCents), t.qty, (t.amountCents / 100).toFixed(2), zone(t.priceCents)])
    }
    downloadText(`${effectiveStock}-挂单清单.csv`, toCsv(rows), 'text/csv;charset=utf-8')
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
      <div className="page-title">
        <h2>挂单</h2>
        <div className="row" style={{ gap: 6 }}>
          <Button size="small" onClick={copyList}>复制</Button>
          <Button size="small" onClick={exportCsv}>CSV</Button>
        </div>
      </div>

      <Card>
        <div className="stack tight">
          <div className="row nowrap">
            <Select
              options={stockNames.map((s) => ({ key: s, label: s }))}
              value={effectiveStock}
              onChange={setStockName}
              aria-label="选择股票"
            />
            <Select
              options={LIMIT_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
              value={limitType}
              onChange={(v) => setLimitType(v as PriceLimitType)}
              aria-label="涨跌幅规则"
            />
          </div>
          <div className="row nowrap">
            <Input
              value={lastClose}
              onChange={(e) => setLastClose(e.target.value)}
              placeholder="昨收价，如 8.10"
              allowClear
              onClear={() => setLastClose('')}
              aria-label="昨收价"
            />
            <div style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {range ? (
                <>
                  <span className="down num">{price(range.downCents)}</span>
                  <span className="muted"> ~ </span>
                  <span className="up num">{price(range.upCents)}</span>
                </>
              ) : (
                <Tag size="small" variant="soft" color="app-red">无区间</Tag>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className="metrics">
          <div>
            <div className="k">待买总额</div>
            <div className="v" style={{ fontSize: 17 }}>{money(rebuyTotal)}</div>
            <div className="s">奖励占 {money(rewardTotal)}</div>
          </div>
          <div>
            <div className="k">待卖预期额</div>
            <div className="v" style={{ fontSize: 17 }}>{money(targetTotal)}</div>
            <div className="s">目标价 × 剩余</div>
          </div>
          <div>
            <div className="k">可分配余额</div>
            <div className="v" style={{ fontSize: 17 }}>{money(availableProfit)}</div>
            <div className="s">组池未动用</div>
          </div>
        </div>
      </Card>

      <Card>
        <Tabs
          aria-label="待买待卖清单"
          items={[
            {
              key: 'buy',
              label: `待买 ${orders.length}`,
              children:
                orders.length === 0 ? (
                  <div className="empty-box">该股没有待买单</div>
                ) : (
                  <div className="stack tight">
                    {orders.map((o) => {
                      const z = zone(o.rebuyPriceCents)
                      return (
                        <div key={o.id} className="line">
                          <div className="left">
                            <div className="t1 num">
                              {price(o.rebuyPriceCents)}
                              <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> × {qty(o.baseQty + o.rewardQty)} 股</span>
                            </div>
                            <div className="t2">
                              行{o.sourceRow} · 基础 {o.baseQty}
                              {o.rewardQty > 0 && ` + 奖励 ${o.rewardQty}`} · 组池 {money(o.grossProfitCents)} / {o.hands} 手
                            </div>
                            <div className="tag-row" style={{ marginTop: 4 }}>
                              <Tag size="small" variant="soft" color={o.exposure ? 'app-red' : 'app-teal'}>
                                {o.exposure ? '空头敞口' : '回补再买入'}
                              </Tag>
                              <Tag size="small" variant="soft" color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}>
                                {z}
                              </Tag>
                            </div>
                          </div>
                          <div className="right num" style={{ fontWeight: 600 }}>
                            {money(o.rebuyPriceCents * (o.baseQty + o.rewardQty))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ),
            },
            {
              key: 'sell',
              label: `待卖 ${targets.length}`,
              children:
                targets.length === 0 ? (
                  <div className="empty-box">该股批次已全部卖完</div>
                ) : (
                  <>
                    {targets.map((t) => {
                      const z = zone(t.priceCents)
                      const lot = ledger.lots.find((l) => l.id === t.lotId)
                      return (
                        <div key={t.id} className="line">
                          <div className="left">
                            <div className="t1 num">
                              {price(t.priceCents)}
                              <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> × {qty(t.qty)} 股</span>
                            </div>
                            <div className="t2">
                              批次 {t.lotId.replace('lot:', '')} · 买入 {price(lot?.buyPriceCents ?? null)}
                            </div>
                            <div className="tag-row" style={{ marginTop: 4 }}>
                              <Tag size="small" variant="soft" color={z === '区间内' ? 'app-green' : z === '无区间' ? 'default' : 'app-red'}>
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
                  </>
                ),
            },
          ]}
        />
      </Card>

      {summary && summary.exposureQty > 0 && (
        <Card>
          <p className="hint-block" style={{ margin: 0 }}>
            <b>敞口提示：</b>{summary.stockName} 可卖 {qty(summary.targetQty)} 股，净持仓 {qty(summary.netQty)} 股。
            待卖全部执行完，会有 <b style={{ color: 'var(--up)' }}>{qty(summary.exposureQty)} 股</b> 需要通过待买回补
            ——这部分不是持仓，是在加空。
          </p>
        </Card>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { limitRange, type PriceLimitType } from '../domain/limit'
import { toCents } from '../domain/money'
import { downloadText, toCsv } from '../ui/csv'
import { money, price, qty, signedMoney } from '../ui/format'

const LIMIT_OPTIONS: { value: PriceLimitType; label: string }[] = [
  { value: 'main_10', label: '主板 10%' },
  { value: 'gem_20', label: '创业板 20%' },
  { value: 'star_20', label: '科创板 20%' },
  { value: 'bse_30', label: '北交所 30%' },
  { value: 'st_5', label: 'ST 5%' },
  { value: 'unknown', label: '未设置（阻断）' },
]

export function OrdersPage() {
  const { ledger, stocks } = useApp()
  const [stockName, setStockName] = useState(ledger.byStock[0]?.stockName ?? '')
  const cfg = stocks.find((s) => s.name === stockName)
  const [lastClose, setLastClose] = useState('')
  const [limitType, setLimitType] = useState<PriceLimitType>(cfg?.priceLimitType ?? 'main_10')

  const effectiveStock = stockName || (ledger.byStock[0]?.stockName ?? '')
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
  }

  function exportCsv() {
    const rows: (string | number)[][] = [['类型', '来源行', '价格', '股数', '金额', '区间']]
    for (const o of orders) {
      rows.push(['待买', o.sourceRow, price(o.rebuyPriceCents), o.baseQty + o.rewardQty, (o.rebuyPriceCents * (o.baseQty + o.rewardQty) / 100).toFixed(2), zone(o.rebuyPriceCents)])
    }
    for (const t of targets) {
      rows.push(['待卖', Number(t.lotId.replace('lot:', '')), price(t.priceCents), t.qty, (t.amountCents / 100).toFixed(2), zone(t.priceCents)])
    }
    downloadText(`${effectiveStock}-挂单清单.csv`, toCsv(rows), 'text/csv;charset=utf-8')
  }

  function zone(p: number): string {
    if (!range) return '无区间'
    if (p > range.upCents) return '涨停外'
    if (p < range.downCents) return '跌停外'
    return '区间内'
  }

  if (ledger.targets.length === 0 && ledger.orders.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <strong>没有可挂的单</strong>
          先到「导入」页把交易记录写进本地。
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>挂单</h2>
          <p>选股 → 昨收价 → 确认涨跌幅 → 合法区间；改计划价不动真实成交（P8）</p>
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={copyList}>复制清单</button>
          <button className="btn ghost sm" onClick={exportCsv}>导出 CSV</button>
        </div>
      </div>

      <div className="card">
        <div className="body">
          <div className="row">
            <label className="field">
              股票
              <select value={effectiveStock} onChange={(e) => setStockName(e.target.value)}>
                {ledger.byStock.map((s) => (
                  <option key={s.stockName} value={s.stockName}>{s.stockName}</option>
                ))}
              </select>
            </label>
            <label className="field">
              昨收价（元）
              <input value={lastClose} onChange={(e) => setLastClose(e.target.value)} placeholder="如 8.10" />
            </label>
            <label className="field">
              涨跌幅
              <select value={limitType} onChange={(e) => setLimitType(e.target.value as PriceLimitType)}>
                {LIMIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <div className="spacer" />
            <div style={{ fontSize: 12.5 }}>
              {range ? (
                <>
                  <span className="muted">合法区间 </span>
                  <b className="down">{price(range.downCents)}</b>
                  <span className="muted"> ~ </span>
                  <b className="up">{price(range.upCents)}</b>
                  <span className="muted">（±{range.pct}%，四舍五入到分）</span>
                </>
              ) : (
                <span className="tag bad">昨收缺失或规则 unknown → 不出确定性建议</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="triad">
        <div className="metric">
          <div className="k">待买总额</div>
          <div className="v" style={{ fontSize: 22 }}>{money(rebuyTotal)}</div>
          <div className="s">其中奖励占 {money(rewardTotal)}</div>
        </div>
        <div className="metric">
          <div className="k">待卖预期额</div>
          <div className="v" style={{ fontSize: 22 }}>{money(targetTotal)}</div>
          <div className="s">目标价 × 剩余批次量</div>
        </div>
        <div className="metric">
          <div className="k">可分配余额</div>
          <div className="v" style={{ fontSize: 22 }}>{money(availableProfit)}</div>
          <div className="s">组池未动用额度（不构成「资金充足」结论）</div>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>待买 {orders.length} 条</h3>
          <span className="hint">只认 P 列非空（D3）；基础量 = 卖出量，奖励量来自组池</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th>来源行</th>
                <th>回补价</th>
                <th>基础</th>
                <th>奖励</th>
                <th>合计</th>
                <th>金额</th>
                <th>组池 / 手数</th>
                <th className="l">区间</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const z = zone(o.rebuyPriceCents)
                return (
                  <tr key={o.id}>
                    <td className="num muted">{o.sourceRow}</td>
                    <td className="num">{price(o.rebuyPriceCents)}</td>
                    <td className="num">{qty(o.baseQty)}</td>
                    <td className="num">{o.rewardQty ? <span className="tag ok">{qty(o.rewardQty)}</span> : '0'}</td>
                    <td className="num">{qty(o.baseQty + o.rewardQty)}</td>
                    <td className="num">{money(o.rebuyPriceCents * (o.baseQty + o.rewardQty))}</td>
                    <td className="num muted">
                      {money(o.grossProfitCents)} / {o.hands} 手
                    </td>
                    <td className="l">
                      <span className={z === '区间内' ? 'tag ok' : z === '无区间' ? 'tag' : 'tag bad'}>{z}</span>
                    </td>
                  </tr>
                )
              })}
              {orders.length === 0 && (
                <tr><td colSpan={8} className="l muted" style={{ padding: 20 }}>该股没有待买单</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>待卖 {targets.length} 条 · {qty(targets.reduce((a, t) => a + t.qty, 0))} 股</h3>
          <span className="hint">量不超批次剩余；预期收益不进已实现盈利</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th>批次行</th>
                <th>买入价</th>
                <th>目标价</th>
                <th>股数</th>
                <th>金额</th>
                <th>预期收益</th>
                <th className="l">区间</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => {
                const z = zone(t.priceCents)
                const lot = ledger.lots.find((l) => l.id === t.lotId)
                return (
                  <tr key={t.id}>
                    <td className="num muted">{t.lotId.replace('lot:', '')}</td>
                    <td className="num">{price(lot?.buyPriceCents ?? null)}</td>
                    <td className="num">{price(t.priceCents)}</td>
                    <td className="num">{qty(t.qty)}</td>
                    <td className="num">{money(t.amountCents)}</td>
                    <td className="num up">{signedMoney(t.expectProfitCents)}</td>
                    <td className="l">
                      <span className={z === '区间内' ? 'tag ok' : z === '无区间' ? 'tag' : 'tag bad'}>{z}</span>
                    </td>
                  </tr>
                )
              })}
              {targets.length === 0 && (
                <tr><td colSpan={7} className="l muted" style={{ padding: 20 }}>该股没有待卖单（批次已全部卖完）</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="l" colSpan={3}>合计</td>
                <td className="num">{qty(targets.reduce((a, t) => a + t.qty, 0))}</td>
                <td className="num">{money(targetTotal)}</td>
                <td className="num">{signedMoney(targets.reduce((a, t) => a + t.expectProfitCents, 0))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {summary && summary.exposureQty > 0 && (
        <div className="card">
          <div className="body note">
            <b>敞口提示：</b>{summary.stockName} 可卖 {qty(summary.targetQty)} 股，净持仓 {qty(summary.netQty)} 股。
            把待卖全部执行完，会有 <b className="up">{qty(summary.exposureQty)} 股</b> 需要通过待买回补——这部分不是持仓，是在加空。
          </div>
        </div>
      )}
    </>
  )
}

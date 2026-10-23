import { useApp } from '../store/useApp'
import { money, qty, signedMoney, tone } from '../ui/format'

export function StatsPage() {
  const { ledger } = useApp()
  const t = ledger.totals

  return (
    <>
      <div className="page-head">
        <div>
          <h2>统计</h2>
          <p>按卖出日期归月；缺日期的单独一桶，不混入月度（R6）</p>
        </div>
        <span className="tag">实现盈利 {signedMoney(t.profitCents)}</span>
      </div>

      <div className="card">
        <header>
          <h3>月度成交</h3>
          <span className="hint">未扣佣金与印花税</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">月份</th>
                <th>卖出笔数</th>
                <th>卖出股数</th>
                <th>卖出金额</th>
                <th>实现盈利</th>
                <th>收益率</th>
              </tr>
            </thead>
            <tbody>
              {ledger.monthly.map((m) => (
                <tr key={m.month}>
                  <td className="l">
                    {m.month}
                    {m.dateMissing && <span className="tag warn" style={{ marginLeft: 8 }}>待补日期</span>}
                  </td>
                  <td className="num">{m.sellCount}</td>
                  <td className="num">{qty(m.sellQty)}</td>
                  <td className="num">{money(m.sellAmountCents)}</td>
                  <td className={`num ${tone(m.profitCents)}`}>{signedMoney(m.profitCents)}</td>
                  <td className="num muted">
                    {m.sellAmountCents ? `${((m.profitCents / m.sellAmountCents) * 100).toFixed(2)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="l">合计</td>
                <td className="num">{t.sellCount}</td>
                <td className="num">{qty(t.sellQty)}</td>
                <td className="num">{money(t.sellAmountCents)}</td>
                <td className={`num ${tone(t.profitCents)}`}>{signedMoney(t.profitCents)}</td>
                <td className="num muted">
                  {t.sellAmountCents ? `${((t.profitCents / t.sellAmountCents) * 100).toFixed(2)}%` : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>按股票</h3>
          <span className="hint">买入 / 卖出 / 待卖 / 敞口</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">股票</th>
                <th>买入股数</th>
                <th>买入金额</th>
                <th>卖出股数</th>
                <th>卖出金额</th>
                <th>实现盈利</th>
                <th>待卖股数</th>
                <th>待买股数</th>
                <th>净持仓</th>
              </tr>
            </thead>
            <tbody>
              {ledger.byStock.map((s) => (
                <tr key={s.stockName}>
                  <td className="l">{s.stockName}</td>
                  <td className="num">{qty(s.buyQty)}</td>
                  <td className="num">{money(s.buyAmountCents)}</td>
                  <td className="num">{qty(s.sellQty)}</td>
                  <td className="num">{money(s.sellAmountCents)}</td>
                  <td className={`num ${tone(s.profitCents)}`}>{signedMoney(s.profitCents)}</td>
                  <td className="num">{qty(s.targetQty)}</td>
                  <td className="num">{qty(s.rebuyQty)}</td>
                  <td className="num">{qty(s.netQty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>组池（同股同回补价）</h3>
          <span className="hint">R4 全部真实卖出入池，含已回补的</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">分组</th>
                <th>组池盈利</th>
                <th>每手成本</th>
                <th>容量（手）</th>
                <th>已授予（手）</th>
                <th>未动用额度</th>
              </tr>
            </thead>
            <tbody>
              {ledger.groups.map((g) => (
                <tr key={g.groupKey}>
                  <td className="l mono" style={{ fontSize: 12 }}>{g.groupKey.replace('stock:', '')}</td>
                  <td className={`num ${tone(g.grossProfitCents)}`}>{money(g.grossProfitCents)}</td>
                  <td className="num">{money(g.lotCostCents)}</td>
                  <td className="num">{g.capacityHands}</td>
                  <td className="num">{g.grantedHands}</td>
                  <td className="num">{money(g.availableCents)}</td>
                </tr>
              ))}
              {ledger.groups.length === 0 && (
                <tr><td colSpan={6} className="l muted" style={{ padding: 20 }}>没有可分配的组池</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

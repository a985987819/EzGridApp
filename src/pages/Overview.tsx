import { useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { CheckGrid } from '../components/CheckGrid'
import { PriceGrid } from '../components/PriceGrid'
import { money, qty, signedMoney, tone } from '../ui/format'

export function Overview({ onPick }: { onPick: (stock: string, priceCents: number) => void }) {
  const { ledger, baseline, records, basename } = useApp()
  const [active, setActive] = useState('')
  const t = ledger.totals
  const failed = baseline.filter((c) => !c.ok).length
  const current = useMemo(
    () => ledger.byStock.find((s) => s.stockName === active) ?? ledger.byStock.find((s) => s.rows > 0),
    [ledger.byStock, active],
  )

  if (records.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <strong>还没有导入数据</strong>
          到「导入」页选 26 年网格记录的 xlsx，先看 dry-run 报告，再写入本地。
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>概览</h2>
          <p>
            数据源 {basename} · 有效 {t.rows} 行 · 只读第 1 表「交易记录」
          </p>
        </div>
        <span className={failed ? 'tag bad' : 'tag ok'}>
          {failed ? `基准 ${baseline.length - failed}/${baseline.length}` : '基准全中'}
        </span>
      </div>

      <div className="triad">
        <div className="metric">
          <div className="k">可卖批次剩余</div>
          <div className="v">{qty(t.targetQty)}</div>
          <div className="s">待卖清单合计，理论上能卖出去的上限</div>
        </div>
        <div className="metric warn">
          <div className="k">待回补欠账</div>
          <div className="v">{qty(t.exposureQty)}</div>
          <div className="s">先卖后买造成的空头敞口，{t.rebuyCount} 条待买</div>
        </div>
        <div className="metric ok">
          <div className="k">净持仓</div>
          <div className="v">{qty(t.netQty)}</div>
          <div className="s">买入 − 卖出，真实持有的净头寸</div>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>数量守恒（R7，每次重算都跑）</h3>
          <span className="hint">任何一格红灯说明算法在悄悄改数</span>
        </header>
        <div className="body">
          <CheckGrid checks={ledger.checks} compact />
        </div>
      </div>

      <div className="card">
        <header>
          <h3>基准快照（文档 §03 / S2 验收）</h3>
          <span className="hint">
            实现盈利 {signedMoney(t.profitCents)} · 卖出 {money(t.sellAmountCents)}
          </span>
        </header>
        <div className="body">
          <CheckGrid checks={baseline} />
        </div>
      </div>

      <div className="card">
        <header>
          <h3>逐股票总账</h3>
          <span className="hint">成交价按 E 列口径（D1）</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">股票</th>
                <th>行数</th>
                <th>买入股数</th>
                <th>买入金额</th>
                <th>卖出笔数</th>
                <th>卖出股数</th>
                <th>卖出金额</th>
                <th>实现盈利</th>
                <th>待卖股数</th>
              </tr>
            </thead>
            <tbody>
              {ledger.byStock.map((s) => (
                <tr key={s.stockName}>
                  <td className="l">{s.stockName}</td>
                  <td className="num">{s.rows}</td>
                  <td className="num">{qty(s.buyQty)}</td>
                  <td className="num">{money(s.buyAmountCents)}</td>
                  <td className="num">{s.sellCount}</td>
                  <td className="num">{qty(s.sellQty)}</td>
                  <td className="num">{money(s.sellAmountCents)}</td>
                  <td className={`num ${tone(s.profitCents)}`}>{signedMoney(s.profitCents)}</td>
                  <td className="num">{qty(s.targetQty)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="l">合计</td>
                <td className="num">{t.rows}</td>
                <td className="num">{qty(t.buyQty)}</td>
                <td className="num">{money(t.buyAmountCents)}</td>
                <td className="num">{t.sellCount}</td>
                <td className="num">{qty(t.sellQty)}</td>
                <td className="num">{money(t.sellAmountCents)}</td>
                <td className={`num ${tone(t.profitCents)}`}>{signedMoney(t.profitCents)}</td>
                <td className="num">{qty(t.targetQty)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>股票明细</h3>
          <span className="hint">按股票分页看价格网格；点任意价格跳到明细</span>
        </header>
        <div className="body">
          <div className="tabs">
            {ledger.byStock.map((s) => (
              <button
                key={s.stockName}
                className={`tab${(active || ledger.byStock[0]?.stockName) === s.stockName ? ' active' : ''}`}
                onClick={() => setActive(s.stockName)}
              >
                {s.stockName}
                <span className="n">{s.rows} 行 · 待卖 {qty(s.targetQty)}</span>
              </button>
            ))}
          </div>
          {current && (
            <>
              <div className="mini">
                <div>
                  <div className="k">可卖</div>
                  <div className="v">{qty(current.targetQty)}</div>
                </div>
                <div>
                  <div className="k">待补</div>
                  <div className="v">{qty(current.exposureQty)}</div>
                </div>
                <div>
                  <div className="k">净持仓</div>
                  <div className="v">{qty(current.netQty)}</div>
                </div>
                <div>
                  <div className="k">已实现盈利</div>
                  <div className={`v ${tone(current.profitCents)}`}>{signedMoney(current.profitCents)}</div>
                </div>
              </div>
              <PriceGrid stock={current} onPick={(p) => onPick(current.stockName, p)} />
            </>
          )}
          {t.exposureQty > 0 && (
            <p className="note" style={{ marginBottom: 0, marginTop: 12 }}>
              <b>卖满提示：</b>把 {qty(t.targetQty)} 股全部卖出后，这个组合还会有 {qty(t.exposureQty)} 股待回补敞口，
              待买清单必须一直在视野里。
            </p>
          )}
        </div>
      </div>
    </>
  )
}

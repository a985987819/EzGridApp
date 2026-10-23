import { useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { isoDate, money, price, qty, signedMoney, tone } from '../ui/format'
import { downloadText, toCsv } from '../ui/csv'
import type { Lot, SellExecution } from '../domain/types'

type StatusFilter = 'all' | 'holding' | 'soldout' | 'pending' | 'dateMissing' | 'needsPrice'

interface Row {
  sourceRow: number
  stockName: string
  lot: Lot | null
  sell: SellExecution | null
}

export function TradesPage({
  focus,
  onClearFocus,
}: {
  focus: { stock: string; priceCents: number } | null
  onClearFocus: () => void
}) {
  const { ledger, records } = useApp()
  const [stockFilter, setStockFilter] = useState(focus?.stock ?? 'all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [priceFilter, setPriceFilter] = useState<number | null>(focus?.priceCents ?? null)

  const stocks = useMemo(() => [...new Set(records.map((r) => r.stockName))], [records])

  const rows = useMemo<Row[]>(() => {
    const lotMap = new Map(ledger.lots.map((l) => [l.sourceRow, l]))
    const sellMap = new Map(ledger.sells.map((s) => [s.sourceRow, s]))
    return records
      .map((r) => ({ sourceRow: r.sourceRow, stockName: r.stockName, lot: lotMap.get(r.sourceRow) ?? null, sell: sellMap.get(r.sourceRow) ?? null }))
      .sort((a, b) => b.sourceRow - a.sourceRow)
  }, [records, ledger])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (stockFilter !== 'all' && r.stockName !== stockFilter) return false
      if (keyword && !String(r.sourceRow).includes(keyword) && !r.stockName.includes(keyword)) return false
      if (priceFilter !== null) {
        const prices = [r.lot?.targetPriceCents, r.sell?.priceCents, r.lot?.buyPriceCents, r.sell?.costCents]
        if (!prices.includes(priceFilter)) return false
      }
      switch (status) {
        case 'holding':
          return (r.lot?.remainingQty ?? 0) > 0
        case 'soldout':
          return r.sell !== null && (r.lot?.remainingQty ?? 0) === 0
        case 'pending':
          return r.sell?.rebuyStatus === 'pending'
        case 'dateMissing':
          return r.sell?.dateMissing === true
        case 'needsPrice':
          return r.sell?.priceCents === null || r.lot?.needsPrice === true
        default:
          return true
      }
    })
  }, [rows, stockFilter, keyword, priceFilter, status])

  function exportCsv() {
    const head = ['行号', '股票', '买入日期', '买入价', '买入份额', '已卖', '剩余', '目标售价', '卖出日期', '成交价', '成本', '实现盈利', '回补状态', '标记']
    const body = filtered.map((r) => [
      r.sourceRow,
      r.stockName,
      isoDate(r.lot?.buyDate ?? null),
      r.lot ? price(r.lot.buyPriceCents) : '',
      r.lot?.qty ?? '',
      r.sell?.qty ?? '',
      r.lot?.remainingQty ?? '',
      price(r.lot?.targetPriceCents ?? r.sell?.priceCents ?? null),
      r.sell ? isoDate(r.sell.soldAt) : '',
      price(r.sell?.priceCents ?? null),
      price(r.sell?.costCents ?? null),
      r.sell?.profitCents === null || r.sell?.profitCents === undefined ? '' : (r.sell.profitCents / 100).toFixed(2),
      r.sell ? (r.sell.rebuyStatus === 'pending' ? '待回补' : '已回补') : '',
      [r.sell?.sellBeforeBuy ? '先卖后买' : '', r.sell?.dateMissing ? '缺日期' : '', r.sell?.priceCents === null && r.sell ? '缺价格' : ''].filter(Boolean).join(' '),
    ])
    downloadText('交易明细.csv', toCsv([head, ...body]), 'text/csv;charset=utf-8')
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>明细</h2>
          <p>
            {filtered.length} / {rows.length} 行 · 一行 = 一个买入批次，卖出记在同一行（G 列实现份数）
          </p>
        </div>
        <button className="btn ghost sm" onClick={exportCsv}>
          导出当前筛选 CSV
        </button>
      </div>

      <div className="card">
        <div className="body">
          <div className="row">
            <label className="field">
              股票
              <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}>
                <option value="all">全部</option>
                {stocks.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              状态
              <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="all">全部</option>
                <option value="holding">还有剩余持仓</option>
                <option value="soldout">已卖完</option>
                <option value="pending">待回补</option>
                <option value="dateMissing">缺卖出日期</option>
                <option value="needsPrice">缺价格</option>
              </select>
            </label>
            <label className="field">
              关键词
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="股票名 / 行号" />
            </label>
            {priceFilter !== null && (
              <button className="btn sm" onClick={() => { setPriceFilter(null); onClearFocus() }}>
                价格 {(priceFilter / 100).toFixed(2)} ×
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="body tight" style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead>
              <tr>
                <th>行</th>
                <th className="l">股票</th>
                <th>买入日期</th>
                <th>买入价</th>
                <th>份额</th>
                <th>已卖</th>
                <th>剩余</th>
                <th>目标价</th>
                <th>卖出日期</th>
                <th>成交价</th>
                <th>成本</th>
                <th>实现盈利</th>
                <th className="l">回补</th>
                <th className="l">标记</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.sourceRow}>
                  <td className="num muted">{r.sourceRow}</td>
                  <td className="l">{r.stockName}</td>
                  <td className="num">{isoDate(r.lot?.buyDate ?? null)}</td>
                  <td className="num">{r.lot ? price(r.lot.buyPriceCents) : '—'}</td>
                  <td className="num">{r.lot ? qty(r.lot.qty) : '—'}</td>
                  <td className="num">{r.sell ? qty(r.sell.qty) : '—'}</td>
                  <td className="num">{r.lot ? qty(r.lot.remainingQty) : '—'}</td>
                  <td className="num">{price(r.lot?.targetPriceCents ?? r.sell?.priceCents ?? null)}</td>
                  <td className="num">{r.sell ? isoDate(r.sell.soldAt) : '—'}</td>
                  <td className="num">{price(r.sell?.priceCents ?? null)}</td>
                  <td className="num">{price(r.sell?.costCents ?? null)}</td>
                  <td className={`num ${tone(r.sell?.profitCents ?? null)}`}>{signedMoney(r.sell?.profitCents ?? null)}</td>
                  <td className="l">
                    {r.sell ? (
                      <span className={r.sell.rebuyStatus === 'pending' ? 'tag warn' : 'tag'}>
                        {r.sell.rebuyStatus === 'pending' ? '待回补' : '已回补'}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="l">
                    <span className="pill-row">
                      {r.sell?.sellBeforeBuy && <span className="tag warn">先卖后买</span>}
                      {r.sell?.dateMissing && <span className="tag warn">缺日期</span>}
                      {r.sell && r.sell.priceCents === null && <span className="tag bad">缺价格</span>}
                      {r.lot?.needsPrice && <span className="tag bad">缺目标价</span>}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td className="l muted" colSpan={14} style={{ textAlign: 'center', padding: 24 }}>
                    没有匹配的行
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="l" colSpan={4}>
                  合计 {filtered.length} 行
                </td>
                <td className="num">{qty(filtered.reduce((a, r) => a + (r.lot?.qty ?? 0), 0))}</td>
                <td className="num">{qty(filtered.reduce((a, r) => a + (r.sell?.qty ?? 0), 0))}</td>
                <td className="num">{qty(filtered.reduce((a, r) => a + (r.lot?.remainingQty ?? 0), 0))}</td>
                <td colSpan={4} />
                <td className="num">{money(filtered.reduce((a, r) => a + (r.sell?.profitCents ?? 0), 0))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </>
  )
}

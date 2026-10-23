import { useMemo } from 'react'
import { money, qty } from '../ui/format'
import { useApp } from '../store/useApp'
import type { StockSummary } from '../domain/types'

interface Level {
  priceCents: number
  soldQty: number
  soldCount: number
  targetQty: number
  rebuyQty: number
}

/** 价格网格：左买（绿）右卖（红），价格高 → 低（P12） */
export function PriceGrid({
  stock,
  onPick,
}: {
  stock: StockSummary
  onPick: (priceCents: number) => void
}) {
  const { ledger } = useApp()

  const levels = useMemo(() => {
    const map = new Map<number, Level>()
    const get = (p: number) => {
      let l = map.get(p)
      if (!l) {
        l = { priceCents: p, soldQty: 0, soldCount: 0, targetQty: 0, rebuyQty: 0 }
        map.set(p, l)
      }
      return l
    }
    for (const s of ledger.sells) {
      if (s.stockName !== stock.stockName || s.priceCents === null) continue
      const l = get(s.priceCents)
      l.soldQty += s.qty
      l.soldCount += 1
    }
    for (const t of ledger.targets) {
      if (t.stockName !== stock.stockName) continue
      get(t.priceCents).targetQty += t.qty
    }
    for (const o of ledger.orders) {
      if (o.stockName !== stock.stockName) continue
      get(o.rebuyPriceCents).rebuyQty += o.baseQty + o.rewardQty
    }
    return [...map.values()].sort((a, b) => b.priceCents - a.priceCents)
  }, [ledger, stock.stockName])

  if (levels.length === 0) return <div className="empty-box">这只票还没有价格档位</div>

  return (
    <>
      <div className="table-wrap">
        <table className="pricegrid">
          <thead>
            <tr>
              <th className="c">回补 / 买</th>
              <th className="c">价格</th>
              <th className="c">待卖 / 卖</th>
              <th className="c">已卖出</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.priceCents} onClick={() => onPick(l.priceCents)}>
                <td className="c down">{l.rebuyQty ? `${qty(l.rebuyQty)} 股` : '—'}</td>
                <td className="px">{(l.priceCents / 100).toFixed(2)}</td>
                <td className="c up">{l.targetQty ? `${qty(l.targetQty)} 股` : '—'}</td>
                <td className="c muted">{l.soldCount ? `${l.soldCount} 笔 / ${qty(l.soldQty)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tiny muted" style={{ margin: '8px 0 0' }}>
        目标金额 {money(stock.targetAmountCents)} · 预期收益 {money(stock.expectProfitCents)} · 点价格看明细
      </p>
    </>
  )
}

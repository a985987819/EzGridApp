import { useMemo, useState } from 'react'
import { Button, Card, Tag } from 'animal-island-ui'
import { buildChipDistribution } from '../domain/chipDistribution'
import type { BookingReceipt } from '../domain/booking'
import type { Ledger, RawRecord, RebuyExecution } from '../domain/types'
import { buildNanoIdIndex } from '../ui/nanoid'
import { buildTradeSourceIndex, tradeSourceLink, type TradeSourceLink } from '../ui/tradeLinks'
import type { TradesQuery } from '../ui/nav'
import { price, qty } from '../ui/format'

function priceRange(lo: number, hi: number): string {
  return lo === hi ? `${price(lo)} 元` : `${price(lo)}–${price(hi)} 元`
}
function share(value: number, total: number): string {
  return total > 0 ? `${(value * 100 / total).toFixed(1)}%` : '—'
}
function DistributionSources({ link, action, preview, goTrades }: {
  link: TradeSourceLink; action: string; preview: boolean; goTrades: (query: TradesQuery) => void
}) {
  return <Button type="text" size="small" disabled={!link.query} data-action={action} data-source-rows={link.rows.join(',')}
    onClick={() => { if (link.query) goTrades(link.query) }}>
    {link.query ? `查看 ${link.rows.length} 笔来源` : preview ? '含模拟来源 · 未写入明细' : '来源暂不可查看'}
  </Button>
}

export function ChipDistributionSection({ stockName, ledger, records, realRecords, executions, receipts, intervalCents, preview, goTrades }: {
  stockName: string
  ledger: Pick<Ledger, 'lots' | 'sells'>
  records: readonly RawRecord[]
  realRecords: readonly RawRecord[]
  executions: readonly RebuyExecution[]
  receipts: readonly BookingReceipt[]
  intervalCents?: number | null
  preview: boolean
  goTrades: (query: TradesQuery) => void
}) {
  const distribution = useMemo(() => buildChipDistribution({ stockName, ledger, records, executions, receipts, intervalCents }),
    [stockName, ledger, records, executions, receipts, intervalCents])
  const nano = useMemo(() => buildNanoIdIndex(realRecords), [realRecords])
  const sourceIndex = useMemo(() => buildTradeSourceIndex(nano, ledger.lots, executions), [nano, ledger.lots, executions])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [visibleLevels, setVisibleLevels] = useState(10)
  const hot = distribution.hotTrades
  const holding = distribution.heavyHoldings
  const sourceLink = (rows: readonly number[]) => tradeSourceLink(stockName, rows, sourceIndex)
  let tradeMaximum = 1, holdingMaximum = 1
  for (const level of distribution.levels) {
    tradeMaximum = Math.max(tradeMaximum, level.tradeCount)
    holdingMaximum = Math.max(holdingMaximum, level.holdingQty)
  }

  return <Card>
    <section className="chip-distribution" data-testid="overview-chip-distribution" data-stock={stockName} data-preview={preview ? '1' : '0'}
      data-total-trade-count={distribution.totalTradeCount} data-total-holding-qty={distribution.totalHoldingQty}>
      <div className="sec-head"><strong>筹码分布</strong><span className="sec-sub">{stockName}</span><div className="spacer" />
        {preview && <Tag size="small" variant="soft" color="purple">沙盒预览 · 含模拟</Tag>}</div>
      <p className="tiny muted chip-basis">本地台账 · 全部历史买卖 · {distribution.widthCents > 0 ? `区间最大跨度 ${price(distribution.widthCents)} 元（1个网格间隔）` : '未配置有效间隔，按同价统计'}</p>

      <div className="chip-summaries">
        <div className="chip-summary is-trades" data-testid="chip-hot-range" data-lo={hot?.loCents} data-hi={hot?.hiCents}
          data-count={hot?.count ?? 0} data-qty={hot?.qty ?? 0} data-total={distribution.totalTradeCount}>
          <h3>成交最高频次范围为</h3>
          <strong className="chip-range num">{hot ? priceRange(hot.loCents, hot.hiCents) : '暂无有价格的成交'}</strong>
          {hot ? <>
            <p><b>{qty(hot.count)} 笔</b><span>占有效成交 {share(hot.count, distribution.totalTradeCount)}</span></p>
            <p className="tiny muted">买入 {hot.buyCount} 笔 · 卖出 {hot.sellCount} 笔 · 累计成交 {qty(hot.qty)} 股</p>
            <DistributionSources link={sourceLink(hot.sourceRows)} action="chip-hot-sources" preview={preview} goTrades={goTrades} />
          </> : <p className="tiny muted">录入真实买卖后统计；没有明确成交价的记录暂不计入。</p>}
        </div>
        <div className="chip-summary is-holdings" data-testid="chip-holding-range" data-lo={holding?.loCents} data-hi={holding?.hiCents}
          data-count={holding?.lotCount ?? 0} data-qty={holding?.qty ?? 0} data-total={distribution.totalHoldingQty}>
          <h3>大量未完成买单范围</h3>
          <strong className="chip-range num">{holding ? priceRange(holding.loCents, holding.hiCents) : '暂无未完成买单'}</strong>
          {holding ? <>
            <p><b>剩余 {qty(holding.qty)} 股</b><span>占剩余库存 {share(holding.qty, distribution.totalHoldingQty)}</span></p>
            <p className="tiny muted">{holding.lotCount} 个批次 · 按实际买入成本归档</p>
            <DistributionSources link={sourceLink(holding.sourceRows)} action="chip-holding-sources" preview={preview} goTrades={goTrades} />
          </> : <p className="tiny muted">当前没有仍待卖出的有效买入批次。</p>}
        </div>
      </div>

      <p className="tiny muted chip-basis">{preview ? '含未落库模拟买卖与库存。' : ''}成交按笔数，未完成买单按剩余股数找最集中区间；本次纳入 {qty(distribution.totalTradeCount)} 笔成交、{qty(distribution.totalHoldingQty)} 股剩余。</p>
      {distribution.excludedTradeCount > 0 && <p className="tiny chip-excluded">另有 {distribution.excludedTradeCount} 笔缺少明确有效的成交价或数量，未纳入频次统计。</p>}

      <details className="chip-levels" data-testid="chip-distribution-details" onToggle={event => setDetailsOpen(event.currentTarget.open)}>
        <summary>查看价位分布 · {distribution.levels.length} 档</summary>
        {detailsOpen && <>
          <p className="tiny muted">实际价位从低到高；柱长分别按各列最大值比较。点数字查看对应来源。</p>
          <div className="chip-level-head"><span>价格（元）</span><span>成交次数</span><span>剩余股数</span></div>
          {distribution.levels.slice(0, visibleLevels).map(level => {
            const trade = sourceLink(level.tradeRows)
            const inventory = sourceLink(level.holdingRows)
            return <div className="chip-level" key={level.priceCents} data-chip-price={level.priceCents}
              data-trade-count={level.tradeCount} data-holding-qty={level.holdingQty}>
              <span className="num">{price(level.priceCents)}</span>
              <button type="button" className="chip-level-cell is-trades" disabled={level.tradeCount === 0 || !trade.query}
                aria-label={`查看 ${price(level.priceCents)} 元的 ${level.tradeCount} 笔成交来源`}
                onClick={() => { if (trade.query) goTrades(trade.query) }}>
                <i aria-hidden style={{ width: `${level.tradeCount / tradeMaximum * 100}%` }} /><span className="num">{qty(level.tradeCount)} 次</span>
              </button>
              <button type="button" className="chip-level-cell is-holdings" disabled={level.holdingQty === 0 || !inventory.query}
                aria-label={`查看 ${price(level.priceCents)} 元剩余 ${level.holdingQty} 股的来源`}
                onClick={() => { if (inventory.query) goTrades(inventory.query) }}>
                <i aria-hidden style={{ width: `${level.holdingQty / holdingMaximum * 100}%` }} /><span className="num">{qty(level.holdingQty)} 股</span>
              </button>
            </div>
          })}
          {visibleLevels < distribution.levels.length && <Button size="small" type="text" data-action="chip-more-levels" onClick={() => setVisibleLevels(count => count + 20)}>再看 {Math.min(20, distribution.levels.length - visibleLevels)} 档</Button>}
        </>}
      </details>
      <details className="chip-method"><summary>统计口径</summary><p>同一笔成交分配到多个来源只计一次，历史同行买入与卖出各计一次。未完成买单取仍未卖出的批次剩余份额，含回补批次；挂单目标价和改单不影响成本分布。</p>
        <p>在最大跨度内寻找最集中的实际价位，不要求成交日期连续。成交笔数并列时依次比较成交股数、跨度更窄、价格更低；剩余股数并列时依次比较批次数、跨度更窄、价格更低。「大量」表示本股剩余股数最集中的范围。</p></details>
    </section>
  </Card>
}

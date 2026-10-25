import { useMemo, useState } from 'react'
import { Button, Card, Tag } from 'animal-island-ui'
import { activeStockNames } from '../domain/stocks'
import type { StockSummary } from '../domain/types'
import { useApp } from '../store/useApp'
import { TreeTrunk } from '../components/TreeTrunk'
import { money, price, qty, signedMoney, tone } from '../ui/format'
import type { TradesQuery } from '../ui/nav'

export function Overview({
  goTrades,
  goManage,
}: {
  goTrades: (q: TradesQuery) => void
  goManage: () => void
}) {
  const { ledger, baseline, records, basename, stocks, lastBackupAt, ordersSession } = useApp()
  const [active, setActive] = useState('')
  const [openMetric, setOpenMetric] = useState<'target' | 'exposure' | 'net' | null>(null)
  const t = ledger.totals
  const failed = baseline.filter((c) => !c.ok).length
  const backupDays = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null
  const backupStale = backupDays === null || backupDays >= 7
  // 跨数据跳转：待补日期 N 笔 → 明细里只看缺卖出日期的行
  const missingDateCount = ledger.anomalies.filter((a) => a.kind === 'dateMissing').length

  const enabledNames = useMemo(() => activeStockNames(stocks), [stocks])
  const withRows = useMemo<StockSummary[]>(() => {
    const byName = new Map(ledger.byStock.map((s) => [s.stockName, s]))
    const out: StockSummary[] = []
    for (const name of enabledNames) {
      const s = byName.get(name)
      if (s && s.rows > 0) out.push(s)
    }
    return out
  }, [ledger.byStock, enabledNames])
  const hasData = records.some((r) => !r.deletedAt)
  if (!hasData) {
    return (
      <Card>
        <div className="empty-box">
          <strong>还没有导入数据</strong>
          去「管理 · 导入」选 26 年网格记录的 xlsx，先看 dry-run 报告，再写入本地。
        </div>
        <Button type="primary" block onClick={goManage}>
          去导入
        </Button>
      </Card>
    )
  }

  const hiddenCount = ledger.byStock.filter((s) => s.rows > 0 && !enabledNames.includes(s.stockName)).length
  const current = withRows.find((s) => s.stockName === active) ?? withRows[0]
  // V9.28 当前股票概述：今年共卖 x 次（真实卖出，不含挂钩暂记）。
  // 早退（无数据）之后才到这里，不能用 useMemo——过滤量小，直接算
  const yearSellCount = current
    ? ledger.sells.filter(
        (s) =>
          s.stockName === current.stockName &&
          s.hedgedFromSellRow === undefined &&
          (s.soldAt ?? '').startsWith(String(new Date().getFullYear())),
      ).length
    : 0
  // 数轴标记：已确认昨收（挂单页）与理想可卖到的股价（= 最高待卖目标价，V9.29）
  const closeCents = current ? ordersSession.confirmedCents[current.stockName] ?? null : null
  /** 被高位挂住（盈利暂缓）的卖出笔数（V9.33） */
  const holdCount = current
    ? ledger.sells.filter((s) => s.stockName === current.stockName && s.hedgedHold === true).length
    : 0

  return (
    <div className="stack">
      {/* V9.28.1 概览：选股卡置顶 + 树填满首屏剩余空间；全局指标块沉底 */}
      {current && (
        <div className="overview-top">
        <Card className="stock-panel">
          <div className="sec-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <div className="row">
              <strong>选股 · 当前股票汇总</strong>
              <div className="spacer" />
              <span className="sec-sub">点枝跳明细 · 树在下方</span>
            </div>
            <div className="stock-tabs">
              {withRows.map((s) => (
                <Tag
                  key={s.stockName}
                  size="medium"
                  variant={current?.stockName === s.stockName ? 'solid' : 'soft'}
                  color={current?.stockName === s.stockName ? 'app-teal' : 'default'}
                  onClick={() => setActive(s.stockName)}
                >
                  {s.stockName}
                </Tag>
              ))}
            </div>
          </div>
          <div className="stack tight">
            {/* V9.28 当前股票概述四项：已实现盈利 / 理想可卖到 / 理想剩余可赚 / 今年共卖 */}
            <div className="grid-4 metric-strip">
              <div>
                <div className="k">已实现盈利</div>
                {/* V9.33：被高位挂住的裸卖盈利暂缓，合计里就没算它们——给一句提示免得以为数据丢了 */}
                <div className={`v long ${tone(current.profitCents)}`}>
                  {signedMoney(current.profitCents)}
                  {holdCount > 0 && <span className="tiny muted"> 含 {holdCount} 笔暂缓</span>}
                </div>
              </div>
              <div>
                <div className="k">理想可卖到</div>
                {/* V9.29 用户拍板：由金额改股价（最高待卖目标价）——同一条数轴上能看到它的位置 */}
                <div className="v long">
                  {price(current.targetMaxPriceCents)}
                  {current.targetMaxPriceCents != null && <span className="tiny muted"> 元</span>}
                </div>
              </div>
              <div>
                <div className="k">理想剩余可赚</div>
                <div className={`v long ${tone(current.expectProfitCents)}`}>{signedMoney(current.expectProfitCents)}</div>
              </div>
              <div>
                <div className="k">今年共卖</div>
                <div className="v">
                  {yearSellCount} <span className="tiny muted">次</span>
                </div>
              </div>
            </div>
            <div className="grid-4 metric-strip">
              <div>
                <div className="k">可卖</div>
                <div className="v">{qty(current.targetQty)}</div>
              </div>
              <div>
                <div className="k">待补</div>
                <div className="v" style={{ color: current.exposureQty ? 'var(--up)' : undefined }}>{qty(current.exposureQty)}</div>
              </div>
              <div>
                <div className="k">净持仓</div>
                <div className="v">{qty(current.netQty)}</div>
              </div>
              <div>
                <div className="k">已实现</div>
                <div className={`v long ${tone(current.profitCents)}`}>{signedMoney(current.profitCents)}</div>
              </div>
            </div>
          </div>
        </Card>

        <Card className="tree-full">
          <TreeTrunk
            stockName={current.stockName}
            closeCents={closeCents}
            idealPriceCents={current.targetMaxPriceCents}
            onPick={({ loCents, hiCents, done }) =>
              goTrades(
                loCents === hiCents
                  ? { stock: current.stockName, price: loCents, showDone: done === true || undefined }
                  : { stock: current.stockName, priceLo: loCents, priceHi: hiCents, showDone: done === true || undefined },
              )
            }
          />
        </Card>
        </div>
      )}

      <div className="overview-bottom">
      <div className="page-title">
        <h2>概览</h2>
        <p>{basename}</p>
      </div>

      <Card>
        <div className="metrics">
          <button
            type="button"
            className={`metric-cell${openMetric === 'target' ? ' on' : ''}`}
            onClick={() => setOpenMetric(openMetric === 'target' ? null : 'target')}
            data-metric="target"
            aria-label="可卖批次构成"
          >
            <div className="k">可卖批次</div>
            <div className="v">{qty(t.targetQty)}</div>
            <div className="s">待卖合计</div>
          </button>
          <button
            type="button"
            className={`metric-cell${openMetric === 'exposure' ? ' on' : ''}`}
            onClick={() => setOpenMetric(openMetric === 'exposure' ? null : 'exposure')}
            data-metric="exposure"
            aria-label="待回补构成"
          >
            <div className="k">待回补</div>
            <div className="v" style={{ color: t.exposureQty ? 'var(--up)' : undefined }}>{qty(t.exposureQty)}</div>
            <div className="s">{t.rebuyCount} 条待买</div>
          </button>
          <button
            type="button"
            className={`metric-cell${openMetric === 'net' ? ' on' : ''}`}
            onClick={() => setOpenMetric(openMetric === 'net' ? null : 'net')}
            data-metric="net"
            aria-label="净持仓构成"
          >
            <div className="k">净持仓</div>
            <div className="v">{qty(t.netQty)}</div>
            <div className="s">买入 − 卖出</div>
          </button>
        </div>
        <p className="tiny muted metrics-hint">点上面三格可以展开构成明细</p>
        <div className="row divider-top" style={{ gap: 6 }}>
          {/* 基准体检挪去了管理 · 校验（V9.10）；这里只在异常时提醒一句 */}
          {failed > 0 && (
            <Tag size="small" variant="soft" color="app-red" onClick={goManage}>
              基准 {baseline.length - failed}/{baseline.length} · 去管理页看
            </Tag>
          )}
          {/* V9.27：盈利数字右侧追加加粗「共计x次」，x 比其它字大 5px（CSS calc(1em+5px)） */}
          <Tag size="small" variant="soft" color="app-blue">
            已实现 {signedMoney(t.profitCents)}
            <span className="profit-count">
              共计<b>{t.sellCount}</b>次
            </span>
          </Tag>
          <Tag size="small" variant="soft" color="app-orange">待卖 {money(t.targetAmountCents)}</Tag>
          {t.exposureQty > 0 && (
            <Tag
              size="small"
              variant="soft"
              color="app-red"
              onClick={() => goTrades({ status: ['exposure'] })}
            >
              卖满后 {qty(t.exposureQty)} 股敞口
            </Tag>
          )}
          {missingDateCount > 0 && (
            <Tag
              size="small"
              variant="soft"
              color="app-yellow"
              onClick={() => goTrades({ status: ['sellDateMissing'], showDone: true })}
            >
              待补日期 {missingDateCount} 笔
            </Tag>
          )}
          {backupStale && hasData && (
            <Tag size="small" variant="soft" color="app-yellow">
              {backupDays === null ? '还没备份过' : `${backupDays} 天没备份`}
            </Tag>
          )}
        </div>
      </Card>

      {/* §04：三格指标点开看构成（移动端没有悬停，用点击代替）；key 换目标时重放进场动画 */}
      {openMetric !== null && (
        <Card key={openMetric} className="reveal">
          <div className="sec-head">
            <strong>
              {openMetric === 'target' ? '可卖批次构成' : openMetric === 'exposure' ? '待回补构成' : '净持仓构成'}
            </strong>
            <div className="spacer" />
            <Button size="small" type="text" onClick={() => setOpenMetric(null)}>收起</Button>
          </div>

          {openMetric === 'target' &&
            (ledger.lots.filter((l) => l.remainingQty > 0).length === 0 ? (
              <div className="empty-box">没有剩余批次</div>
            ) : (
              <>
                <div className="data-block">
                  {ledger.lots
                    .filter((l) => l.remainingQty > 0)
                    .sort((a, b) => b.buyPriceCents - a.buyPriceCents)
                    .map((l) => (
                      <div key={l.id} className="line">
                        <div className="left">
                          <div className="t1 num">
                            {l.stockName} · 买 {price(l.buyPriceCents)}
                          </div>
                          <div className="t2">行 {l.sourceRow} · 目标 {price(l.targetPriceCents)}</div>
                        </div>
                        <div className="right num" style={{ fontWeight: 600 }}>{qty(l.remainingQty)} 股</div>
                      </div>
                    ))}
                </div>
                <p className="tiny muted" style={{ margin: '8px 0 0' }}>
                  合计 {qty(t.targetQty)} 股 · 这是「理论上能卖出去」的上限，不等于持仓
                </p>
              </>
            ))}

          {openMetric === 'exposure' &&
            (() => {
              const exposed = ledger.orders
                .map((o) => ({
                  o,
                  owe: Math.max(0, o.baseQty - Math.max(0, o.execQty - o.doneRewardQty)),
                }))
                .filter((x) => x.o.exposure && x.owe > 0)
              if (exposed.length === 0) return <div className="empty-box">没有空头敞口</div>
              return (
                <>
                  <div className="data-block">
                    {exposed.map(({ o, owe }) => (
                      <div key={o.id} className="line">
                        <div className="left">
                          <div className="t1 num">{o.stockName} · 回补价 {price(o.rebuyPriceCents)}</div>
                          <div className="t2">
                            行 {o.sourceRow}
                            {o.execQty > 0 ? ` · 已回补 ${o.execQty}` : ''}
                          </div>
                        </div>
                        <div className="right num" style={{ fontWeight: 600, color: 'var(--up)' }}>
                          {qty(owe)} 股
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="tiny muted" style={{ margin: '8px 0 0' }}>
                    合计 {qty(t.exposureQty)} 股 · 这些是已卖出、还没有买入批次覆盖的量（在加空）
                  </p>
                </>
              )
            })()}

          {openMetric === 'net' && (
            <>
              <div className="data-block">
                <div className="line">
                  <div className="left t1">Σ 买入份额（含回补批次）</div>
                  <div className="right num">
                    {qty(t.buyQty)}
                    {t.rebuyExecQty > 0 && (
                      <span className="tiny muted" style={{ marginLeft: 4 }}>其中回补 {qty(t.rebuyExecQty)}</span>
                    )}
                  </div>
                </div>
                <div className="line">
                  <div className="left t1">Σ 卖出量</div>
                  <div className="right num">− {qty(t.sellQty)}</div>
                </div>
                <div className="line">
                  <div className="left t1">净持仓</div>
                  <div className="right num" style={{ fontWeight: 700 }}>{qty(t.netQty)}</div>
                </div>
              </div>
              <p className="tiny muted" style={{ margin: '8px 0 0' }}>
                {qty(t.buyQty)} − {qty(t.sellQty)} = {qty(t.netQty)}
                {' · '}可卖 {qty(t.targetQty)} − 待补 {qty(t.exposureQty)}
                {t.exposureExecBaseQty > 0 ? ` − 空头回补基础股 ${qty(t.exposureExecBaseQty)}` : ''}
                也应等于这个数
              </p>
            </>
          )}
        </Card>
      )}

      </div>

      <p className="tiny muted" style={{ textAlign: 'center', margin: '0 0 4px' }}>
        {hiddenCount > 0 && `已隐藏 ${hiddenCount} 只停用股票（数据仍计入上方合计） · `}
        数据只存在本机浏览器
      </p>
    </div>
  )
}

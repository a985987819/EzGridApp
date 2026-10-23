import { useMemo, useState } from 'react'
import { Button, Card, Collapse, Tag } from 'animal-island-ui'
import { activeStockNames } from '../domain/stocks'
import type { StockSummary } from '../domain/types'
import { useApp } from '../store/useApp'
import { CheckList } from '../components/CheckGrid'
import { PriceGrid } from '../components/PriceGrid'
import { money, qty, signedMoney, tone } from '../ui/format'

export function Overview({
  onPick,
  goManage,
}: {
  onPick: (stock: string, priceCents: number) => void
  goManage: () => void
}) {
  const { ledger, baseline, records, basename, stocks, lastBackupAt } = useApp()
  const [active, setActive] = useState('')
  const t = ledger.totals
  const failed = baseline.filter((c) => !c.ok).length
  const backupDays = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null
  const backupStale = backupDays === null || backupDays >= 7

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

  return (
    <div className="stack">
      <div className="page-sticky" data-sticky="overview">
        <div className="page-title">
          <h2>概览</h2>
          <p>{basename}</p>
        </div>

      <Card>
        <div className="metrics">
          <div>
            <div className="k">可卖批次</div>
            <div className="v">{qty(t.targetQty)}</div>
            <div className="s">待卖合计</div>
          </div>
          <div>
            <div className="k">待回补</div>
            <div className="v" style={{ color: t.exposureQty ? 'var(--up)' : undefined }}>{qty(t.exposureQty)}</div>
            <div className="s">{t.rebuyCount} 条待买</div>
          </div>
          <div>
            <div className="k">净持仓</div>
            <div className="v">{qty(t.netQty)}</div>
            <div className="s">买入 − 卖出</div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          <Tag size="small" variant="soft" color={failed ? 'app-red' : 'app-green'}>
            {failed ? `基准 ${baseline.length - failed}/${baseline.length}` : '基准全中'}
          </Tag>
          <Tag size="small" variant="soft" color="app-blue">已实现 {signedMoney(t.profitCents)}</Tag>
          <Tag size="small" variant="soft" color="app-orange">待卖 {money(t.targetAmountCents)}</Tag>
          {t.exposureQty > 0 && (
            <Tag size="small" variant="soft" color="app-red">卖满后 {qty(t.exposureQty)} 股敞口</Tag>
          )}
          {backupStale && hasData && (
            <Tag size="small" variant="soft" color="app-yellow">
              {backupDays === null ? '还没备份过' : `${backupDays} 天没备份`}
            </Tag>
          )}
        </div>
      </Card>
      </div>

      <Card>
        <div className="row" style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>股票价格网格</strong>
          <div className="spacer" />
          <span className="tiny muted">高 → 低</span>
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
        {current && (
          <div className="stack tight" style={{ marginTop: 10 }}>
            <div className="grid-4">
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
            <PriceGrid stock={current} onPick={(p) => onPick(current.stockName, p)} />
          </div>
        )}
      </Card>

      <Card>
        <Collapse
          question={
            <span className="row" style={{ gap: 6 }}>
              基准快照（文档 §03）
              <Tag size="small" variant="soft" color={failed ? 'app-red' : 'app-green'}>
                {failed ? `${failed} 项不符` : '全中'}
              </Tag>
            </span>
          }
          answer={<CheckList checks={baseline} />}
        />
        <Collapse question="数量守恒（R7）" answer={<CheckList checks={ledger.checks} />} />
      </Card>

      <p className="tiny muted" style={{ textAlign: 'center', margin: '0 0 4px' }}>
        {hiddenCount > 0 && `已隐藏 ${hiddenCount} 只停用股票（数据仍计入上方合计） · `}
        数据只存在本机浏览器 · 每周记得去「管理 · 备份」导一份
      </p>
    </div>
  )
}

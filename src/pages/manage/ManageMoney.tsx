/**
 * 规划用钱（2026-11-03）：管理页分区，回答「这笔可用资金现在买哪只、能买多少、值不值博」。
 *
 * - 可用资金：只存本机 localStorage（ezgrid.moneyPlan），不进台账、不进备份、无 Dexie 变更。
 * - 每只启用股票一张卡：股价/PE/PB 三条 5 年百分位温度带（复用 components/ValuationBand）+
 *   现价 + 整手可买 + 值博率。
 * - 现价 = 挂单页已确认昨收（ordersSession.confirmedCents），未确认回退快照最后收盘；
 *   在这里改价等于「确认昨收」，写同一个会话（挂单页/概览温度带同步生效）。
 * - 排序按值博率：已低于 P20 优先 → 比率 ≥2 → 1–2 → <1 → 已过中位 → 无数据。
 *   值博率口径见 domain/moneyPlan.ts 与 docs/规划用钱.md——只回答位置赔率，不构成买卖指令。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Input, Tag } from 'animal-island-ui'
import { activeStockNames } from '../../domain/stocks'
import { toCents } from '../../domain/money'
import { computeValuationBand, loadValuationData, type ValuationBand as BandResult, type ValuationFile } from '../../domain/valuation'
import { planPurchase, valuationAnchors, valueRatio, type ValueLevel } from '../../domain/moneyPlan'
import { ValuationBand } from '../../components/ValuationBand'
import { money, price } from '../../ui/format'
import { useApp } from '../../store/useApp'

const MONEY_KEY = 'ezgrid.moneyPlan'

const VALUE_TAG_COLOR: Record<ValueLevel, 'app-green' | 'app-yellow' | 'app-red'> = {
  high: 'app-green',
  mid: 'app-yellow',
  low: 'app-red',
}

interface StockRow {
  name: string
  priceCents: number | null
  /** 现价来源：true = 已确认昨收，false = 快照收盘，null = 无任何价 */
  priceFromYesterday: boolean | null
  pricePct: number | null
  hasSnapshot: boolean
  plan: ReturnType<typeof planPurchase>
  value: ReturnType<typeof valueRatio> | null
  anchors: ReturnType<typeof valuationAnchors> | null
  band: BandResult | null
}

function tierOf(row: StockRow): number {
  const v = row.value
  if (!v) return 5
  if (v.ratio == null) return v.level === 'high' ? 0 : 4
  return v.level === 'high' ? 1 : v.level === 'mid' ? 2 : 3
}

export function ManageMoney() {
  const { stocks, ordersSession, patchOrdersSession } = useApp()
  const [valuation, setValuation] = useState<ValuationFile | null>(null)
  const [moneyYuan, setMoneyYuan] = useState<string>(() => {
    try {
      return localStorage.getItem(MONEY_KEY) ?? ''
    } catch {
      return ''
    }
  })
  /** 每只股票的昨收编辑草稿（不直接落会话，点确认才写） */
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    let on = true
    loadValuationData()
      .then((d) => {
        if (on) setValuation(d)
      })
      .catch(() => {})
    return () => {
      on = false
    }
  }, [])

  useEffect(() => {
    try {
      if (moneyYuan) localStorage.setItem(MONEY_KEY, moneyYuan)
      else localStorage.removeItem(MONEY_KEY)
    } catch {
      /* 隐私模式存不了就只活在本页 */
    }
  }, [moneyYuan])

  const moneyCents = toCents(moneyYuan)

  const rows = useMemo<StockRow[]>(() => {
    const names = activeStockNames(stocks)
    const list = names.map((name) => {
      const snap = valuation?.stocks[name]
      const anchors = snap ? valuationAnchors(snap.days) : null
      const confirmed = ordersSession.confirmedCents[name] ?? null
      const lastCloseCents = snap ? snap.days[snap.days.length - 1][1] : null
      const priceCents = confirmed ?? lastCloseCents
      const band = snap ? computeValuationBand(snap.days, priceCents) : null
      return {
        name,
        priceCents,
        priceFromYesterday: confirmed != null ? true : lastCloseCents != null ? false : null,
        pricePct: band?.pricePct ?? null,
        hasSnapshot: Boolean(snap),
        plan: planPurchase(moneyCents, priceCents),
        value: anchors ? valueRatio(anchors, priceCents) : null,
        anchors,
        band,
      } satisfies StockRow
    })
    // 值博率排序：优（≤P20）→ 比率降序 → 已过中位 → 无数据；同级内冷者/比率更高者在前
    return list.sort((a, b) => {
      const ta = tierOf(a)
      const tb = tierOf(b)
      if (ta !== tb) return ta - tb
      if (ta === 0 || ta === 4) return (a.pricePct ?? 100) - (b.pricePct ?? 100)
      if (ta >= 1 && ta <= 3) return (b.value?.ratio ?? -Infinity) - (a.value?.ratio ?? -Infinity)
      return a.name.localeCompare(b.name)
    })
  }, [stocks, valuation, ordersSession.confirmedCents, moneyCents])

  const saveYesterday = (name: string) => {
    const draft = drafts[name]
    if (draft === undefined) return
    const cents = toCents(draft)
    setDrafts((d) => {
      const next = { ...d }
      delete next[name]
      return next
    })
    if (cents == null || cents <= 0) return
    // 与挂单页「确认昨收」同一写法：closes 记输入、confirmedCents 记确认分、清该股涨跌幅覆盖
    const overrides = { ...ordersSession.overrides }
    delete overrides[name]
    patchOrdersSession({
      closes: { ...ordersSession.closes, [name]: draft },
      confirmedCents: { ...ordersSession.confirmedCents, [name]: cents },
      overrides,
    })
  }

  return (
    <div className="stack" data-testid="manage-money">
      <Card>
        <div className="sec-head">
          <strong>当前可用资金</strong>
          <div className="spacer" />
          <span className="sec-sub">只存本机浏览器，不进台账与备份</span>
        </div>
        <Input
          className="grow"
          value={moneyYuan}
          onChange={(e) => setMoneyYuan(e.target.value)}
          placeholder="输入可用资金，如 10000"
          inputMode="decimal"
          aria-label="可用资金"
          data-testid="money-input"
          allowClear
          onClear={() => setMoneyYuan('')}
        />
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          下方每只股票按「这笔钱全买它」计算整手股数（A股 100 股一手，不足一手不凑零股）；改价请更新昨收，价格与挂单页、概览温度带共用。
        </p>
      </Card>

      {rows.map((row) => {
        const draft = drafts[row.name]
        const shownYuan = draft ?? (row.priceCents != null ? (row.priceCents / 100).toFixed(2) : '')
        return (
          <Card key={row.name} data-money-stock={row.name}>
            <div className="sec-head">
              <strong>{row.name}</strong>
              <span data-money-zone>
                <Tag size="small" variant="soft" color={row.value ? VALUE_TAG_COLOR[row.value.level] : 'default'}>
                  {row.value ? row.value.label : '无估值数据'}
                </Tag>
              </span>
              <div className="spacer" />
              <span className="sec-sub" data-money-price-source>
                现价（{row.priceFromYesterday === true ? '昨收' : row.priceFromYesterday === false ? '快照收盘' : '未定价'}）
              </span>
            </div>

            <div className="row nowrap" style={{ gap: 8 }}>
              <Input
                className="grow"
                value={shownYuan}
                onChange={(e) => setDrafts((d) => ({ ...d, [row.name]: e.target.value }))}
                placeholder="昨收价，如 8.10"
                inputMode="decimal"
                aria-label={`昨收价-${row.name}`}
                allowClear
                onClear={() => setDrafts((d) => ({ ...d, [row.name]: '' }))}
              />
              <Button
                size="small"
                type="primary"
                data-action="money-confirm-close"
                data-stock={row.name}
                disabled={draft === undefined}
                onClick={() => saveYesterday(row.name)}
              >
                更新昨收
              </Button>
            </div>

            {row.band ? (
              <>
                <div className="money-bands">
                  <ValuationBand metric="price" label="股价" pct={row.band.pricePct} valueText={row.priceCents != null ? price(row.priceCents) : '—'} />
                  <ValuationBand
                    metric="pe"
                    label="PE-TTM"
                    pct={row.band.pePct}
                    valueText={row.band.peEst == null ? '—' : row.band.peEst.toFixed(1)}
                    invalidText={row.band.peLoss ? '亏损 · 失效' : undefined}
                  />
                  <ValuationBand metric="pb" label="PB-MRQ" pct={row.band.pbPct} valueText={row.band.pbEst == null ? '—' : row.band.pbEst.toFixed(2)} />
                </div>
                <p className="tiny muted" data-money-anchor style={{ margin: '2px 0 0' }}>
                  {row.anchors
                    ? `上看中位 ${price(row.anchors.p50Cents)} · 下看 P20 ${price(row.anchors.p20Cents)}（P80 ${price(row.anchors.p80Cents)}）`
                    : ''}
                </p>
              </>
            ) : (
              <div className="empty-box">暂无该股票的估值快照</div>
            )}

            <div className="money-plan-line" data-money-plan>
              {row.plan ? (
                <>
                  可买 <strong className="tabular-nums">{row.plan.shares}</strong> 股（{row.plan.shares / 100} 手）
                  · 需 {money(row.plan.costCents)} · 剩 {money(row.plan.remainingCents)}
                </>
              ) : moneyCents == null || moneyCents <= 0 ? (
                <span className="tiny muted">输入可用资金后计算可买股数</span>
              ) : row.priceCents == null ? (
                <span className="tiny muted">无现价：先更新昨收</span>
              ) : null}
            </div>
          </Card>
        )
      })}

      <p className="tiny muted" style={{ margin: 0 }}>
        排序按值博率：已低于 P20 最优先，其后（中位−现价）÷（现价−P20）从高到低，已过中位与无数据靠后。值博率只回答位置赔率（上看 5 年中位、下破 P20 认错），不预测方向，网格买卖仍以挂单页档位为准。温度带数据截至 {valuation?.asOf ?? '…'}，除权后记得重跑刷新脚本。
      </p>
    </div>
  )
}

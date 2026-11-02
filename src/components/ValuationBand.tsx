/**
 * 估值温度带（2026-11-03）：概览页「回本链」下方的市场参考卡，回答
 * 「当前股价 / PE / PB 在近 5 年里处于什么位置」。纯展示——数据来自
 * domain/valuation 的静态快照（npm run refresh-valuation 刷新），不进台账、
 * 不参与任何计算；现价用挂单页已确认昨收，未确认时回退快照最后收盘并注明。
 * 刻线 20/40/60/80 分区：<20 极冷 / <40 偏冷 / <60 中性 / <80 偏热 / ≥80 过热。
 */
import { Card, Tag } from 'animal-island-ui'
import { computeValuationBand, valuationZone, type ValuationFile } from '../domain/valuation'
import { price } from '../ui/format'

const SEPS = [20, 40, 60, 80]

/** 股价分区 → Tag 颜色（Tag 不透传 data-*，testid 加在包裹层） */
const ZONE_TAG_COLOR: Record<string, 'app-blue' | 'app-green' | 'app-orange' | 'app-red' | 'app-yellow'> = {
  '极冷·低位': 'app-blue',
  '偏冷·低位': 'app-blue',
  中性: 'app-green',
  '偏热·高位': 'app-orange',
  '过热·高位': 'app-red',
  无数据: 'app-yellow',
}

const fmtRatio = (v: number | null, digits: number) => (v == null ? '—' : v.toFixed(digits))
const fmtPct = (pct: number | null) => (pct == null ? null : `${(Math.round(pct * 10) / 10).toFixed(1)}%`)

/** 单条温度带：指标名 + 渐变带（分区刻线 + 当前位置针）+ 右侧「百分位 · 现值」 */
export function ValuationBand({ metric, label, pct, valueText, invalidText }: {
  metric: 'price' | 'pe' | 'pb'
  label: string
  pct: number | null
  valueText: string
  /** 指标失效时的替代文案（如「亏损 · 失效」），此时不画针 */
  invalidText?: string
}) {
  const pctText = fmtPct(pct)
  return (
    <div className="val-band" data-val-metric={metric}>
      <span className="val-band-label">{label}</span>
      <span
        className="val-band-track"
        role="img"
        aria-label={pctText == null ? `${label}：${invalidText ?? '无数据'}` : `${label}处于近 5 年 ${pctText} 百分位`}
      >
        {SEPS.map((z) => (
          <i key={z} className="sep" style={{ left: `${z}%` }} />
        ))}
        {pct != null && <i className="needle" style={{ left: `${Math.min(98, Math.max(2, pct))}%` }} />}
      </span>
      <span className="val-band-val">{pctText == null ? invalidText ?? '—' : `${pctText} · ${valueText}`}</span>
    </div>
  )
}

/** 概览 · 估值温度卡：当前股票的三条温度带 */
export function ValuationSection({ stockName, closeCents, data }: {
  stockName: string
  /** 挂单页已确认昨收（分）；未确认时回退快照最后收盘并在副标题注明 */
  closeCents: number | null
  data: ValuationFile
}) {
  const snap = data.stocks[stockName]
  const covered = Object.keys(data.stocks).join(' / ')
  if (!snap || snap.days.length === 0) {
    return (
      <Card data-testid="overview-valuation">
        <div className="sec-head">
          <strong>估值温度 · 近 5 年百分位</strong>
          <div className="spacer" />
          <span className="sec-sub">数据截至 {data.asOf}</span>
        </div>
        <div className="empty-box">暂无「{stockName}」的估值快照（快照覆盖：{covered}）</div>
      </Card>
    )
  }
  const lastCloseCents = snap.days[snap.days.length - 1][1]
  const usedYesterday = closeCents != null && closeCents > 0
  const priceCents = usedYesterday ? closeCents : lastCloseCents
  const band = computeValuationBand(snap.days, priceCents)
  return (
    <Card data-testid="overview-valuation">
      <div className="sec-head">
        <strong>估值温度 · 近 5 年百分位</strong>
        <span data-testid="valuation-zone">
          <Tag size="small" variant="soft" color={ZONE_TAG_COLOR[valuationZone(band.pricePct)] ?? 'app-yellow'}>
            {valuationZone(band.pricePct)}
          </Tag>
        </span>
        <div className="spacer" />
        <span className="sec-sub" data-testid="valuation-asof">
          数据截至 {data.asOf} · 按{usedYesterday ? '昨收' : '快照收盘'} {price(priceCents)}
        </span>
      </div>
      <ValuationBand metric="price" label="股价" pct={band.pricePct} valueText={price(priceCents)} />
      <ValuationBand
        metric="pe"
        label="PE-TTM"
        pct={band.pePct}
        valueText={fmtRatio(band.peEst, 1)}
        invalidText={band.peLoss ? '亏损 · 失效' : undefined}
      />
      <ValuationBand
        metric="pb"
        label="PB-MRQ"
        pct={band.pbPct}
        valueText={fmtRatio(band.pbEst, 2)}
        invalidText={band.pbLoss ? '亏损 · 失效' : undefined}
      />
      <p className="tiny muted" style={{ margin: '8px 0 0' }}>
        百分位 = 窗口内低于当前值的交易日占比，刻线 20/40/60/80；PE/PB 按现价对快照末值等比缩放，亏损期 PE 失效、以 PB 与股价位置为主。数据为静态快照，除权除息后需重新生成。
      </p>
    </Card>
  )
}

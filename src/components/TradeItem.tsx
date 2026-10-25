/**
 * 明细行卡片（V9.25 从 TradesPage 抽出）：明细列表与价格树 hover 浮层共用。
 *
 * 一行 = 一个 RawRecord（买入批次）+ 派生的 lot / sell。配色口径（V9.11）：
 * 红 = 待卖（目标价 / 剩余量），蓝 = 待回补买（买入 / 回补价 + 量），已完成不标色。
 */
import { Card, Tag } from 'animal-island-ui'
import type { ReactNode } from 'react'
import { serialToIso } from '../domain/defaults'
import { price, qty, signedMoney, tone } from '../ui/format'
import type { Lot, RawRecord, SellExecution } from '../domain/types'

export interface TradeRow {
  rec: RawRecord
  lot: Lot | null
  sell: SellExecution | null
}

/** 行上的买入日期（可空） */
export function buyDateOf(r: TradeRow): string | null {
  return r.lot?.buyDate ?? serialToIso(r.rec.buyDateSerial)
}

/** 行上的卖出日期（可空） */
export function sellDateOf(r: TradeRow): string | null {
  return r.sell?.soldAt ?? null
}

/** 已完成：卖出已落袋且无剩余、也无待回补挂着——明细页默认隐藏这类行 */
export function isDone(r: TradeRow): boolean {
  return r.sell !== null && r.sell.rebuyStatus !== 'pending' && (r.lot === null || r.lot.remainingQty === 0)
}

export function TradeItem({
  row,
  nanoId,
  onClick,
  extraTag,
  anim,
}: {
  row: TradeRow
  nanoId?: string
  onClick?: () => void
  /** 追加到标签行的页内标签（明细页的挂钩状态等；hover 预览不传） */
  extraTag?: ReactNode
  /**
   * V9.37 进场/退场动效：new = 新增落位（弹窗收成一行）、leaving = 删除滑出、
   * done = 刚完成洗一层青。样式全在 styles.css 的 `[data-anim=…]` 里。
   */
  anim?: 'new' | 'leaving' | 'done'
}) {
  const { rec, lot, sell } = row
  const deleted = Boolean(rec.deletedAt)
  const holding = (lot?.remainingQty ?? 0) > 0
  const awaitingBuy = !holding && sell?.rebuyStatus === 'pending'
  const buyP = rec.buyPriceCents ?? rec.earlyBuyPriceCents
  const buyQ = lot ? lot.qty : rec.soldQty ?? 0
  // V9.26.1 状态区分：文字一律默认色；待卖（红）/待买（蓝）用左边框 + 右下角挂单角标表达
  const stateCls = holding ? ' pending-sell' : awaitingBuy ? ' pending-buy' : ''
  const targetP = lot?.targetPriceCents ?? rec.targetPriceCents
  return (
    <Card
      hoverable={Boolean(onClick)}
      onClick={onClick}
      className={`trade-item${stateCls}${deleted ? ' deleted' : ''}`}
      data-row={rec.sourceRow}
      data-anim={anim}
    >
      <div className="head">
        <Tag size="small" variant="soft">{rec.origin === 'manual' ? '手动' : `行 ${rec.sourceRow}`}</Tag>
        {nanoId && (
          <span className="tiny muted mono" title={`nanoId ${nanoId}`}>
            #{nanoId}
          </span>
        )}
        <span className="name">{rec.stockName}</span>
        <div className="spacer" />
        <span className={`profit ${tone(sell?.profitCents ?? null)}`}>
          {/* V9.33：被全额挂住的裸卖盈利暂缓——写「暂缓」比写「—」更像回事 */}
          {sell ? (sell.hedgedHold ? '暂缓' : signedMoney(sell.profitCents)) : '—'}
        </span>
      </div>
      {/* 中部信息一律默认色（V9.26.1）：方向语义交给左边框与右下角挂单角标 */}
      <div className="mid">
        <span className="path num">
          {buyP !== null ? (
            <span>
              买 {price(buyP)}
              {buyQ > 0 && <b> × {qty(buyQ)}</b>}
            </span>
          ) : (
            '无买入批次'
          )}
          {rec.soldQty ? ` · 卖 ${qty(rec.soldQty)}` : ''}
          {' → '}
          <span>目标 {price(targetP)}</span>
        </span>
        <span className="right-qty num">
          {lot ? `剩余 ${qty(lot.remainingQty)}` : rec.soldQty ? `已卖 ${qty(rec.soldQty)}` : ''}
        </span>
      </div>
      {/* 买入 / 卖出日期都显示；没有就显示 —（先卖后买的行买入日期本来就空） */}
      <div className="dates num">
        <span className={buyDateOf(row) === null ? 'missing' : undefined}>
          买入 <b>{buyDateOf(row) ?? '—'}</b>
        </span>
        <span className="sep" aria-hidden />
        <span className={sellDateOf(row) === null ? 'missing' : undefined}>
          卖出 <b>{sellDateOf(row) ?? '—'}</b>
        </span>
      </div>
      <div className="tag-row">
        {sell?.rebuyStatus === 'pending' && <Tag size="small" variant="soft" color="app-orange">待回补</Tag>}
        {sell?.sellBeforeBuy && <Tag size="small" variant="soft" color="app-teal">先卖后买</Tag>}
        {extraTag}
        {sell?.dateMissing && <Tag size="small" variant="soft" color="app-yellow">缺卖出日期</Tag>}
        {buyDateOf(row) === null && (lot !== null || rec.buyPriceCents !== null) && (
          <Tag size="small" variant="soft" color="app-yellow">缺买入日期</Tag>
        )}
        {sell && sell.priceCents === null && <Tag size="small" variant="soft" color="app-red">缺价格</Tag>}
        {rec.editedAt && <Tag size="small" variant="soft" color="purple">改过</Tag>}
        {deleted && <Tag size="small" variant="soft" color="app-red">已删除</Tag>}
        {/* 右下角挂单角标（V9.26.1）：这条该挂的单子数值，与左边框同色系 */}
        {holding && (
          <span className="order-chip sell">
            挂卖 {price(targetP)} × {qty(lot?.remainingQty ?? 0)}
          </span>
        )}
        {awaitingBuy && (
          <span className="order-chip buy">
            挂买 {price(rec.earlyBuyPriceCents)} × {qty(sell?.qty ?? 0)}
          </span>
        )}
      </div>
    </Card>
  )
}

/**
 * 明细行卡片（V9.25 从 TradesPage 抽出）：明细列表与价格树 hover 浮层共用。
 *
 * 一行 = 一个 RawRecord（买入批次）+ 派生的 lot / sell。配色口径（V9.11）：
 * 红 = 待卖（目标价 / 剩余量），蓝 = 待回补买（买入 / 回补价 + 量），已完成不标色。
 */
import { Card, Tag } from 'animal-island-ui'
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { GroupPool } from '../domain/types'
import { LevelProfit } from './LevelProfit'
import { serialToIso } from '../domain/defaults'
import { price, qty, signedMoney, tone } from '../ui/format'
import type { TradeRow } from '../domain/tradeState'
export { isDone } from '../domain/tradeState'
export type { TradeRow } from '../domain/tradeState'


/** 行上的买入日期（可空） */
export function buyDateOf(r: TradeRow): string | null {
  return r.lot?.buyDate ?? serialToIso(r.rec.buyDateSerial)
}

/** 行上的卖出日期（可空） */
export function sellDateOf(r: TradeRow): string | null {
  return r.sell?.soldAt ?? null
}

export function TradeItem({
  row,
  no,
  onClick,
  extraTag,
  anim,
  chain,
  levelProfit,
  onSwipeDelete,
}: {
  row: TradeRow
  /** 第几笔（V9.43 统一身份：导入与应用内新增一样） */
  no?: number | null
  onClick?: () => void
  /** 追加到标签行的页内标签（明细页的挂钩状态等；hover 预览不传） */
  extraTag?: ReactNode
  /**
   * V9.37 进场/退场动效：new = 新增落位（弹窗收成一行）、leaving = 删除滑出、
   * done = 刚完成洗一层青。样式全在 styles.css 的 `[data-anim=…]` 里。
   */
  anim?: 'new' | 'leaving' | 'done'
  /**
   * V9.46 回本链身份：anchor = 亏着清仓的那笔（链的锚点），member = 归进别人链里的一笔；
   * V9.49：branch = 价位槽里那笔「同价再卖 / 同价买回」，点开能看到整条链的账。
   */
  chain?: 'anchor' | 'member' | 'branch'
  levelProfit?: { priceCents: number; group?: GroupPool }
  /**
   * 左滑露出的删除动作（明细页传；价格树 hover 浮层不传，保持只读）。
   * 不需要先打开详情抽屉就能删；原生拖拽/触摸都支持，竖向滚动不受影响。
   */
  onSwipeDelete?: () => void
}) {
  const { rec, lot, sell } = row
  const deleted = Boolean(rec.deletedAt)
  const holding = (lot?.remainingQty ?? 0) > 0
  const awaitingBuy = !holding && sell?.rebuyStatus === 'pending'
  const buyP = rec.soldLotId ? null : rec.buyPriceCents
  const buyQ = lot ? lot.qty : rec.buyQtyRaw ?? 0
  // V9.26.1 状态区分：文字一律默认色；待卖（红）/待买（蓝）用左边框 + 右下角挂单角标表达
  const stateCls = holding ? ' pending-sell' : awaitingBuy ? ' pending-buy' : ''
  const targetP = lot?.targetPriceCents ?? rec.targetPriceCents

  // —— 左滑删除：只在给出 onSwipeDelete 时启用；手指/鼠标都走同一套指针事件 ——
  const REVEAL = 76
  const [dx, setDx] = useState(0)
  const drag = useRef<{ x: number; y: number; axis: 'x' | 'y' | '?' } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onSwipeDelete || (e.pointerType === 'mouse' && e.button !== 0)) return
    drag.current = { x: e.clientX, y: e.clientY, axis: '?' }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const mx = e.clientX - d.x
    const my = e.clientY - d.y
    if (d.axis === '?') {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
      d.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
    }
    if (d.axis !== 'x') return
    // 已删除行只允许右滑露出「恢复」，未删除行只允许左滑露出「删除」
    const next = deleted ? Math.min(REVEAL, Math.max(0, mx)) : Math.max(-REVEAL, Math.min(0, mx))
    setDx(next)
  }
  const onPointerUp = () => {
    if (!drag.current) return
    drag.current = null
    setDx((cur) => (Math.abs(cur) >= REVEAL / 2 ? (deleted ? REVEAL : -REVEAL) : 0))
  }
  const revealed = Math.abs(dx) >= REVEAL / 2

  return (
    <div
      className="trade-swipe"
      data-swipe={onSwipeDelete ? 'enabled' : 'off'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {onSwipeDelete && revealed && (
        <button
          type="button"
          className={`trade-swipe-action${deleted ? ' restore' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setDx(0)
            onSwipeDelete()
          }}
        >
          {deleted ? '恢复' : '删除'}
        </button>
      )}
      <div
        className="trade-swipe-front"
        style={{ transform: `translateX(${dx}px)`, transition: drag.current ? 'none' : undefined }}
        onClickCapture={(e) => {
          // 捕获阶段拦截：露出动作时先收起、不误开详情；滑过也不把这次点击当「打开」。
          // 必须 capture——冒泡阶段 Card 的 onClick 已经先把抽屉打开了。
          if (dx !== 0) {
            e.stopPropagation()
            setDx(0)
          }
        }}
      >
    <Card
      hoverable={Boolean(onClick)}
      onClick={onClick}
      className={`trade-item${stateCls}${deleted ? ' deleted' : ''}`}
      data-row={rec.sourceRow}
      data-anim={anim}
      data-chain={chain}
    >
      <div className="head">
        <Tag size="small" variant="soft">{no == null ? '记录' : `第 ${no} 笔`}</Tag>
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
              实际买入 {price(buyP)}
              {buyQ > 0 && <b> × {qty(buyQ)}</b>}
            </span>
          ) : (
            rec.soldLotId ? `来源成本 ${price(rec.buyPriceCents)}` : (sell?.actualRebuyQty ?? 0) > 0 ? `已买回 ${qty(sell!.actualRebuyQty!)} 股，见流水` : '尚未买回'
          )}
          {rec.soldQty ? ` · 实际卖出 ${price(sell?.priceCents ?? rec.targetPriceCents)} × ${qty(rec.soldQty)}` : ''}
          {' → '}
          {holding ? <span>计划卖价 {price(targetP)}</span> : awaitingBuy ? <span>计划回补 {price(sell?.rebuyPriceCents ?? rec.earlyBuyPriceCents)}</span> : <span>本笔卖出已完成</span>}
        </span>
        <span className="right-qty num">
          {lot ? `剩余 ${qty(lot.remainingQty)}` : rec.soldQty ? `已卖 ${qty(rec.soldQty)}` : ''}
        </span>
      </div>
      {/* 买入 / 卖出日期都显示；没有就显示 —（先卖后买的行买入日期本来就空） */}
      <div className="dates num">
        <span className={buyDateOf(row) === null ? 'missing' : undefined}>
          {rec.soldLotId ? '来源买入' : '买入'} <b>{buyDateOf(row) ?? '—'}</b>
        </span>
        <span className="sep" aria-hidden />
        <span className={sellDateOf(row) === null ? 'missing' : undefined}>
          卖出 <b>{sellDateOf(row) ?? '—'}</b>
        </span>
      </div>
      {levelProfit && !deleted && <LevelProfit {...levelProfit} />}
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
            挂买 {price(sell?.rebuyPriceCents ?? rec.earlyBuyPriceCents)} × {qty(sell?.rebuyRemainingQty ?? sell?.qty ?? 0)}
          </span>
        )}
      </div>
    </Card>
      </div>
    </div>
  )
}

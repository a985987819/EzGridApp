/**
 * 2D 价格树（V9.18）：概览页的纵轴是一棵 Canvas 2D 的「图鉴素雅风」树。
 *
 * V9.22 图鉴素雅风（做减法，取代 V9.18~V9.21 的随机抖动插画风）：
 *   删掉云、装饰叶、树皮排线、树轮与「沸腾」抖动动画——素雅来自统一克制的
 *   线语言，不靠随机抖动；
 *   干体 = 细锥形双线勾边 + 极淡水彩晕染；整步价签是钉在树干正中的小泡牌
 *   （图鉴挂牌），半步档只留左侧短刻度；
 *   枝 = 统一弧线：同侧同仰角（待卖右上扬 / 待买左上扬 / 枯枝右下垂）、
 *   根粗梢细收尖，无逐枝随机；聚合档数 = 枝上小点（叶痕）；
 *   数据牌 = 图鉴注记：单行「买/卖 价 ×份额」，衬线数字、纸色细边、枝梢
 *   小点引线；枯枝牌「已盈利 ±¥xx」（成本缺失的卖出不计）。
 *   色板收敛 5 色：纸白 / 墨褐 / 青灰蓝(买) / 赭红(卖) / 枯褐(已成交)。
 *
 * 数据逻辑与 V9.9~V9.21 一致：
 *   待买/待卖枝长随数量；相邻档间距 < gap 合并成一枝（gap 按数据牌行高
 *   CARD_ROW_PX 推算，放大时聚合枝自动分散回原档位数）；拉远时枝长按
 *   span 等比放大（画面占比恒定）；价签按最小屏幕间距从 1-2-5 档取步长、
 *   钉在树干正中；轴全程线性等比例，视野下沿钳 0。
 *
 * 交互：滚轮 / 双指捏合缩放，拖动攀爬，左右拖动把整棵树平移出画面中心
 *   （两侧的枝拖过来对着看），点枝跳明细（已成交枝跳转自动放开「隐藏已完成」）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useApp } from '../store/useApp'
import type { SellTarget } from '../domain/types'

export interface TreeLevel {
  priceCents: number
  buyQty: number
  sellQty: number
  soldQty: number
  soldCount: number
  /** 该价位已成交的已盈利合计（成本缺失的卖出不计入） */
  soldProfitCents: number
}

const TRUNK_MIN = -20
const TRUNK_MAX = 300
const CAM_MAX = 288
const SPAN_MIN = 0.5
const SPAN_MAX = 150
/** 枝上数据牌占的屏幕行高（px，V9.22 单行注记）：相邻档间距不足就合并，放大后自动分散回原档位数 */
const CARD_ROW_PX = 27
/** 价签最小屏幕间距（px）：任何缩放下相邻两个数字至少隔这么远 */
const LABEL_MIN_GAP = 80
/** 价签步长档位（1-2-5 序列；0.1 档对应 A 股最小报价单位） */
const LABEL_LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
/** 树干最多拖离画面中心 ±45% 画布宽：能看两侧的枝，又不至于整棵拖没 */
const PAN_X_MAX = 0.45

/** 墨色盘（V9.22 图鉴素雅风）：纸白 / 墨褐线稿 / 极淡水彩晕染 / 低饱和枝色 */
const INK = {
  paper: '#f4eee0',
  ink: '#5f5344',
  wash: 'rgba(203, 185, 152, 0.30)',
  buy: '#6e8aa8',
  sell: '#b0685c',
  sold: '#a38f70',
  tag: '#fcf8ee',
}
const inkA = (a: number) => `rgba(95, 83, 68, ${a})`
/** 图鉴注记字体：衬线数字（中文回退宋体，标本注记感） */
const SERIF = 'Georgia, "Noto Serif SC", SimSun, serif'

function aggregate(
  stockName: string,
  sells: { stockName: string; priceCents: number | null; qty: number; profitCents: number | null }[],
  targets: SellTarget[],
  orders: { stockName: string; rebuyPriceCents: number; remainingQty: number }[],
): TreeLevel[] {
  const map = new Map<number, TreeLevel>()
  const get = (p: number) => {
    let l = map.get(p)
    if (!l) {
      l = { priceCents: p, buyQty: 0, sellQty: 0, soldQty: 0, soldCount: 0, soldProfitCents: 0 }
      map.set(p, l)
    }
    return l
  }
  for (const o of orders) {
    if (o.stockName !== stockName || o.remainingQty <= 0) continue
    get(o.rebuyPriceCents).buyQty += o.remainingQty
  }
  for (const t of targets) {
    if (t.stockName !== stockName) continue
    get(t.priceCents).sellQty += t.qty
  }
  for (const s of sells) {
    if (s.stockName !== stockName || s.priceCents === null) continue
    const l = get(s.priceCents)
    l.soldQty += s.qty
    l.soldCount += 1
    l.soldProfitCents += s.profitCents ?? 0
  }
  return [...map.values()].sort((a, b) => a.priceCents - b.priceCents)
}

/** 价格 → 树干半径（元单位，上细下粗；V9.22 收窄成素描细干） */
function trunkRadiusAt(y: number): number {
  const t = Math.min(1, Math.max(0, (y - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN)))
  return 0.26 - 0.12 * t
}

/** 价格 → 树干外表面半径（枝的锚点） */
function outlineRadiusAt(y: number): number {
  return trunkRadiusAt(y) + 0.03
}

interface BranchBin {
  lo: number // 区间下沿（元）
  hi: number
  y: number // 数量加权摆放高度
  repCents: number // 数量最大的档（点击/跳明细用它）
  qty: number
  count: number // 合并档数 = 枝上叶数
  kind: 'buy' | 'sell' | 'sold'
  /** 已成交组的已盈利合计（元 → 分，成本缺失的卖出不计） */
  profitCents: number
  pick?: { cx: number; cy: number; r: number } // 拾取圆（canvas 内 px），点击/投影共用
}

export function TreeTrunk({
  stockName,
  onPick,
}: {
  stockName: string
  onPick: (priceCents: number, opts?: { done?: boolean }) => void
}) {
  const { ledger } = useApp()
  const levels = useMemo(
    () => aggregate(stockName, ledger.sells, ledger.targets, ledger.orders),
    [stockName, ledger],
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  // onPick 是父组件的内联箭头，引用每次渲染都变——走 ref，避免整棵树反复重建
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const canvas = document.createElement('canvas')
    canvas.dataset.tree = 'price'
    canvas.style.touchAction = 'none'
    host.appendChild(canvas)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

    // ---------- 视野状态：世界坐标 y = 价格（元），x 同单位；panX 把整棵树拖离中心 ----------
    const view = { span: 8, camY: 8, panX: 0 }
    let W = 0
    let H = 0
    let dpr = 1
    let k = 1 // px / 元
    const prices = levels.map((l) => l.priceCents / 100)
    const dataLo = prices.length ? Math.min(...prices) : 8
    const dataHi = prices.length ? Math.max(...prices) : 12
    /** 视野钳位：span 限档；下沿（camY − span/2）不许低于 0——股价永远为正 */
    const clampView = () => {
      view.span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, view.span))
      view.camY = Math.min(CAM_MAX, Math.max(view.span / 2, view.camY))
      view.panX = Math.min(PAN_X_MAX * W, Math.max(-PAN_X_MAX * W, view.panX))
    }
    const resetView = () => {
      view.camY = (dataLo + dataHi) / 2
      view.span = Math.max(4, Math.min(SPAN_MAX, (dataHi - dataLo) * 1.6 + 2))
      view.panX = 0
      clampView()
    }

    const sx = (wx: number) => W / 2 + view.panX + wx * k
    const sy = (wy: number) => H / 2 + (view.camY - wy) * k

    // ---------- 树干外轮廓：贴 3D 版的鼓包手感，加一点沿高的起伏（静态、平滑） ----------
    const trunkR = (y: number) =>
      trunkRadiusAt(y) * (1 + 0.05 * Math.sin(y * 0.9 + 1.3) + 0.03 * Math.sin(y * 2.17))

    // ---------- 树干：细锥形双线勾边 + 极淡水彩晕染（V9.22，无排线无树轮） ----------
    const drawTrunk = (y0: number, y1: number) => {
      const stepY = 5 / k // ≈5px 一个采样点
      const n = Math.max(2, Math.ceil((y1 - y0) / stepY))
      const yAt = (i: number) => y0 + ((y1 - y0) * i) / n
      ctx.beginPath()
      for (let i = 0; i <= n; i += 1) {
        const x = sx(-trunkR(yAt(i)))
        if (i) ctx.lineTo(x, sy(yAt(i)))
        else ctx.moveTo(x, sy(yAt(i)))
      }
      for (let i = n; i >= 0; i -= 1) ctx.lineTo(sx(trunkR(yAt(i))), sy(yAt(i)))
      ctx.closePath()
      ctx.fillStyle = INK.wash
      ctx.fill()
      ctx.strokeStyle = inkA(0.85)
      ctx.lineWidth = 1.2
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    // ---------- 数据枝叶 ----------
    const buyList = levels.filter((l) => l.buyQty > 0)
    const sellList = levels.filter((l) => l.sellQty > 0)
    const soldList = levels.filter((l) => l.soldCount > 0)
    const work: { bins: Record<'buy' | 'sell' | 'sold', BranchBin[]> } = {
      bins: { buy: [], sell: [], sold: [] },
    }

    /** 按档间距把同侧档位串成合并组（链式：相邻间距 < gap 就并） */
    const groupLevels = (
      list: TreeLevel[],
      qtyOf: (l: TreeLevel) => number,
      gap: number,
      kind: 'buy' | 'sell' | 'sold',
    ): BranchBin[] => {
      const bins: BranchBin[] = []
      let i = 0
      while (i < list.length) {
        let j = i
        let qty = 0
        let wy = 0
        let profit = 0
        let repQty = -1
        let repCents = list[i].priceCents
        while (j < list.length && (j === i || list[j].priceCents / 100 - list[j - 1].priceCents / 100 < gap)) {
          const l = list[j]
          const q = qtyOf(l)
          qty += q
          wy += (l.priceCents / 100) * q
          profit += l.soldProfitCents
          if (q > repQty) {
            repQty = q
            repCents = l.priceCents
          }
          j += 1
        }
        bins.push({
          lo: list[i].priceCents / 100,
          hi: list[j - 1].priceCents / 100,
          y: qty > 0 ? wy / qty : (list[i].priceCents + list[j - 1].priceCents) / 200,
          repCents,
          qty,
          count: j - i,
          kind,
          profitCents: profit,
        })
        i = j
      }
      return bins
    }

    /** 贝塞尔取点（t ∈ [0,1]） */
    const bez = (s0: number, s1: number, s2: number, t: number) => {
      const u = 1 - t
      return u * u * s0 + 2 * u * t * s1 + t * t * s2
    }

    /** 枝梢注记（V9.22 单行图鉴风）：同侧纵向避让，引线回枝梢 */
    interface CardSpec {
      side: 1 | -1
      tipX: number
      tipY: number
      segs: { text: string; color: string }[]
    }
    const cards: CardSpec[] = []

    const drawSide = (bins: BranchBin[], side: 1 | -1, y0: number, y1: number) => {
      const kzLen = view.span / 8
      const kzThick = Math.pow(kzLen, 0.75)
      for (const bin of bins) {
        if (bin.hi < y0 - 2 || bin.lo > y1 + 2) continue // 视口外不画
        const isSold = bin.kind === 'sold'
        const y = bin.y
        const r = outlineRadiusAt(y)
        const len = isSold
          ? Math.min(2.2, 0.75 + Math.sqrt(bin.qty) / 32) * kzLen
          : Math.min(1.5, 0.5 + Math.sqrt(bin.qty) / 38) * kzLen
        const thick = (1 + Math.min(1.1, Math.sqrt(bin.qty) / 650)) * kzThick * (isSold ? 0.8 : 0.85)
        // 统一弧线（V9.22）：同侧同仰角、控制点统一略低于弦——先平出再上扬/下垂
        const up = isSold ? -0.42 : 0.4
        const p0x = side * r * 0.8
        const p2x = p0x + side * Math.cos(up) * len
        const p2y = y - Math.sin(up) * len
        const p1x = p0x + side * Math.cos(up) * len * 0.55
        const p1y = y + (isSold ? 0.1 : 0.05) * len
        const S0x = sx(p0x)
        const S0y = sy(y)
        const S1x = sx(p1x)
        const S1y = sy(p1y)
        const S2x = sx(p2x)
        const S2y = sy(p2y)

        // 从粗到细收尖：分段变宽描线，圆头衔接
        const M = 16
        const w0 = Math.max(2, 0.17 * thick * k)
        const w1 = Math.max(0.7, w0 * 0.3)
        ctx.strokeStyle = isSold ? INK.sold : bin.kind === 'sell' ? INK.sell : INK.buy
        ctx.lineCap = 'round'
        let px = S0x
        let py = S0y
        for (let s = 1; s <= M; s += 1) {
          const t = s / M
          const qx = bez(S0x, S1x, S2x, t)
          const qy = bez(S0y, S1y, S2y, t)
          ctx.lineWidth = w0 + ((w1 - w0) * s) / M
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(qx, qy)
          ctx.stroke()
          px = qx
          py = qy
        }

        // 聚合档数 = 枝上小点（叶痕，V9.22）：单档枝不缀点
        if (bin.count > 1) {
          const dots = Math.min(bin.count, 8)
          ctx.fillStyle = isSold ? INK.sold : bin.kind === 'sell' ? INK.sell : INK.buy
          ctx.globalAlpha = 0.75
          for (let m = 0; m < dots; m += 1) {
            const t = 0.42 + (0.38 * m) / (dots - 1)
            ctx.beginPath()
            ctx.arc(bez(S0x, S1x, S2x, t), bez(S0y, S1y, S2y, t), 1.6, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
        }

        // 枝梢注记（V9.22）：买/卖标价与份额；枯枝标该价位已盈利（成本缺失的卖出不计）
        if (isSold) {
          cards.push({
            side,
            tipX: S2x,
            tipY: S2y,
            segs:
              bin.profitCents !== 0
                ? [
                    { text: '已盈利 ', color: inkA(0.8) },
                    {
                      text: `${bin.profitCents > 0 ? '+' : '−'}¥${(Math.abs(bin.profitCents) / 100).toLocaleString('zh-CN')}`,
                      color: bin.profitCents > 0 ? INK.sell : '#7a9163',
                    },
                  ]
                : [
                    { text: '已成交 ', color: inkA(0.8) },
                    { text: `× ${bin.qty.toLocaleString('zh-CN')}`, color: INK.sold },
                  ],
          })
        } else {
          cards.push({
            side,
            tipX: S2x,
            tipY: S2y,
            segs: [
              { text: `${bin.kind === 'sell' ? '卖' : '买'} `, color: bin.kind === 'sell' ? INK.sell : INK.buy },
              { text: `${(bin.repCents / 100).toFixed(2)}`, color: INK.ink },
              { text: ` ×${bin.qty.toLocaleString('zh-CN')}`, color: inkA(0.72) },
            ],
          })
        }

        // 拾取圆：贴枝中段，杆细也能点中；点击/投影共用同一圆心
        bin.pick = {
          cx: bez(S0x, S1x, S2x, 0.5),
          cy: bez(S0y, S1y, S2y, 0.5),
          r: Math.max(14, Math.min(0.46, 0.3 + 0.02 * bin.count) * kzThick * k),
        }
      }
    }

    /** 注记绘制：同侧按枝梢高度排序后纵向避让，绝不重叠（V9.22 单行图鉴注记） */
    const drawCards = () => {
      ctx.font = `11.5px ${SERIF}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (const side of [-1, 1] as const) {
        const list = cards.filter((c) => c.side === side).sort((a, b) => a.tipY - b.tipY)
        let lastBottom = -Infinity
        for (const c of list) {
          const w = Math.round(c.segs.reduce((acc, sg) => acc + ctx.measureText(sg.text).width, 0)) + 16
          const h = 21
          let cy = c.tipY
          if (cy - h / 2 < lastBottom + 5) cy = lastBottom + 5 + h / 2
          lastBottom = cy + h / 2
          const innerX = c.tipX + side * 16
          const bx = Math.max(4, Math.min(W - w - 4, side > 0 ? innerX : innerX - w))
          // 引线：枝梢小点 → 牌边（先画，压在牌下面）
          ctx.fillStyle = inkA(0.9)
          ctx.beginPath()
          ctx.arc(c.tipX, c.tipY, 1.4, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = inkA(0.45)
          ctx.lineWidth = 0.8
          ctx.beginPath()
          ctx.moveTo(c.tipX, c.tipY)
          ctx.lineTo(side > 0 ? bx : bx + w, cy)
          ctx.stroke()
          ctx.beginPath()
          ctx.roundRect(bx, cy - h / 2, w, h, 4)
          ctx.fillStyle = INK.tag
          ctx.fill()
          ctx.strokeStyle = inkA(0.38)
          ctx.stroke()
          let tx = bx + 8
          for (const sg of c.segs) {
            ctx.fillStyle = sg.color
            ctx.fillText(sg.text, tx, cy + 0.5)
            tx += ctx.measureText(sg.text).width
          }
        }
      }
    }

    // ---------- 轴刻度（V9.22）：整步 = 钉在树干正中的小泡牌；半步 = 左侧短刻度 ----------
    const labelStep = (span: number, heightPx: number) => {
      const raw = (LABEL_MIN_GAP * span) / Math.max(1, heightPx)
      return LABEL_LADDER.find((s) => s >= raw) ?? LABEL_LADDER[LABEL_LADDER.length - 1]
    }

    const drawAxis = (y0: number, y1: number) => {
      const step = labelStep(view.span, H)
      const half = step / 2
      ctx.lineWidth = 1
      let count = 0
      for (let m = Math.ceil((y0 + half * 0.01) / half); m * half <= y1 && count < 400; m += 1) {
        const y = m * half
        if (Math.abs(y / step - Math.round(y / step)) < 1e-6) continue // 整步处画泡牌
        const py = sy(y)
        if (py < -4 || py > H + 4) continue
        const r = trunkR(y)
        ctx.strokeStyle = inkA(0.3)
        ctx.beginPath()
        ctx.moveTo(sx(-r - 5), py)
        ctx.lineTo(sx(-r + 2), py)
        ctx.stroke()
        count += 1
      }
      ctx.font = `11.5px ${SERIF}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let m = Math.ceil((y0 + 0.1) / step); m * step <= y1 - 0.1; m += 1) {
        const y = m * step
        const py = sy(y)
        if (py < -12 || py > H + 12) continue
        const text = step < 1 ? y.toFixed(1) : String(Math.round(y))
        const w = ctx.measureText(text).width + 14
        ctx.beginPath()
        ctx.roundRect(sx(0) - w / 2, py - 10, w, 20, 10)
        ctx.fillStyle = INK.tag
        ctx.fill()
        ctx.strokeStyle = inkA(0.4)
        ctx.lineWidth = 0.9
        ctx.stroke()
        ctx.fillStyle = inkA(0.95)
        ctx.fillText(text, sx(0), py + 0.5)
      }
    }

    // ---------- 渲染：按需重绘，只有交互 / 改尺寸 / 回前台才画 ----------
    const renderFrame = () => {
      k = H / view.span
      const half = view.span / 2
      const y0 = Math.max(TRUNK_MIN, view.camY - half) - 1
      const y1 = Math.min(TRUNK_MAX, view.camY + half) + 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = INK.paper
      ctx.fillRect(0, 0, W, H)

      // 合并间距按「数据牌行高」推算（V9.21）：放大时间距变大，聚合枝自动
      // 分散回原始档位数（下限 0.01 元 = A 股最小报价单位），每个不重叠
      const gapRaw = (CARD_ROW_PX * view.span) / Math.max(1, H)
      const gap = Math.max(0.01, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-4, gapRaw)) * 2) / 2))
      work.bins.sold = groupLevels(soldList, (l) => l.soldQty, gap, 'sold')
      work.bins.sell = groupLevels(sellList, (l) => l.sellQty, gap, 'sell')
      work.bins.buy = groupLevels(buyList, (l) => l.buyQty, gap, 'buy')

      cards.length = 0
      drawSide(work.bins.sold, 1, y0, y1) // 枯枝垫底（树干后面）
      drawTrunk(y0, y1)
      drawSide(work.bins.sell, 1, y0, y1)
      drawSide(work.bins.buy, -1, y0, y1)
      drawCards()
      drawAxis(y0, y1) // 泡牌最后画，压住枝根保持干面干净
    }

    // ---------- 交互：滚轮 / 捏合缩放，拖动攀爬 + 左右平移，点枝跳明细 ----------
    const pointers = new Map<number, { x: number; y: number }>()
    let pinchDist0 = 1
    let spanAtPinch = 0
    let pinchMidY = 0
    let dragMoved = 0
    let dirty = true
    const markDirty = () => {
      dirty = true
    }

    // 手指往下拖 → 树往下走 → 看更高价（和地图 / 列表同向）；左右拖 → 整棵树跟手平移
    const panBy = (dyPx: number) => {
      view.camY += dyPx * (view.span / (H || 1))
      clampView()
      markDirty()
    }
    const panXBy = (dxPx: number) => {
      view.panX += dxPx
      clampView()
      markDirty()
    }
    const zoomBy = (factor: number) => {
      view.span /= factor
      clampView()
      markDirty()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomBy(Math.pow(1.0014, -e.deltaY))
    }
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      dragMoved = 0
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinchDist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1
        spanAtPinch = view.span
        pinchMidY = (a.y + b.y) / 2
      }
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      dragMoved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 1) {
        panBy(e.clientY - prev.y)
        panXBy(e.clientX - prev.x)
      } else if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
        view.span = spanAtPinch * (pinchDist0 / d)
        clampView()
        const midY = (a.y + b.y) / 2
        panBy(midY - pinchMidY)
        pinchMidY = midY
      }
    }
    const onUp = (e: PointerEvent) => {
      const wasSingle = pointers.size === 1
      pointers.delete(e.pointerId)
      canvas.releasePointerCapture?.(e.pointerId)
      if (wasSingle && dragMoved < 7) {
        const rect = canvas.getBoundingClientRect()
        const bin = hitTest(e.clientX - rect.left, e.clientY - rect.top)
        if (bin) {
          // 已成交跳明细要放开「隐藏已完成」，否则点过去是空列表
          pickRef.current(bin.repCents, bin.kind === 'sold' ? { done: true } : undefined)
        }
      }
    }

    /** 命中检测：圆心离点击最近者胜（2D 无深度，距离当远近）；等距再按 待卖→待买→枯枝 */
    const hitTest = (x: number, y: number): BranchBin | null => {
      const rank: Record<'buy' | 'sell' | 'sold', number> = { sell: 0, buy: 1, sold: 2 }
      let best: BranchBin | null = null
      let bestD = Infinity
      let bestRank = Infinity
      for (const kind of ['sell', 'buy', 'sold'] as const) {
        for (const bin of work.bins[kind]) {
          const p = bin.pick
          if (!p) continue
          const d = Math.hypot(x - p.cx, y - p.cy)
          if (d > p.r) continue
          if (d < bestD - 1e-6 || (d <= bestD + 1e-6 && rank[kind] < bestRank)) {
            best = bin
            bestD = Math.min(d, bestD)
            bestRank = rank[kind]
          }
        }
      }
      return best
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    // ---------- 尺寸 ----------
    const resize = () => {
      W = host.clientWidth || 320
      H = host.clientHeight || 380
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      clampView()
      markDirty()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    const onVisible = () => {
      if (!document.hidden) markDirty()
    }
    document.addEventListener('visibilitychange', onVisible)
    resetView()
    resize()

    ;(canvas as HTMLCanvasElement & { __tree?: unknown }).__tree = {
      levels: () =>
        levels.map((l) => ({ cents: l.priceCents, buy: l.buyQty, sell: l.sellQty, sold: l.soldQty, profit: l.soldProfitCents })),
      span: () => view.span,
      center: () => view.camY,
      panX: () => view.panX,
      /** e2e 恢复视角用：与拖动同一入口 */
      panXBy: (dx: number) => {
        view.panX += dx
        clampView()
        markDirty()
      },
      /** 在视口坐标处做一次命中检测，返回命中的档（e2e 诊断/兜底用） */
      pickAt: (px: number, py: number) => {
        const rect = canvas.getBoundingClientRect()
        const bin = hitTest(px - rect.left, py - rect.top)
        return bin ? { cents: bin.repCents, kind: bin.kind } : null
      },
      zoomBy,
      /** e2e 用：直接设视野（截图等一次性视角变化后恢复现场） */
      setView: (span: number, camY: number) => {
        view.span = span
        view.camY = camY
        clampView()
        markDirty()
      },
      projectPrice: (cents: number, side: 1 | -1 | 0 = 1) => {
        // 投影到该档所在合并枝的拾取圆心——e2e 用它定位点击点（0 = 已成交枯枝）。
        // repCents = 所在合并组的代表档（组内最密档）：点击后跳的就是它
        const y = cents / 100
        const bins = side > 0 ? work.bins.sell : side < 0 ? work.bins.buy : work.bins.sold
        const bin = bins.find((b) => y >= b.lo - 1e-6 && y <= b.hi + 1e-6)
        const px = bin?.pick ? bin.pick.cx : sx((side || 1) * (outlineRadiusAt(y) + 0.9))
        const py = bin?.pick ? bin.pick.cy : sy(y)
        const rect = canvas.getBoundingClientRect()
        return { x: Math.round(rect.left + px), y: Math.round(rect.top + py), repCents: bin?.repCents ?? null }
      },
    }

    // 按需渲染：只有交互 / 改尺寸 / 回前台才重画（V9.22 去掉沸腾抖动，静态即素雅）
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || !dirty) return
      dirty = false
      renderFrame()
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      delete (canvas as HTMLCanvasElement & { __tree?: unknown }).__tree
      canvas.remove()
    }
  }, [levels, stockName])

  return (
    <div className="tree-wrap">
      <div ref={hostRef} className="tree-host" />
      <div className="tree-legend">
        <span className="dot buy">待买枝 · 左</span>
        <span className="dot sell">待卖枝 · 右</span>
        <span className="dot fallen">枯枝 · 已盈利</span>
        <span className="dot agg">枝上点 · 聚合档数</span>
        <span className="hint">滚轮缩放 · 拖动攀爬 / 平移 · 点枝看明细</span>
      </div>
    </div>
  )
}

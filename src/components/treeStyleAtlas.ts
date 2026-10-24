/**
 * 图鉴素雅风（V9.22，默认）：做减法——无云/装饰叶/树皮排线/树轮/沸腾抖动。
 *   干体 = 细锥形双线勾边 + 极淡水彩晕染；整步价签是钉在树干正中的小泡牌，
 *   半步档只留左侧短刻度；枝 = 统一弧线（同侧同仰角、根粗梢细收尖），
 *   聚合档数 = 枝上小点（叶痕）；注记 = 单行衬线字（买/卖 价 ×份额、已盈利 ±¥xx），
 *   枝梢小点 + 细引线；色板收敛 5 色：纸白/墨褐/青灰蓝(买)/赭红(卖)/枯褐(已成交)。
 */
import {
  bez,
  labelStep,
  TRUNK_MAX,
  TRUNK_MIN,
  type BranchBin,
  type TreeFrame,
  type TreeStyle,
  type WorkBins,
} from './treeStyle'

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

/** 价格 → 树干半径（元单位，上细下粗；素描细干） */
function trunkRadiusAt(y: number): number {
  const t = Math.min(1, Math.max(0, (y - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN)))
  return 0.26 - 0.12 * t
}

/** 树干外轮廓：轻微沿高起伏（静态、平滑） */
const trunkR = (y: number) =>
  trunkRadiusAt(y) * (1 + 0.05 * Math.sin(y * 0.9 + 1.3) + 0.03 * Math.sin(y * 2.17))

interface CardSpec {
  side: 1 | -1
  tipX: number
  tipY: number
  segs: { text: string; color: string }[]
}

export const atlasStyle: TreeStyle = {
  id: 'atlas',
  cardRowPx: 27,
  boils: false,
  outlineRadiusAt: (y) => trunkRadiusAt(y) + 0.03,

  drawFrame(f: TreeFrame, bins: WorkBins) {
    const { ctx, W, H, k, span, sx, sy, y0, y1 } = f

    // 树干：细锥形双线勾边 + 极淡水彩晕染（无排线无树轮）
    const drawTrunk = () => {
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

    /** 统一弧线枝：同侧同仰角、控制点统一略低于弦——先平出再上扬/下垂 */
    const drawSide = (list: BranchBin[], side: 1 | -1) => {
      const kzLen = span / 8
      const kzThick = Math.pow(kzLen, 0.75)
      const cards: CardSpec[] = []
      for (const bin of list) {
        if (bin.hi < y0 - 2 || bin.lo > y1 + 2) continue // 视口外不画
        const isSold = bin.kind === 'sold'
        const y = bin.y
        const r = atlasStyle.outlineRadiusAt(y)
        const len = isSold
          ? Math.min(2.2, 0.75 + Math.sqrt(bin.qty) / 32) * kzLen
          : Math.min(1.5, 0.5 + Math.sqrt(bin.qty) / 38) * kzLen
        const thick = (1 + Math.min(1.1, Math.sqrt(bin.qty) / 650)) * kzThick * (isSold ? 0.8 : 0.85)
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

        // 聚合档数 = 枝上小点（叶痕）：单档枝不缀点
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

        // 枝梢注记：买/卖标价与份额；枯枝标该价位已盈利（成本缺失的卖出不计）
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
      return cards
    }

    /** 注记绘制：同侧按枝梢高度排序后纵向避让，绝不重叠（单行图鉴注记） */
    const drawCards = (cards: CardSpec[]) => {
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

    /** 轴刻度：整步 = 钉在树干正中的小泡牌；半步 = 左侧短刻度 */
    const drawAxis = () => {
      const step = labelStep(span, H)
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

    ctx.fillStyle = INK.paper
    ctx.fillRect(0, 0, W, H)
    const soldCards = drawSide(bins.sold, 1) // 枯枝垫底（树干后面）
    drawTrunk()
    const sellCards = drawSide(bins.sell, 1)
    const buyCards = drawSide(bins.buy, -1)
    drawCards([...soldCards, ...sellCards, ...buyCards])
    drawAxis() // 泡牌最后画，压住枝根保持干面干净
  },
}

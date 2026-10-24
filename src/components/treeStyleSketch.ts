/**
 * 手绘抖动风（V9.18~V9.21 存档）：概览树上一代绘制的原样保留，供风格切换。
 *   树干 = 左右两条带噪声的轮廓曲线（上细下粗）+ 浅木色填充 + 纵向树皮排线，
 *          树干上的横向刻度线当树轮（近景 0.1 一道，拉远换 0.5 / 1）；
 *   树枝 = 二次贝塞尔从粗到细收尖：每枝固定随机（锚在 bin.lo，重绘不跳）、
 *          待买左蓝上扬 / 待卖右红上扬 / 已成交枯黄下垂（更长，垫在干后一层）；
 *   叶 = 聚合档数 = 叶数，散开的单档枝缀 1~2 片装饰叶，绿/橄榄/黄绿参差；
 *   装饰 = 浅灰蓝手绘云，世界坐标锚定随滚动移动，贴屏/缩没就跳过；
 *   数据牌 = 双行圆角牌（同侧纵向避让），交互后「沸腾」~140ms 线条重排。
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

/** 墨色盘（V9.21 参考手绘插画）：纸底 / 灰棕线稿 / 浅棕干体 / 低饱和枝色 */
const INK = {
  paper: '#f6efdc',
  trunk: '#7d6449',
  wood: '#dcc7a3',
  buy: '#5f83b5',
  sell: '#b65c4f',
  fallen: '#b3935f',
  cloud: '#fdfbf2',
  cloudLine: 'rgba(151, 166, 178, 0.45)',
  cardFill: '#fffdf5',
  cardLine: 'rgba(139, 122, 98, 0.78)',
  cardText: '#5c4b38',
}
/** 叶色盘：绿 / 橄榄 / 黄绿参差 */
const LEAF_COLORS = ['#7fa65b', '#a3b168', '#c9c46e', '#6f9a55']

/** 云朵：[高度(元), 横位(元), 尺度]——锚在世界坐标，随攀爬滚动 */
const CLOUDS: [number, number, number][] = [
  [16, -4.4, 1.0],
  [44, 4.8, 0.85],
  [92, -5.2, 1.1],
  [150, 4.4, 0.95],
  [215, -4.6, 1.05],
]

/** 价格 → 树干半径（元单位，上细下粗；粗壮插画风） */
function trunkRadiusAt(y: number): number {
  const t = Math.min(1, Math.max(0, (y - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN)))
  return 0.55 - 0.19 * t
}

interface CardSpec {
  side: 1 | -1
  tipX: number
  tipY: number
  seed: number
  lines: { text: string; color: string }[]
}

export const sketchStyle: TreeStyle = {
  id: 'sketch',
  cardRowPx: 34,
  boils: true,
  outlineRadiusAt: (y) => trunkRadiusAt(y) + 0.03,

  drawFrame(f: TreeFrame, bins: WorkBins) {
    const { ctx, W, H, k, span, sx, sy, y0, y1, boilSeed } = f

    /** 树干外轮廓半径（元）：贴 3D 版的鼓包手感，加一点沿高的起伏 */
    const trunkR = (y: number) =>
      trunkRadiusAt(y) * (1 + 0.05 * Math.sin(y * 0.9 + 1.3) + 0.03 * Math.sin(y * 2.17))

    /** 平滑手抖（世界坐标 t 锚定 → 滚动时形状连续；salt 区分线条）→ [-1, 1] */
    const wob = (t: number, salt: number) =>
      Math.sin(t * 1.7 + (boilSeed + salt) * 2.13) * 0.55 +
      Math.sin(t * 3.1 + (boilSeed + salt) * 4.71) * 0.3 +
      Math.sin(t * 5.7 + (boilSeed + salt) * 7.87) * 0.15

    // 云（浅灰蓝手绘轮廓，先描后填让外缘只剩一圈线）
    const drawClouds = () => {
      ctx.lineWidth = 1.2
      for (const [cy, cx0, s] of CLOUDS) {
        if (cy < y0 - 6 || cy > y1 + 6) continue
        const rx0 = 0.62 * s * 1.25 * k
        if (rx0 < 2 || rx0 > W * 0.55) continue // 缩没了/贴满屏都不画
        for (const [dx, dy, r] of [
          [0, 0, 0.62],
          [0.55, -0.08, 0.44],
          [-0.52, -0.1, 0.4],
          [0.12, 0.26, 0.4],
        ] as const) {
          const px = sx(cx0 + dx * s + wob(cy + dx, 11.3) * 0.06)
          const py = sy(cy + dy * s)
          ctx.beginPath()
          ctx.ellipse(px, py, r * s * 1.25 * k, r * s * 0.8 * k, 0, 0, Math.PI * 2)
          ctx.strokeStyle = INK.cloudLine
          ctx.stroke()
          ctx.fillStyle = INK.cloud
          ctx.fill()
        }
      }
    }

    // 树干：轮廓曲线 + 浅木填充 + 树皮排线 + 树轮刻度
    const drawTrunk = () => {
      const stepY = 5 / k // ≈5px 一个采样点，抖动分辨率跟着屏幕走
      const n = Math.max(2, Math.ceil((y1 - y0) / stepY))
      const yAt = (i: number) => y0 + ((y1 - y0) * i) / n
      const edge = (side: 1 | -1) => {
        const pts: [number, number][] = []
        for (let i = 0; i <= n; i += 1) {
          const y = yAt(i)
          const r = trunkR(y) + (wob(y * 2.6, side * 3.7) * 1.2) / k
          pts.push([sx(side * r), sy(y)])
        }
        return pts
      }
      const L = edge(-1)
      const R = edge(1)
      ctx.beginPath()
      L.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      for (let i = R.length - 1; i >= 0; i -= 1) ctx.lineTo(R[i][0], R[i][1])
      ctx.closePath()
      ctx.fillStyle = INK.wood
      ctx.fill()
      ctx.strokeStyle = INK.trunk
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.stroke()

      const midY = (y0 + y1) / 2
      const trunkPx = trunkR(midY) * k * 2
      // 树皮纵排线：树干够宽才画，按宽度决定几根；长波慢抖，别变成规整竖线
      const cols = trunkPx > 20 ? Math.max(2, Math.min(8, Math.round(trunkPx / 11))) : 0
      ctx.strokeStyle = 'rgba(125, 100, 73, 0.32)'
      ctx.lineWidth = 1
      for (let c = 0; c < cols; c += 1) {
        const frac = ((c + 0.5) / cols) * 2 - 1
        ctx.beginPath()
        for (let i = 0; i <= n; i += 1) {
          const y = yAt(i)
          const wx = frac * trunkR(y) * 0.75 + (wob(y * 1.8, c * 7.1) * 3) / k
          if (i === 0) ctx.moveTo(sx(wx), sy(y))
          else ctx.lineTo(sx(wx), sy(y))
        }
        ctx.stroke()
      }
      // 树轮：两侧短刻度（断面年轮感），整元一道贯穿淡线当主刻度
      const minorStep = span < 8 ? 0.1 : span < 60 ? 0.5 : 1
      const majorEvery = Math.round(1 / minorStep)
      if (trunkPx > 8) {
        ctx.lineWidth = 1
        let count = 0
        for (let m = Math.ceil(y0 / minorStep); m * minorStep <= y1 && count < 300; m += 1) {
          const y = m * minorStep
          const r = trunkR(y)
          const major = m % majorEvery === 0
          const tick = r * (major ? 0.3 : 0.16)
          ctx.strokeStyle = major ? 'rgba(125, 100, 73, 0.35)' : 'rgba(125, 100, 73, 0.18)'
          ctx.beginPath()
          ctx.moveTo(sx(-r), sy(y))
          ctx.lineTo(sx(-r + tick), sy(y))
          ctx.moveTo(sx(r), sy(y))
          ctx.lineTo(sx(r - tick), sy(y))
          ctx.stroke()
          if (major) {
            ctx.strokeStyle = 'rgba(125, 100, 73, 0.1)'
            ctx.beginPath()
            ctx.moveTo(sx(-r), sy(y))
            ctx.lineTo(sx(r), sy(y))
            ctx.stroke()
          }
          count += 1
        }
      }
    }

    const drawSide = (list: BranchBin[], side: 1 | -1) => {
      const kzLen = span / 8
      const kzThick = Math.pow(kzLen, 0.75)
      const cards: CardSpec[] = []
      for (const bin of list) {
        if (bin.hi < y0 - 2 || bin.lo > y1 + 2) continue // 视口外不画
        const isSold = bin.kind === 'sold'
        // 每枝固定随机（锚在 bin.lo），重绘/沸腾都不会跳
        let seed = Math.round(bin.lo * 7919) + (side > 0 ? 31 : 57)
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        const y = bin.y
        const r = sketchStyle.outlineRadiusAt(y)
        const len = isSold
          ? Math.min(2.2, 0.75 + Math.sqrt(bin.qty) / 32) * kzLen
          : Math.min(1.5, 0.5 + Math.sqrt(bin.qty) / 38) * kzLen
        const thick = (1 + Math.min(1.1, Math.sqrt(bin.qty) / 650)) * kzThick * (isSold ? 0.8 : 0.85)
        const tilt = isSold ? -(0.35 + rnd() * 0.15) : 0.28 + rnd() * 0.3
        // 世界坐标贝塞尔：根部藏进树干，待成交抬头、枯枝低头下垂
        const p0x = side * r * 0.8
        const p2x = p0x + side * Math.cos(tilt) * len
        const p2y = y + Math.sin(tilt) * len
        const p1x = (p0x + p2x) / 2 + (rnd() - 0.5) * 0.2 * len
        const p1y = (y + p2y) / 2 + (isSold ? -1 : 1) * (0.05 + rnd() * 0.12) * len
        const S0x = sx(p0x)
        const S0y = sy(y)
        const S1x = sx(p1x)
        const S1y = sy(p1y)
        const S2x = sx(p2x)
        const S2y = sy(p2y)

        // 从粗到细收尖：分段变宽描线，圆头衔接（加粗到能撑起数据牌）
        const M = 12
        const w0 = Math.max(2, 0.17 * thick * k)
        const w1 = Math.max(0.9, w0 * 0.3)
        ctx.strokeStyle = isSold ? INK.fallen : bin.kind === 'sell' ? INK.sell : INK.buy
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

        // 叶：聚合档数 = 叶数（密度），散开后每枝缀 1~2 片装饰叶；绿/橄榄/黄绿参差
        if (!isSold) {
          const ls = Math.max(0.55, 1.15 - bin.count * 0.045) * kzThick
          const long = Math.max(3.5, 0.16 * ls * k)
          const short = long * 0.38
          const baseAng = Math.atan2(S2y - S0y, S2x - S0x)
          const leafN = bin.count > 1 ? Math.min(bin.count, 12) : 2
          ctx.lineWidth = 0.8
          for (let m = 0; m < leafN; m += 1) {
            const t = leafN === 1 ? 0.5 : (m + 0.5) / leafN
            const lx = bez(S0x, S1x, S2x, t * 0.94 + 0.03)
            const ly = bez(S0y, S1y, S2y, t * 0.94 + 0.03)
            const ang = baseAng + (m % 2 === 0 ? -0.95 : 0.95)
            ctx.fillStyle = LEAF_COLORS[Math.floor(rnd() * LEAF_COLORS.length)]
            ctx.strokeStyle = 'rgba(84, 110, 58, 0.55)'
            ctx.beginPath()
            ctx.ellipse(lx + Math.cos(ang) * long * 0.4, ly + Math.sin(ang) * long * 0.4, long, short, ang, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
          }
        }

        // 枝上数据牌：买/卖标价与份额；枯枝标该价位已盈利（成本缺失的卖出不计）
        if (isSold) {
          cards.push({
            side,
            tipX: S2x,
            tipY: S2y,
            seed: bin.lo,
            lines:
              bin.profitCents !== 0
                ? [
                    { text: '已盈利', color: INK.cardText },
                    {
                      text: `${bin.profitCents > 0 ? '+' : '−'}¥${(Math.abs(bin.profitCents) / 100).toLocaleString('zh-CN')}`,
                      color: bin.profitCents > 0 ? INK.sell : '#6f9a55',
                    },
                  ]
                : [
                    { text: '已成交', color: INK.cardText },
                    { text: `× ${bin.qty.toLocaleString('zh-CN')} 股`, color: INK.fallen },
                  ],
          })
        } else {
          cards.push({
            side,
            tipX: S2x,
            tipY: S2y,
            seed: bin.lo,
            lines: [
              { text: `${bin.kind === 'sell' ? '卖' : '买'} ${(bin.repCents / 100).toFixed(2)}`, color: INK.cardText },
              { text: `× ${bin.qty.toLocaleString('zh-CN')} 股`, color: bin.kind === 'sell' ? INK.sell : INK.buy },
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

    /** 数据牌绘制：同侧按枝梢高度排序后纵向避让，绝不重叠 */
    const drawCards = (cards: CardSpec[]) => {
      ctx.font = '600 10.5px "Segoe UI", system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const side of [-1, 1] as const) {
        const list = cards.filter((c) => c.side === side).sort((a, b) => a.tipY - b.tipY)
        let lastBottom = -Infinity
        for (const c of list) {
          const w = Math.max(...c.lines.map((l) => ctx.measureText(l.text).width)) + 16
          const h = 34
          let cy = c.tipY
          if (cy - h / 2 < lastBottom + 4) cy = lastBottom + 4 + h / 2
          lastBottom = cy + h / 2
          const cx = Math.min(
            W - w / 2 - 2,
            Math.max(w / 2 + 2, c.tipX + side * (10 + w / 2)),
          )
          // 连接线：枝梢 → 牌边（先画，压在牌下面）
          ctx.strokeStyle = INK.cardLine
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(c.tipX, c.tipY)
          ctx.lineTo(cx - side * (w / 2), cy)
          ctx.stroke()
          ctx.save()
          ctx.translate(cx, cy)
          ctx.rotate(wob(c.seed, side * 9.1) * 0.012)
          ctx.beginPath()
          ctx.roundRect(-w / 2, -h / 2, w, h, 9)
          ctx.fillStyle = INK.cardFill
          ctx.fill()
          ctx.strokeStyle = INK.cardLine
          ctx.stroke()
          c.lines.forEach((l, i) => {
            ctx.fillStyle = l.color
            ctx.fillText(l.text, 0, i === 0 ? -7.5 : 7.5)
          })
          ctx.restore()
        }
      }
    }

    // 价签：钉在树干正中的手绘纸牌（1-2-5 档步长）
    const drawLabels = () => {
      const step = labelStep(span, H)
      ctx.font = '600 11px "Segoe UI", system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let m = Math.ceil((y0 + 0.1) / step); m * step <= y1 - 0.1; m += 1) {
        const y = m * step
        const py = sy(y)
        if (py < -12 || py > H + 12) continue
        const px = sx(0) + wob(y, 5.5) * 0.8
        const text = step < 1 ? y.toFixed(1) : String(Math.round(y))
        const w = ctx.measureText(text).width + 12
        ctx.beginPath()
        ctx.roundRect(px - w / 2, py - 9, w, 18, 9)
        ctx.fillStyle = 'rgba(255, 250, 238, 0.95)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(203, 191, 169, 0.8)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = '#6b4a2e'
        ctx.fillText(text, px, py + 0.5)
      }
    }

    ctx.fillStyle = INK.paper
    ctx.fillRect(0, 0, W, H)
    drawClouds()
    const soldCards = drawSide(bins.sold, 1) // 枯枝垫底（树干后面）
    drawTrunk()
    const sellCards = drawSide(bins.sell, 1)
    const buyCards = drawSide(bins.buy, -1)
    drawCards([...soldCards, ...sellCards, ...buyCards])
    drawLabels()
  },
}

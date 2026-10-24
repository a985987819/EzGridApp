/**
 * 2D 价格树（V9.18）：概览页的纵轴是一棵手绘线条风的 Canvas 2D 树。
 *
 * V9.18 改版：弃用 three.js（依赖与 PWA 预缓存不再背 3D 引擎），单个 <canvas>
 * 按需直绘，正交无透视。构图延续 V9.14~V9.17 的手绘插画风——纸底米白、深棕
 * 线稿、低饱和自然色：
 *   树干 = 左右两条带噪声的轮廓曲线（上细下粗）+ 浅木色填充 + 纵向树皮排线，
 *          树干上的横向刻度线当树轮（近景 0.1 一道，拉远换 0.5 / 1）；
 *   树枝 = 二次贝塞尔从粗到细收尖：待买左蓝上扬 / 待卖右红上扬 /
 *          已成交枯黄下垂（更长，垫在树干后面一层）；
 *   装饰 = 浅灰蓝手绘云，世界坐标锚定随滚动移动，贴屏/缩没就跳过。
 * 手绘沸腾：交互后 ~140ms 内每 2 帧进 1 个种子，所有线条抖动随之重排——
 *   笔触肉眼可见地重画；停手即静止，回归按需渲染。
 *
 * 数据逻辑与 V9.9~V9.17 一致：
 *   待买/待卖枝长随数量；相邻档间距 < gap 合并成一枝，枝上「聚合档数」片
 *   绿叶表密度；不同树枝至少隔 0.5 元；拉远时枝长按 span 等比放大（画面
 *   占比恒定）；价签按最小屏幕间距从 1-2-5 档取步长、钉在树干正中；轴全程
 *   线性等比例，视野下沿钳 0。
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
}

const TRUNK_MIN = -20
const TRUNK_MAX = 300
const CAM_MAX = 288
const SPAN_MIN = 0.5
const SPAN_MAX = 150
/** 相邻两枝最少要占的屏幕行数（按 460px 高估）：行距不足就合并 */
const ROWS_PER_SCREEN = 22
/** 价签最小屏幕间距（px）：任何缩放下相邻两个数字至少隔这么远 */
const LABEL_MIN_GAP = 80
/** 价签步长档位（1-2-5 序列；0.1 档对应 A 股最小报价单位） */
const LABEL_LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
/** 树干最多拖离画面中心 ±45% 画布宽：能看两侧的枝，又不至于整棵拖没 */
const PAN_X_MAX = 0.45

/** 墨色盘：纸底 / 深棕线稿 / 浅木填充，枝叶三色承袭 3D 版 */
const INK = {
  paper: '#f6efdc',
  trunk: '#75492c',
  wood: '#c8a478',
  buy: '#4a7cc4',
  sell: '#c04f48',
  fallen: '#c39a4e',
  leaf: '#5f9a4a',
  cloud: '#fdfbf2',
  cloudLine: 'rgba(146, 164, 178, 0.5)',
}

/** 云朵：[高度(元), 横位(元), 尺度]——锚在世界坐标，随攀爬滚动 */
const CLOUDS: [number, number, number][] = [
  [16, -4.4, 1.0],
  [44, 4.8, 0.85],
  [92, -5.2, 1.1],
  [150, 4.4, 0.95],
  [215, -4.6, 1.05],
]

function aggregate(
  stockName: string,
  sells: { stockName: string; priceCents: number | null; qty: number }[],
  targets: SellTarget[],
  orders: { stockName: string; rebuyPriceCents: number; remainingQty: number }[],
): TreeLevel[] {
  const map = new Map<number, TreeLevel>()
  const get = (p: number) => {
    let l = map.get(p)
    if (!l) {
      l = { priceCents: p, buyQty: 0, sellQty: 0, soldQty: 0, soldCount: 0 }
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
  }
  return [...map.values()].sort((a, b) => a.priceCents - b.priceCents)
}

/** 价格 → 树干半径（元单位，上细下粗） */
function trunkRadiusAt(y: number): number {
  const t = Math.min(1, Math.max(0, (y - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN)))
  return 0.55 - 0.19 * t
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

    // ---------- 手绘噪声：全场共用一个种子，沸腾时所有线条一起重排 ----------
    let boilSeed = 0
    /** 平滑手抖（世界坐标 t 锚定 → 滚动时形状连续；salt 区分线条）→ [-1, 1] */
    const wob = (t: number, salt: number) =>
      Math.sin(t * 1.7 + (boilSeed + salt) * 2.13) * 0.55 +
      Math.sin(t * 3.1 + (boilSeed + salt) * 4.71) * 0.3 +
      Math.sin(t * 5.7 + (boilSeed + salt) * 7.87) * 0.15

    /** 树干外轮廓半径（元）：贴 3D 版的鼓包手感，加一点沿高的起伏 */
    const trunkR = (y: number) =>
      trunkRadiusAt(y) * (1 + 0.05 * Math.sin(y * 0.9 + 1.3) + 0.03 * Math.sin(y * 2.17))

    // ---------- 云（浅灰蓝手绘轮廓，先描后填让外缘只剩一圈线） ----------
    const drawClouds = (y0: number, y1: number) => {
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

    // ---------- 树干：轮廓曲线 + 浅木填充 + 树皮排线 + 树轮刻度 ----------
    const drawTrunk = (y0: number, y1: number) => {
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
      const cols = trunkPx > 24 ? Math.max(2, Math.min(6, Math.round(trunkPx / 16))) : 0
      ctx.strokeStyle = 'rgba(117, 73, 44, 0.28)'
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
      const minorStep = view.span < 8 ? 0.1 : view.span < 60 ? 0.5 : 1
      const majorEvery = Math.round(1 / minorStep)
      if (trunkPx > 8) {
        ctx.lineWidth = 1
        let count = 0
        for (let m = Math.ceil(y0 / minorStep); m * minorStep <= y1 && count < 300; m += 1) {
          const y = m * minorStep
          const r = trunkR(y)
          const major = m % majorEvery === 0
          const tick = r * (major ? 0.3 : 0.16)
          ctx.strokeStyle = major ? 'rgba(117, 73, 44, 0.35)' : 'rgba(117, 73, 44, 0.18)'
          ctx.beginPath()
          ctx.moveTo(sx(-r), sy(y))
          ctx.lineTo(sx(-r + tick), sy(y))
          ctx.moveTo(sx(r), sy(y))
          ctx.lineTo(sx(r - tick), sy(y))
          ctx.stroke()
          if (major) {
            ctx.strokeStyle = 'rgba(117, 73, 44, 0.1)'
            ctx.beginPath()
            ctx.moveTo(sx(-r), sy(y))
            ctx.lineTo(sx(r), sy(y))
            ctx.stroke()
          }
          count += 1
        }
      }
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
        let repQty = -1
        let repCents = list[i].priceCents
        while (j < list.length && (j === i || list[j].priceCents / 100 - list[j - 1].priceCents / 100 < gap)) {
          const l = list[j]
          const q = qtyOf(l)
          qty += q
          wy += (l.priceCents / 100) * q
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

    const drawSide = (bins: BranchBin[], side: 1 | -1, y0: number, y1: number) => {
      const kzLen = view.span / 8
      const kzThick = Math.pow(kzLen, 0.75)
      for (const bin of bins) {
        if (bin.hi < y0 - 2 || bin.lo > y1 + 2) continue // 视口外不画
        const isSold = bin.kind === 'sold'
        // 每枝固定随机（锚在 bin.lo），重绘/沸腾都不会跳
        let seed = Math.round(bin.lo * 7919) + (side > 0 ? 31 : 57)
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        const y = bin.y
        const r = outlineRadiusAt(y)
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

        // 从粗到细收尖：分段变宽描线，圆头衔接
        const M = 12
        const w0 = Math.max(1.4, 0.1 * thick * k)
        const w1 = Math.max(0.6, w0 * 0.28)
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

        // 聚合档 ≥2 才画叶：绿叶数 = 聚合档数，表示这片有很多笔待成交
        if (!isSold && bin.count > 1) {
          const ls = Math.max(0.55, 1.15 - bin.count * 0.045) * kzThick
          const long = Math.max(3.5, 0.16 * ls * k)
          const short = long * 0.38
          const baseAng = Math.atan2(S2y - S0y, S2x - S0x)
          ctx.fillStyle = INK.leaf
          ctx.strokeStyle = 'rgba(47, 82, 37, 0.55)'
          ctx.lineWidth = 0.8
          for (let m = 0; m < bin.count; m += 1) {
            const t = (m + 0.5) / bin.count
            const lx = bez(S0x, S1x, S2x, t * 0.94 + 0.03)
            const ly = bez(S0y, S1y, S2y, t * 0.94 + 0.03)
            const ang = baseAng + (m % 2 === 0 ? -0.9 : 0.9)
            ctx.beginPath()
            ctx.ellipse(lx + Math.cos(ang) * long * 0.4, ly + Math.sin(ang) * long * 0.4, long, short, ang, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
          }
        }

        // 拾取圆：贴枝中段，杆细也能点中；点击/投影共用同一圆心
        bin.pick = {
          cx: bez(S0x, S1x, S2x, 0.5),
          cy: bez(S0y, S1y, S2y, 0.5),
          r: Math.max(14, Math.min(0.46, 0.3 + 0.02 * bin.count) * kzThick * k),
        }
      }
    }

    // ---------- 价签：钉在树干正中的手绘纸牌（1-2-5 档步长） ----------
    const labelStep = (span: number, heightPx: number) => {
      const raw = (LABEL_MIN_GAP * span) / Math.max(1, heightPx)
      return LABEL_LADDER.find((s) => s >= raw) ?? LABEL_LADDER[LABEL_LADDER.length - 1]
    }

    const drawLabels = (y0: number, y1: number) => {
      const step = labelStep(view.span, H)
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

    // ---------- 渲染：按需重绘，只有交互 / 改尺寸 / 回前台才画 ----------
    const renderFrame = () => {
      k = H / view.span
      const half = view.span / 2
      const y0 = Math.max(TRUNK_MIN, view.camY - half) - 1
      const y1 = Math.min(TRUNK_MAX, view.camY + half) + 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = INK.paper
      ctx.fillRect(0, 0, W, H)

      const gapRaw = view.span / ROWS_PER_SCREEN
      const gap = Math.max(0.5, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-4, gapRaw)) * 2) / 2))
      work.bins.sold = groupLevels(soldList, (l) => l.soldQty, gap, 'sold')
      work.bins.sell = groupLevels(sellList, (l) => l.sellQty, gap, 'sell')
      work.bins.buy = groupLevels(buyList, (l) => l.buyQty, gap, 'buy')

      drawClouds(y0, y1)
      drawSide(work.bins.sold, 1, y0, y1) // 枯枝垫底（树干后面）
      drawTrunk(y0, y1)
      drawSide(work.bins.sell, 1, y0, y1)
      drawSide(work.bins.buy, -1, y0, y1)
      drawLabels(y0, y1)
    }

    // ---------- 交互：滚轮 / 捏合缩放，拖动攀爬 + 左右平移，点枝跳明细 ----------
    const pointers = new Map<number, { x: number; y: number }>()
    let pinchDist0 = 1
    let spanAtPinch = 0
    let pinchMidY = 0
    let dragMoved = 0
    let dirty = true
    /** 手绘沸腾窗口：交互后的这段时间里持续重画并推进种子，笔触肉眼可见地重排 */
    let boilUntil = 0
    let boilFrame = 0
    const markDirty = () => {
      dirty = true
    }
    const boil = () => {
      boilUntil = performance.now() + 140
      markDirty()
    }

    // 手指往下拖 → 树往下走 → 看更高价（和地图 / 列表同向）；左右拖 → 整棵树跟手平移
    const panBy = (dyPx: number) => {
      view.camY += dyPx * (view.span / (H || 1))
      clampView()
      boil()
    }
    const panXBy = (dxPx: number) => {
      view.panX += dxPx
      clampView()
      boil()
    }
    const zoomBy = (factor: number) => {
      view.span /= factor
      clampView()
      boil()
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
      levels: () => levels.map((l) => ({ cents: l.priceCents, buy: l.buyQty, sell: l.sellQty, sold: l.soldQty })),
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
        // 投影到该档所在合并枝的拾取圆心——e2e 用它定位点击点（0 = 已成交枯枝）
        const y = cents / 100
        const bins = side > 0 ? work.bins.sell : side < 0 ? work.bins.buy : work.bins.sold
        const bin = bins.find((b) => y >= b.lo - 1e-6 && y <= b.hi + 1e-6)
        const px = bin?.pick ? bin.pick.cx : sx((side || 1) * (outlineRadiusAt(y) + 0.9))
        const py = bin?.pick ? bin.pick.cy : sy(y)
        const rect = canvas.getBoundingClientRect()
        return { x: Math.round(rect.left + px), y: Math.round(rect.top + py) }
      },
    }

    // 按需渲染：交互后的沸腾窗口里继续逐帧重画并推进共享种子（每 2 帧进 1
    // ≈ 30fps），笔触肉眼可见地重排，停手即静
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || !dirty) return
      if (performance.now() < boilUntil) {
        boilFrame += 1
        if (boilFrame % 2 === 0) boilSeed = (boilSeed + 1) % 1024
        dirty = true
      }
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
        <span className="dot leaf">绿叶 · 聚合档数</span>
        <span className="dot fallen">枯枝 · 已成交（更长）</span>
        <span className="hint">滚轮缩放 · 拖动攀爬 / 平移 · 点枝看明细</span>
      </div>
    </div>
  )
}

/**
 * 2D 价格树 · 逻辑层：数据聚合 / 分档合并 / 视野与交互 / 命中 / e2e 桥 / 风格注册。
 *
 * V9.26.2（用户拍板）：移除 hover 明细预览（浮层/高亮全套），只保留点击跳转；
 * 聚合档数的展示从「·N档」文字改为枝上垂直刻线（一道 = 一档，样式层画）。
 *
 * V9.25：数轴风默认；点击传**价格区间**（合并组 lo~hi，分）——单档走 price= 精确
 * 跳转、聚合组走 priceLo/priceHi 区间筛选；缩放锚定指针（V9.23）。
 * 风格注册：数轴（treeStyleAxis，默认）↔ 图鉴素雅（treeStyleAtlas）↔ 手绘抖动
 * （treeStyleSketch，V9.18~V9.21 存档），图例按钮循环切换，偏好存 localStorage。
 *
 * 逻辑层与样式层的分工（全方位改样式请去样式模块，别改这里）：
 *   - 本文件：aggregate（档位聚合）→ groupLevels（按当前风格的数据牌行高分档合并，
 *     放大时聚合枝自动分散回原档位数）、视野钳位、滚轮/拖动/捏合、hitTest、__tree 桥；
 *   - treeStyle*.ts：一帧怎么画（干/枝/注记/价签/刻线），并负责给每个 bin 设拾取圆。
 *
 * 交互：滚轮 / 双指捏合缩放（锚定指针），拖动攀爬，左右拖动平移，
 *   点枝跳明细（命中面 = 拾取圆 + 枝梢注记文字热区；已成交枝自动放开「隐藏已完成」）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Select } from '../ui/Select'
import { useApp } from '../store/useApp'
import type { Ledger, SellTarget } from '../domain/types'
import { price } from '../ui/format'
import { atlasStyle } from './treeStyleAtlas'
import { sketchStyle } from './treeStyleSketch'
import { axisStyle } from './treeStyleAxis'
import { TRUNK_MAX, TRUNK_MIN, type BranchBin, type TreeLevel, type TreeStyle, type WorkBins } from './treeStyle'

export type { TreeLevel } from './treeStyle'

/** 点击枝条（合并组）时的跳转载荷：区间 [loCents, hiCents]（分，含两端） */
export interface TreePick {
  loCents: number
  hiCents: number
  /** 已成交组：跳明细要放开「隐藏已完成」 */
  done?: boolean
}

const CAM_MAX = 288
const SPAN_MIN = 0.5
const SPAN_MAX = 150
/** 树干最多拖离画面中心 ±45% 画布宽：能看两侧的枝，又不至于整棵拖没 */
const PAN_X_MAX = 0.45

type TreeStyleId = TreeStyle['id']
const STYLES: Record<TreeStyleId, TreeStyle> = { atlas: atlasStyle, sketch: sketchStyle, axis: axisStyle }
/** 切换顺序：图鉴素雅 → 手绘插画 → 数轴 → 循环 */
const STYLE_ORDER: TreeStyleId[] = ['atlas', 'sketch', 'axis']
const STYLE_KEY = 'ezgrid.treeStyle'
const STYLE_NAME: Record<TreeStyleId, string> = { atlas: '图鉴素雅', sketch: '手绘插画', axis: '数轴' }

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

export function TreeTrunk({
  stockName,
  onPick,
  closeCents = null,
  idealPriceCents = null,
  ledger: ledgerOverride,
}: {
  stockName: string
  /** 点击枝条（合并组）：区间 + 是否已成交组 */
  onPick: (pick: TreePick) => void
  /** 已确认昨收价（分，挂单页来的）：数轴风画异色虚线标记（V9.28） */
  closeCents?: number | null
  /** 理想可卖到的股价（分 = 最高待卖目标价）：数轴风画水平参考线 + 标签（V9.29，
   *  取代 V9.28 的「理想可卖金额」左上角数据牌——金额没有价格位置） */
  idealPriceCents?: number | null
  /** 沙盒预览：用真实 + 模拟的账本画树（V9.39）；不传就读全局真实账本 */
  ledger?: Ledger
}) {
  const { ledger: appLedger } = useApp()
  const ledger = ledgerOverride ?? appLedger
  // V9.31 年份筛选：只筛「已成交」（按卖出日期年份）——待买/待卖是当前挂单，不随年份消失。
  // 数据里出现过哪些年份就列哪些，将来多年度数据直接可切。
  const years = useMemo(() => {
    const set = new Set<string>()
    for (const s of ledger.sells) if (s.soldAt) set.add(s.soldAt.slice(0, 4))
    return [...set].sort()
  }, [ledger.sells])
  const [year, setYear] = useState('all')
  const effYear = year !== 'all' && years.includes(year) ? year : 'all'
  const scopedSells = useMemo(
    () => (effYear === 'all' ? ledger.sells : ledger.sells.filter((s) => (s.soldAt ?? '').startsWith(effYear))),
    [ledger.sells, effYear],
  )
  const levels = useMemo(
    () => aggregate(stockName, scopedSells, ledger.targets, ledger.orders),
    [stockName, scopedSells, ledger.targets, ledger.orders],
  )
  const [styleId, setStyleId] = useState<TreeStyleId>(() => {
    try {
      // V9.25 起默认数轴风；localStorage 记住的偏好（旧值也算）优先
      const v = localStorage.getItem(STYLE_KEY)
      return v === 'atlas' || v === 'sketch' ? v : 'axis'
    } catch {
      return 'axis'
    }
  })
  const switchStyle = () => {
    setStyleId((s) => {
      const next = STYLE_ORDER[(STYLE_ORDER.indexOf(s) + 1) % STYLE_ORDER.length]
      try {
        localStorage.setItem(STYLE_KEY, next)
      } catch {
        /* 隐私模式等存不了就只切会话内 */
      }
      return next
    })
  }
  const style = STYLES[styleId]
  const hostRef = useRef<HTMLDivElement | null>(null)
  // onPick 是父组件的内联箭头，引用每次渲染都变——走 ref，避免整棵树反复重建
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  // 昨收价 / 理想可卖到价走 ref + 手动标脏：值变了只重画一帧，不重挂画布（视角不丢）
  const closeRef = useRef(closeCents)
  closeRef.current = closeCents
  const idealRef = useRef(idealPriceCents)
  idealRef.current = idealPriceCents
  const bumpCanvas = useRef<() => void>(() => {})
  useEffect(() => {
    bumpCanvas.current()
  }, [closeCents, idealPriceCents])

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

    // 手绘沸腾种子（仅 boils 风格推进；图鉴风忽略）
    let boilSeed = 0
    let boilUntil = 0
    let boilFrame = 0

    // ---------- 数据分档（逻辑层核心）：合并粒度按风格的数据牌行高随缩放推算 ----------
    const buyList = levels.filter((l) => l.buyQty > 0)
    const sellList = levels.filter((l) => l.sellQty > 0)
    const soldList = levels.filter((l) => l.soldCount > 0)
    const work: WorkBins = { buy: [], sell: [], sold: [] }

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
        let times = 0
        let repQty = -1
        let repCents = list[i].priceCents
        while (j < list.length && (j === i || list[j].priceCents / 100 - list[j - 1].priceCents / 100 < gap)) {
          const l = list[j]
          const q = qtyOf(l)
          qty += q
          wy += (l.priceCents / 100) * q
          profit += l.soldProfitCents
          times += l.soldCount
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
          times,
          profitCents: profit,
        })
        i = j
      }
      return bins
    }

    // ---------- 渲染：按需重绘，绘制细节全部委托给当前风格 ----------
    const renderFrame = () => {
      k = H / view.span
      const half = view.span / 2
      const y0 = Math.max(TRUNK_MIN, view.camY - half) - 1
      const y1 = Math.min(TRUNK_MAX, view.camY + half) + 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // 合并间距按「数据牌行高」推算：放大时间距变大，聚合枝自动分散回原始档位数
      // （下限 0.01 元 = A 股最小报价单位），每个不重叠
      const gapRaw = (style.cardRowPx * view.span) / Math.max(1, H)
      const gap = Math.max(0.01, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-4, gapRaw)) * 2) / 2))
      work.sold = groupLevels(soldList, (l) => l.soldQty, gap, 'sold')
      work.sell = groupLevels(sellList, (l) => l.sellQty, gap, 'sell')
      work.buy = groupLevels(buyList, (l) => l.buyQty, gap, 'buy')
      style.drawFrame(
        {
          ctx, W, H, k, span: view.span, camY: view.camY, panX: view.panX, sx, sy, y0, y1, boilSeed,
          closeCents: closeRef.current,
          idealCents: idealRef.current,
        },
        work,
      )
    }

    // ---------- 交互：滚轮 / 捏合缩放（锚定指针），拖动攀爬 + 左右平移，点枝跳明细 ----------
    const pointers = new Map<number, { x: number; y: number }>()
    let pinchDist0 = 1
    let spanAtPinch = 0
    let dragMoved = 0
    let dirty = true
    const markDirty = () => {
      dirty = true
    }
    bumpCanvas.current = markDirty
    /** 交互后的重画请求：手绘风顺带开 ~140ms 沸腾窗口，笔触肉眼可见地重排 */
    const bump = () => {
      if (style.boils) boilUntil = performance.now() + 140
      markDirty()
    }

    // 手指往下拖 → 树往下走 → 看更高价（和地图 / 列表同向）；左右拖 → 整棵树跟手平移
    const panBy = (dyPx: number) => {
      view.camY += dyPx * (view.span / (H || 1))
      clampView()
      bump()
    }
    const panXBy = (dxPx: number) => {
      view.panX += dxPx
      clampView()
      bump()
    }

    /** 锚定缩放：缩放后 (px,py)（画布内坐标）下的世界点保持在原屏位（V9.23） */
    const zoomToSpan = (targetSpan: number, px: number, py: number) => {
      const span0 = view.span
      const k0 = H / span0
      const wy = view.camY + (H / 2 - py) / k0
      const wx = (px - W / 2 - view.panX) / k0
      view.span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, targetSpan))
      const k1 = H / view.span
      view.camY = wy + (view.camY - wy) * (k0 / k1)
      view.panX += wx * (k0 - k1)
      clampView()
      bump()
    }
    /** e2e 桥用：保持「正中缩放」旧语义（只动 span），测试断言依赖 */
    const zoomBy = (factor: number) => {
      view.span /= factor
      clampView()
      bump()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomToSpan(view.span * Math.pow(1.0014, e.deltaY), e.clientX - rect.left, e.clientY - rect.top)
    }
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      dragMoved = 0
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinchDist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1
        spanAtPinch = view.span
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
        // 捏合：以双指中点为锚——缩放与跟手平移一步到位
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const rect = canvas.getBoundingClientRect()
        zoomToSpan(spanAtPinch * (pinchDist0 / d), (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top)
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
          // 聚合组传整段区间（跳到这组全部记录）；已成交组带 done 放开「隐藏已完成」
          pickRef.current({
            loCents: Math.round(bin.lo * 100),
            hiCents: Math.round(bin.hi * 100),
            done: bin.kind === 'sold' ? true : undefined,
          })
        }
      }
    }

    /** 命中检测：拾取圆按圆心距离最近者胜（等距再按 待卖→待买→已成交）；
     *  枝梢注记文字热区（bin.note，数轴风）也算命中——点击的扩靶 */
    const hitTest = (x: number, y: number): BranchBin | null => {
      const rank: Record<'buy' | 'sell' | 'sold', number> = { sell: 0, buy: 1, sold: 2 }
      let best: BranchBin | null = null
      let bestD = Infinity
      let bestRank = Infinity
      const offer = (bin: BranchBin, kind: 'buy' | 'sell' | 'sold', d: number) => {
        if (d < bestD - 1e-6 || (d <= bestD + 1e-6 && rank[kind] < bestRank)) {
          best = bin
          bestD = Math.min(d, bestD)
          bestRank = rank[kind]
        }
      }
      for (const kind of ['sell', 'buy', 'sold'] as const) {
        for (const bin of work[kind]) {
          const p = bin.pick
          if (p) {
            const d = Math.hypot(x - p.cx, y - p.cy)
            if (d <= p.r) offer(bin, kind, d)
          }
          const n = bin.note
          if (n && x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) offer(bin, kind, 0)
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
      /** 当前绘制风格 id（'atlas' | 'sketch'），e2e 切换断言用 */
      style: () => style.id,
      /** 当前已成交年份筛选（'all' 或 'YYYY'），e2e 断言用（V9.31） */
      year: () => effYear,
      /** 当前分档结果（V9.31 数轴格子）：count = 档数、over = 塞不下画成「+N」的档数、times = 卖出笔数 */
      bins: () => ({
        sell: work.sell.map((b) => ({ count: b.count, over: b.over ?? 0, times: b.times, cents: b.repCents })),
        buy: work.buy.map((b) => ({ count: b.count, over: b.over ?? 0, times: b.times, cents: b.repCents })),
        sold: work.sold.map((b) => ({ count: b.count, over: b.over ?? 0, times: b.times, cents: b.repCents })),
      }),
      /** 理想可卖到的股价（分，null = 无待卖）：e2e 断言轴上的参考线有值 */
      ideal: () => idealRef.current,
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
        const bins = side > 0 ? work.sell : side < 0 ? work.buy : work.sold
        const bin = bins.find((b) => y >= b.lo - 1e-6 && y <= b.hi + 1e-6)
        const px = bin?.pick ? bin.pick.cx : sx((side || 1) * (style.outlineRadiusAt(y) + 0.9))
        const py = bin?.pick ? bin.pick.cy : sy(y)
        const rect = canvas.getBoundingClientRect()
        return { x: Math.round(rect.left + px), y: Math.round(rect.top + py), repCents: bin?.repCents ?? null }
      },
    }

    // 按需渲染：手绘风的沸腾窗口里继续逐帧重画并推进共享种子（每 2 帧进 1
    // ≈ 30fps），停手即静；图鉴风只有交互 / 改尺寸 / 回前台才重画
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || !dirty) return
      if (performance.now() < boilUntil && style.boils) {
        boilFrame += 1
        if (boilFrame % 2 === 0) {
          boilSeed = (boilSeed + 1) % 1024
          dirty = true
        }
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
  }, [levels, stockName, style, effYear])

  return (
    <div className="tree-wrap" data-style={styleId}>
      <div ref={hostRef} className="tree-host">
        {/* V9.29：数轴风把「理想可卖到」画成轴上的水平参考线；图鉴/手绘风没有价格刻度，
            退回左上角只读角标（同一个股价口径） */}
        {idealPriceCents != null && styleId !== 'axis' && (
          <div className="tree-stat ideal">理想可卖到 {price(idealPriceCents)}</div>
        )}
      </div>
      <div className="tree-legend">
        <span className="dot buy">待买 · 左</span>
        <span className="dot sell">待卖 · 右</span>
        <span className="dot fallen">{styleId === 'axis' ? '已成交 · 已盈利' : '枯枝 · 已盈利'}</span>
        {styleId === 'atlas' && <span className="dot agg">枝上点 · 聚合档数</span>}
        {styleId === 'sketch' && <span className="dot leaf">叶 · 聚合档数</span>}
        {styleId === 'axis' && <span className="dot agg">格子 · 一格一档</span>}
        {/* V9.31 年份限制：只筛已成交（按卖出日期），待买/待卖是当前挂单不受影响 */}
        {years.length > 0 && (
          <span className="tree-year" title="只筛已成交：按卖出日期年份；待买/待卖是当前挂单，不随年份变">
            <span>已成交年份</span>
            <Select
              options={[{ key: 'all', label: '全部' }, ...years.map((y) => ({ key: y, label: y }))]}
              value={effYear}
              onChange={setYear}
              mini
              aria-label="已成交年份"
            />
          </span>
        )}
        <button
          type="button"
          className="style-toggle"
          data-testid="tree-style-toggle"
          onClick={switchStyle}
          title="切换绘制风格（偏好存在本机浏览器）"
        >
          风格 · {STYLE_NAME[styleId]}
        </button>
        <span className="hint">滚轮/捏合缩放对准指针 · 拖动平移 · 点击看明细</span>
      </div>
    </div>
  )
}

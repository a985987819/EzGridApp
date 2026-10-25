/**
 * 价格树共享层：类型 + 两种风格共用的几何/刻度工具。
 *
 * 分工（改样式别动 TreeTrunk，改口径别动风格模块）：
 *   - TreeTrunk.tsx = 逻辑层：数据聚合、分档合并、视野/交互/命中、e2e 桥、风格注册与切换；
 *   - treeStyleAtlas.ts = 图鉴素雅风（V9.22，默认）；
 *   - treeStyleSketch.ts = 手绘抖动风（V9.18~V9.21 存档，含云/装饰叶/树皮排线/沸腾）。
 */

export interface TreeLevel {
  priceCents: number
  buyQty: number
  sellQty: number
  soldQty: number
  soldCount: number
  /** 该价位已成交的已盈利合计（成本缺失的卖出不计入） */
  soldProfitCents: number
}

/** 合并组（一枝）：lo/hi 元区间、数量加权摆放高度、代表档、拾取圆 */
export interface BranchBin {
  lo: number // 区间下沿（元）
  hi: number
  y: number // 数量加权摆放高度
  repCents: number // 数量最大的档（点击/跳明细用它）
  qty: number
  count: number // 合并档数（图鉴风=枝上小点数；手绘风=叶数）
  kind: 'buy' | 'sell' | 'sold'
  /** 已成交组的已盈利合计（元 → 分，成本缺失的卖出不计） */
  profitCents: number
  pick?: { cx: number; cy: number; r: number } // 拾取圆（canvas 内 px），点击/投影共用
  /** 注记文字热区（canvas 内 px）：hover/点击的扩靶——枝梢注记也能命中（数轴风 V9.25.1） */
  note?: { x: number; y: number; w: number; h: number }
}

export interface WorkBins {
  buy: BranchBin[]
  sell: BranchBin[]
  sold: BranchBin[]
}

/** 一帧的绘制上下文：风格模块只读这些，不碰组件内部状态 */
export interface TreeFrame {
  ctx: CanvasRenderingContext2D
  W: number
  H: number
  k: number // px / 元
  span: number
  camY: number
  panX: number
  sx: (wx: number) => number
  sy: (wy: number) => number
  y0: number // 视口世界坐标范围（已含树干上下限钳位）
  y1: number
  /** 沸腾种子（手绘风交互窗口内逐帧推进；图鉴风忽略） */
  boilSeed: number
}

export interface TreeStyle {
  id: 'atlas' | 'sketch' | 'axis'
  /** 数据牌行高（px）：合并粒度按它随缩放推算 */
  cardRowPx: number
  /** 交互后是否短窗口逐帧重画（手绘沸腾） */
  boils: boolean
  /** 树干外表面半径（元）——枝的锚点，projectPrice 兜底也用 */
  outlineRadiusAt: (y: number) => number
  /** 画一帧：背景 → 枯枝 → 干 → 待卖/待买 → 注记 → 价签；负责给每个 bin 设 pick */
  drawFrame: (f: TreeFrame, bins: WorkBins) => void
}

export const TRUNK_MIN = -20
export const TRUNK_MAX = 300

/** 价签最小屏幕间距（px）：任何缩放下相邻两个数字至少隔这么远 */
export const LABEL_MIN_GAP = 80
/** 价签步长档位（1-2-5 序列；0.1 档对应 A 股最小报价单位） */
export const LABEL_LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]

/** 二次贝塞尔取点（t ∈ [0,1]） */
export const bez = (s0: number, s1: number, s2: number, t: number) => {
  const u = 1 - t
  return u * u * s0 + 2 * u * t * s1 + t * t * s2
}

/** 价签步长：按 span 与画布高从 1-2-5 档取最小够间距的步长 */
export const labelStep = (span: number, heightPx: number) => {
  const raw = (LABEL_MIN_GAP * span) / Math.max(1, heightPx)
  return LABEL_LADDER.find((s) => s >= raw) ?? LABEL_LADDER[LABEL_LADDER.length - 1]
}

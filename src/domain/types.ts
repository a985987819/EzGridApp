/** 领域类型：对齐规范 §7.1 的字段变更（D1–D7 + P1–P12）。 */

import type { PriceLimitType } from './limit'

export interface StockConfig {
  id: string
  /** 明细里出现的名字，例如「安道麦」 */
  name: string
  /** 代码可空（Excel 里没有） */
  code?: string
  /** 默认卖出间隔，整数分 */
  intervalCents: number
  /** 涨跌幅规则只在股票配置里维护，挂单页直接读它算区间 */
  priceLimitType: PriceLimitType
  customLimitPct?: number | null
  note?: string
  /** 排序序号，拖动调整；0 在最前 */
  order?: number
  /** 停用后只在管理页可见，其他列表/清单不显示（数据仍计入合计） */
  enabled?: boolean
}

/** 从 Excel 解析出来的原始行，尚未派生任何规则字段 */
export interface RawRecord {
  /** Excel 行号，可回溯；手动新增的行从 100000 起（origin='manual'） */
  sourceRow: number
  stockName: string
  buyDateSerial: number | null
  buyPriceCents: number | null
  /** D 列原值；为 null 且 qtyNeedsDerive 时按 FLOOR(6000/买入价,100) 派生 */
  buyQtyRaw: number | null
  qtyNeedsDerive: boolean
  targetPriceCents: number | null
  /** E 列公式无缓存值 → 按 买入价+间隔 重算（D1） */
  targetNeedsDerive: boolean
  soldQty: number | null
  sellDateSerial: number | null
  /** P 列「提前卖的买价」= 回补价（D5）；手动新增卖出时按 R3 四级优先级派生 */
  earlyBuyPriceCents: number | null
  /**
   * 回补价的来源留痕（R3）：
   * custom = 手填 / P 列；lot = 关联买入价；
   * sellMinusInterval = 卖出价 − 该股默认间隔；repaid = 勾了「已回补」
   */
  rebuyPriceSource?: RebuyPriceSource
  /** Excel 里的实现盈利（仅留痕，不参与计算） */
  rawProfitCents: number | null
  importKey: string
  /** 来源：解析导入 or 手动新增 */
  origin?: 'excel' | 'manual'
  /** 软删除时间；非空的行不参与任何计算 */
  deletedAt?: number | null
  /** 最近一次编辑时间 */
  editedAt?: number | null
  /**
   * 买入日期是 `=TODAY()` 公式且工作簿没存计算结果。
   * 这类格子 Excel 打开后会显示「当天」，并不等于真实成交日，所以按缺失处理。
   */
  buyDateNeedsToday?: boolean
  /** 同上，卖出日期列 */
  sellDateNeedsToday?: boolean
  /** 由哪一批导入写入，用于回滚（P9 之外补充） */
  batchId?: string | null
}

/** 编辑审计（P10）：实体 / 字段 / 旧值 / 新值 / 时间 / 来源 */
export interface AuditLog {
  id?: number
  entity: 'record' | 'stock' | 'order'
  entityId: string
  field: string
  oldValue: string
  newValue: string
  at: number
  source: string
}

/** 买入批次（派生对象，不落库） */
export interface Lot {
  id: string
  sourceRow: number
  stockId: string
  stockName: string
  buyDate: string | null
  buyPriceCents: number
  qty: number
  soldQty: number
  remainingQty: number
  targetPriceCents: number | null
  /** 无买入价/目标价 → 标 needsPrice，不出目标（R1 边界） */
  needsPrice: boolean
  importKey: string
}

export type RebuyStatus = 'pending' | 'repaid'
export type PriceSource = 'target' | 'earlyBuy' | 'missing'
/** R3 的回补价来源 */
export type RebuyPriceSource = 'custom' | 'lot' | 'p' | 'sellMinusInterval' | 'repaid'

/** 卖出成交（派生对象） */
export interface SellExecution {
  id: string
  sourceRow: number
  stockId: string
  stockName: string
  qty: number
  /** 成交价 = E 列（D1） */
  priceCents: number | null
  /** 成本 = 买入价；无批次时取 P 列 */
  costCents: number | null
  profitCents: number | null
  soldAt: string | null
  dateMissing: boolean
  priceSource: PriceSource
  rebuyStatus: RebuyStatus
  /** 卖出日期早于买入日期（D4，合法） */
  sellBeforeBuy: boolean
  /** 成本价分组键 stockId|priceCents */
  groupKey: string | null
  costComplete: boolean
  /** 关联的买入批次（§7.1）；先卖后买行为 null */
  lotId: string | null
  /** 关联的自动卖出目标（§7.1），派生后回填 */
  targetId: string | null
  /**
   * 挂钩暂记卖出（V9.26）：这条卖不是真实成交，是裸卖挂钩在高位批次上的
   * 暂记（按 卖价−买价 记负盈利）；sourceRow 指向被挂的买入行。
   */
  hedgedFromSellRow?: number
  /**
   * 裸卖被挂钩（V9.26）：盈利暂缓（profitCents 置 null），买回后按回补价
   * 结算；一直不买回则挂钩暂记的负盈利就是真实亏损。
   */
  hedgedHold?: boolean
  /**
   * V9.36：这一截已经被回补永久了结——亏损是真亏（留在合计盈利里），批次不复活，
   * 由回本链继续用低位循环的价差去补。hedgedFromSellRow 同时置位（不算卖出量）。
   */
  hedgeClosed?: boolean
}

/** 计划价（P8）：只挂在页面上与导出里，不动真实成交与任何计算 */
export interface TradePlan {
  id: string
  kind: 'buy' | 'sell'
  /** 对应 RebuyOrder.id 或 SellTarget.id */
  refId: string
  priceCents: number
  qty: number
  at: number
}

/** 一个批次手动拆出来的卖出目标（V6 分批止盈） */
export interface ExtraTarget {
  id: string
  lotId: string
  priceCents: number
  qty: number
  at: number
}

/**
 * 先卖后买挂钩（V9.26）：裸卖在未回补期间人工指定挂到哪些未卖的高位批次上。
 * 纯派生输入——活跃条件由 buildLedger 判定（裸卖 + 无回补成交），回补一出现
 * 挂钩即失效（批次复原），撤销成交又自动恢复；这里只存分配，不存状态。
 */
export interface HedgeLink {
  /** hedge:<sellRow> */
  id: string
  sellRow: number
  /** 挂到哪些买入行、各挂多少股（合计应等于卖单股数） */
  items: { row: number; qty: number }[]
  at: number
}

/**
 * 回本链（V9.36）：先卖后买挂钩的高位批次一旦被「回补」了结，它按卖出价记下的亏损
 * （10 元成本按 7 元了结 = −1,500）不再随回补消失，而是变成一条待回本的账。
 * 低位每做一轮「卖高 → 回补低」，价差持续累加进来，够冲平就标「已回本」。
 * 纯派生：来源是 hedges + 回补成交，不落库。
 */
export interface RepairCycle {
  /** 这张裸卖（先卖后买）的行号 */
  sellRow: number
  sellPriceCents: number
  /** 回补价（多笔成交按股数加权） */
  rebuyPriceCents: number | null
  qty: number
  /** 本轮价差 =（卖价 − 回补价）× 股数，正数表示回血 */
  recoveredCents: number
  soldAt: string | null
  /** 卖出价低于当时的有效成本（低位出货：不回补就是纯亏） */
  belowEffectiveCost: boolean
  /** 那一轮的有效成本（分/股），给界面标注用 */
  effectiveCostAtCents: number
}

export interface RepairChain {
  /** chain:<锚行号> */
  id: string
  stockName: string
  /** 被挂掉的高位批次行号 */
  anchorRow: number
  /** 了结的股数 */
  anchorQty: number
  /** 高位批次原始成本（分/股） */
  anchorCostCents: number
  /** 了结时的卖出价（分/股，多笔按股数加权） */
  closedAtCents: number | null
  /** 了结记下的亏损（负数）= Σ(卖价 − 成本) × 股数 */
  lossCents: number
  /** 已回血（正数）：各轮价差累加 */
  recoveredCents: number
  /** 有效成本 =（原成本 × 股数 − 回血）/ 股数 */
  effectiveCostCents: number
  /** 还差多少回本（正数；冲平后为 0） */
  gapCents: number
  /** 回血 ≥ 亏损 → 这笔高位买入已彻底冲平 */
  done: boolean
  cycles: RepairCycle[]
}

export interface SellTarget {
  id: string
  lotId: string
  stockId: string
  stockName: string
  priceCents: number
  qty: number
  autoGenerated: boolean
  planPriceCents?: number | null
  planQty?: number | null
  /** 预期收益 (E − 成本) × 剩余量 */
  expectProfitCents: number
  amountCents: number
}

export type OrderStatus = 'open' | 'partial' | 'closed' | 'cancelled'

/** 回补成交：一笔待买被真实执行了多少股（平掉空头敞口，不新增可卖批次） */
export interface RebuyExecution {
  id: string
  orderId: string
  sellExecId: string
  stockId: string
  stockName: string
  qty: number
  priceCents: number
  /** 这次成交里含的奖励股数（来自该订单当时的 rewardQty） */
  rewardQty: number
  /** 成交时所在的价组，额度消耗永久留在旧组（P4） */
  groupKeyAtExecution: string
  at: number
  note?: string
}

export interface RebuyOrder {
  id: string
  sellExecId: string
  sourceRow: number
  stockId: string
  stockName: string
  rebuyPriceCents: number
  baseQty: number
  rewardQty: number
  /** 已回补股数（base + reward 合计口径） */
  execQty: number
  /** 已成交的奖励股数（不可撤） */
  doneRewardQty: number
  /** 还没回补的股数 */
  remainingQty: number
  status: OrderStatus
  /** 组池信息（R5） */
  groupKey: string
  grossProfitCents: number
  hands: number
  /**
   * 本次奖励手数的凑手来源（§7.1）：同组、按 FIFO 顺序截至本单的订单 id。
   * 已回补的历史卖出没有订单，所以不会出现在这个列表里。
   */
  rewardSourceOrderIds: string[]
  createdAt: number
  /** 无买入批次的卖出 → 真空头敞口；有批次只是回补再买入，不占敞口 */
  exposure: boolean
  /** planPrice/planQty 只在挂单页改，不动真实成交（P8） */
  planPriceCents?: number | null
  planQty?: number | null
}

export interface GroupPool {
  groupKey: string
  stockId: string
  rebuyPriceCents: number
  grossProfitCents: number
  usedProfitCents: number
  capacityHands: number
  grantedHands: number
  availableCents: number
  lotCostCents: number
}

export interface StockSummary {
  stockId: string
  stockName: string
  rows: number
  buyQty: number
  buyAmountCents: number
  sellCount: number
  sellQty: number
  sellAmountCents: number
  profitCents: number
  targetCount: number
  targetQty: number
  targetAmountCents: number
  /** 待卖里的最高目标价（分）：股价涨到这里待卖全部出清；无待卖时 null（V9.29） */
  targetMaxPriceCents: number | null
  expectProfitCents: number
  rebuyCount: number
  rebuyQty: number
  netQty: number
  exposureQty: number
}

export interface DayBucket {
  day: string
  sellCount: number
  sellQty: number
  profitCents: number
  dateMissing: boolean
}

export interface MonthlyBucket {
  month: string
  sellCount: number
  sellQty: number
  sellAmountCents: number
  profitCents: number
  dateMissing: boolean
}

export interface Anomaly {
  kind:
    | 'needsPrice'
    | 'needsCost'
    | 'dateMissing'
    | 'negativeProfit'
    | 'targetOverflow'
    | 'oversell'
    | 'hedgeInvalid'
    | 'hedgeOverflow'
    | 'hedgeMismatch'
  sourceRow: number
  stockName: string
  detail: string
}

export interface CheckResult {
  name: string
  ok: boolean
  actual: string
  expected: string
  detail?: string
}

export interface Ledger {
  lots: Lot[]
  sells: SellExecution[]
  targets: SellTarget[]
  orders: RebuyOrder[]
  groups: GroupPool[]
  byStock: StockSummary[]
  daily: DayBucket[]
  monthly: MonthlyBucket[]
  anomalies: Anomaly[]
  checks: CheckResult[]
  /** V9.36 回本链：高位批次被回补了结后的待回本账（没有就不返回） */
  repairChains: RepairChain[]
  totals: {
    rows: number
    buyQty: number
    buyAmountCents: number
    sellCount: number
    sellQty: number
    sellAmountCents: number
    profitCents: number
    targetCount: number
    targetQty: number
    targetAmountCents: number
    expectProfitCents: number
    rebuyCount: number
    rebuyBaseQty: number
    rebuyRewardQty: number
    rebuyQty: number
    /** 已回补股数（真实成交） */
    rebuyExecQty: number
    /** 空头挂单回补成交里的基础股部分（既抵敞口又以回补批次进待卖，守恒式扣回防双算） */
    exposureExecBaseQty: number
    /** 还没回补的股数 */
    rebuyRemainingQty: number
    rebuyAmountCents: number
    rewardQty: number
    netQty: number
    exposureQty: number
  }
}

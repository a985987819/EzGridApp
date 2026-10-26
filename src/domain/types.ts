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
  /** 原始 Excel 行号；内部 ID 永久不变。 */
  excelRow?: number
  /** 本次卖出消耗的既有批次，本行不重复创建买入。 */
  soldLotId?: string
  /** 本次买入消耗的下一轮建议来源。 */
  nextRoundOfRow?: number
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
  entity: 'record' | 'stock' | 'order' | 'merge' | 'chain'
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
  rebuyRemainingQty?: number
  rebuyPriceCents?: number | null
  rebuyStatus: RebuyStatus
  /**
   * V9.47.1：本行自己的买入批次盖住这次卖出的股数（先卖后买份额匹配即视为已回补）。
   * 待买单只挂 `qty − ownLotCoverQty` 那截真没买回来的量；省略 = 0。
   */
  ownLotCoverQty?: number
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
 * 卖单拆成多笔买入（V9.50）：先卖后买的单子按价位拆开挂买单。
 * 总量不得超过该卖单还没回补的欠量，超出截断并标异常；拆分后挂单页/概览只认拆分段。
 */
export interface ExtraBuyTarget {
  /** buytarget:<卖单行>:<ts> */
  id: string
  /** 被拆的那笔卖出（先卖后买）所在明细行号 */
  sellRow: number
  priceCents: number
  qty: number
  at: number
}

/**
 * 待买订单的展示档（V9.50）：没拆分就是整单一条，拆了就按 buyTargets 分档。
 * 只用于挂单页/概览展示与「记成交」取价、取量——账务仍走 RebuyOrder。
 */
export interface BuySplit {
  /** 整单 = rb:sell:C；拆分段 = rb:sell:C#<序号> */
  key: string
  orderId: string
  sellExecId: string
  sourceRow: number
  stockName: string
  priceCents: number
  /** 这一档还没买回来的量 */
  qty: number
  /** 这一档拆分时的原始量 */
  plannedQty: number
  /** 已经在这档成交的量（按档位顺序冲抵） */
  executedQty: number
  split: boolean
  /** 手动拆分段对应的 buyTargets id（可删）；整单为 null */
  targetId: string | null
  /** V9.54：这一档来自「先卖后买」的卖单（卖出日 ≤ 买入日 / 裸卖），挂单页排最前 */
  sellFirst?: boolean
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
 * 回本链的后续分支（V9.46）：一笔归属进链的买入批次。
 *   - record = 真实明细行（买回后再卖出，盈亏进链）；
 *   - rebuy  = 「记成交」产生的回补批次（虚拟，未卖前只有持仓与「回补节省」）。
 *   - sell   = **V9.49 价位槽**：一个回补价位（先卖后买订单的 P 列）为一支，
 *              根是那笔「同价再卖」的裸卖，之后所有同股、同价的买入都自动归进来。
 * 原始亏损按买入份额分摊到各分支：分摊额 = 原始亏损 × 本支买入股数 / 锚点股数。
 */
export interface RepairBranch {
  /** 真实行号；回补批次用 exec:<成交 id>；价位槽用 branch:<锚点>:<价位分> */
  key: string
  /** 真实行号；回补批次为 null */
  row: number | null
  kind: 'record' | 'rebuy' | 'sell'
  buyDate: string | null
  buyPriceCents: number
  qty: number
  remainingQty: number
  sellPriceCents: number | null
  sellQty: number
  soldAt: string | null
  /** 本支后续已实现净盈利（未卖 = 0） */
  profitCents: number
  /** 分摊到的原始亏损（≤0） */
  allocatedLossCents: number
  /** 分支累计 = 分摊亏损 + 已实现盈利 */
  netCents: number
  /** 回补批次：相对锚点卖出价省下的资金（只展示，不计入回本进度） */
  savingCents: number
  /**
   * V9.49 价位槽分支：根「先卖后买」订单的行号（普通归属批次为 null）。
   * 明细里靠它在裸卖行上标「本笔是回本链的回补价位」。
   */
  rootSellRow: number | null
  /** V9.49：这一支已完成的卖出次数（根卖出 + 支内批次卖出），界面显示「卖了 x 次」 */
  cycles: number
  /**
   * V9.49：这一支牵连的明细行（价位槽 = 根卖单 + 槽内每一笔真实买入）。
   * 明细里靠它把整支的行都标上回本链、能在抽屉里看到整条链的账。
   */
  memberRows: number[]
}

/**
 * 回本链（V9.46 新口径）：一条链 = 一次「亏着清仓」的原始亏损 + 后续归属交易的已实现净盈利。
 *
 * 主进度只认**已完成的买卖净盈利**；买回后没卖只有持仓和浮盈亏，不算回本。
 * 回补价差（卖价 − 买回价）单独作为「回补节省」展示，绝不重复计入进度。
 * 链在首次亏损清仓时就成立——一直不买回，原始亏损也留在账上。
 */
export interface RepairChain {
  id: string
  stockName: string
  /** 锚点行：这次亏损清仓对应的买入批次 */
  anchorRow: number
  anchorQty: number
  anchorCostCents: number
  closedAtCents: number | null
  /** 原始已实现亏损（≤0） */
  lossCents: number
  /** 后续归属交易的已实现净盈利（可负） */
  profitCents: number
  /** 链累计盈亏 = 原始亏损 + 后续净盈利 */
  netCents: number
  /** 距离回本（正数；已回本为 0） */
  gapCents: number
  done: boolean
  /** 已覆盖比例 0..1 */
  covered: number
  /** 回补价差合计（只展示，不计进度） */
  savingCents: number
  /** 链条当前实际持仓（归属批次还没卖的股数，含回补批次） */
  holdingQty: number
  /** 计划还要买回的股数 = 锚点股数 − 已归属买入股数 */
  plannedQty: number
  /** 还没买回那部分对应的原始亏损（≤0，未分摊） */
  unallocatedLossCents: number
  /** 人为结束这条链的时间（null = 还开着） */
  closedByUserAt: number | null
  /** 触发这次了结的裸卖行（先卖后买挂在锚点批次上的那笔；用于在裸卖行上也展示链） */
  relatedSellRows: number[]
  branches: RepairBranch[]
}

/** 回本链归属（V9.46）：锚点 + 后续归属的真实买出行 */
export interface RepairChainLink {
  /** chainlink:<锚点行号>（派生链的 id 才是 chain:<行号>） */
  id: string
  anchorRow: number
  stockName: string
  /** 归属到本链的后续买入行（真实 records） */
  memberRows: number[]
  /** 人为结束的时间 */
  closedAt: number | null
  at: number
}

/**
 * 合并同价买单（V9.45）：几笔同股票、同买入价、还没卖完的批次人工绑成一组。
 * 只影响挂单页「待卖」提醒的合并显示——数量相加、日期取最早的那笔；
 * records 本身一分不改（各自的数量 / 买入日期都还在），解除即恢复。
 */
export interface LotMergeLink {
  /** merge:<锚行号>（锚 = 买入日期最早的那笔，同日期取行号小） */
  id: string
  stockName: string
  /** 买入价（分），组内必须一致 */
  priceCents: number
  /** 成员行号（真实记录行，按行号升序） */
  rows: number[]
  at: number
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
  /**
   * V9.54：这笔待买属于「先卖后买」——卖出日在买入日之前（同日按 T+1 也只能是先卖后买），
   * 或者这行根本没有买入批次（裸卖）。挂单页把它排在最前并标出来（欠的股是真欠）。
   */
  sellFirst?: boolean
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
    | 'buyTargetOverflow'
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
  /** V9.50：待买的展示档（没拆分 = 整单一条，拆了按 buyTargets 分段） */
  buySplits: BuySplit[]
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

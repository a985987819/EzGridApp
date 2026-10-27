/**
 * 回补覆盖模型（V9.57）——所有「这笔卖还欠多少股」只在这里算一次。
 *
 * 背景：V9.49 的价位槽把「同股、同价的真实买入」自动当成回补，V9.20 的回补成交
 * 又会生成虚拟批次；同一笔裸卖因此有三套减法（order.baseQty / exposure / chain.planned），
 * 各减各的，才出现「守恒式红灯」「敞口少算」「链计划量少算」这一批问题。
 *
 * 统一口径（全部整数股，不碰浮点）：
 *
 *   owed            = 卖出量 − 本行买入批次盖住的量（V9.47.1 先卖后买份额匹配）
 *   baseQty         = owed − 同价真实买入覆盖（价位槽，V9.49）        ← 待买单的计划基数（奖励前）
 *   openBaseQty     = max(0, baseQty − 回补成交基础股)                 ← 真正还欠的股数
 *   openExposureQty = max(0, owed − 真实覆盖 − 成交基础股 − 挂钩股)     ← 真空头敞口（挂住的股已由高位批次交割）
 *   deductQty       = min(本行买回 + 真实覆盖 + 成交基础股, 卖出量 − 全部高位交割股)     ← 守恒式扣减（既抵了敞口、又进了待卖的股）
 *
 * 两条关键规则：
 * 1. **真实覆盖要扣**：同价真实买入既平掉裸卖，又以自己的批次进了待卖，不在守恒式里扣回就是双算。
 * 2. **回补成交不进 cover**：它已经由 `成交基础股` 扣一次（虚拟批次本身进待卖）；
 *    如果把虚拟批次也算成 cover，baseQty 会被减两遍，敞口和链计划量就少算了。
 *
 * 本模块纯函数、无 IO；`ledger.ts` 只负责提供六个输入数字。
 */

export interface SellCoverInput {
  /** 这笔卖出成交的股数（SellExecution.qty） */
  sellQty: number
  /** 本行自己的买入批次盖住的股数（V9.47.1；非先卖后买为 0） */
  ownLotCoverQty: number
  /** 这张单已成交的基础股（不含奖励股） */
  execBaseQty: number
  /** 回本链价位槽里「同价真实买入」覆盖的股数（不含回补成交虚拟批次） */
  realCoverQty: number
  /** 被裸卖挂钩占住、已由高位批次交割的股数（含暂记 hold 与已了结 closed） */
  hedgeAppliedQty: number
  /** 其中「已经买回、永久了结」的股数（保留调用接口；高位交割统一按 hedgeAppliedQty 扣减） */
  hedgeClosedQty: number
  /**
   * 这笔卖是否先卖后买。其买回批次完整留在持仓，因此本行覆盖也参与守恒扣减。
   * 只有这类卖出才产生敞口与守恒扣减；记卖出的子卖出（soldLotId）不算空头。
   */
  exposureEligible: boolean
  /** 回补价；没有价就不挂待买（repaid），但敞口仍然照算 */
  rebuyPriceCents: number | null
}

export interface SellCover {
  /** 扣掉本行买入覆盖后的欠量（先卖后买份额匹配之后） */
  owed: number
  /** 待买单计划基数 = owed − 同价真实买入覆盖 */
  baseQty: number
  /** 已成交基础股（不含奖励） */
  execBaseQty: number
  /** 还欠的基础股 = baseQty − execBaseQty（不含奖励） */
  openBaseQty: number
  /** 真空头敞口（挂住的股已经交割，不再算敞口） */
  openExposureQty: number
  /** 守恒式里的「空头回补基础股」扣减项 */
  deductQty: number
  /** 是否还需要挂一张待买单 */
  pending: boolean
}

/** 非负整数股；非法输入按 0（数据错误由 ledger 的异常清单负责） */
function qtyOf(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function coverOfSell(input: SellCoverInput): SellCover {
  const sellQty = qtyOf(input.sellQty)
  const own = Math.min(qtyOf(input.ownLotCoverQty), sellQty)
  const exec = qtyOf(input.execBaseQty)
  const real = Math.min(qtyOf(input.realCoverQty), Math.max(0, sellQty - own))
  const hedge = qtyOf(input.hedgeAppliedQty)

  const owed = Math.max(0, sellQty - own)
  const baseQty = Math.max(0, owed - real)
  const openBaseQty = Math.max(0, baseQty - exec)
  const openExposureQty = input.exposureEligible
    ? Math.max(0, owed - real - exec - hedge)
    : 0
  // 已买回的持仓中，只有尚未由高位原持仓交割的那部分需要在守恒式扣回。
  const deductQty = input.exposureEligible
    ? Math.min(own + real + exec, Math.max(0, sellQty - hedge))
    : 0

  return {
    owed,
    baseQty,
    execBaseQty: exec,
    openBaseQty,
    openExposureQty,
    deductQty,
    pending: openBaseQty > 0 && input.rebuyPriceCents !== null,
  }
}

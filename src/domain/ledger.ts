/**
 * 关联引擎：把原始行推导成 批次 / 成交 / 待卖目标 / 待买订单 / 组池奖励。
 * 对应规范 §8.1 §8.2 §8.3，D1–D5 全部落在这里。
 */

import { mulCents } from './money'
import { deriveBuyQty } from './qty'
import { serialToIso, stockIdOf } from './defaults'
import { accountIdOf } from './accounts'
import { DEFAULT_ACCOUNT_ID, type Anomaly, type ExtraTarget, type RebuyExecution, type TradePlan, type CheckResult, type GroupPool, type Ledger, type Lot, type DayBucket, type MonthlyBucket, type RawRecord, type RebuyOrder, type SellExecution, type SellTarget, type StockConfig, type StockSummary } from './types'

export interface BuildOptions {
  /** 基准金额，默认 6000 元 */
  baseAmountYuan?: number
  /**
   * 已成交行（G 列有卖出）的 E 列只有公式、没有缓存值时，是否按「买入价+间隔」推定成交价。
   * 默认 false，与文档 §03 口径一致：R44 不推定成交价 → 全表盈利 ¥9,831。
   * 若置为 true，R44 会按 18.81+1.07=19.88 计入，全表盈利变 ¥10,152。
   */
  deriveSellPrice?: boolean
  /** 回补成交记录（有它才算「待补已回补多少」） */
  executions?: RebuyExecution[]
  /** 计划价：只影响展示与导出，不参与任何计算（P8） */
  plans?: TradePlan[]
  /** 手动拆出来的卖出目标（V6 分批止盈） */
  extraTargets?: ExtraTarget[]
}

/** 组池分组键（v9.20 起带账户维度）：账户|股票|成本分，'all' 视图下不同账户不混池 */
export function groupKeyOf(accountId: string, stockId: string, priceCents: number): string {
  return `${accountId}|${stockId}|${priceCents}`
}

function sumBy<T>(arr: T[], f: (x: T) => number): number {
  return arr.reduce((a, x) => a + f(x), 0)
}

export function buildLedger(
  records: RawRecord[],
  stocks: StockConfig[],
  opts: BuildOptions = {},
): Ledger {
  const baseAmountYuan = opts.baseAmountYuan ?? 6000
  const deriveSellPrice = opts.deriveSellPrice ?? false
  const executions = opts.executions ?? []
  const plans = opts.plans ?? []
  const extraTargets = opts.extraTargets ?? []
  const planByRef = new Map(plans.map((p) => [p.refId, p]))
  const extraByLot = new Map<string, ExtraTarget[]>()
  for (const t of extraTargets) {
    const list = extraByLot.get(t.lotId)
    if (list) list.push(t)
    else extraByLot.set(t.lotId, [t])
  }
  // 软删除的行不参与任何计算
  const live = records.filter((r) => !r.deletedAt)
  const byRow = new Map(live.map((r) => [r.sourceRow, r]))
  const stockMap = new Map(stocks.map((s) => [s.name, s]))
  const anomalies: Anomaly[] = []
  const lots: Lot[] = []
  const sells: SellExecution[] = []

  for (const r of live) {
    const cfg = stockMap.get(r.stockName)
    const stockId = cfg?.id ?? stockIdOf(r.stockName)
    const interval = cfg?.intervalCents ?? 0
    const accId = accountIdOf(r)

    // D 列：FLOOR(6000/买入价,100)（S2）
    const qty =
      r.buyQtyRaw ??
      (r.qtyNeedsDerive && r.buyPriceCents ? deriveBuyQty(r.buyPriceCents, baseAmountYuan) : null)

    const soldQty = r.soldQty ?? 0
    // E 列：公式无缓存值 → 买入价 + 该股默认间隔（D1）
    // 已成交行默认不推定成交价（见 BuildOptions.deriveSellPrice）
    let target = r.targetPriceCents
    if (target === null && r.targetNeedsDerive && r.buyPriceCents && interval > 0) {
      if (soldQty === 0 || deriveSellPrice) target = r.buyPriceCents + interval
    }

    const buyDate = serialToIso(r.buyDateSerial)
    const soldAt = serialToIso(r.sellDateSerial)
    const isLot = r.buyPriceCents !== null && qty !== null && qty > 0
    const isSell = soldQty > 0

    if (isLot) {
      const rem = Math.max(0, qty! - soldQty)
      const lot: Lot = {
        id: `lot:${r.sourceRow}`,
        sourceRow: r.sourceRow,
        stockId,
        stockName: r.stockName,
        buyDate,
        buyPriceCents: r.buyPriceCents!,
        qty: qty!,
        soldQty,
        remainingQty: rem,
        targetPriceCents: target,
        needsPrice: target === null,
        importKey: r.importKey,
      }
      lots.push(lot)
      // 超卖：卖出量超过批次量，超出部分没有批次对应——标出来让用户知道
      if (soldQty > qty!) {
        anomalies.push({
          kind: 'oversell',
          sourceRow: r.sourceRow,
          stockName: r.stockName,
          detail: `卖出 ${soldQty} 股 > 买入 ${qty} 股，超出 ${soldQty - qty!} 股无批次对应`,
        })
      }
      if (target === null && rem > 0) {
        anomalies.push({
          kind: 'needsPrice',
          sourceRow: r.sourceRow,
          stockName: r.stockName,
          detail: '买入价与目标售价均缺失，无法生成待卖',
        })
      }
    }

    if (isSell) {
      // 成本：买入价优先，无批次时取 P 列（R4 / D5）
      const cost = r.buyPriceCents ?? r.earlyBuyPriceCents
      const price = target
      const costComplete = cost !== null && price !== null
      const profit = costComplete ? mulCents(price! - cost!, soldQty) : null
      // D4：有日期就比较；无买入批次（先卖后买）同样置 sellBeforeBuy
      const sellBeforeBuy =
        (r.buyDateSerial !== null &&
          r.sellDateSerial !== null &&
          r.sellDateSerial < r.buyDateSerial) ||
        (r.buyPriceCents === null && soldQty > 0)
      const groupKey = cost !== null ? groupKeyOf(accId, stockId, cost) : null

      const sell: SellExecution = {
        id: `sell:${r.sourceRow}`,
        sourceRow: r.sourceRow,
        stockId,
        stockName: r.stockName,
        qty: soldQty,
        priceCents: price,
        costCents: cost,
        profitCents: profit,
        soldAt,
        dateMissing: soldAt === null,
        priceSource: price === null ? 'missing' : 'target',
        rebuyStatus: r.earlyBuyPriceCents !== null ? 'pending' : 'repaid',
        sellBeforeBuy,
        groupKey,
        costComplete,
        // §7.1：卖出挂回买入批次；先卖后买（无批次）留 null
        lotId: isLot ? `lot:${r.sourceRow}` : null,
        // 自动目标在下面生成后再回填
        targetId: null,
      }
      sells.push(sell)

      if (soldAt === null) {
        anomalies.push({
          kind: 'dateMissing',
          sourceRow: r.sourceRow,
          stockName: r.stockName,
          detail: r.sellDateNeedsToday
            ? '卖出日期是 =TODAY() 公式、工作簿没存计算结果（打开 Excel 只会显示当天），需补真实成交日'
            : '卖出日期为空，待补真实成交日',
        })
      }
      if (profit !== null && profit < 0) {
        anomalies.push({
          kind: 'negativeProfit',
          sourceRow: r.sourceRow,
          stockName: r.stockName,
          detail: '负盈利，计入组池但可分配额度下限为 0（P1）',
        })
      }
      if (price === null) {
        anomalies.push({
          kind: 'needsPrice',
          sourceRow: r.sourceRow,
          stockName: r.stockName,
          detail: '缺目标售价（E 列公式已损坏），盈利无法计算，不入组池',
        })
      } else if (cost === null) {
        anomalies.push({
          kind: 'needsCost',
          sourceRow: r.sourceRow,
          stockName: r.stockName,
          detail: '买入价与 P 列都空，无法确定成本，盈利算不出来',
        })
      }
      // D4：先卖后买合法，不进异常清单，仅置标记
    }
  }

  // 回补成交只认当前范围内的卖出行：executions 是全局表，账户筛选时
  // 别的账户的成交不该算进净持仓、也不该消耗本组的奖励预算（P4）
  const sellIdSet = new Set(sells.map((s) => s.id))
  const scopedExecs = executions
    .filter((e) => sellIdSet.has(e.sellExecId))
    .map((e) => {
      // 老库存的 groupKeyAtExecution 没有账户前缀：按成交所属行补齐账户维度，
      // 只改派生副本、不动存储原值（P4：额度消耗永久留在成交时的价组）
      if (e.groupKeyAtExecution.startsWith('acc:')) return e
      const row = byRow.get(Number(e.sellExecId.slice('sell:'.length)))
      const acc = row ? accountIdOf(row) : DEFAULT_ACCOUNT_ID
      return { ...e, groupKeyAtExecution: `${acc}|${e.groupKeyAtExecution}` }
    })
  const execByOrder = new Map<string, RebuyExecution[]>()
  for (const e of scopedExecs) {
    const list = execByOrder.get(e.orderId)
    if (list) list.push(e)
    else execByOrder.set(e.orderId, [e])
  }

  // R1 待卖：有剩余持仓的批次 × E；手动拆分的先占额度，剩下的才走自动目标
  const targets: SellTarget[] = []
  for (const lot of lots) {
    if (lot.remainingQty <= 0) continue
    const manual = (extraByLot.get(lot.id) ?? []).slice().sort((a, b) => a.at - b.at)
    let budget = lot.remainingQty

    for (const m of manual) {
      if (budget <= 0) break
      const q = Math.min(m.qty, budget)
      budget -= q
      const plan = planByRef.get(`target:${m.id}`)
      targets.push({
        id: `target:${m.id}`,
        lotId: lot.id,
        stockId: lot.stockId,
        stockName: lot.stockName,
        priceCents: m.priceCents,
        qty: q,
        autoGenerated: false,
        expectProfitCents: mulCents(m.priceCents - lot.buyPriceCents, q),
        amountCents: mulCents(m.priceCents, q),
        planPriceCents: plan?.priceCents ?? null,
        planQty: plan?.qty ?? null,
      })
    }

    const manualTotal = manual.reduce((a, m) => a + m.qty, 0)
    if (manualTotal > lot.remainingQty) {
      anomalies.push({
        kind: 'targetOverflow',
        sourceRow: lot.sourceRow,
        stockName: lot.stockName,
        detail: `拆分目标合计 ${manualTotal} 股 > 批次剩余 ${lot.remainingQty} 股，已按剩余量截断`,
      })
    }

    if (budget > 0 && lot.targetPriceCents !== null) {
      const plan = planByRef.get(`target:${lot.id}`)
      targets.push({
        id: `target:${lot.id}`,
        lotId: lot.id,
        stockId: lot.stockId,
        stockName: lot.stockName,
        priceCents: lot.targetPriceCents,
        qty: budget,
        autoGenerated: true,
        expectProfitCents: mulCents(lot.targetPriceCents - lot.buyPriceCents, budget),
        amountCents: mulCents(lot.targetPriceCents, budget),
        planPriceCents: plan?.priceCents ?? null,
        planQty: plan?.qty ?? null,
      })
    }
  }

  // §7.1：把自动卖出目标回填到卖出成交上（同一批次一条自动目标）
  const autoTargetByLot = new Map<string, string>()
  for (const t of targets) {
    if (t.autoGenerated) autoTargetByLot.set(t.lotId, t.id)
  }
  for (const sell of sells) {
    if (sell.lotId !== null) sell.targetId = autoTargetByLot.get(sell.lotId) ?? null
  }

  // R2 待买：只认 P 列（D3）
  const orders: RebuyOrder[] = []
  for (const sell of sells) {
    if (sell.rebuyStatus !== 'pending') continue
    const rec = byRow.get(sell.sourceRow)
    if (!rec || rec.earlyBuyPriceCents === null) continue
    const orderId = `rb:${sell.id}`
    const myExecs = execByOrder.get(orderId) ?? []
    const execQty = myExecs.reduce((a, e) => a + e.qty, 0)
    const doneRewardQty = myExecs.reduce((a, e) => a + e.rewardQty, 0)
    orders.push({
      id: orderId,
      sellExecId: sell.id,
      sourceRow: sell.sourceRow,
      stockId: sell.stockId,
      stockName: sell.stockName,
      rebuyPriceCents: rec.earlyBuyPriceCents,
      baseQty: sell.qty,
      rewardQty: 0,
      execQty,
      doneRewardQty,
      remainingQty: Math.max(0, sell.qty - execQty),
      status: execQty <= 0 ? 'open' : 'partial',
      groupKey: groupKeyOf(accountIdOf(rec), sell.stockId, rec.earlyBuyPriceCents),
      grossProfitCents: 0,
      hands: 0,
      createdAt: sell.sourceRow,
      exposure: rec.buyPriceCents === null,
      planPriceCents: planByRef.get(orderId)?.priceCents ?? null,
      planQty: planByRef.get(orderId)?.qty ?? null,
      rewardSourceOrderIds: [],
    })
  }

  // R6（v9.20 用户决策）：回补成交自动生成「回补批次」——买回的股回到待卖清单，
  // 目标价 = 成交价 + 该股间隔。纯派生对象不落库，撤销成交即消失。
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const virtualLots: Lot[] = []
  for (const e of scopedExecs) {
    const o = orderById.get(e.orderId)
    if (!o) continue
    const interval = stockMap.get(e.stockName)?.intervalCents ?? 0
    const target = interval > 0 ? e.priceCents + interval : null
    const d = new Date(e.at)
    virtualLots.push({
      id: `lot:exec:${e.id}`,
      // 200000 段位：不与 Excel 行号 / 手动行（100000+）相撞的派生行号
      sourceRow: 200000 + virtualLots.length,
      stockId: o.stockId,
      stockName: o.stockName,
      buyDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      buyPriceCents: e.priceCents,
      qty: e.qty,
      soldQty: 0,
      remainingQty: e.qty,
      targetPriceCents: target,
      needsPrice: target === null,
      importKey: e.id,
    })
    if (target === null) {
      anomalies.push({
        kind: 'needsPrice',
        sourceRow: o.sourceRow,
        stockName: o.stockName,
        detail: `回补批次（${e.qty} 股 @ ${(e.priceCents / 100).toFixed(2)}）缺该股间隔配置，无法生成待卖目标`,
      })
    }
  }
  // 回补批次与真实批次走同一套 R1 语义：自动目标挂在批次上，手动拆分也可用
  for (const vl of virtualLots) {
    if (vl.targetPriceCents === null) continue
    const plan = planByRef.get(`target:${vl.id}`)
    targets.push({
      id: `target:${vl.id}`,
      lotId: vl.id,
      stockId: vl.stockId,
      stockName: vl.stockName,
      priceCents: vl.targetPriceCents,
      qty: vl.remainingQty,
      autoGenerated: true,
      expectProfitCents: mulCents(vl.targetPriceCents - vl.buyPriceCents, vl.remainingQty),
      amountCents: mulCents(vl.targetPriceCents, vl.remainingQty),
      planPriceCents: plan?.priceCents ?? null,
      planQty: plan?.qty ?? null,
    })
  }
  const allLots = [...lots, ...virtualLots]

  // R4/R5 组池与奖励
  const groups = computeGroups(sells, orders, scopedExecs)
  for (const o of orders) {
    const g = groups.get(o.groupKey)
    if (g) {
      o.grossProfitCents = g.grossProfitCents
      o.hands = g.grantedHands
    }
    // 奖励股数确定后再算剩余与状态
    const planQty = o.baseQty + o.rewardQty
    o.remainingQty = Math.max(0, planQty - o.execQty)
    o.status = o.execQty <= 0 ? 'open' : o.remainingQty === 0 ? 'closed' : 'partial'
  }

  // 汇总（v9.20：回补批次已是派生批次计入 Σ买入，净持仓不再单独加回补量）
  const totals = {
    rows: live.length,
    buyQty: sumBy(allLots, (l) => l.qty),
    buyAmountCents: sumBy(allLots, (l) => mulCents(l.buyPriceCents, l.qty)),
    sellCount: sells.length,
    sellQty: sumBy(sells, (s) => s.qty),
    sellAmountCents: sumBy(sells, (s) => (s.priceCents === null ? 0 : mulCents(s.priceCents, s.qty))),
    profitCents: sumBy(sells, (s) => s.profitCents ?? 0),
    targetCount: targets.length,
    targetQty: sumBy(targets, (t) => t.qty),
    targetAmountCents: sumBy(targets, (t) => t.amountCents),
    expectProfitCents: sumBy(targets, (t) => t.expectProfitCents),
    rebuyCount: orders.length,
    rebuyBaseQty: sumBy(orders, (o) => o.baseQty),
    rebuyRewardQty: sumBy(orders, (o) => o.rewardQty),
    rebuyQty: sumBy(orders, (o) => o.baseQty + o.rewardQty),
    rebuyAmountCents: sumBy(orders, (o) => mulCents(o.rebuyPriceCents, o.baseQty + o.rewardQty)),
    rewardQty: sumBy(orders, (o) => o.rewardQty),
    rebuyExecQty: sumBy(scopedExecs, (e) => e.qty),
    /** 空头挂单回补成交里的基础股部分：既抵了敞口、又以回补批次进了待卖，守恒式里要扣回防双算 */
    exposureExecBaseQty: sumBy(
      scopedExecs.filter((e) => orderById.get(e.orderId)?.exposure === true),
      (e) => Math.max(0, e.qty - e.rewardQty),
    ),
    rebuyRemainingQty: sumBy(orders, (o) => o.remainingQty),
    netQty: 0,
    // 只算真空头敞口：无买入批次、且还没回补掉的那部分（D5）。
    // 奖励股是额外买入，不算欠账，所以从已成交里剔除。
    exposureQty: sumBy(
      orders.filter((o) => o.exposure),
      (o) => Math.max(0, o.baseQty - Math.max(0, o.execQty - o.doneRewardQty)),
    ),
  }
  // 回补批次已在 Σ买入 里，净持仓 = Σ买入 − Σ卖出
  totals.netQty = totals.buyQty - totals.sellQty

  const byStock = summarizeByStock(live, allLots, sells, targets, orders)
  const monthly = summarizeMonthly(sells)
  const daily = summarizeDaily(sells)

  const checks: CheckResult[] = [
    {
      name: 'Σ买入（含回补批次） − Σ卖出 = 净持仓',
      ok: totals.buyQty - totals.sellQty === totals.netQty,
      actual: `${totals.buyQty} − ${totals.sellQty} = ${totals.netQty}`,
      expected: '等式成立',
    },
    {
      name: 'Σ待卖量 − 待补敞口 − 空头回补基础股 = 净持仓',
      ok:
        totals.targetQty - totals.exposureQty - totals.exposureExecBaseQty ===
        totals.netQty,
      actual: `${totals.targetQty} − ${totals.exposureQty} − ${totals.exposureExecBaseQty} = ${
        totals.targetQty - totals.exposureQty - totals.exposureExecBaseQty
      }`,
      expected: `= ${totals.netQty}`,
      detail:
        '回补成交自动生成回补批次进待卖（R6）；空头单回补的基础股既抵了敞口又在待卖里，扣回防双算；奖励股是额外买入不减敞口',
    },
    {
      name: 'Σ待卖量 = Σ批次剩余',
      ok: totals.targetQty === sumBy(allLots, (l) => l.remainingQty),
      actual: `${totals.targetQty} vs ${sumBy(allLots, (l) => l.remainingQty)}`,
      expected: '相等',
    },
    {
      name: '奖励量 % 100 = 0',
      ok: totals.rewardQty % 100 === 0,
      actual: `${totals.rewardQty}`,
      expected: '100 的整数倍',
    },
    {
      name: 'Σ授予手数 ≤ Σ组容量',
      ok: sumBy([...groups.values()], (g) => g.grantedHands) <= sumBy([...groups.values()], (g) => g.capacityHands),
      actual: `${sumBy([...groups.values()], (g) => g.grantedHands)} / ${sumBy([...groups.values()], (g) => g.capacityHands)}`,
      expected: '授予不超容量',
    },
  ]

  return {
    lots: allLots,
    sells,
    targets,
    orders,
    groups: [...groups.values()].sort((a, b) => b.grossProfitCents - a.grossProfitCents),
    byStock,
    daily,
    monthly,
    anomalies,
    checks,
    totals,
  }
}

/**
 * 组池 + FIFO 授予（R4 / R5 / 8.2）。
 * - gross：组内全部真实卖出盈利（含已回补的）
 * - used：已成交奖励股数 × 成交价，按 groupKeyAtExecution 永久归属（P4）
 * - 剩余预算 = max(0, gross − used)，能再授几手 = floor(剩余预算 / 每手成本)
 * - 已成交的奖励股数不可撤（doneRewardQty），新额度只能在它之上叠加
 */
function computeGroups(
  sells: SellExecution[],
  orders: RebuyOrder[],
  executions: RebuyExecution[],
): Map<string, GroupPool> {
  const pools = new Map<string, GroupPool>()

  for (const s of sells) {
    if (!s.costComplete || s.groupKey === null || s.profitCents === null) continue
    const priceCents = s.costCents!
    const key = s.groupKey
    let g = pools.get(key)
    if (!g) {
      g = {
        groupKey: key,
        stockId: s.stockId,
        rebuyPriceCents: priceCents,
        grossProfitCents: 0,
        usedProfitCents: 0,
        capacityHands: 0,
        grantedHands: 0,
        availableCents: 0,
        lotCostCents: priceCents * 100,
      }
      pools.set(key, g)
    }
    g.grossProfitCents += s.profitCents
  }

  // 已成交的奖励消耗，永久留在成交时的价组
  for (const e of executions) {
    const g = pools.get(e.groupKeyAtExecution)
    if (g) g.usedProfitCents += e.rewardQty * e.priceCents
  }

  for (const g of pools.values()) {
    g.capacityHands = Math.floor(Math.max(0, g.grossProfitCents - g.usedProfitCents) / g.lotCostCents)
    let left = g.capacityHands
    const groupOrders = orders
      .filter((o) => o.groupKey === g.groupKey && (o.status === 'open' || o.status === 'partial'))
      .sort((a, b) => a.createdAt - b.createdAt)
    // §7.1：凑手来源按 FIFO 顺序累加，记录这一手是组内哪几张单凑出来的
    const chain: string[] = []
    for (const o of groupOrders) {
      chain.push(o.id)
      const keep = Math.floor(o.doneRewardQty / 100) // 已成交不可撤
      // 已经买满的单子（剩余 0）不再领新奖励——否则容量被永远不会执行的
      // 幻影奖励吃掉，组里排在后面的单子永远轮不到
      const need = o.baseQty + keep * 100 - o.execQty
      const grant = need > 0 && left > 0 ? Math.min(left, g.capacityHands) : 0
      o.rewardQty = (keep + grant) * 100
      o.rewardSourceOrderIds = o.rewardQty > 0 ? [...chain] : []
      left -= grant
    }
    g.grantedHands = g.capacityHands - left
    g.availableCents = left * g.lotCostCents
  }

  return pools
}

function summarizeByStock(
  records: RawRecord[],
  lots: Lot[],
  sells: SellExecution[],
  targets: SellTarget[],
  orders: RebuyOrder[],
): StockSummary[] {
  const names = [...new Set(records.map((r) => r.stockName))]
  return names.map((name) => {
    const ls = lots.filter((l) => l.stockName === name)
    const ss = sells.filter((s) => s.stockName === name)
    const ts = targets.filter((t) => t.stockName === name)
    const os = orders.filter((o) => o.stockName === name)
    return {
      stockId: ls[0]?.stockId ?? ss[0]?.stockId ?? stockIdOf(name),
      stockName: name,
      rows: records.filter((r) => r.stockName === name).length,
      buyQty: sumBy(ls, (l) => l.qty),
      buyAmountCents: sumBy(ls, (l) => mulCents(l.buyPriceCents, l.qty)),
      sellCount: ss.length,
      sellQty: sumBy(ss, (s) => s.qty),
      sellAmountCents: sumBy(ss, (s) => (s.priceCents === null ? 0 : mulCents(s.priceCents, s.qty))),
      profitCents: sumBy(ss, (s) => s.profitCents ?? 0),
      targetCount: ts.length,
      targetQty: sumBy(ts, (t) => t.qty),
      targetAmountCents: sumBy(ts, (t) => t.amountCents),
      expectProfitCents: sumBy(ts, (t) => t.expectProfitCents),
      rebuyCount: os.length,
      rebuyQty: sumBy(os, (o) => o.baseQty + o.rewardQty),
      // 与 totals 同口径：lots 已含回补批次（虚拟批次），净持仓 = Σ买入 − Σ卖出
      netQty: sumBy(ls, (l) => l.qty) - sumBy(ss, (s) => s.qty),
      exposureQty: sumBy(
        os.filter((o) => o.exposure),
        (o) => Math.max(0, o.baseQty - Math.max(0, o.execQty - o.doneRewardQty)),
      ),
    }
  })
}

/** 按天聚合（日历和月度共用同一套卖出口径） */
function summarizeDaily(sells: SellExecution[]): DayBucket[] {
  const map = new Map<string, DayBucket>()
  for (const s of sells) {
    const day = s.soldAt ?? '未填日期'
    let b = map.get(day)
    if (!b) {
      b = { day, sellCount: 0, sellQty: 0, profitCents: 0, dateMissing: day === '未填日期' }
      map.set(day, b)
    }
    b.sellCount += 1
    b.sellQty += s.qty
    b.profitCents += s.profitCents ?? 0
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

function summarizeMonthly(sells: SellExecution[]): MonthlyBucket[] {
  const map = new Map<string, MonthlyBucket>()
  for (const s of sells) {
    const month = s.soldAt ? s.soldAt.slice(0, 7) : '未填日期'
    let b = map.get(month)
    if (!b) {
      b = {
        month,
        sellCount: 0,
        sellQty: 0,
        sellAmountCents: 0,
        profitCents: 0,
        dateMissing: month === '未填日期',
      }
      map.set(month, b)
    }
    b.sellCount += 1
    b.sellQty += s.qty
    b.sellAmountCents += s.priceCents === null ? 0 : mulCents(s.priceCents, s.qty)
    b.profitCents += s.profitCents ?? 0
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : 1))
}

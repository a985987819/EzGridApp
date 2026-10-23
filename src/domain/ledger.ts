/**
 * 关联引擎：把原始行推导成 批次 / 成交 / 待卖目标 / 待买订单 / 组池奖励。
 * 对应规范 §8.1 §8.2 §8.3，D1–D5 全部落在这里。
 */

import { mulCents } from './money'
import { deriveBuyQty } from './qty'
import { serialToIso, stockIdOf } from './defaults'
import type {
  Anomaly,
  ExtraTarget,
  RebuyExecution,
  TradePlan,
  CheckResult,
  GroupPool,
  Ledger,
  Lot,
  DayBucket,
  MonthlyBucket,
  RawRecord,
  RebuyOrder,
  SellExecution,
  SellTarget,
  StockConfig,
  StockSummary,
} from './types'

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

export function groupKeyOf(stockId: string, priceCents: number): string {
  return `${stockId}|${priceCents}`
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
  const execByOrder = new Map<string, RebuyExecution[]>()
  for (const e of executions) {
    const list = execByOrder.get(e.orderId)
    if (list) list.push(e)
    else execByOrder.set(e.orderId, [e])
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
      const groupKey = cost !== null ? groupKeyOf(stockId, cost) : null

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
          detail: 'Excel 用 TODAY() 且无缓存值，卖出日期待补',
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
      groupKey: groupKeyOf(sell.stockId, rec.earlyBuyPriceCents),
      grossProfitCents: 0,
      hands: 0,
      createdAt: sell.sourceRow,
      exposure: rec.buyPriceCents === null,
      planPriceCents: planByRef.get(orderId)?.priceCents ?? null,
      planQty: planByRef.get(orderId)?.qty ?? null,
      rewardSourceOrderIds: [],
    })
  }

  // R4/R5 组池与奖励
  const groups = computeGroups(sells, orders, executions)
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

  // 汇总
  const totals = {
    rows: live.length,
    buyQty: sumBy(lots, (l) => l.qty),
    buyAmountCents: sumBy(lots, (l) => mulCents(l.buyPriceCents, l.qty)),
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
    rebuyExecQty: sumBy(executions, (e) => e.qty),
    rebuyRemainingQty: sumBy(orders, (o) => o.remainingQty),
    netQty: 0,
    // 只算真空头敞口：无买入批次、且还没回补掉的那部分（D5）。
    // 奖励股是额外买入，不算欠账，所以从已成交里剔除。
    exposureQty: sumBy(
      orders.filter((o) => o.exposure),
      (o) => Math.max(0, o.baseQty - Math.max(0, o.execQty - o.doneRewardQty)),
    ),
  }
  // 回补成交是真实买入，计入净持仓
  totals.netQty = totals.buyQty - totals.sellQty + totals.rebuyExecQty

  const byStock = summarizeByStock(live, lots, sells, targets, orders)
  const monthly = summarizeMonthly(sells)
  const daily = summarizeDaily(sells)

  const checks: CheckResult[] = [
    {
      name: 'Σ买入 + Σ回补 − Σ卖出 = 净持仓',
      ok: totals.buyQty + totals.rebuyExecQty - totals.sellQty === totals.netQty,
      actual: `${totals.buyQty} + ${totals.rebuyExecQty} − ${totals.sellQty} = ${totals.netQty}`,
      expected: '等式成立',
    },
    {
      name: 'Σ待卖量 − 待补敞口 = 净持仓',
      ok: totals.targetQty - totals.exposureQty === totals.netQty,
      actual: `${totals.targetQty} − ${totals.exposureQty} = ${totals.targetQty - totals.exposureQty}`,
      expected: `= ${totals.netQty}`,
      detail: '待补只算无买入批次的卖出；有批次的回补只是再买入，不占敞口',
    },
    {
      name: 'Σ待卖量 = Σ批次剩余',
      ok: totals.targetQty === sumBy(lots, (l) => l.remainingQty),
      actual: `${totals.targetQty} vs ${sumBy(lots, (l) => l.remainingQty)}`,
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
    lots,
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
      if (left <= 0) {
        o.rewardQty = keep * 100
        o.rewardSourceOrderIds = o.rewardQty > 0 ? [...chain] : []
        continue
      }
      const grant = Math.min(left, g.capacityHands)
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
      netQty: sumBy(ls, (l) => l.qty) - sumBy(ss, (s) => s.qty),
      exposureQty: sumBy(os.filter((o) => o.exposure), (o) => o.baseQty),
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

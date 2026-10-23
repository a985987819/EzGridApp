/**
 * 关联引擎：把原始行推导成 批次 / 成交 / 待卖目标 / 待买订单 / 组池奖励。
 * 对应规范 §8.1 §8.2 §8.3，D1–D5 全部落在这里。
 */

import { mulCents } from './money'
import { deriveBuyQty } from './qty'
import { serialToIso, stockIdOf } from './defaults'
import type {
  Anomaly,
  CheckResult,
  GroupPool,
  Ledger,
  Lot,
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
      }
      // D4：先卖后买合法，不进异常清单，仅置标记
    }
  }

  // R1 待卖：有剩余持仓的批次 × E
  const targets: SellTarget[] = []
  for (const lot of lots) {
    if (lot.remainingQty <= 0 || lot.targetPriceCents === null) continue
    targets.push({
      id: `target:${lot.id}`,
      lotId: lot.id,
      stockId: lot.stockId,
      stockName: lot.stockName,
      priceCents: lot.targetPriceCents,
      qty: lot.remainingQty,
      autoGenerated: true,
      expectProfitCents: mulCents(lot.targetPriceCents - lot.buyPriceCents, lot.remainingQty),
      amountCents: mulCents(lot.targetPriceCents, lot.remainingQty),
    })
  }

  // R2 待买：只认 P 列（D3）
  const orders: RebuyOrder[] = []
  for (const sell of sells) {
    if (sell.rebuyStatus !== 'pending') continue
    const rec = byRow.get(sell.sourceRow)
    if (!rec || rec.earlyBuyPriceCents === null) continue
    orders.push({
      id: `rb:${sell.id}`,
      sellExecId: sell.id,
      sourceRow: sell.sourceRow,
      stockId: sell.stockId,
      stockName: sell.stockName,
      rebuyPriceCents: rec.earlyBuyPriceCents,
      baseQty: sell.qty,
      rewardQty: 0,
      status: 'open',
      groupKey: groupKeyOf(sell.stockId, rec.earlyBuyPriceCents),
      grossProfitCents: 0,
      hands: 0,
      createdAt: sell.sourceRow,
      exposure: rec.buyPriceCents === null,
    })
  }

  // R4/R5 组池与奖励
  const groups = computeGroups(sells, orders)
  for (const o of orders) {
    const g = groups.get(o.groupKey)
    if (g) {
      o.grossProfitCents = g.grossProfitCents
      o.hands = g.grantedHands
    }
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
    netQty: 0,
    // 只算真空头敞口：无买入批次的那几笔卖出（D5）
    exposureQty: sumBy(
      orders.filter((o) => o.exposure),
      (o) => o.baseQty,
    ),
  }
  totals.netQty = totals.buyQty - totals.sellQty

  const byStock = summarizeByStock(live, lots, sells, targets, orders)
  const monthly = summarizeMonthly(sells)

  const checks: CheckResult[] = [
    {
      name: 'Σ买入份额 − Σ卖出量 = 净持仓',
      ok: totals.buyQty - totals.sellQty === totals.netQty,
      actual: `${totals.buyQty} − ${totals.sellQty} = ${totals.netQty}`,
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
    monthly,
    anomalies,
    checks,
    totals,
  }
}

/** 组池 + FIFO 授予（R4 / R5 / 8.2）。当前无回补成交，used 恒为 0。 */
function computeGroups(sells: SellExecution[], orders: RebuyOrder[]): Map<string, GroupPool> {
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

  // FIFO：只挂给 open 订单，跨单凑整手
  for (const g of pools.values()) {
    g.capacityHands = Math.floor(Math.max(0, g.grossProfitCents - g.usedProfitCents) / g.lotCostCents)
    let left = g.capacityHands
    const groupOrders = orders
      .filter((o) => o.groupKey === g.groupKey && (o.status === 'open' || o.status === 'partial'))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const o of groupOrders) {
      if (left <= 0) break
      const grant = Math.min(left, g.capacityHands)
      o.rewardQty = grant * 100
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

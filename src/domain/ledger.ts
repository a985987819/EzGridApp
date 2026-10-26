/**
 * 关联引擎：把原始行推导成 批次 / 成交 / 待卖目标 / 待买订单 / 组池奖励。
 * 对应规范 §8.1 §8.2 §8.3，D1–D5 全部落在这里。
 */

import { mulCents } from './money'
import { deriveBuyQty } from './qty'
import { deriveRebuyPrice } from './manual'
import { serialToIso, stockIdOf } from './defaults'
import { buildRepairChains } from './chain'
import { type Anomaly, type BuySplit, type ExtraBuyTarget, type ExtraTarget, type HedgeLink, type RebuyExecution, type TradePlan, type CheckResult, type GroupPool, type Ledger, type Lot, type DayBucket, type MonthlyBucket, type RawRecord, type RebuyOrder, type RepairChain, type RepairChainLink, type SellExecution, type SellTarget, type StockConfig, type StockSummary } from './types'

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
  /** 卖单拆出来的买入目标（V9.50 分批回补）：只影响挂单展示与记成交取价 */
  buyTargets?: ExtraBuyTarget[]
  /** 先卖后买挂钩（V9.26）：裸卖 → 高位批次的人工分配 */
  hedges?: HedgeLink[]
  /** 回本链归属（V9.46）：锚点 + 后续归属的真实买入行 */
  chainLinks?: RepairChainLink[]
}

/** 组池分组键：股票|成本分（V9.32 起单一账户，不再带账户维度） */
export function groupKeyOf(stockId: string, priceCents: number): string {
  return `${stockId}|${priceCents}`
}

/**
 * 老数据/老备份里的键还带着账户前缀（`acc:default|stock:柳工|781`，V9.20~V9.31）。
 * 单一账户后统一剥掉前缀——只改派生副本，不动库里的原值（P4 的额度归属照旧）。
 */
export function stripAccountPrefix(key: string): string {
  return key.replace(/^acc:[^|]*\|/, '')
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
  const execByLotId = new Map(executions.map((e) => [`lot:exec:${e.id}`, e]))
  const lotCost = (id: string): number | null => execByLotId.get(id)?.priceCents ??
    byRow.get(Number(id.replace('lot:', '')))?.buyPriceCents ?? null
  // 父交易软删后，后续成交和回补也不参与派生，恢复后整条恢复。
  const reachable = new Set(live.filter((r) => !r.soldLotId).map((r) => r.sourceRow))
  let grew = true
  while (grew) {
    grew = false
    for (const r of live) {
      if (!r.soldLotId || reachable.has(r.sourceRow)) continue
      const parent = execByLotId.get(r.soldLotId)
      const parentRow = parent ? Number(parent.sellExecId.replace('sell:', '')) : Number(r.soldLotId.replace('lot:', ''))
      if (reachable.has(parentRow)) { reachable.add(r.sourceRow); grew = true }
    }
  }
  const sells: SellExecution[] = []

  for (const r of live) {
    if (!reachable.has(r.sourceRow)) continue
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
    if (target === null && (soldQty === 0 || r.targetNeedsDerive) && r.buyPriceCents && interval > 0) {
      if (soldQty === 0 || deriveSellPrice) target = r.buyPriceCents + interval
    }

    const buyDate = serialToIso(r.buyDateSerial)
    const soldAt = serialToIso(r.sellDateSerial)
    const isLot = !r.soldLotId && r.buyPriceCents !== null && qty !== null && qty > 0
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
      const cost = r.soldLotId ? lotCost(r.soldLotId) : r.buyPriceCents ?? r.earlyBuyPriceCents
      const price = target
      const costComplete = cost !== null && price !== null
      const profit = costComplete ? mulCents(price! - cost!, soldQty) : null
      // D4：有日期就比较；无买入批次（先卖后买）同样置 sellBeforeBuy
      const sellBeforeBuy =
        (r.buyDateSerial !== null &&
          r.sellDateSerial !== null &&
          r.sellDateSerial < r.buyDateSerial) ||
        (r.buyPriceCents === null && soldQty > 0)
      /**
       * V9.47.1 用户口径：先卖后买**允许卖出日期早于买入日期**，闭环只看份额——
       * 卖出日 ≤ 买入日（A股 T+1，当日买的不能当日卖，所以同日也只可能是先卖后买）时，
       * 本行的买入批次就是那笔回补本身：盖住多少卖出量就视为已买回多少，剩下的才是真欠账。
       * 先买后卖（买入日更早）不变——那种行里的 P 列是「下一轮打算什么价买回」，照旧挂待买单。
       */
      const soldFirst =
        r.buyDateSerial !== null && r.sellDateSerial !== null && r.sellDateSerial <= r.buyDateSerial
      const ownLotCoverQty = isLot && soldFirst ? Math.min(qty!, soldQty) : 0
      const needRebuyQty = Math.max(0, soldQty - ownLotCoverQty)
      const groupKey = cost !== null ? groupKeyOf(stockId, cost) : null
      /**
       * V9.49：回补价提前在这里定好（P 列 > 裸卖的推导价 = 卖出价 − 该股间隔）。
       * 回本链的「价位槽」靠它认「同股、同价买入」，待买单也复用它，口径只算一次。
       */
      const nakedRebuyPrice =
        !isLot && !r.soldLotId && r.rebuyPriceSource !== 'repaid' ? deriveRebuyPrice(r, interval).cents : null
      const rebuyPriceCents = r.earlyBuyPriceCents ?? nakedRebuyPrice

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
        rebuyStatus: rebuyPriceCents !== null && needRebuyQty > 0 ? 'pending' : 'repaid',
        rebuyPriceCents,
        ownLotCoverQty,
        sellBeforeBuy,
        groupKey,
        costComplete,
        // §7.1：卖出挂回买入批次；先卖后买（无批次）留 null
        lotId: r.soldLotId ?? (isLot ? `lot:${r.sourceRow}` : null),
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

  // 回补成交只认当前范围内的卖出行（executions 是全局表，行被删就一起失效）
  const sellIdSet = new Set(sells.map((s) => s.id))
  const scopedExecs = executions
    .filter((e) => sellIdSet.has(e.sellExecId))
    // V9.32 单一账户：老库/老备份的 groupKeyAtExecution 可能带 acc:xxx| 前缀，统一剥掉
    // （只改派生副本、不动存储原值；P4：额度消耗永久留在成交时的价组）
    .map((e) => ({ ...e, groupKeyAtExecution: stripAccountPrefix(e.groupKeyAtExecution) }))
  const execByOrder = new Map<string, RebuyExecution[]>()
  for (const e of scopedExecs) {
    const list = execByOrder.get(e.orderId)
    if (list) list.push(e)
    else execByOrder.set(e.orderId, [e])
  }

  // V9.26 先卖后买挂钩（H）：裸卖在未回补期间，把人工指定的高位批次按挂股数
  // 「暂记卖出」——批次退出待卖（份额置已卖）、按（卖价−买价）记负盈利挂到
  // 批次行上；被挂那部分不再按 P 列算盈利。纯派生，不写任何状态。
  // V9.33（用户拍板）：**部分买回不再整条作废**——挂钩只作用于「还没买回的股数」。
  // V9.36（用户拍板）：**回补了的份额不再让批次复活**。买回多少股，就把高位批次里
  // 相同股数永久了结（按卖出价记亏），批次剩余归零、退出待卖——这样「实物股数」才
  // 对得上（否则 10 元批次复活 + 6 元回补批次会双算成 1000 股）。了结的亏损进
  // 「回本链」，由低位继续做T的价差逐轮冲平。
  // V9.32 起按挂单时间（at）先后应用，抢同一批次股数时先挂先占。
  const hedgeLinks = (opts.hedges ?? []).slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const sellByRow = new Map(sells.map((s) => [s.sourceRow, s]))
  const lotByRow = new Map(lots.map((l) => [l.sourceRow, l]))
  const fullyHedgedRows = new Set<number>()
  const hedgeUsedByLot = new Map<number, number>()
  /** 每张裸卖实际挂住的股数（敞口按差额计：baseQty − 已回补 − hedgeApplied） */
  const hedgeAppliedByRow = new Map<number, number>()
  /** V9.36 每张裸卖「已回补所以永久了结」的股数（不再往待卖里灌重复股） */
  const hedgeClosedByRow = new Map<number, number>()
  for (const h of hedgeLinks) {
    const rec = byRow.get(h.sellRow)
    const naked =
      rec && !rec.soldLotId && rec.buyPriceCents === null && (rec.soldQty ?? 0) > 0 ? sellByRow.get(h.sellRow) : undefined
    if (!rec || !naked) continue // 行没了 / 不是裸卖 → 挂钩失效
    // 还没买回的股数 = 卖出量 − 已回补量：这部分还能挂；买回光了就整笔永久了结（V9.36）
    const execs = execByOrder.get(`rb:${naked.id}`) ?? []
    const execQty = execs.reduce((a, e) => a + e.qty - e.rewardQty, 0)
    const unrepaid = Math.max(0, naked.qty - execQty)
    if (naked.priceCents === null) {
      anomalies.push({
        kind: 'hedgeInvalid',
        sourceRow: h.sellRow,
        stockName: rec.stockName,
        detail: '裸卖缺成交价（E 列），挂钩暂记不了',
      })
      continue
    }
    const price = naked.priceCents
    let applied = 0
    /** 本次写进「暂记（还欠着）」的股数；不超过已回补前的欠量 */
    let heldQty = 0
    /** 本次永久了结到各批次上的股数（= 已买回那部分吃掉的额度） */
    const closedByRow = new Map<number, number>()
    for (const it of h.items) {
      if (applied >= naked.qty) break // 配额上限是这笔卖的全部股数
      const lot = lotByRow.get(it.row)
      const lotRec = lot ? byRow.get(it.row) : undefined
      if (!lot || !lotRec || lot.stockName !== rec.stockName || (lotRec.soldQty ?? 0) > 0) {
        anomalies.push({
          kind: 'hedgeInvalid',
          sourceRow: h.sellRow,
          stockName: rec.stockName,
          detail: `第 ${it.row} 行不是「${rec.stockName}」的未卖买入批次，跳过`,
        })
        continue
      }
      if (!Number.isFinite(it.qty) || it.qty <= 0) continue
      // V9.32 修 bug：lot.remainingQty 在前面每挂一条时已经被扣过，这里不能再减 hedgeUsedByLot，
      // 否则第二张裸卖挂同一批次时可用量被重复扣减（500 股的批次挂 200+300 会只挂上 300）。
      const used = hedgeUsedByLot.get(it.row) ?? 0
      const lotCap = Math.max(0, lot.remainingQty)
      const sellCap = Math.max(0, naked.qty - applied)
      const q = Math.min(Math.floor(it.qty), lotCap, sellCap)
      // 只有「被批次剩余卡住」才算超挂；因为已买回而被削到剩下的股数属于正常，不报异常
      if (q < it.qty && q >= lotCap) {
        anomalies.push({
          kind: 'hedgeOverflow',
          sourceRow: h.sellRow,
          stockName: rec.stockName,
          detail: `第 ${it.row} 行只挂得下 ${lotCap} 股（剩余 ${lot.remainingQty}${used ? ` − 其它裸卖已挂 ${used}` : ''}${execQty ? ` · 已买回 ${execQty} 股不参与` : ''}），已按 ${q} 股截断`,
        })
      }
      if (q <= 0) continue
      lot.soldQty += q
      lot.remainingQty -= q
      hedgeUsedByLot.set(it.row, used + q)
      applied += q
      // V9.36：先满足「还没买回」的份额（暂记，买回后会复原）；剩下的就是已经买回的
      // 那部分——它对应的批次份额永久卖掉、不再复活。
      const hold = Math.min(q, Math.max(0, unrepaid - heldQty))
      const closed = q - hold
      heldQty += hold
      if (hold > 0) {
        // 暂记卖出：价格 = 裸卖成交价，成本 = 批次买价，盈利为负挂到批次行上展示
        sells.push({
          id: `sell:hedged:${h.sellRow}:${it.row}`,
          sourceRow: it.row,
          stockId: lot.stockId,
          stockName: lot.stockName,
          qty: hold,
          priceCents: price,
          costCents: lot.buyPriceCents,
          profitCents: mulCents(price - lot.buyPriceCents, hold),
          soldAt: naked.soldAt,
          dateMissing: naked.dateMissing,
          priceSource: 'target',
          rebuyStatus: 'repaid',
          sellBeforeBuy: false,
          // 暂记不进组池（P4 的额度消耗只认真实卖出）
          groupKey: null,
          costComplete: false,
          lotId: lot.id,
          targetId: null,
          hedgedFromSellRow: h.sellRow,
        })
      }
      if (closed > 0) {
        // 已回补 → 永久了结：亏损是真亏（留在合计盈利里），批次份额不再回来
        sells.push({
          id: `sell:closed:${h.sellRow}:${it.row}`,
          sourceRow: it.row,
          stockId: lot.stockId,
          stockName: lot.stockName,
          qty: closed,
          priceCents: price,
          costCents: lot.buyPriceCents,
          profitCents: mulCents(price - lot.buyPriceCents, closed),
          soldAt: naked.soldAt,
          dateMissing: naked.dateMissing,
          priceSource: 'target',
          rebuyStatus: 'repaid',
          sellBeforeBuy: false,
          groupKey: null,
          costComplete: false,
          lotId: lot.id,
          targetId: null,
          hedgedFromSellRow: h.sellRow,
          hedgeClosed: true,
        })
        closedByRow.set(it.row, (closedByRow.get(it.row) ?? 0) + closed)
      }
    }
    if (applied > 0) {
      // 被挂的那部分不再按 P 列算盈利；没挂的照旧按 P 列结算。
      // 整笔都挂住 → 盈利整笔暂缓（profitCents = null，行上显示「暂缓」）。
      const plain = naked.qty - applied
      const cost = naked.costCents
      naked.profitCents =
        plain > 0 && cost !== null && naked.priceCents !== null ? mulCents(naked.priceCents - cost, plain) : null
      naked.hedgedHold = plain > 0 ? undefined : true
      hedgeAppliedByRow.set(h.sellRow, applied)
    }
    // 没买回的那部分全挂住了 = 这笔卖不再欠股（敞口归零）；只挂一部分算挂不满
    if (applied >= unrepaid) {
      fullyHedgedRows.add(h.sellRow)
    } else if (applied > 0) {
      anomalies.push({
        kind: 'hedgeMismatch',
        sourceRow: h.sellRow,
        stockName: rec.stockName,
        detail: `挂了 ${applied} 股 ≠ 还没买回 ${unrepaid} 股，差额仍按敞口计（守恒式会亮红灯）`,
      })
    }
    // V9.46：回补价差不再进回本链（改由 chain.ts 按「已实现净盈利」算），
    // 这里只记「了结股数」，守恒式扣双算还要用。
    const closedTotal = [...closedByRow.values()].reduce((a, n) => a + n, 0)
    if (closedTotal > 0) hedgeClosedByRow.set(h.sellRow, (hedgeClosedByRow.get(h.sellRow) ?? 0) + closedTotal)
  }

  // 回补批次是唯一实盘买入，关联卖出只扣库存。
  let virtualIndex = 0
  for (const e of scopedExecs) {
    const parent = byRow.get(Number(e.sellExecId.replace('sell:', '')))
    if (!parent || !reachable.has(parent.sourceRow)) continue
    const interval = stockMap.get(parent.stockName)?.intervalCents ?? 0
    const d = new Date(e.at)
    lots.push({
      id: `lot:exec:${e.id}`, sourceRow: 200000 + virtualIndex++,
      stockId: stockMap.get(parent.stockName)?.id ?? stockIdOf(parent.stockName), stockName: parent.stockName,
      buyDate: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
      buyPriceCents: e.priceCents, qty: e.qty, soldQty: 0, remainingQty: e.qty,
      targetPriceCents: interval > 0 ? e.priceCents + interval : null, needsPrice: interval <= 0, importKey: e.id,
    })
    if (interval <= 0) anomalies.push({kind:'needsPrice',sourceRow:parent.sourceRow,stockName:parent.stockName,detail:'回补批次缺该股间隔配置，无法生成待卖目标'})
  }
  const allLotById = new Map(lots.map((l) => [l.id, l]))
  for (const r of live) {
    if (!r.soldLotId || !reachable.has(r.sourceRow)) continue
    const lot = allLotById.get(r.soldLotId)
    if (!lot) continue
    const q = r.soldQty ?? 0
    if (q > lot.remainingQty) anomalies.push({kind:'oversell',sourceRow:r.sourceRow,stockName:r.stockName,detail:'关联卖出量超过批次剩余'})
    lot.soldQty += q
    lot.remainingQty = Math.max(0, lot.remainingQty - q)
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

  const allLots = lots

  // V9.49 回本链先算：价位槽会把「同股、同价买入」自动认作回补，输出每笔裸卖的覆盖量，
  // 待买单据此自动关掉（用户拍板「不手动关」）。链本身仍是纯派生，不落库。
  const chainCover = new Map<number, number>()
  const repairChains: RepairChain[] = buildRepairChains(
    {
      lots: allLots,
      sells,
      executions: scopedExecs,
      links: opts.chainLinks ?? [],
    },
    chainCover,
  )

  // R2 待买：只认 P 列（D3）
  const orders: RebuyOrder[] = []
  for (const sell of sells) {
    if (sell.rebuyStatus !== 'pending') continue
    const rec = byRow.get(sell.sourceRow)
    if (!rec) continue
    const rebuyPrice = sell.rebuyPriceCents ?? null
    if (rebuyPrice === null) continue
    const orderId = `rb:${sell.id}`
    const myExecs = execByOrder.get(orderId) ?? []
    const execQty = myExecs.reduce((a, e) => a + e.qty, 0)
    const doneRewardQty = myExecs.reduce((a, e) => a + e.rewardQty, 0)
    // V9.47.1：本行买入批次已经盖住的那部分不再挂单，只剩真欠的
    // V9.49：回本链价位槽里同价买回的股数同样算「已完成」，直接从待买里扣掉
    const needQty = Math.max(0, sell.qty - (sell.ownLotCoverQty ?? 0) - (chainCover.get(sell.sourceRow) ?? 0))
    orders.push({
      id: orderId,
      sellExecId: sell.id,
      sourceRow: sell.sourceRow,
      stockId: sell.stockId,
      stockName: sell.stockName,
      rebuyPriceCents: rebuyPrice,
      baseQty: needQty,
      rewardQty: 0,
      execQty,
      doneRewardQty,
      remainingQty: Math.max(0, needQty - execQty),
      status: execQty <= 0 ? 'open' : 'partial',
      groupKey: groupKeyOf(sell.stockId, rebuyPrice),
      grossProfitCents: 0,
      hands: 0,
      createdAt: sell.sourceRow,
      // 全额挂住的裸卖不算敞口：交割股由挂的高位批次提供（V9.26）
      // V9.49：已被回本链同价买回盖满的也不算敞口（空头已经平了）
      exposure:
        needQty > 0 &&
        (!sell.lotId || ((sell.ownLotCoverQty ?? 0) > 0 && sell.qty > (sell.ownLotCoverQty ?? 0))) &&
        !fullyHedgedRows.has(rec.sourceRow),
      planPriceCents: planByRef.get(orderId)?.priceCents ?? null,
      planQty: planByRef.get(orderId)?.qty ?? null,
      rewardSourceOrderIds: [],
    })
  }

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
    const sell = sells.find((s) => s.id === o.sellExecId)
    if (sell) {
      sell.rebuyStatus = o.remainingQty > 0 ? 'pending' : 'repaid'
      sell.rebuyRemainingQty = o.remainingQty
      sell.rebuyPriceCents = o.rebuyPriceCents
    }
  }

  // V9.50：待买展示档——没拆分就是整单一条，拆了按 buyTargets 分段（记成交按档取价、取量）
  const buySplits = buildBuySplits(orders, opts.buyTargets ?? [], anomalies)

  // 汇总（v9.20：回补批次已是派生批次计入 Σ买入，净持仓不再单独加回补量）
  // 暂记卖出（hedgedFromSellRow）不重复计入卖出量/金额/笔数——同一批股的另一种
  // 记账视角；其负盈利计入 profitCents（V9.26「暂记真实亏损」口径）
  const realSells = sells.filter((s) => s.hedgedFromSellRow === undefined)
  const totals = {
    rows: live.length,
    buyQty: sumBy(allLots, (l) => l.qty),
    buyAmountCents: sumBy(allLots, (l) => mulCents(l.buyPriceCents, l.qty)),
    sellCount: realSells.length,
    sellQty: sumBy(realSells, (s) => s.qty),
    sellAmountCents: sumBy(realSells, (s) => (s.priceCents === null ? 0 : mulCents(s.priceCents, s.qty))),
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
    /**
     * 空头挂单回补成交里的基础股部分：既抵了敞口、又以回补批次进了待卖，守恒式里要扣回防双算。
     * V9.33：按「这行的记录是不是裸卖」判定，不看 exposure 标记——部分买回 + 剩下的全挂住时，
     * exposure 已被置否，但买回那部分照样是空头回补基础股，不扣就会让守恒式亮红灯。
     * V9.36：已经把那截高位批次「永久了结」的，不再扣——批次份额已经不在待卖里，没有双算。
     */
    exposureExecBaseQty: (() => {
      let sum = 0
      for (const o of orders) {
        const parent=byRow.get(o.sourceRow)
        const sale=sells.find((s)=>s.id===o.sellExecId)
        if (parent?.soldLotId || (parent?.buyPriceCents!==null && !(sale?.ownLotCoverQty))) continue
        const base = Math.max(0, o.execQty - o.doneRewardQty)
        sum += Math.max(0, base - (hedgeClosedByRow.get(o.sourceRow) ?? 0))
      }
      return sum
    })(),
    rebuyRemainingQty: sumBy(orders, (o) => o.remainingQty),
    netQty: 0,
    // 只算真空头敞口：无买入批次、且还没回补掉的那部分（D5）。
    // 奖励股是额外买入，不算欠账；V9.26：挂住的份额已由高位批次交割，按差额计。
    exposureQty: sumBy(
      orders.filter((o) => o.exposure),
      (o) =>
        Math.max(
          0,
          o.baseQty -
            (hedgeAppliedByRow.get(o.sourceRow) ?? 0) -
            Math.max(0, o.execQty - o.doneRewardQty),
        ),
    ),
  }
  // 回补批次已在 Σ买入 里，净持仓 = Σ买入 − Σ卖出
  totals.netQty = totals.buyQty - totals.sellQty

  const byStock = summarizeByStock(live, allLots, sells, targets, orders, hedgeAppliedByRow)
  const monthly = summarizeMonthly(sells)
  const daily = summarizeDaily(sells)

  /**
   * 每组「已经买回来的奖励手数」（V9.33）：doneRewardQty 折手后按组汇总。
   * 组池因为盈利暂缓而消失时容量按 0 算——就是要让它亮出来。
   */
  const doneHandsByGroup = (() => {
    const m = new Map<string, number>()
    for (const o of orders) {
      if (o.doneRewardQty <= 0) continue
      m.set(o.groupKey, (m.get(o.groupKey) ?? 0) + Math.floor(o.doneRewardQty / 100))
    }
    return [...m.entries()].map(([groupKey, hands]) => ({
      groupKey,
      hands,
      capacity: groups.get(groupKey)?.capacityHands ?? 0,
    }))
  })()

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
    {
      /**
       * V9.33：已买回来的奖励股不可撤（P4），但组容量会因挂钩（盈利暂缓）等操作缩水。
       * 上面的检查只看「还打算发的手数」，这里补一条看「已经买回来的奖励股」——
       * 缩水到装不下时亮黄灯提醒，而不是继续全绿骗人。
       */
      name: 'Σ已买回的奖励手数 ≤ Σ组容量',
      ok: doneHandsByGroup.every((d) => d.hands <= d.capacity),
      actual: doneHandsByGroup.some((d) => d.hands > d.capacity)
        ? doneHandsByGroup
            .filter((d) => d.hands > d.capacity)
            .map((d) => `${d.groupKey} ${d.hands}/${d.capacity} 手`)
            .join(' · ')
        : `${sumBy(doneHandsByGroup, (d) => d.hands)} / ${sumBy(doneHandsByGroup, (d) => d.capacity)}`,
      expected: '已买回的奖励股不超该组容量',
    },
  ]

  return {
    lots: allLots,
    sells,
    targets,
    orders,
    buySplits,
    groups: [...groups.values()].sort((a, b) => b.grossProfitCents - a.grossProfitCents),
    byStock,
    daily,
    monthly,
    anomalies,
    checks,
    totals,
    repairChains,
  }
}

/**
 * 待买展示档（V9.50 用户拍板）：卖单拆多笔买入后，挂单页/概览只显示拆出来的档，
 * 记成交也按档位取价、取量。
 * - 没拆 = 整单一条（价格取计划价 > P 列）；
 * - 拆了 = 按 at 顺序分段，合计不得超过这张单的欠量（超出截断并标 buyTargetOverflow）；
 * - 已成交的量按档位顺序冲抵，后面的档位还剩多少就挂多少。
 */
function buildBuySplits(
  orders: RebuyOrder[],
  targets: readonly ExtraBuyTarget[],
  anomalies: Anomaly[],
): BuySplit[] {
  const bySell = new Map<number, ExtraBuyTarget[]>()
  for (const t of targets) {
    const list = bySell.get(t.sellRow)
    if (list) list.push(t)
    else bySell.set(t.sellRow, [t])
  }
  const out: BuySplit[] = []
  for (const o of orders) {
    const mine = (bySell.get(o.sourceRow) ?? []).slice().sort((a, b) => a.at - b.at)
    if (mine.length === 0) {
      out.push({
        key: o.id,
        orderId: o.id,
        sellExecId: o.sellExecId,
        sourceRow: o.sourceRow,
        stockName: o.stockName,
        priceCents: o.planPriceCents ?? o.rebuyPriceCents,
        qty: o.remainingQty,
        plannedQty: o.baseQty,
        executedQty: o.execQty,
        split: false,
        targetId: null,
      })
      continue
    }
    const cap = Math.max(0, o.baseQty)
    const total = mine.reduce((a, t) => a + t.qty, 0)
    if (total > cap) {
      anomalies.push({
        kind: 'buyTargetOverflow',
        sourceRow: o.sourceRow,
        stockName: o.stockName,
        detail: `拆分买单合计 ${total} 股 > 还没回补 ${cap} 股，已按欠量截断`,
      })
    }
    let planned = 0
    let execLeft = o.execQty
    const rows: BuySplit[] = []
    mine.forEach((t, i) => {
      const qty = Math.min(t.qty, Math.max(0, cap - planned))
      planned += qty
      const used = Math.min(qty, Math.max(0, execLeft))
      execLeft -= used
      rows.push({
        key: `${o.id}#${i + 1}`,
        orderId: o.id,
        sellExecId: o.sellExecId,
        sourceRow: o.sourceRow,
        stockName: o.stockName,
        priceCents: t.priceCents,
        qty: Math.max(0, qty - used),
        plannedQty: qty,
        executedQty: used,
        split: true,
        targetId: t.id,
      })
    })
    // 组池奖励股是额外买入，按最后一个拆分段的价格一起挂（总量才和整单 remainingQty 对齐）
    const rewardQty = Math.max(0, o.rewardQty - o.doneRewardQty)
    if (rewardQty > 0 && rows.length > 0) {
      const last = rows[rows.length - 1]
      const used = Math.min(rewardQty, Math.max(0, execLeft))
      last.qty += rewardQty - used
      last.plannedQty += rewardQty
      last.executedQty += used
    }
    out.push(...rows)
  }
  return out
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
  /** 每张裸卖挂住的股数（敞口按差额计，V9.26） */
  hedgeAppliedByRow: Map<number, number>,
): StockSummary[] {
  const names = [...new Set(records.map((r) => r.stockName))]
  return names.map((name) => {
    const ls = lots.filter((l) => l.stockName === name)
    const ss = sells.filter((s) => s.stockName === name)
    // 暂记卖出只贡献盈利，不重复计卖出量/金额/笔数（V9.26）
    const real = ss.filter((s) => s.hedgedFromSellRow === undefined)
    const ts = targets.filter((t) => t.stockName === name)
    const os = orders.filter((o) => o.stockName === name)
    return {
      stockId: ls[0]?.stockId ?? ss[0]?.stockId ?? stockIdOf(name),
      stockName: name,
      rows: records.filter((r) => r.stockName === name).length,
      buyQty: sumBy(ls, (l) => l.qty),
      buyAmountCents: sumBy(ls, (l) => mulCents(l.buyPriceCents, l.qty)),
      sellCount: real.length,
      sellQty: sumBy(real, (s) => s.qty),
      sellAmountCents: sumBy(real, (s) => (s.priceCents === null ? 0 : mulCents(s.priceCents, s.qty))),
      profitCents: sumBy(ss, (s) => s.profitCents ?? 0),
      targetCount: ts.length,
      targetQty: sumBy(ts, (t) => t.qty),
      targetAmountCents: sumBy(ts, (t) => t.amountCents),
      // V9.29：待卖最高目标价 = 股价涨到多少时待卖全部出清（概览「理想可卖到」的股价口径）
      targetMaxPriceCents: ts.length ? Math.max(...ts.map((t) => t.priceCents)) : null,
      expectProfitCents: sumBy(ts, (t) => t.expectProfitCents),
      rebuyCount: os.length,
      rebuyQty: sumBy(os, (o) => o.baseQty + o.rewardQty),
      // 与 totals 同口径：lots 已含回补批次（虚拟批次），净持仓 = Σ买入 − Σ卖出
      netQty: sumBy(ls, (l) => l.qty) - sumBy(real, (s) => s.qty),
      exposureQty: sumBy(
        os.filter((o) => o.exposure),
        (o) =>
          Math.max(
            0,
            o.baseQty -
              (hedgeAppliedByRow.get(o.sourceRow) ?? 0) -
              Math.max(0, o.execQty - o.doneRewardQty),
          ),
      ),
    }
  })
}

/** 按天聚合（日历和月度共用同一套卖出口径）；暂记卖出只把盈利记到当天，不重复计卖出量/笔数（V9.26） */
function summarizeDaily(sells: SellExecution[]): DayBucket[] {
  const map = new Map<string, DayBucket>()
  for (const s of sells) {
    const day = s.soldAt ?? '未填日期'
    let b = map.get(day)
    if (!b) {
      b = { day, sellCount: 0, sellQty: 0, profitCents: 0, dateMissing: day === '未填日期' }
      map.set(day, b)
    }
    if (s.hedgedFromSellRow === undefined) {
      b.sellCount += 1
      b.sellQty += s.qty
    }
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
    if (s.hedgedFromSellRow === undefined) {
      b.sellCount += 1
      b.sellQty += s.qty
      b.sellAmountCents += s.priceCents === null ? 0 : mulCents(s.priceCents, s.qty)
    }
    b.profitCents += s.profitCents ?? 0
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : 1))
}

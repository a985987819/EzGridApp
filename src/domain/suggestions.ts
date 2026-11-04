import type { BuySplit, GroupPool, Ledger, RawRecord, TradePlan } from './types'
import type { NextRoundBuyRow } from './buyBoard'

export type BuySource =
  | {
      kind: 'order'
      id: string
      qty: number
      row: number
      /** V9.50 拆分段身份（同一卖单拆出的两档不能混） */
      splitKey?: string
      /** V9.54：这笔来源是先卖后买（卖出日 ≤ 买入日 / 裸卖） */
      sellFirst?: boolean
      strategyMode?: 'repair' | 'baseT'
      strategyIsDefault?: true
      /** 本来源数量中由价位盈利支付的份额；只授整手，基础贡献优先。 */
      rewardQty?: number
      rewardGroupKey?: string
    }
  | { kind: 'next'; id: string; qty: number; row: number; rewardQty?: number; rewardGroupKey?: string }
export interface BuySuggestion {
  strategyMode?: 'repair' | 'baseT'
  strategyIsDefault?: true
  key: string
  stockName: string
  priceCents: number
  qty: number
  amountCents: number
  /** 所有改单应用前、当前仍可推荐的量与金额；碰撞合并按各原价累计。纯展示。 */
  originalQty?: number
  originalAmountCents?: number
  sources: BuySource[]
  /** 现有来源实际贡献的盈利奖励合计，已经包含在 qty 中。 */
  rewardQty?: number
  /** V9.53：这一条推荐被人工「改单」过（计划价/计划量只改显示，不动来源） */
  edited?: boolean
  /**
   * 这一条推荐里含「先卖后买」的来源，用于分组和界面标示。
   */
  sellFirst: boolean
  /**
   * V9.55：改单撞价合并后，这一条由哪几「条」组成（各自原来的行身份 + 当时自己的数量）。
   * 改单 / 清除改单要按份写回，否则合并行的另一半不跟着走（价格改了却只有半边动）。
   */
  members?: { key: string; qty: number }[]
  purpose?: 'cover' | 'optional'
  planRefs?: string[]
  legacyPlanConflict?: boolean
}
export function consumedNextRounds(records: readonly RawRecord[]): Map<number,number> {
  const out=new Map<number,number>()
  for(const r of records)if(!r.deletedAt && r.nextRoundOfRow!==undefined)out.set(r.nextRoundOfRow,(out.get(r.nextRoundOfRow)??0)+Math.max(0,(r.buyQtyRaw??0)-(r.profitRewardQty??0)))
  return out
}

const rewardOf = (source: BuySource): number => Math.max(0, Math.min(source.qty, source.rewardQty ?? 0))
/** 缩量先保留整行的基础来源，剩余空间才留整手奖励，不能把零碎奖励当基础股。 */
function clampBuySources(sources: readonly BuySource[], requestedQty: number): BuySource[] {
  const total = sources.reduce((sum, source) => sum + source.qty, 0)
  const limit = Math.max(0, Math.min(total, requestedQty))
  let baseLeft = Math.min(limit, sources.reduce((sum, source) => sum + source.qty - rewardOf(source), 0))
  const baseParts = sources.map(source => {
    const qty = Math.min(baseLeft, source.qty - rewardOf(source))
    baseLeft -= qty
    return qty
  })
  let rewardLeft = Math.max(0, limit - baseParts.reduce((sum, qty) => sum + qty, 0))
  return sources.flatMap((source, index) => {
    const rewardQty = Math.floor(Math.min(rewardLeft, rewardOf(source)) / 100) * 100
    rewardLeft -= rewardQty
    const qty = baseParts[index] + rewardQty
    if (qty <= 0) return []
    return [{ ...source, qty, ...(source.rewardQty !== undefined || source.rewardGroupKey ? { rewardQty } : {}) }]
  })
}

/** 最终改单价只能缩减已分配的奖励，不增加奖励；所有来源共用同一价组现金预算。 */
function capRewardCash(rows: BuySuggestion[], groups: readonly GroupPool[]): void {
  const cash = new Map(groups.map(group => {
    const available = group.grossProfitCents - group.usedProfitCents
    return [group.groupKey, Number.isSafeInteger(available) ? Math.max(0, available) : 0] as const
  }))
  const nextCash = new Map(groups.map(group => {
    const available = group.grossProfitCents - group.usedProfitCents
    // 下一轮只使用订单最初授予后留下的预算，不能挪用未展示或被缩量的订单份额。
    const reserve = group.grantedHands * 100 * group.rebuyPriceCents
    return [group.groupKey, Number.isSafeInteger(available) && Number.isSafeInteger(reserve) ? Math.max(0, available - reserve) : 0] as const
  }))
  const sources = rows.flatMap(row => row.sources.map(source => ({ row, source })))
  sources.sort((a, b) => Number(a.source.kind === 'next') - Number(b.source.kind === 'next'))
  for (const { row, source } of sources) {
    const rewardQty = rewardOf(source)
    if (rewardQty <= 0) continue
    const handCost = row.priceCents * 100
    const remaining = source.rewardGroupKey ? cash.get(source.rewardGroupKey) ?? 0 : 0
    const budget = source.kind === 'next' ? Math.min(remaining, source.rewardGroupKey ? nextCash.get(source.rewardGroupKey) ?? 0 : 0) : remaining
    const affordable = Number.isSafeInteger(handCost) && handCost > 0 ? Math.floor(budget / handCost) * 100 : 0
    const granted = Math.min(Math.floor(rewardQty / 100) * 100, affordable)
    source.qty -= rewardQty - granted
    source.rewardQty = granted
    if (source.rewardGroupKey) {
      const spent = granted * row.priceCents
      cash.set(source.rewardGroupKey, remaining - spent)
      if (source.kind === 'next') nextCash.set(source.rewardGroupKey, budget - spent)
    }
  }
  for (const row of rows) {
    row.sources = row.sources.filter(source => source.qty > 0)
    row.qty = row.sources.reduce((sum, source) => sum + source.qty, 0)
    row.amountCents = row.priceCents * row.qty
  }
}

/** 旧整单计划只在展示层缩量；同一母单多档共用一次上限，基础贡献优先。 */
function applyOrderPlanQuantities(splits: readonly BuySplit[], plans: readonly TradePlan[]): BuySplit[] {
  const byOrder = new Map<string, BuySplit[]>()
  for (const split of splits) {
    const list = byOrder.get(split.orderId) ?? []
    list.push(split)
    byOrder.set(split.orderId, list)
  }
  const quantityByKey = new Map<string, number>()
  for (const [orderId, rows] of byOrder) {
    const plan = plans.find(plan => plan.kind === 'buy' && plan.refId === orderId)
    if (!plan) continue
    const sources: BuySource[] = rows.map(split => ({ kind: 'order', id: split.orderId, row: split.sourceRow,
      splitKey: split.key, qty: split.qty, rewardQty: Math.max(0, split.qty - split.baseRemainingQty), rewardGroupKey: split.rewardGroupKey }))
    const kept = clampBuySources(sources, plan.qty)
    for (const split of rows) quantityByKey.set(split.key, 0)
    for (const source of kept) quantityByKey.set(source.kind === 'order' ? source.splitKey! : '', source.qty)
  }
  return splits.map(split => ({ ...split, qty: quantityByKey.get(split.key) ?? split.qty }))
}

/** 沙盒按拆档直接展示，沿用相同现金上限，但保留每档身份和基础可回补量。 */
export function capBuySplitRewardCash(splits: readonly BuySplit[], groups: readonly GroupPool[], plans: readonly TradePlan[] = []): BuySplit[] {
  const cash = new Map(groups.map(group => {
    const available = group.grossProfitCents - group.usedProfitCents
    return [group.groupKey, Number.isSafeInteger(available) ? Math.max(0, available) : 0] as const
  }))
  return applyOrderPlanQuantities(splits, plans).map(split => {
    const rewardQty = Math.max(0, split.qty - split.baseRemainingQty)
    if (rewardQty === 0) return { ...split }
    const handCost = split.priceCents * 100
    const budget = split.rewardGroupKey ? cash.get(split.rewardGroupKey) ?? 0 : 0
    const affordable = Number.isSafeInteger(handCost) && handCost > 0 ? Math.floor(budget / handCost) * 100 : 0
    const granted = Math.min(Math.floor(rewardQty / 100) * 100, affordable)
    if (split.rewardGroupKey) cash.set(split.rewardGroupKey, budget - granted * split.priceCents)
    return { ...split, qty: split.qty - rewardQty + granted }
  })
}
/** 挂单买入侧统一按最终价格从高到低排列。 */
export function compareBuyPrice(a: { priceCents: number }, b: { priceCents: number }): number {
  return b.priceCents - a.priceCents
}

/** 推荐行排序：最终价格降序 → key 兜底稳定。 */
function compareBuySuggestion(a: BuySuggestion, b: BuySuggestion): number {
  return compareBuyPrice(a, b) || a.key.localeCompare(b.key)
}
/**
 * 买入建议（V9.50）：输入改成「待买展示档」——卖单拆了几笔买入就按几档出建议，
 * 同价再合并（7.01 买 500 ×2 → 7.01 买 1000）。账务仍按 orderId 记成交。
 */
export function buildBuySuggestions(splits: readonly BuySplit[], next: readonly NextRoundBuyRow[], plans: readonly TradePlan[], groups?: readonly GroupPool[]): BuySuggestion[] {
  const rows=new Map<string,BuySuggestion>()
  const add=(stockName:string,p:number,source:BuySource,originalQty=source.qty,originalAmountCents=p*originalQty,orderPlanRef?:string)=>{
    const purpose = source.kind === 'order' && source.sellFirst ? 'cover' : 'optional'
    const strategyMode = source.kind === 'order' ? source.strategyMode : undefined
    const strategyIsDefault = source.kind === 'order' ? source.strategyIsDefault : undefined
    // 默认低位回本只补展示名，保留原推荐身份；显式策略继续独立。
    const identityMode = strategyIsDefault ? undefined : strategyMode
    const key=`buy:${purpose}:${stockName}:${p}${identityMode ? `:${identityMode}` : ''}`
    const hit=rows.get(key)
    if(hit){
      hit.qty+=source.qty
      hit.amountCents+=p*source.qty
      hit.originalQty=(hit.originalQty??0)+originalQty
      hit.originalAmountCents=(hit.originalAmountCents??0)+originalAmountCents
      if(source.qty>0)hit.sources.push(source)
      if(orderPlanRef){hit.edited=true;hit.planRefs=[...new Set([...(hit.planRefs??[]),orderPlanRef])]}
      // 同价合并后只要有一笔先卖后买，整条就按先卖后买分组/标示。
      if(source.kind==='order'&&source.sellFirst)hit.sellFirst=true
    }
    else rows.set(key,{key,stockName,priceCents:p,qty:source.qty,amountCents:p*source.qty,originalQty,originalAmountCents,sources:source.qty>0?[source]:[],purpose,strategyMode,strategyIsDefault,sellFirst:purpose==='cover',...(orderPlanRef?{edited:true,planRefs:[orderPlanRef]}:{})})
  }
  const plannedSplits=applyOrderPlanQuantities(splits,plans)
  for(let index=0;index<plannedSplits.length;index++){
    const b=plannedSplits[index],original=splits[index]
    if(original.qty<=0)continue
    const rewardQty=Math.max(0,b.qty-b.baseRemainingQty)
    add(b.stockName,b.priceCents,{kind:'order',id:b.orderId,row:b.sourceRow,qty:b.qty,splitKey:b.key,sellFirst:b.sellFirst===true,strategyMode:b.strategyMode,strategyIsDefault:b.strategyIsDefault,
      ...(rewardQty>0?{rewardQty,rewardGroupKey:b.rewardGroupKey}:{})},original.qty,(original.originalPriceCents??original.priceCents)*original.qty,
      plans.some(plan=>plan.kind==='buy'&&plan.refId===b.orderId)?b.orderId:undefined)
  }
  for(const n of next) {
    const plan=plans.find((p)=>p.kind==='buy'&&p.refId===n.key)
    let originalQty=n.qty
    // next 单行通常是一笔；合并来源的额度由 store 根据最新账本再次分配。
    const sources=n.rows.map((row):BuySource=>{
      const rewardQty=n.sourceRewardQty?.[row]??0
      return {kind:'next',id:n.key,row,qty:(n.sourceQty?.[row]??n.baseQty??n.qty)+rewardQty,...(rewardQty>0?{rewardQty,rewardGroupKey:n.rewardGroupKey}:{})}
    })
    for(const source of clampBuySources(sources,Math.min(n.qty,plan?.qty??n.qty))){
      add(n.stockName,plan?.priceCents??n.priceCents,source,originalQty,n.priceCents*originalQty)
      originalQty=0
    }
  }
  const out=[...rows.values()]
  /**
   * V9.53 硬改推荐行：用户直接改「这一条推荐挂单」的价格/数量，但不许改推荐来源。
   * 计划挂在建议行身份 `buy:股票:派生价`（行 key 本身）上，只影响这一行的显示、
   * 区间判断、复制/CSV 与记成交默认值——不写 records、不改 orders，也不进任何账务计算。
   * 数量只能往下夹，避免显示一个记不进去的量。
   */
  for(const r of out) {
    const legacyRef = `buy:${r.stockName}:${r.priceCents}`
    const legacy = plans.find(p => p.kind === 'buy' && p.refId === legacyRef)
    const ambiguous = out.some(other => other !== r && other.stockName === r.stockName && other.priceCents === r.priceCents && other.purpose !== r.purpose)
    const specific=plans.find((p)=>p.kind==='buy'&&p.refId===r.key)
    const acceptsLegacy = !ambiguous && (!r.strategyMode || r.strategyIsDefault)
    const plan=specific ?? (acceptsLegacy ? legacy : undefined)
    r.planRefs = [...new Set([...(r.planRefs??[]),r.key, ...(acceptsLegacy && legacy ? [legacyRef] : [])])]
    r.legacyPlanConflict = ambiguous && Boolean(legacy) && !specific
    if(!plan)continue
    r.priceCents=plan.priceCents
    r.edited=true
    r.sources=clampBuySources(r.sources,Math.min(r.qty,plan.qty))
    r.qty=r.sources.reduce((sum,source)=>sum+source.qty,0)
    r.amountCents=plan.priceCents*r.qty
  }
  if(groups)capRewardCash(out,groups)
  // 用当前每份的实际贡献作为再次改单的比例，打开后原样保存不会重新挪动来源。
  for(const r of out) r.members=[{key:r.key,qty:r.qty}]
  /**
   * V9.55：**改单之后撞价的要再合一次**。上面第一次合并是按「派生价」合的，改单把两档
   * 改到同一个价位之后就成了两行同价同类型的挂单——既难看也容易点错。这里按
   * （股票 + 最终价）重新归组：数量相加、金额按最终价重算，**来源各自留着**
   * （改单不动来源，`sources` 一条都不少，界面上分开列）。
   * 行身份优先留「本来就落在这个价」的那条（`buy:股票:价`），没有就沿用第一条——
   * 计划是按 key 挂的，身份稳定才不会出现「改完一刷新又变回去」的抖动。
   */
  const byPrice = new Map<string, BuySuggestion>()
  const originalByPrice = new Map<string, { qty: number; amountCents: number }>()
  const bucketOf = (r: BuySuggestion) => `${r.purpose}|${r.strategyIsDefault ? '' : r.strategyMode ?? ''}|${r.stockName}|${r.priceCents}`
  for (const r of out) {
    const bucket = bucketOf(r)
    const original = originalByPrice.get(bucket) ?? { qty: 0, amountCents: 0 }
    original.qty += r.originalQty ?? 0
    original.amountCents += r.originalAmountCents ?? 0
    originalByPrice.set(bucket, original)
    if (r.qty <= 0) continue
    const hit = byPrice.get(bucket)
    if (!hit) {
      byPrice.set(bucket, r)
      continue
    }
    const natural = `buy:${r.purpose}:${r.stockName}:${r.priceCents}`
    hit.qty += r.qty
    hit.amountCents = hit.priceCents * hit.qty
    hit.sources.push(...r.sources)
    if (r.members) hit.members = [...(hit.members ?? []), ...r.members]
    hit.planRefs = [...new Set([...(hit.planRefs ?? []), ...(r.planRefs ?? [])])]
    hit.legacyPlanConflict ||= r.legacyPlanConflict
    if (r.sellFirst) hit.sellFirst = true
    if (r.edited) hit.edited = true
    if (hit.key !== natural && r.key === natural) hit.key = natural
  }
  const list = [...byPrice.values()]
  for(const r of list) {
    const original = originalByPrice.get(bucketOf(r))!
    r.originalQty = original.qty
    r.originalAmountCents = original.amountCents
    const rewardQty=r.sources.reduce((sum,source)=>sum+rewardOf(source),0)
    if(rewardQty>0||r.sources.some(source=>source.rewardQty!==undefined))r.rewardQty=rewardQty
  }
  // 改单和同价合并完成后再排序，确保使用实际显示价格。
  return list.sort(compareBuySuggestion)
}
/** 明细是按行聚合的视图，必须累计全部成交，不能 Map 覆盖上一笔。 */
export function sellsByRecord(ledger: Ledger) {
  const out=new Map<number,Ledger['sells'][number]>()
  for(const s of ledger.sells) {
    const prior=out.get(s.sourceRow)
    if(!prior){out.set(s.sourceRow,{...s});continue}
    const q=prior.qty+s.qty
    out.set(s.sourceRow,{...prior,qty:q,profitCents:prior.profitCents===null&&s.profitCents===null?null:(prior.profitCents??0)+(s.profitCents??0),
      priceCents:prior.priceCents===null||s.priceCents===null?null:Math.round((prior.priceCents*prior.qty+s.priceCents*s.qty)/q),
      rebuyStatus:prior.rebuyStatus==='pending'||s.rebuyStatus==='pending'?'pending':'repaid',
      hedgeClosed:Boolean(prior.hedgeClosed||s.hedgeClosed),soldAt:(prior.soldAt??'')>(s.soldAt??'')?prior.soldAt:s.soldAt})
  }
  return out
}

/**
 * V9.58 挂单页三组：把买入建议切成「应该买入」和「锦上添花」。
 *
 * 应该买入 = 先卖后买（卖出拿回来的钱就欠着这些股）**或带空头敞口**（超卖那截是真空头，
 * 不能因为不是 sellFirst 就躲进锦上添花）；其余 = 已完成批次的下一轮应买 + 先买后卖行里
 * P 列填了价的待回补（「P 列再买」）——那些是拿这一轮的钱再投一轮，属于锦上添花。
 * `exposedOrderIds` 由调用方从 `ledger.orders` 里筛 `exposure` 的订单 id 传进来
 * （suggestions 层看不到订单对象，只认 id）。
 */
export function splitBuySuggestions(
  suggestions: readonly BuySuggestion[],
  exposedOrderIds: ReadonlySet<string>,
): { mustBuy: BuySuggestion[]; bonus: BuySuggestion[] } {
  const mustBuy: BuySuggestion[] = []
  const bonus: BuySuggestion[] = []
  for (const r of suggestions) {
    const exposed = r.sources.some((s) => s.kind === 'order' && exposedOrderIds.has(s.id))
    ;(r.sellFirst || exposed ? mustBuy : bonus).push(r)
  }
  return { mustBuy, bonus }
}

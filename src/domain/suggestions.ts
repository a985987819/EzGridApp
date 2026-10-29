import type { BuySplit, Ledger, RawRecord, TradePlan } from './types'
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
    }
  | { kind: 'next'; id: string; qty: number; row: number }
export interface BuySuggestion {
  key: string
  stockName: string
  priceCents: number
  qty: number
  amountCents: number
  sources: BuySource[]
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
  for(const r of records)if(!r.deletedAt && r.nextRoundOfRow!==undefined)out.set(r.nextRoundOfRow,(out.get(r.nextRoundOfRow)??0)+(r.buyQtyRaw??0))
  return out
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
export function buildBuySuggestions(splits: readonly BuySplit[], next: readonly NextRoundBuyRow[], plans: readonly TradePlan[]): BuySuggestion[] {
  const rows=new Map<string,BuySuggestion>()
  const add=(stockName:string,p:number,source:BuySource)=>{
    if(source.qty<=0)return
    const purpose = source.kind === 'order' && source.sellFirst ? 'cover' : 'optional'
    const key=`buy:${purpose}:${stockName}:${p}`
    const hit=rows.get(key)
    if(hit){
      hit.qty+=source.qty
      hit.amountCents+=p*source.qty
      hit.sources.push(source)
      // 同价合并后只要有一笔先卖后买，整条就按先卖后买分组/标示。
      if(source.kind==='order'&&source.sellFirst)hit.sellFirst=true
    }
    else rows.set(key,{key,stockName,priceCents:p,qty:source.qty,amountCents:p*source.qty,sources:[source],purpose,sellFirst:purpose==='cover'})
  }
  for(const b of splits)if(b.qty>0)add(b.stockName,b.priceCents,{kind:'order',id:b.orderId,row:b.sourceRow,qty:b.qty,splitKey:b.key,sellFirst:b.sellFirst===true})
  for(const n of next) {
    const plan=plans.find((p)=>p.kind==='buy'&&p.refId===n.key)
    let left=Math.min(n.qty,plan?.qty??n.qty)
    // next 单行通常是一笔；合并来源的额度由 store 根据最新账本再次分配。
    for(const row of n.rows){if(left<=0)break;const qty=Math.min(left,n.sourceQty?.[row]??n.qty);add(n.stockName,plan?.priceCents??n.priceCents,{kind:'next',id:n.key,row,qty});left-=qty}
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
    const plan=specific ?? (!ambiguous ? legacy : undefined)
    r.planRefs = [r.key, ...(!ambiguous && legacy ? [legacyRef] : [])]
    r.legacyPlanConflict = ambiguous && Boolean(legacy) && !specific
    if(!plan)continue
    r.qty=Math.min(r.qty,plan.qty)
    r.priceCents=plan.priceCents
    r.amountCents=plan.priceCents*r.qty
    r.edited=true
    let left = r.qty
    r.sources = r.sources.flatMap(source => {
      const qty = Math.min(left, source.qty)
      left -= qty
      return qty > 0 ? [{ ...source, qty }] : []
    })
  }
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
  for (const r of out) {
    if (r.qty <= 0) continue
    const bucket = `${r.purpose}|${r.stockName}|${r.priceCents}`
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

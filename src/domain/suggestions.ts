import type { BuySplit, Ledger, RawRecord, TradePlan } from './types'
import type { NextRoundBuyRow } from './buyBoard'

export type BuySource =
  | { kind: 'order'; id: string; qty: number; row: number; /** V9.50 拆分段身份（同一卖单拆出的两档不能混） */ splitKey?: string }
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
}
export function consumedNextRounds(records: readonly RawRecord[]): Map<number,number> {
  const out=new Map<number,number>()
  for(const r of records)if(!r.deletedAt && r.nextRoundOfRow!==undefined)out.set(r.nextRoundOfRow,(out.get(r.nextRoundOfRow)??0)+(r.buyQtyRaw??0))
  return out
}
/**
 * 买入建议（V9.50）：输入改成「待买展示档」——卖单拆了几笔买入就按几档出建议，
 * 同价再合并（7.01 买 500 ×2 → 7.01 买 1000）。账务仍按 orderId 记成交。
 */
export function buildBuySuggestions(splits: readonly BuySplit[], next: readonly NextRoundBuyRow[], plans: readonly TradePlan[]): BuySuggestion[] {
  const rows=new Map<string,BuySuggestion>()
  const add=(stockName:string,p:number,source:BuySource)=>{
    if(source.qty<=0)return
    const key=`buy:${stockName}:${p}`
    const hit=rows.get(key)
    if(hit){hit.qty+=source.qty;hit.amountCents+=p*source.qty;hit.sources.push(source)}
    else rows.set(key,{key,stockName,priceCents:p,qty:source.qty,amountCents:p*source.qty,sources:[source]})
  }
  for(const b of splits)if(b.qty>0)add(b.stockName,b.priceCents,{kind:'order',id:b.orderId,row:b.sourceRow,qty:b.qty,splitKey:b.key})
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
    const plan=plans.find((p)=>p.kind==='buy'&&p.refId===r.key)
    if(!plan)continue
    r.qty=Math.min(r.qty,plan.qty)
    r.priceCents=plan.priceCents
    r.amountCents=plan.priceCents*r.qty
    r.edited=true
  }
  return out.filter((r)=>r.qty>0).sort((a,b)=>a.priceCents-b.priceCents)
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

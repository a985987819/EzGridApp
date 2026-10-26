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
  return [...rows.values()].sort((a,b)=>a.priceCents-b.priceCents)
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

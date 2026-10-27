/**
 * 挂单按股票和有效售价自动汇总，保留每个来源实际贡献的数量。
 * merges 仅兼容旧关联与计划引用；解除手工关联不再取消同价自动汇总。
 */
import type { Lot, LotMergeLink, SellTarget, TradePlan } from './types'

/** 挂单页待卖清单的一行：可能是单笔，也可能是合并组里同一价位的几笔 */
export interface TargetRow {
  /** 单笔 = target id；合并 = merge:<组 id>|<目标价>（计划价也挂在这个 ref 上） */
  key: string
  targets: SellTarget[]
  /** 成员批次行号（合并行是全部贡献者；单笔行是 0~1 个） */
  lotRows: number[]
  lotIds: string[]
  priceCents: number
  qty: number
  amountCents: number
  expectProfitCents: number
  /** 是否真的合并了 ≥2 笔 */
  merged: boolean
  /** 点击 / data-row 用：合并行取最早买入的那笔 */
  anchorRow: number
  /** 合并后取最早的买入日期（YYYY-MM-DD） */
  earliestBuyDate: string | null
  buyPriceCents: number | null
  planPriceCents: number | null
  planQty: number | null
  /**
   * V9.55：这条行**读过哪些计划 refId**（包括改价后继续追的那串 `sell:股票:价`）。
   * 「清除改单」要按这张清单逐个删——行 key 是当前价派生的，改完价就换身份了，
   * 只删当前 key 会删不到任何东西（按钮点了没反应）。
   */
  planRefs: string[]
  sandbox: boolean
}

/** 行号 → 合并组：只有「还有 ≥2 笔在卖」的组才返回 */
export function activeMergeGroupOf(
  merges: readonly LotMergeLink[],
  lots: readonly Lot[],
): Map<number, LotMergeLink> {
  const lotByRow = new Map<number, Lot>()
  for (const l of lots) {
    if (l.id !== `lot:${l.sourceRow}`) continue
    if (l.remainingQty <= 0) continue
    lotByRow.set(l.sourceRow, l)
  }
  const byRow = new Map<number, LotMergeLink>()
  for (const m of merges) {
    const members = m.rows
      .map((r) => lotByRow.get(r))
      .filter(
        (l): l is Lot => Boolean(l && l.stockName === m.stockName && l.buyPriceCents === m.priceCents),
      )
    if (members.length < 2) continue
    for (const l of members) byRow.set(l.sourceRow, m)
  }
  return byRow
}

/** 比日期：空值排最后 */
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a <= b ? a : b
}

export function mergeTargetRows(opts: {
  targets: readonly SellTarget[]
  lots: readonly Lot[]
  merges: readonly LotMergeLink[]
  plans?: readonly TradePlan[]
  /** 沙盒模拟行（300000 段）：永远不参与合并 */
  sandboxRows?: ReadonlySet<number>
}): TargetRow[] {
  const { targets, lots, merges, plans = [], sandboxRows } = opts
  const byId = new Map(lots.map((l)=>[l.id,l]))
  const groups = activeMergeGroupOf(merges,lots)
  const groupBudget = new Map<string, number>()
  const rows: TargetRow[]=[]
  for(const t of targets) {
    const l=byId.get(t.lotId)
    if(!l || l.remainingQty<=0) continue
    const sandbox=Boolean(sandboxRows?.has(l.sourceRow))
    const legacy=groups.get(l.sourceRow)
    const ref=legacy ? `${legacy.id}@${t.priceCents}` : t.id
    const autoRef=`sell:${t.stockName}:${t.priceCents}`
    const singlePlan=plans.find((p)=>p.kind==='sell' && p.refId===t.id)
    const groupPlans: TradePlan[]=[]
    const groupPlan=plans.find((p)=>p.kind==='sell' && p.refId===autoRef) ??
      (ref!==t.id ? plans.find((p)=>p.kind==='sell' && p.refId===ref) : undefined)
    if(groupPlan)groupPlans.push(groupPlan)
    let p=groupPlan?.priceCents ?? singlePlan?.priceCents ?? t.planPriceCents ?? t.priceCents
    // 计划改价后可能与另一档合并；随后对这档设置的更新计划也必须覆盖所有来源。
    for(let i=0;i<plans.length;i++) {
      const next=plans.find((v)=>v.kind==='sell' && v.refId===`sell:${t.stockName}:${p}` &&
        !groupPlans.includes(v) && v.at>=(groupPlans.at(-1)?.at??0))
      if(!next)break
      groupPlans.push(next)
      p=next.priceCents
    }
    let q=Math.min(t.qty,singlePlan?.qty ?? t.planQty ?? t.qty)
    // 先限制来源组，再按有效价格归组；不能让组限量吞掉同价的其它批次。
    for(const plan of groupPlans)q=Math.min(q,groupBudget.get(plan.refId)??plan.qty)
    if(q<=0)continue
    for(const plan of groupPlans)groupBudget.set(plan.refId,(groupBudget.get(plan.refId)??plan.qty)-q)
    const hasPlan=groupPlans.length>0 || Boolean(singlePlan) || t.planPriceCents!=null
    const key=sandbox ? t.id : `sell:${t.stockName}:${p}`
    /** V9.55：这条行用到的计划身份（单个来源的计划 + 沿价格追下去的整串） */
    const rowPlanRefs=[...(singlePlan?[t.id]:[]),...groupPlans.map((x)=>x.refId)]
    const hit=rows.find((r)=>r.key===key)
    if(hit) {
      hit.targets.push({...t,qty:q}); hit.lotIds.push(t.lotId)
      if(!hit.lotRows.includes(l.sourceRow))hit.lotRows.push(l.sourceRow)
      hit.qty+=q;hit.amountCents+=p*q;hit.expectProfitCents+=(p-l.buyPriceCents)*q
      if(l.buyDate && (!hit.earliestBuyDate || l.buyDate<hit.earliestBuyDate || (l.buyDate===hit.earliestBuyDate && l.sourceRow<hit.anchorRow)))hit.anchorRow=l.sourceRow
      hit.earliestBuyDate=earlier(hit.earliestBuyDate,l.buyDate)
      hit.merged=true
      if(hasPlan)hit.planPriceCents=p
      if(hit.buyPriceCents!==l.buyPriceCents)hit.buyPriceCents=null
      for(const ref of rowPlanRefs)if(!hit.planRefs.includes(ref))hit.planRefs.push(ref)
    } else rows.push({key,targets:[{...t,qty:q}],lotRows:[l.sourceRow],lotIds:[l.id],priceCents:p,qty:q,amountCents:p*q,
      expectProfitCents:(p-l.buyPriceCents)*q,merged:false,anchorRow:l.sourceRow,earliestBuyDate:l.buyDate,
      buyPriceCents:l.buyPriceCents,planPriceCents:hasPlan ? p : null,planQty:null,planRefs:rowPlanRefs,sandbox})
  }
  for(const r of rows) {
    const legacy=groups.get(r.lotRows[0])
    const sameOriginalPrice=r.targets.every((t)=>t.priceCents===r.targets[0].priceCents)
    r.key=r.merged && sameOriginalPrice && legacy && r.lotRows.every((row)=>groups.get(row)?.id===legacy.id)
      ? `${legacy.id}@${r.targets[0].priceCents}` : r.merged ? `sell:${r.targets[0].stockName}:${sameOriginalPrice?r.targets[0].priceCents:r.priceCents}` : r.targets[0].id
    r.amountCents=r.priceCents*r.qty
    let left=r.qty
    r.expectProfitCents=0
    for(const t of r.targets){const q=Math.min(left,t.qty);t.qty=q;r.expectProfitCents+=(r.priceCents-(byId.get(t.lotId)?.buyPriceCents??r.priceCents))*q;left-=q}
    r.targets=r.targets.filter((t)=>t.qty>0)
    if(r.planPriceCents!==null)r.planQty=r.qty
  }
  // 同一原价可能被各笔计划拆到多个新价，行身份必须与实际汇总档一一对应。
  const keyCounts=new Map<string,number>()
  for(const r of rows)keyCounts.set(r.key,(keyCounts.get(r.key)??0)+1)
  for(const r of rows)if((keyCounts.get(r.key)??0)>1)r.key=`sell:${r.targets[0].stockName}:${r.priceCents}`
  return rows.filter((r)=>r.qty>0).sort((a,b)=>a.priceCents-b.priceCents || a.key.localeCompare(b.key))
}

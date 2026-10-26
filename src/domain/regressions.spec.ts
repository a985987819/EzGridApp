import { describe,it,expect } from 'vitest'
import {buildLedger} from './ledger'
import {buildNextRoundBuyRows} from './buyBoard'
import {buildBuySuggestions,consumedNextRounds,sellsByRecord} from './suggestions'
import {mergeTargetRows} from './merge'
import {validateExecutionInput,activeDependents} from './dependencies'
import {planImport} from './importPlan'
import {limitRange,inRange} from './limit'
import type {RawRecord,RebuyExecution,StockConfig,HedgeLink} from './types'
const stock:StockConfig={id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'}
function rec(row:number,o:Partial<RawRecord>={}):RawRecord{return {sourceRow:row,stockName:'T',buyDateSerial:46000,buyPriceCents:null,buyQtyRaw:null,qtyNeedsDerive:false,targetPriceCents:null,targetNeedsDerive:false,soldQty:0,sellDateSerial:46010,earlyBuyPriceCents:null,rawProfitCents:null,importKey:'k'+row,...o}}
const buy=(row:number,p:number,q:number)=>rec(row,{buyPriceCents:p,buyQtyRaw:q,targetPriceCents:p+200})
const sell=(row:number,p:number,q:number)=>rec(row,{buyDateSerial:null,targetPriceCents:p,soldQty:q,earlyBuyPriceCents:p-200})
const ex=(row:number,q:number,p:number,id='e',at=1):RebuyExecution=>({id,orderId:`rb:sell:${row}`,sellExecId:`sell:${row}`,stockId:stock.id,stockName:'T',qty:q,priceCents:p,rewardQty:0,groupKeyAtExecution:`${stock.id}|${p}`,at})
const hedge:HedgeLink={id:'hedge:9',sellRow:9,items:[{row:2,qty:500}],at:1}
const sold=(row:number,lotId:string,p:number,q:number)=>rec(row,{soldLotId:lotId,buyPriceCents:500,buyDateSerial:46020,targetPriceCents:p,soldQty:q,sellDateSerial:46030,earlyBuyPriceCents:500})
const rows=[buy(2,1000,500),sell(9,700,500)]
const flat=(l:ReturnType<typeof buildLedger>)=>expect(l.checks.filter((k)=>!k.ok)).toEqual([])

describe('记账完整性回归',()=>{
 it('同 Excel 行号的不同买单分配新内部 ID，保留原行号和旧关联',()=>{
  const old=buy(2,1000,500);const incoming=buy(2,600,500)
  const plan=planImport([old],[incoming,buy(3,500,500)])
  expect(plan.fresh.map((r)=>r.sourceRow)).toEqual([4,3]);expect(plan.fresh.map((r)=>r.excelRow)).toEqual([2,3])
  const again=planImport([old,...plan.fresh],[incoming,buy(3,500,500)])
  expect(again.fresh).toEqual([]);expect(again.updates).toEqual([])
 })
 it('原高位亏损挂住、尚未回补即建链',()=>{
  const l=buildLedger(rows,[stock],{hedges:[hedge]})
  expect(l.repairChains[0]).toMatchObject({lossCents:-150000,holdingQty:0,plannedQty:500});flat(l)
 })
 it('只卖一部分也建立已卖份额的亏损链',()=>{
  const l=buildLedger([rec(2,{buyPriceCents:1000,buyQtyRaw:1000,targetPriceCents:700,soldQty:500})],[stock])
  expect(l.repairChains[0]).toMatchObject({anchorQty:500,lossCents:-150000});expect(l.totals.netQty).toBe(500);flat(l)
 })
 it('一笔卖出挂两个锚点：1000 股回补只能分配成 500+500',()=>{
  const l=buildLedger([buy(2,1000,500),buy(3,1200,500),sell(9,700,1000)],[stock],{hedges:[{...hedge,items:[{row:2,qty:500},{row:3,qty:500}]}],executions:[ex(9,1000,500)]})
  expect(l.repairChains.map((c)=>c.holdingQty)).toEqual([500,500]);expect(l.repairChains.map((c)=>c.lossCents)).toEqual([-150000,-250000]);flat(l)
 })
 it('回补批次部分卖出不复制买入，盈利只计一次',()=>{
  const l=buildLedger([...rows,sold(10,'lot:exec:e',700,200)],[stock],{hedges:[hedge],executions:[ex(9,500,500)]})
  expect(l.totals).toMatchObject({netQty:300,targetQty:300,profitCents:-110000,buyQty:1000})
  expect(l.repairChains[0]).toMatchObject({holdingQty:300,profitCents:40000,gapCents:110000});flat(l)
 })
 it('回补后卖光，再次买回、再次卖出，整条链和库存连续守恒',()=>{
  const records=[...rows,sold(10,'lot:exec:e',700,500),sold(11,'lot:exec:e2',700,500)]
  const l=buildLedger(records,[stock],{hedges:[hedge],executions:[ex(9,500,500),ex(10,500,500,'e2',2)]})
  expect(l.totals).toMatchObject({netQty:0,targetQty:0,profitCents:50000})
  expect(l.repairChains[0]).toMatchObject({holdingQty:0,profitCents:200000,netCents:50000,done:true});flat(l)
 })
 it('同一回补分两条链后再部分卖出，每份利润只进一个链',()=>{
  const l=buildLedger([buy(2,1000,500),buy(3,1200,500),sell(9,700,1000),sold(10,'lot:exec:e',700,600)],[stock],{hedges:[{...hedge,items:[{row:2,qty:500},{row:3,qty:500}]}],executions:[ex(9,1000,500)]})
  expect(l.repairChains.map((c)=>c.profitCents)).toEqual([100000,20000]);expect(l.repairChains.map((c)=>c.holdingQty)).toEqual([0,400]);flat(l)
 })
 it('成员批次再次回补后，持仓自动继承原链',()=>{
  const member={...buy(3,500,500),soldQty:500,targetPriceCents:700,earlyBuyPriceCents:500}
  const l=buildLedger([{...buy(2,1000,500),soldQty:500,targetPriceCents:700},member],[stock],{executions:[ex(3,500,500)],chainLinks:[{id:'c2',anchorRow:2,stockName:'T',memberRows:[3],closedAt:null,at:1}]})
  expect(l.repairChains[0]).toMatchObject({holdingQty:500,profitCents:100000});flat(l)
 })
 it('软删后续卖出恢复其父批次库存，恢复卖出后重新扣减',()=>{
  const sale=sold(10,'lot:exec:e',700,500)
  const opts={hedges:[hedge],executions:[ex(9,500,500)]}
  expect(buildLedger([...rows,{...sale,deletedAt:1}],[stock],opts).totals.netQty).toBe(500)
  expect(buildLedger([...rows,sale],[stock],opts).totals.netQty).toBe(0)
 })
 it('同一高位行多笔挂钩的明细盈利等于总账',()=>{
  const l=buildLedger([buy(2,1000,1000),sell(9,700,500),sell(10,600,500)],[stock],{hedges:[hedge,{...hedge,id:'hedge:10',sellRow:10,at:2}]})
  expect(sellsByRecord(l).get(2)?.profitCents).toBe(-350000);flat(l)
 })
 it('回补完成后明细不再显示待回补',()=>{
  const l=buildLedger(rows,[stock],{hedges:[hedge],executions:[ex(9,500,500)]})
  expect(l.sells.find((s)=>s.sourceRow===9)?.rebuyStatus).toBe('repaid')
 })
})
describe('成交边界',()=>{
 it('奖励股数和基础股数分开校验，拒绝负数和非整手',()=>{
  expect(()=>validateExecutionInput(500,500,-100,500,100)).toThrow()
  expect(()=>validateExecutionInput(500,500,50,500,100)).toThrow()
  expect(()=>validateExecutionInput(500,500,200,500,100)).toThrow()
  expect(()=>validateExecutionInput(500,500,0,600,100)).not.toThrow()
  expect(()=>validateExecutionInput(600,500,0,600,100)).toThrow()
  expect(()=>validateExecutionInput(600,500,100,600,100)).not.toThrow()
 })
 it('部分补买入300、卖出500，欠200股进入敞口并保持守恒',()=>{
  const l=buildLedger([rec(2,{buyPriceCents:500,buyQtyRaw:300,buyDateSerial:46020,targetPriceCents:700,soldQty:500,sellDateSerial:46010,earlyBuyPriceCents:400})],[stock])
  expect(l.totals.netQty).toBe(-200);expect(l.totals.exposureQty).toBe(200);flat(l)
 })
 it('已结束的链不自动收进结束后的新回补',()=>{
  const l=buildLedger(rows,[stock],{hedges:[hedge],executions:[ex(9,500,500,'e',20)],chainLinks:[{id:'c2',anchorRow:2,stockName:'T',memberRows:[],closedAt:10,at:1}]})
  expect(l.repairChains[0].holdingQty).toBe(0)
 })
 it('撤销依赖包含真实批次卖出和回补批次卖出',()=>{
  const descendants=[sold(10,'lot:2',700,200),sold(11,'lot:exec:e',700,200)]
  expect(activeDependents(2,descendants,[ex(2,500,500)])).toHaveLength(2)
 })
 it('手工组加同价第三笔仍全部自动合并',()=>{
  const records=[2,3,4].map((r)=>({...buy(r,500,500),soldQty:500}))
  const l=buildLedger(records,[stock])
  const next=buildNextRoundBuyRows({...l,merges:[{id:'m',stockName:'T',priceCents:500,rows:[2,3],at:1}]})
  expect(next).toHaveLength(1);expect(next[0].qty).toBe(1500)
 })
})
describe('挂单建议回归',()=>{
 it('空目标买单按间隔推导，成交价缺失仍不捏造成交',()=>{
  const l=buildLedger([rec(2,{buyPriceCents:500,buyQtyRaw:500}),rec(3,{buyPriceCents:500,buyQtyRaw:500,soldQty:500})],[stock])
  expect(l.targets[0]).toMatchObject({priceCents:700,qty:500});expect(l.sells[0].priceCents).toBeNull()
 })
 it('导入裸卖缺 P 时推导买回建议，明确已回补则不推导',()=>{
  expect(buildLedger([{...sell(9,700,500),earlyBuyPriceCents:null}],[stock]).orders[0].rebuyPriceCents).toBe(500)
  expect(buildLedger([{...sell(9,700,500),earlyBuyPriceCents:null,rebuyPriceSource:'repaid'}],[stock]).orders).toEqual([])
 })
 it('不同成本的卖单同价自动汇总，保留原始批次',()=>{
  const l=buildLedger([buy(2,500,500),{...buy(3,600,300),targetPriceCents:700}],[stock])
  expect(mergeTargetRows({...l,merges:[]})[0]).toMatchObject({qty:800,priceCents:700,expectProfitCents:130000})
 })
 it('同价待回补和下一轮建议汇总，金额包含所有建议',()=>{
  const l=buildLedger([sell(9,700,500),{...buy(2,500,300),soldQty:300}],[stock])
  const next=buildNextRoundBuyRows({...l,merges:[]})
  const board=buildBuySuggestions(l.orders,next,[])
  expect(board[0]).toMatchObject({qty:l.orders[0].remainingQty+300,amountCents:500*(l.orders[0].remainingQty+300)});expect(board[0].sources).toHaveLength(2)
 })
 it('下一轮成交部分消耗建议，软删买入后额度恢复',()=>{
  const anchor={...buy(2,500,500),soldQty:500}
  const partial={...buy(10,500,200),nextRoundOfRow:2}
  const records=[anchor,partial];const l=buildLedger(records,[stock])
  expect(buildNextRoundBuyRows({...l,merges:[],consumed:consumedNextRounds(records)})[0].qty).toBe(300)
  expect(buildNextRoundBuyRows({...l,merges:[],consumed:consumedNextRounds([anchor,{...partial,deletedAt:1}])})[0].qty).toBe(500)
 })
 it('已回补后是否继续给下一轮建议仍沿用现有规则',()=>{
  const records=[{...buy(2,1000,500),targetPriceCents:700,soldQty:500,earlyBuyPriceCents:500}]
  const l=buildLedger(records,[stock],{executions:[ex(2,500,500)]})
  expect(buildNextRoundBuyRows({...l,merges:[]})[0]).toMatchObject({priceCents:1000,qty:500,repaid:true})
 })
 it('今日挂单使用实际计划价，区间边界含两端',()=>{
  const l=buildLedger([{...buy(2,700,500),targetPriceCents:750}],[stock],{plans:[{id:'p',refId:'target:lot:2',kind:'sell',priceCents:900,qty:500,at:1}]})
  const target=mergeTargetRows({...l,merges:[]})[0];const range=limitRange(800,'main_10')
  expect(target.priceCents).toBe(900);expect(inRange(target.priceCents,range)).toBe(false);expect(inRange(720,range)).toBe(true);expect(inRange(880,range)).toBe(true)
 })
 it('计划限量后每个卖出来源的贡献量同步缩小，不可多扣库存',()=>{
  const l=buildLedger([buy(2,500,500),buy(3,600,300)],[stock],{plans:[{id:'p',refId:'target:lot:2',kind:'sell',priceCents:800,qty:100,at:1}]})
  const [target]=mergeTargetRows({...l,merges:[]})
  expect(target.qty).toBe(400)
  expect(target.targets.map((t)=>t.qty)).toEqual([100,300])
  expect(target.expectProfitCents).toBe(90000)
 })
 it('组计划改到另一档时只限制本组，不吞掉同价其它来源',()=>{
  const records=[buy(2,500,500),buy(3,500,500),buy(4,600,300)]
  const plans=[{id:'p',refId:'sell:T:700',kind:'sell' as const,priceCents:800,qty:100,at:1}]
  const l=buildLedger(records,[stock],{plans})
  const [target]=mergeTargetRows({...l,merges:[],plans})
  expect(target.priceCents).toBe(800);expect(target.qty).toBe(400)
  expect(target.targets.reduce((a,t)=>a+t.qty,0)).toBe(400)
 })
 it('同一原价拆成两个计划价的汇总行有不同身份',()=>{
  const records=[2,3,4,5].map((r)=>buy(r,500,500))
  const plans=records.map((r)=>({id:'p'+r.sourceRow,refId:`target:lot:${r.sourceRow}`,kind:'sell' as const,priceCents:r.sourceRow<4?800:900,qty:500,at:1}))
  const l=buildLedger(records,[stock],{plans})
  const rows=mergeTargetRows({...l,merges:[]})
  expect(rows).toHaveLength(2);expect(new Set(rows.map((r)=>r.key)).size).toBe(2)
 })
})

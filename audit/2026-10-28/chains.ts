import assert from 'node:assert/strict'
import { buildLedger } from '../../src/domain/ledger'
import type { RawRecord, RebuyExecution, StockConfig } from '../../src/domain/types'
const stock: StockConfig={id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'}
const row=(sourceRow:number,f:Partial<RawRecord>):RawRecord=>({sourceRow,stockName:'T',buyDateSerial:null,buyPriceCents:null,buyQtyRaw:null,qtyNeedsDerive:false,targetPriceCents:null,targetNeedsDerive:false,soldQty:null,sellDateSerial:null,earlyBuyPriceCents:null,rawProfitCents:null,importKey:`k${sourceRow}`,...f})
const exec=(id:string,sell:number,qty=500,price=500,date='2025-12-22T12:00:00'):RebuyExecution=>({id,orderId:`rb:sell:${sell}`,sellExecId:`sell:${sell}`,stockId:stock.id,stockName:'T',priceCents:price,qty,rewardQty:0,groupKeyAtExecution:'stock:T|500',at:new Date(date).getTime()})
const high=row(1,{buyDateSerial:46000,buyPriceCents:1000,buyQtyRaw:500,targetPriceCents:700,soldQty:500,sellDateSerial:46010,earlyBuyPriceCents:500})
const low=row(2,{buyDateSerial:46011,buyPriceCents:500,buyQtyRaw:500,targetPriceCents:700})
const child=row(3,{soldLotId:'lot:2',targetPriceCents:400,soldQty:300,sellDateSerial:46012})
const flat=(l:ReturnType<typeof buildLedger>)=>assert.deepEqual(l.checks.filter(c=>!c.ok),[])
let checks=0
function check(label:string,f:()=>void){f();checks++;console.log(`PASS ${label}`)}
check('F1 自动真实库存亏损后脱离原链，同时原链库存消失',()=>{
 const before=buildLedger([high,low],[stock]);assert.equal(before.repairChains.find(c=>c.anchorRow===1)?.holdingQty,500)
 const l=buildLedger([high,low,child],[stock]);flat(l)
 assert.equal(l.repairChains.find(c=>c.anchorRow===1)?.profitCents,0);assert.equal(l.repairChains.find(c=>c.anchorRow===1)?.holdingQty,0)
 assert.equal(l.repairChains.find(c=>c.anchorRow===2)?.lossCents,-30000);assert.equal(l.totals.targetQty,200)
})
check('C1 手工归属对照：同一后续亏损仍在原链',()=>{
 const l=buildLedger([high,low,child],[stock],{chainLinks:[{id:'c1',anchorRow:1,stockName:'T',memberRows:[2],closedAt:null,at:1}]});flat(l)
 assert.equal(l.repairChains.length,1);assert.equal(l.repairChains[0].profitCents,-30000);assert.equal(l.repairChains[0].holdingQty,200)
})
const hA=row(10,{buyDateSerial:46000,buyPriceCents:1000,buyQtyRaw:500,targetPriceCents:1200})
const root=row(11,{soldQty:500,targetPriceCents:700,sellDateSerial:46010,earlyBuyPriceCents:500})
check('F2 自动首轮回补的二代回补不继承链库存或盈亏',()=>{
 const sale=row(12,{soldLotId:'lot:exec:initial',soldQty:500,targetPriceCents:700,sellDateSerial:46014,earlyBuyPriceCents:500})
 const opts={executions:[exec('initial',11),exec('round2',12,500,500,'2025-12-24T12:00:00')]}
 const l=buildLedger([hA,root,sale],[stock],opts);flat(l);assert.equal(l.totals.targetQty,500);assert.equal(l.repairChains[0].holdingQty,0);assert.equal(l.repairChains[0].profitCents,100000)
 const after=buildLedger([hA,root,sale,row(13,{soldLotId:'lot:exec:round2',soldQty:500,targetPriceCents:800,sellDateSerial:46016})],[stock],opts);flat(after)
 assert.equal(after.repairChains[0].profitCents,100000);assert.equal(after.totals.profitCents,100000)
})
check('F3 自动槽按日判断把结束时刻之后同日成交收回旧链',()=>{
 const closedAt=new Date('2025-12-22T12:00:00').getTime()
 const l=buildLedger([high],[stock],{chainLinks:[{id:'c1',anchorRow:1,stockName:'T',memberRows:[],closedAt,at:1}],executions:[exec('late',1,500,500,'2025-12-22T15:00:00')]});flat(l)
 assert.equal(l.repairChains[0].holdingQty,500);assert.equal(l.repairChains[0].closedByUserAt,closedAt)
})
check('C2 次日成交对照：结束后的新回补被排除',()=>{
 const l=buildLedger([high],[stock],{chainLinks:[{id:'c1',anchorRow:1,stockName:'T',memberRows:[],closedAt:new Date('2025-12-22T12:00:00').getTime(),at:1}],executions:[exec('late',1,500,500,'2025-12-23T15:00:00')]});flat(l);assert.equal(l.repairChains[0].holdingQty,0)
})
check('F4 实际回补价5.50，P槽仍展示5.00并将节省高估250元',()=>{
 const l=buildLedger([high],[stock],{executions:[exec('actual',1,500,550)]});flat(l)
 assert.equal(l.lots.find(x=>x.id==='lot:exec:actual')?.buyPriceCents,550);assert.equal(l.repairChains[0].branches[0].buyPriceCents,500);assert.equal(l.repairChains[0].savingCents,100000)
 assert.equal((700-550)*500,75000)
})
check('C3 缺根卖出日期，旧库存不会自动挂钩、待买和敞口保留',()=>{
 const l=buildLedger([hA,{...root,sellDateSerial:null},low],[stock]);flat(l);assert.equal(l.totals.exposureQty,500);assert.equal(l.orders[0].remainingQty,500);assert.equal(l.repairChains[0].unlinkedQty,500)
})
check('C4 缺买入日期，不猜成真实回补覆盖',()=>{
 const l=buildLedger([hA,root,{...low,buyDateSerial:null}],[stock]);flat(l);assert.equal(l.orders[0].remainingQty,500);assert.equal(l.repairChains[0].holdingQty,0)
})
check('C5 多链分摊基本FIFO不重复盈利；但对输入数组顺序敏感',()=>{
 const hb=row(21,{buyDateSerial:46000,buyPriceCents:1200,buyQtyRaw:500,targetPriceCents:1400})
 const rr={...root,sourceRow:22,soldQty:1000};const hs={id:'hedge:22',sellRow:22,items:[{row:10,qty:500},{row:21,qty:500}],at:1}
 const a=row(23,{soldLotId:'lot:exec:multi',soldQty:600,targetPriceCents:700,sellDateSerial:46014});const b=row(24,{soldLotId:'lot:exec:multi',soldQty:400,targetPriceCents:800,sellDateSerial:46015})
 const opts={hedges:[hs],executions:[exec('multi',22,1000)]};const l=buildLedger([hA,hb,rr,a,b],[stock],opts);flat(l)
 assert.deepEqual(l.repairChains.map(c=>c.profitCents),[100000,140000]);assert.equal(l.repairChains.reduce((s,c)=>s+c.profitCents,0),240000)
 const rev=buildLedger([hA,hb,rr,b,a],[stock],opts);flat(rev);assert.deepEqual(rev.repairChains.map(c=>c.profitCents),[140000,100000]);assert.equal(rev.totals.profitCents,l.totals.profitCents)
})
console.log(`${checks} audit assertions completed`)

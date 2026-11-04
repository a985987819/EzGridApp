import type { LedgerSnapshot } from '../../src/domain/ledgerSnapshot'
import type { RawRecord } from '../../src/domain/types'
export function dataset(count:number,kind='mixed'):LedgerSnapshot{
 const s:LedgerSnapshot={schemaVersion:13,exportedAt:'2026-11-04T00:00:00.000Z',settings:{deriveSellPrice:false},records:[],stocks:[],batches:[],auditLogs:[],rebuyExecutions:[],plans:[],extraTargets:[],buyTargets:[],hedges:[],merges:[],chainLinks:[],bookingReceipts:[]}
 const row=(sourceRow:number,stockName:string,p:Partial<RawRecord>={}):RawRecord=>({sourceRow,stockName,buyDateSerial:46000,buyPriceCents:1000,buyQtyRaw:500,qtyNeedsDerive:false,targetPriceCents:1200,targetNeedsDerive:false,soldQty:0,sellDateSerial:null,earlyBuyPriceCents:null,rawProfitCents:null,importKey:`synthetic:${sourceRow}`,...p})
 const add=(r:RawRecord)=>s.records.push(r)
 for(let i=0;i<count;i+=20){
  const name=kind==='ordinary'||kind==='mixed-four-stocks'?`S${Math.floor(i/20)%4}`:`B${String(i/20).padStart(5,'0')}`,b=i+2
  if(!s.stocks.some(x=>x.name===name))s.stocks.push({id:`stock:${name}`,name,intervalCents:200,priceLimitType:'main_10'})
  for(let j=0;j<20&&i+j<count;j++)add(row(b+j,name))
  if(kind==='ordinary')continue
  const at=(j:number,p:Partial<RawRecord>)=>Object.assign(s.records[i+j],p)
  at(0,{soldQty:500,sellDateSerial:46001})
  at(1,{soldQty:200,sellDateSerial:46002})
  at(2,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldQty:500,targetPriceCents:700,sellDateSerial:46003,earlyBuyPriceCents:500})
  at(4,{buyDateSerial:46004,buyPriceCents:500,targetPriceCents:700})
  at(5,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldLotId:`lot:${b+4}`,soldQty:200,targetPriceCents:700,sellDateSerial:46005,earlyBuyPriceCents:500})
  s.hedges.push({id:`hedge:${b+2}`,sellRow:b+2,items:[{row:b+3,qty:500}],at:1})
  s.chainLinks.push({id:`chainlink:${b+2}`,anchorRow:b+2,stockName:name,memberRows:[b+4],closedAt:null,at:1})
  const execution={id:`exec:${b}`,orderId:`rb:sell:${b+2}`,sellExecId:`sell:${b+2}`,stockId:`stock:${name}`,stockName:name,qty:500,priceCents:500,rewardQty:0,groupKeyAtExecution:`stock:${name}|500`,at:Date.parse('2025-12-22T12:00:00+08:00')}
  s.rebuyExecutions.push(execution)
  at(6,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldLotId:`lot:exec:${execution.id}`,soldQty:200,targetPriceCents:700,sellDateSerial:46006,earlyBuyPriceCents:500})
  s.rebuyExecutions.push({...execution,id:`exec:second:${b}`,sellExecId:`sell:${b+6}`,orderId:`rb:sell:${b+6}`,qty:100,at:Date.parse('2025-12-24T12:00:00+08:00')})
  at(7,{deletedAt:1})
  at(8,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldQty:200,targetPriceCents:700,sellDateSerial:46004,earlyBuyPriceCents:500})
  s.extraTargets.push({id:`grid-mode:${b+8}`,lotId:`lot:${b+9}`,qty:0,priceCents:700,at:2,strategy:{mode:'baseT',groupId:`baseT:${b}`,sellRow:b+8,rebuyPriceCents:500,nextSellPriceCents:1200}})
  s.rebuyExecutions.push({...execution,id:`exec:baseT:${b}`,sellExecId:`sell:${b+8}`,orderId:`rb:sell:${b+8}`,qty:100})
  s.extraTargets.push({id:`grid:repair:${b}`,lotId:`lot:${b+10}`,qty:300,priceCents:800,at:1,strategy:{mode:'repair',groupId:`repair:${b}`,rebuyPriceCents:600,nextSellPriceCents:800}})
  s.buyTargets.push({id:`buy:${b}`,sellRow:b+2,priceCents:500,qty:300,at:1})
  s.plans.push({id:`p:${b}`,refId:`target:lot:${b+11}`,kind:'sell',priceCents:1250,qty:300,at:1})
  s.bookingReceipts!.push({id:`receipt:${b}`,payload:'synthetic',kind:'sell',stockName:name,qty:200,priceCents:700,date:'2025-12-23',at:1,recordRows:[b+6],executionIds:[]})
 }
 return s
}

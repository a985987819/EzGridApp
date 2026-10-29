import { buildLedger } from '../../src/domain/ledger'
import { buildBuySuggestions, splitBuySuggestions } from '../../src/domain/suggestions'
import { buildNextRoundBuyRows } from '../../src/domain/buyBoard'
import { validateExecutionInput } from '../../src/domain/dependencies'
import type { RawRecord, StockConfig, TradePlan } from '../../src/domain/types'
const stock: StockConfig={id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'}
function rec(sourceRow:number, fields:Partial<RawRecord>={}):RawRecord{return {sourceRow,stockName:'T',buyDateSerial:46000,buyPriceCents:null,buyQtyRaw:null,qtyNeedsDerive:false,targetPriceCents:null,targetNeedsDerive:false,soldQty:0,sellDateSerial:46010,earlyBuyPriceCents:null,rawProfitCents:null,importKey:'probe'+sourceRow,...fields}}
const naked=rec(9,{buyDateSerial:null,targetPriceCents:700,soldQty:500,earlyBuyPriceCents:500})
const nextOnly=rec(2,{buyPriceCents:500,buyQtyRaw:300,targetPriceCents:500,soldQty:300})
const list=(l:ReturnType<typeof buildLedger>,plans:TradePlan[]=[])=>buildBuySuggestions(l.buySplits,buildNextRoundBuyRows({...l,merges:[]}),plans)
function show(name:string,value:unknown){console.log(name,JSON.stringify(value))}
const same=buildLedger([naked,nextOnly],[stock])
const sameBoard=list(same)
show('A same-price must plus next', {board:sameBoard,groups:splitBuySuggestions(sameBoard,new Set(same.orders.filter(o=>o.exposure).map(o=>o.id)))})
const normal=rec(3,{buyPriceCents:1000,buyQtyRaw:500,targetPriceCents:1000,soldQty:500,earlyBuyPriceCents:450})
const collision=buildLedger([normal,naked],[stock])
show('B collision two categories',list(collision,[{id:'p1',refId:'buy:T:450',kind:'buy',priceCents:500,qty:500,at:1}]))
const changed=list(same,[{id:'p',refId:'buy:T:500',kind:'buy',priceCents:450,qty:100,at:1}])
show('C legacy ambiguous plan',changed)
const rewarded=rec(20,{buyPriceCents:500,buyQtyRaw:500,targetPriceCents:700,soldQty:500,earlyBuyPriceCents:500})
const before=buildLedger([rewarded],[stock])
const o=before.orders[0]
let accepts=true;try{validateExecutionInput(700,1000,200,o.remainingQty,o.rewardQty-o.doneRewardQty)}catch{accepts=false}
const after=buildLedger([rewarded],[stock],{executions:[{id:'e',orderId:o.id,sellExecId:o.sellExecId,stockId:o.stockId,stockName:o.stockName,qty:700,rewardQty:200,priceCents:1000,groupKeyAtExecution:o.groupKey,at:1793000000000}]})
show('D actual-price reward overspend',{order:o,validatorAccepts:accepts,groups:after.groups,failedChecks:after.checks.filter(c=>!c.ok)})
// A plan contributes 250 from each member but untouched source quantities retain 500 each.
show('E planned member portions',list(collision,[{id:'p1',refId:'buy:T:450',kind:'buy',priceCents:450,qty:250,at:1},{id:'p2',refId:'buy:T:500',kind:'buy',priceCents:450,qty:250,at:2}]))

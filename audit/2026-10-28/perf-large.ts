import { performance } from 'node:perf_hooks'
import { buildLedger } from '../../src/domain/ledger'
import type { RawRecord, StockConfig } from '../../src/domain/types'
const stock:StockConfig={id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'}
const row=(sourceRow:number,f:Partial<RawRecord>):RawRecord=>({sourceRow,stockName:'T',buyDateSerial:null,buyPriceCents:null,buyQtyRaw:null,qtyNeedsDerive:false,targetPriceCents:null,targetNeedsDerive:false,soldQty:null,sellDateSerial:null,earlyBuyPriceCents:null,rawProfitCents:null,importKey:`k${sourceRow}`,...f})
for(const n of [2500,5000]){
 const rows:Array<RawRecord>=[]
 for(let i=0;i<n;i++)rows.push(row(2*i+1,{buyDateSerial:46000,buyPriceCents:1000+i,buyQtyRaw:100,targetPriceCents:1300+i}),row(2*i+2,{sellDateSerial:46010,targetPriceCents:700,soldQty:100,earlyBuyPriceCents:500}))
 const times=[]; for(let j=0;j<3;j++){const t=performance.now();const l=buildLedger(rows,[stock]);times.push(performance.now()-t); if(l.checks.some(c=>!c.ok))throw new Error('bad checks')}
 console.log(JSON.stringify({rows:rows.length,ms:times.map(t=>Math.round(t)),median:Math.round(times.sort((a,b)=>a-b)[1])}))
}

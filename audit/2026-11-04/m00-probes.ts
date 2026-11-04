import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { buildLedger } from '../../src/domain/ledger'
import { validateBackup } from '../../src/domain/backup'
import { buildManualRecord } from '../../src/domain/manual'
import { toCents, mulCents } from '../../src/domain/money'
import { isQty } from '../../src/domain/qty'
import { parseCsvText, parseWorkbook, loadXlsx } from '../../src/io/parseWorkbook'
import { DEFAULT_STOCKS, serialToIso } from '../../src/domain/defaults'
import { exportLedgerWorkbook, parseLedgerWorkbook } from '../../src/io/ledgerWorkbook'
import type { RawRecord, RebuyExecution, StockConfig } from '../../src/domain/types'
import type { LedgerSnapshot } from '../../src/domain/ledgerSnapshot'
const dir='.tmp/m00';fs.mkdirSync(dir,{recursive:true})
const stock:StockConfig={id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'}
const row=(sourceRow:number,p:Partial<RawRecord>={}):RawRecord=>({sourceRow,stockName:'T',buyDateSerial:null,buyPriceCents:null,buyQtyRaw:null,qtyNeedsDerive:false,targetPriceCents:null,targetNeedsDerive:false,soldQty:null,sellDateSerial:null,earlyBuyPriceCents:null,rawProfitCents:null,importKey:`m00:${sourceRow}`,...p})
const exec=(id:string,sell:number,price=500,date='2025-12-22T12:00:00+08:00'):RebuyExecution=>({id,orderId:`rb:sell:${sell}`,sellExecId:`sell:${sell}`,stockId:stock.id,stockName:stock.name,qty:500,priceCents:price,rewardQty:0,groupKeyAtExecution:'stock:T|500',at:Date.parse(date)})
const high=row(1,{buyDateSerial:46000,buyPriceCents:1000,buyQtyRaw:500,targetPriceCents:700,soldQty:500,sellDateSerial:46010,earlyBuyPriceCents:500})
const low=row(2,{buyDateSerial:46011,buyPriceCents:500,buyQtyRaw:500,targetPriceCents:700})
const sale=row(3,{soldLotId:'lot:2',targetPriceCents:400,soldQty:300,sellDateSerial:46012})
const cases:object[]=[]
const record=(id:string,expected:unknown,actual:unknown,observedIssue:boolean,scope='domain')=>{cases.push({id,scope,expected,actual,status:observedIssue?'reproduced':'not-reproduced-in-this-case'})}
let l=buildLedger([high,low,sale],[stock]);let c=l.repairChains.find(c=>c.anchorRow===1)
record('C01',{profitCents:-30000,holdingQty:200},{profitCents:c?.profitCents,holdingQty:c?.holdingQty,chains:l.repairChains.map(c=>({row:c.anchorRow,loss:c.lossCents,profit:c.profitCents,holding:c.holdingQty})),checks:l.checks.filter(c=>!c.ok)},c?.profitCents!==-30000||c?.holdingQty!==200)
const original=row(10,{buyDateSerial:46000,buyPriceCents:1000,buyQtyRaw:500,targetPriceCents:1200})
const root=row(11,{soldQty:500,targetPriceCents:700,sellDateSerial:46010,earlyBuyPriceCents:500})
const child=row(12,{soldLotId:'lot:exec:initial',soldQty:500,targetPriceCents:700,sellDateSerial:46014,earlyBuyPriceCents:500})
const opts={executions:[exec('initial',11),exec('round2',12,500,'2025-12-24T12:00:00+08:00')]}
l=buildLedger([original,root,child],[stock],opts);c=l.repairChains[0]
record('C02',{holdingQty:500,profitCents:100000},{holdingQty:c?.holdingQty,profitCents:c?.profitCents,totals:l.totals,checks:l.checks.filter(c=>!c.ok)},c?.holdingQty!==500||c?.profitCents!==100000)
for(const [id,date] of [['C03','2025-12-22T15:00:00+08:00'],['C03-next-day-control','2025-12-23T15:00:00+08:00']]){
 l=buildLedger([high],[stock],{chainLinks:[{id:'chainlink:1',anchorRow:1,stockName:'T',memberRows:[],closedAt:Date.parse('2025-12-22T12:00:00+08:00'),at:1}],executions:[exec('late',1,500,date)]})
 record(id,{holdingQty:0},{holdingQty:l.repairChains[0]?.holdingQty,closedAt:l.repairChains[0]?.closedByUserAt},l.repairChains[0]?.holdingQty!==0)
}
l=buildLedger([high],[stock],{executions:[exec('actual',1,550)]});c=l.repairChains[0]
record('C04',{actualCost:550,actualSavingCents:75000},{actualCost:l.lots.find(l=>l.id==='lot:exec:actual')?.buyPriceCents,branchCost:c.branches[0]?.buyPriceCents,savingCents:c.savingCents},c.branches[0]?.buyPriceCents!==550||c.savingCents!==75000)
const csv=(date='2026-02-28',qty='100')=>`股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\nT,${date},10,${qty},12,,,\n`
let p=await parseCsvText(csv('2026-02-30'));record('D08','reject nonexistent calendar date',{parsedDate:serialToIso(p.records[0]?.buyDateSerial??null)},p.records.length>0&&p.records[0].buyDateSerial!==null,'parseCsvText')
p=await parseCsvText(csv('2026-02-28','100.5'));record('D09','reject fractional shares',{qty:p.records[0]?.buyQtyRaw,backupValidation:validateBackup({records:p.records})},p.records[0]?.buyQtyRaw===100.5,'parseCsvText vs validateBackup')
const X=await loadXlsx();const wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([['股票','日期','买入价','买入份额','目标售价','实现份数','卖出日期','提前卖的买价'],['T',44500,10,100,12]]),'交易记录');wb.Workbook={WBProps:{date1904:true}}
p=await parseWorkbook(X.write(wb,{type:'array',bookType:'xlsx'}));record('D10',serialToIso(44500+1462),{parsedDate:serialToIso(p.records[0].buyDateSerial),date1904:true,serial:44500},p.records[0].buyDateSerial===44500,'real XLSX date1904')
const huge='9'.repeat(400),manual=buildManualRecord({kind:'buy',stockName:'T',date:'2026-02-28',price:huge,qty:'500'},100000)
record('V05','reject unsafe price/quantity/product',{toCents:String(toCents(huge)),quantity1e20Accepted:isQty(1e20),productSafe:Number.isSafeInteger(mulCents(1e10,1e10)),manualErrors:manual.errors,manualPrice:String(manual.record.buyPriceCents)},manual.errors.length===0||isQty(1e20)||!Number.isSafeInteger(mulCents(1e10,1e10)),'money/qty/manual')
for(const [id,value]of Object.entries({missingRequired:{sourceRow:1,stockName:'T',importKey:'missing'},unsafeRow:row(Number.MAX_SAFE_INTEGER+1),danglingExec:row(1,{soldLotId:'lot:exec:missing',soldQty:100,targetPriceCents:700}),cycle:row(1,{soldLotId:'lot:1',soldQty:100,targetPriceCents:700})})){
 const result=validateBackup({records:[value]});record('D06-'+id,'reject malformed current snapshot record',{validation:result},result===null,'validateBackup')
}
const fixtureResults=[]
for(const file of ['26年网格记录.xlsx','26年网格记录-交易记录.csv']){
 const parsed=file.endsWith('.csv')?await parseCsvText(fs.readFileSync('tests/fixtures/'+file,'utf8')):await parseWorkbook(fs.readFileSync('tests/fixtures/'+file))
 const ledger=buildLedger(parsed.records,DEFAULT_STOCKS)
 const snapshot:LedgerSnapshot={schemaVersion:13,exportedAt:'2026-11-04T00:00:00.000Z',settings:{deriveSellPrice:false},records:parsed.records,stocks:DEFAULT_STOCKS,batches:[],auditLogs:[],rebuyExecutions:[],plans:[],extraTargets:[],buyTargets:[],hedges:[],merges:[],chainLinks:[],bookingReceipts:[]}
 const exported=await exportLedgerWorkbook(snapshot),restored=await parseLedgerWorkbook(exported)
 fixtureResults.push({file,rows:parsed.records.length,totals:ledger.totals,failedChecks:ledger.checks.filter(c=>!c.ok),anomalies:ledger.anomalies.map(a=>a.kind),backupValidation:validateBackup(snapshot),workbookRoundtripExact:isDeepStrictEqual(restored?.snapshot,snapshot),workbookDifferences:restored?.differences})
}
fs.writeFileSync(dir+'/probes.json',JSON.stringify({date:'2026-11-04',cases,fixtures:fixtureResults},null,2));console.log(JSON.stringify({cases,fixtures:fixtureResults},null,2))

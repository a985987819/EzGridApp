import {spawn} from 'node:child_process'
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const profile=mkdtempSync(join(tmpdir(),'ezgrid-audit-'))
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=9555',`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','about:blank'],{stdio:'ignore'})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const replayDir=join(process.cwd(),'.tmp','audit-replay');mkdirSync(replayDir,{recursive:true});const results=[]
let socket
try{
 for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:9555/json/version')).ok)break}catch{}await sleep(200)}
 const target=await(await fetch('http://127.0.0.1:9555/json/new?about:blank',{method:'PUT'})).json()
 socket=new WebSocket(target.webSocketDebuggerUrl)
 await new Promise((r,j)=>{socket.addEventListener('open',r);socket.addEventListener('error',j)})
 let id=0;const waiting=new Map()
 socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&waiting.has(m.id)){const p=waiting.get(m.id);waiting.delete(m.id);m.error?p.j(m.error):p.r(m.result)}})
 const send=(method,params={})=>new Promise((r,j)=>{const n=++id;waiting.set(n,{r,j});socket.send(JSON.stringify({id:n,method,params}))})
 const run=async(code)=>{const v=await send('Runtime.evaluate',{expression:`(async()=>{${code}})()`,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw new Error(JSON.stringify(v.exceptionDetails));return v.result.value}
 await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:5173'});await sleep(1500)
 await run(`const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;const source=await(await fetch('/src/pages/OrdersPage.tsx')).text();const url=source.match(new RegExp('from "([^\"]*store.useApp[^\"]*)"'))[1];const {AppProvider,useApp}=await import(url);const el=document.createElement('div');document.body.appendChild(el);function Probe(){window.a=useApp();return null}createRoot(el).render(React.createElement(AppProvider,null,React.createElement(Probe)));window.db=(await import('/src/store/db.ts')).db;window.base={sourceRow:2,stockName:'T',buyDateSerial:46000,buyPriceCents:500,buyQtyRaw:500,qtyNeedsDerive:false,targetPriceCents:700,targetNeedsDerive:false,soldQty:500,sellDateSerial:46010,earlyBuyPriceCents:null,rawProfitCents:null,importKey:'audit-base'};`)
 await sleep(700)
 const act=async code=>{const v=await run(code);await sleep(150);return v}
 const reset=()=>act(`await a.resetAll();await a.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'})`)
 const out=(name,value)=>{results.push({name,value});console.log(JSON.stringify({name,value}));writeFileSync(join(replayDir,'persistence-results.json'),JSON.stringify(results,null,2))}
 await reset()
 out('parallelManual',await act(`const ids=await Promise.all([a.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'5',qty:'500'}),a.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'6',qty:'700'})]);return{ids,records:await db.records.toArray(),audits:await db.auditLogs.toArray()}`))
 await reset()
 await act(`await a.commitImport({sheetName:'S',records:[base],skippedRows:[],missingColumns:[]},'a.xlsx')`)
 await act(`await a.recordBuySuggestion([{kind:'next',id:'buy:2',row:2,qty:500}],500,500,'2026-10-25')`)
 out('rollbackNextSource',await act(`const backup=JSON.parse(await a.exportBackup());const count=await a.rollbackBatch(backup.batches[0].id);const after=JSON.parse(await a.exportBackup());const {validateBackup}=await import('/src/domain/backup.ts');return{count,records:after.records,validation:validateBackup(after)}`))
 await reset()
 await act(`await a.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-20',price:'7',qty:'500',rebuyPrice:'5'})`)
 await act(`await a.recordRebuy(a.ledger.orders[0],500,500,0)`)
 const execId=await run(`return a.executions[0].id`)
 await act(`await a.recordLotSales([{lotId:'lot:exec:'+${JSON.stringify(execId)},qty:500}],500,700,'2026-10-26')`)
 await act(`await a.softDelete(a.records.find(r=>r.soldLotId).sourceRow)`)
 out('undoRebuyAfterUndoSale',await act(`await a.removeRebuy(${JSON.stringify(execId)});const after=JSON.parse(await a.exportBackup());const {validateBackup}=await import('/src/domain/backup.ts');let restore;try{await a.restoreBackup(JSON.stringify(after));restore='accepted'}catch(e){restore=e.message}return{records:after.records,execs:after.rebuyExecutions,validation:validateBackup(after),restore}`))
 await reset()
 await act(`await a.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-20',price:'7',qty:'500',rebuyPrice:'5'})`)
 await act(`await a.recordRebuy(a.ledger.orders[0],500,500,0)`)
 await act(`await a.addExtraTarget('lot:exec:'+a.executions[0].id,600,200)`)
 out('undoRebuyLeavesVirtualTargets',await act(`await a.removeRebuy(a.executions[0].id);const after=JSON.parse(await a.exportBackup());const{exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');let xlsx;try{await parseLedgerWorkbook(await exportLedgerWorkbook(after));xlsx='accepted'}catch(e){xlsx=e.message}return{targets:after.extraTargets,xlsx}`))
 await reset()
 await act(`await a.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-20',price:'7',qty:'500',rebuyPrice:'5'})`)
 await act(`await a.recordRebuy(a.ledger.orders[0],500,500,0)`)
 out('restoreMissingTables',await act(`const before=JSON.parse(await a.exportBackup());await a.restoreBackup('{}');const after=JSON.parse(await a.exportBackup());return{before:{records:before.records.length,executions:before.rebuyExecutions.length},after:{records:after.records.length,executions:after.rebuyExecutions.length},owed:a.ledger.orders.map(o=>o.remainingQty)}`))
 await reset()
 out('invalidImportDate',await run(`const {parseCsvText}=await import('/src/io/parseWorkbook.ts');const{isoToSerial}=await import('/src/domain/edit.ts');const{serialToIso}=await import('/src/domain/defaults.ts');const p=await parseCsvText('股票,日期,买入价,买入份额\\nT,2026-02-30,5,500');return{manual:isoToSerial('2026-02-30'),imported:p.records[0].buyDateSerial,iso:serialToIso(p.records[0].buyDateSerial)}`))
 out('jsonInvalidFields',await run(`const{validateBackup}=await import('/src/domain/backup.ts');const {buildLedger}=await import('/src/domain/ledger.ts');const r={...base,buyPriceCents:'wrong',buyQtyRaw:500,soldQty:0};const p={schemaVersion:11,records:[r],stocks:await db.stocks.toArray()};let ledger;try{ledger=buildLedger(p.records,p.stocks).totals}catch(e){ledger=e.message}return{validation:validateBackup(p),ledger}`))
 out('nakedSellReimportSubset',await run(`const {planImport}=await import('/src/domain/importPlan.ts');const first={...base,buyDateSerial:null,buyPriceCents:null,buyQtyRaw:null,targetPriceCents:700,sellDateSerial:46010,importKey:'sell-A'};const second={...first,sourceRow:3,targetPriceCents:800,sellDateSerial:46020,importKey:'sell-B'};return planImport([first,second],[second])`))
 out('fractionalImportQty',await run(`const{parseCsvText}=await import('/src/io/parseWorkbook.ts');const{buildLedger}=await import('/src/domain/ledger.ts');const p=await parseCsvText('股票,日期,买入价,买入份额,目标售价\\nT,2026-10-20,5,500.5,7');const l=buildLedger(p.records,await db.stocks.toArray());return{record:p.records[0],buyQty:l.totals.buyQty,anomalies:l.anomalies,checks:l.checks.filter(c=>!c.ok)}`))
 out('excel1904Dates',await run(`const{parseWorkbook,loadXlsx}=await import('/src/io/parseWorkbook.ts');const{serialToIso}=await import('/src/domain/defaults.ts');const X=await loadXlsx();const w=X.utils.book_new();w.Workbook={WBProps:{date1904:true}};X.utils.book_append_sheet(w,X.utils.aoa_to_sheet([['股票','日期','买入价','买入份额'],['T',44853,5,500]]),'S');const bytes=X.write(w,{type:'array',bookType:'xlsx'});const p=await parseWorkbook(bytes);return{expected:'2026-10-20',serial:p.records[0].buyDateSerial,actual:serialToIso(p.records[0].buyDateSerial)}`))
 await reset()
 out('missingAudits',await act(`const before=(await db.auditLogs.toArray()).length;await a.setPlan('buy','some-ref',500,200);await a.addExtraTarget('lot:2',700,200);await a.addBuyTarget(2,500,200);await a.updateStock({...a.stocks.find(s=>s.name==='T'),intervalCents:300});return{before,after:(await db.auditLogs.toArray()).length}`))
 await reset()
 await act(`window.s1={...base,buyDateSerial:null,buyPriceCents:null,buyQtyRaw:null,targetPriceCents:700,sellDateSerial:46010,importKey:'sell-A'};window.s2={...s1,sourceRow:3,targetPriceCents:800,sellDateSerial:46020,importKey:'sell-B'};await a.commitImport({sheetName:'S',records:[s1,s2],skippedRows:[],missingColumns:[]},'two-sells.xlsx')`)
 out('reimportExistingKeyPublicAction',await act(`const before=(await db.records.toArray()).map(r=>[r.sourceRow,r.importKey,r.targetPriceCents]);const outcome=await a.commitImport({sheetName:'S',records:[s2],skippedRows:[],missingColumns:[]},'second-sell-only.xlsx');return{before,outcome:{added:outcome.added,updated:outcome.updated,duplicated:outcome.duplicated},after:(await db.records.toArray()).map(r=>[r.sourceRow,r.importKey,r.targetPriceCents])}`))
 await reset()
 out('jsonDuplicateIds',await act(`const s=JSON.parse(await a.exportBackup());s.records=[{...base,soldQty:0,importKey:'A'},{...base,soldQty:0,buyQtyRaw:700,buyPriceCents:600,importKey:'B'}];const{validateBackup}=await import('/src/domain/backup.ts');const accepted=validateBackup(s);await a.restoreBackup(JSON.stringify(s));const after=await db.records.toArray();return{validation:accepted,inputRows:s.records.length,afterRows:after.length,after:after.map(r=>({row:r.sourceRow,qty:r.buyQtyRaw,price:r.buyPriceCents,key:r.importKey}))}`))
 await reset()
 out('jsonCycleInvisible',await act(`const s=JSON.parse(await a.exportBackup());s.records=[{...base,sourceRow:2,soldLotId:'lot:3',importKey:'A'},{...base,sourceRow:3,soldLotId:'lot:2',importKey:'B'}];const{validateBackup}=await import('/src/domain/backup.ts');const {buildLedger}=await import('/src/domain/ledger.ts');const l=buildLedger(s.records,s.stocks);const{exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');let xlsx;try{await parseLedgerWorkbook(await exportLedgerWorkbook(s));xlsx='accepted'}catch(e){xlsx=e.message}return{validation:validateBackup(s),records:s.records.length,sells:l.sells.length,lots:l.lots.length,checks:l.checks.filter(c=>!c.ok),xlsx}`))
 out('jsonMissingRewardQty',await run(`const{validateBackup}=await import('/src/domain/backup.ts');const {buildLedger}=await import('/src/domain/ledger.ts');const s=JSON.parse(await a.exportBackup());s.records=[{...base,buyDateSerial:null,buyPriceCents:null,buyQtyRaw:null,earlyBuyPriceCents:500}];s.rebuyExecutions=[{id:'e',orderId:'rb:sell:2',sellExecId:'sell:2',stockId:'stock:T',stockName:'T',qty:500,priceCents:500,at:1793170000000,groupKeyAtExecution:'stock:T|500'}];const l=buildLedger(s.records,s.stocks,{executions:s.rebuyExecutions});return{validation:validateBackup(s),order:l.orders.map(o=>({remaining:o.remainingQty,doneReward:o.doneRewardQty})),isRewardNaN:l.orders.some(o=>Number.isNaN(o.doneRewardQty)),hasInvalidChecks:l.checks.filter(c=>!c.ok)}`))
 writeFileSync(join(replayDir,'persistence-results.json'),JSON.stringify(results,null,2))
}finally{socket?.close();browser.kill();await sleep(200);try{rmSync(profile,{recursive:true,force:true})}catch{}}

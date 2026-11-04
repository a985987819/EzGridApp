import fs from 'node:fs'
import assert from 'node:assert/strict'
import {browser} from './browser.mjs'
const b=await browser(9584),{send,run,until,pause}=b
const base=process.argv[2]??'http://127.0.0.1:5184'
const results={date:'2026-11-04',browser:await send('Browser.getVersion'),cases:[],timings:{}}
const out=(id,actual)=>{results.cases.push({id,actual});console.log(JSON.stringify({id,actual}))}
try{
 await send('Page.navigate',{url:base});await until(`!!document.querySelector('[data-nav=manage]') && !document.body.innerText.includes('初始化本地库')`)
 await run(`(async()=>{
 const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
 const source=await(await fetch('/src/pages/OrdersPage.tsx')).text();const url=source.match(/from "([^"]*store.useApp[^"]*)"/)[1];
 const {AppProvider,useApp}=await import(url);document.getElementById('root').style.display='none';const el=document.createElement('div');document.body.appendChild(el);
 function Probe(){window.a=useApp();return null}createRoot(el).render(React.createElement(AppProvider,null,React.createElement(Probe)));
 window.db=(await import('/src/store/db.ts')).db;window.read=()=>db.transaction('r',db.tables,async()=>Object.fromEntries(await Promise.all(db.tables.map(async t=>[t.name,await t.toArray()]))));
 })()`);await until('window.a?.ready')
 const act=async text=>{const v=await run(`(async()=>{${text}})()`);await pause(120);return v}
 await act(`await a.resetAll();await a.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'})`)
 out('D08-public-import',await act(`const {parseCsvText}=await import('/src/io/parseWorkbook.ts');const p=await parseCsvText(${JSON.stringify('股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\nT,2026-02-30,10,100,12,,,')});await a.commitImport(p,'invalid-date.csv');return (await db.records.toArray()).map(r=>({date:r.buyDateSerial,qty:r.buyQtyRaw}))`))
 await act('await a.resetAll()')
 out('D09-public-import',await act(`const {parseCsvText}=await import('/src/io/parseWorkbook.ts');const p=await parseCsvText(${JSON.stringify('股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\nT,2026-02-28,10,100.5,12,,,')});await a.commitImport(p,'fractional.csv');const s=JSON.parse(await a.exportBackup());const{validateBackup}=await import('/src/domain/backup.ts');return {qty:s.records[0].buyQtyRaw,validation:validateBackup(s)}`))
 await act('await a.resetAll()')
 out('D06-public-restore-minimal',await act(`const s=JSON.parse(await a.exportBackup());s.records=[{sourceRow:2,stockName:'T',importKey:'minimal'}];try{await a.restoreBackup(JSON.stringify(s));return {accepted:true,records:await db.records.toArray()}}catch(e){return {accepted:false,error:e.message}}`))
 await act('await a.resetAll()')
 out('V05-public-manual',await act(`try{await a.addManualRecord({kind:'buy',stockName:'T',date:'2026-02-28',price:'9'.repeat(400),qty:'500'});const rows=await db.records.toArray();return{accepted:true,price:String(rows[0]?.buyPriceCents)}}catch(e){return{accepted:false,error:e.message}}`))
 await act('await a.resetAll()')
 out('D07-public-empty-json',await act(`try{await a.restoreBackup('{}');return{accepted:true}}catch(e){return{accepted:false,error:e.message}}`))
 const synthetic=JSON.parse(fs.readFileSync('.tmp/m00/synthetic-1000.json','utf8'))
 await run(`window.sample=${JSON.stringify(synthetic)}`)
 await act('await a.restoreBackup(JSON.stringify(sample))')
 const env=await run(`({userAgent:navigator.userAgent,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,rows:a.records.length,checks:a.ledger.checks.filter(c=>!c.ok)})`);assert.equal(env.rows,1000);assert.deepEqual(env.checks,[]);results.environment=env
 for(const [name,expr]of [['indexedDbRead','await read()'],['exportBackup','await a.exportBackup()']]){
  results.timings[name]=await run(`(async()=>{const arr=[];for(let i=0;i<25;i++){const t=performance.now();${expr};if(i>=5)arr.push(performance.now()-t)}return arr})()`)
 }
 out('export-side-effects',await run(`(async()=>{const before=await db.meta.get('lastBackupAt');await new Promise(r=>setTimeout(r,5));await a.exportBackup();return {before:before?.value,after:(await db.meta.get('lastBackupAt'))?.value}})()`))
 out('post-probe-state',await run(`({rows:a.records.length,checks:a.ledger.checks.filter(c=>!c.ok),total:a.ledger.totals})`))
 fs.writeFileSync('.tmp/m00/browser-store.json',JSON.stringify(results,null,2));console.log('M00 browser probes completed (observations, not defect fixes)')
}finally{await b.close()}

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const replayDir = join(process.cwd(), '.tmp', 'audit-replay'); mkdirSync(replayDir, { recursive: true }); const profile = mkdtempSync(join(tmpdir(), 'ezgrid-audit-stats-'))
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--remote-debugging-port=9557',`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','about:blank'], {stdio:'ignore'})
const sleep = ms => new Promise(r=>setTimeout(r,ms))
let socket
try {
  for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:9557/json/version')).ok)break}catch{}await sleep(150)}
  const target=await(await fetch('http://127.0.0.1:9557/json/new?about:blank',{method:'PUT'})).json()
  socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r,j)=>{socket.addEventListener('open',r);socket.addEventListener('error',j)})
  let id=0;const waiting=new Map()
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&waiting.has(m.id)){const p=waiting.get(m.id);waiting.delete(m.id);m.error?p.j(m.error):p.r(m.result)}})
  const send=(method,params={})=>new Promise((r,j)=>{const n=++id;waiting.set(n,{r,j});socket.send(JSON.stringify({id:n,method,params}))})
  const run=async code=>{const v=await send('Runtime.evaluate',{expression:`(async()=>{${code}})()`,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw new Error(JSON.stringify(v.exceptionDetails));return v.result.value}
  await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:5173'});await sleep(1200)
  await run(`
    const React=(await import('/node_modules/.vite/deps/react.js')).default;
    const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const source=await(await fetch('/src/pages/StatsPage.tsx')).text();
    const url=source.match(new RegExp('from "([^\\"]*store.useApp[^\\"]*)"'))[1];
    const {AppProvider,useApp}=await import(url);
    const {StatsPage}=await import('/src/pages/StatsPage.tsx');
    const {TreeTrunk}=await import('/src/components/TreeTrunk.tsx');
    localStorage.setItem('ezgrid.statsCal','2026-10');
    const el=document.createElement('div');el.id='audit-stats';document.body.appendChild(el);
    function Probe(){window.audit=useApp();return React.createElement(React.Fragment,null,React.createElement(StatsPage,{goTrades:()=>{}}),React.createElement(TreeTrunk,{stockName:'T',onPick:()=>{}}))}
    createRoot(el).render(React.createElement(AppProvider,null,React.createElement(Probe)));
  `)
  await sleep(700)
  const act=async code=>{const v=await run(code);await sleep(150);return v}
  await act(`await audit.resetAll();await audit.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});await audit.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-01',price:'10',qty:'500',targetPrice:'12'});`)
  await act(`await audit.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-28',price:'7',qty:'500',rebuyPrice:'5'});`)
  await sleep(500)
  const statistics=await run(`return {
    actualDaily:audit.ledger.daily,
    dayDetails:document.querySelector('#audit-stats [data-testid="cal-day-sells"]')?.innerText,
    progress:document.querySelector('#audit-stats [data-testid="grid-progress"]')?.innerText,
    calendarLabels:[...document.querySelectorAll('#audit-stats .cal-day-stat')].map(e=>({text:e.textContent,title:e.title})),
    tree:document.querySelector('#audit-stats canvas')?.__tree?.levels(),
    treeBins:document.querySelector('#audit-stats canvas')?.__tree?.bins(),
    total:audit.ledger.totals
  }`)
  assert.equal(statistics.actualDaily[0].sellCount,1)
  assert.equal(statistics.actualDaily[0].sellQty,500)
  assert(statistics.calendarLabels.some(e=>e.text.includes('2笔')&&e.title.includes('1000')))
  assert.equal(statistics.tree.find(p=>p.cents===700).sold,1000)
  assert(statistics.treeBins.sold.some(b=>b.cents===700&&b.times===2))
  console.log('stats-evidence',JSON.stringify(statistics))
  assert(statistics.progress.includes('1,500.00'))
  const trend=await act(`
    await audit.resetAll();
    const rows=[];for(let i=0;i<14;i++){
      const y=2024+Math.floor(i/12),m=i%12;
      rows.push({sourceRow:i+1,stockName:'T',buyDateSerial:44000,buyPriceCents:500,buyQtyRaw:100,qtyNeedsDerive:false,targetPriceCents:600,targetNeedsDerive:false,soldQty:100,sellDateSerial:i===13?null:Math.round((Date.UTC(y,m,10)-Date.UTC(1899,11,30))/86400000),earlyBuyPriceCents:null,rawProfitCents:null,importKey:'trend:'+i});
    }
    await audit.commitImport({sheetName:'S',records:rows,skippedRows:[],missingColumns:[]},'trend.csv');
  `)
  void trend
  await sleep(300)
  const trendEvidence=await run(`return {monthly:audit.ledger.monthly.map(m=>m.month),labels:[...document.querySelectorAll('#audit-stats .trend-month')].map(e=>e.textContent),columns:document.querySelectorAll('#audit-stats .trend-col').length}`)
  assert.equal(trendEvidence.columns,12)
  assert.equal(trendEvidence.labels.at(-1),'')
  const result={statistics,trend:trendEvidence}
  writeFileSync(join(replayDir,'statistics-ui-results.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
} finally {socket?.close();browser.kill();await sleep(200);try{rmSync(profile,{recursive:true,force:true})}catch{}}

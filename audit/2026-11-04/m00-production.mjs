import fs from 'node:fs'
import {browser} from './browser.mjs'
const b=await browser(9585),{send,run,until,pause}=b
const base=process.argv[2]??'http://127.0.0.1:4184/EzGridApp/'
const results={date:'2026-11-04',base,version:JSON.parse(fs.readFileSync('dist/version.json')),browser:await send('Browser.getVersion'),conditions:{viewport:[390,844],cpuRate:4,network:'local HTTP, no network throttling',serviceWorker:'bypassed',warmup:5,samples:20},cases:[]}
try{
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
 await send('Emulation.setCPUThrottlingRate',{rate:4})
 await send('Network.setBypassServiceWorker',{bypass:true})
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.m00={longTasks:[],lcp:[],cls:0};try{new PerformanceObserver(l=>l.getEntries().forEach(e=>m00.longTasks.push({start:e.startTime,ms:e.duration}))).observe({type:'longtask',buffered:true});new PerformanceObserver(l=>l.getEntries().forEach(e=>m00.lcp.push(e.startTime))).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(!e.hadRecentInput)m00.cls+=e.value})).observe({type:'layout-shift',buffered:true})}catch{}`})
 const nav=async()=>{await send('Page.navigate',{url:'about:blank'});await until(`location.href==='about:blank'`);await send('Page.navigate',{url:base+'#/overview'});await until(`location.href.startsWith(${JSON.stringify(base)}) && !!document.querySelector('[data-nav=overview]') && !document.body.innerText.includes('初始化本地库') && !document.body.innerText.includes('正在打开') && !!document.querySelector('.app-main .stack,.app-main .empty-box')`);await pause(250);return run(`({timeOrigin:performance.timeOrigin,readyMs:performance.now(),lcpMs:m00.lcp.at(-1)??null,cls:m00.cls,longTasks:m00.longTasks,resources:performance.getEntriesByType('resource').map(r=>({name:r.name.replace(location.origin,''),transfer:r.transferSize,encoded:r.encodedBodySize,duration:r.duration}))})`)}
 // First visit includes IndexedDB creation and source-fingerprinted assets. SW bypass excludes precache inflation.
 await send('Network.setCacheDisabled',{cacheDisabled:true})
 results.cases.push({name:'empty-first-install',...(await nav())})
 for(const mode of ['cold-cache','warm-cache']){
  const arr=[];await send('Network.setCacheDisabled',{cacheDisabled:mode==='cold-cache'})
  for(let i=0;i<25;i++){if(mode==='cold-cache')await send('Network.clearBrowserCache');const v=await nav();if(i>=5)arr.push(v)}
  results.cases.push({name:`empty-${mode}`,samples:arr})
 }
 // Deterministic seed into a fresh test profile; never use the user's browser or production account.
 const synthetic=JSON.parse(fs.readFileSync('.tmp/m00/synthetic-1000.json','utf8'))
 await run(`(async()=>{const s=${JSON.stringify(synthetic)};await new Promise((resolve,reject)=>{const r=indexedDB.open('grid-trading');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const names=['records','stocks','batches','auditLogs','rebuyExecutions','plans','extraTargets','buyTargets','hedges','merges','chainLinks','bookingReceipts'];const tx=db.transaction(names,'readwrite');for(const n of names){const t=tx.objectStore(n);t.clear();for(const value of s[n]??[])t.put(value)}tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})})()`)
 const populated=[];await send('Network.setCacheDisabled',{cacheDisabled:false})
 for(let i=0;i<25;i++){const v=await nav();if(i>=5)populated.push(v)}
 results.cases.push({name:'mixed-1000-warm-cache',samples:populated})
 results.caseNotes='readyMs sampled after 75ms readiness polling + fixed 250ms paint settle; not a raw LCP or INP measurement. Empty cases reuse initialized DB except first install.'
 const origins=results.cases.flatMap(c=>c.samples??[c]).map(s=>s.timeOrigin);if(new Set(origins).size!==origins.length)throw Error('navigation reused timeOrigin')
 fs.writeFileSync('.tmp/m00/browser-production.json',JSON.stringify(results,null,2))
 console.log(JSON.stringify(results.cases.map(c=>({name:c.name,samples:c.samples?.length,ready:c.readyMs,median:c.samples?.map(v=>v.readyMs).sort((a,b)=>a-b)[9]}))))
}finally{await b.close()}

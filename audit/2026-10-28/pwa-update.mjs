import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, extname } from 'node:path'
import assert from 'node:assert/strict'
const replayDir=resolve(process.cwd(),'.tmp','audit-replay');mkdirSync(replayDir,{recursive:true});const dist=resolve('dist'),profile=mkdtempSync(join(tmpdir(),'ezgrid-audit-pwa-'))
let version='A',socket,browser
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.webmanifest':'application/manifest+json','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'}
// Only local HTTP responses are marked A/B. Repository files and production site are never changed.
const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1:5278').pathname
  if(!pathname.startsWith('/EzGridApp/')){res.writeHead(404);return res.end()}
  const rel=decodeURIComponent(pathname.slice('/EzGridApp/'.length))||'index.html'
  const path=resolve(dist,rel)
  if(!path.startsWith(dist)||!existsSync(path)){res.writeHead(404);return res.end()}
  let data=readFileSync(path)
  if(rel==='index.html')data=Buffer.from(data.toString().replace('<head>',`<head><meta name="audit-build" content="${version}">`))
  if(rel==='sw.js')data=Buffer.from(data.toString().replace(/url:"index\.html",revision:"[^"]+"/,`url:"index.html",revision:"audit-${version}"`))
  res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)
})
await new Promise(r=>server.listen(5278,'127.0.0.1',r))
try{
  browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=9558',`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','about:blank'],{stdio:'ignore'})
  for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:9558/json/version')).ok)break}catch{}await sleep(150)}
  const target=await(await fetch('http://127.0.0.1:9558/json/new?about:blank',{method:'PUT'})).json()
  socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r,j)=>{socket.addEventListener('open',r);socket.addEventListener('error',j)})
  let id=0;const waiting=new Map()
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&waiting.has(m.id)){const p=waiting.get(m.id);waiting.delete(m.id);m.error?p.j(m.error):p.r(m.result)}})
  const send=(method,params={})=>new Promise((r,j)=>{const n=++id;waiting.set(n,{r,j});socket.send(JSON.stringify({id:n,method,params}))})
  const run=async code=>{const v=await send('Runtime.evaluate',{expression:`(async()=>{${code}})()`,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw new Error(JSON.stringify(v.exceptionDetails));return v.result.value}
  const read=()=>run(`const reg=await navigator.serviceWorker.getRegistration();return {build:document.querySelector('meta[name="audit-build"]')?.content,controlled:!!navigator.serviceWorker.controller,active:reg?.active?.state,waiting:reg?.waiting?.state,notification:document.body.textContent.includes('手动刷新页面后生效')}`)
  await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:5278/EzGridApp/'});await sleep(1500)
  await run('await navigator.serviceWorker.ready;return true')
  await send('Page.reload');await sleep(800)
  const initial=await read();assert.equal(initial.build,'A');assert(initial.controlled)
  version='B'
  await run('const reg=await navigator.serviceWorker.getRegistration();await reg.update();return true')
  for(let i=0;i<50;i++){if((await read()).waiting)break;await sleep(200)}
  const downloaded=await read();assert.equal(downloaded.waiting,'installed')
  await send('Page.reload');await sleep(1000)
  const afterRefresh=await read()
  await send('Page.reload');await sleep(800)
  const afterSecondRefresh=await read()
  assert.equal(afterRefresh.build,'A');assert.equal(afterSecondRefresh.build,'A')
  assert(afterSecondRefresh.waiting)
  await send('Page.navigate',{url:'about:blank'});await sleep(800)
  await send('Page.navigate',{url:'http://127.0.0.1:5278/EzGridApp/'});await sleep(1000)
  const afterAllSiteClientsClosed=await read()
  assert.equal(afterAllSiteClientsClosed.build,'B')
  const result={initial,downloaded,afterRefresh,afterSecondRefresh,afterAllSiteClientsClosed}
  console.log(JSON.stringify(result,null,2));writeFileSync(join(replayDir,'pwa-update-results.json'),JSON.stringify(result,null,2))
}finally{socket?.close();browser?.kill();await new Promise(r=>server.close(r));await sleep(200);try{rmSync(profile,{recursive:true,force:true})}catch{}}

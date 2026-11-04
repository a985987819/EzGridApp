import {spawn} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
export async function browser(port){
 const profile=mkdtempSync(join(tmpdir(),'ezgrid-m00-'))
 const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','about:blank'],{stdio:'ignore'})
 const pause=ms=>new Promise(r=>setTimeout(r,ms))
 let socket
 try{
  for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}await pause(150)}
  const t=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json()
  socket=new WebSocket(t.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r);socket.addEventListener('error',j)})
  const pending=new Map(),listeners=[];let id=0
  socket.addEventListener('message',({data})=>{const v=JSON.parse(data);if(v.id&&pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}else for(const l of listeners)l(v)})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}))})
  const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  const until=async(expression,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await run(expression))return;await pause(75)}throw Error('timeout '+expression)}
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable')
  return {send,run,until,pause,listeners,close:async()=>{socket?.close();child.kill();await pause(300);try{rmSync(profile,{recursive:true,force:true})}catch{}}}
 }catch(e){socket?.close();child.kill();throw e}
}

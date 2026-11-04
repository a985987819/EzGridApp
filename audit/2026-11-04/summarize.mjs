import fs from 'node:fs'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import {gzipSync} from 'node:zlib'
const d='.tmp/m00',read=n=>JSON.parse(fs.readFileSync(d+'/'+n,'utf8'))
const stats=a=>{const s=a.slice().sort((a,b)=>a-b);return{samples:s.length,median:s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2,p95:s[Math.ceil(s.length*.95)-1]}}
const profile=read('m00.cpuprofile'),nodes=new Map(profile.nodes.map(n=>[n.id,n])),parent=new Map()
for(const n of profile.nodes)for(const child of n.children??[])parent.set(child,n.id)
const self=new Map(),inclusive=new Map();let total=0
for(let i=0;i<profile.samples.length;i++){
 const weight=profile.timeDeltas[i]??0;total+=weight;let id=profile.samples[i]
 self.set(id,(self.get(id)??0)+weight)
 const visited=new Set();while(id&&!visited.has(id)){visited.add(id);inclusive.set(id,(inclusive.get(id)??0)+weight);id=parent.get(id)}
}
const mapped=rows=>[...rows].map(([id,us])=>({name:nodes.get(id).callFrame.functionName||'(anonymous)',url:nodes.get(id).callFrame.url,line:nodes.get(id).callFrame.lineNumber+1,ms:us/1000,percent:us/total*100})).filter(x=>x.url.includes('/src/domain/')).sort((a,b)=>b.ms-a.ms).slice(0,14)
const files=[];const collect=p=>{for(const f of fs.readdirSync(p,{withFileTypes:true})){const n=p+'/'+f.name;if(f.isDirectory())collect(n);else{const b=fs.readFileSync(n);files.push({file:n.slice(5),bytes:b.length,gzipBytes:gzipSync(b).length})}}};collect('dist')
const result={date:'2026-11-04',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),environment:{node:process.version,os:os.type()+' '+os.release(),arch:os.arch(),cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()},build:JSON.parse(fs.readFileSync('dist/version.json')),assets:files.sort((a,b)=>b.bytes-a.bytes),nodePerf:fs.readdirSync(d).filter(n=>/^(mixed|ordinary)-.*\.json$/.test(n)).map(read),profile:{totalMs:total/1000,self:mapped(self),inclusive:mapped(inclusive)},perfRun:read('perf-run.json')}
if(fs.existsSync(d+'/fixture-perf.json'))result.fixturePerf=read('fixture-perf.json').map(x=>({...x,stats:Object.fromEntries(Object.entries(x.phases).map(([k,v])=>[k,stats(v)]))}))
if(fs.existsSync(d+'/perf-extended.json'))result.extendedRun=read('perf-extended.json')
if(fs.existsSync(d+'/browser-store.json')){const b=read('browser-store.json');result.browserStore={...b,timingStats:Object.fromEntries(Object.entries(b.timings).map(([k,v])=>[k,stats(v)]))}}
if(fs.existsSync(d+'/browser-production.json')){const b=read('browser-production.json');result.production={...b,cases:b.cases.map(c=>({...c,samples:undefined,stats:c.samples?{readyMs:stats(c.samples.map(v=>v.readyMs)),lcpMs:stats(c.samples.flatMap(v=>v.lcpMs===null?[]:[v.lcpMs])),maxLongTaskMs:stats(c.samples.map(v=>Math.max(0,...v.longTasks.map(t=>t.ms)))),cls:stats(c.samples.map(v=>v.cls)),resourceEncodedBytes:stats(c.samples.map(v=>v.resources.reduce((a,r)=>a+r.encoded,0))),resourceTransferBytes:stats(c.samples.map(v=>v.resources.reduce((a,r)=>a+r.transfer,0)))}:undefined,lastSample:c.samples?.at(-1)}))}}
fs.writeFileSync(d+'/summary.json',JSON.stringify(result,null,2));console.log(JSON.stringify({profile:result.profile,perf:result.nodePerf.map(r=>({kind:r.kind,rows:r.rows,phase:r.phase,median:r.medianMs,p95:r.p95Ms})),browserStore:result.browserStore?.timingStats,production:result.production?.cases.map(c=>({name:c.name,stats:c.stats}))},null,2))

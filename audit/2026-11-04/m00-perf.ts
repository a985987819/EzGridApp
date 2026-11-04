import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { buildLedger } from '../../src/domain/ledger'
import { snapshotViews } from '../../src/domain/ledgerSnapshot'
import { validateBackup } from '../../src/domain/backup'
import { dataset } from './dataset'
const [kind='mixed',size='1000',phase='ledger']=process.argv.slice(2),s=dataset(Number(size),kind)
const dir='.tmp/m00';fs.mkdirSync(dir,{recursive:true})
const input=JSON.stringify(s),hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
if(size==='1000'&&kind==='mixed')fs.writeFileSync(dir+'/synthetic-1000.json',input)
const run=()=>phase==='ledger'?buildLedger(s.records,s.stocks,{executions:s.rebuyExecutions,extraTargets:s.extraTargets,buyTargets:s.buyTargets,plans:s.plans,hedges:s.hedges,chainLinks:s.chainLinks}):phase==='views'?snapshotViews(s):validateBackup(s)
const results:number[]=[];let fingerprint='',last:unknown
for(let i=0;i<25;i++){
 const start=performance.now();last=run();const duration=performance.now()-start
 if(i>=5)results.push(duration)
 if(i===0)fingerprint=hash(last)
 if(i===24&&hash(last)!==fingerprint)throw Error('non-deterministic result')
 if(i===0)console.log(JSON.stringify({progress:'first',kind,rows:s.records.length,phase,ms:duration}))
}
if(JSON.stringify(s)!==input)throw Error('mutated input')
const ordered=results.slice().sort((a,b)=>a-b),ledger=phase==='ledger'?last as ReturnType<typeof buildLedger>:null
const result={kind,rows:s.records.length,stocks:s.stocks.length,phase,warmup:5,samples:20,medianMs:ordered[9]/2+ordered[10]/2,p95Ms:ordered[18],rawMs:results,outputHash:fingerprint,inputBytes:Buffer.byteLength(input),inputHash:hash(s),relationCounts:{executions:s.rebuyExecutions.length,hedges:s.hedges.length,chains:s.chainLinks.length,targets:s.extraTargets.length,buyTargets:s.buyTargets.length,receipts:s.bookingReceipts?.length},failedChecks:ledger?.checks.filter(c=>!c.ok),anomalies:ledger?.anomalies.reduce((a,x)=>({...a,[x.kind]:(a[x.kind]??0)+1}),{} as Record<string,number>),validation:phase==='validate'?last:undefined}
fs.writeFileSync(`${dir}/${kind}-${size}-${phase}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result))

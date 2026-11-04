import { spawn } from 'node:child_process'
import fs from 'node:fs'
fs.mkdirSync('.tmp/m00',{recursive:true})
const jobs=[['mixed','1000','ledger'],['mixed','1000','views'],['mixed','1000','validate'],['mixed','10000','ledger'],['ordinary','10000','ledger'],['mixed','10000','validate'],['mixed','10000','views'],['ordinary','50000','ledger'],['mixed','50000','ledger']]
if(process.argv[2]==='extended-10k')jobs.splice(0,jobs.length,['mixed','10000','ledger'])
const budget=process.argv[2]==='extended-10k'?180000:60000
const outcomes=[]
for(const [kind,size,phase] of jobs){
 const name=`${kind}-${size}-${phase}`;let output='',timedOut=false
 const child=spawn(process.execPath,['node_modules/vite-node/vite-node.mjs','audit/2026-11-04/m00-perf.ts',kind,size,phase],{stdio:['ignore','pipe','pipe']})
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
 const timer=setTimeout(()=>{timedOut=true;child.kill()},budget)
 const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer)
 fs.writeFileSync(`.tmp/m00/${name}.log`,output)
 const result={name,code,timedOut,totalBudgetSeconds:budget/1000,first:output.split('\n').find(l=>l.includes('"progress"'))};outcomes.push(result)
 console.log(JSON.stringify(result));fs.writeFileSync('.tmp/m00/'+(budget===60000?'perf-run.json':'perf-extended.json'),JSON.stringify(outcomes,null,2))
}

import fs from 'node:fs'
import {performance} from 'node:perf_hooks'
import {parseCsvText,parseWorkbook} from '../../src/io/parseWorkbook'
import {buildLedger} from '../../src/domain/ledger'
import {DEFAULT_STOCKS} from '../../src/domain/defaults'
import {buildRecordNoIndex} from '../../src/domain/recordNo'
const results=[]
for(const file of ['26年网格记录.xlsx','26年网格记录-交易记录.csv']){
 const data=fs.readFileSync('tests/fixtures/'+file),parse=()=>file.endsWith('.csv')?parseCsvText(data.toString('utf8')):parseWorkbook(data)
 const cold=performance.now(),p=await parse(),coldParseMs=performance.now()-cold
 const phases={parse:[] as number[],ledger:[] as number[],recordIndex:[] as number[]}
 for(let i=0;i<25;i++){
  let t=performance.now();await parse();if(i>=5)phases.parse.push(performance.now()-t)
  t=performance.now();buildLedger(p.records,DEFAULT_STOCKS);if(i>=5)phases.ledger.push(performance.now()-t)
  t=performance.now();buildRecordNoIndex(p.records);if(i>=5)phases.recordIndex.push(performance.now()-t)
 }
 results.push({file,rows:p.records.length,coldParseMs,phases})
}
fs.writeFileSync('.tmp/m00/fixture-perf.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results))

/** 普通导入股数闭环：真实 public AppProvider / IndexedDB，使用独立临时浏览器。
 * node e2e/importValidation.mjs http://127.0.0.1:5173
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9592
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
const profile = mkdtempSync(join(tmpdir(), 'grid-import-validation-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', 'about:blank'],
{ stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const problems = []
let socket, passed = 0
const check = (label, condition, detail) => {
  assert(condition, `${label}${detail ? ': ' + JSON.stringify(detail) : ''}`)
  passed++
  console.log('  PASS ' + label)
}
const header = '股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价'
const csv = rows => [header, ...rows].join('\n')
const mixed = csv(['T,2026-02-01,5,100,7,0,,', 'T,2026-02-02,6,100.5,8,,,'])
const validPair = csv(['T,2026-02-01,5,100,7,0,,', 'T,2026-02-02,6,200,8,,,'])
const valid = csv(['T,2026-02-01,5,100,7,0,,', 'T,2026-02-02,6,0,8,,,',
  'T,,7,,9,,,', 'T,2026-02-03,8,301,10,101,2026-02-04,'])

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch { /* starting */ }
    await pause(150)
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(arg => arg.description ?? arg.value).join(' '))
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP超时: ${method}`)) }, 20000)
    pending.set(next, { resolve, reject, timer })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  const run = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 200; i++) { if (await run(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('等待超时: ' + expression + '\n页面状态: ' + JSON.stringify(await run('({hash:location.hash,text:document.body.innerText.slice(0,1200)})')) + '\n运行时异常: ' + JSON.stringify(problems))
  }
  const act = expression => run(`(async()=>{${expression}})()`)
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.navigate', { url: BASE + '/#/manage?section=import' })
  await until(`document.querySelector('[data-nav=manage]')`)
  await run(String.raw`(async()=>{
    const main=await(await fetch(new URL('src/main.tsx',location.href))).text()
    const reactUrl=main.match(/from "([^"]*\/react\.js[^"]*)"/)?.[1]
    const clientUrl=main.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)?.[1]
    if(!reactUrl||!clientUrl)throw new Error('请使用dev服务：无法从main模块解析React依赖URL')
    const React=(await import(reactUrl)).default
    const {createRoot}=(await import(clientUrl)).default
    const source=await(await fetch(new URL('src/pages/OrdersPage.tsx',location.href))).text()
    const storeUrl=source.match(/from "([^"]*store.useApp[^"]*)"/)?.[1]
    if(!storeUrl)throw new Error('找不到公共AppProvider模块')
    const {AppProvider,useApp}=await import(storeUrl)
    const mount=document.createElement('div');mount.hidden=true;document.body.appendChild(mount)
    function Probe(){window.importApp=useApp();return null}
    createRoot(mount).render(React.createElement(AppProvider,null,React.createElement(Probe)))
    window.importDb=(await import(new URL('src/store/db.ts',location.href).href)).db
    window.importParser=await import(new URL('src/io/parseWorkbook.ts',location.href).href)
    window.importStable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
    window.importDbFacts=()=>importDb.transaction('r',importDb.tables,async()=>JSON.stringify(Object.fromEntries(await Promise.all(importDb.tables.map(async table=>[table.name,await table.toArray()])))))
    window.importControl=()=>({records:importApp.records.length,buyQty:importApp.ledger.totals.buyQty,sellQty:importApp.ledger.totals.sellQty,netQty:importApp.ledger.totals.netQty,profitCents:importApp.ledger.totals.profitCents})
  })()`)
  await until('window.importApp?.ready')
  await act(`await importApp.resetAll();await importApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10',enabled:true});const p=await importParser.parseCsvText(${JSON.stringify(csv(['T,2026-01-01,4,100,6,,,']))});await importApp.commitImport(p,'sentinel.csv')`)

  console.log('普通导入非法股数：整批拒绝且数据库不变')
  let outcome = await act(`const before=await importDbFacts();let error=null;try{const p=await importParser.parseCsvText(${JSON.stringify(mixed)});await importApp.commitImport(p,'mixed-invalid.csv')}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts(),counts:{records:await importDb.records.count(),batches:await importDb.batches.count(),audits:await importDb.auditLogs.count()}}`)
  check('合法行与100.5股非法行混合导入整批拒绝，记录/批次/审计均不变', Boolean(outcome.error) && outcome.unchanged, outcome)
  outcome = await act(`const p=await importParser.parseCsvText(${JSON.stringify(mixed)});const before=await importDbFacts();let error=null;try{await importApp.commitImport(p,'mixed-skip-invalid.csv',{[p.records.at(-1).sourceRow]:'skip'})}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
  check('不能用跳过非法行的导入选择绕开整批校验', Boolean(outcome.error) && outcome.unchanged, outcome)

  for (const field of ['buyQtyRaw', 'soldQty']) {
    for (const [label, value] of [['负数', '-1'], ['小数', '100.5'], ['Infinity', 'Infinity'], ['不安全整数', 'Number.MAX_SAFE_INTEGER+1']]) {
      outcome = await act(`const p=await importParser.parseCsvText(${JSON.stringify(validPair)});p.records[1].${field}=${value};const before=await importDbFacts();let error=null;try{await importApp.commitImport(p,'tampered-${field}-${label}.csv')}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
      check(`直接调用commitImport拒绝${field}为${label}，不留下部分导入`, Boolean(outcome.error) && outcome.unchanged, outcome)
    }
  }

  console.log('金额乘积与多笔累计的安全整数边界')
  for (const [label, mutation] of [
    ['买入金额', 'p.records[1].buyPriceCents=10000000000;p.records[1].buyQtyRaw=10000000000'],
    ['卖出金额', 'p.records[1].targetPriceCents=10000000000;p.records[1].soldQty=10000000000'],
  ]) {
    outcome = await act(`const p=await importParser.parseCsvText(${JSON.stringify(validPair)});${mutation};const before=await importDbFacts();let error=null;try{await importApp.commitImport(p,'unsafe-product.csv')}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
    check(`价与股数分别合法但${label}乘积超限时整批拒绝`, Boolean(outcome.error) && outcome.unchanged, outcome)
  }
  outcome = await act(`const before=await importDbFacts();let error=null;try{await importApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-03-01',price:'100000000',qty:'10000000000'})}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
  check('手动成交公共入口也拒绝超安全整数金额乘积，不写回执或记录', Boolean(outcome.error) && outcome.unchanged, outcome)
  const largeRows = [1, 2, 3].map(day => `T,2026-04-0${day},40000000000000,1,40000000000001,0,,`)
  outcome = await act(`const p=await importParser.parseCsvText(${JSON.stringify(csv(largeRows))}),before=await importDbFacts();let error=null;try{await importApp.commitImport(p,'unsafe-aggregate.csv')}catch(e){error=e.message}const rows=await importDb.records.toArray(),total=rows.reduce((sum,row)=>sum+(row.buyPriceCents??0)*(row.buyQtyRaw??0),0);return {error,unchanged:before===await importDbFacts(),total,totalSafe:Number.isSafeInteger(total),exactTotal:rows.reduce((sum,row)=>sum+BigInt(row.buyPriceCents??0)*BigInt(row.buyQtyRaw??0),0n).toString()}`)
  check('每笔金额均安全但多笔累计超限时整批拒绝且原库不变', Boolean(outcome.error) && outcome.unchanged, outcome)
  await act(`const p=await importParser.parseCsvText(${JSON.stringify(csv(largeRows.slice(0, 2)))});await importApp.commitImport(p,'safe-large-pair.csv')`)
  outcome = await act(`const p=await importParser.parseCsvText(${JSON.stringify(csv(largeRows.slice(2)))}),before=await importDbFacts();let error=null;try{await importApp.commitImport(p,'unsafe-across-imports.csv')}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
  check('分批导入也检查与现有台账累计的金额上限', Boolean(outcome.error) && outcome.unchanged, outcome)
  outcome = await act(`const before=await importDbFacts();let error=null;try{await importApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-04-03',price:'40000000000000',qty:'1'})}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
  check('单笔合法的手动成交不能使既有台账累计金额超限', Boolean(outcome.error) && outcome.unchanged, outcome)
  outcome = await act(`const p=await importParser.parseCsvText(${JSON.stringify(validPair)});for(const record of p.records){record.buyPriceCents=500;record.buyQtyRaw=10000000000000;record.qtyNeedsDerive=true}const before=await importDbFacts();let error=null;try{await importApp.commitImport(p,'raw-qty-with-derive-flag.csv')}catch(e){error=e.message}return {error,unchanged:before===await importDbFacts()}`)
  check('非空实际股数优先于旧推定标记，不能借标记绕过累计上限', Boolean(outcome.error) && outcome.unchanged, outcome)

  console.log('非法日期阻断与真实1904工作簿日期换算')
  for (const [field, badCsv] of [
    ['buyDateSerial', csv(['T,2026-02-01,5,100,7,0,,', 'T,2026-02-30,6,200,8,,,'])],
    ['sellDateSerial', csv(['T,2026-02-01,5,100,7,0,,', 'T,2026-02-02,6,200,8,100,2026-04-31,'])],
  ]) {
    outcome = await act(`const before=await importDbFacts(),p=await importParser.parseCsvText(${JSON.stringify(badCsv)});let error=null;try{await importApp.commitImport(p,'invalid-date.csv')}catch(e){error=e.message}return {error,issues:p.validationIssues,unchanged:before===await importDbFacts(),parsed:p.records[1].${field}}`)
    check(`不存在的${field}在预览定位且整批拒绝，不推进成别的真实日期`, Boolean(outcome.error) && outcome.unchanged
      && outcome.parsed === null && outcome.issues?.some(issue => issue.sourceRow === 3 && issue.field === field), outcome)
  }
  outcome = await act(`await importApp.resetAll();const X=await importParser.loadXlsx(),wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([${JSON.stringify(header.split(','))},['T',44500,5,100,7,0,null,null],['T','2025-11-01',6,200,8,100,'2025-11-02',null]]),'交易记录');wb.Workbook={WBProps:{date1904:true}};const p=await importParser.parseWorkbook(X.write(wb,{type:'array',bookType:'xlsx'}));const{serialToIso}=await import(new URL('src/domain/defaults.ts',location.href).href);await importApp.commitImport(p,'date1904.xlsx');return {issues:p.validationIssues,dates:(await importDb.records.toArray()).map(r=>({buy:serialToIso(r.buyDateSerial),sell:serialToIso(r.sellDateSerial)}))}`)
  check('真实1904工作簿的数字日期加1462天，文本日期保持同一真实日', !(outcome.issues?.length)
    && outcome.dates.length === 2 && outcome.dates.every(record => record.buy === '2025-11-01') && outcome.dates[1].sell === '2025-11-02', outcome)
  await until('importApp.records.length===2&&importApp.ledger.totals.buyQty===300')
  check('1904日期转换经公共导入后账务控制数买300/卖100/净200', await run('importApp.ledger.totals.sellQty===100&&importApp.ledger.totals.netQty===200&&importApp.ledger.totals.profitCents===20000'))
  outcome = await act(`const original=JSON.parse(await importApp.exportBackup()),api=await import(new URL('src/io/ledgerWorkbook.ts',location.href).href);await importApp.resetAll();await importApp.restoreBackup(JSON.stringify(original));const afterJson=await importDb.records.toArray(),preview=await api.parseLedgerWorkbook(await api.exportLedgerWorkbook(original));await importApp.resetAll();await importApp.restoreBackup(JSON.stringify(preview.snapshot));return {jsonSame:importStable(afterJson)===importStable(original.records),excelSame:importStable(await importDb.records.toArray())===importStable(original.records),differences:preview.differences.length}`)
  check('1904来源经JSON与完整Excel恢复不再次位移日期，原始记录一致', outcome.jsonSame && outcome.excelSame && outcome.differences === 0, outcome)

  console.log('合法股数、幂等重导与完整备份恢复')
  outcome = await act(`await importApp.resetAll();const p=await importParser.parseCsvText(${JSON.stringify(valid)});window.importValidParsed=p;const result=await importApp.commitImport(p,'valid-quantities.csv');return {result,records:await importDb.records.toArray()}`)
  check('null、0与普通整数股数均可提交，原始值保留', outcome.result.added === 4
    && outcome.records[0].buyQtyRaw === 100 && outcome.records[0].soldQty === 0
    && outcome.records[1].buyQtyRaw === 0 && outcome.records[1].soldQty === null
    && outcome.records[2].buyQtyRaw === null && outcome.records[3].buyQtyRaw === 301 && outcome.records[3].soldQty === 101, outcome)
  await until('importApp.records.length===4')
  outcome = await act(`const before=JSON.stringify(await importDb.records.toArray());const result=await importApp.commitImport(importValidParsed,'valid-quantities-again.csv');return {result,unchanged:before===JSON.stringify(await importDb.records.toArray())}`)
  check('同一文件幂等重导不新增或改写记录', outcome.result.added === 0 && outcome.result.updated === 0 && outcome.result.duplicated === 4 && outcome.unchanged, outcome)
  await act(`const parent=(await importDb.records.toArray()).find(r=>r.buyPriceCents===500);await importApp.recordLotSales([{lotId:'lot:'+parent.sourceRow,qty:50}],50,700,'2026-02-05')`)
  await until('importApp.records.length===5')
  outcome = await act(`const snapshot=JSON.parse(await importApp.exportBackup());const control=importControl();window.importSavedSnapshot=snapshot;window.importSavedControl=control;return {control,child:snapshot.records.find(r=>r.soldLotId),receipt:snapshot.bookingReceipts.find(r=>r.kind==='sell')}`)
  check('合法导入后子卖出保留来源关系和成交回执，控制数买401/卖151/净250', outcome.control.buyQty === 401 && outcome.control.sellQty === 151 && outcome.control.netQty === 250
    && outcome.control.profitCents === 30200 && outcome.child?.soldLotId && outcome.receipt?.recordRows.includes(outcome.child.sourceRow), outcome)
  outcome = await act(`await importApp.resetAll();await importApp.restoreBackup(JSON.stringify(importSavedSnapshot));const restored=JSON.parse(await importApp.exportBackup());return {same:['records','batches','auditLogs','bookingReceipts','rebuyExecutions','plans','extraTargets','buyTargets','hedges','merges','chainLinks','stocks','settings'].every(key=>importStable(restored[key])===importStable(importSavedSnapshot[key]))}`)
  await until('importApp.records.length===5')
  check('JSON整库恢复逐表保持原始记录、关系与回执', outcome.same, outcome)
  check('JSON恢复后账务控制数不变', await run('JSON.stringify(importControl())===JSON.stringify(importSavedControl)'))
  outcome = await act(`const api=await import(new URL('src/io/ledgerWorkbook.ts',location.href).href);const bytes=await api.exportLedgerWorkbook(importSavedSnapshot);const preview=await api.parseLedgerWorkbook(bytes);window.importExcelSnapshot=preview.snapshot;return {differences:preview.differences.length,same:['records','batches','auditLogs','bookingReceipts','rebuyExecutions','plans','extraTargets','buyTargets','hedges','merges','chainLinks','stocks','settings'].every(key=>importStable(preview.snapshot[key])===importStable(importSavedSnapshot[key]))}`)
  check('完整Excel导出解析无核对差异，股数与所有关系逐表一致', outcome.differences === 0 && outcome.same, outcome)
  await act(`await importApp.resetAll();await importApp.restoreBackup(JSON.stringify(importExcelSnapshot))`)
  await until('importApp.records.length===5')
  check('完整Excel恢复后账务控制数不变', await run('JSON.stringify(importControl())===JSON.stringify(importSavedControl)'))

  for (const [file, controls] of [['26年网格记录.xlsx', { buyQty: 31800, sellQty: 18600, netQty: 13200, profitCents: 797000 }],
    ['26年网格记录-交易记录.csv', { buyQty: 33300, sellQty: 18600, netQty: 14700, profitCents: 306100 }]]) {
    const bytes = [...readFileSync(join(process.cwd(), 'tests', 'fixtures', file))]
    outcome = await act(`await importApp.resetAll();const bytes=new Uint8Array(${JSON.stringify(bytes)});const parsed=${file.endsWith('.csv') ? 'await importParser.parseCsvText(new TextDecoder().decode(bytes))' : 'await importParser.parseWorkbook(bytes)'};await importApp.commitImport(parsed,${JSON.stringify(file)});return {count:await importDb.records.count()}`)
    await until(`importApp.records.length===62&&${Object.entries(controls).map(([key, value]) => `importApp.ledger.totals.${key}===${value}`).join('&&')}`)
    const actual = await run('importControl()')
    check(`${file}经公共导入保留62行和原账务控制数`, outcome.count === 62 && Object.entries(controls).every(([key, value]) => actual[key] === value), actual)
    outcome = await act(`const original=JSON.parse(await importApp.exportBackup());const{validateBackup}=await import(new URL('src/domain/backup.ts',location.href).href);return {validation:validateBackup(original),records:original.records.length}`)
    check(`${file}导出JSON可通过恢复校验`, outcome.validation === null && outcome.records === 62, outcome)
  }
  check('浏览器无运行时异常', problems.length === 0, problems)
  console.log(`IMPORT VALIDATION E2E PASS (${passed} checks)`)
} finally {
  socket?.close()
  browser.kill()
  await pause(400)
  const resolvedProfile = resolve(profile)
  assert(resolvedProfile.startsWith(resolve(tmpdir()) + sep) && basename(resolvedProfile).startsWith('grid-import-validation-'), '拒绝清理临时浏览器目录之外的路径')
  try { rmSync(resolvedProfile, { recursive: true, force: true }) } catch { /* Windows may retain a temporary browser file briefly */ }
}

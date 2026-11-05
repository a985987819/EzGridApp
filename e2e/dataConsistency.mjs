/** 当前快照校验、多标签一致性与清空失败原子性。仅使用临时Chrome profile。
 * node e2e/dataConsistency.mjs http://127.0.0.1:5173
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const SENTINEL = '股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\nT,2026-02-01,5,100,7,0,,'
const PORT = 9593
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
const profile = mkdtempSync(join(tmpdir(), 'grid-data-consistency-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', 'about:blank'],
{ stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const problems = [], sockets = []
let passed = 0
const check = (label, condition, detail) => {
  assert(condition, `${label}${detail ? ': ' + JSON.stringify(detail) : ''}`)
  passed++
  console.log('  PASS ' + label)
}

async function connect() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  sockets.push(socket)
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
  const until = async (expression, timeout = 10000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await run(`Boolean(${expression})`)) return true; await pause(100) }
    return false
  }
  const act = expression => run(`(async()=>{${expression}})()`)
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.navigate', { url: BASE + '/#/manage' })
  assert(await until(`document.querySelector('[data-nav=manage]')`, 20000), '应用未就绪: ' + JSON.stringify(problems))
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
    function Probe(){window.consistencyApp=useApp();return null}
    createRoot(mount).render(React.createElement(AppProvider,null,React.createElement(Probe)))
    window.consistencyDb=(await import(new URL('src/store/db.ts',location.href).href)).db
    window.consistencyFacts=()=>consistencyDb.transaction('r',consistencyDb.tables,async()=>JSON.stringify(Object.fromEntries(await Promise.all(consistencyDb.tables.map(async table=>[table.name,await table.toArray()])))))
    window.consistencyStable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
  })()`)
  assert(await until('window.consistencyApp?.ready'), '公共AppProvider未就绪')
  return { send, run, until, act }
}

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch { /* starting */ }
    await pause(150)
  }
  const a = await connect()
  await a.act(`await consistencyApp.resetAll();await consistencyApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10',enabled:true});const{parseCsvText}=await import(new URL('src/io/parseWorkbook.ts',location.href).href);await consistencyApp.commitImport(await parseCsvText(${JSON.stringify(SENTINEL)}),'consistency.csv')`)
  const b = await connect()
  assert(await b.until('consistencyApp.records.length===1'), '第二标签未读取同一数据库')
  await b.run('window.consistencyOldExport=consistencyApp.exportBackup')
  console.log('两个真实标签的记录与计算设置一致性')
  await a.act(`consistencyApp.setDeriveSellPrice(true);await consistencyApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-02-02',price:'6',qty:'200'})`)
  assert(await a.until(`consistencyApp.records.length===2 && consistencyApp.deriveSellPrice`), '首个标签写入未完成')
  const refreshed = await b.until('consistencyApp.records.length===2 && consistencyApp.deriveSellPrice', 5000)
  let outcome = await b.act(`const snapshot=JSON.parse(await consistencyApp.exportBackup()),priorCallback=JSON.parse(await consistencyOldExport());return {records:consistencyApp.records.length,derive:consistencyApp.deriveSellPrice,dbDerive:(await consistencyDb.meta.get('deriveSellPrice'))?.value,exportedRecords:snapshot.records.length,exportedDerive:snapshot.settings.deriveSellPrice,priorCallbackRecords:priorCallback.records.length,priorCallbackDerive:priorCallback.settings.deriveSellPrice}`)
  check('另一标签自动刷新记录和计算设置', refreshed, outcome)
  check('导出快照包含同一数据库版本的记录和计算设置', outcome.exportedRecords === 2 && outcome.exportedDerive === true && outcome.dbDerive === 'true', outcome)
  check('设置更新前捕获的导出回调仍从数据库读取设置', outcome.priorCallbackRecords === 2 && outcome.priorCallbackDerive === true, outcome)
  outcome = await a.act(`const before=await consistencyFacts();const{readLedgerSnapshot}=await import(new URL('src/store/readSnapshot.ts',location.href).href);const snapshot=await readLedgerSnapshot();return {unchanged:before===await consistencyFacts(),records:snapshot.records.length,derive:snapshot.settings.deriveSellPrice}`)
  check('通用快照读取不更新备份时间或写入其它表', outcome.unchanged && outcome.records === 2 && outcome.derive === true, outcome)

  console.log('当前结构严格校验，拒绝恢复时原库不变')
  await a.act('window.consistencyGood=JSON.parse(await consistencyApp.exportBackup())')
  for (const [label, mutation] of [
    ['仅含三个身份字段', "s.records[0]={sourceRow:s.records[0].sourceRow,stockName:'T',importKey:'minimal'}"],
    ['缺买入数量字段', 'delete s.records[0].buyQtyRaw'],
    ['缺推定标记字段', 'delete s.records[0].qtyNeedsDerive'],
    ['缺交易记录表', 'delete s.records'],
    ['缺股票配置表', 'delete s.stocks'],
    ['缺计算设置', 'delete s.settings'],
    ['不安全主键', 's.records[0].sourceRow=Number.MAX_SAFE_INTEGER+1'],
    ['零主键', 's.records[0].sourceRow=0'],
    ['负主键', 's.records[0].sourceRow=-1'],
    ['多笔累计金额超限', "s.records=Array.from({length:3},(_,index)=>({...s.records[0],sourceRow:200+index,importKey:'aggregate:'+index,buyPriceCents:4000000000000000,buyQtyRaw:1,targetPriceCents:4000000000000100,soldQty:0,qtyNeedsDerive:false}));s.bookingReceipts=[]"],
    ['回补成交指向没有实际卖出的来源', "s.rebuyExecutions=[{id:'exec:without-sale',orderId:'rb:sell:'+s.records[0].sourceRow,sellExecId:'sell:'+s.records[0].sourceRow,stockId:'stock:T',stockName:'T',qty:100,priceCents:400,rewardQty:0,groupKeyAtExecution:'stock:T|400',at:1793000000000}]"],
  ]) {
    outcome = await a.act(`const s=structuredClone(consistencyGood);${mutation};const before=await consistencyFacts();let error=null;try{await consistencyApp.restoreBackup(JSON.stringify(s))}catch(e){error=e.message}return {error,unchanged:before===await consistencyFacts()}`)
    check(`结构14拒绝${label}，不覆盖任何表`, Boolean(outcome.error) && outcome.unchanged, outcome)
  }
  for (const version of [11, 13]) {
    outcome = await a.act(`const s=structuredClone(consistencyGood);s.schemaVersion=${version};${version === 11 ? 'delete s.bookingReceipts;' : ''}await consistencyApp.restoreBackup(JSON.stringify(s));const restored=JSON.parse(await consistencyApp.exportBackup());return {recordsEqual:consistencyStable(s.records)===consistencyStable(restored.records),stocksEqual:consistencyStable(s.stocks)===consistencyStable(restored.stocks),records:restored.records.length,derive:restored.settings.deriveSellPrice}`)
    check(`合法旧结构${version}可迁移恢复且保留记录和计算设置`, outcome.recordsEqual && outcome.stocksEqual && outcome.records === 2 && outcome.derive === true, outcome)
  }
  outcome = await a.act(`const s=structuredClone(consistencyGood);s.schemaVersion=13;s.records=[{sourceRow:2,stockName:'T',importKey:'legacy-minimal'}];s.bookingReceipts=[];s.batches=[];s.auditLogs=[];await consistencyApp.restoreBackup(JSON.stringify(s));const record=(await consistencyDb.records.toArray())[0];return {nullable:['buyDateSerial','buyPriceCents','buyQtyRaw','targetPriceCents','soldQty','sellDateSerial','earlyBuyPriceCents','rawProfitCents'].every(key=>record[key]===null),flags:record.qtyNeedsDerive===false&&record.targetNeedsDerive===false,records:await consistencyDb.records.count()}`)
  check('旧结构13缺省字段经迁移补成null与false，不借用当前记录', outcome.nullable && outcome.flags && outcome.records === 1, outcome)
  await a.act('await consistencyApp.restoreBackup(JSON.stringify(consistencyGood))')

  console.log('删除与卖出并发时保留完整来源')
  outcome = await a.act(`const row=consistencyGood.records[0].sourceRow;const results=await Promise.allSettled([consistencyApp.softDelete(row),consistencyApp.recordLotSales([{lotId:'lot:'+row,qty:50}],50,700,'2026-02-05')]);const records=await consistencyDb.records.toArray(),parent=records.find(record=>record.sourceRow===row),children=records.filter(record=>record.soldLotId==='lot:'+row&&!record.deletedAt);return {statuses:results.map(result=>result.status),errors:results.filter(result=>result.status==='rejected').map(result=>result.reason.message),orphan:Boolean(parent?.deletedAt)&&children.length>0}`)
  check('并发删除来源与记卖出只能一项成功，不能留下活跃孤儿卖出', !outcome.orphan && outcome.statuses.filter(status => status === 'fulfilled').length === 1, outcome)
  await a.act('await consistencyApp.restoreBackup(JSON.stringify(consistencyGood))')
  outcome = await a.act(`const row=consistencyGood.records[0].sourceRow,batchId=consistencyGood.records[0].batchId;const results=await Promise.allSettled([consistencyApp.rollbackBatch(batchId),consistencyApp.recordLotSales([{lotId:'lot:'+row,qty:50}],50,700,'2026-02-05')]);const records=await consistencyDb.records.toArray(),parent=records.find(record=>record.sourceRow===row),children=records.filter(record=>record.soldLotId==='lot:'+row&&!record.deletedAt);return {statuses:results.map(result=>result.status),errors:results.filter(result=>result.status==='rejected').map(result=>result.reason.message),orphan:!parent&&children.length>0}`)
  check('并发回滚导入与记卖出只能一项成功，不能物理删除成交来源', !outcome.orphan && outcome.statuses.filter(status => status === 'fulfilled').length === 1, outcome)
  await a.act('await consistencyApp.restoreBackup(JSON.stringify(consistencyGood))')

  console.log('沙盒关联的买入与卖出转正必须作为整体提交')
  await a.act(`consistencyApp.addSandboxItem({kind:'buy',stockName:'T',date:'2026-06-01',priceCents:1000,qty:100,targetPriceCents:1200,rebuyPriceCents:null});consistencyApp.addSandboxItem({kind:'sell',stockName:'T',date:'2026-06-02',priceCents:700,qty:100,targetPriceCents:null,rebuyPriceCents:500})`)
  assert(await a.until('consistencyApp.sandbox.items.length===2'), '两条沙盒模拟未创建')
  await a.act(`const buy=consistencyApp.sandbox.items.find(item=>item.kind==='buy'),sell=consistencyApp.sandbox.items.find(item=>item.kind==='sell');window.consistencySandboxSellId=sell.id;consistencyApp.setSandboxHedge(300000+sell.seq,[{row:300000+buy.seq,qty:100}])`)
  assert(await a.until('consistencyApp.sandbox.hedges.length===1'), '沙盒关联未创建')
  outcome = await a.act(`const before=await consistencyFacts(),sandboxBefore=consistencyStable(consistencyApp.sandbox),original=consistencyDb.records.add;let calls=0,error=null;consistencyDb.records.add=function(...args){calls++;return calls===2?Promise.reject(new Error('e2e injected sandbox second add failure')):original.apply(this,args)};try{await consistencyApp.commitSandboxItem(consistencySandboxSellId)}catch(e){error=e.message}finally{consistencyDb.records.add=original}return {error,calls,unchanged:before===await consistencyFacts(),sandboxUnchanged:sandboxBefore===consistencyStable(consistencyApp.sandbox),records:await consistencyDb.records.count(),receipts:await consistencyDb.bookingReceipts.count(),audits:await consistencyDb.auditLogs.count()}`)
  check('沙盒第二条转正失败时记录/回执/审计全部回滚，两条模拟和关联保留', outcome.error?.includes('sandbox second add failure') && outcome.calls === 2 && outcome.unchanged && outcome.sandboxUnchanged, outcome)
  outcome = await a.act(`const result=await consistencyApp.commitSandboxItem(consistencySandboxSellId),records=await consistencyDb.records.toArray(),hedge=(await consistencyDb.hedges.toArray()).find(link=>link.sellRow===result.row),buy=records.find(record=>record.sourceRow===hedge?.items[0]?.row);return {result,records:records.length,linkedBuyPrice:buy?.buyPriceCents,linkedQty:hedge?.items[0]?.qty,receipts:await consistencyDb.bookingReceipts.count()}`)
  check('移除故障后重试一次转正两条记录，挂钩映射到真实买入来源', outcome.result?.committed === 2 && outcome.records === 4 && outcome.linkedBuyPrice === 1000 && outcome.linkedQty === 100, outcome)
  check('转正成功后才移除沙盒条目及其模拟关联', await a.until('consistencyApp.sandbox.items.length===0&&consistencyApp.sandbox.hedges.length===0'))
  await a.act('await consistencyApp.restoreBackup(JSON.stringify(consistencyGood))')

  console.log('清空失败必须整库回滚')
  outcome = await a.act(`const before=await consistencyFacts(),original=consistencyDb.plans.clear;let error=null;consistencyDb.plans.clear=()=>Promise.reject(new Error('e2e injected clear failure'));try{await consistencyApp.resetAll()}catch(e){error=e.message}finally{consistencyDb.plans.clear=original}return {error,unchanged:before===await consistencyFacts(),records:await consistencyDb.records.count(),batches:await consistencyDb.batches.count()}`)
  check('清空任一表失败时其它交易/批次/审计全部回滚', outcome.error?.includes('injected clear failure') && outcome.unchanged && outcome.records === 2, outcome)
  await a.act('await consistencyApp.resetAll()')
  check('成功清空一次性清除所有业务表并保留股票配置', await a.act(`return {empty:(await Promise.all(['records','batches','auditLogs','rebuyExecutions','plans','extraTargets','buyTargets','hedges','merges','chainLinks','bookingReceipts'].map(name=>consistencyDb[name].count()))).every(count=>count===0),stocks:await consistencyDb.stocks.count()}`)
    .then(value => value.empty && value.stocks > 0))
  check('清空后另一标签自动同步为空台账', await b.until('consistencyApp.records.length===0', 5000))
  console.log('沙盒已提交后的只读刷新失败不能误报记账失败')
  await a.act(`consistencyApp.addSandboxItem({kind:'buy',stockName:'T',date:'2026-07-01',priceCents:1100,qty:100,targetPriceCents:1300,rebuyPriceCents:null});consistencyApp.addSandboxItem({kind:'sell',stockName:'T',date:'2026-07-02',priceCents:800,qty:100,targetPriceCents:null,rebuyPriceCents:600})`)
  assert(await a.until('consistencyApp.sandbox.items.length===2'), '刷新故障用的沙盒模拟未创建')
  await a.act(`const buy=consistencyApp.sandbox.items.find(item=>item.kind==='buy'),sell=consistencyApp.sandbox.items.find(item=>item.kind==='sell');window.consistencySandboxSellId=sell.id;consistencyApp.setSandboxHedge(300000+sell.seq,[{row:300000+buy.seq,qty:100}])`)
  assert(await a.until('consistencyApp.sandbox.hedges.length===1'), '刷新故障用的沙盒关联未创建')
  outcome = await a.act(`const add=consistencyDb.records.add,read=consistencyDb.records.toArray;let added=0,afterFlag=false,readFailures=0,error=null,result=null;consistencyDb.records.add=async function(...args){const value=await add.apply(this,args);if(++added===2)afterFlag=true;return value};consistencyDb.records.toArray=function(...args){const tx=consistencyDb.constructor.currentTransaction;let writeAncestor=false;for(let current=tx;current;current=current.parent)if(current.mode==='readwrite')writeAncestor=true;if(afterFlag&&tx?.mode==='readonly'&&!writeAncestor){readFailures++;return Promise.reject(new Error('e2e injected sandbox refresh failure'))}return read.apply(this,args)};try{result=await consistencyApp.commitSandboxItem(consistencySandboxSellId)}catch(e){error=e.message}finally{consistencyDb.records.add=add;consistencyDb.records.toArray=read}const records=await consistencyDb.records.toArray(),receipts=await consistencyDb.bookingReceipts.toArray();return {error,result,added,readFailures,records:records.length,receipts:receipts.length,uniqueAllocations:new Set(receipts.flatMap(receipt=>receipt.recordRows)).size}`)
  check('两笔写入成功后仅只读刷新失败仍返回成功，记录和回执不重复', outcome.error === null && outcome.result?.committed === 2
    && outcome.added === 2 && outcome.readFailures >= 1 && outcome.records === 2 && outcome.receipts === 2 && outcome.uniqueAllocations === 2, outcome)
  check('只读刷新失败也移除已经成功转正的模拟，避免误导用户再次记账', await a.until('consistencyApp.sandbox.items.length===0&&consistencyApp.sandbox.hedges.length===0'))
  check('浏览器无运行时异常', problems.length === 0, problems)
  console.log(`DATA CONSISTENCY E2E PASS (${passed} checks)`)
} finally {
  for (const socket of sockets) socket.close()
  browser.kill()
  await pause(400)
  const resolvedProfile = resolve(profile)
  assert(resolvedProfile.startsWith(resolve(tmpdir()) + sep) && basename(resolvedProfile).startsWith('grid-data-consistency-'), '拒绝清理临时浏览器目录之外的路径')
  try { rmSync(resolvedProfile, { recursive: true, force: true }) } catch { /* Windows may retain a temporary browser file briefly */ }
}

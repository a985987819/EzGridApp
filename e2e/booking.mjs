/**
 * 真实 IndexedDB 与 React store 的记账回归（移动端 390×844 视口）：
 * 分链 → 回补 → 部分卖出 → 多轮循环 → 依赖保护 → 建议成交 → 备份恢复 → 增量导入。
 *
 *   node e2e/accounting.mjs http://127.0.0.1:5173
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9446
const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const OUT = join(process.cwd(), 'e2e', 'out')
mkdirSync(OUT, { recursive: true })

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const browserPath = CANDIDATES.find((p) => existsSync(p))
if (!browserPath) {
  console.error('找不到 Chrome/Edge，请设置 CHROME_PATH')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'grid-e2e-'))
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const problems = []
let ok = true

function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    ok = false
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) break
    } catch {
      /* keep waiting */
    }
    await sleep(250)
  }

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(JSON.stringify(m.error)))
      else resolve(m.result)
      return
    }
    if (m.method) listeners.forEach((fn) => fn(m))
  })
  await new Promise((res, rej) => {
    socket.addEventListener('open', () => res())
    socket.addEventListener('error', rej)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  const IGNORED = /favicon|net::ERR_|React DevTools|DevTools failed|\[vite\]|WebSocket/i
  listeners.add((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      problems.push(`exception: ${d.exception?.description ?? d.text}`)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = m.params.args.map((a) => a.description ?? a.value ?? a.type).join(' ')
      if (!IGNORED.test(text)) problems.push(`console.error: ${text}`)
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const entry = m.params.entry
      if (!IGNORED.test(`${entry.text} ${entry.url ?? ''}`)) problems.push(`log: ${entry.text} ${entry.url ?? ''}`)
    }
  })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const settle = async (budget = 6000) => {
    let prev = -1
    let stable = 0
    const deadline = Date.now() + budget
    while (Date.now() < deadline && stable < 2) {
      await sleep(200)
      const len = await evaluate(`(document.getElementById('root')?.innerHTML ?? '').length`)
      stable = len > 0 && len === prev ? stable + 1 : 0
      prev = len
    }
  }
  const bodyText = () => evaluate(`document.body.innerText`)

  await send('Page.navigate',{url:BASE})
  await settle()
  await evaluate(`(async()=>{
    const React=(await import('/node_modules/.vite/deps/react.js')).default
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source=await (await fetch('/src/pages/OrdersPage.tsx')).text()
    const storeUrl=source.match(new RegExp('from "([^"]*store.useApp[^"]*)"'))[1]
    const {AppProvider,useApp}=await import(storeUrl)
    const {OrdersPage}=await import('/src/pages/OrdersPage.tsx')
    document.getElementById('root').style.display='none'
    const el=document.createElement('div');el.id='accounting-root';document.body.appendChild(el)
    function Probe(){const a=useApp();window.testApp=a;return a.ready?React.createElement(OrdersPage,{goTrades:()=>{}}):null}
    createRoot(el).render(React.createElement(AppProvider,null,React.createElement(Probe)))
  })()`)
  await settle()
  const state=()=>evaluate(`({records:testApp.records,totals:testApp.ledger.totals,chains:testApp.ledger.repairChains.map(c=>({row:c.anchorRow,loss:c.lossCents,profit:c.profitCents,holding:c.holdingQty})),checks:testApp.ledger.checks.filter(c=>!c.ok),targets:testApp.ledger.targets,orders:testApp.ledger.orders,executions:testApp.executions})`)
  const act=async(expr)=>{const r=await evaluate(`(async()=>{${expr}})()`);await sleep(120);return r}
  const rejects=async(expr)=>act(`try{${expr};return false}catch(e){return e.message}`)
  const click=async(selector)=>{const v=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);await sleep(250);return v}
  const input=async(field,value)=>{await evaluate(`(()=>{const e=document.querySelector('[data-field="${field}"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(100)}
  console.log('\n[1] 真实数据库：操作幂等、并发、跨入口防重')
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});testApp.patchOrdersSession({stockName:'T',closes:{T:'7'},confirmedCents:{T:700},overrides:{}})`)
  const once=await act(`const input={kind:'buy',stockName:'T',date:'2026-10-20',price:'5',qty:'500',targetPrice:'7'};window.bookingInput=input;return await Promise.all([testApp.addManualRecord(input,{commandId:'same-op'}),testApp.addManualRecord(input,{commandId:'same-op'})])`)
  check('并发重试同一操作返回同一记录，库存只增加500',once[0]===once[1]&&(await state()).totals.buyQty===500)
  check('同编号不同内容明确报冲突',Boolean(await rejects(`await testApp.addManualRecord({...bookingInput,qty:'400'},{commandId:'same-op'})`)))
  const parallel=await act(`return await Promise.all([testApp.addManualRecord({...bookingInput,price:'6'},{commandId:'parallel-a'}),testApp.addManualRecord({...bookingInput,price:'8'},{commandId:'parallel-b'})])`)
  check('独立并发新增不覆盖，主键不同且两笔都在',parallel[0]!==parallel[1]&&(await state()).records.length===3)
  check('不同操作录入相同事实会提示候选，且不写库',Boolean(await rejects(`await testApp.addManualRecord(bookingInput,{commandId:'similar'})`))&&(await state()).records.length===3)
  await act(`await testApp.addManualRecord(bookingInput,{commandId:'real-second',allowSimilar:true,externalRef:'Broker/20261020/fill-002'})`)
  check('确认另一笔同条件成交可以保留',(await state()).records.length===4)
  const external=await act(`return await testApp.addManualRecord(bookingInput,{commandId:'retry-external',externalRef:'Broker/20261020/fill-002'})`)
  check('同凭据重试返回原事实，不新增',(await state()).records.length===4&&external!==undefined)
  check('凭据相同而方向价量不同拒绝',Boolean(await rejects(`await testApp.addManualRecord({...bookingInput,qty:'200'},{externalRef:'Broker/20261020/fill-002'})`)))
  await act(`await testApp.softDelete(${external})`)
  check('软删事实后同凭据不能假报保存成功',Boolean(await rejects(`await testApp.addManualRecord(bookingInput,{commandId:'deleted-ref',externalRef:'Broker/20261020/fill-002'})`)))
  await act(`await testApp.restore(${external})`)

  console.log('\n[2] 合并成交原子分配、统一流水及整笔撤销')
  await act(`window.sellReceipt=await testApp.recordLotSales([{lotId:'lot:'+${once[0]},qty:500},{lotId:'lot:'+${parallel[0]},qty:500}],200,700,'2026-10-21',{commandId:'sell-merged'});window.receiptSaleRows=sellReceipt.recordRows`)
  // 两个来源各100，使同笔父成交确实含两份分配。
  await act(`await testApp.voidBooking('sell-merged');window.sellReceipt=await testApp.recordLotSales([{lotId:'lot:'+${once[0]},qty:100},{lotId:'lot:'+${parallel[0]},qty:100}],200,700,'2026-10-21',{commandId:'sell-multi'});window.receiptSaleRows=sellReceipt.recordRows`)
  const grouped=await act(`const {tradeFacts,saleFacts}=await import('/src/domain/booking.ts');return {facts:tradeFacts(testApp.records,testApp.executions,testApp.bookingReceipts).filter(f=>f.id==='sell-multi'),sales:saleFacts(testApp.ledger.sells,testApp.bookingReceipts).filter(f=>f.id==='sell-multi')}`)
  check('一次合并卖出分配两行，流水只算200股一笔',grouped.facts.length===1&&grouped.facts[0].rows.length===2&&grouped.facts[0].qty===200&&grouped.sales.length===1&&grouped.sales[0].qty===200)
  check('单独删除合并成交的一份分配被阻止',Boolean(await rejects(`await testApp.softDelete(receiptSaleRows[0])`)))
  await act(`await testApp.reviewBooking('sell-multi',true)`)
  check('核对状态保存独立于账务',await evaluate(`testApp.bookingReceipts.find(r=>r.id==='sell-multi').reviewedAt>0`))
  await act(`await testApp.voidBooking('sell-multi')`)
  check('整笔撤销同时恢复两个库存分配',(await state()).totals.sellQty===0)
  check('已撤销操作不能重试恢复或单行恢复',Boolean(await rejects(`await testApp.restore(receiptSaleRows[0])`)))

  console.log('\n[3] 回补幂等与跨入口候选')
  await act(`window.naked=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-22',price:'7',qty:'500',rebuyPrice:'5'},{commandId:'naked'});await testApp.setHedgeLink(naked,[])`)
  const rebuy=await act(`const o=testApp.ledger.orders.find(o=>o.sourceRow===naked);return await Promise.all([testApp.recordRebuy(o,200,500,0,undefined,undefined,{commandId:'rebuy-once'}),testApp.recordRebuy(o,200,500,0,undefined,undefined,{commandId:'rebuy-once'})])`)
  check('回补重复提交只扣200股，仍欠300',rebuy[0].id===rebuy[1].id&&await evaluate(`testApp.ledger.orders.find(o=>o.sourceRow===naked).remainingQty===300&&testApp.executions.length===1`))
  check('回补后从独立新增再记同一买回会提示',Boolean(await rejects(`await testApp.addManualRecord({kind:'buy',stockName:'T',date:new Date().toLocaleDateString('sv-SE'),price:'5',qty:'200'},{commandId:'cross-entry'})`)))
  await act(`const {planImport}=await import('/src/domain/importPlan.ts');const {tradeFacts}=await import('/src/domain/booking.ts');window.importCandidate={...testApp.records[0],sourceRow:22,importKey:'import:same-buy',buyDateSerial:Math.floor((new Date(new Date().toLocaleDateString('sv-SE')+'T00:00:00Z').getTime()-Date.UTC(1899,11,30))/86400000),buyPriceCents:500,buyQtyRaw:200,soldQty:null,sellDateSerial:null,batchId:null};window.importMatch=planImport(testApp.records,[importCandidate],[],{},tradeFacts(testApp.records,testApp.executions,testApp.bookingReceipts))`)
  check('回补成交后普通导入同一买回进入选择，不能静默新增',await evaluate(`importMatch.conflicts.length===1&&importMatch.fresh.length===0`))
  await act(`await testApp.addExtraTarget('lot:exec:'+testApp.executions[0].id,100,700);await testApp.setPlan('sell','target:lot:exec:'+testApp.executions[0].id,700,100);await testApp.voidBooking('rebuy-once')`)
  check('整笔撤销回补恢复基础欠股',(await state()).executions.length===0&&await evaluate(`testApp.ledger.orders.find(o=>o.sourceRow===naked).remainingQty===500`))
  check('撤销回补同时清理虚拟批次拆卖档与直接计划',await act(`const b=JSON.parse(await testApp.exportBackup());return !b.extraTargets.some(t=>t.lotId.startsWith('lot:exec:'))&&!b.plans.some(p=>p.refId.startsWith('target:lot:exec:'))`))
  await act(`window.depReceipt=await testApp.recordRebuy(testApp.ledger.orders.find(o=>o.sourceRow===naked),100,600,0,undefined,undefined,{commandId:'history-parent'});const e=depReceipt.executionIds[0];window.depSale=await testApp.recordLotSales([{lotId:'lot:exec:'+e,qty:100}],100,650,'2026-10-29',{commandId:'history-child'});await testApp.softDelete(depSale.recordRows[0])`)
  check('软删子卖出后仍不能撤销回补来源',Boolean(await rejects(`await testApp.removeRebuy(depReceipt.executionIds[0])`)))
  check('整笔撤销也尊重软删除历史依赖',Boolean(await rejects(`await testApp.voidBooking('history-parent')`)))

  console.log('\n[4] 导入歧义与备份往返')
  const imported=await act(`const base={...testApp.records.find(r=>r.sourceRow===naked),sourceRow:2,importKey:'import:A',soldQty:500,targetPriceCents:720,batchId:null};window.importA=base;window.importB={...base,sourceRow:3,importKey:'import:B',targetPriceCents:730};return await testApp.commitImport({records:[importA,importB],sheetName:'test',missingColumns:[],skippedRows:[],warnings:[]},'two.csv',{2:'new',3:'new'})`)
  const subset=await act(`return await testApp.commitImport({records:[{...importB,sourceRow:2}],sheetName:'test',missingColumns:[],skippedRows:[],warnings:[]},'subset.csv')`)
  check('裸卖子集重导精确匹配，不误更新另一笔',imported.added===2&&subset.added===0&&subset.updated===0&&subset.duplicated===1)
  check('模糊裸卖更新必须明确选择',Boolean(await rejects(`await testApp.commitImport({records:[{...importA,targetPriceCents:740,importKey:'changed'}],sheetName:'test',missingColumns:[],skippedRows:[],warnings:[]},'changed.csv')`)))
  await act(`window.nextImport=await testApp.commitImport({records:[{...importA,sourceRow:8,importKey:'next:import',buyPriceCents:400,buyQtyRaw:100,buyDateSerial:46000,targetPriceCents:600,soldQty:100,sellDateSerial:46001,earlyBuyPriceCents:null}],sheetName:'test',missingColumns:[],skippedRows:[],warnings:[]},'next.csv');const anchor=testApp.records.find(r=>r.importKey==='next:import')??(await import('/src/store/db.ts')).db.records;window.nextAnchor=(await (await import('/src/store/db.ts')).db.records.toArray()).find(r=>r.importKey==='next:import').sourceRow;await testApp.recordBuySuggestion([{kind:'next',id:'next',row:nextAnchor,qty:50}],50,400,'2026-10-24',{commandId:'next-buy'})`)
  check('回滚原导入会检查下一轮来源依赖',Boolean(await rejects(`await testApp.rollbackBatch(nextImport.batch.id)`)))
  const parallelImports=await act(`const p=r=>({records:[r],sheetName:'test',missingColumns:[],skippedRows:[],warnings:[]});return await Promise.all([testApp.commitImport(p({...importA,sourceRow:10,importKey:'batch:one',buyPriceCents:420,buyQtyRaw:50,buyDateSerial:46005,soldQty:null,sellDateSerial:null}), 'one.csv'),testApp.commitImport(p({...importA,sourceRow:11,importKey:'batch:two',buyPriceCents:430,buyQtyRaw:60,buyDateSerial:46005,soldQty:null,sellDateSerial:null}), 'two.csv')])`)
  check('并发导入各有独立批次身份，新增都保留',parallelImports[0].batch.id!==parallelImports[1].batch.id&&parallelImports.every(p=>p.added===1))
  await act(`window.bookingBackup=await testApp.exportBackup();const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');const before=JSON.parse(bookingBackup);const bytes=await exportLedgerWorkbook(before);window.excelBooking=await parseLedgerWorkbook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))`)
  check('完整Excel保留成交回执、撤销、凭据与核对字段',await evaluate(`(()=>{const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);return canonical(excelBooking.snapshot.bookingReceipts)===canonical(JSON.parse(bookingBackup).bookingReceipts)})()`))
  await act(`await testApp.restoreBackup(bookingBackup)`)
  check('JSON恢复保留回执唯一身份',await evaluate(`testApp.bookingReceipts.some(r=>r.id==='real-second'&&r.externalRef==='Broker/20261020/fill-002')`))
  check('空对象恢复整包拒绝',Boolean(await rejects(`await testApp.restoreBackup('{}')`)))
  check('重复主键备份整包拒绝',Boolean(await rejects(`const bad=JSON.parse(bookingBackup);bad.records.push(bad.records[0]);await testApp.restoreBackup(JSON.stringify(bad))`)))
  check('非法小数股数备份整包拒绝',Boolean(await rejects(`const bad=JSON.parse(bookingBackup);bad.records[0].buyQtyRaw=0.5;await testApp.restoreBackup(JSON.stringify(bad))`)))
  check('循环来源备份整包拒绝',Boolean(await rejects(`const bad=JSON.parse(bookingBackup);bad.records[0].soldLotId='lot:'+bad.records[0].sourceRow;await testApp.restoreBackup(JSON.stringify(bad))`)))

  console.log('\n[5] 移动端真实页面：核对、查找、防重及滚动')
  await send('Page.reload');await settle()
  await send('Page.navigate',{url:BASE+'/#/manage?section=activity'});await settle()
  check('管理成交流水可直接刷新打开',await evaluate(`Boolean(document.querySelector('[data-testid="trade-activity"]'))`))
  check('成交编号和凭据号可见',await evaluate(`document.body.innerText.includes('real-second')&&document.body.innerText.includes('Broker/20261020/fill-002')`))
  check('390px流水没有横向溢出',await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`))
  await send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:2,mobile:true});await settle()
  check('320px流水编号换行且无横向溢出',await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`))
  const activityShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,'booking-activity-320.png'),Buffer.from(activityShot.data,'base64'))
  await send('Page.navigate',{url:BASE+'/#/orders'});await settle()
  await click('[data-action="suggestion-buy"]')
  check('成交表单显示防重检查和本次事实',await evaluate(`Boolean(document.querySelector('[data-testid="booking-check"]'))&&document.body.innerText.includes('本次实际买入')`))
  check('320px成交弹窗内容无需横向滚动',await evaluate(`(()=>{const b=document.querySelector('.booking-modal [class*="animal-body"]');return b&&b.scrollWidth<=b.clientWidth+1})()`))
  await input('tradeQty','100');await input('tradePrice','6')
  check('表单实时展示同股同日同价同量的已有编号',await evaluate(`Boolean(document.querySelector('[data-testid="booking-duplicates"]'))&&document.body.innerText.includes('history-parent')`))
  await evaluate(`[...document.querySelectorAll('.booking-modal button')].find(b=>b.textContent.trim()==='保存成交').click()`);await settle()
  check('没有确认另一笔时保留表单并阻止重复保存',await evaluate(`Boolean(document.querySelector('.booking-modal'))&&document.body.innerText.includes('发现同股同日同价同量成交')`))
  const formShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,'booking-confirm-320.png'),Buffer.from(formShot.data,'base64'))
  await click('[data-field="booking-allow-similar"]')
  await evaluate(`[...document.querySelectorAll('.booking-modal button')].find(b=>b.textContent.trim()==='保存成交').click()`);await settle()
  check('确认另一笔真实成交后界面可成功保存',await evaluate(`!document.querySelector('.booking-modal')`))
  check('无浏览器运行时错误',problems.length===0,problems.join(' | '))
  socket.close()

} finally {
  browser.kill()
  try {rmSync(profile,{recursive:true,force:true})}catch{}
}
console.log(ok?'\nBOOKING E2E PASS':'\nBOOKING E2E FAIL')
process.exit(ok?0:1)

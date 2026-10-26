/**
 * 真实 IndexedDB 与 React store 的记账回归（移动端 390×844 视口）：
 * 分链 → 回补 → 部分卖出 → 多轮循环 → 依赖保护 → 建议成交 → 备份恢复 → 增量导入。
 *
 *   node e2e/accounting.mjs http://127.0.0.1:5173
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9445
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
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});testApp.patchOrdersSession({stockName:'T',closes:{T:'7'},confirmedCents:{T:700},overrides:{}})`)
  await act(`window.h1=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'10',qty:'500'});window.h2=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'12',qty:'500'});window.naked=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'1000',rebuyPrice:'5'});await testApp.setHedgeLink(naked,[{row:h1,qty:500},{row:h2,qty:500}])`)
  let v=await state()
  check('未回补即有两条亏损链',v.chains.length===2&&v.chains.reduce((a,c)=>a+c.loss,0)===-400000,JSON.stringify(v.chains))
  await act(`await testApp.recordBuySuggestion([{kind:'order',id:'rb:sell:'+naked,row:naked,qty:1000}],1000,500,'2026-10-22')`)
  v=await state()
  check('同一回补只分配1000股，分链各500股',v.chains.every(c=>c.holding===500)&&v.totals.netQty===1000,JSON.stringify(v.chains))
  check('全部守恒检查通过',v.checks.length===0,JSON.stringify(v.checks))
  check('回补后明细状态完成',v.orders.find(o=>o.sourceRow===100002)?.remainingQty===0)
  check('重复补买入被拦截',Boolean(await rejects(`await testApp.editRecord(naked,{buyPrice:'5',buyQty:'1000',buyDate:'2026-10-22'})`)))
  check('待卖存在记卖出入口',await click('[data-action="sell-execution"]'))
  await input('tradeQty','600')
  await input('tradePrice','7')
  check('成交弹窗可填实际数量',await evaluate(`document.querySelector('[data-field="tradeQty"]').value==='600'`))
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存成交');b.click()})()`)
  await settle()
  v=await state()
  check('通过UI卖600，库存只剩400',v.totals.netQty===400&&v.totals.targetQty===400,JSON.stringify(v.totals))
  check('两条链分别计1000和200盈利',v.chains[0].profit===100000&&v.chains[1].profit===20000,JSON.stringify(v.chains))
  check('不能撤销已有子卖出的回补',Boolean(await rejects(`await testApp.removeRebuy(testApp.executions[0].id)`)))
  check('不能删除已有子卖出的父记录',Boolean(await rejects(`await testApp.softDelete(naked)`)))
  const before=v.records.length
  check('超过剩余库存整笔拒绝',Boolean(await rejects(`await testApp.recordLotSales([{lotId:testApp.ledger.targets[0].lotId,qty:500}],500,700,'2026-10-23')`)))
  check('失败事务没有半笔成交',(await state()).records.length===before)
  await act(`const sale=testApp.records.find(r=>r.soldLotId);window.firstSale=sale.sourceRow;await testApp.recordBuySuggestion([{kind:'order',id:'rb:sell:'+sale.sourceRow,row:sale.sourceRow,qty:600}],600,500,'2026-10-24')`)
  v=await state()
  check('第二轮买回承接原链，持仓合计1000',v.chains.reduce((a,c)=>a+c.holding,0)===1000&&v.totals.netQty===1000,JSON.stringify(v.chains))
  await act(`const e=testApp.executions.find(e=>e.sellExecId==='sell:'+firstSale);await testApp.recordLotSales([{lotId:'lot:exec:'+e.id,qty:600}],600,700,'2026-10-25')`)
  v=await state()
  check('第二轮卖出后保持400股，累计链盈利2400',v.totals.netQty===400&&v.chains.reduce((a,c)=>a+c.profit,0)===240000,JSON.stringify(v.chains))
  check('第二轮守恒仍全通过',v.checks.length===0,JSON.stringify(v.checks))
  await act(`window.nextAnchor=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-23',price:'8',qty:'500',buyPrice:'6',buyQty:'500',buyDate:'2026-10-20',repaid:true})`)
  await act(`await testApp.recordBuySuggestion([{kind:'next',id:'buy:'+nextAnchor,row:nextAnchor,qty:500}],200,600,'2026-10-24')`)
  check('下一轮建议成交生成唯一买入并记来源',(await state()).records.some(r=>r.nextRoundOfRow&&r.buyQtyRaw===200))
  check('重复超额执行下一轮建议被拒绝',Boolean(await rejects(`await testApp.recordBuySuggestion([{kind:'next',id:'buy:'+nextAnchor,row:nextAnchor,qty:500}],500,600,'2026-10-24')`)))
  const backup=await act(`return await testApp.exportBackup()`)
  const backupState=await state()
  await act(`await testApp.resetAll();await testApp.restoreBackup(${JSON.stringify(backup)})`)
  v=await state()
  check('备份恢复保留成交来源与链持仓',JSON.stringify(v.chains)===JSON.stringify(backupState.chains)&&v.totals.netQty===backupState.totals.netQty)
  // 同行号增量导入：通过真实 Dexie 写入检查覆盖风险。
  await act(`await testApp.resetAll();window.importRec=(p)=>({sourceRow:2,stockName:'T',buyDateSerial:46000,buyPriceCents:p,buyQtyRaw:500,qtyNeedsDerive:false,targetPriceCents:p+200,targetNeedsDerive:false,soldQty:0,sellDateSerial:null,earlyBuyPriceCents:null,rawProfitCents:null,importKey:'import:'+p});await testApp.commitImport({sheetName:'Sheet1',records:[importRec(1000)],skippedRows:[],missingColumns:[]},'A.xlsx');await testApp.commitImport({sheetName:'Sheet1',records:[importRec(600)],skippedRows:[],missingColumns:[]},'B.xlsx')`)
  v=await state()
  check('真实IndexedDB增量导入不覆盖旧交易',v.records.length===2&&v.records.some(r=>r.sourceRow===2&&r.buyPriceCents===1000)&&v.records.some(r=>r.sourceRow!==2&&r.excelRow===2&&r.buyPriceCents===600),JSON.stringify(v.records))
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});window.anchor=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'10',qty:'500'});window.pending=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});await testApp.setHedgeLink(pending,[{row:anchor,qty:500}]);await testApp.setPlan('buy','rb:sell:'+pending,550,200)`)
  check('单笔计划建议有成交入口',await click('[data-testid="buy-suggestion"][data-price="550"] [data-action="suggestion-buy"]'))
  check('成交弹窗采用计划价和计划量',await evaluate(`document.querySelector('[data-field="execQty"]')?.value==='200'&&document.querySelector('[data-field="execPrice"]')?.value==='5.50'`))
  await input('execQty',' ');await input('execPrice',' ');await input('execReward',' ')
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存');b.click()})()`)
  await settle()
  v=await state()
  check('按计划成交200股后仍只欠300股',v.executions[0]?.qty===200&&v.executions[0]?.priceCents===550&&v.orders[0]?.remainingQty===300,JSON.stringify(v.orders))
  check('无浏览器运行时错误',problems.length===0,problems.join(' | '))
  const shot=await send('Page.captureScreenshot',{format:'png'})
  writeFileSync(join(OUT,'accounting-mobile.png'),Buffer.from(shot.data,'base64'))
  socket.close()
} finally {
  browser.kill()
  try {rmSync(profile,{recursive:true,force:true})}catch{}
}
console.log(ok?'\nACCOUNTING E2E PASS':'\nACCOUNTING E2E FAIL')
process.exit(ok?0:1)

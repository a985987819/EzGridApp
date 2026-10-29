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
  // 完整 XLSX 经真实 store 整库恢复两次：成交/虚拟批次/链/奖励/序号必须不变。
  const excelRoundtrip=await act(`
    const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');
    const {snapshotViews}=await import('/src/domain/ledgerSnapshot.ts');
    const before=JSON.parse(await testApp.exportBackup());
    const parsed=await parseLedgerWorkbook(await exportLedgerWorkbook(before));
    const beforeViews=JSON.stringify(snapshotViews(before));
    await testApp.resetAll();
    await testApp.restoreBackup(JSON.stringify(parsed.snapshot));
    await testApp.restoreBackup(JSON.stringify(parsed.snapshot));
    const after=JSON.parse(await testApp.exportBackup());
    const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
    return {differences:parsed.differences,viewsMatch:JSON.stringify(snapshotViews(after))===beforeViews,
      recordCount:after.records.length,expectedCount:before.records.length,
      auditMatch:canon(after.auditLogs)===canon(before.auditLogs),
      inputsMatch:['stocks','records','batches','rebuyExecutions','plans','extraTargets','buyTargets','hedges','merges','chainLinks'].every(k=>canon(before[k])===canon(after[k]))};
  `)
  check('完整Excel核对快照全部一致',excelRoundtrip.differences.length===0,JSON.stringify(excelRoundtrip))
  check('完整Excel空库恢复与重复恢复不重复记账',excelRoundtrip.viewsMatch&&excelRoundtrip.recordCount===excelRoundtrip.expectedCount,JSON.stringify(excelRoundtrip))
  check('完整Excel保留人工关联、成交、操作历史与稳定ID',excelRoundtrip.inputsMatch&&excelRoundtrip.auditMatch,JSON.stringify(excelRoundtrip))
  await act(`testApp.setDeriveSellPrice(true)`)
  const settingBackup=await act(`return await testApp.exportBackup()`)
  await act(`testApp.setDeriveSellPrice(false)`)
  await act(`await testApp.restoreBackup(${JSON.stringify(settingBackup)})`)
  check('计算设置随备份恢复并写入持久化存储',await evaluate(`testApp.deriveSellPrice===true&&(async()=>{const {db}=await import('/src/store/db.ts');return (await db.meta.get('deriveSellPrice'))?.value==='true'})()`))
  await act(`testApp.setDeriveSellPrice(false)`)


  // 审计回归：同订单拆档撞价合并后，基础股只能分配一次，奖励必须占用利润。
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});window.auditRec={sourceRow:2,stockName:'T',buyDateSerial:46000,buyPriceCents:500,buyQtyRaw:500,qtyNeedsDerive:false,targetPriceCents:700,targetNeedsDerive:false,soldQty:500,sellDateSerial:46010,earlyBuyPriceCents:500,rawProfitCents:null,importKey:'audit:reward'};await testApp.commitImport({sheetName:'交易记录',records:[auditRec],skippedRows:[],missingColumns:[]},'audit.csv');await testApp.addBuyTarget(2,450,300);await testApp.addBuyTarget(2,500,200)`)
  await act(`const {buildBuySuggestions}=await import('/src/domain/suggestions.ts');const row=buildBuySuggestions(testApp.ledger.buySplits,[],[]).find(b=>b.priceCents===450);await testApp.setPlan('buy',row.key,500,300)`)
  await evaluate(`document.querySelector('[data-action="suggestion-buy"]')?.click()`)
  await settle()
  check('合并建议从UI进入多来源成交，默认量为700股',await evaluate(`document.querySelector('input[data-field="tradeQty"]')?.value==='700'`))
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存成交')?.click()`)
  await settle()
  const rewardResult=await evaluate(`({done:testApp.ledger.orders[0].doneRewardQty,used:testApp.ledger.groups[0].usedProfitCents,remaining:testApp.ledger.orders[0].remainingQty,sources:testApp.executions.map(e=>e.buyTargetId),bad:testApp.ledger.checks.filter(c=>!c.ok)})`)
  check('同订单拆档合并700股正确记录200奖励及1000元已用利润',rewardResult.done===200&&rewardResult.used===100000&&rewardResult.remaining===0&&rewardResult.sources.every(Boolean)&&rewardResult.bad.length===0,JSON.stringify(rewardResult))
  check('合并成交不能仅撤销一份分配',Boolean(await rejects(`await testApp.removeRebuy(testApp.executions.find(e=>e.rewardQty>0).id)`)))
  await act(`await testApp.voidBooking(testApp.bookingReceipts.find(r=>r.executionIds.length===2&&!r.voidedAt).id)`)
  check('撤销整笔恢复基础量与奖励额度',await evaluate(`testApp.ledger.orders[0].remainingQty===700&&testApp.ledger.groups[0].usedProfitCents===0&&testApp.executions.length===0`))
  await act(`const split=testApp.ledger.buySplits.find(b=>b.priceCents===500);await testApp.recordRebuy(testApp.ledger.orders[0],400,500,200,undefined,split.key)`)
  check('单档先成交奖励档也保存来源，其它300股基础档不变',await evaluate(`testApp.executions[0].rewardQty===200&&Boolean(testApp.executions[0].buyTargetId)&&testApp.ledger.buySplits.find(b=>b.priceCents===450).qty===300&&testApp.ledger.buySplits.find(b=>b.priceCents===500).qty===0&&testApp.ledger.checks.every(c=>c.ok)`))

  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});window.partialBuy=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-20',price:'8',qty:'1000',rebuyPrice:'6'});await testApp.addBuyTarget(partialBuy,500,200)`)
  check('只拆200股的买单保留默认价600分的800股',await evaluate(`testApp.ledger.buySplits.some(b=>b.priceCents===500&&b.qty===200)&&testApp.ledger.buySplits.some(b=>b.priceCents===600&&b.qty===800)`))
  await act(`const split=testApp.ledger.buySplits.find(b=>b.priceCents===500);await testApp.recordRebuy(testApp.ledger.orders[0],100,550,0,undefined,split.key)`)
  check('单档改价部分买入后只扣原档100股',await evaluate(`testApp.ledger.buySplits.some(b=>b.priceCents===500&&b.qty===100)&&testApp.ledger.buySplits.some(b=>b.priceCents===600&&b.qty===800)&&Boolean(testApp.executions[0].buyTargetId)`))

  // 新来源身份跨完整 Excel 往返，恢复后继续卖出和撤销。
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});window.splitParent=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'5',qty:'500',targetPrice:'7'});await testApp.addExtraTarget('lot:'+splitParent,600,200);await testApp.addExtraTarget('lot:'+splitParent,700,300)`)
  await act(`const t=testApp.ledger.targets.find(t=>t.priceCents===600);await testApp.recordLotSales([{lotId:t.lotId,targetId:t.id,qty:t.qty}],100,650,'2026-10-21')`)
  check('卖出改成交价后仍只扣原拆分档',await evaluate(`testApp.ledger.targets.some(t=>t.priceCents===600&&t.qty===100)&&testApp.ledger.targets.some(t=>t.priceCents===700&&t.qty===300)&&Boolean(testApp.records.find(r=>r.soldLotId)?.soldTargetId)`))
  const splitRestored=await act(`const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');const p=await parseLedgerWorkbook(await exportLedgerWorkbook(JSON.parse(await testApp.exportBackup())));await testApp.restoreBackup(JSON.stringify(p.snapshot));return p.differences.length===0`)
  check('来源档身份经完整Excel恢复，核对快照不变',splitRestored)
  await act(`const t=testApp.ledger.targets.find(t=>t.priceCents===600);await testApp.recordLotSales([{lotId:t.lotId,targetId:t.id,qty:t.qty}],100,600,'2026-10-22')`)
  check('恢复后继续卖出，已成交低价档不再出现',await evaluate(`testApp.ledger.targets.length===1&&testApp.ledger.targets[0].priceCents===700&&testApp.ledger.targets[0].qty===300`))
  await act(`await testApp.softDelete(testApp.records.filter(r=>r.soldLotId).sort((a,b)=>b.sourceRow-a.sourceRow)[0].sourceRow)`)
  check('恢复后撤销子卖出，原档100股恢复',await evaluate(`testApp.ledger.targets.some(t=>t.priceCents===600&&t.qty===100)&&testApp.ledger.checks.every(c=>c.ok)`))
  await act(`await testApp.recordLotSales(testApp.ledger.targets.map(t=>({lotId:t.lotId,targetId:t.id,qty:t.qty})),400,700,'2026-10-23')`)
  check('同批次多档一起成交支持独立来源，并识别父明细已完成',await evaluate(`(async()=>{const {isDone}=await import('/src/domain/tradeState.ts');return testApp.ledger.lots.find(l=>l.id==='lot:'+splitParent).remainingQty===0&&isDone({rec:testApp.records.find(r=>r.sourceRow===splitParent),lot:testApp.ledger.lots.find(l=>l.id==='lot:'+splitParent),sell:null})&&testApp.ledger.checks.every(c=>c.ok)})()`))

  // 推定售价设置必须同时用于页面和事务内成交校验。
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10'});await testApp.commitImport({sheetName:'交易记录',records:[{...auditRec,targetPriceCents:null,targetNeedsDerive:true,importKey:'audit:formula'}],skippedRows:[],missingColumns:[]},'formula.xlsx')`)
  await act(`testApp.setDeriveSellPrice(true)`)
  check('推定售价启用后显示700股含200奖励',await evaluate(`testApp.ledger.orders[0].remainingQty===700`))
  await act(`await testApp.recordBuySuggestion([{kind:'order',id:testApp.ledger.orders[0].id,row:2,qty:700}],700,500,'2026-10-23')`)
  check('推定售价设置下700股按页面额度成功成交',await evaluate(`testApp.ledger.orders[0].remainingQty===0&&testApp.ledger.orders[0].doneRewardQty===200&&testApp.ledger.checks.every(c=>c.ok)`))
  await act(`testApp.setDeriveSellPrice(false)`)

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
  // 用户确认的真实 CSV：导入、自动高位关联、同行回补与跨详情回本链。
  const csv = readFileSync(join(process.cwd(),'tests/fixtures/26年网格记录-交易记录.csv'),'utf8')
  await act(`await testApp.resetAll();const {parseCsvText}=await import('/src/io/parseWorkbook.ts');await testApp.commitImport(await parseCsvText(${JSON.stringify(csv)}),'交易记录.csv')`)
  v=await state()
  const csvState=await evaluate(`({roots:testApp.ledger.sells.filter(s=>s.sellBeforeBuy).map(s=>s.sourceRow),chains:testApp.ledger.repairChains.map(c=>({row:c.anchorRow,loss:c.lossCents,profit:c.profitCents})),pending:testApp.ledger.orders.filter(o=>o.sellFirst&&o.remainingQty>0).map(o=>[o.sourceRow,o.remainingQty,o.rebuyPriceCents]),own:testApp.ledger.sells.reduce((a,s)=>a+(s.ownLotCoverQty??0),0)})`)
  check('真实CSV识别六笔先卖后买',JSON.stringify(csvState.roots)==='[40,57,60,61,62,63]',JSON.stringify(csvState))
  check('真实CSV已回补2100股，仅剩500股@8.01',csvState.own===2100&&JSON.stringify(csvState.pending)==='[[60,500,801]]',JSON.stringify(csvState))
  check('真实CSV初始亏损5176，未完成低位买卖不计回血',csvState.chains.filter(c=>csvState.roots.includes(c.row)).reduce((a,c)=>a+c.loss,0)===-517600&&csvState.chains.every(c=>c.profit===0),JSON.stringify(csvState.chains))
  check('真实CSV全部守恒检查通过',v.checks.length===0,JSON.stringify(v.checks))
  const autoRoundtrip=await act(`
    const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');
    const {snapshotViews}=await import('/src/domain/ledgerSnapshot.ts');
    const before=JSON.parse(await testApp.exportBackup());
    const p=await parseLedgerWorkbook(await exportLedgerWorkbook(before));
    await testApp.restoreBackup(JSON.stringify(p.snapshot));
    const after=JSON.parse(await testApp.exportBackup());
    return {same:JSON.stringify(snapshotViews(before))===JSON.stringify(snapshotViews(after)),manual:after.hedges.length};
  `)
  check('CSV经完整Excel恢复后六条自动关联仍自动且盈亏不变',autoRoundtrip.same&&autoRoundtrip.manual===0,JSON.stringify(autoRoundtrip))
  // 两个文件入口经原生 input 读完整 XLSX，预览不写库，确认后整库替换。
  const excelFile=join(OUT,'ledger-roundtrip.xlsx')
  writeFileSync(excelFile,Buffer.from(await act(`const {exportLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');return Array.from(await exportLedgerWorkbook(JSON.parse(await testApp.exportBackup())))`)))
  await evaluate(`(async()=>{
    const React=(await import('/node_modules/.vite/deps/react.js')).default;
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const source=await (await fetch('/src/pages/OrdersPage.tsx')).text();
    const storeUrl=source.match(new RegExp('from "([^"]*store.useApp[^"]*)"'))[1];
    const {AppProvider}=await import(storeUrl);
    const {ManageImport}=await import('/src/pages/manage/ManageImport.tsx');
    const {ManageBackup}=await import('/src/pages/manage/ManageBackup.tsx');
    const el=document.createElement('div');el.id='excel-preview-test';document.body.appendChild(el);
    createRoot(el).render(React.createElement(AppProvider,null,React.createElement('div',null,
      React.createElement(ManageImport,{goTrades:()=>{}}),React.createElement(ManageBackup))));
  })()`)
  await settle()
  const setExcelInput=async(selector)=>{
    const {root}=await send('DOM.getDocument');
    const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector});
    await send('DOM.setFileInputFiles',{nodeId,files:[excelFile]});
    await settle();
  }
  await setExcelInput('#excel-preview-test #import-file-input')
  check('普通导入入口识别完整Excel并进入恢复预览',await evaluate(`document.querySelector('[data-testid="ledger-restore-preview"]')?.textContent.includes('62 笔记录')&&document.querySelector('[data-testid="ledger-restore-preview"]')?.textContent.includes('核对通过')`))
  check('完整文件未混进普通增量导入报告',await evaluate(`!document.querySelector('#excel-preview-test')?.textContent.includes('dry-run 报告')`))
  await evaluate(`(()=>{const p=document.querySelector('[data-testid="ledger-restore-preview"]');[...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='取消').click()})()`)
  await settle()
  await setExcelInput('#excel-preview-test #ledger-file-input')
  check('备份入口同样先展示恢复预览',await evaluate(`Boolean(document.querySelector('[data-testid="ledger-restore-preview"]'))`))
  check('移动端恢复预览没有横向溢出',await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`))
  await evaluate(`document.querySelector('[data-testid="ledger-restore-preview"]').scrollIntoView({block:'start'})`)
  const previewShot=await send('Page.captureScreenshot',{format:'png'})
  writeFileSync(join(OUT,'ledger-restore-mobile.png'),Buffer.from(previewShot.data,'base64'))
  await click('[data-action="restore-ledger-confirm"]')
  await settle()
  check('确认恢复关闭预览且数据库保持62笔',await evaluate(`(async()=>!document.querySelector('[data-testid="ledger-restore-preview"]')&&(JSON.parse(await testApp.exportBackup())).records.length===62)()`))
  await evaluate(`document.getElementById('excel-preview-test')?.remove()`)

  const cycleRows=await act(`const hi=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'10',qty:'500'});const root=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});const low=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-22',price:'5',qty:'500',targetPrice:'7'});await testApp.recordLotSales([{lotId:'lot:'+low,qty:500}],500,700,'2026-10-23');return [hi,root,low,testApp.records.find(r=>r.soldLotId==='lot:'+low)?.sourceRow]`)
  // React 的快照要等动作重载后再读取新增子卖出。
  cycleRows[3]=await evaluate(`testApp.records.find(r=>r.soldLotId==='lot:'+${cycleRows[2]})?.sourceRow`)
  check('完成低位买卖后仅回血1000，实际仍亏500',await evaluate(`testApp.ledger.repairChains.some(c=>c.anchorRow===${cycleRows[1]}&&c.lossCents===-150000&&c.profitCents===100000&&c.netCents===-50000)`))
  const ids=await evaluate(`(async()=>{const {buildNanoIdIndex}=await import('/src/ui/nanoid.ts');return Object.fromEntries(buildNanoIdIndex(testApp.records).rowToId)})()`)
  await send('Page.reload');await settle()
  for(const row of [40,29,60,7,62,...cycleRows]){
    await send('Page.navigate',{url:BASE+'/#/trades?id='+ids[row]})
    await settle()
    if(row===cycleRows[1]){
      check('自动归链仍保留行上的改挂入口',await click('[data-hedge="'+row+'"]'))
      check('改挂弹层可见',await evaluate(`Boolean(document.querySelector('.hedge-modal [data-action="save-hedge"]'))`))
      await evaluate(`document.querySelector('.hedge-modal [aria-label="关闭"]')?.click();[...document.querySelectorAll('.hedge-modal button')].find(b=>b.textContent.trim()==='关闭')?.click()`);await sleep(300)
    }
    await click('[data-row="'+row+'"]')
    check('第'+row+'行详情能看到完整回本链',await evaluate(`Boolean(document.querySelector('[data-testid="chain-section"] .chain-card'))`))
    if(row===29)check('高位第29行详情同时显示两条关联链',await evaluate(`document.querySelectorAll('[data-testid="chain-section"] .chain-card').length===2`))
  }
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

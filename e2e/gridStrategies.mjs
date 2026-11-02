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

const PORT = 9468
const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const OUT = join(process.cwd(), 'e2e', 'out', 'grid')
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
  const gridInput=async(field,value)=>{await evaluate(`(()=>{const e=document.querySelector('[data-grid-field="${field}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await sleep(100)}
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:57,priceLimitType:'main_10',order:-1,enabled:true});testApp.patchOrdersSession({stockName:'T',closes:{T:'8'},confirmedCents:{T:800}})`)
  await act(`window.h1=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'10',qty:'1000',targetPrice:'12'});window.h2=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'10.1',qty:'1000',targetPrice:'12.1'});window.original=JSON.stringify(testApp.records)`)
  await sleep(500)
  await act(`window.original=JSON.stringify(testApp.records)`)
  check('挂单页提供独立批量拆档入口',await click('[data-action=grid-open]'))
  await click('[data-grid-lot="lot:'+await evaluate('h1')+'"]');await click('[data-grid-lot="lot:'+await evaluate('h2')+'"]')
  await gridInput('start','7');await gridInput('step','0.3');await gridInput('gap','2')
  await click('[data-grid-mode-select=baseT]')
  check('两笔1000预览四个500档，相邻0.30且只改计划',await evaluate(`document.querySelectorAll('.grid-preview-row').length===4&&document.querySelector('[data-testid=grid-preview]').textContent.includes('7.90')`))
  const previewShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,'planner-mobile.png'),Buffer.from(previewShot.data,'base64'))
  check('拆档表单没有遮挡或横向溢出，来源与模式分开排列',await evaluate(`(()=>{const modal=document.querySelector('.grid-planner-modal'),sources=modal.querySelector('.grid-source-list').getBoundingClientRect(),toggle=modal.querySelector('.type-toggle').getBoundingClientRect(),body=modal.querySelector('[class*="animal-body"]');return body.scrollWidth<=body.clientWidth+1&&sources.bottom<=toggle.top})()`))
  await evaluate(`const body=document.querySelector('.grid-planner-modal [class*="animal-body"]');body.scrollTop=body.scrollHeight`);await sleep(200)
  const previewBottom=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,'planner-preview-mobile.png'),Buffer.from(previewBottom.data,'base64'))
  await click('[data-action=grid-save]');await sleep(350)
  let v=await state()
  check('计划保存不修改原始记录、不新增成交或股票',v.records.length===2&&await evaluate('JSON.stringify(testApp.records)===original')&&v.totals.netQty===2000)
  check('四个档位准确且没有原自动档重复份额',JSON.stringify(v.targets.map(t=>[t.priceCents,t.qty]))==='[[700,500],[730,500],[760,500],[790,500]]',JSON.stringify(v.targets))
  await act(`window.first=testApp.extraTargets.find(t=>t.priceCents===700);window.second=testApp.extraTargets.find(t=>t.priceCents===730)`)
  await act(`await testApp.recordLotSales([{lotId:first.lotId,targetId:'target:'+first.id,qty:500}],500,700,'2026-10-21')`)
  v=await state()
  check('做T卖500股只扣500且不生成回本链',v.totals.netQty===1500&&v.chains.length===0&&v.totals.profitCents===-150000)
  check('做T卖出后回补订单独立标记且无奖励',v.orders.some(o=>o.strategyMode==='baseT'&&o.rebuyPriceCents===500&&o.rewardQty===0))
  await act(`window.o=testApp.ledger.orders.find(o=>o.strategyMode==='baseT');await testApp.recordRebuy(o,200,500,0)`)
  v=await state()
  check('部分回补恢复200股12元目标，实际买价仍为5元',v.targets.some(t=>t.priceCents===1200&&t.qty===200)&&v.totals.netQty===1700&&v.chains.length===0)
  check('策略台账显示待买回300股与做T价差400元',await evaluate(`testApp.extraTargets.length===4&&document.querySelector('[data-testid=grid-status]').textContent.includes('+¥400.00')&&document.querySelector('[data-testid=grid-status]').textContent.includes('300')`))
  check('已有回补后禁止改写先卖模式',Boolean(await rejects(`await testApp.setSellGridMode(o.sourceRow,'repair')`)))
  await act(`window.o=testApp.ledger.orders.find(o=>o.strategyMode==='baseT');await testApp.recordRebuy(o,300,500,0)`)
  v=await state()
  check('全部回补只恢复500股高位卖量，原库存合计2000股',v.totals.netQty===2000&&v.targets.filter(t=>t.priceCents===1200).reduce((a,t)=>a+t.qty,0)===500&&v.chains.length===0)
  const immutable=await evaluate(`JSON.stringify(testApp.records.filter(r=>r.sourceRow===h1||r.sourceRow===h2))===original`)
  check('真实交易后原始高位两笔仍逐字段一致',immutable,await evaluate(`JSON.stringify({before:original,after:JSON.stringify(testApp.records.filter(r=>r.sourceRow===h1||r.sourceRow===h2))})`))
  check('策略历史档不可直接删除',Boolean(await rejects(`await testApp.removeExtraTarget(first.id)`)))
  check('来源原单不可改成本',Boolean(await rejects(`await testApp.editRecord(h1,{buyPrice:'9'})`)))
  check('来源原单不可删除',Boolean(await rejects(`await testApp.softDelete(h1)`)))
  // 第二档再拆为两份，切成回本模式；原来成交档及原始记录不动。
  await evaluate(`document.querySelector('[data-testid=grid-status]').open=true`)
  await click('[data-grid-id="'+await evaluate('second.id')+'"] [data-action=grid-resplit]')
  await gridInput('qty','250');await click('[data-grid-mode-select=repair]')
  check('剩余再拆表单预览两份250股，不改已有成交',await evaluate(`document.querySelectorAll('.grid-preview-row').length===2&&document.querySelector('[data-testid=grid-preview]').textContent.includes('500')`))
  await click('[data-action=grid-save]');await sleep(200)
  await act(`window.repair=testApp.extraTargets.find(t=>t.strategy?.mode==='repair');window.resplitGroup=repair.strategy.groupId;window.replan={lotIds:[second.lotId],targetIds:['target:'+second.id],startCents:730,stepCents:30,direction:1,perQty:250,rebuyGapCents:200,mode:'repair'};await testApp.saveGridLadder(replan,resplitGroup)`)
  check('再拆剩余并重试只生成两份250股，原500不重复保留',await evaluate(`testApp.extraTargets.filter(t=>t.strategy?.groupId===resplitGroup).length===2&&testApp.ledger.targets.filter(t=>t.lotId===second.lotId).reduce((a,t)=>a+t.qty,0)===500`))
  check('同一编号不同内容不允许复用',Boolean(await rejects(`await testApp.saveGridLadder({...replan,startCents:800},resplitGroup)`)))
  await act(`await testApp.recordLotSales([{lotId:repair.lotId,targetId:'target:'+repair.id,qty:250}],250,730,'2026-10-22')`)
  v=await state()
  check('回本档与做T档同来源也能独立结算，仅回本档建立链',v.chains.length===1&&v.chains[0].loss===-67500)
  await act(`window.ro=testApp.ledger.orders.find(o=>o.strategyMode==='repair');await testApp.recordRebuy(ro,250,530,0)`)
  v=await state()
  check('回本回补恢复本档7.30低位目标，不提前盈利',v.chains[0].profit===0&&v.targets.some(t=>t.priceCents===730&&t.lotId.startsWith('lot:exec:')))
  check('全过程所有守恒检查通过',v.checks.length===0,JSON.stringify(v.checks))
  const restored=await act(`const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');const {snapshotViews}=await import('/src/domain/ledgerSnapshot.ts');window.backup=JSON.parse(await testApp.exportBackup());const before=JSON.stringify(snapshotViews(backup));const parsed=await parseLedgerWorkbook(await exportLedgerWorkbook(backup));await testApp.resetAll();await testApp.restoreBackup(JSON.stringify(parsed.snapshot));return {differences:parsed.differences,same:JSON.stringify(snapshotViews(JSON.parse(await testApp.exportBackup())))===before,version:parsed.snapshot.schemaVersion}`)
  check('JSON与完整Excel保留模式/来源/再拆历史，重复恢复账务一致',restored.same&&restored.version===13&&restored.differences.length===0,JSON.stringify(restored))
  await act(`await testApp.restoreBackup(JSON.stringify(backup))`)
  check('恢复后仍保留原始两笔记录',await evaluate('JSON.stringify(testApp.records.filter(r=>r.sourceRow===h1||r.sourceRow===h2))===original'))
  // 保存最终12元卖出时只按真实5元成本计算，不重复加策略收益。
  await act(`window.ts=testApp.ledger.targets.filter(t=>t.priceCents===1200&&t.strategyMode==='baseT');await testApp.recordLotSales(ts.map(t=>({lotId:t.lotId,targetId:t.id,qty:t.qty})),500,1200,'2026-10-24')`)
  v=await state()
  check('做T最终卖出实际盈利2000元，与回本原损失分开累计',v.totals.profitCents===200000-67500&&v.chains[0].profit===0)
  check('有后续成交不能撤销回补来源',Boolean(await rejects(`await testApp.removeRebuy(testApp.executions.find(e=>e.orderId===o.id).id)`)))
  await act(`await testApp.resetAll();window.high=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'10',qty:'500',targetPrice:'12'});window.root=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'})`)
  await sleep(250)
  await act(`window.originalRoot=JSON.stringify(testApp.records)`)
  check('已有先卖单在未回补时提供模式选择',await evaluate(`!!document.querySelector('[data-grid-existing="'+root+'"]')`))
  await click('[data-testid=grid-existing] > summary')
  await evaluate(`(()=>{const e=document.querySelector('[data-grid-existing="'+root+'"]');e.value='baseT';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await sleep(400)
  check('切做T仅新增策略关联，原始记录不变，原回本链移出',await evaluate(`testApp.ledger.repairChains.length===0&&testApp.extraTargets.some(t=>t.strategy?.sellRow===root)&&JSON.stringify(testApp.records)===originalRoot`))
  check('做T期间阻止解除高位来源',Boolean(await rejects(`await testApp.clearHedgeLink(root)`)))
  await act(`await testApp.recordRebuy(testApp.ledger.orders.find(o=>o.sourceRow===root),500,500,0)`)
  v=await state()
  check('已有先卖单买回500后仅一份12元目标，保留实际亏损和做T策略收益',v.totals.netQty===500&&v.targets.length===1&&v.targets[0].priceCents===1200&&v.chains.length===0&&v.totals.profitCents===-150000)
  const markerRoundtrip=await act(`const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');const snapshot=JSON.parse(await testApp.exportBackup());const result=await parseLedgerWorkbook(await exportLedgerWorkbook(snapshot));const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);return canon(result.snapshot.extraTargets)===canon(snapshot.extraTargets)&&result.differences.length===0`)
  check('既有先卖单模式标记也完整Excel往返',markerRoundtrip)
  await evaluate(`document.querySelector('[data-testid=grid-status]').open=true;document.querySelector('[data-testid=grid-strategies]').scrollIntoView({block:'start'})`);await sleep(5300)
  const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,'strategies-mobile.png'),Buffer.from(shot.data,'base64'))
  await send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});await sleep(200)
  check('320px窄屏不横向溢出',await evaluate('document.documentElement.scrollWidth<=innerWidth'))
  check('无运行时错误',problems.length===0,problems.join(' | '))
  socket.close()
} finally {
  browser.kill()
  try {rmSync(profile,{recursive:true,force:true})}catch{}
}
console.log(ok?'\nGRID E2E PASS':'\nGRID E2E FAIL')
process.exit(ok?0:1)

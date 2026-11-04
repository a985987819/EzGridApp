/**
 * 统计收益专项：真实 store/IndexedDB、回补完成日、日历/月度一致、来源跳转与备份往返。
 * npm run dev 后：node e2e/statistics.mjs http://127.0.0.1:5184
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9469
const OUT = join(process.cwd(), 'e2e', 'out', 'statistics')
const browserPath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(browserPath, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已被占用，请使用独立测试端口`)
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-statistics-'))
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const problems = []
let socket, passed = 0
const check = (label, condition, detail) => {
  assert(condition, `${label}${detail ? ': ' + JSON.stringify(detail) : ''}`)
  passed++
  console.log('  PASS ' + label)
}

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
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(arg => arg.description ?? arg.value).join(' '))
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  const run = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 120; i++) { if (await run(expression)) return; await pause(100) }
    throw new Error('等待超时: ' + expression)
  }
  const act = async expression => { const value = await run(`(async()=>{${expression}})()`); await pause(180); return value }
  const click = async selector => {
    assert(await run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;element.scrollIntoView({block:'center'});element.click();return true})()`), '缺少元素 ' + selector)
    await pause(200)
  }
  const shot = async name => {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE })
  await until(`!!document.querySelector('[data-nav=stats]')`)
  await run(`(async()=>{
    const React=(await import('/node_modules/.vite/deps/react.js')).default
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source=await(await fetch('/src/pages/OrdersPage.tsx')).text()
    const storeUrl=source.match(/from "([^"]*store.useApp[^"]*)"/)[1]
    const {AppProvider,useApp}=await import(storeUrl)
    const {StatsPage}=await import('/src/pages/StatsPage.tsx')
    const {TradesPage}=await import('/src/pages/TradesPage.tsx')
    const {buildTradingStatistics}=await import('/src/domain/statistics.ts')
    localStorage.setItem('ezgrid.statsCal','2026-10')
    document.getElementById('root').style.display='none'
    const mount=document.createElement('div');mount.id='statistics-root';document.body.appendChild(mount)
    function Probe(){
      const app=useApp();window.testApp=app
      const [query,setQuery]=React.useState(null)
      window.showStatistics=()=>setQuery(null)
      window.statistics=()=>buildTradingStatistics(app.ledger,app.records,app.bookingReceipts)
      return app.ready?(query?React.createElement(TradesPage,{urlQuery:query}):React.createElement(StatsPage,{goTrades:next=>{window.lastTradesQuery=next;setQuery(next)}})):null
    }
    createRoot(mount).render(React.createElement(AppProvider,null,React.createElement(Probe)))
  })()`)
  await until(`window.testApp?.ready&&!!document.querySelector('#statistics-root [data-testid=stats-calendar]')`)
  await act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:50,priceLimitType:'main_10',enabled:true,order:-1})`)
  await act(`window.high=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-08-01',price:'10',qty:'500',targetPrice:'12'});
    window.root=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-08-25',price:'7',qty:'500',rebuyPrice:'5'});
    window.normal=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-01',price:'6',qty:'100',targetPrice:'6.5'});
    await testApp.recordLotSales([{lotId:'lot:'+normal,qty:100}],100,650,'2026-10-07')`)
  await act(`window.normalSale=testApp.records.find(record=>record.soldLotId==='lot:'+normal).sourceRow`)
  let statistics = await run('statistics()')
  check('正常先买后卖盈利50元进入统计，未回补先卖单不出现', statistics.events.length === 1 && statistics.events[0].kind === 'sale' && statistics.events[0].profitCents === 5000 && statistics.pendingRebuyCount === 1, statistics)
  check('先卖单默认低位回本并自动关联完整高位500股', await run(`testApp.ledger.orders.find(order=>order.sourceRow===root)?.strategyMode==='repair'&&testApp.ledger.effectiveHedges.some(link=>link.sellRow===root&&link.items.some(item=>item.row===high&&item.qty===500))`))
  check('高买低卖亏损保留总账和链，不进入日历收益', await run(`testApp.ledger.totals.profitCents===-145000&&testApp.ledger.repairChains.some(chain=>chain.lossCents===-150000)&&document.querySelector('[data-testid=stats-calendar]').textContent.includes('尚未全部回补')&&!document.querySelector('[data-testid=stats-calendar]').textContent.includes('-1,500')`))
  await act(`window.order=testApp.ledger.orders.find(item=>item.sourceRow===root);
    await testApp.recordBuySuggestion([{kind:'order',id:order.id,row:root,qty:200}],200,500,'2026-09-20')`)
  statistics = await run('statistics()')
  check('9月仅买回200股时仍整单不统计，不提前确认400元价差', statistics.events.length === 1 && statistics.monthly.every(month => month.month !== '2026-09') && statistics.pendingRebuyCount === 1, statistics)
  await act(`window.order=testApp.ledger.orders.find(item=>item.sourceRow===root);
    await testApp.recordBuySuggestion([{kind:'order',id:order.id,row:root,qty:300}],300,550,'2026-10-07')`)
  statistics = await run('statistics()')
  const completed = statistics.events.find(event => event.kind === 'rebuy')
  check('200股5元＋300股5.5元全回补，以实际均价5.30确认850元', completed?.date === '2026-10-07' && completed.originalSoldAt === '2026-08-25' && completed.qty === 500 && completed.buyPriceCents === 530 && completed.profitCents === 85000, completed)
  check('全部收益仅在10月完成日归集为900元、2笔600股', statistics.daily.length === 1 && statistics.daily[0].day === '2026-10-07' && statistics.daily[0].sellCount === 2 && statistics.daily[0].sellQty === 600 && statistics.daily[0].profitCents === 90000 && statistics.monthly.length === 1 && statistics.monthly[0].month === '2026-10' && statistics.monthly[0].profitCents === 90000 && statistics.pendingRebuyCount === 0, statistics)
  check('日历年月累计、月度列表和趋势均显示900元', await run(`document.querySelector('[data-stat-year="2026"]').textContent.includes('900.00')&&document.querySelector('[data-stat-month-total="2026-10"]').textContent.includes('900.00')&&document.querySelector('[data-stat-month="2026-10"]').textContent.includes('900.00')&&document.querySelector('[data-testid=profit-trend] .trend-col').title.includes('900.00')`))
  check('原8月卖出日与9月部分回补日不产生统计事件', statistics.events.every(event => event.date !== '2026-08-25' && event.date !== '2026-09-20') && await run(`!document.querySelector('[data-stat-month="2026-08"]')&&!document.querySelector('[data-stat-month="2026-09"]')`))
  await click('[data-testid=stats-calendar] [data-date="2026-10-07"]')
  check('完成日明细分别显示普通卖出与回补完成，不混用方向与成本', await run(`document.querySelector('[data-stat-kind=sale]').textContent.includes('卖出')&&document.querySelector('[data-stat-kind=sale]').textContent.includes('买入成本')&&document.querySelector('[data-stat-kind=rebuy]').textContent.includes('回补完成')&&document.querySelector('[data-stat-kind=rebuy]').textContent.includes('实际买回均价 5.30')&&document.querySelector('[data-stat-kind=rebuy]').textContent.includes('原卖出日 2026-08-25')`))
  check('日历格显示合计900元与2笔', await run(`document.querySelector('[data-testid=stats-calendar] .cal-day-stat').textContent.includes('+900')&&document.querySelector('[data-testid=stats-calendar] .cal-day-stat').textContent.includes('2笔')`))
  await run(`document.querySelector('[data-testid=stats-calendar]').scrollIntoView({block:'start'})`)
  await pause(350)
  await shot('calendar-completed-390')
  await click('[data-stat-kind=rebuy]')
  await until(`!!document.querySelector('#statistics-root [data-row="'+root+'"]')`)
  check('点击完成日回补记录，跳转真实明细且不以完成日过滤旧卖出行', await run(`!lastTradesQuery.from&&!lastTradesQuery.to&&!!lastTradesQuery.id&&lastTradesQuery.stock==='T'&&!!document.querySelector('#statistics-root [data-row="'+root+'"]')`))
  await act('showStatistics()')
  await until(`!!document.querySelector('#statistics-root [data-testid=stats-calendar]')`)
  await click('[data-testid=stats-calendar] [data-date="2026-10-07"]')
  await run(`(()=>{const button=[...document.querySelectorAll('[data-testid=stats-calendar] button')].find(element=>element.textContent.includes('看这天明细'));button.click()})()`)
  await until(`!!document.querySelector('#statistics-root [data-row="'+root+'"]')&&!!document.querySelector('#statistics-root [data-row="'+normalSale+'"]')`)
  check('完成日整体明细同时保留两笔真实来源，已完成订单不被隐藏', await run(`lastTradesQuery.showDone===true&&!lastTradesQuery.from&&!lastTradesQuery.to&&document.querySelectorAll('#statistics-root [data-row]').length===2`))
  await act('showStatistics()')
  await until(`!!document.querySelector('#statistics-root [data-testid=stats-calendar]')`)
  await act(`window.fullBackup=await testApp.exportBackup();window.expectedStatistics=JSON.stringify(statistics());await testApp.resetAll();await testApp.restoreBackup(fullBackup)`)
  check('JSON恢复保留实际回补来源、完成日期与900元收益', await run('JSON.stringify(statistics())===expectedStatistics'))
  const workbook = await act(`const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');
    const result=await parseLedgerWorkbook(await exportLedgerWorkbook(JSON.parse(fullBackup)));
    await testApp.resetAll();await testApp.restoreBackup(JSON.stringify(result.snapshot));
    return {differences:result.differences}`)
  check('完整Excel恢复后统计一致且无核对差异', await run('JSON.stringify(statistics())===expectedStatistics') && workbook.differences.length === 0, workbook)
  await act(`const last=testApp.executions.find(execution=>execution.sellExecId==='sell:'+root&&execution.priceCents===550);await testApp.removeRebuy(last.id)`)
  statistics = await run('statistics()')
  check('撤销最后300股后回补收益整笔消失，仍只统计普通盈利50元', statistics.events.length === 1 && statistics.events[0].profitCents === 5000 && statistics.pendingRebuyCount === 1 && await run(`document.querySelector('[data-stat-month-total="2026-10"]').textContent.includes('50.00')`), statistics)
  await act('await testApp.restoreBackup(fullBackup)')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  await click('[data-testid=stats-calendar] [data-date="2026-10-07"]')
  check('320px日历及完成记录不横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  await run(`document.querySelector('[data-testid=stats-calendar]').scrollIntoView({block:'start'})`)
  await pause(350)
  await shot('calendar-completed-320')
  check('总账和回本链仍保留原高位亏损，不重复加统计价差', await run(`testApp.ledger.totals.profitCents===-145000&&testApp.ledger.repairChains.some(chain=>chain.lossCents===-150000&&chain.profitCents===0)&&testApp.ledger.checks.every(check=>check.ok)`))
  check('页面无运行时错误和React警告', problems.length === 0, problems)
  console.log(`\nSTATISTICS E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(250)
  const resolved = resolve(profile)
  if (resolved.startsWith(resolve(tmpdir()) + sep) && basename(resolved).startsWith('grid-statistics-')) {
    try { rmSync(resolved, { recursive: true, force: true }) } catch { /* browser may still release files */ }
  }
}

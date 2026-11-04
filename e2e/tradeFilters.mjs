/** 合并挂单来源跳转和明细序号筛选；真实 App/IndexedDB。node e2e/tradeFilters.mjs http://127.0.0.1:5184 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9473
const OUT = join(process.cwd(), 'e2e', 'out', 'trade-filters')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-trade-filters-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
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
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch { /* browser starting */ }
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
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 120; i++) { if (await run(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('等待超时: ' + expression + '\n页面状态: ' + JSON.stringify(await run('({hash:location.hash,text:document.body.innerText.slice(0,600)})')) + '\n运行时异常: ' + JSON.stringify(problems))
  }
  const act = async expression => { const result = await run(`(async()=>{${expression}})()`); await pause(200); return result }
  const click = async selector => {
    assert(await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '缺少元素 ' + selector)
    await pause(250)
    await until(`!document.documentElement.dataset.transition`)
  }
  const input = async (selector, value) => {
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('缺少筛选输入框');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await pause(150)
  }
  const query = () => run(`Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]??''))`)
  const visibleRows = () => run(`[...document.querySelectorAll('.app-main .trade-item[data-row]')].map(e=>Number(e.dataset.row)).sort((a,b)=>a-b)`)
  const expectRows = async (label, rows) => {
    const expected = [...rows].sort((a, b) => a - b)
    await until(`JSON.stringify([...document.querySelectorAll('.app-main .trade-item[data-row]')].map(e=>Number(e.dataset.row)).sort((a,b)=>a-b))===${JSON.stringify(JSON.stringify(expected))}`)
    check(label, JSON.stringify(await visibleRows()) === JSON.stringify(expected), await visibleRows())
  }
  const shot = async name => {
    await run('window.scrollTo({top:0,behavior:"instant"})')
    await pause(350)
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const installSeed = async () => {
    await run(`(async()=>{
      if(window.seedApp?.ready)return
      const React=(await import('/node_modules/.vite/deps/react.js')).default
      const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const source=await(await fetch('/src/pages/OrdersPage.tsx')).text(),storeUrl=source.match(/from "([^"]*store.useApp[^"]*)"/)[1]
      const {AppProvider,useApp}=await import(storeUrl)
      const mount=document.createElement('div');mount.id='trade-filter-seed';mount.hidden=true;document.body.appendChild(mount)
      function Probe(){window.seedApp=useApp();return null}
      createRoot(mount).render(React.createElement(AppProvider,null,React.createElement(Probe)))
    })()`)
    await until('window.seedApp?.ready')
  }
  const reset = async () => {
    await installSeed()
    await act(`await seedApp.resetAll();await seedApp.addStock({id:'stock:T',name:'T',intervalCents:50,priceLimitType:'main_10',enabled:true,order:-1});seedApp.patchOrdersSession({stockName:'T',closes:{T:'6'},confirmedCents:{T:600},overrides:{T:{down:400,up:900}}})`)
  }
  const openOrders = async () => {
    await run(`location.hash='#/orders'`)
    await pause(250)
    await send('Page.reload')
    await until(`document.querySelector('[data-nav=orders][aria-current=page]')&&document.querySelector('[data-sticky=orders]')`)
    await pause(200)
  }
  const factSnapshot = () => run(`(async()=>{const {db}=await import('/src/store/db.ts');return JSON.stringify({records:await db.records.toArray(),execs:await db.rebuyExecutions.toArray(),plans:await db.plans.toArray()})})()`)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE + '/#/orders' })
  await until(`!!document.querySelector('[data-nav=orders]')`)

  await reset()
  const sell = await act(`const a=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'6',qty:'500',targetPrice:'7'});const b=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-21',price:'6.1',qty:'300',targetPrice:'7'});const other=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-22',price:'6.2',qty:'200',targetPrice:'7.5'});return {a,b,other}`)
  await openOrders()
  const beforeFilters = await factSnapshot()
  await click('.pending-sell[data-merge-group]')
  await expectRows('同价合并卖单点击整行，同时筛出两笔实际来源，不混入其它挂单', [sell.a, sell.b])
  let q = await query()
  check('合并来源以去重ID列表写入URL，可复制分享', q.id?.split(',').length === 2 && q.stock === 'T', q)
  check('明细来源面板逐笔展示并可单独移除', await run(`document.querySelectorAll('[data-testid=trade-source-selection] [data-remove-source]').length===2`))
  await shot('merged-sell-sources-390')
  const selectedId = q.id.split(',')[0]
  await click(`[data-remove-source="${selectedId}"]`)
  q = await query()
  const oneRow = await visibleRows()
  check('移除一个来源只保留另一笔，ID列表同步缩减', oneRow.length === 1 && [sell.a, sell.b].includes(oneRow[0]) && q.id?.split(',').length === 1 && q.stock === 'T', { q, oneRow })
  await send('Page.reload')
  await expectRows('刷新保留剩余单笔来源筛选', oneRow)
  await run('history.back()')
  await until(`!!document.querySelector('[data-nav=orders][aria-current=page]')`)
  await run('history.forward()')
  await expectRows('浏览器后退回挂单，再前进仍保留来源筛选', oneRow)
  await click('[data-action=clear-source-selection]')
  await expectRows('清除来源选择恢复当前股票列表', [sell.a, sell.b, sell.other])
  q = await query()
  check('清除来源不清除股票条件，也不残留隐藏ID', q.stock === 'T' && !q.id, q)
  check('浏览来源、移除、刷新与清除筛选不修改成交和计划', await factSnapshot() === beforeFilters)

  await reset()
  const buy = await act(`const a=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});const b=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-22',price:'7.1',qty:'300',rebuyPrice:'5'});const other=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-23',price:'7.2',qty:'200',rebuyPrice:'5.5'});return {a,b,other}`)
  await openOrders()
  await click('[data-testid=buy-suggestion][data-price="500"] [data-action=view-sources]')
  await expectRows('同价合并买建议查看全部来源，精确筛出两笔卖单', [buy.a, buy.b])
  check('合并买建议URL保留全部来源ID', (await query()).id?.split(',').length === 2)

  await reset()
  const next = await act(`const a=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',buyPrice:'5',buyQty:'500',buyDate:'2026-10-01',repaid:true});const b=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-22',price:'7.1',qty:'300',buyPrice:'5',buyQty:'300',buyDate:'2026-10-02',repaid:true});const other=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-23',price:'7.2',qty:'200',buyPrice:'5.2',buyQty:'200',buyDate:'2026-10-03',repaid:true});return {a,b,other}`)
  await openOrders()
  await click('[data-testid=buy-suggestion][data-price="500"]')
  await expectRows('下一轮合并建议跳转能同时显示两笔已完成来源', [next.a, next.b])

  await reset()
  const splitRoot = await act(`const row=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});await seedApp.addBuyTarget(row,450,200);return row`)
  await act(`const {buildBuySuggestions}=await import('/src/domain/suggestions.ts');await seedApp.savePlans('buy',buildBuySuggestions(seedApp.ledger.buySplits,[],[]).map(row=>({key:row.key,priceCents:440,qty:100})))`)
  await openOrders()
  await click('[data-testid=buy-suggestion][data-price="440"]')
  await expectRows('同一卖单多个拆档碰价合并，来源行去重为一笔', [splitRoot])
  check('拆档去重后URL只有一个有效ID', (await query()).id?.split(',').length === 1)

  await reset()
  const virtual = await act(`const root=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-20',price:'7',qty:'500',rebuyPrice:'5'});return {root}`)
  await act(`const order=seedApp.ledger.orders.find(o=>o.sourceRow===${virtual.root});await seedApp.recordBuySuggestion([{kind:'order',id:order.id,row:${virtual.root},qty:500}],500,500,'2026-10-21')`)
  virtual.real = await act(`return await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-23',price:'6',qty:'300',targetPrice:'5.5'})`)
  await openOrders()
  await click('.pending-sell[data-merge-group]')
  await expectRows('回补虚拟批次与真实批次合并，跳转解析为回补根卖单及真实来源', [virtual.root, virtual.real])
  check('虚拟批次不以不存在的200000段ID退成全股票列表', (await query()).id?.split(',').length === 2)

  await reset()
  const four = await act(`const rows=[];for(let i=0;i<4;i++)rows.push(await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-'+(20+i),price:String(6+i/10),qty:'100',targetPrice:String(7+i/10)}));return rows`)
  await openOrders()
  await click('[data-nav=trades]')
  await until(`!!document.querySelector('[data-testid=record-selection-input]')`)
  await input('[data-testid=record-selection-input]', '1,3-4')
  await click('[data-action=apply-record-selection]')
  await expectRows('按序号列表和范围1,3-4筛选，显示第1/3/4笔', [four[0], four[2], four[3]])
  q = await query()
  check('手工序号筛选写入URL nos参数，刷新可恢复', Boolean(q.nos), q)
  await run(`document.querySelector('[data-testid=trade-range-filter]').open=true`)
  await input('[data-testid=filter-price-low]', '6.2')
  await input('[data-testid=filter-price-high]', '6.3')
  await input('[data-field=filter-from]', '2026-10-22')
  await input('[data-field=filter-to]', '2026-10-23')
  await click('[data-action=apply-range-filter]')
  await expectRows('价格和日期区间与序号列表取交集，保留第3/4笔', [four[2], four[3]])
  const rangeHash = await run('location.hash')
  await input('[data-testid=filter-price-low]', '8')
  await input('[data-testid=filter-price-high]', '7')
  await click('[data-action=apply-range-filter]')
  check('倒序价格区间提示错误，不覆盖已生效区间或扩大结果', await run(`!!document.querySelector('[data-testid=trade-range-filter] [role=alert]')&&location.hash===${JSON.stringify(rangeHash)}`) && (await visibleRows()).length === 2)
  await input('[data-testid=filter-price-low]', '6.2')
  await input('[data-testid=filter-price-high]', '6.3')
  await input('[data-field=filter-from]', '2026-10-24')
  await input('[data-field=filter-to]', '2026-10-20')
  await click('[data-action=apply-range-filter]')
  check('倒序日期区间同样保留原筛选结果', await run(`!!document.querySelector('[data-testid=trade-range-filter] [role=alert]')&&location.hash===${JSON.stringify(rangeHash)}`) && (await visibleRows()).length === 2)
  await click('[data-action=clear-range-filter]')
  await expectRows('清除区间时保留序号列表筛选', [four[0], four[2], four[3]])
  const validHash = await run('location.hash')
  await send('Page.reload')
  await expectRows('刷新恢复序号列表和范围筛选', [four[0], four[2], four[3]])
  await input('[data-testid=record-selection-input]', '1,nope')
  await click('[data-action=apply-record-selection]')
  check('非法序号显示明确提示，保留已生效条件而不扩大为全部记录', await run(`!!document.querySelector('[data-testid=record-selection-error]')&&location.hash===${JSON.stringify(validHash)}`) && (await visibleRows()).length === 3)
  await input('[data-testid=record-selection-input]', '第2笔、4')
  await click('[data-action=apply-record-selection]')
  await expectRows('中文第几笔和顿号也能组成序号列表', [four[1], four[3]])
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: true })
  check('320px序号筛选、来源和结果没有横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  await shot('record-list-filter-320')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1100, deviceScaleFactor: 1, mobile: true })
  await run(`document.querySelector('[data-testid=trade-range-filter]').open=true`)
  await pause(250)
  check('320px展开价格日期表单也无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  await shot('range-filter-320')
  await click('[data-action=clear-record-selection]')
  await expectRows('单独清除序号条件恢复记录列表', four)
  check('清除后URL不残留nos筛选', !(await query()).nos)
  const combinedIds = await run(`(async()=>{const {db}=await import('/src/store/db.ts'),{buildNanoIdIndex}=await import('/src/ui/nanoid.ts');const index=buildNanoIdIndex(await db.records.toArray());return [${four[0]},${four[1]}].map(row=>index.rowToId.get(row)).join(',')})()`)
  await run(`location.hash='#/trades?'+new URLSearchParams({stock:'T',id:${JSON.stringify(combinedIds)},nos:'2'}).toString()`)
  await expectRows('组合链接的来源列表与序号条件同时生效', [four[1]])
  await click('[data-action=clear-record-selection]')
  await until(`document.querySelectorAll('.app-main .trade-item[data-row]').length===2`)
  q = await query()
  check('组合链接清除序号只删除nos，保留两笔来源和股票', q.id === combinedIds && !q.nos && q.stock === 'T' && JSON.stringify(await visibleRows()) === JSON.stringify([four[0], four[1]]), q)
  check('无浏览器运行时异常或React警告', problems.length === 0, problems)
  console.log(`\nTRADE FILTERS E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(250)
  const resolved = resolve(profile)
  if (resolved.startsWith(resolve(tmpdir()) + sep) && basename(resolved).startsWith('grid-trade-filters-')) {
    try { rmSync(resolved, { recursive: true, force: true }) } catch { /* browser release pending */ }
  }
}

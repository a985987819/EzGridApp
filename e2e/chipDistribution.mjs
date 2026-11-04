/** 概览个股筹码分布；真实 App/IndexedDB。node e2e/chipDistribution.mjs http://127.0.0.1:5184 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9477
const OUT = join(process.cwd(), 'e2e', 'out', 'chip-distribution')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-chip-distribution-'))
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
    for (let i = 0; i < 160; i++) { if (await run(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('等待超时: ' + expression + '\n页面状态: ' + JSON.stringify(await run('({hash:location.hash,text:document.body.innerText.slice(0,1200)})')) + '\n运行时异常: ' + JSON.stringify(problems))
  }
  const act = async expression => { const result = await run(`(async()=>{${expression}})()`); await pause(200); return result }
  const click = async selector => {
    assert(await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '缺少元素 ' + selector)
    await pause(250)
    await until(`!document.documentElement.dataset.transition`)
  }
  const input = async (selector, value) => {
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('缺少输入框');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await pause(150)
  }
  const card = '[data-testid=overview-chip-distribution]'
  const hot = '[data-testid=chip-hot-range]'
  const holding = '[data-testid=chip-holding-range]'
  const facts = () => run(`(async()=>{const {db}=await import('/src/store/db.ts');const result={};for(const table of db.tables)result[table.name]=await table.toArray();return JSON.stringify(result)})()`)
  const summaries = () => run(`(()=>{const root=document.querySelector(${JSON.stringify(card)});return {stock:root?.dataset.stock,totalCount:Number(root?.dataset.totalTradeCount),totalHolding:Number(root?.dataset.totalHoldingQty),hot:{...root?.querySelector(${JSON.stringify(hot)})?.dataset},holding:{...root?.querySelector(${JSON.stringify(holding)})?.dataset},text:root?.innerText}})()`)
  const expectRows = async (label, rows) => {
    const expected = [...new Set(rows)].sort((a, b) => a - b)
    const expression = `JSON.stringify([...document.querySelectorAll('.app-main .trade-item[data-row]')].map(e=>Number(e.dataset.row)).sort((a,b)=>a-b))===${JSON.stringify(JSON.stringify(expected))}`
    await until(expression)
    check(label, await run(expression), expected)
  }
  const installSeed = async () => {
    await run(`(async()=>{
      if(window.seedApp?.ready)return
      const React=(await import('/node_modules/.vite/deps/react.js')).default
      const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const source=await(await fetch('/src/pages/OrdersPage.tsx')).text(),storeUrl=source.match(/from "([^"]*store.useApp[^"]*)"/)[1]
      const {AppProvider,useApp}=await import(storeUrl)
      const mount=document.createElement('div');mount.hidden=true;document.body.appendChild(mount)
      function Probe(){window.seedApp=useApp();return null}
      createRoot(mount).render(React.createElement(AppProvider,null,React.createElement(Probe)))
    })()`)
    await until('window.seedApp?.ready')
  }
  const reset = async () => {
    await installSeed()
    await act(`await seedApp.resetAll();await seedApp.addStock({id:'stock:T',name:'T',intervalCents:50,priceLimitType:'main_10',enabled:true,order:-2});await seedApp.addStock({id:'stock:U',name:'U',intervalCents:50,priceLimitType:'main_10',enabled:true,order:-1});seedApp.patchOrdersSession({stockName:'T',closes:{T:'6'},confirmedCents:{T:600},overrides:{T:{down:400,up:1200}}})`)
  }
  const openOverview = async (stock = 'T') => {
    await run(`location.hash='#/overview'`)
    await pause(200)
    await send('Page.reload')
    await until(`document.querySelector('[data-nav=overview][aria-current=page]')&&document.querySelector(${JSON.stringify(card)})`)
    await run(`(()=>{const tab=[...document.querySelector('.overview-head .stock-tabs').children].find(e=>e.textContent.trim()===${JSON.stringify(stock)});tab?.click()})()`)
    await until(`document.querySelector(${JSON.stringify(card)})?.dataset.stock===${JSON.stringify(stock)}`)
    await pause(250)
  }
  const shot = async name => {
    await run(`document.querySelector(${JSON.stringify(card)}).scrollIntoView({block:'start'})`)
    await pause(300)
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE + '/#/overview' })
  await until(`document.querySelector('[data-nav=overview]')`)
  await reset()
  const seed = await act(`
    const a=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-01',price:'5',qty:'100',targetPrice:'6'});
    const b=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-02',price:'5.2',qty:'100',targetPrice:'6'});
    const c=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-03',price:'5',qty:'100',targetPrice:'6'});
    const d=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-04',price:'9',qty:'1000',targetPrice:'10'});
    const e=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-05',price:'9.2',qty:'600',targetPrice:'10'});
    const u=await seedApp.addManualRecord({kind:'buy',stockName:'U',date:'2026-10-06',price:'2',qty:'900',targetPrice:'3'});
    const merged=await seedApp.recordLotSales([{lotId:'lot:'+a,qty:100},{lotId:'lot:'+b,qty:100}],200,510,'2026-10-07');
    const partial=await seedApp.recordLotSales([{lotId:'lot:'+d,qty:200}],200,1000,'2026-10-08');
    return {a,b,c,d,e,u,merged,partial};`)
  await openOverview()
  const before = await facts()
  let data = await summaries()
  check('个股成交频次按实际回执计数，合并两份卖出分配只算一次', data.totalCount === 7, data)
  check('成交最高频次窗口5.00—5.20包含3买1卖，共4笔500股', Number(data.hot.lo) === 500 && Number(data.hot.hi) === 520 && Number(data.hot.count) === 4 && Number(data.hot.qty) === 500, data.hot)
  check('大量未完成买单窗口9.00—9.20仅算剩余800+600股', Number(data.holding.lo) === 900 && Number(data.holding.hi) === 920 && Number(data.holding.qty) === 1400 && data.totalHolding === 1500, data)
  check('两类集中度分别按成交笔数和剩余股数显示57.1%与93.3%', data.text.includes('57.1%') && data.text.includes('93.3%'), data.text)
  check('标题、全历史频次与实际成本剩余股数口径清晰展示', data.text.includes('成交最高频次范围为') && data.text.includes('大量未完成买单范围') && data.text.includes('历史') && data.text.includes('剩余'), data.text)
  await click('[data-testid=chip-distribution-details] > summary')
  check('明细价位5.10只有一笔真实卖出，分配行不重复增加频次', await run(`document.querySelector('[data-chip-price="510"]')?.dataset.tradeCount==='1'`))
  check('明细9.00按部分卖出后的800股展示，已卖光5.20为0股', await run(`document.querySelector('[data-chip-price="900"]')?.dataset.holdingQty==='800'&&document.querySelector('[data-chip-price="520"]')?.dataset.holdingQty==='0'`))
  await shot('stock-t-distribution-390')
  await click('[data-action=chip-hot-sources]')
  await expectRows('高频区间查看全部精确来源，包括已完成历史和一次成交的两份分配', [seed.a, seed.b, seed.c, ...seed.merged.recordRows])
  check('高频来源跳转不靠价格筛选扩大匹配', await run(`(()=>{const q=new URLSearchParams(location.hash.split('?')[1]);return q.get('stock')==='T'&&q.get('id').split(',').length===5&&!q.has('price')&&!q.has('priceLo')})()`))
  await click('[data-nav=overview]')
  await until(`document.querySelector(${JSON.stringify(card)})?.dataset.stock==='T'`)
  await click('[data-action=chip-holding-sources]')
  await expectRows('高位剩余集中区间仅筛两笔实际买入来源', [seed.d, seed.e])
  await click('[data-nav=overview]')
  await until(`document.querySelector(${JSON.stringify(card)})`)
  await run(`(()=>{const tab=[...document.querySelector('.overview-head .stock-tabs').children].find(e=>e.textContent.trim()==='U');tab.click()})()`)
  await until(`document.querySelector(${JSON.stringify(card)})?.dataset.stock==='U'`)
  data = await summaries()
  check('切换个股独立重算，不混入T的价格、成交和持仓', data.totalCount === 1 && data.totalHolding === 900 && Number(data.hot.lo) === 200 && Number(data.hot.hi) === 200 && Number(data.holding.qty) === 900, data)
  check('浏览统计和来源跳转不改变任何IndexedDB表', await facts() === before)

  await installSeed()
  await act(`await seedApp.addExtraTarget('lot:${seed.d}',1500,100);const target=seedApp.ledger.targets.find(t=>t.lotId==='lot:${seed.e}');await seedApp.setPlan('sell',target.id,2000,100)`)
  await openOverview()
  data = await summaries()
  check('拆分待卖与改单价格不改变实际成交范围和原成本筹码范围', data.totalCount === 7 && Number(data.hot.lo) === 500 && Number(data.hot.hi) === 520 && Number(data.holding.lo) === 900 && Number(data.holding.hi) === 920 && Number(data.holding.qty) === 1400, data)

  await reset()
  const rebuy = await act(`const high=await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-09-01',price:'10',qty:'500',targetPrice:'11'});const root=await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-01',price:'7',qty:'500',rebuyPrice:'5'});return {high,root}`)
  await act(`const order=seedApp.ledger.orders.find(o=>o.sourceRow===${rebuy.root});await seedApp.recordBuySuggestion([{kind:'order',id:order.id,row:${rebuy.root},qty:500}],500,500,'2026-10-02')`)
  await openOverview()
  data = await summaries()
  check('先卖后买含一次实际回补，共3笔成交，不重复计算合成挂钩或虚拟库存', data.totalCount === 3 && data.totalHolding === 500, data)
  check('回补持仓采用实际5元成本500股，高位已交割份额不再计入', Number(data.holding.lo) === 500 && Number(data.holding.hi) === 500 && Number(data.holding.qty) === 500, data)
  await click('[data-action=chip-holding-sources]')
  await expectRows('虚拟回补持仓来源解析到原卖出记录，不跳不存在的200000段', [rebuy.root])
  await click('[data-nav=overview]')
  await until(`document.querySelector(${JSON.stringify(card)})`)
  const beforeSandbox = await facts()
  await click('[data-nav=orders]')
  await click('[data-sandbox-toggle]')
  await click('[data-action=sandbox-add-buy]')
  await input('[data-field=sandboxDate]', '2026-11-01')
  await input('[data-field=sandboxPrice]', '5.2')
  await input('[data-field=sandboxQty]', '1000')
  await input('[data-field=sandboxExtra]', '6.2')
  await click('[data-action=sandbox-save]')
  await until(`!document.querySelector('[data-field=sandboxPrice]')`)
  await click('[data-nav=overview]')
  await until(`document.querySelector(${JSON.stringify(card)})?.dataset.preview==='1'`)
  data = await summaries()
  check('沙盒预览明确含模拟，成交频次和成本库存同步重算', data.totalCount === 4 && data.totalHolding === 1500 && Number(data.holding.qty) === 1500 && data.text.includes('模拟'), data)
  check('混合模拟来源不能退成真实来源子集跳转', await run(`document.querySelector('[data-action=chip-holding-sources]')?.disabled===true`))
  check('模拟统计没有写入真实成交、库存或其它数据库表', await facts() === beforeSandbox)
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1100, deviceScaleFactor: 1, mobile: true })
  await click('[data-testid=chip-distribution-details] > summary')
  check('320px分布摘要、价位明细及来源按钮无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  await pause(5000) // 让「已加入沙盒」短暂通知自然收起，截图不遮住统计摘要。
  await shot('sandbox-distribution-320')
  await send('Page.reload')
  await until(`document.querySelector(${JSON.stringify(card)})`)
  data = await summaries()
  check('刷新清空沙盒后恢复真实3笔成交、500股回补持仓', data.totalCount === 3 && data.totalHolding === 500, data)

  await reset()
  await act(`await seedApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-10',price:'7',qty:'100',buyPrice:'5',buyQty:'100',buyDate:'2026-10-01',repaid:true})`)
  await openOverview()
  data = await summaries()
  check('没有剩余买入批次时不伪造集中持仓区间', data.totalHolding === 0 && !Number(data.holding.qty), data)
  await reset()
  await act(`for(let i=0;i<12;i++)await seedApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-01',price:String(2+i),qty:'100',targetPrice:String(3+i)})`)
  await openOverview()
  await click('[data-testid=chip-distribution-details] > summary')
  check('价位较多时首批只呈现10档，避免一次铺满长表', await run(`document.querySelectorAll('[data-chip-price]').length===10&&!!document.querySelector('[data-action=chip-more-levels]')`))
  await click('[data-action=chip-more-levels]')
  check('继续查看可展开剩余价位，实际12档各出现一次', await run(`document.querySelectorAll('[data-chip-price]').length===12&&new Set([...document.querySelectorAll('[data-chip-price]')].map(e=>e.dataset.chipPrice)).size===12&&!document.querySelector('[data-action=chip-more-levels]')`))
  check('无浏览器运行时异常或React警告', problems.length === 0, problems)
  console.log(`\nCHIP DISTRIBUTION E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(250)
  const resolved = resolve(profile)
  if (resolved.startsWith(resolve(tmpdir()) + sep) && basename(resolved).startsWith('grid-chip-distribution-')) {
    try { rmSync(resolved, { recursive: true, force: true }) } catch { /* browser release pending */ }
  }
}

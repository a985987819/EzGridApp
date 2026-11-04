/** 挂单原推荐对照：真实 store/IndexedDB 与 OrdersPage；node e2e/orderOriginal.mjs http://127.0.0.1:5184 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9471
const OUT = join(process.cwd(), 'e2e', 'out', 'order-original')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-order-original-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const problems = []
let socket, passed = 0
const check = (label, condition, detail) => { assert(condition, `${label}${detail ? ': ' + JSON.stringify(detail) : ''}`); passed++; console.log('  PASS ' + label) }
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
    if (pending.has(message.id)) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result) }
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map(arg => arg.description ?? arg.value).join(' '))
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })) })
  const run = async expression => { const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value }
  const until = async expression => { for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(100) } throw new Error('等待超时: ' + expression) }
  const act = async expression => { const value = await run(`(async()=>{${expression}})()`); await pause(200); return value }
  const click = async selector => { assert(await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '缺少 ' + selector); await pause(200) }
  const shot = async name => { const result = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name + '.png'), Buffer.from(result.data, 'base64')) }
  const shotRow = async (name, selector) => {
    await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'end'})`)
    await pause(450)
    await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();window.scrollBy(0,r.top-Math.max(420,innerHeight-r.height-16))})()`)
    await pause(250)
    const clip = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,r.left),y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()`)
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
    writeFileSync(join(OUT, name + '.png'), Buffer.from(result.data, 'base64'))
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE }); await until(`!!document.querySelector('[data-nav=orders]')`)
  await run(`(async()=>{
    const React=(await import('/node_modules/.vite/deps/react.js')).default
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source=await(await fetch('/src/pages/OrdersPage.tsx')).text(),storeUrl=source.match(/from "([^"]*store.useApp[^"]*)"/)[1]
    const {AppProvider,useApp}=await import(storeUrl),{OrdersPage}=await import('/src/pages/OrdersPage.tsx')
    const {mergeTargetRows}=await import('/src/domain/merge.ts')
    const {buildBuySuggestions,consumedNextRounds}=await import('/src/domain/suggestions.ts')
    const {buildNextRoundBuyRows}=await import('/src/domain/buyBoard.ts')
    document.getElementById('root').style.display='none';const el=document.createElement('div');el.id='original-orders-test';document.body.appendChild(el)
    function Probe(){const a=useApp();window.testApp=a;window.currentBuys=()=>buildBuySuggestions(a.ledger.buySplits,buildNextRoundBuyRows({...a.ledger,merges:a.merges,consumed:consumedNextRounds(a.records)}),a.plans);window.currentSells=()=>mergeTargetRows({...a.ledger,merges:a.merges,plans:a.plans});return a.ready?React.createElement(OrdersPage,{goTrades:()=>{}}):null}
    createRoot(el).render(React.createElement(AppProvider,null,React.createElement(Probe)))
    window.originalRead=selector=>{const row=document.querySelector(selector),small=row?.querySelector('[data-testid=order-original]');return row?{main:row.querySelector('.t1')?.textContent,amount:row.querySelector('.right')?.textContent,qty:Number(small?.dataset.originalQty),originalAmount:Number(small?.dataset.originalAmount),label:small?.textContent}:null}
  })()`)
  await until(`window.testApp?.ready`)
  const reset = async () => act(`await testApp.resetAll();await testApp.addStock({id:'stock:T',name:'T',intervalCents:50,priceLimitType:'main_10',enabled:true,order:-1});testApp.patchOrdersSession({stockName:'T',closes:{T:'6'},confirmedCents:{T:600},overrides:{T:{down:400,up:900}}})`)
  await reset()
  await act(`window.buyRoot=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});window.sellLot=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'6',qty:'500',targetPrice:'7'})`)
  const buySelector = '[data-testid=buy-suggestion][data-price="500"]'
  let value = await run(`originalRead(${JSON.stringify(buySelector)})`)
  check('未改单买单原推荐与当前相同：500股、2500元', value?.qty === 500 && value.originalAmount === 250000 && value.main.includes('5.00') && value.main.includes('500'), value)
  value = await run(`originalRead('#original-orders-test .pending-sell[data-row="'+sellLot+'"]')`)
  check('未改单卖单原推荐与当前相同：500股、3500元', value?.qty === 500 && value.originalAmount === 350000 && value.main.includes('7.00'), value)
  await act(`window.originalRecords=JSON.stringify(testApp.records);await testApp.savePlans('buy',[{key:currentBuys().find(row=>row.sources.some(source=>source.row===buyRoot)).key,priceCents:480,qty:200}]);await testApp.savePlans('sell',[{key:currentSells().find(row=>row.lotRows.includes(sellLot)).key,priceCents:720,qty:200}])`)
  value = await run(`originalRead('[data-testid=buy-suggestion][data-price="480"]')`)
  check('买单改4.80×200显示960元，原推荐仍500股2500元', value?.main.includes('4.80') && value.main.includes('200') && value.amount.includes('960.00') && value.qty === 500 && value.originalAmount === 250000, value)
  value = await run(`originalRead('#original-orders-test .pending-sell[data-row="'+sellLot+'"]')`)
  check('卖单改7.20×200显示1440元，原推荐仍500股3500元', value?.main.includes('7.20') && value.main.includes('200') && value.amount.includes('1,440.00') && value.qty === 500 && value.originalAmount === 350000, value)
  check('改单对照标签明确写原推荐，原始交易记录未改', value.label.includes('原推荐') && await run('JSON.stringify(testApp.records)===originalRecords'))
  await run(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedOrders=text}}});window.csvBlobs=[];URL.createObjectURL=blob=>{csvBlobs.push(blob);return 'blob:order-original-test'};HTMLAnchorElement.prototype.click=function(){}`)
  await run(`(()=>{const buttons=[...document.querySelectorAll('#original-orders-test button')];buttons.find(button=>button.textContent.trim()==='复制').click();buttons.find(button=>button.textContent.trim()==='CSV').click()})()`)
  await pause(200)
  const output = await run(`(async()=>({copy:copiedOrders,csv:await csvBlobs.at(-1).text()}))()`)
  check('复制和CSV继续使用改单后的实际挂单价量，没有混入原推荐', output.copy.includes('4.80 × 200') && output.copy.includes('7.20 × 200') && output.csv.includes('4.80,200,960.00') && output.csv.includes('7.20,200,1440.00') && !output.csv.includes('原推荐'), output)
  await click('[data-testid=buy-suggestion][data-price="480"] [data-action=suggestion-buy]')
  check('买入成交弹窗默认仍采用改单后4.80与200股', await run(`document.querySelector('[data-field=tradeQty]')?.value==='200'&&document.querySelector('[data-field=tradePrice]')?.value==='4.80'||document.querySelector('[data-field=execQty]')?.value==='200'&&document.querySelector('[data-field=execPrice]')?.value==='4.80'`))
  await run(`(()=>{const modal=document.querySelector('[role=dialog]');[...modal.querySelectorAll('button')].find(button=>button.textContent.trim()==='取消').click()})()`);await pause(250)
  await act(`await testApp.recordLotSales([{lotId:'lot:'+sellLot,qty:100}],100,720,'2026-10-22')`)
  value = await run(`originalRead('#original-orders-test .pending-sell[data-row="'+sellLot+'"]')`)
  check('部分卖出100后原推荐随真实剩余减为400股2800元', value?.qty === 400 && value.originalAmount === 280000 && value.main.includes('200'), value)
  await act(`const order=testApp.ledger.orders.find(row=>row.sourceRow===buyRoot);await testApp.recordBuySuggestion([{kind:'order',id:order.id,row:buyRoot,qty:100}],100,480,'2026-10-23')`)
  // 新增4.80实际库存后，同价推荐被既有最低成本规则过滤；再明确调低未成交计划以核对剩余参考。
  await act(`await testApp.savePlans('buy',[{key:currentBuys().find(row=>row.sources.some(source=>source.row===buyRoot)).key,priceCents:470,qty:200}])`)
  value = await run(`originalRead('[data-testid=buy-suggestion][data-price="470"]')`)
  check('部分回补100后原推荐减为400股2000元，不使用成交价改写原价', value?.qty === 400 && value.originalAmount === 200000 && value.main.includes('200'), value)
  await shotRow('original-buy-390', '[data-testid=buy-suggestion][data-price="470"]')
  await reset()
  await act(`window.rootA=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});window.rootB=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-22',price:'7.1',qty:'300',rebuyPrice:'5.5'})`)
  await act(`await testApp.savePlans('buy',currentBuys().map(row=>({key:row.key,priceCents:480,qty:row.sources.some(source=>source.row===rootA)?200:100})))`)
  value = await run(`originalRead('[data-testid=buy-suggestion][data-price="480"]')`)
  check('不同原价买单改单撞价合并：当前300股1440元，原推荐800股4150元', value?.main.includes('300') && value.amount.includes('1,440.00') && value.qty === 800 && value.originalAmount === 415000, value)
  await reset()
  await act(`window.sellA=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-20',price:'6',qty:'500',targetPrice:'7'});window.sellB=await testApp.addManualRecord({kind:'buy',stockName:'T',date:'2026-10-21',price:'6.1',qty:'300',targetPrice:'7.5'})`)
  await act(`await testApp.savePlans('sell',currentSells().map(row=>({key:row.key,priceCents:720,qty:row.lotRows.includes(sellA)?200:100})))`)
  value = await run(`originalRead('#original-orders-test .pending-sell[data-merge-group]')`)
  check('不同原价卖单撞价合并：当前300股2160元，原推荐800股5750元', value?.main.includes('300') && value.amount.includes('2,160.00') && value.qty === 800 && value.originalAmount === 575000, value)
  await reset()
  await act(`window.splitRoot=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});await testApp.addBuyTarget(splitRoot,450,200)`)
  await act(`await testApp.savePlans('buy',currentBuys().map(row=>({key:row.key,priceCents:440,qty:100})))`)
  value = await run(`originalRead('[data-testid=buy-suggestion][data-price="440"]')`)
  check('同一母单拆档撞价仅按各档原量相加，不重复计算母单500股', value?.qty === 500 && value.originalAmount === 240000 && value.main.includes('200'), value)
  await reset()
  await act(`window.outRoot=await testApp.addManualRecord({kind:'sell',stockName:'T',date:'2026-10-21',price:'7',qty:'500',rebuyPrice:'5'});testApp.patchOrdersSession({stockName:'T',closes:{T:'6'},confirmedCents:{T:600},overrides:{T:{down:600,up:800}}})`)
  await run(`document.querySelector('[data-testid=must-out]').open=true`)
  value = await run(`originalRead('[data-testid=must-out] [data-testid=buy-suggestion]')`)
  check('区间外买档仍显示原推荐500股2500元', value?.qty === 500 && value.originalAmount === 250000, value)
  await act(`testApp.setSandboxActive(true);testApp.patchOrdersSession({stockName:'T',closes:{T:'6'},confirmedCents:{T:600},overrides:{T:{down:400,up:900}}});testApp.addSandboxItem({kind:'sell',stockName:'T',date:'2026-10-24',priceCents:700,qty:200,targetPriceCents:null,rebuyPriceCents:500});testApp.addSandboxItem({kind:'buy',stockName:'T',date:'2026-10-24',priceCents:600,qty:200,targetPriceCents:700,rebuyPriceCents:null})`)
  const simulation = await run(`[...document.querySelectorAll('#original-orders-test [data-sandbox-row]')].map(row=>({buy:row.classList.contains('pending-buy'),main:row.querySelector('.t1')?.textContent,small:{...row.querySelector('[data-testid=order-original]')?.dataset}}))`)
  check('沙盒模拟买卖也展示各自原推荐，未新增真实成交', simulation.some(row => row.buy && row.small?.originalQty === '200' && row.small.originalAmount === '100000') && simulation.some(row => !row.buy && row.small?.originalQty === '200' && row.small.originalAmount === '140000') && await run('testApp.records.length===1'), simulation)
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });await pause(250)
  check('320px原推荐小字和当前挂单无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  await run(`document.querySelector('[data-testid=must-buy-card]').scrollIntoView({block:'start'})`);await pause(250);await shot('original-sandbox-320')
  // 较长视口让原生吸顶设置与完整模拟行同时可见；宽度仍为320px。
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1200, deviceScaleFactor: 1, mobile: true })
  await run(`(()=>{const row=document.querySelector('#original-orders-test .pending-buy[data-sandbox-row]');row.scrollIntoView({block:'end'})})()`)
  await pause(450)
  await run(`(()=>{const row=document.querySelector('#original-orders-test .pending-buy[data-sandbox-row]'),header=document.querySelector('#original-orders-test [data-sticky]'),top=Math.max(40,header?.getBoundingClientRect().bottom??0)+24;window.scrollBy(0,row.getBoundingClientRect().top-top)})()`)
  await pause(350)
  await shot('original-sandbox-buy-320')
  check('无浏览器运行时错误或React警告', problems.length === 0, problems)
  console.log(`\nORDER ORIGINAL E2E PASS (${passed})`)
} finally {
  socket?.close();browser.kill();await pause(250)
  const resolved = resolve(profile)
  if (resolved.startsWith(resolve(tmpdir()) + sep) && basename(resolved).startsWith('grid-order-original-')) {
    try { rmSync(resolved, { recursive: true, force: true }) } catch { /* browser release pending */ }
  }
}

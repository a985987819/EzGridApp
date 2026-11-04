/** 当前价位累计盈利与奖励买入：真实 App / IndexedDB。node e2e/levelRewards.mjs http://127.0.0.1:5184 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9479
const OUT = join(process.cwd(), 'e2e', 'out', 'level-rewards')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-level-rewards-'))
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
const record = (sourceRow, fields = {}) => ({
  sourceRow, stockName: 'T', buyDateSerial: 46000, buyPriceCents: 500, buyQtyRaw: 500,
  qtyNeedsDerive: false, targetPriceCents: 700, targetNeedsDerive: false, soldQty: 500,
  sellDateSerial: 46010, earlyBuyPriceCents: null, rawProfitCents: null, importKey: `level-e2e:${sourceRow}`, ...fields,
})
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
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 160; i++) { if (await run(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('等待超时: ' + expression + '\n页面状态: ' + JSON.stringify(await run('({hash:location.hash,text:document.body.innerText.slice(0,1600)})')) + '\n运行时异常: ' + JSON.stringify(problems))
  }
  const act = async expression => { const result = await run(`(async()=>{${expression}})()`); await pause(220); return result }
  const click = async selector => {
    assert(await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '缺少元素 ' + selector)
    await pause(250)
    await until(`!document.documentElement.dataset.transition`)
  }
  const input = async (selector, value) => {
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('缺少输入框 '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await pause(150)
  }
  const installProbe = async () => {
    await run(`(async()=>{
      if(window.rewardApp?.ready)return
      const React=(await import('/node_modules/.vite/deps/react.js')).default
      const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const source=await(await fetch('/src/pages/OrdersPage.tsx')).text(),storeUrl=source.match(/from "([^"]*store.useApp[^"]*)"/)[1]
      const {AppProvider,useApp}=await import(storeUrl)
      const mount=document.createElement('div');mount.hidden=true;document.body.appendChild(mount)
      function Probe(){window.rewardApp=useApp();return null}
      createRoot(mount).render(React.createElement(AppProvider,null,React.createElement(Probe)))
      window.rewardNext=async()=>{const {buildNextRoundBuyRows}=await import('/src/domain/buyBoard.ts');const {consumedNextRounds}=await import('/src/domain/suggestions.ts');return buildNextRoundBuyRows({...rewardApp.ledger,merges:rewardApp.merges,consumed:consumedNextRounds(rewardApp.records),groups:rewardApp.ledger.groups})}
      window.rewardSuggestions=async()=>{const {buildBuySuggestions}=await import('/src/domain/suggestions.ts');return buildBuySuggestions(rewardApp.ledger.buySplits,await rewardNext(),rewardApp.plans,rewardApp.ledger.groups)}
    })()`)
    await until('window.rewardApp?.ready')
  }
  const refresh = async hash => {
    await run(`location.hash=${JSON.stringify(hash)}`)
    await pause(200)
    await send('Page.reload')
    await until(`document.querySelector('[data-nav=orders]')&&!document.documentElement.dataset.transition`)
    await installProbe()
  }
  const seed = async (records, chainLinks = [], executions = [], hedges = []) => {
    await installProbe()
    await act(`await rewardApp.resetAll();await rewardApp.addStock({id:'stock:T',name:'T',intervalCents:200,priceLimitType:'main_10',enabled:true,order:-1});const data=JSON.parse(await rewardApp.exportBackup());data.records=${JSON.stringify(records)};data.chainLinks=${JSON.stringify(chainLinks)};data.rebuyExecutions=${JSON.stringify(executions)};data.hedges=${JSON.stringify(hedges)};await rewardApp.restoreBackup(JSON.stringify(data));rewardApp.patchOrdersSession({stockName:'T',closes:{T:'5'},confirmedCents:{T:500},overrides:{T:{down:300,up:1200}}})`)
    await refresh('#/orders')
  }
  const group = () => run(`rewardApp.ledger.groups.find(group=>group.groupKey==='stock:T|500')`)
  const dbFacts = () => run(`(async()=>{const {db}=await import('/src/store/db.ts');return JSON.stringify({records:await db.records.toArray(),executions:await db.rebuyExecutions.toArray(),receipts:await db.bookingReceipts.toArray()})})()`)
  const levelData = () => run(`({...document.querySelector('.app-main [data-testid=level-profit][data-level-price="500"]')?.dataset})`)
  const shot = async (name, selector) => {
    await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
    await pause(450)
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE + '/#/orders' })
  await until(`document.querySelector('[data-nav=orders]')`)
  await seed([record(2)])
  await until(`document.querySelector('[data-testid=buy-suggestion][data-price="500"]')`)
  let value = await run(`(()=>{const e=document.querySelector('[data-testid=buy-suggestion][data-price="500"]');return {reward:e.dataset.rewardQty,text:e.innerText}})()`)
  check('普通5买7卖500股，下一轮基础500加200奖励，推荐700股', value.reward === '200' && value.text.includes('700') && value.text.includes('盈利奖励 200'), value)
  await refresh('#/trades?stock=T&showDone=1')
  await until(`document.querySelector('.app-main [data-testid=level-profit]')`)
  value = await levelData()
  check('明细显示同价累计1000元、可用1000元和可再买200股', value.gross === '100000' && value.used === '0' && value.available === '100000' && value.rewardQty === '200', value)
  await shot('level-profit-390', '[data-testid=level-profit]')
  await click('.app-main .trade-item[data-row="2"]')
  await until(`document.querySelector('[role=dialog] [data-testid=level-profit]')`)
  check('明细抽屉与列表共用同一价位累计和可用奖励余额', await run(`(()=>{const e=document.querySelector('[role=dialog] [data-testid=level-profit]');return e.dataset.gross==='100000'&&e.dataset.available==='100000'&&e.dataset.rewardQty==='200'})()`))
  await click('[aria-label="关闭"]')
  await refresh('#/orders')
  await run(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.rewardCopy=text}}});window.rewardCsv=[];URL.createObjectURL=blob=>{rewardCsv.push(blob);return 'blob:reward-e2e'};HTMLAnchorElement.prototype.click=function(){}`)
  await run(`(()=>{const buttons=[...document.querySelectorAll('.app-main button')];buttons.find(button=>button.textContent.trim()==='复制').click();buttons.find(button=>button.textContent.trim()==='CSV').click()})()`)
  await pause(200)
  const output = await run(`(async()=>({copy:rewardCopy,csv:await rewardCsv.at(-1).text()}))()`)
  check('复制和CSV同时包含奖励后的700股与3500元', output.copy.includes('5.00 × 700') && output.csv.includes('5.00,700,3500.00'), output)
  await click('[data-testid=buy-suggestion][data-price="500"] [data-action=suggestion-buy]')
  check('真实成交弹窗默认包含700股推荐总量', await run(`document.querySelector('[data-field=tradeQty]')?.value==='700'&&document.querySelector('[data-field=tradePrice]')?.value==='5.00'`))
  await input('[data-field=tradeQty]', '600')
  await run(`(()=>{const dialog=document.querySelector('[role=dialog]');[...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='保存成交').click()})()`)
  await until(`!document.querySelector('[data-field=tradeQty]')`)
  await refresh('#/trades?stock=T&showDone=1')
  const saved = await run(`rewardApp.records.find(record=>record.nextRoundOfRow===2&&!record.deletedAt)`)
  check('真实UI部分买入600，保存500基础与100奖励以及永久原价组', saved?.buyQtyRaw === 600 && saved.profitRewardQty === 100 && saved.profitRewardGroupKey === 'stock:T|500', saved)
  let g = await group()
  check('奖励实际花费500元已扣减，库存600股只生成一次', g.usedProfitCents === 50000 && g.grossProfitCents === 100000 && await run(`rewardApp.ledger.lots.find(lot=>lot.id==='lot:${saved.sourceRow}')?.qty===600`), g)
  const remaining = await run(`(async()=>{const rows=await rewardNext();return rows.find(row=>row.rows.includes(2))})()`)
  check('基础已买满后仅保留100股尾奖励，不重复推荐500基础', remaining?.baseQty === 0 && remaining.rewardQty === 100 && remaining.qty === 100, remaining)
  const lastReceipt = await run(`rewardApp.bookingReceipts.find(receipt=>receipt.recordRows.includes(${saved.sourceRow}))`)
  check('刷新后明细统计仍保留已用500元与可再买100股', await run(`rewardApp.ledger.groups.find(g=>g.groupKey==='stock:T|500').usedProfitCents===50000`))
  check('刷新后列表显示实际已用500元与剩余500元，不重复显示200奖励', await run(`(()=>{const e=document.querySelector('.app-main [data-testid=level-profit][data-level-price="500"]');return e.dataset.used==='50000'&&e.dataset.available==='50000'&&e.dataset.rewardQty==='100'})()`))
  const exchange = await act(`const json=await rewardApp.exportBackup(),data=JSON.parse(json);const {exportLedgerWorkbook,parseLedgerWorkbook}=await import('/src/io/ledgerWorkbook.ts');const xlsx=await exportLedgerWorkbook(data),preview=await parseLedgerWorkbook(xlsx);window.rewardBackup=json;window.rewardXlsxSnapshot=preview.snapshot;return {schema:data.schemaVersion,jsonRecord:data.records.find(r=>r.sourceRow===${saved.sourceRow}),excelRecord:preview.snapshot.records.find(r=>r.sourceRow===${saved.sourceRow}),differences:preview.differences.length}`)
  check('JSON结构14及完整Excel往返保留实际奖励股数和永久价组', exchange.schema === 14 && exchange.jsonRecord.profitRewardQty === 100 && exchange.excelRecord.profitRewardQty === 100 && exchange.excelRecord.profitRewardGroupKey === 'stock:T|500' && exchange.differences === 0, exchange)
  await act(`await rewardApp.restoreBackup(JSON.stringify(rewardXlsxSnapshot))`)
  check('完整Excel恢复后奖励余额仍精确500元，不可重复领用', (await group()).usedProfitCents === 50000)
  const tailReceipt = await act(`const row=(await rewardNext()).find(r=>r.rows.includes(2));return await rewardApp.recordBuySuggestion([{kind:'next',id:row.key,row:2,qty:row.qty}],row.qty,500,'2026-10-25')`)
  check('仅剩奖励的100股可独立成交，实际已用金额累计到1000元', (await group()).usedProfitCents === 100000 && await run(`rewardApp.records.filter(record=>record.nextRoundOfRow===2&&!record.deletedAt).reduce((sum,record)=>sum+(record.profitRewardQty??0),0)===200`))
  check('盈利已全部用于奖励后不再产生同来源基础或奖励建议', await run(`(async()=>!(await rewardNext()).some(row=>row.rows.includes(2)))()`))
  await act(`await rewardApp.voidBooking(${JSON.stringify(tailReceipt.id)})`)
  check('撤销尾奖励只归还其500元费用，不影响首笔600股库存', (await group()).usedProfitCents === 50000 && await run(`rewardApp.ledger.lots.find(lot=>lot.id==='lot:${saved.sourceRow}')?.remainingQty===600`))
  await act(`await rewardApp.voidBooking(${JSON.stringify(lastReceipt.id)})`)
  check('整笔撤销奖励买入后归还500元预算并恢复500基础', (await group()).usedProfitCents === 0 && await run(`(async()=>{const row=(await rewardNext()).find(r=>r.rows.includes(2));return row.baseQty===500&&row.rewardQty===200&&row.qty===700})()`))

  await seed([record(2)])
  const beforeInvalid = await dbFacts()
  const invalid = await act(`const sources=(await rewardSuggestions())[0].sources;try{await rewardApp.recordBuySuggestion(sources,550,500,'2026-10-25');return ''}catch(error){return error.message}`)
  check('500基础加50奖励拒绝保存，奖励只允许整手', invalid.includes('100') && await dbFacts() === beforeInvalid, invalid)
  const expensive = await act(`const sources=(await rewardSuggestions())[0].sources;try{await rewardApp.recordBuySuggestion(sources,700,600,'2026-10-25');return ''}catch(error){return error.message}`)
  check('实际成交价提高导致奖励超现金预算，原子拒绝且无半笔记录', expensive.includes('累计盈利不足') && await dbFacts() === beforeInvalid, expensive)
  await act(`const suggestion=(await rewardSuggestions())[0];await rewardApp.savePlans('buy',[{key:suggestion.key,priceCents:600,qty:700}])`)
  await refresh('#/orders')
  const cashLimited = await run(`(()=>{const row=document.querySelector('[data-testid=buy-suggestion][data-price="600"]');return {reward:row?.dataset.rewardQty,text:row?.innerText}})()`)
  check('改单到6元按实际挂价裁成100奖励，推荐基础500加100共600股', cashLimited.reward === '100' && cashLimited.text.includes('600') && cashLimited.text.includes('盈利奖励 100'), cashLimited)

  const chainLink = { id: 'chainlink:2', anchorRow: 2, stockName: 'T', memberRows: [3], closedAt: null, at: 1 }
  await seed([record(2, { buyPriceCents: 1000 }), record(3, { buyDateSerial: 46011, sellDateSerial: 46012, earlyBuyPriceCents: 500 })], [chainLink])
  g = await group()
  check('先卖后回本链未完成，低位盈利1000全部锁定且不奖励', g.grossProfitCents === 0 && await run(`rewardApp.ledger.repairChains.find(c=>c.anchorRow===2)?.netCents===-50000&&rewardApp.ledger.orders.find(o=>o.sourceRow===3)?.rewardQty===0`), g)
  await refresh('#/trades?stock=T&showDone=1')
  value = await levelData()
  check('链未回本时明细可奖励累计为0，显示回本占用而非累计1000', value.gross === '0' && value.rewardQty === '0' && await run(`document.querySelector('.app-main [data-testid=level-profit][data-level-price="500"]').innerText.includes('回本占用')`), value)
  await seed([record(2, { buyPriceCents: 1000 }), record(3, { buyDateSerial: 46011, sellDateSerial: 46012, earlyBuyPriceCents: 500 })], [{ ...chainLink, closedAt: Date.UTC(2026, 10, 4) }])
  check('人工结束但仍亏损的链继续锁定，不能当作已回本', (await group()).grossProfitCents === 0)
  await seed([record(2, { buyPriceCents: 1000 }), record(3, { buyDateSerial: 46011, sellDateSerial: 46012, buyQtyRaw: 1000, soldQty: 1000, earlyBuyPriceCents: 500 })], [chainLink])
  g = await group()
  check('链已回本仅释放净超额500元，奖励100股，不释放低位全部2000', g.grossProfitCents === 50000 && g.chainReleasedCents === 50000 && await run(`rewardApp.ledger.repairChains.find(c=>c.anchorRow===2)?.netCents===50000&&rewardApp.ledger.orders.find(o=>o.sourceRow===3)?.rewardQty===100`), g)
  await seed([record(2, { buyPriceCents: 1000 }), record(3, { buyDateSerial: 46011, sellDateSerial: 46012, buyQtyRaw: 1000, soldQty: 1000, earlyBuyPriceCents: 500 }),
    record(4, { buyDateSerial: 46013, sellDateSerial: 46014, buyQtyRaw: 1000, soldQty: 1000, targetPriceCents: 400 }),
    record(5, { buyDateSerial: 46013, sellDateSerial: null, buyQtyRaw: 100, soldQty: 0, nextRoundOfRow: 3, profitRewardQty: 100, profitRewardGroupKey: 'stock:T|500' })], [{ ...chainLink, memberRows: [3, 4] }])
  g = await group()
  check('后续归属亏损令链重新未完成，锁未来奖励但保留已买100股及历史费用', g.grossProfitCents === 0 && g.usedProfitCents === 50000 && g.capacityHands === 0 && await run(`rewardApp.ledger.lots.find(lot=>lot.id==='lot:5')?.remainingQty===100&&rewardApp.ledger.checks.find(check=>check.name==='Σ已买回奖励金额 ≤ 组累计盈利')?.ok===false`), g)

  await seed([record(2), record(3, { buyPriceCents: null, buyQtyRaw: null, buyDateSerial: null, earlyBuyPriceCents: 500 })], [], [], [{ id: 'hedge:3', sellRow: 3, items: [], at: 1 }])
  const shared = await run(`(async()=>({orders:rewardApp.ledger.orders.map(o=>({row:o.sourceRow,reward:o.rewardQty})),next:await rewardNext()}))()`)
  check('同价P列待买和下一轮共用200股奖励，不同时重复授予', shared.orders.reduce((sum, row) => sum + row.reward, 0) + shared.next.reduce((sum, row) => sum + (row.rewardQty ?? 0), 0) === 200, shared)
  const beforeRebuy = await dbFacts()
  const falseSource = await act(`const order=rewardApp.ledger.orders.find(o=>o.sourceRow===3);try{await rewardApp.recordBuySuggestion([{kind:'order',id:order.id,row:2,qty:700}],700,500,'2026-10-26');return ''}catch(error){return error.message}`)
  check('伪造订单来源行被拒绝，不能借用另一笔来源提取奖励', Boolean(falseSource) && await dbFacts() === beforeRebuy, falseSource)
  const rebuyError = await act(`const order=rewardApp.ledger.orders.find(o=>o.sourceRow===3);try{await rewardApp.recordRebuy(order,700,600,200);return ''}catch(error){return error.message}`)
  check('旧回补路径同样拒绝奖励实际价超预算，原数据不变', rebuyError.includes('累计盈利不足') && await dbFacts() === beforeRebuy, rebuyError)

  await seed([record(2)])
  await refresh('#/trades?stock=T&showDone=1')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: true })
  await pause(300)
  check('320px当前价位累计、已用和可奖励股数无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  await shot('level-profit-320', '[data-testid=level-profit]')
  await refresh('#/orders')
  check('320px700股奖励推荐、原推荐和来源按钮无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
  check('320px推荐行的来源、改单和成交按钮均在屏幕内，不能被裁切隐藏', await run(`(()=>{const buttons=[...document.querySelector('[data-testid=buy-suggestion][data-price="500"]').querySelectorAll('.acts button')];return buttons.length>0&&buttons.every(button=>{const rect=button.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth})})()`))
  await shot('reward-order-320', '[data-testid=buy-suggestion][data-price="500"]')
  check('无浏览器运行时异常或React警告', problems.length === 0, problems)
  console.log(`\nLEVEL REWARDS E2E PASS (${passed})`)
} finally {
  socket?.close(); browser.kill(); await pause(250)
  const resolved = resolve(profile)
  if (resolved.startsWith(resolve(tmpdir()) + sep) && basename(resolved).startsWith('grid-level-rewards-')) {
    try { rmSync(resolved, { recursive: true, force: true }) } catch { /* browser release pending */ }
  }
}

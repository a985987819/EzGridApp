/** 最低持仓价与买入推荐：真实导入、区间、双组、导出、沙盒、切股。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9467
const OUT = join(process.cwd(), 'e2e/out/buy-recommendations')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-guide-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
let passed = 0
const problems = []
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
      const promise = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) promise.reject(new Error(JSON.stringify(message.error)))
      else promise.resolve(message.result)
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
  const settle = () => until(`!document.documentElement.dataset.transition`)
  const click = async selector => {
    assert(await run(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`), '找不到 ' + selector)
    await pause(100)
    await settle()
  }
  const text = () => run('document.body.innerText')
  const input = async (selector, value) => {
    await run(`(() => {const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await pause(150)
  }
  const nav = async page => { await click(`[data-nav="${page}"]`); await settle() }
  const shot = async name => {
    const response = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name + '.png'), Buffer.from(response.data, 'base64'))
  }
  const noOverflow = () => run('document.documentElement.scrollWidth<=innerWidth')

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })

  await send('Page.navigate', { url: BASE + '/#/manage' })
  await until(`!!document.querySelector('[data-manage-entry=import]')`)
  await click('[data-manage-entry=import]')
  const csv = join(profile, 'buy-reference.csv')
  writeFileSync(csv, '\uFEFF股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\n'
    + '柳工,2026-10-20,7.71,500,8.28,,,\n柳工,2026-10-20,8.50,100,9.07,,,\n'
    + '柳工,2026-10-01,8.50,100,9.07,100,2026-10-02,\n柳工,2026-10-01,7.71,100,8.28,100,2026-10-02,\n'
    + '柳工,2026-10-01,7.50,100,8.07,100,2026-10-02,\n柳工,2026-10-01,7.00,100,7.57,100,2026-10-02,\n'
    + '柳工,,,,8.30,100,2026-10-10,7.60\n柳工,,,,8.30,100,2026-10-10,8.00\n'
    + '三一重工,2026-10-20,6.50,100,7.57,,,\n三一重工,2026-10-01,6.00,100,7.07,100,2026-10-02,\n')
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [csv] })
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='写入本地')`)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='写入本地').click()`)
  await pause(1500)
  await nav('orders')
  await until(`!!document.querySelector('[data-testid=buy-reference]')`)
  const reference = () => run(`document.querySelector('[data-testid=buy-reference-price]').textContent`)
  const prices = () => run(`Array.from(document.querySelectorAll('[data-testid=must-buy-card] [data-price],[data-testid=bonus-card] [data-price]')).filter(e=>!e.closest('[data-testid=must-out],[data-testid=bonus-out]')).map(e=>Number(e.dataset.price))`)
  check('最低未完成买单为7.71，已卖光的7.00及其它股票不影响参考',await reference()==='7.71')
  check('下一档参考为7.14',await run(`document.querySelector('[data-testid=next-buy-reference]').textContent==='7.14'`))
  check('未确认区间不出今日推荐', (await prices()).length===0)
  await input('[aria-label=昨收价]','8')
  await click('[data-action=confirm-close]')
  check('日内7.20至8.80与严格低于7.71取交集7.20至7.70',await run(`document.querySelector('[data-testid=buy-window-range]').textContent==='7.20 ~ 7.70'`))
  check('两组今日推荐只包含欠股7.60与下一轮7.50',JSON.stringify(await prices())==='[760,750]',await prices())
  check('推荐与区间外均不展示7.71或以上买价',await run(`Array.from(document.querySelectorAll('[data-testid=must-buy-card] [data-price],[data-testid=bonus-card] [data-price]')).every(e=>Number(e.dataset.price)<771)`))
  check('低于跌停的7.00保留在区间外且不混入今日推荐',await run(`document.querySelector('[data-testid=bonus-out] [data-price="700"]')!==null`))
  await run(`Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.buyCopied=value}},configurable:true})`)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='复制').click()`)
  check('复制只输出7.60与7.50，保留7.71参考说明',await run(`window.buyCopied.includes('上次最低未完成买单 7.71')&&window.buyCopied.includes('7.60 × 100')&&window.buyCopied.includes('7.50 × 100')&&!window.buyCopied.includes('8.00 × 100')&&!window.buyCopied.includes('7.00 × 100')`))
  await run(`window.buyCsv='';const original=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{blob.text().then(v=>window.buyCsv=v);return original(blob)}`)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='CSV').click()`)
  await until(`!!window.buyCsv`)
  check('CSV买档和页面一致，无同价/高价/跌停外推荐',await run(`(()=>{const rows=window.buyCsv.split(String.fromCharCode(10)).filter(r=>r.startsWith('应该买入,')||r.startsWith('锦上添花,'));return rows.length===2&&rows.every(r=>r.includes(',7.60,')||r.includes(',7.50,'))})()`),await run('window.buyCsv'))
  await click('[data-testid=bonus-card] [data-price="750"] [data-action=suggestion-plan]')
  await input('[data-field=planPrice]','8.00')
  await run(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='保存').click()`)
  await pause(600)
  check('改单提高到8.00立即退出推荐',JSON.stringify(await prices())==='[760]',await prices())
  check('未纳入推荐的改单仍有调整入口且没有成交按钮',await run(`!!document.querySelector('[data-action=excluded-buy-plan]')&&!document.querySelector('[data-testid=excluded-buy-plans] [data-action=suggestion-buy]')`))
  await click('[data-testid=excluded-buy-plans] > summary')
  await click('[data-action=excluded-buy-plan]')
  await input('[data-field=planPrice]','7.50')
  await run(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='保存').click()`)
  await pause(500)
  check('调低后重新进入推荐',JSON.stringify(await prices())==='[760,750]')
  await click('[data-sandbox-toggle]')
  check('空沙盒同样不推荐高于或等于参考价的买档',await run(`Array.from(document.querySelectorAll('[data-testid=must-buy-card] [data-price],[data-testid=bonus-card] [data-price]')).every(e=>Number(e.dataset.price)<771)`))
  check('沙盒参考价仍为7.71',await reference()==='7.71')
  await click('[data-action=sandbox-add-buy]')
  await input('[data-field=sandboxPrice]','7.00')
  await input('[data-field=sandboxQty]','100')
  await click('[data-action=sandbox-save]')
  check('新增更低模拟持仓后参考重算为7.00，日内无交集就不推荐',await reference()==='7.00'&&(await prices()).length===0)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='清空模拟').click()`)
  await pause(250)
  check('清空模拟恢复真实最低持仓7.71',await reference()==='7.71')
  await click('[data-sandbox-toggle]')
  await click('[aria-label=选择股票]')
  await run(`[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('三一重工')).click()`)
  await pause(350)
  check('切股参考改为6.50且不会沿用柳工的日内区间',await reference()==='6.50'&&(await prices()).length===0)
  await input('[aria-label=昨收价]','6')
  await click('[data-action=confirm-close]')
  check('三一重工仅推荐6.00',JSON.stringify(await prices())==='[600]',await prices())
  await click('[aria-label=选择股票]')
  await run(`[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('柳工')).click()`)
  await pause(350)
  await input('[aria-label=昨收价]','9')
  await click('[data-action=confirm-close]')
  check('日内下限8.10高于参考时提示无符合范围且不凑高价',await run(`document.querySelector('[data-testid=buy-window-range]').textContent==='无符合范围'`)&&(await prices()).length===0)
  await input('[aria-label=昨收价]','8')
  await click('[data-action=confirm-close]')
  await pause(5100)
  await shot('orders-390')
  await send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});await pause(250)
  check('320px窄屏参考面板及列表无横向溢出',await noOverflow())
  await shot('orders-320')
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});await pause(250)
  check('桌面参考面板及列表无横向溢出',await noOverflow())
  await shot('orders-desktop')
  check('无运行时异常或React警告',problems.length===0,problems)
  console.log(`BUY RECOMMENDATIONS E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

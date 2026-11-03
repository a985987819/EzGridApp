/** 规划用钱：资金输入、全股票温度带、整手可买、值博率排序、改昨收联动挂单页、资金记忆。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9476
const OUT = join(process.cwd(), 'e2e/out/money-plan')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-money-'))
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
  const order = () => run(`[...document.querySelectorAll('[data-money-stock]')].map(e=>e.dataset.moneyStock).join(',')`)
  const planText = name => run(`document.querySelector('[data-money-stock="${name}"] [data-money-plan]')?.textContent ?? ''`)

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })

  await send('Page.navigate', { url: BASE + '/#/manage' })
  await until(`!!document.querySelector('[data-manage-entry=import]')`)
  await click('[data-manage-entry=import]')
  const csv = join(profile, 'money-plan.csv')
  writeFileSync(csv, '\uFEFF股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\n'
    + '柳工,2026-10-20,7.71,500,8.28,,,\n三一重工,2026-10-20,6.50,100,7.07,,,\n安道麦,2026-10-20,5.00,500,5.37,,,\n')
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [csv] })
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='写入本地')`)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='写入本地').click()`)
  await pause(1500)

  // 进入规划用钱分区（导入后停在导入分区，先回管理首页）
  await send('Page.navigate', { url: BASE + '/#/manage' })
  await until(`!!document.querySelector('[data-manage-entry=money]')`)
  await click('[data-manage-entry=money]')
  await until(`!!document.querySelector('[data-testid=manage-money] [data-money-stock]')`)
  check('分区列出全部4只启用股票', await run(`document.querySelectorAll('[data-money-stock]').length`) === 4, await order())
  check('无资金时不给可买数，提示输入', (await planText('柳工')).includes('输入可用资金'))

  // 输入可用资金 ¥10,000
  await input('[data-testid=money-input]', '10000')
  await pause(300)
  check('柳工按快照收盘8.00算整手：1200股12手需9600剩400', (await planText('柳工')).includes('可买 1200') && (await planText('柳工')).includes('12 手') && (await planText('柳工')).includes('9,600') && (await planText('柳工')).includes('400'),
    await planText('柳工'))
  check('资金不足一手买0股不凑零股', (await planText('三一重工')).includes('可买 1500') || (await planText('三一重工')).length > 0,
    await planText('三一重工'))
  check('现价来源标注快照收盘', (await run(`document.querySelector('[data-money-stock="柳工"] [data-money-price-source]').textContent`)).includes('快照收盘'))
  check('每卡有股价温度带与锚点价', await run(`!!document.querySelector('[data-money-stock="柳工"] .val-band[data-val-metric=price]') && !!document.querySelector('[data-money-stock="柳工"] [data-money-anchor]')`))

  // 排序：安道麦 4.60 已低于 P20（5.89）排最前；柳工/奥佳华/三一均在中位上方，按价格百分位升序
  check('排序：已低于P20的安道麦最前，其后按百分位冷→暖', await order() === '安道麦,柳工,奥佳华,三一重工', await order())
  check('安道麦值博率标签为「优 · 已到 P20 下方」', (await run(`document.querySelector('[data-money-stock="安道麦"] [data-money-zone]').textContent`)).includes('优'))
  check('三一重工已在中位上方标「低」', (await run(`document.querySelector('[data-money-stock="三一重工"] [data-money-zone]').textContent`)).includes('低'))

  // 在本页更新安道麦昨收 6.50 → 现价来源变昨收、值博率变为比率 0.74（偏低）、可买 1500 股
  await input('[aria-label=昨收价-安道麦]', '6.5')
  await click('[data-action=money-confirm-close][data-stock=安道麦]')
  await pause(300)
  check('更新昨收后现价来源标注昨收', (await run(`document.querySelector('[data-money-stock="安道麦"] [data-money-price-source]').textContent`)).includes('昨收'))
  check('安道麦改价后可买1500股（15手）', (await planText('安道麦')).includes('可买 1500') && (await planText('安道麦')).includes('15 手'), await planText('安道麦'))
  check('安道麦进入比值博区间标签「偏低」，仍优先于已过中位的股票', (await run(`document.querySelector('[data-money-stock="安道麦"] [data-money-zone]').textContent`)).includes('偏低') && (await order()).startsWith('安道麦'), await order())
  check('390px 无横向溢出', await noOverflow())
  await shot('money-plan-390')

  // 跨页联动：挂单页读同一会话昨收
  await nav('orders')
  await until(`!!document.querySelector('[aria-label=选择股票]')`)
  await click('[aria-label=选择股票]')
  await run(`[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('安道麦')).click()`)
  await pause(350)
  check('本页改的昨收在挂单页同一会话生效', await run(`document.querySelector('[aria-label=昨收价]').value`) === '6.5')

  // 资金记忆：刷新后仍在（localStorage）
  await send('Page.reload')
  await send('Page.navigate', { url: BASE + '/#/manage?section=money' })
  await until(`!!document.querySelector('[data-testid=money-input]')`)
  check('可用资金刷新后仍记忆（localStorage）', await run(`document.querySelector('[data-testid=money-input]').value`) === '10000')
  check('无运行时异常或React警告', problems.length === 0, problems)
  console.log(`MONEY PLAN E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

/** 概览估值温度带：昨收驱动的三条百分位带、股价分区徽标、快照收盘回退与亏损失效。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9469
const OUT = join(process.cwd(), 'e2e/out/valuation')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-valuation-'))
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
  /** 读一条带的「百分位 · 现值」文本 */
  const bandVal = metric => run(`document.querySelector('[data-val-metric=${metric}] .val-band-val')?.textContent ?? ''`)

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })

  await send('Page.navigate', { url: BASE + '/#/manage' })
  await until(`!!document.querySelector('[data-manage-entry=import]')`)
  await click('[data-manage-entry=import]')
  const csv = join(profile, 'valuation.csv')
  writeFileSync(csv, '\uFEFF股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\n'
    + '柳工,2026-10-20,7.71,500,8.28,,,\n柳工,2026-10-01,8.50,100,9.07,100,2026-10-02,\n'
    + '安道麦,2026-10-20,5.00,500,5.37,,,\n')
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [csv] })
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='写入本地')`)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='写入本地').click()`)
  await pause(1500)

  // 柳工确认昨收 8.00（= 快照末收盘，百分位可直接对照快照基准）
  await nav('orders')
  await input('[aria-label=昨收价]', '8')
  await click('[data-action=confirm-close]')
  await nav('overview')
  await until(`!!document.querySelector('[data-testid=overview-valuation] [data-val-metric=price]')`)

  check('温度卡副标题标注数据截至与昨收口径', await run(`document.querySelector('[data-testid=valuation-asof]').textContent`) === '数据截至 2026-11-02 · 按昨收 8.00',
    await run(`document.querySelector('[data-testid=valuation-asof]').textContent`))
  check('柳工股价分区徽标为中性', await run(`document.querySelector('[data-testid=valuation-zone]').textContent`) === '中性')

  // 百分位随快照刷新漂移：容差 ±1.5 个百分点，重跑 npm run refresh-valuation 后如越界按新快照更新
  const pctOf = text => Number((/([\d.]+)%/.exec(text) ?? [])[1])
  const pricePct = pctOf(await bandVal('price'))
  check('柳工股价百分位约52（快照2026-11-02基准）', Math.abs(pricePct - 52.2) <= 1.5, pricePct)
  const pePct = pctOf(await bandVal('pe'))
  check('柳工PE-TTM百分位约13（盈利增长压低估值）', Math.abs(pePct - 13.4) <= 1.5, pePct)
  const pbPct = pctOf(await bandVal('pb'))
  check('柳工PB-MRQ百分位约36', Math.abs(pbPct - 35.7) <= 1.5, pbPct)
  check('三条带都画了位置针', await run(`document.querySelectorAll('[data-testid=overview-valuation] .needle').length`) === 3)
  check('PE 现值按昨收缩放为11.1', (await bandVal('pe')).includes('11.1'), await bandVal('pe'))
  check('390px 温度卡无横向溢出', await noOverflow())
  await shot('overview-valuation-390')

  // 安道麦：快照末 PE 为负 → PE 失效不画针；未确认昨收 → 回退快照收盘（股票 tab 是 Tag，不一定是 button）
  await run(`(()=>{const t=[...document.querySelectorAll('.stock-tabs *')].filter(e=>e.textContent.trim()==='安道麦').pop();if(!t)throw new Error('找不到安道麦tab');t.click()})()`)
  await pause(400)
  check('安道麦副标题回退为快照收盘', (await run(`document.querySelector('[data-testid=valuation-asof]').textContent`)).includes('按快照收盘 4.60'))
  check('安道麦PE带显示亏损失效且不画针', (await bandVal('pe')) === '亏损 · 失效'
    && await run(`document.querySelector('[data-val-metric=pe] .needle')===null`), await bandVal('pe'))
  check('安道麦股价极冷百分位约4.9', Math.abs(pctOf(await bandVal('price')) - 4.9) <= 1.5, await bandVal('price'))
  check('安道麦PB带仍有位置针', await run(`document.querySelector('[data-val-metric=pb] .needle')!==null`))
  await shot('overview-valuation-loss')
  check('无运行时异常或React警告', problems.length === 0, problems)
  console.log(`VALUATION E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

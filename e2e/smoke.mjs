/**
 * 项目自带 E2E 冒烟：用本机 Chrome/Edge（CDP）走一遍「导入 → 校验 → 挂单 → 明细编辑 → 删除恢复」主链路。
 * 移动端视口 390×844。
 *
 *   node e2e/smoke.mjs http://127.0.0.1:5183
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9444
const BASE = (process.argv[2] ?? 'http://127.0.0.1:5183').replace(/\/+$/, '')
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })

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
  const clickByText = (sel, text) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().includes(${JSON.stringify(text)}))
      if (!el) return false
      el.click(); return true
    })()`)

  const nav = async (key) => {
    const done = await evaluate(`(() => {
      const b = document.querySelector('button[data-nav="${key}"]')
      if (!b) return false
      b.click(); return true
    })()`)
    await settle(2500)
    return done
  }

  const closeDrawer = async () => {
    await evaluate(`document.querySelector('[aria-label="关闭"]')?.click()`)
    await sleep(500)
  }

  console.log(`\n[1] 首屏（移动端 390×844）${BASE}`)
  let text = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await send('Page.navigate', { url: `${BASE}/` })
    await settle()
    text = await bodyText()
    if (text.includes('网格交易')) break
    await sleep(1200)
  }
  check('渲染出头部', text.includes('网格交易'))
  check('底部导航 5 项', (await evaluate(`document.querySelectorAll('button[data-nav]').length`)) === 5)
  check('空态引导', text.includes('还没有导入数据') || text.includes('去导入'))
  check(
    '没有横向溢出',
    (await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`)) === true,
    `scrollWidth=${await evaluate('document.documentElement.scrollWidth')}`,
  )

  console.log('\n[2] 管理 · 导入 → 载入内置示例')
  check('切到管理页', await nav('manage'))
  check('导入 tab 默认展开', (await bodyText()).includes('载入内置示例'))
  check('点到「载入内置示例」', await clickByText('button', '载入内置示例'))
  await sleep(2500)
  await settle()
  text = await bodyText()
  check('dry-run 出现股票名', text.includes('柳工'))
  check('基准 16 项全中', text.includes('16 项全中'))
  check('dry-run 命中 15,200', text.includes('15,200'))

  console.log('\n[3] 写入本地 → 概览')
  check('点到「写入本地」', await clickByText('button', '写入本地'))
  await sleep(1500)
  await settle()
  check('回到概览', await nav('overview'))
  text = await bodyText()
  check('三格：可卖 15,200', text.includes('15,200'))
  check('三格：待补 2,000', text.includes('2,000'))
  check('三格：净持仓 13,200', text.includes('13,200'))
  check('头部基准全中', text.includes('基准全中'))

  console.log('\n[4] 概览按股票 tab + 价格网格列序')
  check('切到三一重工', await clickByText('.stock-tabs > *', '三一重工'))
  await sleep(500)
  text = await bodyText()
  check('三一可卖 3,800', text.includes('3,800'))
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(400)
  const gridDump = await evaluate(`JSON.stringify(
    [...document.querySelectorAll('table.pricegrid')[0].querySelectorAll('tbody tr')]
      .slice(0, 6).map(tr => [...tr.children].map(td => td.textContent.trim()))
  )`)
  console.log('  网格前 6 行:', gridDump)
  const cells = JSON.parse(gridDump)
  check('网格 4 列且第 2 列是价格', cells.every((c) => c.length === 4 && /^\d+\.\d{2}$/.test(c[1])))
  check('第 3 列是待卖股数', cells.some((c) => /股$/.test(c[2])))
  check('第 4 列是已卖出笔数', cells.some((c) => /笔/.test(c[3])))

  console.log('\n[5] 明细：卡片 → 抽屉 → 编辑 → 保存')
  check('切到明细', await nav('trades'))
  check(
    '点到第 63 行卡片',
    await evaluate(`(() => {
      const el = document.querySelector('[data-row="63"]')
      if (!el) return false
      el.click(); return true
    })()`),
  )
  await sleep(700)
  check('抽屉打开且有「变更历史」', (await bodyText()).includes('变更历史'))
  check('点编辑', await clickByText('button', '编辑'))
  await sleep(400)
  await evaluate(`(() => {
    const input = document.querySelector('input[data-field="targetPrice"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '9.00')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  check('点保存', await clickByText('button', '保存'))
  await sleep(1000)
  check('抽屉里能看到改成 9.00', (await bodyText()).includes('9.00'))
  await closeDrawer()
  await nav('overview')
  text = await bodyText()
  check('编辑后盈利重算为 ¥9,990', text.includes('9,990'))

  console.log('\n[6] 删除 → 恢复')
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(600)
  await evaluate(`window.confirm = () => true`)
  check('点删除', await clickByText('button', '删除'))
  await sleep(900)
  await nav('overview')
  text = await bodyText()
  check('删除后净持仓 13,700', text.includes('13,700'))
  check('删除后敞口 1,500', text.includes('1,500'))

  await nav('trades')
  check(
    '打开「显示已删除」',
    await evaluate(`(() => {
      const sw = document.querySelector('[aria-label="显示已删除"]')
      if (!sw) return false
      sw.click(); return true
    })()`),
  )
  await sleep(700)
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(600)
  check('点恢复', await clickByText('button', '恢复'))
  await sleep(800)
  await closeDrawer()

  // 把第 63 行改回 8.68，让最终截图回到「基准全中」
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(600)
  await clickByText('button', '编辑')
  await sleep(400)
  await evaluate(`(() => {
    const input = document.querySelector('input[data-field="targetPrice"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '8.68')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  await clickByText('button', '保存')
  await sleep(900)
  await closeDrawer()
  await nav('overview')
  text = await bodyText()
  check('改回 8.68 后盈利回到 ¥9,830', text.includes('9,830') && !text.includes('9,990'))
  check('改回后基准全中', text.includes('基准全中'))

  console.log('\n[7] 挂单页（区间 + 待买/待卖）')
  check('切到挂单', await nav('orders'))
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="昨收价"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '8.10')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(700)
  text = await bodyText()
  check('昨收 8.10 → 区间 7.29~8.91', text.includes('7.29') && text.includes('8.91'))
  check('待买标注空头敞口', text.includes('空头敞口'))
  check('有「待卖」tab', text.includes('待卖'))

  console.log('\n[8] 其余页面渲染')
  for (const [key, expect] of [
    ['stats', '月度成交'],
    ['manage', '导入批次'],
  ]) {
    await nav(key)
    const t = await bodyText()
    check(`${key} 渲染`, t.includes(expect), `text=${t.length}`)
  }

  console.log('\n[9] 截图')
  for (const [key, file] of [
    ['overview', 'mobile-overview.png'],
    ['trades', 'mobile-trades.png'],
    ['orders', 'mobile-orders.png'],
    ['manage', 'mobile-manage.png'],
  ]) {
    await nav(key)
    await sleep(500)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'))
  }
  // 抽屉截图（明细详情 + 编辑入口）
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(700)
  const drawerShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-drawer.png'), Buffer.from(drawerShot.data, 'base64'))
  await clickByText('button', '编辑')
  await sleep(500)
  const editShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-drawer-edit.png'), Buffer.from(editShot.data, 'base64'))
  await closeDrawer()

  await nav('overview')
  await sleep(500)
  const full = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(OUT, 'mobile-overview-full.png'), Buffer.from(full.data, 'base64'))
  console.log(`  截图已存 ${OUT}`)

  console.log('\n[10] 运行时错误')
  check('无未捕获异常 / console.error', problems.length === 0, problems.slice(0, 5).join(' | '))

  socket.close()
} finally {
  browser.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(ok ? '\nE2E PASS' : '\nE2E FAIL')
process.exit(ok ? 0 : 1)

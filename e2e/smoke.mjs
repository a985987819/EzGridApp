/**
 * 项目自带 E2E 冒烟：用本机 Chrome/Edge（CDP）走一遍「导入 → 校验 → 挂单 → 概览」主链路。
 * 用法： node e2e/smoke.mjs http://127.0.0.1:5183
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
    '--window-size=1500,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const problems = []
let ok = true

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
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

  const clickNav = async (label) => {
    const done = await evaluate(`(() => {
      const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)}))
      if (!b) return false
      b.click(); return true
    })()`)
    await settle(3000)
    return done
  }

  const bodyText = () => evaluate(`document.body.innerText`)

  console.log(`\n[1] 首屏 ${BASE}`)
  await send('Page.navigate', { url: `${BASE}/` })
  await settle()
  let text = await bodyText()
  check('渲染出侧栏', text.includes('网格交易管理'))
  check('空态提示', text.includes('还没有导入数据') || text.includes('概览'))

  console.log('\n[2] 导入页 → 载入内置示例')
  check('切到导入页', await clickNav('导入'))
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('载入内置示例'))
    if (!b) return false
    b.click(); return true
  })()`)
  check('点到「载入内置示例」', clicked)
  await sleep(2500)
  await settle()
  text = await bodyText()
  check('dry-run 出现首股对象', text.includes('柳工'))
  const pass = await evaluate(`document.body.innerText.split('✓').length - 1`)
  const fail = await evaluate(`document.body.innerText.split('✗').length - 1`)
  check('基准校验 16 项全过', pass >= 16 && fail === 0, `(✓${pass} ✗${fail})`)
  check('dry-run 命中 15,200', text.includes('15,200'))
  check('dry-run 命中 13,200', text.includes('13,200'))

  console.log('\n[3] 写入本地 → 概览')
  const committed = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '写入本地')
    if (!b) return false
    b.click(); return true
  })()`)
  check('点到「写入本地」', committed)
  await sleep(1500)
  await settle()
  check('回到概览', await clickNav('概览'))
  text = await bodyText()
  check('三格：可卖 15,200', text.includes('15,200'))
  check('三格：待补 2,000', text.includes('2,000'))
  check('三格：净持仓 13,200', text.includes('13,200'))
  check('基准全中徽章', text.includes('基准全中') || text.includes('基准 16/16'))
  check('逐股票总账有 9,830', text.includes('9,830'))

  console.log('\n[4] 其余页面渲染')
  for (const [label, expect] of [
    ['明细', '明细'],
    ['挂单', '挂单'],
    ['股票', '默认间隔'],
    ['统计', '月度成交'],
    ['备份', '导出全量 JSON'],
  ]) {
    await clickNav(label)
    const t = await bodyText()
    check(`${label} 页渲染`, t.includes(expect), `text length=${t.length}`)
  }

  console.log('\n[5] 挂单页数值与区间')
  await clickNav('挂单')
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => i.placeholder === '如 8.10')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '8.10')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(600)
  text = await bodyText()
  check('昨收 8.10 → 区间 7.29~8.91', text.includes('7.29') && text.includes('8.91'))
  check('待买清单有序号 63', text.includes('63'))

  console.log('\n[6] 截图')
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(OUT, 'overview-orders.png'), Buffer.from(shot.data, 'base64'))
  await clickNav('概览')
  const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(OUT, 'overview.png'), Buffer.from(shot2.data, 'base64'))
  console.log(`  截图已存 ${OUT}`)

  console.log('\n[7] 运行时错误')
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

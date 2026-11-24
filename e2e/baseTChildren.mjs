/**
 * 底仓做T子单 UI 回归（m00139 / m00001）：
 * 拆分按填入数量生成子单（预填价量+仅选日期）→ 子单只在父详情可见、默认已完成
 * → 日历按回补次数与合并盈利显示 → 全部回补父行加 ✅（V9.79 起整行不提供编辑/删除，
 *   但每笔子单可点「修改」改价量日期，日期允许晚于卖出日）。
 *
 *   node e2e/baseTChildren.mjs http://127.0.0.1:5173
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9471
const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
mkdirSync(join(process.cwd(), 'e2e', 'out'), { recursive: true })

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
const profile = mkdtempSync(join(tmpdir(), 'baset-e2e-'))
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
    } catch { /* keep waiting */ }
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
      problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = m.params.args.map((a) => a.description ?? a.value ?? a.type).join(' ')
      if (!IGNORED.test(text)) problems.push(`console.error: ${text}`)
    }
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

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
      const len = await evaluate(`(document.getElementById('test-root')?.innerHTML ?? '').length`)
      stable = len > 0 && len === prev ? stable + 1 : 0
      prev = len
    }
  }
  const click = async (selector) => {
    const v = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`)
    await sleep(250)
    return v
  }
  const setInput = async (selector, value) => {
    const v = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await sleep(80)
    return v
  }

  await send('Page.navigate', { url: BASE })
  await settle()
  // 挂载真实 TradesPage（复用 gridStrategies 的探针方式，store 是真 IndexedDB）
  await evaluate(`(async () => {
    const main = await (await fetch('/src/main.tsx')).text()
    const React = (await import(main.match(new RegExp('from "([^"]*deps.react[.]js[^"]*)"'))[1])).default
    const { createRoot } = (await import(main.match(new RegExp('from "([^"]*deps.react-dom_client[.]js[^"]*)"'))[1])).default
    const source = await (await fetch('/src/pages/TradesPage.tsx')).text()
    const storeUrl = source.match(new RegExp('from "([^"]*store.useApp[^"]*)"'))[1]
    const { AppProvider, useApp } = await import(storeUrl)
    const { TradesPage } = await import('/src/pages/TradesPage.tsx')
    const { StatsPage } = await import('/src/pages/StatsPage.tsx')
    document.getElementById('root').style.display = 'none'
    const el = document.createElement('div'); el.id = 'test-root'; document.body.appendChild(el)
    function Probe() {
      const a = useApp(); window.testApp = a
      const [page, setPage] = React.useState('trades')
      window.showStats = () => setPage('stats')
      window.showTrades = () => setPage('trades')
      return a.ready ? (page === 'stats' ? React.createElement(StatsPage, { goTrades: () => setPage('trades') }) : React.createElement(TradesPage, { urlQuery: {} })) : null
    }
    createRoot(el).render(React.createElement(AppProvider, null, React.createElement(Probe)))
  })()`)
  await settle()

  // 干净的账本：一只股票 T，间隔 0.57；先卖 1000 @10
  await evaluate(`(async () => {
    await testApp.resetAll()
    await testApp.addStock({ id: 'stock:T', name: 'T', intervalCents: 57, priceLimitType: 'main_10', order: -1, enabled: true })
    window.baseRow = await testApp.addManualRecord({ kind: 'sell', stockName: 'T', date: '2026-10-20', price: '10', qty: '1000', rebuyPrice: '9' })
    await testApp.setSellGridMode(baseRow, 'baseT')
  })()`)
  await sleep(400)

  // 打开父记录详情抽屉
  check('打开底仓做T父记录详情', await click(`.trade-item[data-row="${await evaluate('baseRow')}"]`))
  check('父详情出现做T回补子单面板', await evaluate(`!!document.querySelector('[data-testid="base-t-children-section"]')`))

  // 拆分：股数填实际值 400（不是固定200），价格留空 → 弹窗价格置空由用户填
  await setInput('input[data-field="base-t-child-qty-input"]', '400')
  check('点拆分打开子单弹窗', await click('[data-action="base-t-split"]'))
  check('弹窗带入填入的股数、价格留空、日期默认今天', await evaluate(`(() => {
    const q = document.querySelector('input[data-field="base-t-child-qty"]')?.value
    const p = document.querySelector('input[data-field="base-t-child-price"]')?.value
    const d = document.querySelector('input[data-field="base-t-child-date"]')?.value
    return q === '400' && p === '' && !!d
  })()`))
  await setInput('input[data-field="base-t-child-price"]', '9')
  await setInput('input[data-field="base-t-child-date"]', '2026-10-22')
  await click('[data-action="base-t-child-save"]')
  await sleep(350)

  let v = await evaluate(`(() => {
    const { baseTRowSummary } = window.__btSummary || {}
    return {
      execs: testApp.executions.filter(e => e.sellExecId === 'sell:' + baseRow).map(e => ({ qty: e.qty, priceCents: e.priceCents, at: e.at })),
      summary: testApp.ledger.sells.find(s => s.sourceRow === baseRow),
      childInList: !!document.querySelector('.trade-item .base-t-done'),
    }
  })()`)
  check('确认后生成一笔400股@9元真实回补（非固定200）', v.execs.length === 1 && v.execs[0].qty === 400 && v.execs[0].priceCents === 900, JSON.stringify(v.execs))
  check('子单日期取所选日期', await evaluate(`new Date(testApp.executions.find(e => e.sellExecId === 'sell:' + baseRow).at).toISOString().slice(0,10) === '2026-10-22'`))
  check('子单不进明细列表（列表无✅标记行）', !(await evaluate(`[...document.querySelectorAll('.trade-item')].some(el => el.textContent.includes('已完成') && !el.querySelector('[data-testid="base-t-done"]'))`)))

  // 父详情子单列表
  const childList = await evaluate(`[...document.querySelectorAll('[data-base-t-child]')].map(el => el.textContent)`)
  check('父详情显示子单（数量/价格/日期/已完成）', childList.length === 1 && childList[0].includes('400') && childList[0].includes('9.00') && childList[0].includes('2026-10-22') && childList[0].includes('已完成'), JSON.stringify(childList))

  // 日历：按回补笔数显示，逐笔价差
  const goOct = async () => {
    for (let i = 0; i < 14; i += 1) {
      if (await evaluate(`!!document.querySelector('[data-testid="stats-calendar"] [data-date="2026-10-20"]')`)) return true
      await click('[aria-label="上个月"]')
    }
    return false
  }
  await evaluate(`showStats()`)
  await sleep(600)
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  await sleep(200)
  const octOk = await goOct()
  check('日历翻到2026年10月', octOk)
  await click('[data-testid="stats-calendar"] [data-date="2026-10-20"]')
  const dayCell = await evaluate(`document.querySelector('[data-testid="stats-calendar"] [data-testid="cal-base-t"]')?.textContent ?? ''`)
  check('日历卖出日显示回补1次（做T盈利并入当日）', dayCell.includes('回补1次'), dayCell)

  // 第二笔：400@9 + 第三笔：200@8 → 卖出日 3 笔；再全回补加 ✅
  await evaluate(`showTrades()`)
  await sleep(400)
  // 全部回补父行带 ✅，默认（隐藏已完成开启时）也应可见
  await click(`.trade-item[data-row="${await evaluate('baseRow')}"]`)
  await setInput('input[data-field="base-t-child-qty-input"]', '400')
  await click('[data-action="base-t-split"]')
  await setInput('input[data-field="base-t-child-price"]', '9')
  await setInput('input[data-field="base-t-child-date"]', '2026-10-23')
  await click('[data-action="base-t-child-save"]')
  await sleep(300)
  await setInput('input[data-field="base-t-child-qty-input"]', '200')
  await click('[data-action="base-t-split"]')
  await setInput('input[data-field="base-t-child-price"]', '8')
  await setInput('input[data-field="base-t-child-date"]', '2026-10-24')
  await click('[data-action="base-t-child-save"]')
  await sleep(400)

  check('三笔回补全部入账，数量合计1000', await evaluate(`testApp.executions.filter(e => e.sellExecId === 'sell:' + baseRow).reduce((a, e) => a + e.qty, 0) === 1000`))
  check('父行右侧出现✅', await evaluate(`!!document.querySelector('.trade-item[data-row="' + baseRow + '"] [data-testid="base-t-done"]')`))
  check('父详情提示已全部回补、无整行编辑入口，子单各有「修改」', await evaluate(`(() => {
    const hint = document.querySelector('.trades-edit-drawer [data-testid="base-t-done-hint"]')
    const recordEdit = [...document.querySelectorAll('.trades-edit-drawer > .acts button, .trades-edit-drawer .footer button')].find(b => b.textContent.trim() === '编辑')
    const childEdits = document.querySelectorAll('[data-action="base-t-child-edit"]')
    return !!hint && !recordEdit && childEdits.length === 3
  })()`))
  // V9.79：子单可以改（尤其日期），改完父行仍是 ✅，统计日历按新日期重算
  await click('[data-action="base-t-child-edit"]')
  check('点「修改」打开子单弹窗并预填现值', await evaluate(`(() => {
    const q = document.querySelector('input[data-field="base-t-child-qty"]')?.value
    const p = document.querySelector('input[data-field="base-t-child-price"]')?.value
    const d = document.querySelector('input[data-field="base-t-child-date"]')?.value
    return q === '400' && p === '9.00' && d === '2026-10-22'
  })()`))
  await setInput('input[data-field="base-t-child-date"]', '2026-10-25')
  await click('[data-action="base-t-child-save"]')
  await sleep(400)
  check('改子单日期生效（买入日期可晚于卖出日）', await evaluate(`(() => {
    // 两笔 400@9 都在（一笔 10-23 新建、一笔由 10-22 改成 10-25），只要有一笔落在 10-25 即生效
    return testApp.executions.some(x => x.sellExecId === 'sell:' + baseRow && x.qty === 400 && x.priceCents === 900
      && new Date(x.at).toISOString().slice(0,10) === '2026-10-25')
  })()`))
  check('父详情子单列表显示3笔且全部已完成', await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-base-t-child]')]
    return rows.length === 3 && rows.every(r => r.textContent.includes('已完成'))
  })()`))

  await evaluate(`showStats()`)
  await sleep(600)
  await goOct()
  await click('[data-testid="stats-calendar"] [data-date="2026-10-20"]')
  const dayText = await evaluate(`document.querySelector('[data-testid="stats-calendar"] [data-testid="cal-base-t"]')?.textContent ?? ''`)
  check('日历卖出日显示回补3次', dayText.includes('回补3次'), dayText)

  check('无运行时错误', problems.length === 0, problems.join(' | '))
  socket.close()
} finally {
  browser.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
console.log(ok ? '\nBASET E2E PASS' : '\nBASET E2E FAIL')
process.exit(ok ? 0 : 1)

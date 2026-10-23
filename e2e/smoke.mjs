/**
 * 项目自带 E2E 冒烟（移动端 390×844 视口）：
 * 股票排序 → 导入 → 基准校验 → 分股 tab → 明细编辑/删除/恢复 → 挂单区间 → 启用开关 → 手动卖出
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
  const setInput = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  const stockOrder = () =>
    evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-stock-row]')].map(e => e.getAttribute('data-stock-row').replace('stock:','')))`,
    )

  console.log(`\n[1] 首屏（390×844）${BASE}`)
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
  check('没有横向溢出', (await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`)) === true)

  console.log('\n[2] 管理 · 股票（第一个 tab）+ 拖动排序')
  check('切到管理页', await nav('manage'))
  text = await bodyText()
  check('股票 tab 默认展示', text.includes('默认间隔') && text.includes('涨跌幅规则'))
  const order0 = JSON.parse(await stockOrder())
  console.log('  初始顺序:', order0)
  check('初始顺序 柳工→三一重工→奥佳华→安道麦', order0.join('>') === '柳工>三一重工>奥佳华>安道麦')

  const from = JSON.parse(
    await evaluate(`(() => {
      const h = document.querySelector('[data-stock-row="stock:三一重工"] .drag-handle')
      const r = h.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`),
  )
  const to = JSON.parse(
    await evaluate(`(() => {
      const h = document.querySelector('[data-stock-row="stock:柳工"]')
      const r = h.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 12) })
    })()`),
  )
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', clickCount: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  await sleep(120)
  for (let i = 1; i <= 6; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * i) / 6),
      y: Math.round(from.y + ((to.y - from.y) * i) / 6),
      button: 'left',
      buttons: 1,
    })
    await sleep(80)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const orderAfter = JSON.parse(await stockOrder())
  console.log('  拖动后顺序:', orderAfter)
  check('拖动后三一重工排第一', orderAfter[0] === '三一重工')

  console.log('\n[3] 管理 · 导入 → 载入示例 → 写入本地')
  check('切到导入 tab', await clickByText('[role="tab"]', '导入'))
  await sleep(400)
  check('点到「载入内置示例」', await clickByText('button', '载入内置示例'))
  await sleep(2500)
  await settle()
  text = await bodyText()
  check('dry-run 出现股票名', text.includes('柳工'))
  check('基准 16 项全中', text.includes('16 项全中'))
  check('dry-run 命中 15,200', text.includes('15,200'))
  check('点到「写入本地」', await clickByText('button', '写入本地'))
  await sleep(1600)
  await settle()

  console.log('\n[4] 概览：三格 + 顺序跟随')
  check('回到概览', await nav('overview'))
  text = await bodyText()
  check('可卖 15,200', text.includes('15,200'))
  check('待补 2,000', text.includes('2,000'))
  check('净持仓 13,200', text.includes('13,200'))
  check('基准全中', text.includes('基准全中'))
  const pills = await evaluate(`JSON.stringify([...document.querySelectorAll('.stock-tabs > *')].map(e => e.textContent.trim()))`)
  console.log('  概览药丸:', pills)
  check('药丸顺序跟随股票排序（三一重工在前）', JSON.parse(pills)[0] === '三一重工')

  const stickyOf = (key) =>
    evaluate(`(() => {
      const el = document.querySelector('[data-sticky="${key}"]')
      if (!el) return 'missing'
      return getComputedStyle(el).position
    })()`)
  check('概览顶部吸顶', (await stickyOf('overview')) === 'sticky')
  // 滚动后吸顶块应停在顶栏下方
  await evaluate(`window.scrollTo(0, 600)`)
  await sleep(400)
  const stickyTop = await evaluate(`(() => {
    const el = document.querySelector('[data-sticky="overview"]')
    const header = document.querySelector('.app-header')
    if (!el || !header) return null
    return JSON.stringify({ el: Math.round(el.getBoundingClientRect().top), header: Math.round(header.getBoundingClientRect().bottom) })
  })()`)
  console.log('  吸顶位置:', stickyTop)
  const st = JSON.parse(stickyTop)
  check('滚动后吸顶块贴在顶栏下沿', Math.abs(st.el - st.header) <= 8, stickyTop)
  await evaluate(`window.scrollTo(0, 0)`)
  await sleep(300)

  console.log('\n[4.5] 三格点开看构成')
  check(
    '点「净持仓」',
    await evaluate(`(() => {
      const el = document.querySelector('[data-metric="net"]')
      if (!el) return false
      el.click(); return true
    })()`),
  )
  await sleep(500)
  text = await bodyText()
  check('出现「净持仓构成」', text.includes('净持仓构成'))
  check('构成里有 Σ 买入 / Σ 卖出 / Σ 回补', text.includes('Σ 买入份额') && text.includes('Σ 卖出量') && text.includes('Σ 回补成交'))
  check('参数一致（合计 13,200）', text.includes('= 13,200'))
  check('点「收起」', await clickByText('button', '收起'))
  await sleep(400)
  check('收起后面板消失', !(await bodyText()).includes('净持仓构成'))

  console.log('\n[5] 价格网格列序')
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(400)
  const gridDump = await evaluate(`JSON.stringify(
    [...document.querySelectorAll('table.pricegrid')[0].querySelectorAll('tbody tr')]
      .slice(0, 5).map(tr => [...tr.children].map(td => td.textContent.trim()))
  )`)
  const cells = JSON.parse(gridDump)
  console.log('  网格前 5 行:', gridDump)
  check('4 列且第 2 列价格', cells.every((c) => c.length === 4 && /^\d+\.\d{2}$/.test(c[1])))
  check('第 3 列待卖 / 第 4 列已卖出', cells.some((c) => /股$/.test(c[2])) && cells.some((c) => /笔/.test(c[3])))

  // 表头必须自己带底色 + 分隔线，否则和数据行糊在一起
  const headStyle = await evaluate(`(() => {
    const th = document.querySelector('table.pricegrid thead th')
    const td = document.querySelector('table.pricegrid tbody td')
    if (!th || !td) return null
    const hs = getComputedStyle(th)
    const ts = getComputedStyle(td)
    return JSON.stringify({
      headBg: hs.backgroundColor,
      bodyBg: ts.backgroundColor,
      headBorder: hs.borderBottomWidth + ' ' + hs.borderBottomStyle,
      wrapBorder: getComputedStyle(document.querySelector('.table-wrap')).borderTopWidth,
      inWrap: Boolean(th.closest('.table-wrap')),
    })
  })()`)
  console.log('  表头样式:', headStyle)
  const hs = JSON.parse(headStyle)
  check('表头在带边框的容器里', hs.inWrap === true && hs.wrapBorder !== '0px')
  check('表头有底色（与数据行不同）', hs.headBg !== hs.bodyBg && hs.headBg !== 'rgba(0, 0, 0, 0)')
  check('表头有下边线', hs.headBorder.startsWith('1px solid'))

  console.log('\n[6] 明细：股票 tab + 抽屉编辑')
  check('切到明细', await nav('trades'))
  // S3：日期区间筛选 + 排序
  const headCount = async () =>
    Number((await evaluate(`document.querySelector('.page-title p')?.textContent ?? ''`)).split('/')[0]) || 0
  const allCount = await headCount()
  await setInput('input[aria-label="起始日期"]', '2026-08-01')
  await sleep(400)
  const fromCount = await headCount()
  check('起始日期筛选生效（8 月后行数变少）', fromCount > 0 && fromCount < allCount, `${fromCount}/${allCount}`)
  await setInput('input[aria-label="结束日期"]', '2026-08-31')
  await sleep(400)
  const rangeCount = await headCount()
  check('结束日期进一步收窄', rangeCount <= fromCount, `${rangeCount}/${fromCount}`)
  check('清除日期筛选', await clickByText('button', '清除'))
  await sleep(400)
  check('清除后恢复全部', (await headCount()) === allCount, `${await headCount()}/${allCount}`)

  const sortPick = async (label) => {
    await evaluate(`document.querySelector('.app-main [role="combobox"][aria-label="排序"]')?.click()`)
    await sleep(300)
    const ok = await clickByText('[role="option"]', label)
    await sleep(400)
    return ok
  }
  const firstRows = async () =>
    JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-row]')].slice(0,3).map(e => Number(e.getAttribute('data-row'))))`))
  check('排序切到「行号 低→高」', await sortPick('行号 低→高'))
  const asc = await firstRows()
  check('升序生效', asc[0] < asc[1] && asc[1] < asc[2], JSON.stringify(asc))
  check('排序切回「行号 高→低」', await sortPick('行号 高→低'))
  const desc = await firstRows()
  check('降序恢复', desc[0] > desc[1] && desc[1] > desc[2], JSON.stringify(desc))

  // 买入日期排序（新→旧）
  const firstBuyDates = async () =>
    JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.trade-item .dates')].slice(0,3).map(e => e.textContent.trim()))`))
  check('排序切到「买入日期 新→旧」', await sortPick('买入日期 新→旧'))
  const buyDesc = await firstBuyDates()
  console.log('  买入日期降序前 3:', buyDesc)
  const isoOf = (t) => (t.match(/买入 (\d{4}-\d{2}-\d{2})/) || [])[1] ?? ''
  const dates = buyDesc.map(isoOf).filter(Boolean)
  check('买入日期降序生效', dates.length >= 2 && dates.every((d, i) => i === 0 || dates[i - 1] >= d), JSON.stringify(buyDesc))
  const datesShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-trades-dates.png'), Buffer.from(datesShot.data, 'base64'))
  check('排序切回「行号 高→低」', await sortPick('行号 高→低'))

  // 卡片上买入/卖出日期都要显示（空就显示 —）
  const cardText = await evaluate(`document.querySelector('[data-row="63"] .dates')?.textContent.trim() ?? ''`)
  console.log('  R63 日期行:', cardText)
  check('卡片显示买入/卖出日期', cardText.includes('买入') && cardText.includes('卖出'))
  check('R63 买入日期为空显示 —（先卖后买）', /买入\s*—/.test(cardText), cardText)
  check('R63 卖出日期为空显示 —', /卖出\s*—/.test(cardText), cardText)
  const r2Text = await evaluate(`document.querySelector('[data-row="2"] .dates')?.textContent.trim() ?? ''`)
  check('R2 两个日期都有值', /买入 \d{4}-\d{2}-\d{2}/.test(r2Text) && /卖出 \d{4}-\d{2}-\d{2}/.test(r2Text), r2Text)

  // 缺日期筛选拆成买入/卖出两个
  const pickStatus = async (label) => {
    await evaluate(`document.querySelector('.app-main [role="combobox"][aria-label="按状态筛选"]')?.click()`)
    await sleep(300)
    const ok = await clickByText('[role="option"]', label)
    await sleep(400)
    return ok
  }
  check('筛选「缺卖出日期」', await pickStatus('缺卖出日期'))
  const sellMissingCount = await headCount()
  check('缺卖出日期 9 行', sellMissingCount === 9, String(sellMissingCount))
  check('筛选「缺买入日期」', await pickStatus('缺买入日期'))
  const buyMissingCount = await headCount()
  check('缺买入日期 4 行（R60–63）', buyMissingCount === 4, String(buyMissingCount))
  check('筛选回到全部状态', await pickStatus('全部状态'))
  check('全部状态行数恢复', (await headCount()) === allCount, `${await headCount()}/${allCount}`)
  check('明细顶部吸顶', (await stickyOf('trades')) === 'sticky')
  const tradePills = await evaluate(`JSON.stringify([...document.querySelectorAll('.stock-tabs > *')].map(e => e.textContent.trim()))`)
  check('明细也有股票药丸（含「全部」）', JSON.parse(tradePills)[0] === '全部' && JSON.parse(tradePills).length === 5, tradePills)
  check(
    '点开第 63 行',
    await evaluate(`(() => {
      const el = document.querySelector('[data-row="63"]')
      if (!el) return false
      el.click(); return true
    })()`),
  )
  await sleep(700)
  check('抽屉出现变更历史', (await bodyText()).includes('变更历史'))
  check('点编辑', await clickByText('button', '编辑'))
  await sleep(400)
  await setInput('input[data-field="targetPrice"]', '9.00')
  await sleep(300)
  check('点保存', await clickByText('button', '保存'))
  await sleep(1000)
  check('能读到 9.00', (await bodyText()).includes('9.00'))
  await closeDrawer()
  await nav('overview')
  check('编辑后盈利 ¥9,990', (await bodyText()).includes('9,990'))

  console.log('\n[6.5] 拆分卖出目标（分批止盈）')
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="16"]')?.click()`)
  await sleep(600)
  check('抽屉里有「卖出目标」', (await bodyText()).includes('卖出目标'))
  await setInput('input[aria-label="拆分目标价"]', '10.00')
  await setInput('input[aria-label="拆分股数"]', '100')
  await sleep(200)
  check('点拆分', await clickByText('button', '拆分'))
  await sleep(900)
  text = await bodyText()
  check('出现手动拆分目标', text.includes('手动拆分') && text.includes('10.00'))
  check('自动目标缩到 100', text.includes('自动（E 列）'))
  // 清理：删掉刚拆的手动目标，回到 29 条待卖
  check('删掉拆分目标', await clickByText('button', '删除'))
  await sleep(700)
  check('拆分目标已移除', !(await bodyText()).includes('手动拆分'))
  await closeDrawer()

  console.log('\n[7] 删除 → 恢复 → 改回')
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

  await nav('trades')
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(600)
  await clickByText('button', '编辑')
  await sleep(400)
  await setInput('input[data-field="targetPrice"]', '8.68')
  await sleep(300)
  await clickByText('button', '保存')
  await sleep(900)
  await closeDrawer()
  await nav('overview')
  text = await bodyText()
  check('改回后盈利 ¥9,830 且基准全中', text.includes('9,830') && text.includes('基准全中'))

  console.log('\n[8] 挂单：确认昨收 → 涨停/跌停 → 今日挂单')
  check('切到挂单', await nav('orders'))
  check('挂单顶部吸顶', (await stickyOf('orders')) === 'sticky')
  text = await bodyText()
  check('页面显示「涨跌幅 10%」', text.includes('涨跌幅 10%'))
  check('没有涨跌幅选择器', !text.includes('创业板 20%'))
  check('未确认时提示要确认', text.includes('才算涨停/跌停'))

  // 选柳工（待卖价多落在区间内）
  await evaluate(`document.querySelector('.app-main [role="combobox"]')?.click()`)
  await sleep(400)
  check('选柳工', await clickByText('[role="option"]', '柳工'))
  await sleep(500)
  check('读入昨收 8.10', await setInput('input[aria-label="昨收价"]', '8.10'))
  await sleep(300)
  check('点「确认」', await clickByText('button', '确认'))
  await sleep(700)
  text = await bodyText()
  const limitUp = await evaluate(`document.querySelector('[data-tag="limit-up"]')?.textContent.trim() ?? ''`)
  const limitDown = await evaluate(`document.querySelector('[data-tag="limit-down"]')?.textContent.trim() ?? ''`)
  console.log('  涨跌停标签:', limitUp, '/', limitDown)
  check('涨停价 8.91', limitUp.includes('8.91'))
  check('跌停价 7.29', limitDown.includes('7.29'))
  check('出现「今日挂单」', text.includes('今日挂单'))
  check('今日挂单有可挂买', /可挂买\s*[1-9]/.test(text))

  // 今日挂单 / 待买 / 待卖 都要在带边框的数据块里，且块内有分组标签
  const blocks = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.data-block')]
    const bordered = list.filter(el => parseFloat(getComputedStyle(el).borderTopWidth) > 0)
    return JSON.stringify({
      total: list.length,
      bordered: bordered.length,
      labels: [...document.querySelectorAll('.group-label')].map(e => e.textContent.trim()),
    })
  })()`)
  console.log('  数据块:', blocks)
  const blk = JSON.parse(blocks)
  check('挂单页有带边框的数据块', blk.bordered >= 2, blocks)
  check('可挂买/可挂卖 分组标签存在', blk.labels.some((l) => l.includes('可挂买')) && blk.labels.some((l) => l.includes('可挂卖')), blocks)
  check('今日挂单里有「记成交」', text.includes('记成交'))

  // 待买/待卖必须常驻，不能藏在页签后面（§04）
  const tabCount = await evaluate(`document.querySelectorAll('[role="tab"]').length`)
  check('挂单页不再用页签藏待买', Number(tabCount) === 0, String(tabCount))
  check('待买清单常驻', /待买\s*\d+\s*条/.test(text) && text.includes('空头敞口要一直看得见'))

  console.log('\n[8.1] 涨跌停手工覆盖')
  check('点「手工调整」', await clickByText('button', '手工调整'))
  await sleep(400)
  await setInput('input[aria-label="手工跌停价"]', '7.00')
  await setInput('input[aria-label="手工涨停价"]', '9.50')
  await sleep(200)
  check('点「应用」', await clickByText('button', '应用'))
  await sleep(700)
  text = await bodyText()
  const manualUp = await evaluate(`document.querySelector('[data-tag="limit-up"]')?.textContent.trim() ?? ''`)
  check('手工区间生效（涨停 9.50）', manualUp.includes('9.50'), manualUp)
  check('出现「手工区间」标记', text.includes('手工区间'))
  check('点「恢复」', await clickByText('button', '恢复'))
  await sleep(600)
  const backUp = await evaluate(`document.querySelector('[data-tag="limit-up"]')?.textContent.trim() ?? ''`)
  check('恢复后回到 8.91', backUp.includes('8.91'), backUp)

  console.log('\n[8.2] 挂单计划价')
  check('点第一个「计划」', await clickByText('button', '计划'))
  await sleep(500)
  check('计划弹窗出现', (await bodyText()).includes('计划价只用于显示和导出'))
  await setInput('input[data-field="planPrice"]', '7.95')
  await setInput('input[data-field="planQty"]', '300')
  await sleep(200)
  check('保存计划', await clickByText('button', '保存'))
  await sleep(800)
  text = await bodyText()
  check('列表出现「计划 7.95 × 300」', text.includes('计划 7.95') && text.includes('300'))
  await sleep(600)
  const orderShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-orders-confirmed.png'), Buffer.from(orderShot.data, 'base64'))

  console.log('\n[8.5] 记回补成交 → 敞口减少 → 撤销')
  check('点第一个「记成交」', await clickByText('button', '记成交'))
  await sleep(600)
  check('弹出记成交窗口', (await bodyText()).includes('本次回补股数'))
  check('默认股数已填', (await evaluate(`document.querySelector('input[data-field="execQty"]')?.value ?? ''`)) !== '')
  check('点保存', await clickByText('button', '保存'))
  await sleep(1200)
  await nav('overview')
  text = await bodyText()
  check('回补 500 股后待补 1,500', text.includes('1,500'))
  check('回补后净持仓 13,700', text.includes('13,700'))
  await nav('orders')
  await evaluate(`document.querySelector('.app-main [role="combobox"]')?.click()`)
  await sleep(300)
  await clickByText('[role="option"]', '柳工')
  await sleep(400)
  check('点「撤销最后一笔」', await clickByText('button', '撤销最后一笔'))
  await sleep(1000)
  await nav('overview')
  text = await bodyText()
  check('撤销后待补回到 2,000', text.includes('2,000'))
  check('撤销后净持仓回到 13,200', text.includes('13,200'))

  console.log('\n[9] 停用开关：其他页面不再出现该股')
  await nav('manage')
  check(
    '关掉奥佳华',
    await evaluate(`(() => {
      const sw = document.querySelector('[aria-label="启用 奥佳华"]')
      if (!sw) return false
      sw.click(); return true
    })()`),
  )
  await sleep(800)
  await nav('overview')
  const pillsAfter = await evaluate(`JSON.stringify([...document.querySelectorAll('.stock-tabs > *')].map(e => e.textContent.trim()))`)
  check('概览不再有奥佳华', !pillsAfter.includes('奥佳华'), pillsAfter)
  await nav('trades')
  const tradePillsAfter = await evaluate(`JSON.stringify([...document.querySelectorAll('.stock-tabs > *')].map(e => e.textContent.trim()))`)
  check('明细不再有奥佳华', !tradePillsAfter.includes('奥佳华'), tradePillsAfter)
  await nav('stats')
  check('统计不再有奥佳华', !(await bodyText()).includes('奥佳华'))
  await nav('manage')
  await evaluate(`document.querySelector('[aria-label="启用 奥佳华"]')?.click()`)
  await sleep(700)
  await nav('overview')
  check('重新启用后回到概览', (await bodyText()).includes('奥佳华'))

  console.log('\n[10] 新增一笔：卖出（先卖后买）')
  await nav('trades')
  check('点「新增一笔」', await clickByText('button', '新增一笔'))
  await sleep(600)
  check('弹窗立即可见（无打字机）', (await bodyText()).includes('买入份额') || (await bodyText()).includes('卖出数量'))
  check('切到卖出', await clickByText('button', '卖出'))
  await sleep(300)
  text = await bodyText()
  check('卖出表单出现「成交价」「回补价」', text.includes('成交价') && text.includes('回补价'))
  check(
    '打开股票下拉',
    await evaluate(`(() => {
      const box = [...document.querySelectorAll('[role="combobox"]')].pop()
      if (!box) return false
      box.click(); return true
    })()`),
  )
  await sleep(400)
  check('选柳工', await clickByText('[role="option"]', '柳工'))
  await sleep(400)
  await setInput('input[data-field="date"]', '2026-10-21')
  await setInput('input[data-field="price"]', '8.68')
  await setInput('input[data-field="qty"]', '500')
  // R3：回补价留空 → 卖出价 8.68 − 柳工间隔 0.57 = 8.11，且默认生成待买
  await sleep(300)
  check('点保存', await clickByText('button', '保存'))
  await sleep(1200)
  await nav('overview')
  text = await bodyText()
  check('卖出后净持仓 12,700', text.includes('12,700'))
  check('卖出后敞口 2,500', text.includes('2,500'))

  // 回补价被自动推导出来，来源写在明细里
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="100000"]')?.click()`)
  await sleep(700)
  text = await bodyText()
  check('抽屉标出「回补价 = 卖出价 − 间隔」', text.includes('回补价 = 卖出价 − 间隔'))
  check('推导出的回补价 8.11', text.includes('8.11'))
  await closeDrawer()

  console.log('\n[11] 删掉这笔手动卖出，恢复原状')
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="100000"]')?.click()`)
  await sleep(600)
  await evaluate(`window.confirm = () => true`)
  check('删除手动行', await clickByText('button', '删除'))
  await sleep(900)
  await nav('overview')
  text = await bodyText()
  check('回到净持仓 13,200', text.includes('13,200'))
  check('基准重新全中', text.includes('基准全中'))

  console.log('\n[11.2] 账户')
  await nav('manage')
  check('切到账户 tab', await clickByText('[role="tab"]', '账户'))
  await sleep(500)
  text = await bodyText()
  check('默认账户存在', text.includes('默认账户'))
  await setInput('input[aria-label="账户名"]', '2027 年')
  await sleep(200)
  check('点添加', await clickByText('button', '添加'))
  await sleep(900)
  text = await bodyText()
  check('新账户出现在列表', text.includes('2027 年'))
  check('顶部账户选择器存在', (await evaluate(`Boolean(document.querySelector('[aria-label="切换账户"]'))`)) === true)

  console.log('\n[11.5] 下拉浮层不被卡片裁掉')
  await nav('manage')
  await clickByText('[role="tab"]', '股票')
  await sleep(500)
  check('打开涨跌幅下拉', await evaluate(`(() => {
    const box = document.querySelector('.app-main [role="combobox"]')
    if (!box) return false
    box.scrollIntoView({ block: 'center' })
    box.click(); return true
  })()`))
  await sleep(500)
  const dd = await evaluate(`(() => {
    const d = document.querySelector('[class*="animal-dropdown"]')
    if (!d) return null
    const r = d.getBoundingClientRect()
    const y = Math.min(Math.max(r.top + 24, 2), innerHeight - 2)
    const hit = document.elementFromPoint(r.left + r.width / 2, y)
    return JSON.stringify({
      inViewport: r.right <= innerWidth + 1 && r.left >= -1,
      hitIsOption: Boolean(hit && hit.closest('[class*="animal-dropdown"]')),
      height: Math.round(r.height),
      top: Math.round(r.top),
      hitClass: hit ? String(hit.className).slice(0, 40) : 'null',
    })
  })()`)
  console.log('  下拉检测:', dd)
  check('下拉存在且在视口内', dd !== null && JSON.parse(dd).inViewport === true)
  check('下拉没有被卡片裁掉（命中测试）', dd !== null && JSON.parse(dd).hitIsOption === true)
  const ddShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-dropdown.png'), Buffer.from(ddShot.data, 'base64'))
  await evaluate(`document.body.click()`)
  await sleep(300)

  console.log('\n[12] 截图')
  await sleep(4800) // 等轻提示消失，截干净的图
  for (const [key, file] of [
    ['overview', 'mobile-overview.png'],
    ['trades', 'mobile-trades.png'],
    ['orders', 'mobile-orders.png'],
    ['stats', 'mobile-stats.png'],
  ]) {
    await nav(key)
    await sleep(500)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'))
  }
  // 挂单页整页（看待买/待卖是不是常驻两段）
  await nav('orders')
  await sleep(500)
  const ordersFull = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(OUT, 'mobile-orders-full.png'), Buffer.from(ordersFull.data, 'base64'))

  await nav('manage')
  await sleep(500)
  const manageShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-stocks.png'), Buffer.from(manageShot.data, 'base64'))
  await clickByText('[role="tab"]', '导入')
  await sleep(500)
  const importShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-manage.png'), Buffer.from(importShot.data, 'base64'))
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(700)
  const drawerShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-drawer.png'), Buffer.from(drawerShot.data, 'base64'))
  await closeDrawer()
  console.log(`  截图已存 ${OUT}`)

  console.log('\n[13] 运行时错误')
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

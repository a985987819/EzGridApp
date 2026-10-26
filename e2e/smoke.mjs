/**
 * 项目自带 E2E 冒烟（移动端 390×844 视口）：
 * 股票排序 → 导入 → 基准校验 → 分股 tab → 明细编辑/删除/恢复 → 跨数据跳转/URL 筛选/可叠加筛选/一键复位
 * → 挂单区间 → 启用开关 → 手动卖出
 *
 *   node e2e/smoke.mjs http://127.0.0.1:5173
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9444
const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
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
  // 本地 fixture 直接塞进 file input（示例文件不再随站点发布）
  const uploadFile = async (selector, filePath) => {
    await send('DOM.enable')
    const { root } = await send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) return false
    await send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
    return true
  }
  const clickByText = (sel, text) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().includes(${JSON.stringify(text)}))
      if (!el) return false
      el.click(); return true
    })()`)
  // V9.46：按行上的回本链身份点开明细行（anchor = 亏着清仓的锚点）；返回命中的行号，没命中返回 null
  const clickChainRow = async (kind, stock = null) => {
    const where = stock
      ? `el.querySelector('.name')?.textContent.trim() === ${JSON.stringify(stock)}`
      : 'true'
    return evaluate(`(() => {
      const items = [...document.querySelectorAll('.trade-item[data-chain="${kind}"]')].filter((el) => ${where})
      if (items.length === 0) return null
      items[0].click()
      return items[0].getAttribute('data-row')
    })()`)
  }
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
  // 管理页 V9.44 改成按钮入口：从某个子页回菜单（已在菜单时返回 false）
  const backToManageMenu = () =>
    evaluate(`(() => {
      const b = document.querySelector('[data-testid="manage-back"]')
      if (!b) return false
      b.click(); return true
    })()`)
  const stickyOf = (key) =>
    evaluate(`(() => {
      const el = document.querySelector('[data-sticky="${key}"]')
      if (!el) return 'missing'
      return getComputedStyle(el).position
    })()`)
  const setInput = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  const readTable = (table) => evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('grid-trading')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(${JSON.stringify(table)}, 'readonly')
      const rows = tx.objectStore(${JSON.stringify(table)}).getAll()
      rows.onsuccess = () => resolve(rows.result)
      rows.onerror = () => reject(rows.error)
      tx.oncomplete = () => db.close()
    }
  })`)
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
    if (text.includes('概览')) break
    await sleep(1200)
  }
  check('全局「网格交易」header 已移除', (await evaluate(`Boolean(document.querySelector('.app-header'))`)) === false)
  check('底部导航 5 项', (await evaluate(`document.querySelectorAll('button[data-nav]').length`)) === 5)
  check('空态引导', text.includes('还没有导入数据') || text.includes('去导入'))
  check('没有横向溢出', (await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`)) === true)
  // V9.37：切页有方向感动画（往右走 = page-in-forward，往左走 = page-in-back）
  const pageAnim = await evaluate(`getComputedStyle(document.querySelector('.app-main > *')).animationName`)
  check('页面进场动画生效', ['page-in', 'page-in-forward', 'page-in-back'].includes(pageAnim), pageAnim)

  console.log('\n[2] 管理 · 股票（按钮入口）+ 拖动排序')
  check('切到管理页', await nav('manage'))
  check(
    '管理页是按钮入口',
    (await evaluate(`document.querySelectorAll('[data-manage-entry]').length`)) === 4,
  )
  text = await bodyText()
  check('入口列表不展开内容', !text.includes('默认间隔') && text.includes('股票设置'))
  check(
    '点「股票设置」进入',
    await clickByText('[data-manage-entry="stocks"]', '股票设置'),
  )
  await sleep(500)
  text = await bodyText()
  check('股票设置展示', text.includes('默认间隔') && text.includes('涨跌幅规则'))
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

  console.log('\n[3] 管理 · 导入 → 本地 fixture → 写入本地')
  check(
    '返回管理菜单',
    await evaluate(`(() => {
      const b = document.querySelector('[data-testid="manage-back"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(350)
  check('切到导入入口', await clickByText('[data-manage-entry="import"]', '导入数据'))
  await sleep(400)
  check(
    '选本地 fixture 文件',
    await uploadFile('input[type="file"]', join(process.cwd(), 'tests', 'fixtures', '26年网格记录.xlsx')),
  )
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
  // V9.10：基准体检挪去管理 · 校验，概览只在异常时弹「去管理页看」
  check('概览无基准异常提示', !text.includes('去管理页看'))
  const pills = await evaluate(`JSON.stringify([...document.querySelectorAll('.stock-tabs > *')].map(e => e.textContent.trim()))`)
  console.log('  概览药丸:', pills)
  check('药丸顺序跟随股票排序（三一重工在前）', JSON.parse(pills)[0] === '三一重工')

  // V9.41 概览重排：股票 tab 置顶 → 已实现盈利行 → 树占满首屏；可卖/净持仓行滚到树下
  const layoutInfo = await evaluate(`(() => {
    const canvas = document.querySelector('canvas[data-tree="price"]')
    const tabs = document.querySelector('.stock-tabs')
    const strips = [...document.querySelectorAll('.metric-strip')]
    const card = document.querySelector('.tree-full')
    const nav = document.querySelector('.app-nav')
    if (!canvas || !tabs || strips.length < 2 || !card || !nav) return null
    const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    return JSON.stringify({
      h: Math.round(canvas.getBoundingClientRect().height),
      tabsBeforeTree: after(tabs, canvas),
      topBeforeTree: after(strips[0], canvas),
      bottomAfterTree: after(canvas, strips[1]),
      topText: strips[0].textContent || '',
      bottomText: strips[1].textContent || '',
      gapToNav: Math.round(nav.getBoundingClientRect().top - card.getBoundingClientRect().bottom),
      count: Boolean(document.querySelector('.profit-count b')),
      hasHeading: (document.body.innerText || '').includes('选股 · 当前股票汇总'),
    })
  })()`)
  const layout = layoutInfo ? JSON.parse(layoutInfo) : null
  console.log('  首屏布局:', layoutInfo)
  check('股票 tab 置顶（DOM 先于树）', Boolean(layout?.tabsBeforeTree), layoutInfo ?? '')
  check(
    '高频四项在树上方、可卖行在树下方',
    Boolean(layout?.topBeforeTree && layout?.bottomAfterTree),
    layoutInfo ?? '',
  )
  check(
    '顶部指标 = 已实现盈利 / 理想可卖到 / 理想剩余可赚 / 今年共卖',
    Boolean(
      layout &&
        ['已实现盈利', '理想可卖到', '理想剩余可赚', '今年共卖'].every((t) => layout.topText.includes(t)),
    ),
    layout?.topText ?? '',
  )
  check(
    '树下指标 = 可卖 / 待补 / 净持仓 / 已实现',
    Boolean(
      layout &&
        ['可卖', '待补', '净持仓', '已实现'].every((t) => layout.bottomText.includes(t)),
    ),
    layout?.bottomText ?? '',
  )
  check('树填满首屏（画布 ≥ 450px 高）', Boolean(layout && layout.h >= 450), layoutInfo ?? '')
  check(
    '树卡铺到导航上沿（间距 0~24px）',
    Boolean(layout && layout.gapToNav >= 0 && layout.gapToNav <= 24),
    layoutInfo ?? '',
  )
  check('「选股 · 当前股票汇总」标题行已移除', layout?.hasHeading === false, layoutInfo ?? '')
  check('盈利右侧有「共计x次」', Boolean(layout?.count), layoutInfo ?? '')
  check('共计次数文案在页面上', /共计\s*\d+\s*次/.test(text), '')
  // 视觉凭证：树下的低频区（可卖/待补/净持仓/已实现 + 合计三格）确实要滚动才看到
  await evaluate(`window.scrollTo(0, document.body.scrollHeight)`)
  await sleep(400)
  const bottomShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-overview-bottom.png'), Buffer.from(bottomShot.data, 'base64'))
  await evaluate(`window.scrollTo(0, 0)`)
  await sleep(300)

  // V9.28 当前股票概述四项 + V9.29「理想可卖到」改股价并画到数轴上
  check(
    '当前股票概述四项',
    text.includes('已实现盈利') && text.includes('理想可卖到') && text.includes('理想剩余可赚') && text.includes('今年共卖'),
  )
  const idealInfo = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    if (!c || !c.__tree) return null
    const lv = c.__tree.levels()
    const topSell = lv.filter((l) => l.sell > 0).reduce((m, l) => Math.max(m, l.cents), 0)
    return JSON.stringify({
      ideal: c.__tree.ideal(),
      topSell,
      axis: c.__tree.style() === 'axis',
      badge: Boolean(document.querySelector('.tree-stat.ideal')),
      card: (document.querySelector('.metric-strip') || {}).textContent || '',
    })
  })()`)
  const ideal = idealInfo ? JSON.parse(idealInfo) : null
  console.log('  理想可卖到:', idealInfo)
  check('「理想可卖到」= 最高待卖目标价（股价口径）', Boolean(ideal && ideal.ideal > 0 && ideal.ideal === ideal.topSell), idealInfo)
  check('该价位画在数轴上（数轴风不再留左上角金额牌）', Boolean(ideal && ideal.axis && ideal.badge === false), idealInfo)
  check('概述卡显示的是股价而非金额', Boolean(ideal && /\d+\.\d{2}\s*元/.test(ideal.card)), ideal?.card ?? '')

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
  check('构成里有 Σ 买入（含回补批次）/ Σ 卖出 / 净持仓', text.includes('Σ 买入份额（含回补批次）') && text.includes('Σ 卖出量') && text.includes('净持仓'))
  check('参数一致（合计 13,200）', text.includes('= 13,200'))
  check('点「收起」', await clickByText('button', '收起'))
  await sleep(400)
  check('收起后面板消失', !(await bodyText()).includes('净持仓构成'))

  console.log('\n[5] 2D 价格树（Canvas 双风格：图鉴素雅/手绘插画，替代价格表格）')
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(800) // 首帧（Canvas 直绘，无需等 chunk）
  check(
    '树干画布出现',
    Boolean(await evaluate(`Boolean(document.querySelector('canvas[data-tree="price"]'))`)),
  )
  const treeInfo = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    if (!c || !c.__tree) return null
    const r = c.getBoundingClientRect()
    const lv = c.__tree.levels()
    lv.sort((a, b) => b.sell - a.sell)
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), levels: lv.length, topSell: lv[0] })
  })()`)
  console.log('  树干:', treeInfo)
  const tree = treeInfo ? JSON.parse(treeInfo) : null
  check('画布有尺寸且解析出档位', Boolean(tree && tree.w > 150 && tree.h > 150 && tree.levels >= 10), treeInfo)
  check(
    '默认风格=数轴（V9.25）',
    (await evaluate(`document.querySelector('canvas[data-tree="price"]').__tree.style()`)) === 'axis',
  )
  const treeShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-tree.png'), Buffer.from(treeShot.data, 'base64'))

  // 先在概览页验滚轮缩放（点击会跳走，缩放要放在跳转前）
  // V9.23 缩放锚定光标：真实滚轮打在画布下沿——span 变小的同时视野中心向下沿
  // 靠拢，而不是从画面正中放大。CDP 坐标要画布在视口内 + 藏掉吸顶层才落得准
  await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    c.scrollIntoView({ block: 'center' })
    window.scrollBy(0, -80)
    const st = document.querySelector('[data-sticky="overview"]')
    if (st) st.style.visibility = 'hidden'
  })()`)
  await sleep(400)
  const wheelInfo0 = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    const r = c.getBoundingClientRect()
    return JSON.stringify({
      span: c.__tree.span(), center: c.__tree.center(),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.85),
    })
  })()`)
  const w0 = JSON.parse(wheelInfo0)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w0.x, y: w0.y, deltaX: 0, deltaY: -600 })
  await sleep(400)
  const wheelInfo1 = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({ span: c.__tree.span(), center: c.__tree.center() })
  })()`)
  const w1 = JSON.parse(wheelInfo1)
  check('滚轮缩放生效（span 变小）', w1.span < w0.span * 0.9, `${w0.span} → ${w1.span}`)
  check('缩放锚定光标（下沿缩放中心下移）', w1.center < w0.center - 0.1, `${w0.center} → ${w1.center}`)
  await evaluate(`(() => {
    const st = document.querySelector('[data-sticky="overview"]')
    if (st) st.style.visibility = ''
  })()`)

  // 放大状态截图：聚合枝应分散回原档位数、枝梢数据牌互不重叠（V9.21）
  const zoomInShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-tree-zoomin.png'), Buffer.from(zoomInShot.data, 'base64'))

  // 缩到最远看整条价格轴（标签密度 / 枝干比例 / 云朵），拍完恢复原视野——
  // 缩远会把 camY 钳到 span/2（视野离开数据区），不恢复的话后面点击全落空
  const view0 = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]').__tree
    return JSON.stringify({ span: c.span(), center: c.center() })
  })()`)
  await evaluate(`document.querySelector('canvas[data-tree="price"]').__tree.zoomBy(0.05)`)
  await sleep(300)
  const treeFarShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-tree-zoomout.png'), Buffer.from(treeFarShot.data, 'base64'))
  const { span: v0span, center: v0center } = JSON.parse(view0)
  await evaluate(`document.querySelector('canvas[data-tree="price"]').__tree.setView(${v0span}, ${v0center})`)
  await sleep(200)

  // V9.23/24/25 多风格循环：数轴（默认）→ 图鉴素雅 → 手绘插画（V9.18~21 存档）→ 回数轴；
  // 偏好落 localStorage
  await evaluate(`document.querySelector('[data-testid="tree-style-toggle"]').click()`)
  await sleep(700) // 重挂 effect + 首帧
  const style1 = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({ style: c.__tree.style(), stored: localStorage.getItem('ezgrid.treeStyle') })
  })()`)
  const s1 = JSON.parse(style1)
  check('切到图鉴素雅并落 localStorage', s1.style === 'atlas' && s1.stored === 'atlas', style1)
  await evaluate(`document.querySelector('[data-testid="tree-style-toggle"]').click()`)
  await sleep(700)
  const style2 = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({ style: c.__tree.style(), stored: localStorage.getItem('ezgrid.treeStyle') })
  })()`)
  const s2 = JSON.parse(style2)
  check('切到手绘插画（三风格循环）', s2.style === 'sketch' && s2.stored === 'sketch', style2)
  const sketchShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-tree-sketch.png'), Buffer.from(sketchShot.data, 'base64'))
  await evaluate(`document.querySelector('[data-testid="tree-style-toggle"]').click()`)
  await sleep(700)
  const style3 = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({ style: c.__tree.style(), stored: localStorage.getItem('ezgrid.treeStyle') })
  })()`)
  const s3 = JSON.parse(style3)
  check('切回数轴（默认风格）', s3.style === 'axis' && s3.stored === 'axis', style3)

  // V9.26.2：hover 预览已移除（点击跳转保留）；枝梢注记文字区仍是点击热区（扩靶）
  const hoverPt = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    const lv = c.__tree.levels().filter((l) => l.sell > 0).sort((a, b) => b.sell - a.sell)
    return JSON.stringify(c.__tree.projectPrice(lv[0].cents))
  })()`)
  const hp = JSON.parse(hoverPt)
  const noteZone = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify(c.__tree.pickAt(${hp.x} + 60, ${hp.y}))
  })()`)
  check('注记文字区也是热区', Boolean(noteZone && JSON.parse(noteZone).cents), noteZone ?? '')
  check('hover 浮层已移除', !(await evaluate(`Boolean(document.querySelector('[data-testid="tree-hover"]'))`)))

  // V9.18 左右拖动平移：真实鼠标拖（按下→横移 120px→松手；dragMoved>7 不触发拾取）
  // 画布多半在视口外/被吸顶层盖住：滚到位并临时藏掉吸顶层，否则 CDP 坐标落空
  await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    c.scrollIntoView({ block: 'center' })
    window.scrollBy(0, -80)
    const st = document.querySelector('[data-sticky="overview"]')
    if (st) st.style.visibility = 'hidden'
  })()`)
  await sleep(400)
  const pan0 = await evaluate(`document.querySelector('canvas[data-tree="price"]').__tree.panX()`)
  const rectC = await evaluate(`(() => {
    const r = document.querySelector('canvas[data-tree="price"]').getBoundingClientRect()
    return JSON.stringify({ cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) })
  })()`)
  const { cx, cy } = JSON.parse(rectC)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 60, y: cy, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 120, y: cy, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 120, y: cy, button: 'left', clickCount: 1 })
  await sleep(300)
  const pan1 = await evaluate(`document.querySelector('canvas[data-tree="price"]').__tree.panX()`)
  check('左右拖动平移生效（树干可拖离中心）', typeof pan1 === 'number' && Math.abs(pan1 - pan0) >= 115, `${pan0} → ${pan1}`)
  // 拖走的树平移回中，后面 projectPrice 的点击不受影响
  await evaluate(`document.querySelector('canvas[data-tree="price"]').__tree.panXBy(-120)`)
  await sleep(200)

  // 点最密的待卖叶团 → 明细带价格档
  const topCents = tree.topSell.cents
  // V9.15 画布加高后目标点可能滚出视口/被吸顶头部盖住：滚到位并把吸顶层临时藏掉再取坐标
  await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    c.scrollIntoView({ block: 'center' })
    window.scrollBy(0, -80)
    const st = document.querySelector('[data-sticky="overview"]')
    if (st) st.style.visibility = 'hidden'
  })()`)
  await sleep(400)
  const pj = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify(c.__tree.projectPrice(${topCents}))
  })()`)
  const clickAt = JSON.parse(pj)
  check('档位能投影到屏幕', clickAt && clickAt.x > 0 && clickAt.y > 0, pj)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickAt.x, y: clickAt.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickAt.x, y: clickAt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickAt.x, y: clickAt.y, button: 'left', clickCount: 1 })
  await sleep(700)
  const treeHash = await evaluate('location.hash')
  check(
    '点叶跳明细带价格档（单档=精确、聚合=区间）',
    treeHash.startsWith('#/trades') &&
      (treeHash.includes(`price=${topCents}`) || (treeHash.includes('priceLo=') && treeHash.includes('priceHi='))),
    treeHash,
  )
  // V9.2 起导航回明细会恢复上次筛选：当场清掉价格筛选，让 [6] 从干净明细开始
  check('清空树干点击留下的筛选', await clickByText('[data-testid="active-chips"] .filter-chip', '清空筛选'))
  await sleep(400)

  console.log('\n[5.5] 枯枝（已成交）点击跳明细（V9.15）')
  check('回概览', await nav('overview'))
  await sleep(900)
  await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    if (!c) return
    c.scrollIntoView({ block: 'center' })
    window.scrollBy(0, -80)
    const st = document.querySelector('[data-sticky="overview"]')
    if (st) st.style.visibility = 'hidden'
  })()`)
  await sleep(400)
  const soldPick = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    if (!c || !c.__tree) return null
    const lv = c.__tree.levels().filter((l) => l.sold > 0)
    if (!lv.length) return null
    // 优先找只有已成交、没有待买卖的独立档——点击不会被更近的待成交枝截胡
    const lonely = lv.filter((l) => l.sell === 0 && l.buy === 0).sort((a, b) => b.sold - a.sold)[0]
    const pick = lonely ?? lv.sort((a, b) => b.sold - a.sold)[0]
    return JSON.stringify({ cents: pick.cents, lonely: Boolean(lonely), p: c.__tree.projectPrice(pick.cents, 0) })
  })()`)
  check('枯枝档可投影', Boolean(soldPick && JSON.parse(soldPick).p), soldPick ?? '')
  if (soldPick && JSON.parse(soldPick).p) {
    const sp = JSON.parse(soldPick)
    // 合并枝点击跳的是组内代表档（V9.21 projectPrice 返回 repCents）
    const repCents = sp.p.repCents ?? sp.cents
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.p.x, y: sp.p.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.p.x, y: sp.p.y, button: 'left', clickCount: 1 })
    await sleep(700)
    const soldHash = await evaluate('location.hash')
    check(
      '点枯枝跳明细带价格（单档=精确、聚合=区间）',
      soldHash.startsWith('#/trades') &&
        (soldHash.includes(`price=${repCents}`) || (soldHash.includes('priceLo=') && soldHash.includes('priceHi='))),
      soldHash,
    )
    if (sp.lonely) check('枯枝跳转放开隐藏已完成（showDone=1）', soldHash.includes('showDone=1'), soldHash)
    check('清掉枯枝留下的筛选', await clickByText('[data-testid="active-chips"] .filter-chip', '清空筛选'))
    await sleep(400)
  }

  console.log('\n[6] 明细：股票 tab + 抽屉编辑')
  check('切到明细', await nav('trades'))
  // S3：日期区间筛选 + 排序
  const headCount = async () =>
    Number((await evaluate(`document.querySelector('.page-title p')?.textContent ?? ''`)).split('/')[0]) || 0
  const allCount = await headCount()
  // V9.11：明细页不再放日期范围组件（年月筛选只从统计页跳转），区间筛选走 URL 深链验证
  await send('Page.navigate', { url: `${BASE}/#/trades?from=2026-08-01` })
  await settle(2500)
  await sleep(400)
  const fromCount = await headCount()
  check('起始日期筛选生效（8 月后行数变少）', fromCount > 0 && fromCount < allCount, `${fromCount}/${allCount}`)
  check('日期条件 chip 出现', (await bodyText()).includes('日期 2026-08-01'))
  await send('Page.navigate', { url: `${BASE}/#/trades?from=2026-08-01&to=2026-08-31` })
  await settle(2500)
  await sleep(400)
  const rangeCount = await headCount()
  check('整月区间显示成「月份」chip', (await bodyText()).includes('月份 2026-08'), '')
  check('结束日期进一步收窄', rangeCount <= fromCount, `${rangeCount}/${fromCount}`)
  check('点掉月份 chip', await clickByText('[data-testid="active-chips"] .filter-chip', '月份 2026-08'))
  await sleep(400)
  check('点掉后恢复全部', (await headCount()) === allCount, `${await headCount()}/${allCount}`)

  // 排序平铺 chips（V9.4）：同项单击反序，再点回默认
  const sortPick = async (label) => {
    const ok = await clickByText('[aria-label="排序"] .filter-chip', label)
    await sleep(400)
    return ok
  }
  const firstRows = async () =>
    JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-row]')].slice(0,3).map(e => Number(e.getAttribute('data-row'))))`))
  check('排序切到「录入顺序 早→晚」（单击反序）', await sortPick('录入顺序'))
  const asc = await firstRows()
  check('升序生效', asc[0] < asc[1] && asc[1] < asc[2], JSON.stringify(asc))
  check('再点回「录入顺序 晚→早」默认', await sortPick('录入顺序'))
  const desc = await firstRows()
  check('降序恢复', desc[0] > desc[1] && desc[1] > desc[2], JSON.stringify(desc))

  // 买入日期排序（新→旧）
  const firstBuyDates = async () =>
    JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.trade-item .dates')].slice(0,3).map(e => e.textContent.trim()))`))
  check('排序切到「买入日期 新→旧」', await sortPick('买入日期'))
  const buyDesc = await firstBuyDates()
  console.log('  买入日期降序前 3:', buyDesc)
  const isoOf = (t) => (t.match(/买入 (\d{4}-\d{2}-\d{2})/) || [])[1] ?? ''
  const dates = buyDesc.map(isoOf).filter(Boolean)
  check('买入日期降序生效', dates.length >= 2 && dates.every((d, i) => i === 0 || dates[i - 1] >= d), JSON.stringify(buyDesc))
  const datesShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-trades-dates.png'), Buffer.from(datesShot.data, 'base64'))
  check('点录入顺序回默认排序', await sortPick('录入顺序'))

  // 卡片上买入/卖出日期都要显示（空就显示 —）
  const cardText = await evaluate(`document.querySelector('[data-row="63"] .dates')?.textContent.trim() ?? ''`)
  console.log('  R63 日期行:', cardText)
  check('卡片显示买入/卖出日期', cardText.includes('买入') && cardText.includes('卖出'))
  check('R63 买入日期为空显示 —（先卖后买）', /买入\s*—/.test(cardText), cardText)
  check('R63 卖出日期为空显示 —', /卖出\s*—/.test(cardText), cardText)
  // R2 是已完成行，默认被「隐藏已完成」藏起来：临时放开再验证双日期显示与买卖配色
  const toggleHideDoneHere = async () => {
    const ok = await clickByText('.status-chips .filter-chip', '隐藏已完成')
    await sleep(400)
    return ok
  }
  check('临时放开「隐藏已完成」', await toggleHideDoneHere())
  const r2Text = await evaluate(`document.querySelector('[data-row="2"] .dates')?.textContent.trim() ?? ''`)
  check('R2 两个日期都有值', /买入 \d{4}-\d{2}-\d{2}/.test(r2Text) && /卖出 \d{4}-\d{2}-\d{2}/.test(r2Text), r2Text)
  check(
    'R2 已完成行无状态边框',
    Boolean(
      await evaluate(`!document.querySelector('[data-row="2"].pending-sell') && !document.querySelector('[data-row="2"].pending-buy')`),
    ),
  )
  // V9.26.1 状态区分：文字统一默认色，待卖红边框 / 待买蓝边框 + 右下角同色挂单角标
  check('持仓行待卖红边框 + 挂卖角标', Boolean(await evaluate(`Boolean(document.querySelector('.trade-item.pending-sell') && document.querySelector('.trade-item.pending-sell .order-chip.sell'))`)))
  check('待回补行待买蓝边框 + 挂买角标', Boolean(await evaluate(`Boolean(document.querySelector('.trade-item.pending-buy') && document.querySelector('.trade-item.pending-buy .order-chip.buy'))`)))
  check('R63 先卖后买是待买行（蓝边框）', Boolean(await evaluate(`Boolean(document.querySelector('[data-row="63"].pending-buy'))`)))
  check('挂单角标带价格与股数', Boolean(await evaluate(`(() => { const c = document.querySelector('.order-chip'); return Boolean(c && /\\d/.test(c.textContent) && c.textContent.includes('×')) })()`)))
  check('恢复「隐藏已完成」', await toggleHideDoneHere())

  // 状态多选 chips（V9）：可叠加取交集，已生效条件 chip 可点掉，一键复位
  const toggleStatus = async (label) => {
    const ok = await clickByText('.status-chips .filter-chip', label)
    await sleep(400)
    return ok
  }
  check('筛选「缺卖出日期」', await toggleStatus('缺卖出日期'))
  const sellMissingCount = await headCount()
  // V9.5 起默认隐藏已完成：9 笔缺日期里的 5 笔（R44-50/57 中已卖完的）被排除，只剩待回补的 4 行
  check('缺卖出日期 4 行（已完成的被默认隐藏）', sellMissingCount === 4, String(sellMissingCount))
  const hashWithStatus = await evaluate('location.hash')
  check('筛选写进 URL（S7）', hashWithStatus.includes('status=sellDateMissing'), hashWithStatus)
  check('叠加「缺买入日期」', await toggleStatus('缺买入日期'))
  const bothCount = await headCount()
  check('交集 4 行（R60–63 两个日期都缺）', bothCount === 4, String(bothCount))
  check(
    '点掉「缺卖出日期」条件 chip',
    await clickByText('[data-testid="active-chips"] .filter-chip', '缺卖出日期'),
  )
  await sleep(400)
  check('点掉后只剩缺买入日期 4 行', (await headCount()) === 4, String(await headCount()))
  check('一键复位「清空筛选」', await clickByText('[data-testid="active-chips"] .filter-chip', '清空筛选'))
  await sleep(400)
  check('复位后行数恢复', (await headCount()) === allCount, `${await headCount()}/${allCount}`)
  check('复位后 URL 不带筛选', (await evaluate('location.hash')) === '#/trades', await evaluate('location.hash'))

  // V9.5：默认隐藏已完成，chip 一键找回，URL 记住 showDone=1
  // V9.46：奥佳华第 26/30 笔亏着清仓、当场成了回本链的锚点——还欠着账，不算完成，33 → 35
  check('默认隐藏已完成（62 行里可见 35 行）', allCount === 35, String(allCount))
  check('点「隐藏已完成」chip 放开', await toggleStatus('隐藏已完成'))
  const withDone = await headCount()
  check('放开后已完成行回来（62 行）', withDone === 62, String(withDone))
  check('URL 记住 showDone=1', (await evaluate('location.hash')).includes('showDone=1'), await evaluate('location.hash'))
  check('已完成行出现（R2 已卖完）', Boolean(await evaluate(`Boolean(document.querySelector('[data-row="2"]'))`)))
  check('再点恢复隐藏', await toggleStatus('隐藏已完成'))
  check('恢复隐藏后回到 35 行', (await headCount()) === allCount, String(await headCount()))
  check('明细顶部吸顶', (await stickyOf('trades')) === 'sticky')
  const tradePills = await evaluate(`JSON.stringify([...document.querySelectorAll('.stock-tabs > *')].map(e => e.textContent.trim()))`)
  check('明细也有股票药丸（含「全部」）', JSON.parse(tradePills)[0] === '全部' && JSON.parse(tradePills).length === 5, tradePills)

  console.log('\n[6.1] 明细删除搜索框；下滑收起筛选与排序，回顶恢复')
  check(
    '搜索框已删除',
    (await evaluate(`Boolean(document.querySelector('input[aria-label="搜索"]'))`)) === false &&
      !(await bodyText()).includes('搜股票名'),
  )
  const tradesFullH = Number(await evaluate(`document.querySelector('[data-sticky="trades"]')?.getBoundingClientRect().height ?? 0`))
  const topFiltersRaw = await evaluate(`(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel)
      return Boolean(el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().bottom > 0)
    }
    return JSON.stringify({
      tabs: shown('.stock-tabs'),
      status: shown('.status-chips'),
      sort: shown('.sort-chips'),
      search: Boolean(document.querySelector('input[aria-label="搜索"]')),
    })
  })()`)
  const topFilters = JSON.parse(topFiltersRaw)
  console.log('  顶部控件:', topFiltersRaw)
  check('顶部显示股票 tab / 状态筛选 / 排序', topFilters.tabs && topFilters.status && topFilters.sort, topFiltersRaw)
  await evaluate(`window.scrollTo(0, 900)`)
  await sleep(700)
  const condensedRaw = await evaluate(`(() => {
    const sticky = document.querySelector('[data-sticky="trades"]')
    const filters = document.querySelector('.trades-filters')
    const sort = document.querySelector('.sort-chips')
    const sr = sort?.getBoundingClientRect()
    return JSON.stringify({
      // V9.60：收起改 grid-rows 连续动画——容器高度收到 0 + 内容 visibility hidden
      filtersHidden: (() => {
        const wrap = document.querySelector('.trades-collapse')
        const f = document.querySelector('.trades-filters')
        return wrap ? wrap.getBoundingClientRect().height < 1 && f && getComputedStyle(f).visibility === 'hidden' : null
      })(),
      sortOut: !sr || sr.bottom <= 0,
      title: document.querySelector('[data-sticky="trades"] .page-title')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      position: sticky ? getComputedStyle(sticky).position : 'missing',
      h: Math.round(sticky?.getBoundingClientRect().height ?? 0),
      y: Math.round(window.scrollY),
    })
  })()`)
  const condensed = JSON.parse(condensedRaw)
  console.log('  收起后:', condensedRaw)
  check('下滑后筛选项隐藏', condensed.filtersHidden === true && condensed.y > 96, condensedRaw)
  check('下滑后排序方式离开视野', condensed.sortOut === true, condensedRaw)
  check('收起后标题与计数仍在吸顶', condensed.position === 'sticky' && condensed.title.includes('明细') && condensed.title.includes('笔'), condensedRaw)
  check('收起后吸顶高度变小', condensed.h > 0 && condensed.h < tradesFullH / 2, `full=${tradesFullH} condensed=${condensed.h}`)
  const condensedShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-trades-condensed.png'), Buffer.from(condensedShot.data, 'base64'))
  await evaluate(`window.scrollTo(0, 0)`)
  await sleep(800)
  const tradesRestoredRaw = await evaluate(`(() => {
    const filters = document.querySelector('.trades-filters')
    const sort = document.querySelector('.sort-chips')
    return JSON.stringify({
      y: Math.round(window.scrollY),
      // V9.60：恢复 = 容器高度回来 + 内容重新可见
      filtersShown: Boolean(
        filters &&
          getComputedStyle(filters).visibility !== 'hidden' &&
          (document.querySelector('.trades-collapse')?.getBoundingClientRect().height ?? 0) > 40,
      ),
      tabs: Boolean(document.querySelector('.stock-tabs')),
      sortShown: Boolean(sort && sort.getBoundingClientRect().top < innerHeight),
    })
  })()`)
  const tradesRestored = JSON.parse(tradesRestoredRaw)
  console.log('  回顶后:', tradesRestoredRaw)
  check(
    '回到顶部恢复筛选项与排序',
    tradesRestored.y === 0 && tradesRestored.filtersShown && tradesRestored.tabs && tradesRestored.sortShown,
    tradesRestoredRaw,
  )
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
  const drawerDate = await evaluate(`JSON.stringify({
    fields: document.querySelectorAll('.trades-edit-drawer .date-field').length,
    buttons: document.querySelectorAll('.trades-edit-drawer .date-field-btn').length,
  })`)
  const ddate = JSON.parse(drawerDate)
  check('抽屉编辑的日期字段带日期选择器', ddate.fields === 2 && ddate.buttons === 2, drawerDate)
  const drawerEditShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-drawer-edit.png'), Buffer.from(drawerEditShot.data, 'base64'))
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
  const splitDefaults = await evaluate(`({
    price: document.querySelector('input[aria-label="拆分目标价"]').placeholder,
    qty: document.querySelector('input[aria-label="拆分股数"]').placeholder,
  })`)
  check('拆分留空保存', await clickByText('button', '拆分'))
  await sleep(700)
  const defaultTarget = (await readTable('extraTargets')).find((t) => t.lotId === 'lot:16')
  check('拆分实际采用默认价量', defaultTarget?.priceCents === Math.round(Number(splitDefaults.price) * 100) && defaultTarget?.qty === Number(splitDefaults.qty), JSON.stringify(defaultTarget))
  await clickByText('button', '删除')
  await sleep(500)
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
  check('改回后盈利 ¥9,830 且概览无基准异常', text.includes('9,830') && !text.includes('去管理页看'))

  console.log('\n[7.2] 编辑抽屉：滚动位置保持 + 输入法避让（V9.40）')
  await nav('trades')
  await evaluate(`window.scrollTo(0, 1600)`)
  await sleep(500)
  const scrollBefore = await evaluate(`Math.round(window.scrollY)`)
  check('明细滚到中段', scrollBefore > 1000, String(scrollBefore))
  await evaluate(`document.querySelector('[data-row="32"]')?.click()`)
  await sleep(700)
  check('抽屉打开', (await bodyText()).includes('变更历史'))
  check('点编辑', await clickByText('button', '编辑'))
  await sleep(400)
  const tpBefore = await evaluate(`document.querySelector('input[data-field="targetPrice"]')?.value ?? ''`)
  check('目标售价有值可编辑', tpBefore !== '', tpBefore)

  // 模拟手机输入法：visualViewport 缩到 400 高
  const kbInfo = await evaluate(`(() => {
    const vv = window.visualViewport
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 400 })
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 })
    vv.dispatchEvent(new Event('resize'))
    return new Promise((res) => requestAnimationFrame(() => {
      const panel = document.querySelector('.trades-edit-drawer')
      const r = panel.getBoundingClientRect()
      const body = panel.querySelector('[class*="animal-body"]')
      const last = panel.querySelector('input[data-field="earlyBuyPrice"]')
      last?.focus()
      const lr = last?.getBoundingClientRect()
      res(JSON.stringify({
        top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
        scrollable: Boolean(body && body.scrollHeight > body.clientHeight),
        inputTop: lr ? Math.round(lr.top) : null,
        inputBottom: lr ? Math.round(lr.bottom) : null,
      }))
    }))
  })()`)
  const kb = JSON.parse(kbInfo)
  console.log('  键盘避让:', kbInfo)
  check('面板抬到键盘上方（底边 = 可见区底部）', kb.bottom <= 401 && kb.top >= 0, kbInfo)
  check('面板高度收进可见区', kb.h <= 400, kbInfo)
  check('表单区可滚动', kb.scrollable === true, kbInfo)
  check('最下面一行输入框在面板可见区内', kb.inputTop !== null && kb.inputTop >= kb.top && kb.inputBottom <= kb.bottom, kbInfo)

  await evaluate(`(() => {
    const vv = window.visualViewport
    delete vv.height
    delete vv.offsetTop
    vv.dispatchEvent(new Event('resize'))
  })()`)
  await sleep(400)
  const restoredInfo = await evaluate(`(() => {
    const r = document.querySelector('.trades-edit-drawer').getBoundingClientRect()
    return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) })
  })()`)
  const restored = JSON.parse(restoredInfo)
  check('键盘收起后面板恢复 84vh', restored.bottom === 844 && Math.abs(restored.h - 709) <= 2, restoredInfo)

  const tpNext = (Number(tpBefore) + 0.01).toFixed(2)
  await setInput('input[data-field="targetPrice"]', tpNext)
  await sleep(300)
  check('改价并保存', await clickByText('button', '保存'))
  await sleep(900)
  check('保存后抽屉仍开着', (await bodyText()).includes('变更历史'))
  check('再点编辑改回原值', await clickByText('button', '编辑'))
  await sleep(400)
  await setInput('input[data-field="targetPrice"]', tpBefore)
  await sleep(300)
  check('改回原值并保存', await clickByText('button', '保存'))
  await sleep(900)
  await closeDrawer()
  await sleep(400)
  const scrollAfter = await evaluate(`Math.round(window.scrollY)`)
  check('关掉抽屉后回到原来的滚动位置', Math.abs(scrollAfter - scrollBefore) <= 2, `${scrollAfter}/${scrollBefore}`)

  console.log('\n[7.5] 跨数据跳转 + URL 筛选（V9）')
  // 深链直达：URL 直接打开明细并带筛选（S7）
  await send('Page.navigate', { url: `${BASE}/#/trades?status=pending&stock=${encodeURIComponent('柳工')}` })
  await settle(2500)
  await sleep(600)
  check('深链落在明细页', (await evaluate('location.hash')).includes('#/trades'))
  check('深链筛选生效：柳工待回补 4 行', (await headCount()) === 4, String(await headCount()))
  const onChips = await evaluate(`JSON.stringify([...document.querySelectorAll('.status-chips .filter-chip.on')].map(e => e.textContent.trim()))`)
  check('状态 chip 处于激活态', JSON.parse(onChips).join(',').includes('待回补'), onChips)

  // 概览 · 价格树干 → 明细（股票 + 价格档）：点最密的待卖叶团
  await nav('overview')
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(1200)
  const gridPos = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    if (!c || !c.__tree) return null
    const lv = c.__tree.levels().filter((l) => l.sell > 0).sort((a, b) => b.sell - a.sell)
    return lv.length ? JSON.stringify({ cents: lv[0].cents, p: c.__tree.projectPrice(lv[0].cents) }) : null
  })()`)
  const gridTarget = gridPos ? JSON.parse(gridPos) : null
  check('树干给出可点击档位', Boolean(gridTarget && gridTarget.p), gridPos)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gridTarget.p.x, y: gridTarget.p.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gridTarget.p.x, y: gridTarget.p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gridTarget.p.x, y: gridTarget.p.y, button: 'left', clickCount: 1 })
  await sleep(600)
  const gridHash = await evaluate('location.hash')
  check(
    '树干跳转带股票和价格档（单档=精确、聚合=区间）',
    gridHash.startsWith('#/trades') &&
      (gridHash.includes(`price=${gridTarget.cents}`) || (gridHash.includes('priceLo=') && gridHash.includes('priceHi='))) &&
      decodeURIComponent(gridHash).includes('stock=柳工'),
    gridHash,
  )

  // 概览 · 待补日期标签 → 缺卖出日期
  await nav('overview')
  check(
    '点「待补日期 N 笔」标签',
    await evaluate(`(() => {
      const tag = [...document.querySelectorAll('[class*="animal-tag"]')].find(e => e.textContent.includes('待补日期'))
      if (!tag) return false
      tag.click(); return true
    })()`),
  )
  await sleep(600)
  check('跳到明细并带缺卖出日期筛选', (await evaluate('location.hash')).includes('status=sellDateMissing'))
  // 执行类跳转自带 showDone=1 放开隐藏，行数与来源标签一致
  check('缺卖出日期 9 行（跳转自动放开隐藏）', (await headCount()) === 9, String(await headCount()))

  // 概览 · 敞口标签 → 空头敞口（口径与标签数字一致：待回补 ∧ 无买入批次）
  await nav('overview')
  check(
    '点「卖满后 X 股敞口」标签',
    await evaluate(`(() => {
      const tag = [...document.querySelectorAll('[class*="animal-tag"]')].find(e => e.textContent.includes('股敞口'))
      if (!tag) return false
      tag.click(); return true
    })()`),
  )
  await sleep(600)
  check('跳到明细并带空头敞口筛选', (await evaluate('location.hash')).includes('status=exposure'))
  check('空头敞口 4 行（R60–63，与敞口 2,000 股同口径）', (await headCount()) === 4, String(await headCount()))

  // 统计 · 月度成交 → 该月日期区间
  await nav('stats')
  check(
    '点月度行「2026-02」',
    await evaluate(`(() => {
      const line = [...document.querySelectorAll('.data-block .line')].find(l => l.textContent.includes('2026-02'))
      if (!line) return false
      line.click(); return true
    })()`),
  )
  await sleep(600)
  const monthHash = await evaluate('location.hash')
  check('落在明细并带该月区间', monthHash.startsWith('#/trades') && monthHash.includes('from=2026-02-01') && monthHash.includes('to=2026-02-28'), monthHash)
  check('该月行数 > 0', (await headCount()) > 0, String(await headCount()))

  // 统计 · 按股票 → 该股明细
  await nav('stats')
  check(
    '点「按股票 · 柳工」行',
    await evaluate(`(() => {
      const line = [...document.querySelectorAll('.data-block .line')].find(l => l.textContent.includes('柳工') && l.textContent.includes('净持仓'))
      if (!line) return false
      line.click(); return true
    })()`),
  )
  await sleep(600)
  const stockHash = await evaluate('location.hash')
  check('落在明细并选中该股', stockHash.startsWith('#/trades') && decodeURIComponent(stockHash).includes('stock=柳工'), stockHash)

  // 统计 · 组池 → 该股 + 该价格档
  await nav('stats')
  check(
    '点组池第一行',
    await evaluate(`(() => {
      const line = [...document.querySelectorAll('.data-block .line')].find(l => l.textContent.includes('每手'))
      if (!line) return false
      line.click(); return true
    })()`),
  )
  await sleep(600)
  const groupHash = await evaluate('location.hash')
  check('组池跳转带股票和价格档', groupHash.startsWith('#/trades') && /price=\d+/.test(groupHash) && decodeURIComponent(groupHash).includes('stock=柳工'), groupHash)
  check('组池[0]=柳工|7.81 命中 2 行（跳转自动放开隐藏）', (await headCount()) === 2, String(await headCount()))

  // V9.7：年 / 月累计盈利 + 日历按天聚合
  await nav('stats')
  text = await bodyText()
  // 基准数据：全部盈利 ¥9,830，其中 9 笔缺日期 ¥2,869 不进累计 → 年累计 ¥6,961；10 月只有 R56 → ¥196
  check('年累计盈利（¥6,961）', text.includes('6,961'), '')
  check('月累计盈利（¥196）', text.includes('196'), '')
  // 日历格 = 左当日总盈利（+196）· 右成交笔数（1笔）
  check('日历格聚合成「盈利+笔数」', text.includes('+196') && text.includes('1笔'), '')
  // V9.13：统计条占格子高度一半、内容水平居中（事件条定位有一帧量测，短重试兜底）
  let calStat = null
  for (let i = 0; i < 6 && !calStat; i += 1) {
    await sleep(300)
    calStat = await evaluate(`(() => {
      const stat = document.querySelector('.cal-day-stat')
      const bar = stat && stat.closest('[class*="animal-event-"]')
      // 事件条挂在绝对定位的 eventsLayer 里，不是 td 后代——格子高度直接从表格取
      const cell = document.querySelector('td[class*="animal-cell-"]')
      if (!bar || !cell) return null
      return JSON.stringify({
        bh: bar.getBoundingClientRect().height,
        ch: cell.getBoundingClientRect().height,
        jc: getComputedStyle(stat).justifyContent,
      })
    })()`)
  }
  check('日历统计条存在', Boolean(calStat), '')
  const cs = JSON.parse(calStat ?? '{}')
  check('统计条高度 = 格子一半', Math.abs(cs.bh - cs.ch / 2) < 3, calStat)
  check('统计条内容水平居中', cs.jc === 'center', calStat)
  const dayClicked = await evaluate(`(() => {
    const el = [...document.querySelectorAll('div,span,button,td')].find((x) => x.textContent?.trim() === '13' && x.children.length === 0)
    if (!el) return false
    el.click()
    return true
  })()`)
  await sleep(500)
  check('点日历 13 日', dayClicked)
  text = await bodyText()
  // 选中日后，下方恢复当日成交明细（每笔可点）
  check(
    '当日明细恢复（三一重工 · 17.99 × 200）',
    text.includes('17.99 × 200') && /第 \d+ 笔/.test(text),
    '',
  )
  // V9.41：日历只按卖出日归集，当日明细行首必须标明「卖出」，成本写明是买入成本
  const daySideRaw = await evaluate(`(() => {
    const root = document.querySelector('[data-testid="cal-day-sells"]')
    if (!root) return null
    const rows = [...root.querySelectorAll('.line')]
    return JSON.stringify({
      rows: rows.length,
      chips: rows.map((r) => r.querySelector('.side-chip.sell')?.textContent.trim() ?? ''),
      cost: root.textContent.includes('买入成本'),
    })
  })()`)
  const daySide = daySideRaw ? JSON.parse(daySideRaw) : null
  check(
    '当日明细每笔标「卖出」',
    Boolean(daySide && daySide.rows > 0 && daySide.chips.length === daySide.rows && daySide.chips.every((c) => c === '卖出')),
    daySideRaw ?? '',
  )
  check('当日明细成本写「买入成本」', Boolean(daySide?.cost), daySideRaw ?? '')
  await evaluate(`document.querySelector('[data-testid="cal-day-sells"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  const calShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-calendar-day.png'), Buffer.from(calShot.data, 'base64'))

  // 统计 · 成交日历 → 那一天
  await nav('stats')
  check(
    '点「看这天明细」',
    await clickByText('button', '看这天明细'),
  )
  await sleep(600)
  const dayHash = await evaluate('location.hash')
  check('落在明细并带单日区间', /from=\d{4}-\d{2}-\d{2}/.test(dayHash) && /to=\d{4}-\d{2}-\d{2}/.test(dayHash) && dayHash.match(/from=([^&]+)/)?.[1] === dayHash.match(/to=([^&]+)/)?.[1], dayHash)

  // 挂单 · 待卖条目（整行可点）→ nanoId 定位（V9.4 起跳转以 nanoId 为唯一依据）
  // V9.47：待买卡里的「下一轮应买」行也含「· 买入」，这里要把它排掉，点的仍是待卖行
  await nav('orders')
  check(
    '点待卖清单行',
    await evaluate(`(() => {
      const line = [...document.querySelectorAll('.data-block .line')].find(
        (l) => !l.hasAttribute('data-buy-level') && l.textContent.includes('· 买入'),
      )
      if (!line) return false
      line.click(); return true
    })()`),
  )
  await sleep(600)
  const idHash = await evaluate('location.hash')
  const nanoId = (idHash.match(/id=([0-9a-z-]+)/) || [])[1]
  check('落在明细并带 nanoId', Boolean(nanoId), idHash)
  check('nanoId 定位 1 行', (await headCount()) === 1, String(await headCount()))
  const idChip = await evaluate(`[...document.querySelectorAll('[data-testid="active-chips"] .filter-chip')].map(e => e.textContent.trim()).join('|')`)
  check('记录序号条件 chip 显示', /第 \d+ 笔/.test(idChip), idChip)

  // 收尾清掉筛选，让后面的章节拿到干净的明细页（V9.2 起导航会恢复上次筛选）
  check('清空筛选收尾', await clickByText('[data-testid="active-chips"] .filter-chip', '清空筛选'))
  await sleep(400)

  console.log('\n[8] 挂单：确认昨收 → 涨停/跌停 → 今日挂单')
  check('切到挂单', await nav('orders'))
  check('挂单顶部吸顶', (await stickyOf('orders')) === 'sticky')
  text = await bodyText()
  // V9.13：涨跌幅档位与确认引导整行删除（自明信息不占界面），只看涨跌停价
  check('没有涨跌幅选择器', !text.includes('创业板 20%'))
  check('涨跌幅档位不再显示', !text.includes('涨跌幅'))

  // 选柳工（待卖价多落在区间内）
  await evaluate(`document.querySelector('.app-main [role="combobox"]')?.click()`)
  await sleep(400)
  check('选柳工', await clickByText('[role="option"]', '柳工'))
  await sleep(500)
  check('读入昨收 8.10', await setInput('input[aria-label="昨收价"]', '8.10'))
  await sleep(300)
  check(
    '点「确认」',
    await evaluate(`(() => {
      const b = document.querySelector('[data-action="confirm-close"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(700)
  text = await bodyText()
  const limitUp = await evaluate(`document.querySelector('[data-tag="limit-up"]')?.textContent.trim() ?? ''`)
  const limitDown = await evaluate(`document.querySelector('[data-tag="limit-down"]')?.textContent.trim() ?? ''`)
  console.log('  涨跌停标签:', limitUp, '/', limitDown)
  check('涨停价 8.91', limitUp.includes('8.91'))
  check('跌停价 7.29', limitDown.includes('7.29'))
  // V9.58：挂单页三组——应该买入（先卖后买/敞口）· 锦上添花（下一轮/P列再买）· 应该卖出（未卖份额）
  check('出现「应该买入 / 锦上添花 / 应该卖出」三组', text.includes('应该买入') && text.includes('锦上添花') && text.includes('应该卖出'))
  check('应该买入有档位（先卖后买的欠股）', await evaluate(`Boolean(document.querySelector('[data-testid="must-buy-card"] [data-testid="buy-suggestion"]'))`))

  // 三组卡片都在带边框的数据块里
  const blocks = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.data-block')]
    const bordered = list.filter(el => parseFloat(getComputedStyle(el).borderTopWidth) > 0)
    return JSON.stringify({
      total: list.length,
      bordered: bordered.length,
      heads: [...document.querySelectorAll('.sec-head strong')].map(e => e.textContent.trim()),
    })
  })()`)
  console.log('  数据块:', blocks)
  const blk = JSON.parse(blocks)
  check('挂单页有带边框的数据块', blk.bordered >= 2, blocks)
  check('三组卡片标题都在', blk.heads.includes('应该买入') && blk.heads.includes('锦上添花') && blk.heads.includes('应该卖出'), blocks)

  // V9.29.1：可挂买 / 可挂卖 行加左侧状态边框（与明细页 trade-item 同语义：蓝=买、红=卖）
  const rowEdge = await evaluate(`(() => {
    const read = (cls) => {
      const el = document.querySelector('.data-block .line.' + cls)
      if (!el) return null
      const s = getComputedStyle(el)
      return { w: parseFloat(s.borderLeftWidth), c: s.borderLeftColor }
    }
    return JSON.stringify({ buy: read('pending-buy'), sell: read('pending-sell') })
  })()`)
  console.log('  挂单行左边框:', rowEdge)
  const edge = JSON.parse(rowEdge)
  check('可挂买行有蓝色左边框', Boolean(edge.buy && edge.buy.w >= 2.5 && edge.buy.c === 'rgb(47, 111, 214)'), rowEdge)
  check('可挂卖行有红色左边框', Boolean(edge.sell && edge.sell.w >= 2.5 && edge.sell.c === 'rgb(208, 69, 63)'), rowEdge)
  check('今日挂单里有「记成交」', text.includes('记成交'))

  // 待买/待卖必须常驻，不能藏在页签后面（§04）；V9.58 起逐笔回补收进底部「台账」折叠区
  const tabCount = await evaluate(`document.querySelectorAll('[role="tab"]').length`)
  check('挂单页不再用页签藏待买', Number(tabCount) === 0, String(tabCount))
  check('台账收着逐笔回补（默认收起）', /逐笔回补\s*\d+\s*条/.test(text))
  check('逐笔回补默认收起', await evaluate(`document.querySelector('[data-testid="rebuy-ledger"]')?.open === false`))

  // V9.47：卖完的老批次也排「下一轮应买」；V9.58 起它作为「锦上添花」档直接可记成交
  const nrRaw = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-buy-level]')]
    return JSON.stringify({
      card: Boolean(document.querySelector('[data-testid="bonus-card"]')),
      count: rows.length,
      levels: rows.map((el) => Number(el.getAttribute('data-buy-level'))),
      chip: rows.length > 0 && rows[0].textContent.includes('下一轮'),
      label: rows[0] ? (rows[0].querySelector('.t1')?.textContent.trim() ?? '') : '',
      exec: rows.some((el) => [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === '记成交')),
    })
  })()`)
  console.log('  下一轮应买:', nrRaw)
  const nr = JSON.parse(nrRaw)
  check('锦上添花卡存在', nr.card, nrRaw)
  check('卖完的老批次排出档位（≥5 档）', nr.count >= 5, String(nr.count))
  check('挂单页提供同价汇总成交入口', await evaluate(`Boolean(document.querySelector('[data-action="suggestion-buy"]'))`), nrRaw)
  check('档位行标「下一轮」并给出买价 × 股数', nr.chip && /买\s*[\d.]+\s*×\s*[\d,]+/.test(nr.label), nr.label)
  check('还没回补完的行不重复提示（R60-63 不在其中）', ![60, 61, 62, 63].some((r) => nr.levels.includes(r)), JSON.stringify(nr.levels))
  check('下一轮档可直接记成交（V9.58 起锦上添花档即建议行）', nr.exec, nrRaw)

  // 点下一轮行 → 明细要落在那一笔「已完成」的行上（V9.47 修：深链不能被默认隐藏干掉）
  const deepRow = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="bonus-card"] [data-buy-level]')
    if (!el) return null
    el.click(); return el.getAttribute('data-buy-level')
  })()`)
  await sleep(700)
  check('点下一轮行跳明细', deepRow !== null, String(deepRow))
  check('深链命中已完成那一行（不被隐藏）', (await headCount()) === 1, String(await headCount()))
  check('清空筛选收尾', await clickByText('[data-testid="active-chips"] .filter-chip', '清空筛选'))
  await sleep(400)
  await nav('orders')
  await sleep(700)

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

  console.log('\n[8.1.1] 跳明细往返：昨收与区间保留（V9.28 起昨收存 localStorage 跨会话）')
  await nav('trades')
  await nav('orders')
  const keptUp = await evaluate(`document.querySelector('[data-tag="limit-up"]')?.textContent.trim() ?? ''`)
  check('返回后区间还在（涨停 8.91）', keptUp.includes('8.91'), keptUp)
  check('返回后输入框还留着昨收 8.10', (await evaluate(`document.querySelector('input[aria-label="昨收价"]')?.value ?? ''`)) === '8.10')
  check('返回后不用重新确认就可用', (await bodyText()).includes('应该买入'))

  console.log('\n[8.1.2] 下滑收成一行摘要，回顶恢复完整设置')
  const fullH = Number(await evaluate(`document.querySelector('[data-sticky="orders"]')?.getBoundingClientRect().height ?? 0`))
  check(
    '顶部时显示完整设置',
    await evaluate(
      `Boolean(document.querySelector('input[aria-label="昨收价"]')) &&
       !document.querySelector('[data-sticky="orders"]').classList.contains('is-compact')`,
    ),
  )
  await evaluate(`window.scrollTo(0, 900)`)
  await sleep(700)
  const compactRaw = await evaluate(`(() => {
    const bar = document.querySelector('[data-testid="orders-compact"]')
    const sticky = document.querySelector('[data-sticky="orders"]')
    const setup = document.querySelector('.orders-setup')
    const barStyle = bar ? getComputedStyle(bar) : null
    return JSON.stringify({
      exists: Boolean(bar),
      text: bar?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      compact: sticky ? sticky.classList.contains('is-compact') : null,
      barVisible: barStyle ? Number(barStyle.opacity) > 0.9 && barStyle.visibility !== 'hidden' : false,
      setupHidden: setup ? getComputedStyle(setup).visibility === 'hidden' : null,
      position: sticky ? getComputedStyle(sticky).position : 'missing',
      h: Math.round(sticky?.getBoundingClientRect().height ?? 0),
      y: Math.round(window.scrollY),
    })
  })()`)
  const compactBar = JSON.parse(compactRaw)
  console.log('  收起后:', compactRaw)
  check('下滑后出现单行摘要', compactBar.exists && compactBar.compact === true && compactBar.y > 96, compactRaw)
  check('摘要可见（不是零高度占位）', compactBar.barVisible === true, compactRaw)
  check(
    '摘要含股票/昨收/涨停/跌停',
    ['柳工', '8.10', '8.91', '7.29'].every((s) => compactBar.text.includes(s)),
    compactRaw,
  )
  check('完整设置已隐藏', compactBar.setupHidden === true, compactRaw)
  check('收起后仍吸顶', compactBar.position === 'sticky', compactRaw)
  check('收起后高度明显变小', compactBar.h > 0 && compactBar.h < fullH / 2, `full=${fullH} compact=${compactBar.h}`)
  const compactShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-orders-compact.png'), Buffer.from(compactShot.data, 'base64'))
  check('点摘要回顶', await evaluate(`document.querySelector('[data-testid="orders-compact"]')?.click() ?? true`))
  await sleep(1400)
  const restoredRaw = await evaluate(`(() => {
    const setup = document.querySelector('.orders-setup')
    return JSON.stringify({
      y: Math.round(window.scrollY),
      compact: document.querySelector('[data-sticky="orders"]').classList.contains('is-compact'),
      setupShown: setup ? getComputedStyle(setup).visibility !== 'hidden' : false,
      input: document.querySelector('input[aria-label="昨收价"]')?.value ?? '',
    })
  })()`)
  const restoredTop = JSON.parse(restoredRaw)
  console.log('  回顶后:', restoredRaw)
  check('回到顶部恢复完整设置', restoredTop.y === 0 && !restoredTop.compact && restoredTop.setupShown, restoredRaw)
  check('恢复后昨收仍是 8.10', restoredTop.input === '8.10', restoredRaw)

  // V9.44：顶部收放不能来回抽搐——临界点附近小步滚动，最多收/放各一次，scrollY 不被浏览器补偿拉走
  const jitterRaw = await evaluate(`(async () => {
    const sticky = document.querySelector('[data-sticky="orders"]')
    let flips = 0
    let last = sticky.classList.contains('is-compact')
    const mo = new MutationObserver(() => {
      const cur = sticky.classList.contains('is-compact')
      if (cur !== last) { flips += 1; last = cur }
    })
    mo.observe(sticky, { attributes: true, attributeFilter: ['class'] })
    const at = (y) => new Promise((r) => setTimeout(r, y))
    for (let y = 0; y <= 300; y += 12) {
      window.scrollTo(0, y)
      await at(30)
    }
    await at(700)
    const landed = Math.round(window.scrollY)
    for (let y = 300; y >= 0; y -= 12) {
      window.scrollTo(0, y)
      await at(30)
    }
    await at(700)
    mo.disconnect()
    return JSON.stringify({ flips, landed, end: Math.round(window.scrollY), compact: sticky.classList.contains('is-compact') })
  })()`)
  const jitter = JSON.parse(jitterRaw)
  console.log('  收放抖动:', jitterRaw)
  check('临界点附近不反复收放（flips ≤ 3）', jitter.flips <= 3, jitterRaw)
  check('滚动位置没被补偿拉回（停在 300）', jitter.landed === 300, jitterRaw)
  check('回到顶部完全展开', jitter.end === 0 && !jitter.compact, jitterRaw)

  console.log('\n[8.1.3] 合并同价未卖完批次 → 挂单提醒合并显示（V9.45）')
  await nav('trades')
  await sleep(700)
  check(
    '打开柳工 9.61 的第一笔',
    await evaluate(`(() => {
      const el = document.querySelector('[data-row="16"]')
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click(); return true
    })()`),
  )
  await sleep(800)
  text = await bodyText()
  check('抽屉里有「合并同价买单」', text.includes('合并同价买单'))
  const candRaw = await evaluate(
    `JSON.stringify([...document.querySelectorAll('[data-merge-candidate]')].map(e => e.getAttribute('data-merge-candidate')))`,
  )
  const cand = JSON.parse(candRaw)
  check('候选列出两笔 9.61 批次', cand.includes('16') && cand.includes('22'), candRaw)
  check(
    '勾上第 22 笔',
    await evaluate(`(() => {
      const cb = document.querySelector('[data-merge-candidate="22"] input[type="checkbox"]')
      if (!cb) return false
      cb.click(); return true
    })()`),
  )
  await sleep(300)
  check(
    '保存合并',
    await evaluate(`(() => {
      const b = document.querySelector('[data-action="merge-save"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(1000)
  check('合并后出现「解除」', Boolean(await evaluate(`Boolean(document.querySelector('[data-action="merge-clear"]'))`)))
  const mergeShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-merge-binder.png'), Buffer.from(mergeShot.data, 'base64'))
  await closeDrawer()
  await nav('orders')
  await sleep(1000)
  // V9.58：区间外的合并行收进「区间外」折叠区，先展开再读（收起时 innerText 拿不到内容）
  const openOut = await evaluate(`(() => {
    const d = document.querySelector('[data-testid="sell-out"]')
    if (d && !d.open) d.open = true
    return Boolean(d)
  })()`)
  const mergedRaw = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll('.data-block')]
    const rows = blocks.flatMap((b) => [...b.querySelectorAll('.line[data-merge-group]')])
    const row = rows.find((l) => l.textContent.includes('10.68'))
    const same = [...document.querySelectorAll('.data-block .line')].filter((l) => l.textContent.includes('10.68'))
    return JSON.stringify({
      exists: Boolean(row),
      text: row?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      sameRows: same.length,
      stale: same.map((l) => l.getAttribute('data-merge-group') ?? ''),
    })
  })()`)
  const mergedRow = JSON.parse(mergedRaw)
  console.log('  合并后的待卖行:', mergedRaw)
  check('不同成本的10.68待卖自动合成一行', mergedRow.exists && mergedRow.sameRows === 1, mergedRaw)
  check('同一卖价的不同买入成本也自动合并', mergedRow.text.includes('1,600'), mergedRaw)
  check('合并行标「合并 3 笔」', mergedRow.text.includes('合并 3 笔'), mergedRaw)
  check('合并行日期取最早的 2026-03-16', mergedRow.text.includes('2026-03-16'), mergedRaw)
  check('合并行带 data-merge-group', mergedRow.stale.some((key)=>key.includes('sell:柳工:1068')), mergedRaw)
  const mergedShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-orders-merged.png'), Buffer.from(mergedShot.data, 'base64'))

  // 解除合并 → 挂单页恢复逐笔
  await nav('trades')
  await sleep(700)
  await evaluate(`document.querySelector('[data-row="16"]')?.click()`)
  await sleep(800)
  check(
    '解除合并',
    await evaluate(`(() => {
      const b = document.querySelector('[data-action="merge-clear"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(900)
  await closeDrawer()
  await nav('orders')
  await sleep(900)
  await evaluate(`(() => { const d = document.querySelector('[data-testid="sell-out"]'); if (d && !d.open) d.open = true })()`)
  const splitRaw = await evaluate(`(() => {
    const same = [...document.querySelectorAll('.data-block .line')].filter((l) => l.textContent.includes('10.68'))
    return JSON.stringify({
      n: same.length,
      merged: same.filter((l) => l.getAttribute('data-merge-group')).length,
      texts: same.map((l) => l.innerText.replace(/\\s+/g, ' ').trim()),
    })
  })()`)
  const split = JSON.parse(splitRaw)
  console.log('  解除后:', splitRaw)
  check('解除手工关联后仍按卖价自动汇总', split.n === 1 && split.merged === 1, splitRaw)
  check('解除手工关联不会改变1600股汇总量', split.texts.some((t)=>t.includes('1,600')), splitRaw)

  console.log('\n[8.2] 挂单改单（计划价量）')
  check('点第一个「改单」', await clickByText('[data-action="sell-plan"]', '改单'))
  await sleep(500)
  check('计划弹窗出现', (await bodyText()).includes('计划价只用于显示和导出'))
  const planDefaults = await evaluate(`({
    price: document.querySelector('input[data-field="planPrice"]').placeholder,
    qty: document.querySelector('input[data-field="planQty"]').placeholder,
  })`)
  await setInput('input[data-field="planPrice"]', ' ')
  await setInput('input[data-field="planQty"]', '')
  check('计划价量留空保存', await clickByText('button', '保存'))
  await sleep(700)
  const defaultPlan = (await readTable('plans')).find((p) => p.priceCents === Math.round(Number(planDefaults.price) * 100) && p.qty === Number(planDefaults.qty))
  check('计划实际采用默认价量', Boolean(defaultPlan), JSON.stringify(planDefaults))
  await clickByText('[data-action="sell-plan"]', '改单')
  await sleep(400)
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

  // V9.55：所有编辑弹层都不许改变页面滚动位置（库把 body 锁成 overflow:hidden 会把 scrollY 清零）
  await evaluate(`window.scrollTo(0, 600)`)
  await sleep(350)
  const planScrollBefore = await evaluate('window.scrollY')
  await clickByText('[data-action="sell-plan"]', '改单')
  await sleep(450)
  const planScrollOpen = await evaluate('window.scrollY')
  await clickByText('button', '取消')
  await sleep(900)
  const planScrollAfter = await evaluate('window.scrollY')
  console.log('  滚动:', { planScrollBefore, planScrollOpen, planScrollAfter })
  check('改单弹窗关掉后回到原来的滚动位置', planScrollBefore > 100 && Math.abs(planScrollAfter - planScrollBefore) <= 4, `${planScrollBefore} → ${planScrollAfter}`)
  await evaluate(`window.scrollTo(0, 0)`)
  await sleep(300)

  console.log('\n[8.5] 记回补成交 → 敞口减少 → 撤销')
  check('点第一笔回补的「记成交」', await clickByText('[data-action="rebuy-execution"]', '记成交'))
  await sleep(600)
  check('弹出记成交窗口', (await bodyText()).includes('本次回补股数'))
  check('默认股数已填', (await evaluate(`document.querySelector('input[data-field="execQty"]')?.value ?? ''`)) !== '')
  const execDefaults = await evaluate(`({
    qty: document.querySelector('input[data-field="execQty"]').placeholder,
    price: document.querySelector('input[data-field="execPrice"]').placeholder,
    reward: document.querySelector('input[data-field="execReward"]').placeholder,
  })`)
  for (const field of ['execQty', 'execPrice', 'execReward']) await setInput(`input[data-field="${field}"]`, ' ')
  check('点保存', await clickByText('button', '保存'))
  await sleep(1200)
  check('回补成交实际采用默认股数/价格/奖励', (await readTable('rebuyExecutions')).some((e) => e.qty === Number(execDefaults.qty) && e.priceCents === Math.round(Number(execDefaults.price) * 100) && e.rewardQty === Number(execDefaults.reward)))
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
  check('进入股票设置', await clickByText('[data-manage-entry="stocks"]', '股票设置'))
  await sleep(400)
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
  await clickByText('[data-manage-entry="stocks"]', '股票设置')
  await sleep(400)
  await evaluate(`document.querySelector('[aria-label="启用 奥佳华"]')?.click()`)
  await sleep(700)
  await nav('overview')
  check('重新启用后回到概览', (await bodyText()).includes('奥佳华'))

  console.log('\n[9.5] 价格轴：下沿 0 + 价签等比例间隔（V9.12）')
  await sleep(900)
  const axisInfo = await evaluate(`(() => {
    const t = document.querySelector('canvas[data-tree="price"]')?.__tree
    if (!t) return null
    t.zoomBy(0.0001)
    return JSON.stringify({ span: t.span(), center: t.center() })
  })()`)
  check('树画布可用', Boolean(axisInfo), '')
  const axis = JSON.parse(axisInfo ?? '{}')
  check('拉远后 span 到上限 150', axis.span === 150, JSON.stringify(axis))
  check('下沿不越过 0（股价永远为正）', axis.center >= axis.span / 2 - 1e-6, JSON.stringify(axis))

  // V9.31 格子进度条：缩小视图时必须还能数出「聚合了多少档」——格子数 + 格子后面的「+N」= 档数
  // 切到柳工（待买/待卖/已成交三类都有，格子才测得全）
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(800)
  const cellInfo = await evaluate(`(() => {
    const t = document.querySelector('canvas[data-tree="price"]').__tree
    const lv = t.levels()
    const cents = lv.map((l) => l.cents)
    // 把视野收到数据中段、跨度 ~18 元：这就是「视图缩小」的真实场景
    t.setView(18, (Math.min(...cents) + Math.max(...cents)) / 200)
    const b = t.bins()
    return JSON.stringify({
      bins: b,
      sellLevels: lv.filter((l) => l.sell > 0).length,
      buyLevels: lv.filter((l) => l.buy > 0).length,
      soldLevels: lv.filter((l) => l.sold > 0).length,
    })
  })()`)
  const cells = JSON.parse(cellInfo)
  const sumCount = (arr) => arr.reduce((a, x) => a + x.count, 0)
  console.log('  格子分档:', JSON.stringify({ sell: sumCount(cells.bins.sell), buy: sumCount(cells.bins.buy), sold: sumCount(cells.bins.sold) }))
  check('卖侧档数守恒（格子分档合起来 = 待卖档位数）', sumCount(cells.bins.sell) === cells.sellLevels, cellInfo)
  check('买侧档数守恒', sumCount(cells.bins.buy) === cells.buyLevels, cellInfo)
  check(
    '缩小时聚合成多档但每档都能数清（画 8 格以内 + 「+N」补齐）',
    [...cells.bins.sell, ...cells.bins.buy].every((b) => b.count > 0 && b.count - b.over >= 1 && b.count - b.over <= 8),
    cellInfo,
  )
  check(
    '已成交每档都带「共卖出几次」',
    cells.bins.sold.every((b) => b.times >= 1),
    cellInfo,
  )
  // 缩小后的样子留一张图（视觉回归用）
  await sleep(400)
  const zoomShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'tree-cells-zoomed.png'), Buffer.from(zoomShot.data, 'base64'))

  // V9.31 年份限制：默认「全部」；切到具体年份后整棵树照常出图（未来多年数据可切）
  const yearInit = await evaluate(`(() => {
    const sel = document.querySelector('[aria-label="已成交年份"]')
    const t = document.querySelector('canvas[data-tree="price"]').__tree
    return JSON.stringify({ has: Boolean(sel), year: t.year() })
  })()`)
  const yi = JSON.parse(yearInit)
  check('树上加了已成交年份筛选，默认全部', yi.has && yi.year === 'all', yearInit)
  check(
    '打开年份下拉',
    await evaluate(`(() => {
      const el = document.querySelector('[aria-label="已成交年份"]')
      if (!el) return false
      el.click(); return true
    })()`),
  )
  await sleep(400)
  check('选 2026 年', await clickByText('[role="option"]', '2026'))
  await sleep(700)
  const yearAfter = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({ year: c.__tree.year(), levels: c.__tree.levels().length })
  })()`)
  const ya = JSON.parse(yearAfter)
  check('年份切到 2026 且树照常出档位', ya.year === '2026' && ya.levels > 0, yearAfter)

  console.log('\n[10] 新增一笔：卖出（先卖后买）')
  await nav('trades')
  check('点「新增一笔」', await clickByText('button', '新增一笔'))
  await sleep(600)
  check('弹窗立即可见（无打字机）', (await bodyText()).includes('买入份额') || (await bodyText()).includes('卖出数量'))
  // V9.35：日期默认今天，不用每格都填
  const preDate = await evaluate(`document.querySelector('input[data-field="date"]')?.value ?? ''`)
  check('新增表单日期默认填今天', /^\d{4}-\d{2}-\d{2}$/.test(preDate), preDate)
  // V9.38 日期选择器：手输框旁有日历按钮，原生 date input 选完回填
  const pickerInfo = await evaluate(`(() => {
    const text = document.querySelector('input[data-field="date"]')
    const field = text?.closest('.date-field')
    const native = field?.querySelector('input[type="date"]')
    if (!text || !native) return null
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(native, '2026-10-21')
    native.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({
      button: Boolean(field.querySelector('.date-field-btn')),
      value: document.querySelector('input[data-field="date"]')?.value ?? '',
    })
  })()`)
  const pk = pickerInfo ? JSON.parse(pickerInfo) : null
  check('日期字段有日期选择器且选完回填', Boolean(pk?.button && pk.value === '2026-10-21'), pickerInfo ?? '')
  check('切到卖出', await clickByText('.type-toggle button', '卖出'))
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
  // V9.35：placeholder 直接把推导出来的回补价报出来，不用自己减间隔
  const rebuyPh = await evaluate(`document.querySelector('input[data-field="rebuyPrice"]')?.placeholder ?? ''`)
  check('回补价 placeholder 直接给出推导值 8.11', rebuyPh.includes('8.11'), rebuyPh)
  check('点保存', await clickByText('button', '保存'))
  await sleep(500)
  // V9.37：弹窗收起 → 新行弹入 + 微光（「弹窗收成一条明细」的落点）
  check(
    '新增后新行带进场动效',
    Boolean(await evaluate(`Boolean(document.querySelector('.trade-item[data-anim="new"]'))`)),
  )
  const newRowShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'trades-new-row.png'), Buffer.from(newRowShot.data, 'base64'))
  await sleep(800)
  await nav('overview')
  text = await bodyText()
  check('卖出后净持仓 12,700', text.includes('12,700'))
  check('卖出后敞口 2,500', text.includes('2,500'))

  // V9.30 裸卖待挂钩：行上标签点一下直接弹绑定面板（不必先开抽屉）
  await nav('trades')
  await sleep(600)
  // V9.37 切页方向：概览(0) → 明细(1) 是「往右走」，新页从右侧进来
  check(
    '切页带方向（概览→明细 = forward）',
    (await evaluate(`document.querySelector('.app-main')?.dataset.dir ?? ''`)) === 'forward',
  )
  text = await bodyText()
  check('裸卖行有「裸卖待挂钩」标签', text.includes('裸卖待挂钩'))
  check(
    '点「裸卖待挂钩」标签',
    await evaluate(`(() => {
      const el = document.querySelector('[data-hedge="100000"]')
      if (!el) return false
      el.click(); return true
    })()`),
  )
  await sleep(700)
  const sheetInfo = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input[data-field^="hedge-"]')]
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存挂钩')
    const wrap = document.querySelector('[class*="animal-modal-"]')
    const r = wrap ? wrap.getBoundingClientRect() : null
    const sr = save ? save.getBoundingClientRect() : null
    return JSON.stringify({
      cands: inputs.length,
      save: Boolean(save && save.offsetParent !== null),
      // V9.33：列表变高后「保存挂钩」曾被顶到可视区外，这条专门盯它
      saveInView: Boolean(sr && sr.top >= 0 && sr.bottom <= window.innerHeight - 2),
      title: document.body.textContent.includes('裸卖待挂钩'),
      box: r ? { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), vw: window.innerWidth } : null,
    })
  })()`)
  console.log('  挂钩弹层:', sheetInfo)
  const sheet = JSON.parse(sheetInfo)
  check('弹层里列出未完成买单', sheet.cands > 0, sheetInfo)
  check('弹层里有「保存挂钩」', sheet.save, sheetInfo)
  check('「保存挂钩」在可视区内（列表不把按钮顶出去）', sheet.saveInView, sheetInfo)
  check('弹层标题「裸卖待挂钩」', sheet.title, sheetInfo)
  check('弹层没超出视口宽度', Boolean(sheet.box && sheet.box.l >= 0 && sheet.box.r <= sheet.box.vw), sheetInfo)
  // V9.33 面板新增：自动挂满 / 允许挂不满 / 已分配提示
  const sheetTools = await evaluate(`JSON.stringify({
    auto: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '自动挂满'),
    partial: document.body.textContent.includes('必须挂满') || document.body.textContent.includes('允许挂不满'),
    assigned: /已分配\\s*[\\d,]+\\s*\\/\\s*[\\d,]+\\s*股/.test(document.body.textContent),
  })`)
  console.log('  挂钩面板工具:', sheetTools)
  const tools = JSON.parse(sheetTools)
  check('面板有「自动挂满」', tools.auto, sheetTools)
  check('面板有「挂满/挂不满」开关', tools.partial, sheetTools)
  check('面板有「已分配 x / y 股」', tools.assigned, sheetTools)
  // 留一张弹层截图（视觉回归/人工核对用）
  const sheetShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'hedge-sheet.png'), Buffer.from(sheetShot.data, 'base64'))
  check('点「关闭」收起弹层', await clickByText('button', '关闭'))
  await sleep(500)
  check('弹层已收起', (await evaluate(`document.querySelectorAll('input[data-field^="hedge-"]').length`)) === 0, '')

  // 回补价被自动推导出来，来源写在明细里
  await evaluate(`document.querySelector('[data-row="100000"]')?.click()`)
  await sleep(700)
  text = await bodyText()
  check('抽屉标出「回补价 = 卖出价 − 间隔」', text.includes('回补价 = 卖出价 − 间隔'))
  check('推导出的回补价 8.11', text.includes('8.11'))
  // V9.35：普通「编辑」不预填买入侧（免得只想改卖出侧却把买入写进台账）
  check('进编辑', await clickByText('button', '编辑'))
  await sleep(500)
  const plainEdit = await evaluate(`document.querySelector('input[data-field="buyPrice"]')?.value ?? 'X'`)
  check('普通编辑不预填买入价', plainEdit === '', plainEdit)
  check('取消编辑', await clickByText('button', '取消'))
  await sleep(400)
  // 点「补买入」：买入价=回补价、份额=卖出量、日期=今天，卖出侧保持原样
  check('点「补买入」', await clickByText('button', '补买入'))
  await sleep(500)
  const preEdit = await evaluate(`JSON.stringify({
    buyPrice: document.querySelector('input[data-field="buyPrice"]')?.value ?? '',
    buyQty: document.querySelector('input[data-field="buyQty"]')?.value ?? '',
    buyDate: document.querySelector('input[data-field="buyDate"]')?.value ?? '',
    target: document.querySelector('input[data-field="targetPrice"]')?.value ?? '',
    sold: document.querySelector('input[data-field="soldQty"]')?.value ?? '',
    day: new Date().toISOString().slice(0, 10),
  })`)
  const pe = JSON.parse(preEdit)
  check('编辑时买入价预填回补价 8.11', pe.buyPrice === '8.11', preEdit)
  check('编辑时买入份额 = 卖出量 500', pe.buyQty === '500', preEdit)
  check('编辑时卖出侧重卖价 8.68 / 份额 500', pe.target === '8.68' && pe.sold === '500', preEdit)
  check('编辑时买入日期默认今天', /^\d{4}-\d{2}-\d{2}$/.test(pe.buyDate), preEdit)
  check('取消编辑', await clickByText('button', '取消'))
  await sleep(400)

  // V9.26 先卖后买挂钩：裸卖 8.68×500 挂到未卖的高位批次上
  check(
    '抽屉里也有同一个挂钩面板',
    Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="hedge-section"] input[data-field^="hedge-"]'))`)),
  )
  const hedgeCands = await evaluate(`(() => {
    const sec = document.querySelector('[data-testid="hedge-section"]')
    if (!sec) return null
    const lines = [...sec.querySelectorAll('.line')]
    return JSON.stringify(
      lines
        .map((el) => {
          const input = el.querySelector('input')
          const m = el.textContent.match(/可挂\\s*([\\d,]+)/)
          return { field: input ? input.getAttribute('data-field') : null, avail: m ? Number(m[1].replace(/,/g, '')) : 0 }
        })
        .filter((c) => c.field && c.avail > 0),
    )
  })()`)
  const cands = hedgeCands ? JSON.parse(hedgeCands) : []
  check('有可挂的候选批次', cands.length > 0, hedgeCands ?? '')
  if (cands.length > 0) {
    // 贪心分配：候选批次可挂量依次填满 500 股
    let left = 500
    for (const c of cands) {
      if (left <= 0) break
      const q = Math.min(c.avail, left)
      await setInput(`input[data-field="${c.field}"]`, String(q))
      left -= q
      await sleep(150)
    }
    check('候选量够挂满 500 股', left === 0, `还差 ${left}`)
    check('点「保存挂钩」', await clickByText('button', '保存挂钩'))
    await sleep(900)
    await closeDrawer()
    await sleep(500)
    text = await bodyText()
    check('裸卖行标「已挂钩」', text.includes('已挂钩'))
    // 敞口回到 2,000（挂住的 500 由高位批次交割）；净持仓不变（没发生真实交易）
    await nav('overview')
    await sleep(900)
    text = await bodyText()
    check('挂钩后敞口 2,000', text.includes('2,000'), '')
    check('挂钩后净持仓 12,700', text.includes('12,700'), '')
    await clickByText('.stock-tabs > *', '柳工')
    await sleep(400)
    check(
      '未回补时概览已出现回本链',
      (await evaluate(`Boolean(document.querySelector('[data-testid="overview-chains"]'))`)),
    )
    // V9.30 挂单页待买行也有同一个入口（已挂的显示「已挂钩 · 改挂」）；V9.58 起在台账折叠区里，先展开
    await nav('orders')
    await sleep(900)
    await evaluate(`(() => { const d = document.querySelector('[data-testid="rebuy-ledger"]'); if (d && !d.open) d.open = true })()`)
    await sleep(200)
    text = await bodyText()
    check('挂单页待买行有「已挂钩 · 改挂」入口', text.includes('已挂钩 · 改挂'))
    check('挂单页标注「已挂高位，这张买单可撤」', text.includes('已挂高位，这张买单可撤'))

    // V9.36 回补 → 高位批次永久了结（不再复活），概览出现「回本链」
    const opened = await evaluate(`(() => {
      const line = [...document.querySelectorAll('.data-block .line')].find((l) => l.getAttribute('data-row') === '100000')
      const btn = line && [...line.querySelectorAll('button')].find((b) => b.textContent.trim() === '记成交')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    check('找到这笔裸卖的「记成交」', opened)
    if (opened) {
      await sleep(700)
      check('回补弹窗打开', (await bodyText()).includes('本次回补股数'))
      check('点保存回补', await clickByText('button', '保存'))
      await sleep(1400)
      await nav('overview')
      await sleep(1000)
      // 概览默认停在第一只股票，先点回柳工再看这条链
      await clickByText('.stock-tabs > *', '柳工')
      await sleep(700)
      text = await bodyText()
      check(
        '回补后概览出现回本链',
        Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="overview-chains"]'))`)),
      )
      check('回本链显示「后续净盈利」', text.includes('后续净盈利'))
      check('回本链给出「还差」金额', text.includes('还差'))
      check('未卖出时进度只算持仓', text.includes('当前持有'))
      const chainShot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(OUT, 'overview-chain.png'), Buffer.from(chainShot.data, 'base64'))
    }
  } else {
    await closeDrawer()
  }

  console.log('\n[11] 删掉这笔手动卖出，恢复原状')
  await nav('trades')
  await sleep(700)
  // V9.46：亏着清仓的锚点虽然「卖完了」，但还欠着回本，默认隐藏已成交时也要留在列表里
  text = await bodyText()
  check('明细里仍能看到「回本链 · 还差」那一行', text.includes('回本链 · 还差'))
  const listChainShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'trades-chain-list.png'), Buffer.from(listChainShot.data, 'base64'))

  // V9.46 归属面板：把一笔独立录入的低位买卖归进这条链，再由用户结束 / 重开
  const anchorRow = await clickChainRow('anchor', '柳工')
  check('打开高位批次那笔（回本链锚点）的抽屉', anchorRow !== null, String(anchorRow))
  if (anchorRow !== null) {
    await sleep(700)
    check(
      '锚点抽屉里有归属面板',
      Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="chain-binder"]'))`)),
    )
    // V9.57：人工归属收进「高级」折叠区，默认收起；先展开再勾选
    check(
      '手动归属默认收起',
      await evaluate(`document.querySelector('[data-testid="chain-manual"]')?.open === false`),
    )
    await evaluate(`document.querySelector('[data-testid="chain-manual"] summary')?.click()`)
    await sleep(300)
    check(
      '回本卡给出四个数字',
      await evaluate(`(() => {
        const c = document.querySelector('[data-testid="chain-section"] .chain-card')
        if (!c) return false
        const t = c.textContent
        return t.includes('原始亏损') && t.includes('后续净盈利') && t.includes('链累计盈亏') && t.includes('还差多少')
      })()`),
    )
    check(
      '显示当前持仓与计划买回',
      await evaluate(`(() => {
        const c = document.querySelector('[data-testid="chain-section"] .chain-card')
        if (!c) return false
        return /当前持有\\s*[\\d,]+\\s*股/.test(c.textContent)
      })()`),
    )
    const pickedRow = await evaluate(`(() => {
      const el = document.querySelector('[data-chain-candidate]')
      if (!el) return null
      const inp = el.querySelector('input')
      if (!inp) return null
      inp.click()
      return el.getAttribute('data-chain-candidate')
    })()`)
    check('归属面板列出候选买入批次', pickedRow !== null, String(pickedRow))
    if (pickedRow !== null) {
      check('点「保存归属」', await clickByText('button', '保存归属'))
      await sleep(1200)
      check(
        '归属后卡片仍在（那笔盈亏进链）',
        Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="chain-binder"]'))`)),
      )
      const memberMark = await evaluate(`document.querySelectorAll('[data-row="${pickedRow}"][data-chain="member"]').length`)
      check('被归属的那笔标成链成员', memberMark === 1, String(memberMark))
      // 取消勾选再保存 = 退回独立交易（后面还要按原口径断言，这里恢复原状）
      await evaluate(`document.querySelector('[data-chain-candidate="${pickedRow}"] input')?.click()`)
      await sleep(500)
      check('点「保存归属」撤销', await clickByText('button', '保存归属'))
      await sleep(1200)
      check(
        '撤销后那笔不再是链成员',
        (await evaluate(`document.querySelectorAll('[data-row="${pickedRow}"][data-chain="member"]').length`)) === 0,
      )
    }
    check('点「结束这条链」', await clickByText('button', '结束这条链'))
    await sleep(1300)
    await closeDrawer()
    await sleep(400)
    await nav('overview')
    await sleep(900)
    await clickByText('.stock-tabs > *', '柳工')
    await sleep(700)
    check(
      '概览把已结束的链折成一行提示',
      Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="overview-chains-closed"]'))`)),
    )
    // 重开，回到后续断言要的默认状态
    await nav('trades')
    await sleep(700)
    const reopened = await clickChainRow('anchor', '柳工')
    if (reopened !== null) {
      await sleep(700)
      check('点「重新打开」', await clickByText('button', '重新打开'))
      await sleep(1200)
      await closeDrawer()
      await sleep(400)
    }
  }

  await evaluate(`document.querySelector('[data-row="100000"]')?.click()`)
  await sleep(600)
  // V9.36：这笔裸卖自己身上也能看到它牵连的回本链（高位批次已了结、正在被低位回血）
  check(
    '裸卖抽屉里显示回本链',
    Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="chain-section"] .chain-card'))`)),
  )
  check('回本链带进度条', Boolean(await evaluate(`Boolean(document.querySelector('.chain-bar'))`)))
  const drawerChainShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'trades-chain-drawer.png'), Buffer.from(drawerChainShot.data, 'base64'))
  await evaluate(`window.confirm = () => true`)
  check('删除手动行', await clickByText('button', '删除'))
  await sleep(120)
  // V9.37：删除不是「啪」地消失——先向右滑出并收高度
  check(
    '删除时行带滑出动效',
    Boolean(await evaluate(`Boolean(document.querySelector('.trade-item[data-anim="leaving"]'))`)),
  )
  await sleep(900)
  await nav('overview')
  text = await bodyText()
  check('回到净持仓 13,200', text.includes('13,200'))
  check('概览无基准异常提示', !text.includes('去管理页看'))

  console.log('\n[11.1.1] 管理页 · 校验（V9.10 从概览挪来）')
  await nav('manage')
  check('切到校验入口', await clickByText('[data-manage-entry="checks"]', '校验'))
  await sleep(500)
  text = await bodyText()
  check('基准快照在管理页且全中', text.includes('基准快照') && text.includes('全中'))
  check('数量守恒在管理页', text.includes('数量守恒'))

  console.log('\n[11.2] 账户功能已删除（V9.32 单账户）')
  await backToManageMenu()
  await sleep(300)
  await nav('manage')
  text = await bodyText()
  check('管理页没有账户入口', !text.includes('账户'))
  check('顶部没有账户选择器', (await evaluate(`Boolean(document.querySelector('[aria-label="切换账户"]'))`)) === false)

  console.log('\n[11.5] 下拉浮层不出屏 / 不被卡片裁掉')
  /** 量当前打开的面板：四边都在视口内、命中测试落回面板 */
  const measurePanel = (selector) =>
    evaluate(`(() => {
      const d = document.querySelector(${JSON.stringify(selector)})
      if (!d) return null
      const r = d.getBoundingClientRect()
      const y = Math.min(Math.max(r.top + 24, 2), innerHeight - 2)
      const hit = document.elementFromPoint(r.left + r.width / 2, y)
      return JSON.stringify({
        inViewport:
          r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        hitIsOption: Boolean(hit && hit.closest(${JSON.stringify(selector)})),
        options: d.querySelectorAll('[role="option"]').length,
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })
    })()`)

  await nav('manage')
  await backToManageMenu()
  await sleep(300)
  await clickByText('[data-manage-entry="stocks"]', '股票设置')
  await sleep(500)
  check('打开涨跌幅下拉', await evaluate(`(() => {
    const box = document.querySelector('.app-main [role="combobox"]')
    if (!box) return false
    box.scrollIntoView({ block: 'center' })
    box.click(); return true
  })()`))
  await sleep(400)
  const ddRaw = await measurePanel('.app-select-panel')
  console.log('  涨跌幅下拉:', ddRaw)
  const dd = ddRaw ? JSON.parse(ddRaw) : null
  check('下拉存在且四边都在视口内', Boolean(dd?.inViewport), ddRaw ?? '')
  check('下拉没有被卡片裁掉（命中测试）', dd?.hitIsOption === true, ddRaw ?? '')
  const ddShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-dropdown.png'), Buffer.from(ddShot.data, 'base64'))
  await evaluate(`document.body.click()`)
  await sleep(300)

  // 用户反馈的场景：挂单页「选择股票」整行宽触发框
  await nav('orders')
  await sleep(600)
  check('打开挂单页股票下拉', await evaluate(`(() => {
    const box = document.querySelector('.app-main [role="combobox"]')
    if (!box) return false
    box.scrollIntoView({ block: 'center' })
    box.click(); return true
  })()`))
  await sleep(400)
  const stockDdRaw = await measurePanel('.app-select-panel')
  console.log('  股票下拉:', stockDdRaw)
  const stockDd = stockDdRaw ? JSON.parse(stockDdRaw) : null
  check('股票下拉完整落在视口内', Boolean(stockDd?.inViewport), stockDdRaw ?? '')
  check('股票下拉列出全部股票（≥4 项）', (stockDd?.options ?? 0) >= 4, stockDdRaw ?? '')
  const stockShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-stock-dropdown.png'), Buffer.from(stockShot.data, 'base64'))
  await evaluate(`document.body.click()`)
  await sleep(300)

  console.log('\n[11.8] 桌面全屏宽度：无横向滚动条')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${BASE}/#/overview` })
  await settle(2500)
  const ovf = await evaluate(`JSON.stringify({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`)
  check('1920 宽无横向溢出', JSON.parse(ovf).sw <= JSON.parse(ovf).iw, ovf)
  // V9.31 桌面宽度下的数轴格子（格子能排满 8 个，注记不压格子）——留一张图
  await sleep(600)
  const deskShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'tree-cells-desktop.png'), Buffer.from(deskShot.data, 'base64'))

  // V9.34 明细编辑抽屉：桌面下要和主内容列同宽（--app-max 560）并居中，不再铺满整屏
  await nav('trades')
  await sleep(800)
  await evaluate(`document.querySelector('.trade-item')?.click()`)
  await sleep(800)
  const drawerInfo = await evaluate(`(() => {
    const el = document.querySelector('.trades-edit-drawer')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right), vw: window.innerWidth })
  })()`)
  console.log('  桌面抽屉:', drawerInfo)
  const dw = drawerInfo ? JSON.parse(drawerInfo) : null
  check(
    '桌面下编辑抽屉与主内容列同宽（560）且居中',
    Boolean(dw && dw.w >= 520 && dw.w <= 562 && Math.abs(dw.l - (dw.vw - dw.w) / 2) <= 2),
    drawerInfo ?? '',
  )
  const deskDrawerShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'trades-drawer-desktop.png'), Buffer.from(deskDrawerShot.data, 'base64'))
  await evaluate(`document.querySelector('[aria-label="关闭"]')?.click()`)
  await sleep(500)

  // 还原移动端视口，让后面的截图保持 390 尺寸
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${BASE}/#/overview` })
  await settle(2000)

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
  writeFileSync(join(OUT, 'mobile-manage-menu.png'), Buffer.from(manageShot.data, 'base64'))
  await clickByText('[data-manage-entry="import"]', '导入数据')
  await sleep(500)
  const importShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-manage-import.png'), Buffer.from(importShot.data, 'base64'))
  await nav('trades')
  await evaluate(`document.querySelector('[data-row="63"]')?.click()`)
  await sleep(700)
  const drawerShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'mobile-drawer.png'), Buffer.from(drawerShot.data, 'base64'))
  await closeDrawer()
  console.log(`  截图已存 ${OUT}`)

  console.log('\n[12.5] 沙盒模式：模拟待买 → 挂钩预演 → 记为成交')
  await nav('orders')
  await sleep(800)
  check('挂单页有「沙盒」入口', Boolean(await evaluate(`Boolean(document.querySelector('[data-sandbox-toggle]'))`)))
  check(
    '打开沙盒',
    await evaluate(`(() => {
      const b = document.querySelector('[data-sandbox-toggle]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(600)
  const sbBaseRaw = await evaluate(`(() => {
    const q = (s) => document.querySelector(s)?.textContent.trim() ?? ''
    return JSON.stringify({
      panel: Boolean(document.querySelector('[data-testid="sandbox-panel"]')),
      profit: q('[data-sandbox-metric="profit"]'),
      max: q('[data-sandbox-metric="max"]'),
      expect: q('[data-sandbox-metric="expect"]'),
      count: q('[data-sandbox-metric="count"]'),
    })
  })()`)
  const sb0 = JSON.parse(sbBaseRaw)
  console.log('  沙盒基线:', sbBaseRaw)
  check('沙盒面板出现（与真实台账并排）', sb0.panel, sbBaseRaw)
  check('沙盒基线 · 已实现 +¥5,425.00', sb0.profit.includes('5,425.00'), sbBaseRaw)
  check('沙盒基线 · 理想可卖到 11.48 元', sb0.max.includes('11.48'), sbBaseRaw)
  check('沙盒基线 · 理想剩余可赚 +¥8,052.00', sb0.expect.includes('8,052.00'), sbBaseRaw)
  check('沙盒初始没有模拟条目', sb0.count === '0', sbBaseRaw)

  check(
    '待买区有「＋ 模拟待买」',
    Boolean(await evaluate(`Boolean(document.querySelector('[data-action="sandbox-add-sell"]'))`)),
  )
  await evaluate(`document.querySelector('[data-action="sandbox-add-sell"]')?.click()`)
  await sleep(500)
  const sbFormRaw = await evaluate(`(() => {
    const v = (f) => document.querySelector('input[data-field="' + f + '"]')?.value ?? null
    return JSON.stringify({
      title: document.body.innerText.includes('模拟一笔待买（先卖后买）'),
      date: v('sandboxDate'), price: v('sandboxPrice'), qty: v('sandboxQty'), extra: v('sandboxExtra'),
    })
  })()`)
  const sbf = JSON.parse(sbFormRaw)
  check('模拟待买弹窗打开', sbf.title, sbFormRaw)
  check('默认卖出价 = 昨收 8.10', sbf.price === '8.10', sbFormRaw)
  check('默认回补价 = 昨收 − 间隔 7.53', sbf.extra === '7.53', sbFormRaw)
  check('默认股数 100', sbf.qty === '100', sbFormRaw)
  check('默认日期为今天', /^\d{4}-\d{2}-\d{2}$/.test(sbf.date ?? ''), sbFormRaw)
  await setInput('input[data-field="sandboxPrice"]', '7.00')
  await setInput('input[data-field="sandboxQty"]', '500')
  await setInput('input[data-field="sandboxExtra"]', '6.50')
  check(
    '点「加到沙盒」',
    await evaluate(`(() => {
      const b = document.querySelector('[data-action="sandbox-save"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(800)
  await evaluate(`(() => {
    for (const sel of ['[data-testid="rebuy-ledger"]', '[data-testid="must-out"]']) {
      const d = document.querySelector(sel)
      if (d && !d.open) d.open = true
    }
  })()`)
  await sleep(150)
  const sbAddRaw = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="rebuy-ledger"] [data-sandbox-row="300001"]')
    const q = (s) => document.querySelector(s)?.textContent.trim() ?? ''
    return JSON.stringify({
      count: q('[data-sandbox-metric="count"]'),
      profit: q('[data-sandbox-metric="profit"]'),
      max: q('[data-sandbox-metric="max"]'),
      expect: q('[data-sandbox-metric="expect"]'),
      row: Boolean(row),
      rowText: row ? row.innerText : '',
      // Tag 不透传 data-*，用它会透传的 className 找入口
      hedgeTag: Boolean(row?.querySelector('.hedge-entry')),
      exposure: document.body.innerText.includes('待补敞口 2,500 股'),
    })
  })()`)
  const sb1 = JSON.parse(sbAddRaw)
  check('模拟条目计数 1', sb1.count === '1', sbAddRaw)
  check('模拟待买行出现（预览行 300001）', sb1.row, sbAddRaw)
  check('模拟行标「模拟 ·」且注明只预览', sb1.rowText.includes('模拟 ·') && sb1.rowText.includes('只用于沙盒预览'), sbAddRaw)
  check('模拟行有「模拟待挂钩」入口', sb1.hedgeTag, sbAddRaw)
  check('未挂时已实现 +¥5,675.00（+250 按 P 列）', sb1.profit.includes('5,675.00'), sbAddRaw)
  check('未挂时理想可卖到仍是 11.48', sb1.max.includes('11.48'), sbAddRaw)
  check('未挂时理想剩余可赚不变 +¥8,052.00', sb1.expect.includes('8,052.00'), sbAddRaw)
  check('未挂时敞口 2,500（模拟裸卖加空 500）', sb1.exposure, sbAddRaw)

  check('去概览看树', await clickByText('button', '去概览看树'))
  await sleep(1000)
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(700)
  const sbOvRaw = await evaluate(`(() => {
    const d = (k) => {
      const el = document.querySelector('[data-sandbox-delta="' + k + '"]')
      return el ? { was: el.querySelector('.was')?.textContent.trim(), now: el.querySelector('b')?.textContent.trim() } : null
    }
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({
      banner: Boolean(document.querySelector('[data-testid="sandbox-banner"]')),
      profit: d('profit'), max: d('max'), expect: d('expect'),
      ideal: c?.__tree?.ideal() ?? null,
    })
  })()`)
  const ov1 = JSON.parse(sbOvRaw)
  console.log('  未挂概览:', sbOvRaw)
  check('概览出现沙盒横幅（未写库）', ov1.banner, sbOvRaw)
  check('横幅差价 · 已实现 5,425 → 5,675', ov1.profit?.was.includes('5,425.00') && ov1.profit?.now.includes('5,675.00'), sbOvRaw)
  check('横幅差价 · 理想可卖到 11.48 不变', ov1.max?.was.includes('11.48') && ov1.max?.now.includes('11.48'), sbOvRaw)
  check('横幅差价 · 剩余可赚 8,052 不变', ov1.expect?.was.includes('8,052.00') && ov1.expect?.now.includes('8,052.00'), sbOvRaw)
  check('树上的理想可卖到仍是 11.48', ov1.ideal === 1148, sbOvRaw)

  check('回挂单页', await clickByText('button', '去挂单页调'))
  await sleep(900)
  await evaluate(`(() => {
    for (const sel of ['[data-testid="rebuy-ledger"]', '[data-testid="must-out"]']) {
      const d = document.querySelector(sel)
      if (d && !d.open) d.open = true
    }
  })()`)
  check(
    '点模拟行的「模拟待挂钩」',
    await evaluate(`(() => {
      const t = document.querySelector('[data-testid="rebuy-ledger"] [data-sandbox-row="300001"] .hedge-entry')
      if (!t) return false
      t.click(); return true
    })()`),
  )
  await sleep(600)
  const sbCandsRaw = await evaluate(`(() => {
    const sheet = document.querySelector('.hedge-modal') || document
    const inputs = [...sheet.querySelectorAll('input[data-field^="hedge-"]')]
    return JSON.stringify({
      title: (sheet.textContent || '').includes('沙盒挂钩预演'),
      intro: (sheet.textContent || '').includes('沙盒预演：'),
      first: inputs[0] ? inputs[0].getAttribute('data-field') : null,
      firstLine: inputs[0]?.closest('.line')?.innerText ?? '',
      all: inputs.map((i) => i.getAttribute('data-field')),
    })
  })()`)
  const sbc = JSON.parse(sbCandsRaw)
  check('打开沙盒挂钩预演弹层', sbc.title && sbc.intro, sbCandsRaw)
  check(
    '候选按买价从高到低（首项 = Excel 第 9 行 / 10.89 可挂 500）',
    sbc.first === 'hedge-9' && sbc.firstLine.includes('10.89') && sbc.firstLine.includes('可挂 500'),
    sbCandsRaw,
  )
  await setInput('input[data-field="hedge-9"]', '500')
  await sleep(300)
  check('点「保存挂钩」', await clickByText('button', '保存挂钩'))
  await sleep(1000)
  const sbHedgedRaw = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="rebuy-ledger"] [data-sandbox-row="300001"]')
    const q = (s) => document.querySelector(s)?.textContent.trim() ?? ''
    return JSON.stringify({
      tag: row?.querySelector('.hedge-entry')?.textContent.trim() ?? '',
      profit: q('[data-sandbox-metric="profit"]'),
      max: q('[data-sandbox-metric="max"]'),
      expect: q('[data-sandbox-metric="expect"]'),
      exposure: document.body.innerText.includes('待补敞口 2,000 股'),
    })
  })()`)
  const sbh = JSON.parse(sbHedgedRaw)
  console.log('  模拟挂钩后:', sbHedgedRaw)
  check('模拟行变成「模拟已挂钩 · 改挂」', sbh.tag.includes('模拟已挂钩'), sbHedgedRaw)
  check('挂钩后已实现 −¥1,945.00（5,425 − 1,945）', sbh.profit.includes('3,480.00'), sbHedgedRaw)
  check('挂钩后理想可卖到 11.38（最高批次退出待卖）', sbh.max.includes('11.38'), sbHedgedRaw)
  check('挂钩后剩余可赚 8,052 − 295 = 7,757', sbh.expect.includes('7,757.00'), sbHedgedRaw)
  check('挂钩后敞口回到 2,000', sbh.exposure, sbHedgedRaw)
  await sleep(2600) // 等轻提示消失再截图
  const sbOrdersShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(OUT, 'sandbox-orders.png'), Buffer.from(sbOrdersShot.data, 'base64'))

  check('去概览看挂钩效果', await clickByText('button', '去概览看树'))
  await sleep(1000)
  await clickByText('.stock-tabs > *', '柳工')
  await sleep(700)
  const sbOvHedgedRaw = await evaluate(`(() => {
    const d = (k) => {
      const el = document.querySelector('[data-sandbox-delta="' + k + '"]')
      return el ? { was: el.querySelector('.was')?.textContent.trim(), now: el.querySelector('b')?.textContent.trim() } : null
    }
    const c = document.querySelector('canvas[data-tree="price"]')
    return JSON.stringify({
      banner: Boolean(document.querySelector('[data-testid="sandbox-banner"]')),
      profit: d('profit'), max: d('max'), expect: d('expect'),
      ideal: c?.__tree?.ideal() ?? null,
    })
  })()`)
  const ov2 = JSON.parse(sbOvHedgedRaw)
  console.log('  挂钩后概览:', sbOvHedgedRaw)
  check('概览横幅 · 已实现 5,425 → 3,480', ov2.profit?.was.includes('5,425.00') && ov2.profit?.now.includes('3,480.00'), sbOvHedgedRaw)
  check('概览横幅 · 理想可卖到 11.48 → 11.38', ov2.max?.was.includes('11.48') && ov2.max?.now.includes('11.38'), sbOvHedgedRaw)
  check('概览横幅 · 剩余可赚 8,052 → 7,757', ov2.expect?.was.includes('8,052.00') && ov2.expect?.now.includes('7,757.00'), sbOvHedgedRaw)
  check('树上的理想可卖到变成 11.38', ov2.ideal === 1138, sbOvHedgedRaw)
  const sbOverviewShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'sandbox-overview.png'), Buffer.from(sbOverviewShot.data, 'base64'))

  check('回挂单页提交', await clickByText('button', '去挂单页调'))
  await sleep(900)
  check(
    '点模拟行的「记为成交」',
    await evaluate(`(() => {
      const row = document.querySelector('[data-sandbox-row="300001"]')
      const b = row?.querySelector('[data-action="sandbox-commit"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(1600)
  await evaluate(`(() => {
    for (const sel of ['[data-testid="rebuy-ledger"]', '[data-testid="must-out"]']) {
      const d = document.querySelector(sel)
      if (d && !d.open) d.open = true
    }
  })()`)
  await sleep(150)
  const sbCommitRaw = await evaluate(`(() => {
    const q = (s) => document.querySelector(s)?.textContent.trim() ?? ''
    return JSON.stringify({
      simRowLeft: Boolean(document.querySelector('[data-sandbox-row="300001"]')),
      count: q('[data-sandbox-metric="count"]'),
      profit: q('[data-sandbox-metric="profit"]'),
      max: q('[data-sandbox-metric="max"]'),
      expect: q('[data-sandbox-metric="expect"]'),
      realHedgeTag: document.body.innerText.includes('已挂钩 · 改挂'),
      note: document.body.innerText.includes('已挂高位，这张买单可撤'),
    })
  })()`)
  const sbc2 = JSON.parse(sbCommitRaw)
  console.log('  记为成交后:', sbCommitRaw)
  check('记为成交后模拟行消失', sbc2.simRowLeft === false, sbCommitRaw)
  check('模拟条目清空', sbc2.count === '0', sbCommitRaw)
  check('转正后真实待买行带「已挂钩 · 改挂」', sbc2.realHedgeTag, sbCommitRaw)
  check('转正后标注「已挂高位，这张买单可撤」', sbc2.note, sbCommitRaw)
  check('转正后已实现 = 3,480（不再是预览）', sbc2.profit.includes('3,480.00'), sbCommitRaw)
  check('转正后理想可卖到 11.38', sbc2.max.includes('11.38'), sbCommitRaw)
  check('转正后剩余可赚 7,757', sbc2.expect.includes('7,757.00'), sbCommitRaw)

  await nav('trades')
  await sleep(800)
  const sbTradeRaw = await evaluate(`(() => {
    const r = document.querySelector('[data-row="100001"]')
    return JSON.stringify({ exists: Boolean(r), text: r?.innerText ?? '' })
  })()`)
  const sbt = JSON.parse(sbTradeRaw)
  check('记为成交写进明细第 100001 行', sbt.exists, sbTradeRaw)
  check('第 100001 行是那笔 7.00 卖出且已挂钩', sbt.text.includes('7.00') && sbt.text.includes('已挂钩'), sbTradeRaw)

  // 清理：解除真实挂钩 → 删除这条手动行，回到基准
  await evaluate(`document.querySelector('[data-row="100001"]')?.click()`)
  await sleep(700)
  check(
    '抽屉里解除转正的挂钩',
    await evaluate(`(() => {
      const sec = document.querySelector('[data-testid="hedge-section"]')
      const b = sec && [...sec.querySelectorAll('button')].find((x) => x.textContent.trim() === '解除挂钩')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(900)
  await evaluate(`window.confirm = () => true`)
  check('删除第 100001 行', await clickByText('button', '删除'))
  await sleep(1200)

  check('重新打开挂单页', await nav('orders'))
  await sleep(800)
  const sbBackRaw = await evaluate(`(() => {
    const q = (s) => document.querySelector(s)?.textContent.trim() ?? ''
    return JSON.stringify({ profit: q('[data-sandbox-metric="profit"]'), max: q('[data-sandbox-metric="max"]') })
  })()`)
  const sbb = JSON.parse(sbBackRaw)
  check('清理后已实现回到 +¥5,425.00', sbb.profit.includes('5,425.00'), sbBackRaw)
  check('清理后理想可卖到回到 11.48', sbb.max.includes('11.48'), sbBackRaw)

  console.log('\n[12.6] 沙盒：模拟待卖 → 记为成交 → 刷新清空')
  check(
    '待卖区有「＋ 模拟待卖」',
    Boolean(await evaluate(`Boolean(document.querySelector('[data-action="sandbox-add-buy"]'))`)),
  )
  await evaluate(`document.querySelector('[data-action="sandbox-add-buy"]')?.click()`)
  await sleep(500)
  const sbBuyFormRaw = await evaluate(`(() => {
    const v = (f) => document.querySelector('input[data-field="' + f + '"]')?.value ?? null
    return JSON.stringify({
      title: document.body.innerText.includes('模拟一笔待卖（假设买入）'),
      price: v('sandboxPrice'), qty: v('sandboxQty'), extra: v('sandboxExtra'),
    })
  })()`)
  const sbbf = JSON.parse(sbBuyFormRaw)
  check('模拟待卖弹窗打开', sbbf.title, sbBuyFormRaw)
  check('默认买入价 = 昨收 8.10', sbbf.price === '8.10', sbBuyFormRaw)
  check('默认目标价 = 昨收 + 间隔 8.67', sbbf.extra === '8.67', sbBuyFormRaw)
  await setInput('input[data-field="sandboxPrice"]', '8.00')
  await setInput('input[data-field="sandboxQty"]', '100')
  await setInput('input[data-field="sandboxExtra"]', '8.50')
  check(
    '加模拟待卖',
    await evaluate(`(() => {
      const b = document.querySelector('[data-action="sandbox-save"]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(800)
  const sbBuyRaw = await evaluate(`(() => {
    const q = (s) => document.querySelector(s)?.textContent.trim() ?? ''
    return JSON.stringify({
      count: q('[data-sandbox-metric="count"]'),
      profit: q('[data-sandbox-metric="profit"]'),
      max: q('[data-sandbox-metric="max"]'),
      expect: q('[data-sandbox-metric="expect"]'),
      rows: document.querySelectorAll('[data-sandbox-row="300001"]').length,
    })
  })()`)
  const sbb2 = JSON.parse(sbBuyRaw)
  check('模拟待卖计数 1', sbb2.count === '1', sbBuyRaw)
  check('模拟待卖出现在待卖/今日挂单', sbb2.rows >= 1, sbBuyRaw)
  check('模拟待卖不改已实现', sbb2.profit.includes('5,425.00'), sbBuyRaw)
  check('模拟待卖挂高理想可卖到不变 11.48', sbb2.max.includes('11.48'), sbBuyRaw)
  check('模拟待卖使剩余可赚 +50 → 8,102', sbb2.expect.includes('8,102.00'), sbBuyRaw)
  check(
    '模拟待卖「记为成交」',
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-sandbox-row="300001"] [data-action="sandbox-commit"]')].pop()
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(1500)
  await nav('trades')
  await sleep(800)
  const sbBuyTradeRaw = await evaluate(`(() => {
    const r = document.querySelector('[data-row="100002"]')
    return JSON.stringify({ exists: Boolean(r), text: r?.innerText ?? '' })
  })()`)
  const sbbt = JSON.parse(sbBuyTradeRaw)
  check('模拟待卖记为成交写进第 100002 行', sbbt.exists, sbBuyTradeRaw)
  check('第 100002 行是 8.00 买入 / 8.50 目标', sbbt.text.includes('8.00') && sbbt.text.includes('8.50'), sbBuyTradeRaw)
  await evaluate(`document.querySelector('[data-row="100002"]')?.click()`)
  await sleep(700)
  await evaluate(`window.confirm = () => true`)
  check('删除第 100002 行', await clickByText('button', '删除'))
  await sleep(1200)

  console.log('\n[12.7] 沙盒只活在内存：刷新即清空')
  await nav('orders')
  await sleep(800)
  check(
    '退出沙盒',
    await evaluate(`(() => {
      const b = document.querySelector('[data-sandbox-toggle]')
      if (!b) return false
      b.click(); return true
    })()`),
  )
  await sleep(500)
  check(
    '退出后沙盒面板消失',
    !(await evaluate(`Boolean(document.querySelector('[data-testid="sandbox-panel"]'))`)),
  )
  check(
    '重新打开沙盒并加一条模拟待买',
    await evaluate(`(() => {
      const t = document.querySelector('[data-sandbox-toggle]')
      if (!t) return false
      t.click()
      return true
    })()`),
  )
  await sleep(400)
  await evaluate(`document.querySelector('[data-action="sandbox-add-sell"]')?.click()`)
  await sleep(400)
  for (const field of ['sandboxDate', 'sandboxPrice', 'sandboxQty', 'sandboxExtra']) await setInput(`input[data-field="${field}"]`, ' ')
  await sleep(200)
  await evaluate(`document.querySelector('[data-action="sandbox-save"]')?.click()`)
  await sleep(600)
  check('刷新前有模拟行', Boolean(await evaluate(`Boolean(document.querySelector('[data-sandbox-row]'))`)))
  const blankSandbox = await evaluate(`document.querySelector('[data-sandbox-row]')?.textContent ?? ''`)
  check('沙盒留空采用昨收与100股并推导回补价', blankSandbox.includes('7.53') && blankSandbox.includes('100'), blankSandbox)
  await send('Page.reload', { ignoreCache: true })
  await settle(3000)
  await sleep(500)
  check('刷新后模拟行全部消失', !(await evaluate(`Boolean(document.querySelector('[data-sandbox-row]'))`)))
  check('刷新后沙盒默认关闭', !(await evaluate(`Boolean(document.querySelector('[data-testid="sandbox-panel"]'))`)))
  // V9.41 全局 header 已删：净持仓 13,200 现在只在概览的合计卡里
  await nav('overview')
  check('刷新后净持仓仍是 13,200（模拟没写库）', (await bodyText()).includes('13,200'))

  console.log('\n[12.8] 新增弹窗留空采用默认值，检查实际落库')
  await nav('trades')
  await clickByText('button', '新增一笔')
  await sleep(400)
  await evaluate(`[...document.querySelectorAll('[role="combobox"]')].pop()?.click()`)
  await sleep(200)
  await clickByText('[role="option"]', '柳工')
  await sleep(200)
  const blankBuyDefaults = await evaluate(`({
    date: document.querySelector('input[data-field="date"]').placeholder,
    target: document.querySelector('input[data-field="targetPrice"]').placeholder,
  })`)
  for (const field of ['date', 'price', 'qty', 'targetPrice']) await setInput(`input[data-field="${field}"]`, ' ')
  await clickByText('button', '保存')
  await sleep(700)
  let manualRows = (await readTable('records')).filter((r) => r.origin === 'manual' && !r.deletedAt).sort((a, b) => b.sourceRow - a.sourceRow)
  const defaultBuy = manualRows[0]
  check('新增买入留空实际写入8.01元700股', defaultBuy?.buyPriceCents === 801 && defaultBuy?.buyQtyRaw === 700 && defaultBuy?.stockName === '柳工', JSON.stringify(defaultBuy))
  check('日期留空实际采用当天，目标价留空仍由间隔推导', defaultBuy?.buyDateSerial === Math.round((Date.parse(blankBuyDefaults.date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000) && defaultBuy?.targetNeedsDerive === true && blankBuyDefaults.target === '8.58')
  await evaluate(`document.querySelector('[data-row="${defaultBuy.sourceRow}"]')?.click()`)
  await sleep(400)
  await clickByText('button', '编辑')
  await sleep(200)
  await setInput('input[data-field="buyDate"]', '')
  await clickByText('button', '保存')
  await sleep(400)
  check('普通编辑清空日期仍保存为空', (await readTable('records')).find((r) => r.sourceRow === defaultBuy.sourceRow)?.buyDateSerial === null)
  await closeDrawer()

  await clickByText('button', '新增一笔')
  await sleep(300)
  await clickByText('.type-toggle button', '卖出')
  await sleep(200)
  await evaluate(`[...document.querySelectorAll('[role="combobox"]')].pop()?.click()`)
  await sleep(200)
  await clickByText('[role="option"]', '柳工')
  await sleep(200)
  for (const field of ['date', 'price', 'qty', 'rebuyPrice']) await setInput(`input[data-field="${field}"]`, '')
  await clickByText('button', '保存')
  await sleep(600)
  manualRows = (await readTable('records')).filter((r) => r.origin === 'manual' && !r.deletedAt).sort((a, b) => b.sourceRow - a.sourceRow)
  const defaultSell = manualRows[0]
  check('新增卖出留空实际写入8.58元700股和8.01回补价', defaultSell?.targetPriceCents === 858 && defaultSell?.soldQty === 700 && defaultSell?.earlyBuyPriceCents === 801, JSON.stringify(defaultSell))
  check('可选买入全部留空不会产生买入批次', defaultSell?.buyPriceCents === null && defaultSell?.buyQtyRaw === null && defaultSell?.buyDateSerial === null)

  await clickByText('button', '新增一笔')
  await sleep(300)
  const rowCountBeforeInvalid = (await readTable('records')).length
  await setInput('input[data-field="price"]', '0')
  await clickByText('button', '保存')
  await sleep(400)
  check('显式0不会被默认值替换落库', (await readTable('records')).length === rowCountBeforeInvalid && await evaluate(`Boolean(document.querySelector('input[data-field="price"]'))`))
  await clickByText('button', '取消')
  await sleep(300)

  await nav('manage')
  await clickByText('[data-manage-entry="stocks"]', '股票设置')
  await sleep(300)
  await clickByText('button', '新增股票')
  await sleep(300)
  await setInput('input[placeholder="填写与 Excel 一致的股票名称"]', '默认值测试股')
  await setInput('input[placeholder="0.57"]', ' ')
  await clickByText('button', '添加')
  await sleep(500)
  check('新增股票间隔留空实际写入0.57', (await readTable('stocks')).some((s) => s.name === '默认值测试股' && s.intervalCents === 57))

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

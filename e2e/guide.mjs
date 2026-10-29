/** 管理指南：移动阅读/检索/深链/历史/表格溢出/多股票隔离。
 * npm run dev 后：node e2e/guide.mjs http://127.0.0.1:5173
 * 生产离线检查：node e2e/guide.mjs http://127.0.0.1:4173 --offline
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9452
const OUT = join(process.cwd(), 'e2e/out/guide')
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
  await until(`!!document.querySelector('[data-manage-entry="guide"]')`)
  if (process.argv.includes('--offline')) {
    await run('navigator.serviceWorker.ready.then(()=>true)')
    // 首次安装的页面需再次导航才受新worker控制，指南组件此时尚未打开。
    await send('Page.reload')
    await until(`!!document.querySelector('[data-manage-entry="guide"]')`)
    await until(`'serviceWorker' in navigator && !!navigator.serviceWorker.controller`)
    await run('navigator.serviceWorker.ready')
    await send('Network.enable')
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  }
  await click('[data-manage-entry="guide"]')
  await until(`!!document.querySelector('[data-testid="manage-guide"]')`)
  if (process.argv.includes('--offline')) {
    check('未打开过指南时也可从预缓存离线载入正文', await run(`document.querySelectorAll('[data-guide-topic]').length===43`))
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }
  check('管理页有随应用保存的操作指南入口', await run(`location.hash.includes('section=guide')`))
  check('处理步骤完整收录43条，移动首屏无横向溢出', await run(`document.querySelectorAll('[data-guide-topic]').length===43 && document.documentElement.scrollWidth<=innerWidth`))
  await shot('home-mobile')
  await input('#guide-search', '回本 亏损')
  check('搜索同时匹配标题与正文，关键词高亮', await run(`document.querySelectorAll('[data-guide-topic]').length>0 && document.querySelectorAll('[data-guide-topic]').length<43 && !!document.querySelector('mark')`))
  const listHash = await run('location.hash')
  await click('[data-guide-topic="20"]')
  check('操作页给出步骤与500元未回本算例', (await text()).includes('链仍亏 500') && await run('scrollY===0'))
  await send('Page.reload')
  await until(`!!document.querySelector('[data-testid="guide-article"]')`)
  check('刷新保留当前问题和搜索条件', await run(`location.hash.includes('topic=20') && location.hash.includes('q=') && document.querySelector('#guide-article-title').textContent.includes('回本')`))
  await click('[data-testid="guide-back"]')
  await until(`!!document.querySelector('#guide-search')`)
  check('返回指南保留搜索结果', await run('location.hash') === listHash && await run(`document.querySelector('#guide-search').value==='回本 亏损'`))
  await click('[aria-label="清空指南搜索"]')
  await input('#guide-search', '不存在的超长关键词xyz')
  check('空结果给出明确反馈', (await text()).includes('没有找到匹配内容'))
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent==='查看全部').click()`)
  await pause(150)
  check('清空搜索与分类后URL不残留旧条件', await run(`document.querySelectorAll('[data-guide-topic]').length===43 && !location.hash.includes('q=')`))

  // 列表到文章再返回，恢复手机上原来的阅读位置。
  await run(`document.querySelector('[data-guide-topic="30"]').scrollIntoView({block:'center'})`)
  const savedY = await run('scrollY')
  await click('[data-guide-topic="30"]')
  await click('[data-testid="guide-back"]')
  await pause(200)
  check('文章返回恢复原列表滚动位置', Math.abs(await run('scrollY') - savedY) < 3)

  await run('window.scrollTo(0,0)')
  await click('[data-guide-mode="scenarios"]')
  check('场景核对完整收录108条', await run(`document.querySelectorAll('[data-guide-scenario]').length===108`))
  await click('[data-guide-scenario="058"]')
  check('场景把应有结果与本轮修复证据分开', (await text()).includes('应有结果') && (await text()).includes('已修复O02'))
  await run('history.back()')
  await until(`document.querySelectorAll('[data-guide-scenario]').length===108`)
  check('浏览器返回恢复场景列表', await run(`document.querySelector('[data-guide-mode="scenarios"]').getAttribute('aria-pressed')==='true'`))

  await run('window.scrollTo(0,0)')
  await click('[data-guide-mode="issues"]')
  check('注意事项有26项并明确本次修复状态', await run(`document.querySelectorAll('[data-guide-issue]').length===26 && document.querySelector('[data-guide-issue="O01"]').textContent.includes('本次已修复')`))
  await click('[data-guide-issue="C01"]')
  await until(`!!document.querySelector('#c01')`)
  check('问题深链直达对应段落，保留待修复结论', await run(`location.hash.includes('anchor=c01') && document.querySelector('#c01').getBoundingClientRect().top>=0 && document.querySelector('#c01').getBoundingClientRect().top<160`) && (await text()).includes('本次仍可复现，待修复'))
  await click('[data-testid="guide-back"]')
  await click('[data-guide-mode="documents"]')
  check('完整文档收录全部14篇本地指南与审计资料', await run(`document.querySelectorAll('[data-guide-doc]').length===14`))
  await click('[data-guide-doc="workbook"]')
  check('完整文档有目录和可读表格', await run(`!!document.querySelector('.guide-toc') && !!document.querySelector('.guide-table table')`) && (await text()).includes('整数分'))
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  await pause(150)
  check('320px窄屏长表格在独立容器滚动，不撑宽页面', await noOverflow() && await run(`[...document.querySelectorAll('.guide-table')].every(e=>e.clientWidth<=innerWidth && getComputedStyle(e).overflowX==='auto')`))
  await shot('workbook-320')
  const title = await run(`document.querySelector('#guide-article-title').textContent`)
  await click('.guide-toc > summary')
  await click('.guide-toc nav a:last-child')
  check('目录定位仍在同一篇文档内', await run(`document.querySelector('#guide-article-title').textContent`) === title && await run('location.hash.includes("anchor=")'))
  check('长文中返回入口保持可见，标题没有被遮住', await run(`(() => {const b=document.querySelector('[data-testid="guide-back"]').getBoundingClientRect();const anchor=new URLSearchParams(location.hash.split('?')[1]).get('anchor');return b.top>=0 && b.bottom<70 && document.getElementById(anchor).getBoundingClientRect().top>=b.bottom})()`))
  await click('[data-testid="guide-back"]')
  await click('[data-guide-doc="manual"]')
  await click('.guide-markdown a[href*="doc=guide"]')
  check('文档相对链接打开对应的应用内正文', await run(`location.hash.includes('doc=guide') && document.querySelector('#guide-article-title').textContent==='操作指南'`))

  // 使用普通导入UI装入两个股票的真实小样本，不碰用户浏览器数据。
  await nav('manage')
  await click('[data-manage-entry="import"]')
  const csv = join(profile, 'two-stocks.csv')
  writeFileSync(csv, '\uFEFF股票,日期,买入价,买入份额,目标售价,实现份数,卖出日期,提前卖的买价\n柳工,,,,7,500,2026-10-21,5\n三一重工,,,,8,600,2026-10-21,6\n')
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [csv] })
  await until(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='写入本地')`)
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='写入本地').click()`)
  await pause(700)
  await nav('orders')
  await click('[aria-label="选择股票"]')
  await run(`[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('柳工')).click()`)
  await pause(400)
  const multi = await run(`({rows:[...document.querySelectorAll('[data-testid="buy-suggestion"]')].map(e=>({row:e.dataset.row,price:e.dataset.price,text:e.innerText})),card:document.querySelector('[data-testid="must-buy-card"]').innerText})`)
  check('O01 当前柳工建议只含500股@5，不混三一重工600股@6', multi.rows.length === 1 && multi.rows[0].price === '500' && multi.card.includes('2,500.00'), multi)
  await run(`Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.guideCopied=value}},configurable:true})`)
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='复制').click()`)
  check('O01 复制清单不混入其它股票价量', await run(`window.guideCopied.includes('5.00 × 500') && !window.guideCopied.includes('6.00 × 600')`))
  await run(`window.guideCsv='';const original=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{blob.text().then(value=>window.guideCsv=value);return original(blob)}`)
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='CSV').click()`)
  await until(`!!window.guideCsv`)
  check('O01 挂单CSV只导出当前股票数量', await run(`window.guideCsv.includes('500') && !window.guideCsv.includes('600')`))
  await click('[data-action="suggestion-buy"]')
  check('O01 成交弹窗明确股票与实际500股默认值', await run(`(() => {const e=document.querySelector('[data-field="execQty"]');return e && (e.value||e.placeholder)==='500' && document.querySelector('.hint-block').textContent.includes('柳工')})()`))
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='取消').click()`)
  await pause(450)
  await input('[aria-label="昨收价"]', '5')
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认').click()`)
  await pause(200)
  await click('[data-sandbox-toggle]')
  check('O01 沙盒同样只显示当前股票买档', await run(`document.querySelector('[data-testid="must-buy-card"]').innerText.includes('2,500.00') && !document.querySelector('[data-testid="must-buy-card"]').innerText.includes('6.00')`))
  await click('[data-sandbox-toggle]')
  await run('window.scrollTo(0,0)')
  await click('[aria-label="选择股票"]')
  await run(`[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('三一重工')).click()`)
  await pause(400)
  check('O01 切股后显示三一重工600股@6，旧股票区间不串用', await run(`document.querySelectorAll('[data-testid="buy-suggestion"]').length===1 && document.querySelector('[data-testid="buy-suggestion"]').dataset.price==='600' && document.querySelector('[data-testid="must-buy-card"]').innerText.includes('3,600.00')`))

  if (process.argv.includes('--offline')) {
    await until(`'serviceWorker' in navigator && !!navigator.serviceWorker.controller`)
    await run('navigator.serviceWorker.ready')
    await send('Network.enable')
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    await send('Page.navigate', { url: BASE + '/#/manage?section=guide&doc=boundaries&anchor=c02' })
    await until(`!!document.querySelector('#c02')`)
    check('生产包离线重开可阅读完整指南与问题状态', (await text()).includes('第二代回补') && await noOverflow())
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }
  check('页面无运行时异常和React警告', problems.length === 0, problems)
  console.log(`\nGUIDE E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

/** 动效回归：真实页面/fixture、稳定滚动布局、摘要焦点、快切、展开收起、减少动态效果。
 * npm run dev 后：node e2e/motion.mjs http://127.0.0.1:5173
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9450
const OUT = join(process.cwd(), 'e2e/out/motion')
const executable = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-motion-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
let passed = 0
const problems = []
const results = {}
function check(label, condition, detail) {
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
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.text)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      problems.push(message.params.args.map(a => a.description ?? a.value).join(' '))
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  const run = async expression => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  const click = async selector => {
    check('存在操作入口 ' + selector, await run(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`))
  }
  const until = async expression => {
    for (let i = 0; i < 80; i++) { if (await run(expression)) return; await pause(100) }
    throw new Error('等待超时: ' + expression)
  }
  const nav = async page => {
    await click(`[data-nav="${page}"]`)
    await until(`location.hash.startsWith('#/${page}') && !document.documentElement.dataset.transition`)
    await pause(150)
  }
  const shot = async name => {
    const value = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name + '.png'), Buffer.from(value.data, 'base64'))
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Performance.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE + '/#/manage' })
  await until(`!!document.querySelector('[data-manage-entry="import"]')`)
  await click('[data-manage-entry="import"]')
  await until(`!!document.querySelector('input[type="file"]') && !document.documentElement.dataset.transition`)
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [join(process.cwd(), 'tests/fixtures/26年网格记录.xlsx')] })
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='写入本地')`)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='写入本地').click()`)
  await pause(1000)

  for (const page of ['trades', 'orders']) {
    await nav(page)
    const before = (await send('Performance.getMetrics')).metrics
    const data = await run(`(async () => {
      const header=document.querySelector('[data-sticky="${page}"]'),marker=header.nextElementSibling;
      const samples=[];const begin=performance.now();window.scrollTo(0,900);
      await new Promise(resolve=>{function frame(t){samples.push({y:scrollY,doc:document.documentElement.scrollHeight,h:header.offsetHeight,marker:marker.getBoundingClientRect().top+scrollY});if(t-begin<700)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)});
      const range=key=>Math.max(...samples.map(s=>s[key]))-Math.min(...samples.map(s=>s[key]));
      const summary=header.querySelector('[data-scroll-summary]'),expanded=header.querySelector('[data-scroll-expanded]');
      const rect=summary.getBoundingClientRect();
      return {heightRange:range('h'),docRange:range('doc'),markerRange:range('marker'),compact:header.dataset.compact,summaryTop:rect.top,summaryBottom:rect.bottom,summaryInert:summary.inert,expandedInert:expanded.inert,summaryOpacity:getComputedStyle(summary).opacity,y:scrollY};
    })()`)
    const after = (await send('Performance.getMetrics')).metrics
    const metric = name => (after.find(m => m.name === name)?.value ?? 0) - (before.find(m => m.name === name)?.value ?? 0)
    results[page] = { ...data, layoutCount: metric('LayoutCount'), layoutMs: Math.round(metric('LayoutDuration') * 1000) }
    check(page + ' 收放不改变文档与下方内容位置', data.heightRange === 0 && data.docRange === 0 && data.markerRange < 1, data)
    check(page + ' 摘要吸在顶部并可交互', data.compact === 'true' && data.summaryTop >= 0 && data.summaryBottom < 70 && !data.summaryInert && Number(data.summaryOpacity) > .99, data)
    check(page + ' 完整设置收起后不进入键盘焦点', data.expandedInert, data)
    await shot(page + '-compact')
    const jitter = await run(`(async()=>{
      const header=document.querySelector('[data-sticky="${page}"]');let flips=0,last=header.dataset.compact;
      const observer=new MutationObserver(()=>{if(header.dataset.compact!==last){flips++;last=header.dataset.compact}});observer.observe(header,{attributes:true,attributeFilter:['data-compact']});
      for(let y=900;y>=0;y-=20){window.scrollTo(0,y);await new Promise(r=>requestAnimationFrame(r))}
      for(let y=0;y<=300;y+=10){window.scrollTo(0,y);await new Promise(r=>requestAnimationFrame(r))}
      await new Promise(r=>setTimeout(r,300));observer.disconnect();return{flips,y:scrollY,compact:header.dataset.compact}
    })()`)
    check(page + ' 快速往返不抖动、不改写用户滚动位置', jitter.flips <= 2 && Math.abs(jitter.y - 300) <= 1, jitter)
    await click(`[data-testid="${page}-compact"]`)
    await until(`scrollY===0 && document.querySelector('[data-sticky="${page}"]').dataset.compact==='false'`)
    check(page + ' 回顶恢复设置与焦点', await run(`!document.querySelector('[data-sticky="${page}"] [data-scroll-expanded]').inert`))
  }

  // 原生details的开启、退出与快速反向；原有data-testid和程序化open语义保持可用。
  const detail = '[data-testid="rebuy-ledger"]'
  await run(`document.querySelector('${detail}').scrollIntoView({block:'center'})`)
  await pause(200)
  await click(detail + ' > summary')
  await until(`document.querySelector('${detail}').open && !document.querySelector('${detail}').hasAttribute('data-opening')`)
  check('台账展开后有可读内容', await run(`document.querySelector('${detail}').innerText.includes('撤销')`))
  await click(detail + ' > summary')
  await pause(60)
  await click(detail + ' > summary')
  await until(`document.querySelector('${detail}').open && !document.querySelector('${detail}').hasAttribute('data-opening')`)
  check('展开动画快速反向后无残留固定高度', await run(`document.querySelector('${detail}').style.height==='' && document.querySelector('${detail}').style.overflow===''`))
  await click(detail + ' > summary')
  await until(`!document.querySelector('${detail}').open`)

  // 滚入模块只展示一次；上滚不反复隐藏已有卡片。
  await nav('stats')
  check('屏幕下方模块准备首次展示', await run(`document.querySelectorAll('[data-reveal="pending"]').length>0`))
  await run(`document.querySelector('[data-testid="profit-trend"]').scrollIntoView({block:'center'})`)
  await pause(400)
  check('滚入的模块展示后保持可见', await run(`document.querySelector('[data-testid="profit-trend"]').dataset.reveal==='shown'`))
  await run('window.scrollTo(0,0)')
  await pause(150)
  check('滚回顶部不会重新隐藏已展示模块', await run(`document.querySelector('[data-testid="profit-trend"]').dataset.reveal==='shown'`))

  // 多次导航最后一次必须生效，不保留上一张页面，不跳回旧滚动位置。
  await run(`(async()=>{for(const page of ['orders','overview','manage','trades']){document.querySelector('[data-nav="'+page+'"]').click();await new Promise(r=>setTimeout(r,45))}})()`)
  await until(`!document.documentElement.dataset.transition && !!document.querySelector('[data-sticky="trades"]')`)
  check('快速连切最终落在明细、方向正确且回到顶部', await run(`location.hash==='#/trades' && document.querySelector('.app-main').dataset.dir==='back' && scrollY===0`))

  // 弹层锁定期间不把已收起摘要闪回；关闭后仍在原位置。
  await run('window.scrollTo(0,900)')
  await pause(250)
  await run(`document.querySelector('.trade-item').click()`)
  await pause(200)
  check('弹层打开时保留摘要状态', await run(`document.body.style.position==='fixed' && document.querySelector('[data-sticky="trades"]').dataset.compact==='true'`))
  await click('[aria-label="关闭"]')
  await until(`document.body.style.position!== 'fixed'`)
  await pause(450)
  check('弹层关闭后恢复原滚动位置', await run('Math.abs(scrollY-900)<=2'))

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await nav('orders')
  await run('window.scrollTo(0,900)')
  await pause(100)
  check('减少动态效果下摘要过渡瞬切', await run(`getComputedStyle(document.querySelector('[data-scroll-summary]')).transitionDuration.split(',').every(v=>parseFloat(v)===0)`))
  await click('[data-testid="orders-compact"]')
  await pause(50)
  check('减少动态效果下回顶无平滑滚动', await run('scrollY===0'))
  check('减少动态效果下无隐藏模块', await run(`[...document.querySelectorAll('[data-reveal="pending"]')].every(e=>getComputedStyle(e).opacity==='1')`))
  await shot('reduced-motion')

  // 不支持快照切换的浏览器仍立即提交导航与筛选动作。
  await send('Emulation.setEmulatedMedia', { features: [] })
  await run(`Object.defineProperty(document,'startViewTransition',{value:undefined,configurable:true})`)
  await nav('trades')
  await click('[data-action="hide-done"]')
  await pause(250)
  check('缺少View Transition时导航与筛选仍正常', await run(`location.hash.includes('showDone=1') && document.querySelectorAll('.trade-item').length===62 && !document.documentElement.dataset.transition`))
  await run(`delete document.startViewTransition`)

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await nav('orders')
  await run('window.scrollTo(0,900)')
  await pause(300)
  check('窗口尺寸变化后摘要位置仍正确且无横向溢出', await run(`(() => {const h=document.querySelector('[data-sticky="orders"]'),r=h.querySelector('[data-scroll-summary]').getBoundingClientRect();return h.dataset.compact==='true' && r.top>=0 && r.bottom<70 && document.documentElement.scrollWidth<=innerWidth})()`))

  // 由键盘触发的原生summary也经过同一套展开动画。
  await send('Page.bringToFront')
  await run(`document.querySelector('${detail} > summary').focus()`)
  await pause(100)
  const focus = await run(`({focused:document.activeElement===document.querySelector('${detail} > summary'),pageFocus:document.hasFocus(),open:document.querySelector('${detail}').open})`)
  check('键盘操作前summary持有焦点', focus.focused && focus.pageFocus && !focus.open, focus)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector('${detail}').open && !document.querySelector('${detail}').hasAttribute('data-opening')`)
  check('键盘展开保留焦点与原生open语义', await run(`document.activeElement===document.querySelector('${detail} > summary') && document.querySelector('${detail}').style.height===''`))
  check('无运行时异常或React警告', problems.length === 0, problems)
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, results }, null, 2))
  console.log(`\nMOTION E2E PASS (${passed})`)
} finally {
  socket?.close()
  browser.kill()
  await pause(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

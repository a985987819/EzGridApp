/** PWA 安装入口：真实管理页 + 可控浏览器事件。不是系统安装弹窗/真机验收。
 * node e2e/pwaInstall.mjs http://127.0.0.1:5184 [--baseline]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = 9475
const OUT = join(process.cwd(), 'e2e', 'out', 'pwa-install')
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path))
assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
let occupied = false
try { occupied = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok } catch { /* unused port */ }
assert(!occupied, `调试端口 ${PORT} 已占用`)
mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'grid-pwa-install-'))
const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const problems = []
let socket, passed = 0
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
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
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
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 120; i++) { if (await run(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('等待超时: ' + expression + '\n页面状态: ' + JSON.stringify(await run('({hash:location.hash,text:document.body.innerText.slice(0,1000)})')) + '\n运行时异常: ' + JSON.stringify(problems))
  }
  const click = async selector => {
    assert(await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '缺少元素 ' + selector)
    await pause(250)
    await until(`!document.documentElement.dataset.transition`)
  }
  const shot = async name => {
    await run('window.scrollTo({top:0,behavior:"instant"})')
    await pause(300)
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const installed = () => run(`document.querySelector('[data-testid=pwa-install]')?.dataset.installed==='1'`)
  const panelText = () => run(`document.querySelector('[data-testid=pwa-install]')?.innerText??''`)
  const trustedClick = async selector => {
    const point = await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    assert(point, '缺少元素 ' + selector)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pause(150)
  }
  let initScript, scenarioNo = 0
  const openScenario = async (config = {}) => {
    if (initScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript })
    const source = `(()=>{
      const config=${JSON.stringify(config)}
      if(config.ua)Object.defineProperty(navigator,'userAgent',{configurable:true,value:config.ua})
      if(config.platform)Object.defineProperty(navigator,'platform',{configurable:true,value:config.platform})
      if(config.touch!==undefined)Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:config.touch})
      Object.defineProperty(navigator,'standalone',{configurable:true,value:config.iosStandalone===true})
      const nativeMatchMedia=window.matchMedia.bind(window),media=new EventTarget()
      media.matches=config.standalone===true;media.media='(display-mode: standalone)';media.onchange=null
      media.addListener=listener=>media.addEventListener('change',listener);media.removeListener=listener=>media.removeEventListener('change',listener)
      window.matchMedia=query=>query.includes('display-mode: standalone')?media:nativeMatchMedia(query)
      window.installFixture={calls:[],events:[],media,fire(mode='pending'){
        let resolveChoice,rejectChoice
        const choice=new Promise((resolve,reject)=>{resolveChoice=resolve;rejectChoice=reject})
        const event=new Event('beforeinstallprompt',{cancelable:true})
        event.userChoice=choice
        event.prompt=()=>{this.calls.push({mode,active:navigator.userActivation?.isActive===true});if(mode==='throw')throw new Error('fixture synchronous prompt rejection');if(mode==='reject')return Promise.reject(new Error('fixture async prompt rejection'));return Promise.resolve()}
        this.current={event,resolve:outcome=>resolveChoice({outcome,platform:'web'}),reject:()=>rejectChoice(new Error('fixture choice rejection'))};this.events.push(this.current)
        return !window.dispatchEvent(event)
      },choose(outcome){this.current.resolve(outcome)},setStandalone(value){media.matches=value;media.dispatchEvent(new Event('change'))}}
    })()`
    initScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier
    await send('Page.navigate', { url: BASE + '/?pwa-e2e=' + (++scenarioNo) + '#/overview' })
    await until(`document.querySelector('[data-nav=overview][aria-current=page]')&&window.installFixture`)
    await until(`!document.documentElement.dataset.transition`)
  }
  const openManage = async () => {
    await click('[data-nav=manage]')
    await until(`document.querySelector('[data-testid=pwa-install]')`)
  }
  const facts = () => run(`(async()=>{const {db}=await import('/src/store/db.ts');const result={};for(const table of db.tables)result[table.name]=await table.toArray();return JSON.stringify(result)})()`)
  const waitOutcome = async outcome => until(`document.querySelector('[data-testid=pwa-install]')?.dataset.outcome===${JSON.stringify(outcome)}`)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: BASE + '/#/manage' })
  await until(`document.querySelector('[data-testid=manage-menu]')`)

  if (process.argv.includes('--baseline')) {
    check('复现：管理页缺少显式PWA安装按钮', await run(`!document.querySelector('[data-testid=pwa-install]')&&!document.querySelector('[data-action=install-app]')`))
    console.log('\nPWA INSTALL BASELINE REPRODUCED')
  } else {
    await openScenario()
    await openManage()
    const originalFacts = await facts()
    check('管理页始终提供明确的安装按钮，不依赖浏览器自动弹出横幅', await run(`!!document.querySelector('[data-action=install-app]')&&!document.querySelector('[data-action=install-app]').disabled`))
    check('安装卡独立展示，原有八个管理入口保留', await run(`document.querySelectorAll('[data-testid=manage-menu] [data-manage-entry]').length===8`))
    check('安装方法初始折叠，主按钮仍直接可见', await run(`document.querySelector('[data-testid=pwa-install-help]')?.open===false`))
    await click('[data-action=install-app]')
    check('无安装事件时点击入口展开手动安装指引，不让按钮失效', await run(`document.querySelector('[data-testid=pwa-install-help]')?.open===true&&!document.querySelector('[data-action=install-app]').disabled`))
    check('桌面指引包含浏览器菜单/安装操作', /Chrome|Edge/.test(await panelText()) && /菜单|安装/.test(await panelText()))
    check('390px安装入口与指引无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
    await shot('install-entry-390')

    await openScenario()
    check('在概览页就能捕获并保存安装事件，打开管理页前已阻止默认丢失', await run(`installFixture.fire()`))
    await openManage()
    check('较早收到的安装事件在管理页可用', await run(`document.querySelector('[data-testid=pwa-install]').dataset.canPrompt==='1'`))
    await trustedClick('[data-action=install-app]')
    check('点击后同步唤起安装提示并保留用户手势', await run(`installFixture.calls.length===1&&installFixture.calls[0].active`), await run('installFixture.calls'))
    check('安装提示等待期间按钮禁用防止重复调用', await run(`document.querySelector('[data-action=install-app]').disabled`))
    await run(`document.querySelector('[data-action=install-app]').click();document.querySelector('[data-action=install-app]').click()`)
    check('连续点击不会重复消费同一安装事件', await run(`installFixture.calls.length===1`))
    await run(`installFixture.choose('accepted')`)
    await waitOutcome('accepted')
    check('接受安装只显示等待完成，不提前声称已安装', !await installed() && /等待|确认|完成/.test(await panelText()), await panelText())
    await run(`window.dispatchEvent(new Event('appinstalled'))`)
    await until(`document.querySelector('[data-testid=pwa-install]').dataset.installed==='1'`)
    check('收到appinstalled后才显示已安装并禁止重复安装', await installed() && await run(`document.querySelector('[data-action=install-app]').disabled`) && /已安装/.test(await panelText()))

    await openScenario()
    await run(`installFixture.fire()`)
    await openManage()
    await trustedClick('[data-action=install-app]')
    await run(`installFixture.choose('dismissed')`)
    await waitOutcome('dismissed')
    check('取消安装保留可操作入口并展开人工安装途径', !await installed() && await run(`!document.querySelector('[data-action=install-app]').disabled&&document.querySelector('[data-testid=pwa-install-help]')?.open===true`) && /取消/.test(await panelText()))
    await click('[data-action=install-app]')
    check('一次性事件用过后不会再次调用原prompt', await run(`installFixture.calls.length===1`))

    for (const mode of ['throw', 'reject']) {
      await run(`installFixture.fire(${JSON.stringify(mode)})`)
      await trustedClick('[data-action=install-app]')
      await waitOutcome('error')
      check(`${mode==='throw'?'同步抛错':'异步拒绝'}后恢复按钮并回落手动指引`, !await installed() && await run(`!document.querySelector('[data-action=install-app]').disabled&&document.querySelector('[data-testid=pwa-install-help]')?.open===true`))
    }
    await run(`installFixture.fire()`)
    await trustedClick('[data-action=install-app]')
    await run(`installFixture.choose('accepted')`)
    await waitOutcome('accepted')
    check('安装提示失败后收到新事件仍能再次尝试', await run(`installFixture.calls.length===4`) && !await installed())

    await openScenario()
    await run(`installFixture.fire()`)
    await openManage()
    await trustedClick('[data-action=install-app]')
    await run(`window.dispatchEvent(new Event('appinstalled'));installFixture.choose('dismissed')`)
    await until(`document.querySelector('[data-testid=pwa-install]').dataset.installed==='1'`)
    await pause(200)
    check('较晚返回的取消结果不覆盖已确认安装状态', await installed() && await run(`document.querySelector('[data-testid=pwa-install]').dataset.outcome!=='dismissed'`))

    await openScenario()
    await openManage()
    await run(`installFixture.setStandalone(true)`)
    await until(`document.querySelector('[data-testid=pwa-install]').dataset.installed==='1'`)
    check('窗口进入独立显示模式后及时更新已安装状态', await installed() && await run(`document.querySelector('[data-action=install-app]').disabled`))

    await openScenario({ standalone: true })
    await openManage()
    check('独立应用显示已安装状态，不重复提示安装', await installed() && await run(`document.querySelector('[data-action=install-app]').disabled`))

    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    await openScenario({ ua: iphone, platform: 'iPhone', touch: 5, iosStandalone: true })
    await openManage()
    check('iOS主屏幕独立运行标识同样识别为已安装', await installed() && await run(`document.querySelector('[data-action=install-app]').disabled`))
    await openScenario({ ua: iphone, platform: 'iPhone', touch: 5 })
    await openManage()
    await click('[data-action=install-app]')
    check('iPhone无安装弹窗时展开Safari分享添加到主屏幕步骤', await run(`document.querySelector('[data-testid=pwa-install-help]')?.open===true&&document.querySelector('[data-testid=pwa-install-help]').dataset.platform==='ios'`) && /Safari/.test(await panelText()) && /分享/.test(await panelText()) && /添加到主屏幕/.test(await panelText()), await panelText())
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1100, deviceScaleFactor: 1, mobile: true })
    check('320px安装说明和按钮无横向溢出', await run('document.documentElement.scrollWidth<=innerWidth'))
    await shot('install-ios-help-320')

    await openScenario({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', touch: 5 })
    await openManage()
    await click('[data-action=install-app]')
    check('安卓无安装事件时展开浏览器菜单安装入口', await run(`document.querySelector('[data-testid=pwa-install-help]')?.open===true&&document.querySelector('[data-testid=pwa-install-help]').dataset.platform==='android'`) && /菜单/.test(await panelText()) && /安装应用|添加到主屏幕/.test(await panelText()), await panelText())
    await openScenario({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', platform: 'MacIntel', touch: 0 })
    await openManage()
    await click('[data-action=install-app]')
    check('macOS Safari展开添加到程序坞的手动操作', await run(`document.querySelector('[data-testid=pwa-install-help]')?.open===true&&document.querySelector('[data-testid=pwa-install-help]').dataset.platform==='mac-safari'`) && /Safari/.test(await panelText()) && /文件/.test(await panelText()) && /程序坞/.test(await panelText()), await panelText())
    await openScenario({ ua: iphone + ' MicroMessenger/8.0.50', platform: 'iPhone', touch: 5 })
    await openManage()
    await click('[data-action=install-app]')
    check('内置浏览器提示转到外部浏览器，避免误称可直接安装', await run(`document.querySelector('[data-testid=pwa-install-help]')?.open===true&&document.querySelector('[data-testid=pwa-install-help]').dataset.platform==='embedded'`) && /在浏览器中打开/.test(await panelText()), await panelText())
    check('手动安装指引保留当前网站地址供复制', await run(`(()=>{const input=document.querySelector('input[aria-label="安装网站地址"]');return input?.readOnly&&input.value===location.origin+${JSON.stringify(new URL(BASE).pathname.replace(/\/?$/, '/'))}})()`))
    check('安装提示和指南不会新增或修改本地台账表', await facts() === originalFacts)
    check('无浏览器运行时异常或React警告', problems.length === 0, problems)
    console.log(`\nPWA INSTALL E2E PASS (${passed})`)
  }
} finally {
  socket?.close()
  browser.kill()
  const absoluteProfile = resolve(profile)
  assert(absoluteProfile.startsWith(resolve(tmpdir()) + sep) && basename(absoluteProfile).startsWith('grid-pwa-install-'), '只清理本次独立浏览器临时目录')
  try { rmSync(absoluteProfile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

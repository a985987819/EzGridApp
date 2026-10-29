/** Builds two real production releases and switches the server while old tabs stay open.
 * node e2e/updates.mjs  (does not use or modify a user's browser or ledger)
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd(), OUT = join(ROOT, 'e2e/out/updates'), RELEASES = join(ROOT, '.tmp/update-releases')
mkdirSync(OUT, { recursive: true })
mkdirSync(RELEASES, { recursive: true })
for (const release of ['a', 'b']) {
  const log = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(RELEASES, release)], {
    cwd: ROOT, env: { ...process.env, GITHUB_PAGES: 'true', EZGRID_BUILD_ID: release === 'a' ? 'a100000000000001' : 'b200000000000002' }, encoding: 'utf8', timeout: 90_000,
  })
  writeFileSync(join(OUT, `build-${release}.log`), (log.stdout ?? '') + (log.stderr ?? ''))
  assert.equal(log.status, 0, `生产包${release}构建失败：${log.stderr}`)
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let version = 'a', versionFailure = false, manifestOverride = null
const requests = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  requests.push(url.pathname + url.search)
  if (url.pathname === '/unrelated/sw.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('self.addEventListener("install",()=>self.skipWaiting());'); return }
  if (!url.pathname.startsWith('/EzGridApp/')) { res.writeHead(404).end(); return }
  let name = decodeURIComponent(url.pathname.slice('/EzGridApp/'.length)) || 'index.html'
  if (name.includes('..')) { res.writeHead(400).end(); return }
  if (name === 'version.json' && versionFailure) { res.writeHead(503).end('not ready'); return }
  if (name === 'version.json' && manifestOverride) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(manifestOverride)); return }
  const file = resolve(RELEASES, version, name)
  if (!existsSync(file)) { res.writeHead(404).end(); return }
  const types = { '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' }
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'public,max-age=3600')
  res.end(readFileSync(file))
})
await new Promise(resolve => server.listen(4187, '127.0.0.1', resolve))
const BASE = 'http://127.0.0.1:4187/EzGridApp/'
const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => file && existsSync(file))
assert(executable, '需要Chrome/Edge')
const profile = mkdtempSync(join(tmpdir(), 'grid-updates-'))
const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=9462', `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const sockets = [], problems = []
let passed = 0
const check = (name, value, detail) => { assert(value, name + (detail ? ': ' + JSON.stringify(detail) : '')); passed++; console.log('  PASS ' + name) }
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:9462/json/version')).ok) break } catch { /* starting */ } await pause(100) }
  const page = async url => {
    const target = await (await fetch(`http://127.0.0.1:9462/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    const socket = new WebSocket(target.webSocketDebuggerUrl); sockets.push(socket)
    await new Promise(resolve => socket.addEventListener('open', resolve))
    let id = 0; const pending = new Map()
    socket.addEventListener('message', ({ data }) => {
      const m = JSON.parse(data)
      if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })) })
    const run = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
    const until = async (expression, timeout = 15_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { if (await run(expression)) return } catch { /* navigation */ } await pause(100) } console.log(await run('document.body.innerText')); console.log(requests.slice(-12)); throw Error('等待超时: ' + expression) }
    const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(100) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    return { send, run, until, click, id: target.id }
  }
  const p = await page(BASE + '#/manage?section=updates')
  await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`)
  await p.run('navigator.serviceWorker.ready.then(()=>true)')
  await p.send('Page.reload'); await p.until(`navigator.serviceWorker.controller && document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`)
  check('A版显示固定当前版本并联网确认最新', await p.run(`document.querySelector('[data-testid=app-updates]').dataset.buildId==='a100000000000001'&&document.body.innerText.includes('已是最新版本')`))
  await p.run(`(async()=>{const r=await navigator.serviceWorker.register('/unrelated/sw.js',{scope:'/unrelated/'});await new Promise(resolve=>{if(r.active)return resolve();r.installing.addEventListener('statechange',()=>{if(r.active)resolve()})});localStorage.setItem('ledger-preference-sentinel','keep');await new Promise((resolve,reject)=>{const request=indexedDB.open('grid-trading');request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['meta','records'],'readwrite');tx.objectStore('meta').put({key:'update-sentinel',value:'saved-ledger'});tx.objectStore('records').add({sourceRow:42,stockName:'柳工',buyDateSerial:46000,buyPriceCents:500,buyQtyRaw:300,qtyNeedsDerive:false,targetPriceCents:700,targetNeedsDerive:false,soldQty:null,sellDateSerial:null,earlyBuyPriceCents:null,rawProfitCents:null,importKey:'update-preserved-trade'});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject}})})()`)
  const other = await page(BASE + '#/manage?section=updates')
  await other.until(`document.querySelector('[data-testid=app-updates]')?.dataset.buildId==='a100000000000001'`)
  await other.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`)
  await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'&&!document.querySelector('[data-action=check-version]').disabled`)
  await other.run(`window.unsavedMarker='keep-my-form';window.initialNavigationCount=performance.getEntriesByType('navigation').length`)
  version = 'b'
  await p.send('Page.bringToFront')
  await p.click('[data-action=check-version]'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='available'`)
  check('只检查发现B版，A版页面保持运行且不自动刷新', await p.run(`document.querySelector('[data-testid=app-updates]').dataset.buildId==='a100000000000001'&&document.body.innerText.includes('有新版可用')`))
  check('version.json检查附独立查询参数绕过固定URL缓存', requests.filter(url => url.includes('/version.json?check=')).length >= 2)
  await p.click('[data-action=apply-update]')
  await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.buildId==='b200000000000002'`, 55_000)
  await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`)
  check('另有旧标签时一次点击成功接管到B版', await p.run(`document.querySelector('[data-testid=update-result]')?.textContent.includes('更新成功')`))
  check('更新后保留管理页面深链并清理临时URL参数', await p.run(`location.hash==='#/manage?section=updates'&&!location.search.includes('_ezupdate')`))
  check('另一个页面没有被强制刷新，未保存内容保留', await other.run(`window.unsavedMarker==='keep-my-form'&&document.querySelector('[data-testid=app-updates]').dataset.buildId==='a100000000000001'`))
  await other.send('Page.bringToFront')
  await other.click('[data-testid=manage-back]'); await other.click('[data-manage-entry=guide]')
  await other.until(`!!document.querySelector('[data-testid=manage-guide]')`)
  check('旧页面切入尚未打开过的指南仍可加载，不因更新丢资源', await other.run(`window.unsavedMarker==='keep-my-form'`))
  await p.send('Page.bringToFront')
  check('已保存台账与偏好保留', await p.run(`(async()=>{const value=await new Promise(resolve=>{const r=indexedDB.open('grid-trading');r.onsuccess=()=>{const db=r.result;const q=db.transaction('meta').objectStore('meta').get('update-sentinel');q.onsuccess=()=>{db.close();resolve(q.result?.value)}}});return value==='saved-ledger'&&localStorage.getItem('ledger-preference-sentinel')==='keep'})()`))
  check('真实交易记录经过更新仍有原身份和300股库存', await p.run(`(async()=>new Promise(resolve=>{const r=indexedDB.open('grid-trading');r.onsuccess=()=>{const db=r.result;const q=db.transaction('records').objectStore('records').get(42);q.onsuccess=()=>{const row=q.result;db.close();resolve(row?.importKey==='update-preserved-trade'&&row.buyQtyRaw===300&&row.buyPriceCents===500)}}}))()`))
  check('同源其他应用的Service Worker保持注册', await p.run(`navigator.serviceWorker.getRegistration('/unrelated/').then(r=>!!r)`))
  await p.click('[data-action=force-update]'); await p.until(`document.querySelector('[data-testid=update-result]')?.textContent.includes('刷新完成')`, 55_000)
  check('已经最新时强制刷新也有明确完成回执', await p.run(`document.querySelector('[data-testid=app-updates]').dataset.buildId==='b200000000000002'`))
  await p.run(`sessionStorage.setItem('ezgrid-update:/EzGridApp/',JSON.stringify({from:'a100000000000001',target:'c300000000000003',at:Date.now()}))`)
  await p.send('Page.reload'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`)
  check('刷新实际未达到目标版本时明确提示，不假报成功', await p.run(`document.querySelector('[data-testid=update-result]')?.textContent.includes('尚未切换到目标版本')`))
  manifestOverride = { ...JSON.parse(readFileSync(join(RELEASES, 'b/version.json'), 'utf8')), buildId: 'c300000000000003' }
  await p.click('[data-action=force-update]'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='error'`, 55_000)
  check('版本号先发布但对应资源尚未发布时不假报更新成功', await p.run(`document.querySelector('[data-testid=app-updates]').dataset.buildId==='b200000000000002'&&document.body.innerText.includes('更新未完成')&&!document.querySelector('[data-testid=update-result]')`))
  manifestOverride = null
  versionFailure = true
  await p.click('[data-action=check-version]'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='error'`)
  check('版本服务失败明确未知，不能用历史缓存冒充最新', await p.run(`!document.body.innerText.includes('已是最新版本')&&document.body.innerText.includes('503')&&document.body.innerText.includes('上次查到的版本')`))
  await p.send('Network.enable'); await p.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await p.click('[data-action=force-update]'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='error'`)
  check('离线强制更新不刷新、不假报成功', await p.run(`document.querySelector('[data-testid=app-updates]').dataset.buildId==='b200000000000002'&&document.body.innerText.includes('更新未完成')`))
  await p.send('Page.reload'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='error'`)
  check('离线重开应用仍可用且不会声称最新', await p.run(`document.body.innerText.includes('尚未确认最新')&&document.body.innerText.includes('上次查到的版本')`))
  await p.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); versionFailure = false
  await p.click('[data-action=check-version]'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`)
  check('联网重试恢复准确最新状态', true)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  check('320px版本比较与更新按钮无横向溢出', await p.run('document.documentElement.scrollWidth<=innerWidth'))
  const shot = await p.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'updates-320.png'), Buffer.from(shot.data, 'base64'))
  version = 'a'
  await p.click('[data-action=force-update]'); await p.until(`document.querySelector('[data-testid=app-updates]')?.dataset.buildId==='a100000000000001'&&document.querySelector('[data-testid=app-updates]')?.dataset.phase==='current'`, 55_000)
  check('线上回滚发布时按实际发布构建号切换，不按时间猜新旧', await p.run(`document.querySelector('[data-testid=update-result]')?.textContent.includes('更新成功')`))
  check('没有运行时异常', problems.length === 0, problems)
  console.log(`\nUPDATES E2E PASS (${passed})`)
} finally {
  sockets.forEach(socket => socket.close()); browser.kill(); server.close(); await pause(150)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser releasing files */ }
}

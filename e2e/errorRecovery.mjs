/** Real page failures: failed chunk, render exception, explicit retry and backup. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openBrowser, pause } from './lib/browser.mjs'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const OUT = resolve('e2e/out/error-recovery')
mkdirSync(OUT, { recursive: true })
const browser = await openBrowser({ name: 'grid-error-recovery' })
const { send, evaluate, until } = browser
let passed = 0, failedNetwork = false, failedGuide = false, interceptedRender = false
const protocolProblems = [], runtimeProblems = []
const check = (label, condition) => { assert(condition, label); passed++; console.log('  PASS ' + label) }
const click = async selector => {
  assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '找不到 ' + selector)
  await pause(150)
  await until('!document.documentElement.dataset.transition')
}
const snapshot = () => evaluate(`(async()=>{
  const {db}=await import('/src/store/db.ts');const result={};
  for(const table of db.tables)if(table.name!=='meta')result[table.name]=await table.toArray();
  return JSON.stringify(result)
})()`)

browser.onEvent(message => {
  if (message.method === 'Runtime.exceptionThrown') runtimeProblems.push(message.params.exceptionDetails.text)
  if (message.method !== 'Fetch.requestPaused') return
  const { requestId, request } = message.params
  const respond = async () => {
    if (request.url.includes('/src/pages/StatsPage.tsx') && !failedNetwork) {
      failedNetwork = true
      await send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
    } else if (request.url.includes('/src/pages/manage/ManageGuide.tsx') && !failedGuide) {
      failedGuide = true
      await send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
    } else if (request.url.includes('/src/pages/OrdersPage.tsx')) {
      interceptedRender = true
      const code = 'export function OrdersPage(){if(!window.__allowPageRender)throw new Error("E2E_PAGE_RENDER_FAILURE");return "页面重试已恢复"}'
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: Buffer.from(code).toString('base64') })
    } else await send('Fetch.continueRequest', { requestId })
  }
  void respond().catch(error => protocolProblems.push(error.message))
})

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Fetch.enable', { patterns: [
    { urlPattern: '*/src/pages/StatsPage.tsx*', requestStage: 'Request' },
    { urlPattern: '*/src/pages/OrdersPage.tsx*', requestStage: 'Request' },
    { urlPattern: '*/src/pages/manage/ManageGuide.tsx*', requestStage: 'Request' },
  ] })
  await send('Page.navigate', { url: BASE + '/#/manage?section=import' })
  await until("document.querySelector('#import-file-input')")
  const csv = join(OUT, 'recovery-seed.csv')
  writeFileSync(csv, '\uFEFF股票,买入日期,买入价,买入份额,目标售价\n柳工,2026-02-28,5,100,7\n')
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#import-file-input' })
  await send('DOM.setFileInputFiles', { nodeId, files: [csv] })
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='写入本地'&&!b.disabled)")
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='写入本地').click()")
  await until("(async()=>{const {db}=await import('/src/store/db.ts');return (await db.records.count())===1})()")
  await evaluate("document.querySelectorAll('[data-animal-notification-root] button[aria-label=close]').forEach(button=>button.click())")
  await until("!document.querySelector('[data-animal-notification-root] [data-notification-key]')")
  const before = await snapshot()
  await evaluate('window.__pageVisitSentinel="kept"')

  await click('[data-nav=stats]')
  await until("document.querySelector('[data-testid=page-error]')")
  check('真实懒加载下载失败进入可恢复提示', failedNetwork)
  check('失败页面保留五个导航和直接备份入口', await evaluate("document.querySelectorAll('.app-nav [data-nav]').length===5&&!!document.querySelector('[data-action=error-backup]')"))
  check('失败后不自动刷新或修改交易数据', await evaluate('window.__pageVisitSentinel==="kept"') && await snapshot() === before)
  await click('[data-action=retry-page]')
  await until("!document.querySelector('[data-testid=page-error]')&&document.querySelector('.page-title h2')?.textContent==='统计'")
  check('用户重试重新加载失败模块并恢复统计页', await evaluate('window.__pageVisitSentinel==="kept"'))

  await click('[data-nav=orders]')
  await until("document.querySelector('[data-testid=page-error]')")
  check('页面渲染异常被同一页面兜底接住', interceptedRender)
  check('渲染失败后其它导航仍可使用', await evaluate("!document.querySelector('[data-nav=manage]').disabled"))
  const downloads = join(browser.profile, 'downloads')
  mkdirSync(downloads)
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await click('[data-action=error-backup]')
  const deadline = Date.now() + 10_000
  let backupFile
  while (Date.now() < deadline) {
    backupFile = readdirSync(downloads).find(file => file.endsWith('.json'))
    if (backupFile) break
    await pause(100)
  }
  assert(backupFile, '异常界面未生成备份文件')
  const backup = JSON.parse(readFileSync(join(downloads, backupFile), 'utf8').replace(/^\uFEFF/, ''))
  check('异常界面直接导出含原记录的有效JSON备份', backup.schemaVersion === 14 && backup.records.length === 1 && backup.records[0].buyQtyRaw === 100)
  check('导出备份后原交易和关联没有变化', await snapshot() === before)
  await evaluate('window.__allowPageRender=true')
  await click('[data-action=retry-page]')
  await until("!document.querySelector('[data-testid=page-error]')&&document.body.textContent.includes('页面重试已恢复')")
  check('页面渲染条件恢复后可显式重试', await evaluate('window.__pageVisitSentinel==="kept"'))

  await click('[data-nav=overview]')
  await evaluate('window.__allowPageRender=false')
  await click('[data-nav=orders]')
  await until("document.querySelector('[data-testid=page-error]')")
  await click('[data-testid=page-error] a[href="#/manage?section=updates"]')
  await until("!document.querySelector('[data-testid=page-error]')&&document.querySelector('[data-testid=app-updates]')")
  check('错误提示的版本入口可直接离开异常页面', await evaluate('window.__pageVisitSentinel==="kept"'))
  runtimeProblems.length = 0
  await click('[data-nav=manage]')
  await until("document.querySelector('[data-testid=manage-menu]')")
  check('切换页面清除错误状态并保留台账', await snapshot() === before)
  await click('[data-manage-entry=guide]')
  await until("document.querySelector('[data-testid=page-error]')")
  check('管理页内嵌指南的下载失败也进入页面兜底', failedGuide)
  await click('[data-action=retry-page]')
  await until("!document.querySelector('[data-testid=page-error]')&&document.querySelector('[data-testid=manage-guide]')")
  check('显式重试可重新下载嵌套指南模块', await evaluate('window.__pageVisitSentinel==="kept"'))
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  await click('[data-nav=orders]')
  await until("document.querySelector('[data-testid=page-error]')")
  check('320像素异常提示和操作没有横向溢出', await evaluate('document.documentElement.scrollWidth<=innerWidth'))
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'page-error-320.png'), Buffer.from(screenshot.data, 'base64'))
  await click('[data-nav=manage]')
  await until("document.querySelector('[data-testid=manage-menu]')")
  runtimeProblems.length = 0
  await pause(300)
  check('恢复后的页面没有额外运行时或协议错误', runtimeProblems.length === 0 && protocolProblems.length === 0)
  console.log(`\nERROR RECOVERY E2E PASS (${passed} checks)`)
} catch (error) {
  try {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, 'failure.png'), Buffer.from(screenshot.data, 'base64'))
    writeFileSync(join(OUT, 'failure.txt'), await evaluate('document.body.innerText'))
  } catch { /* Original failure is more useful than diagnostics failure. */ }
  throw error
} finally {
  await browser.close()
}

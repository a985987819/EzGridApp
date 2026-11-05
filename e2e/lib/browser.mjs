import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Each run owns its profile, ephemeral debugging port and bounded CDP requests. */
export async function openBrowser({ name = 'grid-browser', timeout = 20_000 } = {}) {
  assert(/^[a-z0-9-]+$/i.test(name), '临时profile名称只能包含字母、数字和连字符')
  const executable = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(path => path && existsSync(path))
  assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
  const temporaryRoot = resolve(tmpdir())
  const profile = mkdtempSync(join(temporaryRoot, `${name}-`))
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
  let socket, sequence = 0, closed = false, spawnError
  browser.once('error', error => { spawnError = error })
  const pending = new Map()
  const listeners = new Set()
  const rejectPending = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
  }
  const close = async () => {
    if (closed) return
    closed = true
    rejectPending(new Error('浏览器会话已关闭'))
    socket?.close()
    browser.kill()
    // Chrome releases profile files asynchronously on Windows.
    assert(resolve(profile).startsWith(temporaryRoot + sep) && basename(profile).startsWith(name + '-'), '拒绝清理临时profile目录之外的路径')
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break } catch { await pause(100) }
    }
  }
  try {
    const activePort = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + timeout
    while (!existsSync(activePort)) {
      if (spawnError) throw spawnError
      if (browser.exitCode !== null) throw new Error(`浏览器提前退出：${browser.exitCode}`)
      if (Date.now() > deadline) throw new Error('浏览器启动超时')
      await pause(100)
    }
    const port = Number(readFileSync(activePort, 'utf8').split('\n')[0])
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT', signal: AbortSignal.timeout(timeout),
    })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP连接超时')), timeout)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP连接失败')) }, { once: true })
    })
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const request = pending.get(message.id)
      if (request) {
        pending.delete(message.id)
        clearTimeout(request.timer)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      }
      if (message.method) for (const listener of listeners) listener(message)
    })
    socket.addEventListener('close', () => rejectPending(new Error('CDP连接已断开')))
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      if (closed || socket.readyState !== WebSocket.OPEN) { reject(new Error('CDP连接不可用')); return }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP请求超时：${method}`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const until = async (expression, waitMs = timeout) => {
      const expires = Date.now() + waitMs
      while (Date.now() < expires) {
        if (await evaluate(`(async()=>Boolean(await (${expression})))()`)) return
        await pause(100)
      }
      throw new Error('等待超时：' + expression)
    }
    return { send, evaluate, until, close, profile, onEvent: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    } }
  } catch (error) {
    await close()
    throw error
  }
}

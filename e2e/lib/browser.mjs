import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const EXECUTABLES = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/**
 * 启动独立临时 profile 的无头浏览器，直到它真的开始监听调试端口。
 * 端口交给浏览器自选（--remote-debugging-port=0）：固定端口在 CI 上会撞上残留进程，
 * 实际端口从 profile 目录的 DevToolsActivePort 读取。失败时抛出浏览器自己的 stderr，
 * 不再用一个光秃秃的 ECONNREFUSED 结束。
 */
export async function launchBrowser({ name = 'grid-browser', timeout = 60_000, args = [] } = {}) {
  assert(/^[a-z0-9-]+$/i.test(name), '临时profile名称只能包含字母、数字和连字符')
  const executable = EXECUTABLES.find(path => existsSync(path))
  assert(executable, '需要 Chrome/Edge，或设置 CHROME_PATH')
  const profile = mkdtempSync(join(resolve(tmpdir()), `${name}-`))
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-gpu',
    '--disable-dev-shm-usage', ...args, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  browser.stderr.setEncoding('utf8')
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  let spawnError
  browser.once('error', error => { spawnError = error })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    browser.kill()
    // Chrome releases profile files asynchronously on Windows.
    const temporaryRoot = resolve(tmpdir())
    assert(resolve(profile).startsWith(temporaryRoot + sep) && basename(profile).startsWith(name + '-'), '拒绝清理临时profile目录之外的路径')
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break } catch { await pause(100) }
    }
  }
  try {
    const activePort = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + timeout
    let port = 0
    while (!port) {
      if (spawnError) throw spawnError
      if (browser.exitCode !== null) throw new Error(`浏览器提前退出（code ${browser.exitCode}）\n${stderr}`)
      if (existsSync(activePort)) {
        const parsed = Number(readFileSync(activePort, 'utf8').split('\n')[0])
        if (Number.isInteger(parsed) && parsed > 0) port = parsed
      }
      if (port) break
      if (Date.now() > deadline) throw new Error(`浏览器启动超时（${timeout}ms）\n${stderr}`)
      await pause(100)
    }
    return { browser, port, profile, close, stderr: () => stderr }
  } catch (error) {
    await close()
    throw error
  }
}

/** Each run owns its profile, ephemeral debugging port and bounded CDP requests. */
export async function openBrowser({ name = 'grid-browser', timeout = 20_000 } = {}) {
  // 启动给足时间（CI 冷启动慢），CDP 单请求仍按调用方给的 timeout 收紧。
  const launched = await launchBrowser({ name, timeout: Math.max(timeout, 60_000) })
  const { browser, port } = launched
  let socket, sequence = 0, closed = false
  const pending = new Map()
  const listeners = new Set()
  const rejectPending = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
  }
  // 浏览器自己崩了时，只有 stderr 能说清原因；别让调用方只看到「连接不可用」。
  const browserDied = message => new Error(`${message}（浏览器 code ${browser.exitCode ?? '仍在运行'}）\n${launched.stderr()}`)
  const close = async () => {
    if (closed) return
    closed = true
    rejectPending(new Error('浏览器会话已关闭'))
    socket?.close()
    await launched.close()
  }
  try {
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
    socket.addEventListener('close', () => rejectPending(browserDied('CDP连接已断开')))
    browser.once('exit', () => rejectPending(browserDied('浏览器已退出')))
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      if (closed || socket.readyState !== WebSocket.OPEN) { reject(browserDied('CDP连接不可用')); return }
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
    return { send, evaluate, until, close, profile: launched.profile, onEvent: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    } }
  } catch (error) {
    await close()
    throw error
  }
}

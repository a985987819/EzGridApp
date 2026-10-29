import { useSyncExternalStore } from 'react'
import { notificationOpen } from 'animal-island-ui'
import { parseRelease, type AppRelease } from './release'

export const CURRENT_RELEASE = __APP_BUILD__
const BASE = import.meta.env.BASE_URL
const LAST_KEY = `ezgrid-release:${BASE}`
const RECEIPT_KEY = `ezgrid-update:${BASE}`
interface UpdateReceipt { from: string; target: string; at: number }
type Phase = 'idle' | 'checking' | 'current' | 'available' | 'updating' | 'error' | 'development'
export interface UpdateState {
  phase: Phase
  latest: AppRelease | null
  checkedAt: number | null
  verified: boolean
  pending: boolean
  message: string
  result: 'updated' | 'refreshed' | 'mismatch' | null
}

function readPrevious(): Pick<UpdateState, 'latest' | 'checkedAt' | 'result'> {
  let latest: AppRelease | null = null, checkedAt: number | null = null, result: UpdateState['result'] = null
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as { release: unknown; at: number } | null
    if (saved && Number.isFinite(saved.at)) { latest = parseRelease(saved.release, BASE); checkedAt = saved.at }
  } catch { /* Private mode or old storage cannot prevent application startup. */ }
  let receipt: UpdateReceipt | null = null
  try { receipt = JSON.parse(sessionStorage.getItem(RECEIPT_KEY) ?? 'null') as UpdateReceipt | null; sessionStorage.removeItem(RECEIPT_KEY) } catch { /* URL receipt is a fallback when sessionStorage is unavailable. */ }
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('_ezupdate')?.split('.')
  if (!receipt && fromUrl?.length === 3) receipt = { target: fromUrl[0], from: fromUrl[1], at: Number(fromUrl[2]) }
  if (receipt && Number.isFinite(receipt.at) && Date.now() - receipt.at >= 0 && Date.now() - receipt.at < 10 * 60_000) result = receipt.target === CURRENT_RELEASE.buildId ? receipt.from === receipt.target ? 'refreshed' : 'updated' : 'mismatch'
  if (url.searchParams.has('_ezupdate')) { url.searchParams.delete('_ezupdate'); history.replaceState(history.state, '', url) }
  return { latest, checkedAt, result }
}

let state: UpdateState = { phase: import.meta.env.DEV ? 'development' : 'idle', ...readPrevious(), verified: false, pending: false, message: '' }
const listeners = new Set<() => void>()
const publish = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useAppUpdate(): UpdateState { return useSyncExternalStore(subscribe, () => state) }

let registration: ServiceWorkerRegistration | null = null
let started = false
let registrationReady: Promise<ServiceWorkerRegistration | null> | null = null
let checking: Promise<AppRelease | null> | null = null
let updating = false
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}

function observe(reg: ServiceWorkerRegistration) {
  registration = reg
  const inspect = () => {
    const pending = Boolean(reg.waiting)
    const wasPending = state.pending
    publish({ pending })
    if (pending && !wasPending && !updating && reg.waiting) void workerVersion(reg.waiting).then(info => {
      if (info && info.buildId !== CURRENT_RELEASE.buildId && !updating) notificationOpen({ message: '新版已准备好', description: '到管理 → 版本与更新，点击更新并刷新后启用。', type: 'info' })
    })
  }
  reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', inspect))
  inspect()
}

export function startAppUpdater() {
  if (started || import.meta.env.DEV) return
  started = true
  if ('serviceWorker' in navigator) {
    registrationReady = navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE, updateViaCache: 'none' }).then(reg => { observe(reg); return reg }).catch(() => null)
    // Another tab may activate a release. Keep this tab's work intact and offer an explicit refresh.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updating) { publish({ pending: true }); void checkLatestVersion() }
    })
  }
  const backgroundCheck = () => {
    if (document.visibilityState === 'visible' && !updating && Date.now() - (state.checkedAt ?? 0) > 5 * 60_000) void checkLatestVersion()
  }
  document.addEventListener('visibilitychange', backgroundCheck)
  window.addEventListener('online', backgroundCheck)
  window.addEventListener('offline', () => { if (!updating) publish({ phase: 'error', verified: false, message: '当前离线，无法确认线上最新版本；已保存的台账仍可使用。' }) })
  setInterval(backgroundCheck, 60 * 60_000)
}

async function fetchLatest(): Promise<AppRelease> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const url = new URL(`${BASE}version.json`, location.origin)
    url.searchParams.set('check', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`版本检查返回 ${response.status}`)
    const release = parseRelease(await response.json(), BASE)
    const at = Date.now()
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ release, at })) } catch { /* optional display cache */ }
    publish({ latest: release, checkedAt: at, verified: true })
    return release
  } finally { clearTimeout(timer) }
}

const errorMessage = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '网络请求超时，请稍后重试'

export function checkLatestVersion(): Promise<AppRelease | null> {
  if (import.meta.env.DEV) return Promise.resolve(null)
  if (checking) return checking
  if (updating) return Promise.resolve(null)
  publish({ phase: 'checking', verified: false, message: '正在读取线上版本…' })
  checking = (async () => {
    try {
      const latest = await fetchLatest()
      publish({ phase: latest.buildId === CURRENT_RELEASE.buildId ? 'current' : 'available', message: latest.buildId === CURRENT_RELEASE.buildId ? '当前运行版本与线上发布一致。' : '发现不同的线上发布版本，点击更新后启用。' })
      // Version comparison completes independently of a slow background worker download.
      if (registration) void registration.update().catch(() => {})
      else void registrationReady?.then(reg => reg?.update().catch(() => {}))
      return latest
    } catch (error) {
      publish({ phase: 'error', verified: false, message: `${errorMessage(error)}。无法确认是否最新，请重试。` })
      return null
    } finally { checking = null }
  })()
  return checking
}

function workerVersion(worker: ServiceWorker): Promise<AppRelease | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (value: AppRelease | null) => { clearTimeout(timer); channel.port1.close(); resolve(value) }
    const timer = setTimeout(() => finish(null), 1500)
    channel.port1.onmessage = ({ data }) => { try { finish(parseRelease(data, BASE)) } catch { finish(null) } }
    try { worker.postMessage({ type: 'EZGRID_VERSION' }, [channel.port2]) } catch { finish(null) }
  })
}

async function targetWorker(reg: ServiceWorkerRegistration, target: AppRelease): Promise<ServiceWorker> {
  const deadline = Date.now() + 45_000
  let idleSince = Date.now()
  while (Date.now() < deadline) {
    for (const worker of [reg.waiting, reg.active]) {
      if (worker && ['installed', 'activated'].includes(worker.state) && (await workerVersion(worker))?.buildId === target.buildId) return worker
    }
    if (!navigator.onLine) throw new Error('下载过程中网络已断开，当前页面仍保留，请联网后重试')
    if (reg.installing) idleSince = Date.now()
    else if (Date.now() - idleSince > 3000) throw new Error('线上版本号与已下载资源尚未一致，可能正在发布，请稍后重试')
    await pause(200)
  }
  throw new Error('新版资源尚未完整准备好，可能正在发布或下载失败；当前版本保留，请重试')
}

async function activateTarget(reg: ServiceWorkerRegistration, target: AppRelease): Promise<void> {
  const worker = await targetWorker(reg, target)
  if (worker.state !== 'activated') worker.postMessage({ type: 'SKIP_WAITING' })
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (navigator.serviceWorker.controller && (await workerVersion(navigator.serviceWorker.controller))?.buildId === target.buildId && reg.active?.state === 'activated') return
    await pause(100)
  }
  throw new Error('新版尚未接管页面，请再次点击强制更新；已保存的台账保留')
}

/** Updates only application resources. Never clear IndexedDB/localStorage or unregister other apps. */
export async function updateToLatest(force = false): Promise<void> {
  if (updating || import.meta.env.DEV) return
  if (checking) await checking
  if (updating) return
  updating = true
  publish({ phase: 'updating', message: '正在核对线上版本…', result: null })
  try {
    const target = await fetchLatest()
    publish({ message: '正在准备新版资源，完成后刷新并校验版本…' })
    if ('serviceWorker' in navigator) {
      const url = new URL(`${BASE}sw.js`, location.origin)
      url.searchParams.set('build', target.buildId)
      if (force) url.searchParams.set('force', String(Date.now()))
      const reg = await within(navigator.serviceWorker.register(url, { scope: BASE, updateViaCache: 'none' }), 25_000, '更新脚本下载超时，请联网后重试')
      observe(reg)
      await within(reg.update(), 25_000, '更新脚本检查超时，请稍后重试')
      await activateTarget(reg, target)
    } else {
      const url = new URL(`${BASE}index.html`, location.origin)
      url.searchParams.set('_ezupdate', String(Date.now()))
      const response = await fetch(url, { cache: 'no-store' })
      const html = new DOMParser().parseFromString(await response.text(), 'text/html')
      if (!response.ok || html.querySelector('meta[name="ezgrid-build"]')?.getAttribute('content') !== target.buildId) throw new Error('线上页面与版本信息尚未一致，请稍后重试')
    }
    const receipt: UpdateReceipt = { from: CURRENT_RELEASE.buildId, target: target.buildId, at: Date.now() }
    try { sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt)) } catch { /* The URL also carries a short-lived verification receipt. */ }
    const url = new URL(location.href)
    url.searchParams.set('_ezupdate', `${target.buildId}.${CURRENT_RELEASE.buildId}.${receipt.at}`)
    location.replace(url)
  } catch (error) {
    publish({ phase: 'error', verified: false, message: `更新未完成：${errorMessage(error)}` })
    updating = false
  }
}

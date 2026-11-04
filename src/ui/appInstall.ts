import { useSyncExternalStore } from 'react'

export type InstallOutcome = 'idle' | 'accepted' | 'dismissed' | 'error'
export type InstallRequestResult = Exclude<InstallOutcome, 'idle'> | 'unavailable'

export interface AppInstallState {
  installed: boolean
  canPrompt: boolean
  installing: boolean
  outcome: InstallOutcome
  message: string
}

interface InstallChoice {
  outcome: 'accepted' | 'dismissed'
  platform?: string
}

/** Chromium 的旧接口通过 userChoice 返回结果，新接口也会由 prompt() 返回。 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<InstallChoice | void>
  userChoice?: Promise<InstallChoice>
}

export interface AppInstallEnvironment {
  events: Pick<EventTarget, 'addEventListener'>
  isStandalone(): boolean
  onDisplayModeChange(listener: () => void): void
}

function isChoice(value: unknown): value is InstallChoice {
  return typeof value === 'object' && value !== null &&
    ('outcome' in value) && (value.outcome === 'accepted' || value.outcome === 'dismissed')
}

/** 保留浏览器给的单次安装能力；控制器不写存储，不把接受提示当成安装完成。 */
export function createAppInstallController(environment: AppInstallEnvironment) {
  const readStandalone = () => {
    try { return environment.isStandalone() } catch { return false }
  }
  let confirmedInstalled = false
  let state: AppInstallState = { installed: readStandalone(), canPrompt: false, installing: false, outcome: 'idle', message: '' }
  let pending: InstallPromptEvent | null = null
  let started = false
  let generation = 0
  let activeToken: symbol | null = null
  let activeRequest: Promise<InstallRequestResult> | null = null
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<AppInstallState>) => {
    if (Object.entries(patch).every(([key, value]) => state[key as keyof AppInstallState] === value)) return
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const markInstalled = () => {
    generation += 1
    pending = null
    activeToken = null
    activeRequest = null
    publish({ installed: true, canPrompt: false, installing: false, outcome: 'idle', message: '应用已安装，可从主屏幕或应用列表打开。' })
  }

  function start() {
    if (started) return
    started = true
    if (readStandalone()) markInstalled()
    environment.events.addEventListener('beforeinstallprompt', event => {
      if (typeof (event as Partial<InstallPromptEvent>).prompt !== 'function') return
      event.preventDefault()
      if (state.installed) return
      generation += 1
      pending = event as InstallPromptEvent
      // 新事件代表新的单次安装能力；旧 userChoice 即使悬挂，也不能占住下一次点击。
      activeToken = null
      activeRequest = null
      publish({ canPrompt: true, installing: false, outcome: 'idle', message: '' })
    })
    environment.events.addEventListener('appinstalled', () => {
      confirmedInstalled = true
      markInstalled()
    })
    environment.onDisplayModeChange(() => {
      if (readStandalone() || confirmedInstalled) markInstalled()
      else publish({ installed: false, canPrompt: pending !== null, message: '' })
    })
  }

  function request(): Promise<InstallRequestResult> {
    if (state.installed) return Promise.resolve('unavailable')
    if (activeRequest) return activeRequest
    if (!pending) return Promise.resolve('unavailable')
    const event = pending
    pending = null
    const requestGeneration = generation
    const token = Symbol('install-request')
    activeToken = token
    publish({ canPrompt: false, installing: true, outcome: 'idle', message: '' })
    const isCurrent = () => generation === requestGeneration && !state.installed
    const finish = () => {
      if (activeToken !== token) return
      activeToken = null
      activeRequest = null
      publish({ installing: false })
    }
    let promptResult: Promise<InstallChoice | void>
    let userChoice: Promise<InstallChoice> | undefined
    try {
      // 必须在点击处理的同步调用栈里执行，不能先等待 SW、版本检查或其它异步任务。
      promptResult = event.prompt()
      userChoice = event.userChoice
    } catch {
      if (isCurrent()) publish({ outcome: 'error', message: '未能打开安装窗口，请按下方浏览器指引手动安装。' })
      finish()
      return Promise.resolve('error')
    }
    // 两个结果同时接住拒绝，避免旧 userChoice 先失败时成为未处理的 Promise。
    const request = Promise.all([promptResult, userChoice]).then(([promptChoice, choice]) => {
      const result = isChoice(choice) ? choice : promptChoice
      if (!isChoice(result)) throw new Error('安装结果不可用')
      if (isCurrent()) publish({
        outcome: result.outcome,
        message: result.outcome === 'accepted'
          ? '已确认安装，请等待系统完成；完成后可从主屏幕或应用列表打开。'
          : '已取消安装。需要时可按下方浏览器指引继续安装。',
      })
      return result.outcome
    }).catch(() => {
      if (isCurrent()) publish({ outcome: 'error', message: '未能完成安装提示，请按下方浏览器指引手动安装。' })
      return 'error' as const
    }).finally(finish)
    // prompt() 内也可能同步到达新事件或 appinstalled；不能把旧请求重新设为活跃。
    if (activeToken === token) activeRequest = request
    return request
  }

  return {
    start,
    request,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

function browserEnvironment(): AppInstallEnvironment {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null
  return {
    events: window,
    isStandalone: () => media?.matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    onDisplayModeChange: listener => {
      if (media?.addEventListener) media.addEventListener('change', listener)
      else media?.addListener(listener)
    },
  }
}

let controller: ReturnType<typeof createAppInstallController> | undefined
const appInstallController = () => controller ??= createAppInstallController(browserEnvironment())

/** 入口同步注册，不能等用户打开管理页才开始接收安装事件。 */
export function startAppInstall(): void { appInstallController().start() }
export function requestAppInstall(): Promise<InstallRequestResult> { return appInstallController().request() }
export function useAppInstall(): AppInstallState {
  const current = appInstallController()
  return useSyncExternalStore(current.subscribe, current.getSnapshot)
}

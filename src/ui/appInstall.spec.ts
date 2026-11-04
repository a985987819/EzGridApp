import { describe, expect, it, vi } from 'vitest'
import { createAppInstallController } from './appInstall'

type Choice = { outcome: 'accepted' | 'dismissed' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(standalone = false) {
  const events = new EventTarget()
  const mediaListeners = new Set<() => void>()
  const environment = {
    events,
    isStandalone: () => standalone,
    onDisplayModeChange: vi.fn((listener: () => void) => { mediaListeners.add(listener) }),
  }
  const controller = createAppInstallController(environment)
  return {
    events, controller, environment,
    display: (value: boolean) => { standalone = value; mediaListeners.forEach(listener => listener()) },
  }
}

function promptEvent(prompt: () => Promise<Choice | void>, userChoice?: Promise<Choice>) {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: vi.fn(prompt), userChoice })
}

describe('全局 PWA 安装事件生命周期', () => {
  it('只注册一次，管理页打开之前到达的事件仍能由稍后的点击调用', async () => {
    const { controller, events, environment } = setup()
    const add = vi.spyOn(events, 'addEventListener')
    controller.start()
    controller.start()
    expect(add).toHaveBeenCalledTimes(2)
    expect(environment.onDisplayModeChange).toHaveBeenCalledTimes(1)
    const event = promptEvent(() => Promise.resolve({ outcome: 'dismissed' }))
    events.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ installed: false, canPrompt: true, installing: false })
    expect(event.prompt).not.toHaveBeenCalled()
    const request = controller.request()
    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: false, installing: true })
    await expect(request).resolves.toBe('dismissed')
    expect(controller.getSnapshot()).toMatchObject({ installed: false, installing: false, outcome: 'dismissed' })
  })

  it('不支持安装事件时返回不可用，页面仍可提供手动引导', async () => {
    const { controller } = setup()
    controller.start()
    await expect(controller.request()).resolves.toBe('unavailable')
    expect(controller.getSnapshot()).toMatchObject({ installed: false, canPrompt: false, outcome: 'idle' })
  })

  it('prompt 在首次 await 前同步调用，快速重复点击共用一次请求，事件不能复用', async () => {
    const { controller, events } = setup()
    controller.start()
    const choice = deferred<Choice>()
    let gesture = true
    const event = promptEvent(() => {
      expect(gesture).toBe(true)
      return choice.promise
    })
    events.dispatchEvent(event)
    const first = controller.request()
    const second = controller.request()
    gesture = false
    expect(first).toBe(second)
    expect(event.prompt).toHaveBeenCalledTimes(1)
    choice.resolve({ outcome: 'accepted' })
    await expect(first).resolves.toBe('accepted')
    await expect(controller.request()).resolves.toBe('unavailable')
    expect(event.prompt).toHaveBeenCalledTimes(1)
  })

  it('兼容旧接口 prompt 返回 void、由 userChoice 确认；accepted 不冒充已安装', async () => {
    const { controller, events } = setup()
    controller.start()
    const choice = deferred<Choice>()
    events.dispatchEvent(promptEvent(() => Promise.resolve(), choice.promise))
    const request = controller.request()
    choice.resolve({ outcome: 'accepted' })
    await expect(request).resolves.toBe('accepted')
    expect(controller.getSnapshot()).toMatchObject({ installed: false, canPrompt: false, installing: false, outcome: 'accepted' })
    expect(controller.getSnapshot().message).toContain('等待系统完成')
    events.dispatchEvent(new Event('appinstalled'))
    expect(controller.getSnapshot()).toMatchObject({ installed: true, canPrompt: false, outcome: 'idle' })
  })

  it('取消后只在收到新事件时再次允许安装，不立即重复打开原提示', async () => {
    const { controller, events } = setup()
    controller.start()
    events.dispatchEvent(promptEvent(() => Promise.resolve({ outcome: 'dismissed' })))
    await controller.request()
    expect(controller.getSnapshot()).toMatchObject({ installed: false, canPrompt: false, outcome: 'dismissed' })
    events.dispatchEvent(promptEvent(() => Promise.resolve({ outcome: 'accepted' })))
    expect(controller.getSnapshot()).toMatchObject({ installed: false, canPrompt: true, outcome: 'idle' })
    await expect(controller.request()).resolves.toBe('accepted')
  })

  it.each(['synchronous', 'asynchronous'] as const)('原生提示%s失败时释放加载状态并回落人工引导', async kind => {
    const { controller, events } = setup()
    controller.start()
    events.dispatchEvent(promptEvent(() => {
      if (kind === 'synchronous') throw new Error('NotAllowedError')
      return Promise.reject(new Error('NotAllowedError'))
    }))
    await expect(controller.request()).resolves.toBe('error')
    expect(controller.getSnapshot()).toMatchObject({ installed: false, canPrompt: false, installing: false, outcome: 'error' })
    expect(controller.getSnapshot().message).toContain('手动安装')
  })

  it('旧 userChoice 拒绝也转为明确失败，不留下永远加载', async () => {
    const { controller, events } = setup()
    controller.start()
    const choice = deferred<Choice>()
    events.dispatchEvent(promptEvent(() => Promise.resolve(), choice.promise))
    const request = controller.request()
    choice.reject(new Error('userChoice failed'))
    await expect(request).resolves.toBe('error')
    expect(controller.getSnapshot()).toMatchObject({ installing: false, outcome: 'error' })
  })

  it('已安装事件先到达时，旧弹窗迟到的取消不会改回未安装', async () => {
    const { controller, events } = setup()
    controller.start()
    const choice = deferred<Choice>()
    events.dispatchEvent(promptEvent(() => choice.promise))
    const request = controller.request()
    events.dispatchEvent(new Event('appinstalled'))
    const installed = controller.getSnapshot()
    choice.resolve({ outcome: 'dismissed' })
    await request
    expect(controller.getSnapshot()).toBe(installed)
    expect(controller.getSnapshot()).toMatchObject({ installed: true, installing: false, outcome: 'idle' })
  })

  it('等待旧结果时新事件到达，旧结果不覆盖新能力与消息', async () => {
    const { controller, events } = setup()
    controller.start()
    const oldChoice = deferred<Choice>()
    events.dispatchEvent(promptEvent(() => oldChoice.promise))
    const request = controller.request()
    const next = promptEvent(() => Promise.resolve({ outcome: 'dismissed' }))
    events.dispatchEvent(next)
    oldChoice.reject(new Error('stale result'))
    await expect(request).resolves.toBe('error')
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: true, installing: false, outcome: 'idle', message: '' })
    await expect(controller.request()).resolves.toBe('dismissed')
    expect(next.prompt).toHaveBeenCalledTimes(1)
  })

  it('新事件到达后不等待旧 userChoice，旧 finally 不能结束正在展示的新提示', async () => {
    const { controller, events } = setup()
    controller.start()
    const oldChoice = deferred<Choice>()
    const newChoice = deferred<Choice>()
    const oldEvent = promptEvent(() => oldChoice.promise)
    const newEvent = promptEvent(() => newChoice.promise)
    events.dispatchEvent(oldEvent)
    const oldRequest = controller.request()
    events.dispatchEvent(newEvent)
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: true, installing: false })
    const newRequest = controller.request()
    expect(newRequest).not.toBe(oldRequest)
    expect(newEvent.prompt).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: false, installing: true })
    oldChoice.resolve({ outcome: 'dismissed' })
    await oldRequest
    expect(controller.getSnapshot()).toMatchObject({ installing: true, outcome: 'idle', message: '' })
    newChoice.resolve({ outcome: 'accepted' })
    await expect(newRequest).resolves.toBe('accepted')
    expect(controller.getSnapshot()).toMatchObject({ installing: false, outcome: 'accepted', installed: false })
  })

  it('从应用独立模式启动和 display-mode 切换都同步状态，菜单安装也能识别', async () => {
    const app = setup(true)
    app.controller.start()
    expect(app.controller.getSnapshot().installed).toBe(true)
    const never = promptEvent(() => Promise.resolve({ outcome: 'accepted' }))
    app.events.dispatchEvent(never)
    await expect(app.controller.request()).resolves.toBe('unavailable')
    expect(never.prompt).not.toHaveBeenCalled()
    app.display(false)
    expect(app.controller.getSnapshot().installed).toBe(false)
    app.display(true)
    expect(app.controller.getSnapshot().installed).toBe(true)
    app.display(false)
    app.events.dispatchEvent(new Event('appinstalled'))
    app.display(false)
    expect(app.controller.getSnapshot().installed).toBe(true)
  })

  it('外部订阅收到新快照并可取消，无效事件不会伪造可安装状态', () => {
    const { controller, events } = setup()
    controller.start()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    events.dispatchEvent(new Event('beforeinstallprompt'))
    expect(listener).not.toHaveBeenCalled()
    events.dispatchEvent(promptEvent(() => Promise.resolve({ outcome: 'accepted' })))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    events.dispatchEvent(new Event('appinstalled'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

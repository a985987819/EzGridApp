import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * V9.55：让所有编辑弹层（Modal / Drawer）**不改变页面滚动位置**。
 *
 * 组件库在打开弹层时给 `body` 写 `overflow:hidden`，而本项目是普通文档流
 * （`.app` 只有 `min-height:100%`）——文档高度当场塌成一屏，浏览器把
 * `window.scrollY` 清零，关掉之后人就停在页面顶上，改完一笔还得从头往下划
 * 才能找回刚才那一行。
 *
 * 做法：打开前记下位置，**全部弹层都关掉之后**再补回去。补的时候不能急——
 * 库要在关闭动画 / 副作用里把 `overflow` 清掉，那时才滚得动，所以用 rAF +
 * 少量重试（400ms 内最多 5 次），滚到位就停。
 *
 * **V9.57 锁定期把 body 钉在当前可视位置**：光记位置不够——弹层开着的整个期间
 * 文档就是一屏高、`scrollY` 是 0，遮罩底下看到的是页顶而不是刚才那一行，开/关
 * 一次背景就「跳上去 → 跳回来」；iOS 上 `overflow:hidden` 更是挡不住触摸拖遮罩，
 * 背景会被直接拖走。锁住时给 body 上 `position:fixed; top:-Y`（弹层门户都是
 * fixed 定位、不受宿主影响），背景纹丝不动，触摸拖拽也无处可拖；恢复时等库把
 * `overflow` 清掉（钉子挂着时文档高度恒为一屏，只能看这个信号），**摘钉子和
 * scrollTo 放进同一帧**，背景全程没有一帧是页顶。
 *
 * 嵌套弹层（抽屉里再开弹窗）要传合并后的布尔值：`open` 一直为 true 就不会
 * 在中间那层关闭时抢着摘钉子——body 还锁着，滚也白滚。
 *
 * 用 `useLayoutEffect` 是有意的：库锁 body 是在 `useEffect` 里做的，layout 阶段
 * 一定先跑完——这时 `scrollY` 还是打开前的真值，换成 `useEffect` 就记录到 0 了。
 *
 * V9.55 修（重入）：关掉一个弹层后 400ms 内又打开另一个时，别把「还没滚到位的
 * 当前位置」当成新的锚点——那会把人留在半路。回滚没落地（`restoring`）就沿用
 * 上一次记下的位置，等这一轮也关掉再一起补回去。
 */

function pinBody(y: number): void {
  const s = document.body.style
  s.position = 'fixed'
  s.top = `-${y}px`
  s.left = '0'
  s.right = '0'
  s.width = '100%'
}

function unpinBody(): void {
  const s = document.body.style
  s.position = ''
  s.top = ''
  s.left = ''
  s.right = ''
  s.width = ''
}

export function useScrollHold(open: boolean): void {
  const savedY = useRef(0)
  const holding = useRef(false)
  const restoring = useRef(false)
  const frame = useRef(0)
  const timer = useRef(0)

  // 卸载时清掉还没跑完的回滚与钉子（页面在弹层开着时被切走：库会自己摘 overflow，钉子必须一起摘）
  useEffect(
    () => () => {
      window.cancelAnimationFrame(frame.current)
      window.clearTimeout(timer.current)
      unpinBody()
    },
    [],
  )

  useLayoutEffect(() => {
    if (open) {
      if (holding.current) return
      holding.current = true
      const locked = document.body.style.overflow === 'hidden'
      // 已被别的弹层锁住（scrollY 已经是 0）或上一轮回滚还没落地时，不要重记
      if (!locked && !restoring.current) savedY.current = window.scrollY
      // 重入路径（restoring）沿用旧锚点重新钉上；钉子是幂等的
      pinBody(savedY.current)
      return
    }
    if (!holding.current) return
    holding.current = false
    const top = savedY.current
    if (top <= 0) {
      unpinBody()
      return
    }
    restoring.current = true
    let tries = 0
    const step = () => {
      tries += 1
      // 重入：上一轮还没滚回去就又开了新弹层——钉子保持、这轮回滚让给下一轮
      // （open 分支已经沿旧锚点重新钉上，别在这里把钉子摘了）
      if (holding.current) {
        restoring.current = false
        return
      }
      // 钉子还挂着时文档高度恒为一屏，只能用「库清没清 overflow」判断能不能滚；
      // 摘钉 + 滚回必须同一帧，否则背景闪一下页顶
      if (document.body.style.overflow === 'hidden' && tries < 5) {
        timer.current = window.setTimeout(step, 80)
        return
      }
      unpinBody()
      window.scrollTo(0, top)
      if (Math.abs(window.scrollY - top) <= 2 || tries >= 5) {
        // 落地（或这次滚不动了——通常是被新弹层重新锁住），放过下一轮
        restoring.current = false
        return
      }
      timer.current = window.setTimeout(step, 80)
    }
    frame.current = window.requestAnimationFrame(step)
  }, [open])
}

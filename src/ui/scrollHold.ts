import { useLayoutEffect, useRef } from 'react'

/**
 * V9.55：让所有编辑弹层（Modal / Drawer）**不改变页面滚动位置**。
 *
 * 组件库在打开弹层时给 `body` 写 `overflow:hidden`，而本项目是普通文档流
 * （`.app` 只有 `min-height:100%`）——文档高度当场塌成一屏，浏览器把
 * `window.scrollY` 清零，关掉之后人就停在页面顶上，改完一笔还得从头往下划
 * 才能找回刚才那一行。
 *
 * 做法：打开前记下位置，**全部弹层都关掉之后**再补回去。补的时候不能急——
 * 库要在关闭动画 / 副作用里把 `overflow` 清掉、文档高度才恢复，那时才滚得动，
 * 所以用 rAF + 少量重试（400ms 内最多 5 次），滚到位就停。
 *
 * 嵌套弹层（抽屉里再开弹窗）要传合并后的布尔值：`open` 一直为 true 就不会
 * 在中间那一层关闭时抢着滚——body 还锁着，滚也白滚。
 *
 * 用 `useLayoutEffect` 是有意的：库锁 body 是在 `useEffect` 里做的，layout 阶段
 * 一定先跑完——这时 `scrollY` 还是打开前的真值，换成 `useEffect` 就记录到 0 了。
 */
export function useScrollHold(open: boolean): void {
  const savedY = useRef(0)
  const holding = useRef(false)

  useLayoutEffect(() => {
    if (open) {
      if (holding.current) return
      holding.current = true
      // 已被别的弹层锁住 body（scrollY 已经是 0）时不要记，否则会把人拽回顶部
      const locked = document.body.style.overflow === 'hidden'
      savedY.current = locked ? -1 : window.scrollY
      return
    }
    if (!holding.current) return
    holding.current = false
    const top = savedY.current
    savedY.current = 0
    if (top <= 0) return
    let tries = 0
    let frame = 0
    let timer = 0
    const step = () => {
      tries += 1
      window.scrollTo(0, top)
      if (Math.abs(window.scrollY - top) <= 2 || tries >= 5) return
      timer = window.setTimeout(step, 80)
    }
    frame = window.requestAnimationFrame(step)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [open])
}

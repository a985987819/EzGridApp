import { useEffect } from 'react'

/**
 * 移动端输入法避让：把 visualViewport 与布局视口的差写成 CSS 变量。
 * Drawer 挂在 body 上、position:fixed——键盘弹出时布局视口不缩，面板会整个落到
 * 键盘下面；--kb-inset 把底边抬到键盘上沿，--ed-h 让高度只占可见区。
 * 键盘没弹时两值与正常 84vh 等价，不影响桌面。
 */
export function useKeyboardInset(active: boolean) {
  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    const vv = window.visualViewport
    const apply = () => {
      const viewH = Math.round(vv?.height ?? window.innerHeight)
      const inset = Math.max(0, window.innerHeight - viewH - (vv?.offsetTop ?? 0))
      root.style.setProperty('--kb-inset', `${inset}px`)
      root.style.setProperty('--kb-vh', `${viewH}px`)
      root.style.setProperty('--ed-h', `${Math.max(0, Math.min(Math.round(window.innerHeight * 0.84), viewH - 8))}px`)
    }
    apply()
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      root.style.removeProperty('--kb-inset')
      root.style.removeProperty('--kb-vh')
      root.style.removeProperty('--ed-h')
    }
  }, [active])
}

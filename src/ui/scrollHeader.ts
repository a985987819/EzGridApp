import { useLayoutEffect, useRef } from 'react'

/**
 * 顶部设置自然滚出后才换成摘要。收放不改变文档高度，也不触发页面重渲染。
 * 只在尺寸变化时测量高度；滚动帧只读位置并在跨过阈值时更新 DOM 标记。
 */
export function useScrollHeader(compactClass: string) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const header = ref.current
    const summary = header?.querySelector<HTMLElement>('[data-scroll-summary]')
    const expanded = header?.querySelector<HTMLElement>('[data-scroll-expanded]')
    if (!header || !summary || !expanded) return

    let frame = 0
    let compact = false
    let hiddenHeight = 0
    let stickyTop = 0
    const apply = (next: boolean) => {
      if (next === compact && header.dataset.compact !== undefined) return
      compact = next
      header.dataset.compact = String(next)
      header.classList.toggle(compactClass, next)
      summary.setAttribute('aria-hidden', String(!next))
      summary.inert = !next
      expanded.setAttribute('aria-hidden', String(next))
      expanded.inert = next
    }
    const sync = () => {
      frame = 0
      // 编辑弹层把 body 钉住时 scrollY 会变0；摘要不能因此闪回完整设置。
      if (document.body.style.position === 'fixed') return
      const top = header.getBoundingClientRect().top
      const focused = expanded.contains(document.activeElement)
      apply(!focused && hiddenHeight > 0 && window.scrollY > 24 &&
        top <= stickyTop + (compact ? 18 : 1))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync)
    }
    const measure = () => {
      // 摘要为绝对定位；始终可测量，不用先隐藏/显示整块设置。
      hiddenHeight = Math.max(0, header.offsetHeight - summary.offsetHeight - 14)
      header.style.setProperty('--scroll-hide-height', `${hiddenHeight}px`)
      stickyTop = parseFloat(getComputedStyle(header).top) || 0
      schedule()
    }

    apply(false)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    observer.observe(summary)
    window.addEventListener('scroll', schedule, { passive: true })
    expanded.addEventListener('focusin', schedule)
    expanded.addEventListener('focusout', schedule)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      expanded.removeEventListener('focusin', schedule)
      expanded.removeEventListener('focusout', schedule)
    }
  }, [compactClass])

  return ref
}

export function scrollToPageTop(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' })
}

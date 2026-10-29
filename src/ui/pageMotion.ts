import { useEffect, type RefObject } from 'react'

/** 只观察页面模块，首次进入视口才展示；滚回同一模块不重播，不逐帧驱动React。 */
export function usePageMotion(ref: RefObject<HTMLElement>, pageKey: string): void {
  useEffect(() => {
    const main = ref.current
    if (!main) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const seen = new Set<HTMLElement>()
    const animations = new Set<Animation>()
    const disclosures = new Map<HTMLDetailsElement, { animation: Animation; finish: () => void }>()
    let frame = 0
    let observer: IntersectionObserver | undefined

    const reveal = (element: HTMLElement, animate = true) => {
      if (element.dataset.reveal === 'shown') return
      element.dataset.reveal = 'shown'
      observer?.unobserve(element)
      if (!animate || media.matches || element.dataset.anim) return
      const animation = element.animate(
        [{ opacity: 0.35, translate: '0 10px' }, { opacity: 1, translate: '0 0' }],
        { duration: 280, easing: 'cubic-bezier(.2,.75,.25,1)' },
      )
      animations.add(animation)
      void animation.finished.finally(() => animations.delete(animation)).catch(() => {})
    }
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) reveal(entry.target as HTMLElement)
      }, { rootMargin: '0px 0px 64px 0px', threshold: 0.01 })
    }
    const collect = () => {
      frame = 0
      const page = main.firstElementChild
      if (!page) return
      const candidates = page.matches('.stack')
        ? [...page.children, ...page.querySelectorAll('.overview-bottom > *, .overview-top > *, .manage-content > .stack > *')]
        : [page]
      for (const node of candidates) {
        if (!(node instanceof HTMLElement) || seen.has(node) ||
          node.matches('.page-sticky, .overview-top, .overview-bottom, .manage-content, script, style') ||
          node.closest('[data-scroll-expanded], [data-scroll-summary], [data-reveal]')) continue
        seen.add(node)
        const top = node.getBoundingClientRect().top
        if (!observer || media.matches || top < window.innerHeight + 32) {
          // 首屏由切页动画负责；不再把每张卡、每行、每个指标叠加三层入场。
          reveal(node, false)
        } else {
          node.dataset.reveal = 'pending'
          observer.observe(node)
        }
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(collect)
    }
    const showAll = () => {
      if (!media.matches) return
      for (const node of seen) reveal(node, false)
      for (const animation of animations) animation.cancel()
      for (const { finish } of disclosures.values()) finish()
    }
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element) {
        const pending = event.target.closest<HTMLElement>('[data-reveal="pending"]')
        if (pending) reveal(pending, false)
      }
    }
    const onDisclosure = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.defaultPrevented || event.button !== 0) return
      const summary = event.target.closest('summary')
      const details = summary?.parentElement
      if (!summary || !(details instanceof HTMLDetailsElement) || !main.contains(details) ||
        event.target.closest('a, button, input, select, textarea')) return
      if (media.matches) return // 保留原生瞬切与键盘语义。
      event.preventDefault()
      const previous = disclosures.get(details)
      const opening = previous ? details.dataset.opening !== 'true' : !details.open
      const start = details.getBoundingClientRect().height
      previous?.animation.cancel()
      details.style.height = ''
      details.open = true
      const style = getComputedStyle(details)
      const collapsed = summary.getBoundingClientRect().height +
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      const end = opening ? details.getBoundingClientRect().height : collapsed
      details.dataset.opening = String(opening)
      details.style.overflow = 'hidden'
      const animation = details.animate(
        [{ height: `${start}px` }, { height: `${end}px` }],
        { duration: 220, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both' },
      )
      const finish = () => {
        details.open = opening
        details.style.height = ''
        details.style.overflow = ''
        delete details.dataset.opening
        animation.cancel()
        disclosures.delete(details)
      }
      disclosures.set(details, { animation, finish })
      void animation.finished.then(finish).catch(() => {})
    }
    collect()
    const mutations = new MutationObserver(schedule)
    mutations.observe(main, { childList: true, subtree: true })
    main.addEventListener('focusin', onFocus)
    main.addEventListener('click', onDisclosure)
    media.addEventListener('change', showAll)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      mutations.disconnect()
      main.removeEventListener('focusin', onFocus)
      main.removeEventListener('click', onDisclosure)
      media.removeEventListener('change', showAll)
      for (const animation of animations) animation.cancel()
      for (const { finish } of disclosures.values()) finish()
      for (const node of seen) delete node.dataset.reveal
    }
  }, [ref, pageKey])
}

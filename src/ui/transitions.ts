import { flushSync } from 'react-dom'

type Direction = 'forward' | 'back'
let active: ViewTransition | undefined
let commitPending: (() => void) | undefined

/** 用户触发的切页/切面板。快切先提交前一次动作，动画可以跳过，动作不能丢。 */
export function transitionView(update: () => void, direction: Direction = 'forward', scope: 'page' | 'content' = 'content'): void {
  commitPending?.()
  active?.skipTransition()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced || !document.startViewTransition || document.visibilityState !== 'visible') {
    flushSync(update)
    if (!reduced) {
      document.querySelector('.app-main > *')?.animate(
        [{ opacity: 0.65 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' },
      )
    }
    return
  }

  document.documentElement.dataset.transition = scope
  document.documentElement.dataset.direction = direction
  let committed = false
  const commit = () => {
    if (committed) return
    committed = true
    if (commitPending === commit) commitPending = undefined
    flushSync(update)
  }
  commitPending = commit
  const transition = document.startViewTransition(commit)
  active = transition
  // 跳过的快照会拒绝ready；不影响已经提交的业务/导航动作。
  void transition.ready.catch(() => {})
  void transition.finished.finally(() => {
    if (active !== transition) return
    active = undefined
    delete document.documentElement.dataset.transition
    delete document.documentElement.dataset.direction
  }).catch(() => {})
}

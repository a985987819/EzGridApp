import { useEffect, useRef, useState } from 'react'

/**
 * 「这一帧里新出现的 key」→ 闪一下（V9.37 动效层）。
 *
 * 用途：某行刚刚完成（挂单回补、明细卖满）时给它一个短暂的动效标记，
 * 组件只要把「已经完成的行的 key 列表」丢进来就行。
 *
 * 注意两点：
 *   1. 首帧不算「新出现」——刚进页面不该满屏乱闪；
 *   2. 依赖用「key 序列的签名」而不是数组本身，否则每次渲染都会重跑 effect、
 *      把正在计时的清除函数提前跑掉，闪灯永远不灭。
 */
export function useFlashOnAppear(keys: number[], ms = 1200): Set<number> {
  const [flashed, setFlashed] = useState<Set<number>>(() => new Set())
  const seen = useRef<Set<number> | null>(null)
  const keysRef = useRef(keys)
  keysRef.current = keys
  const sig = keys.join(',')
  useEffect(() => {
    const now = new Set(keysRef.current)
    const prev = seen.current
    seen.current = now
    if (prev === null) return // 首帧：只记录基线，不闪
    const fresh = [...now].filter((k) => !prev.has(k))
    if (fresh.length === 0) return
    setFlashed((s) => new Set([...s, ...fresh]))
    const t = window.setTimeout(() => {
      setFlashed((s) => {
        const n = new Set(s)
        for (const k of fresh) n.delete(k)
        return n
      })
    }, ms)
    return () => window.clearTimeout(t)
  }, [sig, ms])
  return flashed
}

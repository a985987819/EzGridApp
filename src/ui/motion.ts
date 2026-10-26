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
  /**
   * V9.55 修：定时器改成**按 key 各一个**，并且只有卸载时才统一清。
   * 原来一个 effect 只留一个定时器、依赖变化就把它 clear 掉——第二笔回补在 1.2s 内
   * 完成时，第一行已经进了 `flashed` 却再也等不到清除，动效会一直亮着。
   */
  const timers = useRef(new Map<number, number>())
  const sig = keys.join(',')
  useEffect(() => {
    const now = new Set(keysRef.current)
    const prev = seen.current
    seen.current = now
    if (prev === null) return // 首帧：只记录基线，不闪
    const fresh = [...now].filter((k) => !prev.has(k))
    if (fresh.length === 0) return
    setFlashed((s) => new Set([...s, ...fresh]))
    for (const k of fresh) {
      const old = timers.current.get(k)
      if (old !== undefined) window.clearTimeout(old)
      timers.current.set(
        k,
        window.setTimeout(() => {
          timers.current.delete(k)
          setFlashed((s) => {
            const n = new Set(s)
            n.delete(k)
            return n
          })
        }, ms),
      )
    }
  }, [sig, ms])
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) window.clearTimeout(t)
      map.clear()
    }
  }, [])
  return flashed
}

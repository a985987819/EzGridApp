import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * 页内下拉选择器。
 *
 * 组件库的 Select 把面板横向浮在触发框右侧（空间不够翻到左侧），手机上一整行宽时
 * 两边都会出屏。这里改成：面板在触发框正下方就地展开，左右夹进视口，下方空间不够
 * 向上翻转，面板自己滚，不会把内容顶出页面。
 */

export interface SelectOption {
  key: string
  label: string
}

export interface SelectProps {
  options: SelectOption[]
  value: string
  onChange: (key: string) => void
  placeholder?: string
  disabled?: boolean
  /** 嵌在标题/图例条里的小尺寸 */
  mini?: boolean
  className?: string
  'aria-label'?: string
}

/** 面板与触发框的间距 */
const GAP = 6
/** 面板与视口边缘的最小留白 */
const EDGE = 8
/** 面板最多占屏高比例 */
const MAX_VH = 0.5
/** 下方不足这个高度就考虑向上翻转 */
const MIN_BELOW = 220

export function Select({
  options,
  value,
  onChange,
  placeholder = '请选择',
  disabled = false,
  mini = false,
  className,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const [shift, setShift] = useState(0)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const selectedIndex = options.findIndex((o) => o.key === value)
  const selected = selectedIndex < 0 ? undefined : options[selectedIndex]

  // 展开时量一次：朝上还是朝下、可用高度、左右偏移（相对触发框）
  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current
    const p = panelRef.current
    if (!t || !p) return
    const r = t.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const below = vh - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    const need = p.scrollHeight
    const useUp = below < Math.min(need, MIN_BELOW) && above > below
    setUp(useUp)
    setMaxHeight(Math.round(Math.max(96, Math.min(useUp ? above : below, vh * MAX_VH))))
    const pw = p.offsetWidth
    let left = r.left
    if (left + pw > vw - EDGE) left = vw - EDGE - pw
    if (left < EDGE) left = EDGE
    setShift(Math.round(left - r.left))
    setActive(Math.max(0, selectedIndex))
  }, [open, options.length, selectedIndex])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // 高亮项滚进可视区（键盘操作）
  useEffect(() => {
    if (!open) return
    const el = panelRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function close(focus = false) {
    setOpen(false)
    if (focus) triggerRef.current?.focus()
  }

  function pick(key: string) {
    onChange(key)
    close(true)
  }

  function move(delta: number) {
    if (options.length === 0) return
    setActive((i) => (i + delta + options.length) % options.length)
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === 'Escape') {
        close()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(Math.max(0, options.length - 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const opt = options[active]
      if (opt) pick(opt.key)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') {
      close()
    }
  }

  return (
    <div
      ref={wrapRef}
      className={['app-select', mini ? 'mini' : '', open ? 'open' : '', disabled ? 'disabled' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        {selected ? (
          <span className="app-select-val">{selected.label}</span>
        ) : (
          <span className="app-select-ph">{placeholder}</span>
        )}
        <svg className="app-select-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          className={`app-select-panel${up ? ' up' : ''}`}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            maxHeight: maxHeight === null ? undefined : `${maxHeight}px`,
            left: maxHeight === null ? undefined : `${shift}px`,
            visibility: maxHeight === null ? 'hidden' : undefined,
          }}
        >
          {options.length === 0 ? (
            <div className="app-select-empty" role="option" aria-disabled="true" aria-selected="false">
              暂无选项
            </div>
          ) : (
            options.map((o, i) => (
              <button
                type="button"
                key={o.key}
                role="option"
                aria-selected={o.key === value}
                className={`app-select-option${i === active ? ' active' : ''}${o.key === value ? ' selected' : ''}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(o.key)}
              >
                <span className="app-select-dot" aria-hidden="true" />
                <span className="app-select-label">{o.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

import { useRef } from 'react'
import { Input } from 'animal-island-ui'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'
import { todayIso } from './format'
import { IconCalendar } from './icons'

/**
 * 日期字段：手输框（认 2026-10-25 / 2026/10/25 / 2026.10.25）+ 日历按钮。
 * 日历按钮唤起系统原生选择器（手机上是滚轮），选完按 ISO 回填手输框。
 */

interface DateFieldProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  'data-field'?: string
  'aria-label'?: string
}

/** 手输值 → 原生 input[type=date] 认的 YYYY-MM-DD；认不出就回到今天 */
function nativeValue(value: string): string {
  const serial = isoToSerial(value)
  const iso = serial === null ? null : serialToIso(serial)
  return iso ?? todayIso()
}

export function DateField({ value, onChange, placeholder = 'YYYY-MM-DD', ...rest }: DateFieldProps) {
  const nativeRef = useRef<HTMLInputElement>(null)

  function openPicker() {
    const el = nativeRef.current
    if (!el) return
    el.value = nativeValue(value)
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker()
        return
      } catch {
        // 部分浏览器要求更强的用户手势，退回 focus
      }
    }
    el.focus()
    el.click()
  }

  return (
    <div className="date-field">
      <Input
        className="date-field-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-field={rest['data-field']}
        aria-label={rest['aria-label']}
      />
      <button
        type="button"
        className="date-field-btn"
        aria-label="选择日期"
        onClick={(e) => {
          // 字段常包在 <label> 里：别让标签激活去抢焦点、把刚弹出的选择器关掉
          e.preventDefault()
          openPicker()
        }}
      >
        <IconCalendar width={16} height={16} />
      </button>
      <input
        ref={nativeRef}
        type="date"
        className="date-field-native"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value)
        }}
      />
    </div>
  )
}

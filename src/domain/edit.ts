/** 行内编辑：把界面上的字符串草稿安全地转成 RawRecord，并给出变更清单（P10）。 */

import { centsToYuan, toCents } from './money'
import { serialToIso } from './defaults'
import type { RawRecord } from './types'

export type EditableKey =
  | 'buyDate'
  | 'buyPrice'
  | 'buyQty'
  | 'targetPrice'
  | 'soldQty'
  | 'sellDate'
  | 'earlyBuyPrice'

export type EditKind = 'money' | 'qty' | 'date'

export const EDITABLE: { key: EditableKey; label: string; kind: EditKind }[] = [
  { key: 'buyDate', label: '买入日期', kind: 'date' },
  { key: 'buyPrice', label: '买入价', kind: 'money' },
  { key: 'buyQty', label: '买入份额', kind: 'qty' },
  { key: 'targetPrice', label: '目标售价', kind: 'money' },
  { key: 'soldQty', label: '已卖份额', kind: 'qty' },
  { key: 'sellDate', label: '卖出日期', kind: 'date' },
  { key: 'earlyBuyPrice', label: '回补价（P 列）', kind: 'money' },
]

export const LABEL: Record<EditableKey, string> = {
  buyDate: '买入日期',
  buyPrice: '买入价',
  buyQty: '买入份额',
  targetPrice: '目标售价',
  soldQty: '已卖份额',
  sellDate: '卖出日期',
  earlyBuyPrice: '回补价（P 列）',
}

/** ISO 日期 → Excel 序列号（1900 系统） */
export function isoToSerial(iso: string): number | null {
  const s = iso.trim()
  if (s === '') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const serial = Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000)
  // 用反解校验，挡掉 2026-13-45 这种会被 Date 自动进位的写法
  if (serial <= 0 || serialToIso(serial) !== s) return null
  return serial
}

export function fieldText(rec: RawRecord, key: EditableKey): string {
  switch (key) {
    case 'buyDate':
      return serialToIso(rec.buyDateSerial) ?? ''
    case 'buyPrice':
      return rec.buyPriceCents === null ? '' : centsToYuan(rec.buyPriceCents)
    case 'buyQty':
      return rec.buyQtyRaw === null ? '' : String(rec.buyQtyRaw)
    case 'targetPrice':
      return rec.targetPriceCents === null ? '' : centsToYuan(rec.targetPriceCents)
    case 'soldQty':
      return rec.soldQty === null ? '' : String(rec.soldQty)
    case 'sellDate':
      return serialToIso(rec.sellDateSerial) ?? ''
    case 'earlyBuyPrice':
      return rec.earlyBuyPriceCents === null ? '' : centsToYuan(rec.earlyBuyPriceCents)
  }
}

export interface Change {
  field: EditableKey
  label: string
  oldValue: string
  newValue: string
}

export interface ApplyResult {
  record: RawRecord
  changes: Change[]
  errors: string[]
}

/** 把草稿（全是字符串，空串表示清空）应用到一条记录上 */
export function applyEdits(rec: RawRecord, draft: Partial<Record<EditableKey, string>>): ApplyResult {
  const next: RawRecord = { ...rec }
  const changes: Change[] = []
  const errors: string[] = []

  const push = (field: EditableKey, oldValue: string, newValue: string) => {
    if (oldValue !== newValue) {
      changes.push({ field, label: LABEL[field], oldValue: oldValue || '（空）', newValue: newValue || '（空）' })
    }
  }

  for (const { key, kind } of EDITABLE) {
    const raw = draft[key]
    if (raw === undefined) continue
    const text = raw.trim()

    if (kind === 'money') {
      const cents = text === '' ? null : toCents(text)
      if (text !== '' && cents === null) {
        errors.push(`${LABEL[key]} 不是合法金额：${text}`)
        continue
      }
      if (cents !== null && cents <= 0) errors.push(`${LABEL[key]} 必须大于 0`)
      const before = fieldText(rec, key)
      const after = cents === null ? '' : centsToYuan(cents)
      push(key, before, after)
      if (key === 'buyPrice') next.buyPriceCents = cents
      if (key === 'targetPrice') {
        next.targetPriceCents = cents
        // 手改过的目标价不再由公式派生
        if (cents !== null) next.targetNeedsDerive = false
      }
      if (key === 'earlyBuyPrice') next.earlyBuyPriceCents = cents
    } else if (kind === 'qty') {
      let q: number | null = null
      if (text !== '') {
        const n = Number(text.replace(/,/g, ''))
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          errors.push(`${LABEL[key]} 必须是整数股：${text}`)
          continue
        }
        q = n
        if (q < 0) errors.push(`${LABEL[key]} 不能为负`)
      }
      const before = fieldText(rec, key)
      const after = q === null ? '' : String(q)
      push(key, before, after)
      if (key === 'buyQty') {
        next.buyQtyRaw = q
        if (q !== null) next.qtyNeedsDerive = false
      }
      if (key === 'soldQty') next.soldQty = q
    } else {
      const serial = text === '' ? null : isoToSerial(text)
      if (text !== '' && serial === null) {
        errors.push(`${LABEL[key]} 要写成 YYYY-MM-DD：${text}`)
        continue
      }
      const before = fieldText(rec, key)
      const after = serial === null ? '' : (serialToIso(serial) ?? '')
      push(key, before, after)
      if (key === 'buyDate') next.buyDateSerial = serial
      if (key === 'sellDate') next.sellDateSerial = serial
    }
  }

  if (errors.length === 0 && changes.length > 0) next.editedAt = Date.now()
  return { record: next, changes, errors }
}

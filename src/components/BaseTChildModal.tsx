/**
 * 底仓做T「买入拆分 → 子单」弹窗（m00139）。
 *
 * 点拆单按钮时若用户填了买入价/股数就带进来，没填则留空由用户填（留空点确认取 placeholder）。
 * 只需再选一个回补日期，确认即走 store 的 recordRebuy（带 date）生成一笔
 * 真实回补：虚拟批次 lot:exec:*、走 saveBooking/价格树/盈亏全套，默认已完成，
 * 只挂在父记录详情里展示，不进明细列表。
 *
 * V9.79：同一个弹窗兼作「改子单」——传 `editing` 时预填这笔成交的价量日期，
 * 确认走 store 的 editRebuy 原地改（不新增批次）。日期允许晚于卖出日（先卖后买口径）。
 */
import { useState } from 'react'
import { Button, Input, Modal, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { BookingCheck, useBookingCheck } from './BookingCheck'
import { centsToYuan, toCents } from '../domain/money'
import { inputOrDefault } from '../domain/formDefaults'
import { enterSubmit } from '../ui/enterSave'
import { DateField } from '../ui/DateField'
import { qty, todayIso } from '../ui/format'
import { serialToIso } from '../domain/defaults'
import { isoToSerial } from '../domain/edit'

export interface BaseTChildSeed {
  sourceRow: number
  stockName: string
  /** 拆单按钮上已填的买入价（元字符串，可能为空） */
  priceText: string
  /** 拆单按钮上已填的股数（字符串，可能为空） */
  qtyText: string
  /** 买入价兜底（用户未填时作为 placeholder，不强制带入） */
  pricePlaceholder: string
  /** 拆分上限（股数兜底 placeholder） */
  qtyPlaceholder: string
}

/** V9.79：改一笔已有子单时传进来的现值 */
export interface BaseTChildEditing {
  /** RebuyExecution.id */
  id: string
  /** 父底仓做T记录的 sourceRow（取 order / 标题用） */
  sourceRow: number
  stockName: string
  qty: number
  priceCents: number
  /** YYYY-MM-DD */
  dateIso: string
}

export function BaseTChildModal({
  seed,
  editing,
  onClose,
}: {
  seed: BaseTChildSeed
  editing?: BaseTChildEditing
  onClose: () => void
}) {
  const { ledger, recordRebuy, editRebuy, recordNo, removeBuyTarget } = useApp()
  const sourceRow = editing?.sourceRow ?? seed.sourceRow
  const stockName = editing?.stockName ?? seed.stockName
  const order = ledger.orders.find((o) => o.sourceRow === sourceRow)
  const no = recordNo.of(sourceRow)
  const isEdit = editing !== undefined
  // 新建：用户填了才带入，没填留空，placeholder 既是提示也是确认时的默认值（V9.79）。
  // 改子单：直接预填现值，改哪个填哪个。
  const [qText, setQText] = useState(isEdit ? String(editing.qty) : seed.qtyText.trim())
  const [pText, setPText] = useState(isEdit ? centsToYuan(editing.priceCents) : seed.priceText.trim())
  const [date, setDate] = useState(isEdit ? editing.dateIso : todayIso())
  const [saving, setSaving] = useState(false)

  const qtyPlaceholder = isEdit ? String(editing.qty) : seed.qtyPlaceholder
  const pricePlaceholder = isEdit ? centsToYuan(editing.priceCents) : seed.pricePlaceholder
  const priceCents = toCents(inputOrDefault(pText, pricePlaceholder))
  const q = Number(inputOrDefault(qText, qtyPlaceholder))
  const normalizedDate = serialToIso(isoToSerial(date)) ?? todayIso()
  const check = useBookingCheck('base-t-child', {
    side: 'buy',
    stockName,
    date: normalizedDate,
    priceCents,
    qty: Number.isInteger(q) && q > 0 ? q : 0,
  }, [sourceRow, editing?.id, pText, qText, normalizedDate])

  async function save() {
    if (saving || (!order && !isEdit)) return
    setSaving(true)
    try {
      const buyQty = Number(inputOrDefault(qText, qtyPlaceholder))
      const p = toCents(inputOrDefault(pText, pricePlaceholder))
      if (!Number.isInteger(buyQty) || buyQty <= 0) throw new Error('回补股数要填正整数')
      if (p === null || p <= 0) throw new Error('回补价不合法')
      const iso = serialToIso(isoToSerial(date))
      if (!iso) throw new Error('回补日期不合法')

      if (isEdit) {
        await editRebuy(editing.id, { qty: buyQty, priceCents: p, dateIso: iso })
        check.completed()
        notificationOpen({
          message: '子单已修改',
          description: `${qty(buyQty)} 股 @ ${centsToYuan(p)} 元 · ${iso}`,
          type: 'success',
        })
        onClose()
        return
      }

      // m00139：点拆分直接生成子明细，不再走「先拆档→再记成交」两步。
      // 清掉这条卖单上可能残留的手动拆分档，避免旧档与子单重复挂待买。
      for (const b of ledger.buySplits) {
        if (b.sourceRow === seed.sourceRow && b.targetId !== null) {
          await removeBuyTarget(b.targetId)
        }
      }
      const receipt = await recordRebuy(order!, buyQty, p, 0, '底仓做T子单', undefined, check.options(), iso)
      check.completed()
      notificationOpen({
        message: '已生成底仓做T子单',
        description: `编号 ${receipt.id} · ${qty(buyQty)} 股 @ ${centsToYuan(p)} 元 · ${iso}，仅在本记录详情显示`,
        type: 'success',
      })
      onClose()
    } catch (e) {
      notificationOpen({
        message: isEdit ? '修改子单失败' : '生成子单失败',
        description: e instanceof Error ? e.message : String(e),
        type: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      className="booking-modal"
      title={`${stockName} · ${no === null ? `第 ${sourceRow} 行` : `第 ${no} 笔`}底仓做T回补子单${isEdit ? '（修改）' : ''}`}
      typewriter={false}
      onClose={() => !saving && onClose()}
      footer={
        <div className="row nowrap" style={{ gap: 8 }}>
          <Button type="primary" data-emphasis="true" data-action="base-t-child-save" style={{ flex: 1 }} disabled={saving} onClick={() => void save()}>确认</Button>
          <Button disabled={saving} onClick={onClose}>取消</Button>
        </div>
      }
    >
      <div className="stack tight" onKeyDown={enterSubmit(() => void save())}>
        <BookingCheck check={check} compact />
        <p className="tiny muted" style={{ margin: 0 }}>
          {isEdit
            ? '改的是这一笔真实回补：价、量、日期都会重算持仓、做T价差与统计日历。买入日期可以晚于卖出日期。'
            : '子单是真实回补，生成后计入持仓、恢复做T目标价；默认已完成，只在这条底仓做T记录的详情里显示。'}
        </p>
        <div className="form-grid">
          <label>
            <span>回补股数</span>
            <Input value={qText} onChange={(e) => setQText(e.target.value)} placeholder={qtyPlaceholder} data-field="base-t-child-qty" />
          </label>
          <label>
            <span>回补价（元）</span>
            <Input value={pText} onChange={(e) => setPText(e.target.value)} placeholder={pricePlaceholder} data-field="base-t-child-price" />
          </label>
          <label>
            <span>回补日期</span>
            <DateField value={date} onChange={setDate} data-field="base-t-child-date" />
          </label>
        </div>
      </div>
    </Modal>
  )
}

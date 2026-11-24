/**
 * 底仓做T「买入拆分 → 子单」弹窗（m00139）。
 *
 * 点拆单按钮时若用户填了买入价/股数就带进来，没填则留空由用户填。
 * 只需再选一个回补日期，确认即走 store 的 recordRebuy（带 date）生成一笔
 * 真实回补：虚拟批次 lot:exec:*、走 saveBooking/价格树/盈亏全套，默认已完成，
 * 只挂在父记录详情里展示，不进明细列表。
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

export function BaseTChildModal({ seed, onClose }: { seed: BaseTChildSeed; onClose: () => void }) {
  const { ledger, recordRebuy, recordNo, removeBuyTarget } = useApp()
  const order = ledger.orders.find((o) => o.sourceRow === seed.sourceRow)
  const no = recordNo.of(seed.sourceRow)
  // 用户填了才带入；没填留空，placeholder 只做提示，确认时必填。
  const [qText, setQText] = useState(seed.qtyText.trim())
  const [pText, setPText] = useState(seed.priceText.trim())
  const [date, setDate] = useState(todayIso())
  const [saving, setSaving] = useState(false)

  const priceCents = toCents(inputOrDefault(pText, ''))
  const q = Number(inputOrDefault(qText, ''))
  const normalizedDate = serialToIso(isoToSerial(date)) ?? todayIso()
  const check = useBookingCheck('base-t-child', {
    side: 'buy',
    stockName: seed.stockName,
    date: normalizedDate,
    priceCents,
    qty: Number.isInteger(q) && q > 0 ? q : 0,
  }, [seed.sourceRow, pText, qText, normalizedDate])

  async function save() {
    if (saving || !order) return
    setSaving(true)
    try {
      const buyQty = Number(inputOrDefault(qText, ''))
      const p = toCents(inputOrDefault(pText, ''))
      if (!Number.isInteger(buyQty) || buyQty <= 0) throw new Error('回补股数要填正整数')
      if (p === null || p <= 0) throw new Error('回补价不合法')
      const iso = serialToIso(isoToSerial(date))
      if (!iso) throw new Error('回补日期不合法')

      // m00139：点拆分直接生成子明细，不再走「先拆档→再记成交」两步。
      // 清掉这条卖单上可能残留的手动拆分档，避免旧档与子单重复挂待买。
      for (const b of ledger.buySplits) {
        if (b.sourceRow === seed.sourceRow && b.targetId !== null) {
          await removeBuyTarget(b.targetId)
        }
      }
      const receipt = await recordRebuy(order, buyQty, p, 0, '底仓做T子单', undefined, check.options(), iso)
      check.completed()
      notificationOpen({
        message: '已生成底仓做T子单',
        description: `编号 ${receipt.id} · ${qty(buyQty)} 股 @ ${centsToYuan(p)} 元 · ${iso}，仅在本记录详情显示`,
        type: 'success',
      })
      onClose()
    } catch (e) {
      notificationOpen({ message: '生成子单失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      className="booking-modal"
      title={`${seed.stockName} · ${no === null ? `第 ${seed.sourceRow} 行` : `第 ${no} 笔`}底仓做T回补子单`}
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
          子单是真实回补，生成后计入持仓、恢复做T目标价；默认已完成，只在这条底仓做T记录的详情里显示。
        </p>
        <div className="form-grid">
          <label>
            <span>回补股数</span>
            <Input value={qText} onChange={(e) => setQText(e.target.value)} placeholder={seed.qtyPlaceholder} data-field="base-t-child-qty" />
          </label>
          <label>
            <span>回补价（元）</span>
            <Input value={pText} onChange={(e) => setPText(e.target.value)} placeholder={seed.pricePlaceholder} data-field="base-t-child-price" />
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

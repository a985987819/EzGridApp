/**
 * 先卖后买的「按档记成交」（V9.68）。
 *
 * 一档买入 = 一笔真实成交：数量、价格、奖励股都可以按这一档单独填；
 * 账务仍走 store 的 recordRebuy(order, ..., split.key)——校验、回执、成交流水
 * 全部复用，只有入口是新的。用完关掉本弹窗，父层拆分弹窗继续开着，
 * 于是可以连续把几档都记完（用户口径：补买入可以分为多笔）。
 */
import { useState } from 'react'
import { Button, Input, Modal, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { BookingCheck, useBookingCheck } from './BookingCheck'
import { centsToYuan, toCents } from '../domain/money'
import { inputOrDefault } from '../domain/formDefaults'
import { enterSubmit } from '../ui/enterSave'
import { qty, todayIso } from '../ui/format'
import type { BuySplit } from '../domain/types'

export function SplitExecModal({ split, onClose }: { split: BuySplit; onClose: () => void }) {
  const { ledger, recordRebuy, recordNo } = useApp()
  const order = ledger.orders.find((o) => o.id === split.orderId)
  const sellNo = recordNo.of(split.sourceRow)
  // V9.79：价/量留空，直接点确认就取 placeholder（这一档的默认价量），只在手改时才用实际值。
  const [qText, setQText] = useState('')
  const [pText, setPText] = useState('')
  const [rText, setRText] = useState('')
  const [saving, setSaving] = useState(false)

  const check = useBookingCheck('split-rebuy', {
    side: 'buy',
    stockName: split.stockName,
    date: todayIso(),
    priceCents: toCents(inputOrDefault(pText, centsToYuan(split.priceCents))),
    qty: Number(inputOrDefault(qText, String(split.qty))),
  }, [split.key, qText, pText, rText])

  async function save() {
    if (saving || !order) return
    setSaving(true)
    try {
      const q = Number(inputOrDefault(qText, String(split.qty)))
      const p = toCents(inputOrDefault(pText, centsToYuan(split.priceCents)))
      const r = Number(inputOrDefault(rText, '0'))
      if (!Number.isInteger(q) || q <= 0) throw new Error('成交股数要填正整数')
      if (p === null || p <= 0) throw new Error('成交价不合法')
      if (!Number.isInteger(r) || r < 0) throw new Error('奖励股数不合法')
      // splitKey 让 store 按来源档扣量，并把 buyTargetId 写进成交；不会错位冲抵别的档
      const receipt = await recordRebuy(order, q, p, r, undefined, split.key, check.options())
      check.completed()
      notificationOpen({
        message: '已记这一档的成交',
        description: `编号 ${receipt.id} · ${qty(q)} 股 @ ${centsToYuan(p)} 元`,
        type: 'success',
      })
      onClose()
    } catch (e) {
      notificationOpen({ message: '记录失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      className="booking-modal"
      title={`${split.stockName} · ${sellNo === null ? `第 ${split.sourceRow} 行` : `第 ${sellNo} 笔`}买入档记成交`}
      typewriter={false}
      onClose={() => !saving && onClose()}
      footer={
        <div className="row nowrap" style={{ gap: 8 }}>
          <Button type="primary" data-emphasis="true" style={{ flex: 1 }} disabled={saving} onClick={() => void save()}>记成交</Button>
          <Button disabled={saving} onClick={onClose}>取消</Button>
        </div>
      }
    >
      <div className="stack tight" onKeyDown={enterSubmit(() => void save())}>
        <BookingCheck check={check} />
        <p className="tiny muted" style={{ margin: 0 }}>
          这一档可成交 {qty(split.qty)} 股，其中基础股 {qty(split.baseRemainingQty)} 股；
          奖励股只在对应额度内有效。多档可以分别记，合计不会超过这笔卖出量。
        </p>
        <div className="form-grid">
          <label>
            <span>成交股数</span>
            <Input value={qText} onChange={(e) => setQText(e.target.value)} placeholder={String(split.qty)} data-field="split-exec-qty" />
          </label>
          <label>
            <span>成交价</span>
            <Input value={pText} onChange={(e) => setPText(e.target.value)} placeholder={centsToYuan(split.priceCents)} data-field="split-exec-price" />
          </label>
          <label>
            <span>奖励股数（可空，默认 0）</span>
            <Input value={rText} onChange={(e) => setRText(e.target.value)} placeholder="0" data-field="split-exec-reward" />
          </label>
        </div>
      </div>
    </Modal>
  )
}

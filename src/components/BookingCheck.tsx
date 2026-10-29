import { useMemo, useState } from 'react'
import { Button, Input } from 'animal-island-ui'
import { similarFacts, tradeFacts, type BookingOptions } from '../domain/booking'
import { useApp } from '../store/useApp'
import { bookingDraft, clearBookingDraft } from '../ui/bookingDraft'
import { navigateManage } from '../ui/nav'
import { money, price, qty } from '../ui/format'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'

export function useBookingCheck(scope: string, fact: { side: 'buy' | 'sell'; stockName: string; date: string | null; priceCents: number | null; qty: number }, payload: unknown) {
  const { records, executions, bookingReceipts } = useApp()
  const [externalRef, setExternalRef] = useState('')
  const [allowedSignature, setAllowedSignature] = useState('')
  const signature = JSON.stringify([payload, externalRef])
  const normalizedDate = serialToIso(isoToSerial(fact.date ?? ''))
  const facts = useMemo(() => tradeFacts(records, executions, bookingReceipts), [records, executions, bookingReceipts])
  const candidates = useMemo(() => similarFacts(facts, fact.side, fact.stockName, normalizedDate, fact.priceCents ?? 0, fact.qty),
    [facts, fact.side, fact.stockName, normalizedDate, fact.priceCents, fact.qty])
  return { fact, externalRef, setExternalRef, candidates, allowed: allowedSignature === signature,
    allow: (value: boolean) => setAllowedSignature(value ? signature : ''),
    options: (): BookingOptions => ({ commandId: bookingDraft(scope, signature), externalRef, allowSimilar: allowedSignature === signature }),
    reset: () => { setExternalRef(''); setAllowedSignature('') },
    completed: () => { clearBookingDraft(scope); setExternalRef(''); setAllowedSignature('') },
  }
}

export function BookingCheck({ check }: { check: ReturnType<typeof useBookingCheck> }) {
  const { fact } = check
  return <div className="stack tight booking-check" data-testid="booking-check">
    <p className="hint-block">本次实际{fact.side === 'buy' ? '买入' : '卖出'} {qty(fact.qty)} 股 × {price(fact.priceCents)}，金额 {money(fact.priceCents === null ? null : fact.priceCents * fact.qty)}。{fact.side === 'buy' && '买回形成库存只算一次，尚未卖出不增加后续回本盈利。'}</p>
    <label><span>来源凭据号（可选）</span><Input value={check.externalRef} onChange={e => check.setExternalRef(e.target.value)} placeholder="例如：券商名称/成交日期/成交编号" data-field="booking-ref" /></label>
    <p className="tiny muted">每笔实际成交使用独立成交号；同一委托下的多笔成交需分别填写。</p>
    {check.candidates.length > 0 && <div className="hint-block" role="status" data-testid="booking-duplicates">
      <strong>已有同股同日同价同量成交，请先核对</strong>
      {check.candidates.map(c => <div key={c.id} className="tiny" style={{ overflowWrap: 'anywhere' }}>{c.source} · {c.id} · {c.date ?? '日期待补'} · {qty(c.qty)} 股</div>)}
      <label className="row"><input type="checkbox" checked={check.allowed} onChange={e => check.allow(e.target.checked)} data-field="booking-allow-similar" />已核对，确认本次是另一笔真实成交</label>
    </div>}
    <Button size="small" onClick={() => navigateManage({ section: 'activity' })}>已经记过？查看成交流水，不再新增</Button>
  </div>
}

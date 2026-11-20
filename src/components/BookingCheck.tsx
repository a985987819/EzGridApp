import { useMemo, useState } from 'react'
import { Button } from 'animal-island-ui'
import { similarFacts, tradeFacts, type BookingOptions } from '../domain/booking'
import { useApp } from '../store/useApp'
import { bookingDraft, clearBookingDraft } from '../ui/bookingDraft'
import { navigateManage } from '../ui/nav'
import { money, price, qty } from '../ui/format'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'

export function useBookingCheck(scope: string, fact: { side: 'buy' | 'sell'; stockName: string; date: string | null; priceCents: number | null; qty: number }, payload: unknown) {
  const { records, executions, bookingReceipts } = useApp()
  const [allowedSignature, setAllowedSignature] = useState('')
  // 用户不填来源凭据号：签名只按本次事实派生，幂等编号由系统生成。
  // externalRef 仍是回执/备份的合法字段，只在导入、恢复等系统路径沿用，不来自表单。
  const signature = JSON.stringify([payload])
  const normalizedDate = serialToIso(isoToSerial(fact.date ?? ''))
  const facts = useMemo(() => tradeFacts(records, executions, bookingReceipts), [records, executions, bookingReceipts])
  const candidates = useMemo(() => similarFacts(facts, fact.side, fact.stockName, normalizedDate, fact.priceCents ?? 0, fact.qty),
    [facts, fact.side, fact.stockName, normalizedDate, fact.priceCents, fact.qty])
  return { fact, candidates, allowed: allowedSignature === signature,
    allow: (value: boolean) => setAllowedSignature(value ? signature : ''),
    options: (): BookingOptions => ({ commandId: bookingDraft(scope, signature), allowSimilar: allowedSignature === signature }),
    reset: () => setAllowedSignature(''),
    completed: () => { clearBookingDraft(scope); setAllowedSignature('') },
  }
}

/**
 * 成交前校验。来源凭据号不是可填项：它由导入/恢复等系统路径写入回执，
 * 用户录入只按本次事实生成成交编号，不再增加一次填写负担。
 * compact（明细「新增一笔」等弹窗）再把上方压成一行摘要、隐藏查看流水按钮；
 * 真正必须人工确认的「疑似重复成交」仍完整保留（去重是账务安全闸，不能省）。
 */
export function BookingCheck({ check, compact = false }: { check: ReturnType<typeof useBookingCheck>; compact?: boolean }) {
  const { fact } = check
  return <div className={`stack tight booking-check${compact ? ' compact' : ''}`} data-testid="booking-check">
    <p className={compact ? 'tiny muted' : 'hint-block'}>本次实际{fact.side === 'buy' ? '买入' : '卖出'} {qty(fact.qty)} 股 × {price(fact.priceCents)}，金额 {money(fact.priceCents === null ? null : fact.priceCents * fact.qty)}。{!compact && fact.side === 'buy' && '买回形成库存只算一次，尚未卖出不增加后续回本盈利。'}</p>
    {check.candidates.length > 0 && <div className="hint-block" role="status" data-testid="booking-duplicates">
      <strong>已有同股同日同价同量成交，请先核对</strong>
      {check.candidates.map(c => <div key={c.id} className="tiny" style={{ overflowWrap: 'anywhere' }}>{c.source} · {c.id} · {c.date ?? '日期待补'} · {qty(c.qty)} 股</div>)}
      <label className="row"><input type="checkbox" checked={check.allowed} onChange={e => check.allow(e.target.checked)} data-field="booking-allow-similar" />已核对，确认本次是另一笔真实成交</label>
    </div>}
    {!compact && <Button size="small" onClick={() => navigateManage({ section: 'activity' })}>已经记过？查看成交流水，不再新增</Button>}
  </div>
}

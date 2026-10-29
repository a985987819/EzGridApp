import { useMemo, useState } from 'react'
import { Button, Card, Input, Tag, notificationOpen } from 'animal-island-ui'
import { tradeFacts } from '../../domain/booking'
import { useApp } from '../../store/useApp'
import { money, price, qty } from '../../ui/format'
import { buildNanoIdIndex } from '../../ui/nanoid'
import type { TradesQuery } from '../../ui/nav'

export function ManageActivity({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
  const { records, executions, bookingReceipts, reviewBooking, voidBooking, recordNo } = useApp()
  const [query, setQuery] = useState('')
  const [pendingOnly, setPendingOnly] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const facts = useMemo(() => tradeFacts(records, executions, bookingReceipts), [records, executions, bookingReceipts])
  const nano = useMemo(() => buildNanoIdIndex(records), [records])
  const shown = facts.filter(f => (!pendingOnly || (!f.reviewed && !f.voided)) && (!query.trim() || `${f.stockName} ${f.id} ${f.externalRef ?? ''} ${f.date ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())))
  return <div className="stack" data-testid="trade-activity">
    <Card><strong>成交流水与核对</strong><p className="tiny muted">一次真实成交只列一次；合并成交可分配到多笔记录。成本分配、回本链分支与生成的库存不另算成交。历史同行买卖按两个方向分别展示。</p>
      <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索股票、日期、成交编号或凭据号" aria-label="搜索成交流水" />
      <label className="row"><input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} />只看待核对</label>
      <p className="tiny muted">共 {facts.length} 条 · 待核对 {facts.filter(f => !f.reviewed && !f.voided).length} 条。核对状态只表示与凭据核验结果。</p>
    </Card>
    <Card>{shown.length === 0 && <div className="empty-box">没有匹配的成交</div>}{shown.map(f => <div className="line wrap-row" key={f.id} data-booking-id={f.id}>
      <div className="left" style={{ minWidth: 0 }}><div className="t1">{f.stockName} · 实际{f.side === 'buy' ? '买入' : '卖出'} <b>{qty(f.qty)} 股 × {price(f.priceCents)}</b></div>
        <div className="t2">{f.date ?? '日期待补'} · {money(f.priceCents === null ? null : f.priceCents * f.qty)} · {f.source}</div>
        <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>编号 {f.id}{f.externalRef && ` · 凭据 ${f.externalRef}`}</div>
        <div className="tag-row"><Tag size="small">{f.voided ? '已撤销' : f.reviewed ? '已与凭据核对' : '已记账待核对'}</Tag>
          {f.rows.map(row => <Button key={row} size="small" onClick={() => goTrades({ id: nano.rowToId.get(row), stock: f.stockName, del: true, showDone: true })}>查看第 {recordNo.of(row)} 笔分配</Button>)}
          {f.executionIds.map(id => <span className="tiny" key={id}>回补分配 {executions.find(e => e.id === id)?.qty ?? '—'} 股</span>)}
        </div>
      </div>
      {!f.voided && <Button size="small" disabled={busy !== null} onClick={async () => { setBusy(f.id); try { await reviewBooking(f.id, !f.reviewed) } catch (e) { notificationOpen({ message: '核对未保存', description: String(e), type: 'error' }) } finally { setBusy(null) } }}>{f.reviewed ? '改为待核对' : '已与凭据核对'}</Button>}
      {!f.voided && bookingReceipts.some(r => r.id === f.id) && <Button size="small" disabled={busy !== null} onClick={async () => {
        const dependents = records.filter(r => r.soldLotId && (f.rows.some(row => r.soldLotId === `lot:${row}`) || f.executionIds.some(id => r.soldLotId === `lot:exec:${id}`)))
        const after = executions.filter(e => f.rows.some(row => e.sellExecId === `sell:${row}`))
        if (!window.confirm(`撤销整笔 ${f.qty} 股成交及 ${f.rows.length + f.executionIds.length} 份分配？\n后续卖出/历史引用 ${dependents.length} 笔，后续回补 ${after.length} 笔；有依赖会阻止撤销。`)) return
        setBusy(f.id); try { await voidBooking(f.id); notificationOpen({ message: '整笔成交已撤销', type: 'success' }) } catch (e) { notificationOpen({ message: '无法撤销', description: String(e), type: 'error' }) } finally { setBusy(null) }
      }}>撤销整笔</Button>}
    </div>)}</Card>
  </div>
}

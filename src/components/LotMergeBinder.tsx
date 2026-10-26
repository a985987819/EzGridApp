/**
 * 合并同价买单（V9.45）：几笔同股票、同买入价、还没卖完的批次绑成一组。
 *
 * **只做关联，不改数据**：records 里各自的数量 / 买入日期原样保留，
 * 挂单页「待卖」提醒按组合并显示（数量相加、日期取最早）；解除即恢复逐笔。
 * 关联存在 merges 表，备份 schemaVersion 8 一起带走。
 */
import { useMemo, useState } from 'react'
import { Button, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { recordNoLabel } from '../domain/recordNo'
import type { Lot } from '../domain/types'
import { price, qty } from '../ui/format'

function earliestOf(lots: Lot[]): string | null {
  let out: string | null = null
  for (const l of lots) {
    if (!l.buyDate) continue
    if (out === null || l.buyDate < out) out = l.buyDate
  }
  return out
}

export function LotMergeBinder({ row }: { row: number }) {
  const { ledger, merges, records, recordNo, setLotMerge, clearLotMerge } = useApp()
  const lot = ledger.lots.find((l) => l.id === `lot:${row}`) ?? null
  const rec = records.find((r) => r.sourceRow === row) ?? null
  const group = lot ? merges.find((m) => m.rows.includes(row)) ?? null : null

  /** 候选：同股票、同买入价、还没卖完的真实批次（回补虚拟批次不在里面） */
  const candidates = useMemo(() => {
    if (!lot) return []
    return ledger.lots
      .filter((l) => l.id === `lot:${l.sourceRow}` && l.remainingQty > 0)
      .filter((l) => l.stockName === lot.stockName && l.buyPriceCents === lot.buyPriceCents)
      .sort((a, b) => (a.buyDate ?? '9999').localeCompare(b.buyDate ?? '9999') || a.sourceRow - b.sourceRow)
  }, [ledger.lots, lot])

  const initial = () => {
    const active = (group?.rows ?? []).filter((r) => candidates.some((c) => c.sourceRow === r))
    return active.length >= 2 ? active : [row]
  }
  const [selected, setSelected] = useState<number[]>(initial)

  if (!lot || !rec || lot.remainingQty <= 0 || candidates.length < 2) return null

  const picked = candidates.filter((c) => selected.includes(c.sourceRow))
  const totalQty = picked.reduce((a, c) => a + c.remainingQty, 0)
  const earliest = earliestOf(picked)

  const toggle = (r: number) =>
    setSelected((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r].sort((a, b) => a - b)))

  async function save() {
    try {
      await setLotMerge(selected)
      notificationOpen({
        message: `已合并 ${selected.length} 笔同价买单`,
        description: '只影响挂单页「待卖」的合并显示，明细数据没动',
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '合并失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function clear() {
    await clearLotMerge(row)
    setSelected([row])
    notificationOpen({ message: '已解除合并', description: '挂单页恢复逐笔显示', type: 'success' })
  }

  return (
    <div className="divider-top" data-testid="merge-binder">
      <div className="sec-head sm">
        <strong>合并同价买单</strong>
        <div className="spacer" />
        <span className="sec-sub">买入价 {price(lot.buyPriceCents)}</span>
      </div>
      <div className="data-block" data-testid="merge-candidates">
        {candidates.map((c) => (
          <label key={c.sourceRow} className="line merge-row" data-merge-candidate={c.sourceRow}>
            <input
              type="checkbox"
              checked={selected.includes(c.sourceRow)}
              onChange={() => toggle(c.sourceRow)}
              aria-label={`合并 ${recordNoLabel(c.sourceRow, recordNo)}`}
            />
            <div className="left">
              <div className="t1">
                {recordNoLabel(c.sourceRow, recordNo)}
                {c.sourceRow === row && <span className="muted" style={{ fontWeight: 400 }}> · 当前</span>}
              </div>
              <div className="t2">
                买入 {price(c.buyPriceCents)} · {c.buyDate ?? '—'} · 剩余 {qty(c.remainingQty)} 股
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="row nowrap" style={{ gap: 6, marginTop: 8 }}>
        <span className="tiny muted grow">
          已选 {picked.length} 笔 · 合计 {qty(totalQty)} 股 · 最早 {earliest ?? '—'}
        </span>
        <Button size="small" type="primary" data-action="merge-save" disabled={picked.length < 2} onClick={() => void save()}>
          保存合并
        </Button>
        {group && <Button size="small" data-action="merge-clear" onClick={() => void clear()}>解除</Button>}
      </div>
      <p className="tiny muted" style={{ margin: '6px 0 0' }}>
        只影响挂单页「待卖」提醒：合并后数量相加、日期取最早的那笔；每笔明细的数量和买入日期都不改。
      </p>
    </div>
  )
}

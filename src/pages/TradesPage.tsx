import { Fragment, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { centsToYuan } from '../domain/money'
import { serialToIso } from '../domain/defaults'
import { EDITABLE, fieldText, type EditableKey } from '../domain/edit'
import { isoDate, money, price, qty, signedMoney, tone } from '../ui/format'
import { downloadText, toCsv } from '../ui/csv'
import type { Lot, RawRecord, SellExecution } from '../domain/types'

type StatusFilter = 'all' | 'holding' | 'soldout' | 'pending' | 'dateMissing' | 'needsPrice'

interface Row {
  rec: RawRecord
  lot: Lot | null
  sell: SellExecution | null
}

const BLANK_DRAFT = Object.fromEntries(EDITABLE.map((f) => [f.key, ''])) as Record<EditableKey, string>

export function TradesPage({
  focus,
  onClearFocus,
}: {
  focus: { stock: string; priceCents: number } | null
  onClearFocus: () => void
}) {
  const { ledger, records, stocks, editRecord, softDelete, restore, addManualRecord, historyOf } = useApp()
  const [stockFilter, setStockFilter] = useState(focus?.stock ?? 'all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [priceFilter, setPriceFilter] = useState<number | null>(focus?.priceCents ?? null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState<Record<EditableKey, string>>(BLANK_DRAFT)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [showDeleted, setShowDeleted] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ stockName: '', buyDate: '', buyPrice: '', buyQty: '', targetPrice: '' })

  const stockNames = useMemo(() => [...new Set(records.map((r) => r.stockName))], [records])

  const rows = useMemo<Row[]>(() => {
    const lotMap = new Map(ledger.lots.map((l) => [l.sourceRow, l]))
    const sellMap = new Map(ledger.sells.map((s) => [s.sourceRow, s]))
    return records
      .map((rec) => ({ rec, lot: lotMap.get(rec.sourceRow) ?? null, sell: sellMap.get(rec.sourceRow) ?? null }))
      .sort((a, b) => b.rec.sourceRow - a.rec.sourceRow)
  }, [records, ledger])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!showDeleted && r.rec.deletedAt) return false
      if (stockFilter !== 'all' && r.rec.stockName !== stockFilter) return false
      if (keyword && !String(r.rec.sourceRow).includes(keyword) && !r.rec.stockName.includes(keyword)) return false
      if (priceFilter !== null) {
        const prices = [
          r.rec.targetPriceCents,
          r.rec.buyPriceCents,
          r.sell?.priceCents ?? null,
          r.rec.earlyBuyPriceCents,
        ]
        if (!prices.includes(priceFilter)) return false
      }
      switch (status) {
        case 'holding':
          return (r.lot?.remainingQty ?? 0) > 0
        case 'soldout':
          return r.sell !== null && (r.lot?.remainingQty ?? 0) === 0
        case 'pending':
          return r.sell?.rebuyStatus === 'pending'
        case 'dateMissing':
          return r.sell?.dateMissing === true
        case 'needsPrice':
          return (r.sell !== null && r.sell.priceCents === null) || r.lot?.needsPrice === true
        default:
          return true
      }
    })
  }, [rows, stockFilter, keyword, priceFilter, status, showDeleted])

  function startEdit(r: Row) {
    const next = { ...BLANK_DRAFT }
    for (const f of EDITABLE) next[f.key] = fieldText(r.rec, f.key)
    setDraft(next)
    setEditing(r.rec.sourceRow)
    setError(null)
    setMsg(null)
    setExpanded(null)
  }

  async function save(row: number) {
    try {
      const n = await editRecord(row, draft)
      setMsg(n === 0 ? '没有改动' : `已保存，${n} 个字段写入变更历史`)
      setError(null)
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onDelete(row: number) {
    if (!window.confirm(`把第 ${row} 行标记为删除？软删除，可恢复，且会记入变更历史。`)) return
    await softDelete(row)
    setMsg(`第 ${row} 行已软删除`)
    setExpanded(null)
  }

  async function onRestore(row: number) {
    await restore(row)
    setMsg(`第 ${row} 行已恢复`)
  }

  async function onAdd() {
    try {
      if (!form.stockName) throw new Error('请选择股票')
      const row = await addManualRecord(form)
      setMsg(`已新增第 ${row} 行`)
      setError(null)
      setAdding(false)
      setForm({ stockName: '', buyDate: '', buyPrice: '', buyQty: '', targetPrice: '' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function exportCsv() {
    const head = ['行号', '来源', '股票', '买入日期', '买入价', '买入份额', '已卖', '剩余', '目标售价', '回补价', '卖出日期', '成交价', '实现盈利', '回补状态', '标记']
    const body = filtered.map((r) => [
      r.rec.sourceRow,
      r.rec.origin === 'manual' ? '手动' : 'Excel',
      r.rec.stockName,
      r.lot ? isoDate(r.lot.buyDate) : serialToIso(r.rec.buyDateSerial) ?? '',
      r.rec.buyPriceCents === null ? '' : centsToYuan(r.rec.buyPriceCents),
      r.lot?.qty ?? r.rec.buyQtyRaw ?? '',
      r.rec.soldQty ?? '',
      r.lot?.remainingQty ?? '',
      r.lot?.targetPriceCents === null || r.lot?.targetPriceCents === undefined ? '' : centsToYuan(r.lot.targetPriceCents),
      r.rec.earlyBuyPriceCents === null ? '' : centsToYuan(r.rec.earlyBuyPriceCents),
      r.sell?.soldAt ?? '',
      r.sell?.priceCents === null || r.sell?.priceCents === undefined ? '' : centsToYuan(r.sell.priceCents),
      r.sell?.profitCents === null || r.sell?.profitCents === undefined ? '' : (r.sell.profitCents / 100).toFixed(2),
      r.sell ? (r.sell.rebuyStatus === 'pending' ? '待回补' : '已回补') : '',
      [r.sell?.sellBeforeBuy ? '先卖后买' : '', r.sell?.dateMissing ? '缺日期' : '', r.rec.deletedAt ? '已删除' : ''].filter(Boolean).join(' '),
    ])
    downloadText('交易明细.csv', toCsv([head, ...body]), 'text/csv;charset=utf-8')
  }

  const cellInput = (key: EditableKey, kind: 'money' | 'qty' | 'date') => (
    <input
      className={`cell${kind === 'date' ? ' text' : ''}`}
      data-field={key}
      value={draft[key]}
      placeholder={kind === 'date' ? 'YYYY-MM-DD' : kind === 'qty' ? '股' : '元'}
      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
    />
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h2>明细</h2>
          <p>
            {filtered.length} / {rows.length} 行 · 一行 = 一个买入批次；改任一字段都会重算清单、并写入变更历史
          </p>
        </div>
        <div className="row">
          <button className="btn primary sm" onClick={() => setAdding((v) => !v)}>
            {adding ? '收起新增' : '新增一笔'}
          </button>
          <button className="btn ghost sm" onClick={exportCsv}>
            导出当前筛选 CSV
          </button>
        </div>
      </div>

      {adding && (
        <div className="card">
          <header>
            <h3>新增一笔</h3>
            <span className="hint">行号从 100000 起，标明「手动」，不影响 Excel 行号回溯</span>
          </header>
          <div className="body">
            <div className="row">
              <label className="field">
                股票
                <select
                  value={form.stockName}
                  onChange={(e) => setForm({ ...form, stockName: e.target.value })}
                >
                  <option value="">选择…</option>
                  {stocks.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                买入日期
                <input value={form.buyDate} placeholder="2026-10-23" onChange={(e) => setForm({ ...form, buyDate: e.target.value })} />
              </label>
              <label className="field">
                买入价
                <input value={form.buyPrice} placeholder="8.01" onChange={(e) => setForm({ ...form, buyPrice: e.target.value })} />
              </label>
              <label className="field">
                买入份额
                <input value={form.buyQty} placeholder="700" onChange={(e) => setForm({ ...form, buyQty: e.target.value })} />
              </label>
              <label className="field">
                目标售价
                <input value={form.targetPrice} placeholder="8.58" onChange={(e) => setForm({ ...form, targetPrice: e.target.value })} />
              </label>
              <button className="btn primary" onClick={() => void onAdd()}>保存</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="body">
          <div className="row">
            <label className="field">
              股票
              <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}>
                <option value="all">全部</option>
                {stockNames.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              状态
              <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="all">全部</option>
                <option value="holding">还有剩余持仓</option>
                <option value="soldout">已卖完</option>
                <option value="pending">待回补</option>
                <option value="dateMissing">缺卖出日期</option>
                <option value="needsPrice">缺价格</option>
              </select>
            </label>
            <label className="field">
              关键词
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="股票名 / 行号" />
            </label>
            <label className="row" style={{ fontSize: 12.5, color: 'var(--muted)', gap: 6 }}>
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
              显示已删除
            </label>
            {priceFilter !== null && (
              <button className="btn sm" onClick={() => { setPriceFilter(null); onClearFocus() }}>
                价格 {(priceFilter / 100).toFixed(2)} ×
              </button>
            )}
            <div className="spacer" />
            {msg && <span className="tag ok">{msg}</span>}
            {error && <span className="err">{error}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="body tight" style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead>
              <tr>
                <th>行</th>
                <th className="l">股票</th>
                <th>买入日期</th>
                <th>买入价</th>
                <th>份额</th>
                <th>已卖</th>
                <th>剩余</th>
                <th>目标价</th>
                <th>回补价</th>
                <th>卖出日期</th>
                <th>成交价</th>
                <th>实现盈利</th>
                <th className="l">标记</th>
                <th className="l">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isEditing = editing === r.rec.sourceRow
                const deleted = Boolean(r.rec.deletedAt)
                return (
                  <Fragment key={r.rec.sourceRow}>
                    <tr data-row={r.rec.sourceRow} style={deleted ? { opacity: 0.45 } : undefined}>
                      <td className="num muted">
                        {r.rec.origin === 'manual' ? '手动' : r.rec.sourceRow}
                        {r.rec.editedAt && <span className="edited-dot" title="改过" />}
                      </td>
                      <td className="l">{r.rec.stockName}</td>
                      <td className="num">{isEditing ? cellInput('buyDate', 'date') : (r.lot ? isoDate(r.lot.buyDate) : serialToIso(r.rec.buyDateSerial) ?? '—')}</td>
                      <td className="num">
                        {isEditing
                          ? cellInput('buyPrice', 'money')
                          : price(r.rec.buyPriceCents)}
                      </td>
                      <td className="num">{isEditing ? cellInput('buyQty', 'qty') : qty(r.lot?.qty ?? r.rec.buyQtyRaw)}</td>
                      <td className="num">{isEditing ? cellInput('soldQty', 'qty') : qty(r.rec.soldQty)}</td>
                      <td className="num">{r.lot ? qty(r.lot.remainingQty) : '—'}</td>
                      <td className="num">
                        {isEditing
                          ? cellInput('targetPrice', 'money')
                          : price(r.lot?.targetPriceCents ?? r.rec.targetPriceCents)}
                      </td>
                      <td className="num">
                        {isEditing ? cellInput('earlyBuyPrice', 'money') : price(r.rec.earlyBuyPriceCents)}
                      </td>
                      <td className="num">{isEditing ? cellInput('sellDate', 'date') : (r.sell ? isoDate(r.sell.soldAt) : '—')}</td>
                      <td className="num">{price(r.sell?.priceCents)}</td>
                      <td className={`num ${tone(r.sell?.profitCents ?? null)}`}>{signedMoney(r.sell?.profitCents ?? null)}</td>
                      <td className="l">
                        <span className="pill-row">
                          {r.sell?.rebuyStatus === 'pending' && <span className="tag warn">待回补</span>}
                          {r.sell?.sellBeforeBuy && <span className="tag">先卖后买</span>}
                          {r.sell?.dateMissing && <span className="tag warn">缺日期</span>}
                          {r.sell && r.sell.priceCents === null && <span className="tag bad">缺价格</span>}
                          {deleted && <span className="tag bad">已删除</span>}
                        </span>
                      </td>
                      <td className="l">
                        <div className="row-actions">
                          {isEditing ? (
                            <>
                              <button className="btn sm primary" onClick={() => void save(r.rec.sourceRow)}>保存</button>
                              <button className="btn sm ghost" onClick={() => setEditing(null)}>取消</button>
                            </>
                          ) : deleted ? (
                            <button className="btn sm ghost" onClick={() => void onRestore(r.rec.sourceRow)}>恢复</button>
                          ) : (
                            <>
                              <button className="btn sm" onClick={() => startEdit(r)}>编辑</button>
                              <button
                                className="btn sm ghost"
                                onClick={() => setExpanded(expanded === r.rec.sourceRow ? null : r.rec.sourceRow)}
                              >
                                历史
                              </button>
                              <button className="btn sm ghost" onClick={() => void onDelete(r.rec.sourceRow)}>删除</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded === r.rec.sourceRow && (
                      <tr className="subrow">
                        <td className="l" colSpan={14}>
                          {(() => {
                            const list = historyOf(r.rec.sourceRow)
                            if (list.length === 0) return <span className="muted">还没有变更记录</span>
                            return (
                              <ul className="hist">
                                {list.map((a, i) => (
                                  <li key={a.id ?? i}>
                                    <span className="t mono">{new Date(a.at).toLocaleString('zh-CN', { hour12: false })}</span>
                                    <span className="f">{a.field}</span>：{a.oldValue} → {a.newValue}
                                    <span className="muted">（{a.source}）</span>
                                  </li>
                                ))}
                              </ul>
                            )
                          })()}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td className="l muted" colSpan={14} style={{ textAlign: 'center', padding: 24 }}>
                    没有匹配的行
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="l" colSpan={4}>合计 {filtered.length} 行</td>
                <td className="num">{qty(filtered.reduce((a, r) => a + (r.lot?.qty ?? 0), 0))}</td>
                <td className="num">{qty(filtered.reduce((a, r) => a + (r.rec.soldQty ?? 0), 0))}</td>
                <td className="num">{qty(filtered.reduce((a, r) => a + (r.lot?.remainingQty ?? 0), 0))}</td>
                <td colSpan={4} />
                <td className="num">{money(filtered.reduce((a, r) => a + (r.sell?.profitCents ?? 0), 0))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </>
  )
}

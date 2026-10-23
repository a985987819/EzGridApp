import { useMemo, useState } from 'react'
import { Button, Card, Drawer, Input, Modal, Select, Switch, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { serialToIso } from '../domain/defaults'
import { EDITABLE, fieldText, type EditableKey } from '../domain/edit'
import { activeStocks } from '../domain/stocks'
import type { ManualInput } from '../domain/manual'
import { isoDate, money, price, qty, signedMoney, tone } from '../ui/format'
import { downloadText, toCsv } from '../ui/csv'
import type { Lot, RawRecord, SellExecution } from '../domain/types'

type StatusFilter = 'all' | 'holding' | 'soldout' | 'pending' | 'dateMissing' | 'needsPrice'

interface Row {
  rec: RawRecord
  lot: Lot | null
  sell: SellExecution | null
}

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'holding', label: '还有剩余持仓' },
  { key: 'soldout', label: '已卖完' },
  { key: 'pending', label: '待回补' },
  { key: 'dateMissing', label: '缺卖出日期' },
  { key: 'needsPrice', label: '缺价格' },
]

const BLANK_DRAFT = Object.fromEntries(EDITABLE.map((f) => [f.key, ''])) as Record<EditableKey, string>

const BLANK_FORM: ManualInput = {
  kind: 'buy',
  stockName: '',
  date: '',
  price: '',
  qty: '',
  targetPrice: '',
  rebuyPrice: '',
  buyPrice: '',
  buyQty: '',
  buyDate: '',
}

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
  const [showDeleted, setShowDeleted] = useState(false)
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<EditableKey, string>>(BLANK_DRAFT)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<ManualInput>(BLANK_FORM)

  // 股票顺序 / 启停都来自「管理 · 股票」
  const stockList = useMemo(() => activeStocks(stocks), [stocks])
  const stockNames = useMemo(() => stockList.map((s) => s.name), [stockList])
  const enabledSet = useMemo(() => new Set(stockNames), [stockNames])
  const hiddenStockCount = useMemo(
    () => new Set(records.map((r) => r.stockName).filter((n) => !enabledSet.has(n))).size,
    [records, enabledSet],
  )

  const rows = useMemo<Row[]>(() => {
    const lotMap = new Map(ledger.lots.map((l) => [l.sourceRow, l]))
    const sellMap = new Map(ledger.sells.map((s) => [s.sourceRow, s]))
    return records
      .map((rec) => ({ rec, lot: lotMap.get(rec.sourceRow) ?? null, sell: sellMap.get(rec.sourceRow) ?? null }))
      .sort((a, b) => b.rec.sourceRow - a.rec.sourceRow)
  }, [records, ledger])

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (!showDeleted && r.rec.deletedAt) return false
        if (stockFilter === 'all') {
          // 停用的股票不出现在明细里
          if (!enabledSet.has(r.rec.stockName)) return false
        } else if (r.rec.stockName !== stockFilter) return false
        if (keyword && !String(r.rec.sourceRow).includes(keyword) && !r.rec.stockName.includes(keyword)) return false
        if (priceFilter !== null) {
          const prices = [r.rec.targetPriceCents, r.rec.buyPriceCents, r.sell?.priceCents ?? null, r.rec.earlyBuyPriceCents]
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
      }),
    [rows, stockFilter, keyword, priceFilter, status, showDeleted, enabledSet],
  )

  const current = filtered.find((r) => r.rec.sourceRow === openRow) ?? null

  function open(r: Row) {
    const next = { ...BLANK_DRAFT }
    for (const f of EDITABLE) next[f.key] = fieldText(r.rec, f.key)
    setDraft(next)
    setEditing(false)
    setOpenRow(r.rec.sourceRow)
  }

  async function save() {
    if (openRow === null) return
    try {
      const n = await editRecord(openRow, draft)
      setEditing(false)
      notificationOpen({
        message: n === 0 ? '没有改动' : '已保存',
        description: n === 0 ? undefined : `${n} 个字段进入变更历史`,
        type: n === 0 ? 'info' : 'success',
      })
    } catch (e) {
      notificationOpen({ message: '保存失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function onDelete(row: number) {
    if (!window.confirm(`把第 ${row} 行标记为删除？软删除，可恢复。`)) return
    await softDelete(row)
    setOpenRow(null)
    notificationOpen({ message: `第 ${row} 行已删除`, description: '勾「显示已删除」可以恢复', type: 'info' })
  }

  async function onRestore(row: number) {
    await restore(row)
    notificationOpen({ message: `第 ${row} 行已恢复`, type: 'success' })
  }

  async function onAdd() {
    try {
      const row = await addManualRecord(form)
      setAdding(false)
      setForm(BLANK_FORM)
      notificationOpen({
        message: `已新增第 ${row} 行`,
        description: form.kind === 'sell' && !form.buyPrice ? '先卖后买：之后可在明细里补买入信息' : undefined,
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '新增失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  function exportCsv() {
    const head = ['行号', '来源', '股票', '买入日期', '买入价', '买入份额', '已卖', '剩余', '目标售价', '回补价', '卖出日期', '成交价', '实现盈利', '标记']
    const body = filtered.map((r) => [
      r.rec.sourceRow,
      r.rec.origin === 'manual' ? '手动' : 'Excel',
      r.rec.stockName,
      r.lot ? isoDate(r.lot.buyDate) : serialToIso(r.rec.buyDateSerial) ?? '',
      r.rec.buyPriceCents === null ? '' : (r.rec.buyPriceCents / 100).toFixed(2),
      r.lot?.qty ?? r.rec.buyQtyRaw ?? '',
      r.rec.soldQty ?? '',
      r.lot?.remainingQty ?? '',
      r.lot?.targetPriceCents == null ? '' : (r.lot.targetPriceCents / 100).toFixed(2),
      r.rec.earlyBuyPriceCents === null ? '' : (r.rec.earlyBuyPriceCents / 100).toFixed(2),
      r.sell?.soldAt ?? '',
      r.sell?.priceCents == null ? '' : (r.sell.priceCents / 100).toFixed(2),
      r.sell?.profitCents == null ? '' : (r.sell.profitCents / 100).toFixed(2),
      [r.sell?.rebuyStatus === 'pending' ? '待回补' : '', r.sell?.sellBeforeBuy ? '先卖后买' : '', r.rec.deletedAt ? '已删除' : '']
        .filter(Boolean)
        .join(' '),
    ])
    downloadText('交易明细.csv', toCsv([head, ...body]), 'text/csv;charset=utf-8')
  }

  return (
    <div className="stack">
      <div className="page-title">
        <h2>明细</h2>
        <p>{filtered.length} / {rows.length} 行</p>
      </div>

      <Card>
        <div className="stack tight">
          <div className="stock-tabs">
            <Tag
              size="medium"
              variant={stockFilter === 'all' ? 'solid' : 'soft'}
              color={stockFilter === 'all' ? 'app-teal' : 'default'}
              onClick={() => setStockFilter('all')}
            >
              全部
            </Tag>
            {stockNames.map((n) => (
              <Tag
                key={n}
                size="medium"
                variant={stockFilter === n ? 'solid' : 'soft'}
                color={stockFilter === n ? 'app-teal' : 'default'}
                onClick={() => setStockFilter(n)}
              >
                {n}
              </Tag>
            ))}
          </div>
          <div className="row nowrap">
            <Select
              options={STATUS_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
              value={status}
              onChange={(v) => setStatus(v as StatusFilter)}
              aria-label="按状态筛选"
            />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜股票名 / 行号"
              allowClear
              onClear={() => setKeyword('')}
              aria-label="搜索"
            />
          </div>
          <div className="row">
            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              <Switch size="small" checked={showDeleted} onChange={setShowDeleted} aria-label="显示已删除" />
              显示已删除
            </label>
            <div className="spacer" />
            <Button size="small" onClick={exportCsv}>导出 CSV</Button>
          </div>
          <Button
            block
            type="primary"
            onClick={() => {
              setForm({ ...BLANK_FORM, stockName: stockFilter === 'all' ? stockNames[0] ?? '' : stockFilter })
              setAdding(true)
            }}
          >
            新增一笔
          </Button>
        </div>
      </Card>

      {priceFilter !== null && (
        <div className="row" style={{ margin: '-4px 2px 0' }}>
          <Tag size="small" variant="soft" color="app-blue">
            价格 {(priceFilter / 100).toFixed(2)}
          </Tag>
          <Button
            size="small"
            type="text"
            onClick={() => {
              setPriceFilter(null)
              onClearFocus()
            }}
          >
            清除
          </Button>
        </div>
      )}

      {filtered.length === 0 ? (
        <Card>
          <div className="empty-box">没有匹配的行</div>
        </Card>
      ) : (
        filtered.map((r) => {
          const deleted = Boolean(r.rec.deletedAt)
          return (
            <Card
              key={r.rec.sourceRow}
              hoverable
              onClick={() => open(r)}
              className={`trade-item${deleted ? ' deleted' : ''}`}
              data-row={r.rec.sourceRow}
            >
              <div className="head">
                <Tag size="small" variant="soft">{r.rec.origin === 'manual' ? '手动' : `行 ${r.rec.sourceRow}`}</Tag>
                <span className="name">{r.rec.stockName}</span>
                <div className="spacer" />
                <span className={`profit ${tone(r.sell?.profitCents ?? null)}`}>
                  {r.sell ? signedMoney(r.sell.profitCents) : '—'}
                </span>
              </div>
              <div className="mid">
                <span className="path num">
                  {r.rec.buyPriceCents !== null ? `买 ${price(r.rec.buyPriceCents)}` : '无买入批次'}
                  {r.lot ? ` × ${qty(r.lot.qty)}` : r.rec.soldQty ? ` · 卖 ${qty(r.rec.soldQty)}` : ''}
                  {' → '}
                  目标 {price(r.lot?.targetPriceCents ?? r.rec.targetPriceCents)}
                </span>
                <span className="tiny muted num">
                  {r.lot ? `剩余 ${qty(r.lot.remainingQty)}` : r.rec.soldQty ? `已卖 ${qty(r.rec.soldQty)}` : ''}
                </span>
              </div>
              <div className="tag-row">
                {r.sell?.rebuyStatus === 'pending' && <Tag size="small" variant="soft" color="app-orange">待回补</Tag>}
                {r.sell?.sellBeforeBuy && <Tag size="small" variant="soft" color="app-teal">先卖后买</Tag>}
                {r.sell?.dateMissing && <Tag size="small" variant="soft" color="app-yellow">缺日期</Tag>}
                {r.sell && r.sell.priceCents === null && <Tag size="small" variant="soft" color="app-red">缺价格</Tag>}
                {r.rec.editedAt && <Tag size="small" variant="soft" color="purple">改过</Tag>}
                {deleted && <Tag size="small" variant="soft" color="app-red">已删除</Tag>}
              </div>
            </Card>
          )
        })
      )}

      <p className="tiny muted" style={{ textAlign: 'center' }}>
        共 {filtered.length} 行 · 合计盈利 {money(filtered.reduce((a, r) => a + (r.sell?.profitCents ?? 0), 0))}
        {hiddenStockCount > 0 && stockFilter === 'all' && ` · 已隐藏 ${hiddenStockCount} 只停用股票`}
      </p>

      <Drawer
        open={current !== null}
        placement="bottom"
        height="84vh"
        title={current ? `${current.rec.stockName} · ${current.rec.origin === 'manual' ? '手动' : `第 ${current.rec.sourceRow} 行`}` : ''}
        onClose={() => setOpenRow(null)}
        footer={
          current ? (
            <div className="row nowrap" style={{ gap: 8 }}>
              {editing ? (
                <>
                  <Button type="primary" style={{ flex: 1 }} onClick={() => void save()}>保存</Button>
                  <Button onClick={() => setEditing(false)}>取消</Button>
                </>
              ) : (
                <>
                  <Button type="primary" style={{ flex: 1 }} onClick={() => setEditing(true)}>编辑</Button>
                  {current.rec.deletedAt ? (
                    <Button onClick={() => void onRestore(current.rec.sourceRow)}>恢复</Button>
                  ) : (
                    <Button danger onClick={() => void onDelete(current.rec.sourceRow)}>删除</Button>
                  )}
                </>
              )}
            </div>
          ) : null
        }
      >
        {current && (
          <div className="stack">
            {editing ? (
              <div className="form-grid">
                {EDITABLE.map((f) => (
                  <label key={f.key}>
                    <span>{f.label}</span>
                    <Input
                      value={draft[f.key]}
                      placeholder={f.kind === 'date' ? 'YYYY-MM-DD' : f.kind === 'qty' ? '股数' : '元'}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      data-field={f.key}
                    />
                  </label>
                ))}
                <p className="tiny muted" style={{ margin: 0 }}>
                  成交价由 E 列（目标售价）决定；成本优先取买入价，无批次时取 P 列。
                </p>
              </div>
            ) : (
              <>
                <div className="detail-kv">
                  <div className="item">
                    <div className="k">买入日期</div>
                    <div className="v">{isoDate(current.lot?.buyDate ?? serialToIso(current.rec.buyDateSerial))}</div>
                  </div>
                  <div className="item">
                    <div className="k">买入价 / 份额</div>
                    <div className="v">
                      {price(current.rec.buyPriceCents)} / {qty(current.lot?.qty ?? current.rec.buyQtyRaw)}
                    </div>
                  </div>
                  <div className="item">
                    <div className="k">目标售价</div>
                    <div className="v">{price(current.lot?.targetPriceCents ?? current.rec.targetPriceCents)}</div>
                  </div>
                  <div className="item">
                    <div className="k">回补价 P</div>
                    <div className="v">{price(current.rec.earlyBuyPriceCents)}</div>
                  </div>
                  <div className="item">
                    <div className="k">已卖 / 剩余</div>
                    <div className="v">
                      {qty(current.rec.soldQty)} / {current.lot ? qty(current.lot.remainingQty) : '—'}
                    </div>
                  </div>
                  <div className="item">
                    <div className="k">成交价</div>
                    <div className="v">{price(current.sell?.priceCents)}</div>
                  </div>
                  <div className="item">
                    <div className="k">卖出日期</div>
                    <div className="v">{current.sell ? isoDate(current.sell.soldAt) : '—'}</div>
                  </div>
                  <div className="item">
                    <div className="k">实现盈利</div>
                    <div className={`v ${tone(current.sell?.profitCents ?? null)}`}>
                      {signedMoney(current.sell?.profitCents)}
                    </div>
                  </div>
                </div>

                <div className="tag-row">
                  {current.sell?.rebuyStatus === 'pending' && <Tag size="small" variant="soft" color="app-orange">待回补</Tag>}
                  {current.sell?.sellBeforeBuy && <Tag size="small" variant="soft" color="app-teal">先卖后买</Tag>}
                  {current.sell?.dateMissing && <Tag size="small" variant="soft" color="app-yellow">缺日期</Tag>}
                  {current.sell && current.sell.priceCents === null && <Tag size="small" variant="soft" color="app-red">缺价格</Tag>}
                  {current.rec.deletedAt && <Tag size="small" variant="soft" color="app-red">已删除</Tag>}
                </div>

                <div>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <strong style={{ fontSize: 13 }}>变更历史</strong>
                    <div className="spacer" />
                    <span className="tiny muted">{historyOf(current.rec.sourceRow).length} 条</span>
                  </div>
                  {historyOf(current.rec.sourceRow).length === 0 ? (
                    <p className="tiny muted" style={{ margin: 0 }}>还没改过</p>
                  ) : (
                    <ul className="hist-list">
                      {historyOf(current.rec.sourceRow).map((a, i) => (
                        <li key={a.id ?? i}>
                          <span className="when mono">
                            {new Date(a.at).toLocaleString('zh-CN', {
                              hour12: false,
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                          <span className="field">{a.field}</span>
                          <span>{a.oldValue} → {a.newValue}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>

      <Modal
        open={adding}
        title="新增一笔"
        typewriter={false}
        onClose={() => setAdding(false)}
        footer={
          <div className="row nowrap" style={{ gap: 8 }}>
            <Button type="primary" style={{ flex: 1 }} onClick={() => void onAdd()}>保存</Button>
            <Button onClick={() => setAdding(false)}>取消</Button>
          </div>
        }
      >
        <div className="stack tight">
          <div className="type-toggle">
            <Button
              type={form.kind === 'buy' ? 'primary' : 'default'}
              onClick={() => setForm({ ...form, kind: 'buy' })}
            >
              买入
            </Button>
            <Button
              type={form.kind === 'sell' ? 'primary' : 'default'}
              onClick={() => setForm({ ...form, kind: 'sell' })}
            >
              卖出
            </Button>
          </div>

          <div className="form-grid">
            <label>
              <span>股票</span>
              <Select
                options={[{ key: '', label: '选择…' }, ...stockNames.map((n) => ({ key: n, label: n }))]}
                value={form.stockName}
                onChange={(v) => setForm({ ...form, stockName: v })}
                placeholder="选择股票"
                aria-label="股票"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入日期' : '卖出日期'}</span>
              <Input
                value={form.date}
                placeholder="2026-10-23"
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                data-field="date"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入价' : '成交价'}</span>
              <Input
                value={form.price}
                placeholder={form.kind === 'buy' ? '8.01' : '8.58'}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                data-field="price"
              />
            </label>
            <label>
              <span>{form.kind === 'buy' ? '买入份额' : '卖出数量'}</span>
              <Input
                value={form.qty}
                placeholder="700"
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                data-field="qty"
              />
            </label>

            {form.kind === 'buy' ? (
              <label>
                <span>目标售价（可空，空则按「买入价 + 间隔」派生）</span>
                <Input
                  value={form.targetPrice ?? ''}
                  placeholder="8.58"
                  onChange={(e) => setForm({ ...form, targetPrice: e.target.value })}
                  data-field="targetPrice"
                />
              </label>
            ) : (
              <>
                <label>
                  <span>回补价 P（可空，空则视为已回补）</span>
                  <Input
                    value={form.rebuyPrice ?? ''}
                    placeholder="7.90"
                    onChange={(e) => setForm({ ...form, rebuyPrice: e.target.value })}
                    data-field="rebuyPrice"
                  />
                </label>
                <p className="tiny muted" style={{ margin: 0 }}>
                  先卖后买：买入信息可以现在填，也可以留空——之后在明细里补买入价和份额，会自动生成待卖。
                </p>
                <div className="row nowrap">
                  <label style={{ flex: 1 }}>
                    <span>买入价（选填）</span>
                    <Input
                      value={form.buyPrice ?? ''}
                      placeholder="8.30"
                      onChange={(e) => setForm({ ...form, buyPrice: e.target.value })}
                      data-field="buyPrice"
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <span>买入份额（选填）</span>
                    <Input
                      value={form.buyQty ?? ''}
                      placeholder="700"
                      onChange={(e) => setForm({ ...form, buyQty: e.target.value })}
                      data-field="buyQty"
                    />
                  </label>
                </div>
                <label>
                  <span>买入日期（选填）</span>
                  <Input
                    value={form.buyDate ?? ''}
                    placeholder="2026-10-22"
                    onChange={(e) => setForm({ ...form, buyDate: e.target.value })}
                    data-field="buyDate"
                  />
                </label>
              </>
            )}
            <p className="tiny muted" style={{ margin: 0 }}>
              手动新增的行号从 100000 起，不打乱 Excel 行号回溯。
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import { Button, Card, Input, Modal, Select, Switch, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { stockIdOf } from '../../domain/defaults'
import { centsToYuan, toCents } from '../../domain/money'
import { moveItem, normalizeStocks } from '../../domain/stocks'
import type { PriceLimitType } from '../../domain/limit'
import type { StockConfig } from '../../domain/types'
import { IconGrip } from '../../ui/icons'

const LIMITS: { key: PriceLimitType; label: string }[] = [
  { key: 'main_10', label: '主板 10%' },
  { key: 'gem_20', label: '创业板 20%' },
  { key: 'star_20', label: '科创板 20%' },
  { key: 'bse_30', label: '北交所 30%' },
  { key: 'st_5', label: 'ST 5%' },
  { key: 'custom', label: '自定义' },
  { key: 'unknown', label: '未设置' },
]

export function ManageStocks() {
  const { stocks, updateStock, addStock, removeStock, records, reorderStocks, setStockEnabled } = useApp()
  const ordered = useMemo(() => normalizeStocks(stocks), [stocks])
  const [preview, setPreview] = useState<string[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const dragRef = useRef<string | null>(null)

  const ids = preview ?? ordered.map((s) => s.id)
  const byId = useMemo(() => new Map(ordered.map((s) => [s.id, s])), [ordered])
  const list = ids.map((id) => byId.get(id)).filter((s): s is StockConfig => Boolean(s))

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newInterval, setNewInterval] = useState('0.57')

  const usedNames = new Set(records.map((r) => r.stockName))
  const missing = [...usedNames].filter((n) => !ordered.some((s) => s.name === n))

  async function onIntervalChange(s: StockConfig, v: string) {
    const cents = toCents(v)
    if (cents === null || cents <= 0) return
    await updateStock({ ...s, intervalCents: cents })
    notificationOpen({ message: `${s.name} 间隔改为 ${v}`, description: '清单已按新间隔重算', type: 'success' })
  }

  function startDrag(e: React.PointerEvent<HTMLButtonElement>, id: string) {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = id
    setDragId(id)
    setPreview(ids)
  }

  function onDragMove(e: React.PointerEvent<HTMLButtonElement>) {
    const id = dragRef.current
    if (!id) return
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-stock-row]')
    const overId = el?.getAttribute('data-stock-row') ?? null
    if (!overId || overId === id) return
    setPreview((prev) => {
      const cur = prev ?? ids
      const from = cur.indexOf(id)
      const to = cur.indexOf(overId)
      if (from < 0 || to < 0) return cur
      return moveItem(cur, from, to)
    })
  }

  async function endDrag() {
    const id = dragRef.current
    if (!id) return
    dragRef.current = null
    setDragId(null)
    const next = preview
    setPreview(null)
    if (next) {
      await reorderStocks(next)
      notificationOpen({ message: '顺序已保存', description: '其他页面的选股顺序同步更新', type: 'success' })
    }
  }

  return (
    <div className="stack">
      <Card>
        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
          <IconGrip />
          <span className="tiny muted">按住手柄上下拖动排序；这个顺序决定概览 / 明细 / 挂单 / 统计里的股票顺序</span>
        </div>
        <div className="hint-block">
          停用的股票只在管理页可见，不进其他列表（数据仍计入合计）。间隔用于派生目标售价，涨跌幅给挂单页算区间。
        </div>
      </Card>

      {list.map((s, index) => (
        <Card
          key={s.id}
          className={`stock-card${dragId === s.id ? ' dragging' : ''}${s.enabled ? '' : ' off'}`}
          data-stock-row={s.id}
        >
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="drag-handle"
              aria-label={`拖动 ${s.name}`}
              onPointerDown={(e) => startDrag(e, s.id)}
              onPointerMove={onDragMove}
              onPointerUp={() => void endDrag()}
              onPointerCancel={() => void endDrag()}
            >
              <IconGrip />
            </button>
            <span className="order-chip">{index + 1}</span>
            <strong style={{ fontSize: 15 }}>{s.name}</strong>
            {usedNames.has(s.name) ? (
              <Tag size="small" variant="soft" color="app-green">在用</Tag>
            ) : (
              <Tag size="small" variant="soft">未使用</Tag>
            )}
            {!s.enabled && <Tag size="small" variant="soft" color="app-red">已停用</Tag>}
            <div className="spacer" />
            <label className="row" style={{ gap: 6, fontSize: 11.5 }}>
              <Switch
                size="small"
                checked={s.enabled}
                onChange={(v) => void setStockEnabled(s.id, v)}
                aria-label={`启用 ${s.name}`}
              />
              <span className="muted">启用</span>
            </label>
          </div>

          <div className="row nowrap">
            <label style={{ flex: 1, fontSize: 12 }}>
              <span className="muted">默认间隔（元）</span>
              <Input
                key={`${s.id}-${s.intervalCents}`}
                defaultValue={centsToYuan(s.intervalCents)}
                onBlur={(e) => void onIntervalChange(s, e.target.value)}
                aria-label={`${s.name} 默认间隔`}
              />
            </label>
            <label style={{ flex: 1, fontSize: 12 }}>
              <span className="muted">涨跌幅规则</span>
              <Select
                options={LIMITS.map((l) => ({ key: l.key, label: l.label }))}
                value={s.priceLimitType}
                onChange={(v) => void updateStock({ ...s, priceLimitType: v as PriceLimitType })}
                aria-label={`${s.name} 涨跌幅规则`}
              />
            </label>
          </div>

          {s.priceLimitType === 'custom' && (
            <label style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              <span className="muted">自定义涨跌幅（%）</span>
              <Input
                key={`${s.id}-pct`}
                defaultValue={String(s.customLimitPct ?? 10)}
                onBlur={(e) => {
                  const pct = Number(e.target.value)
                  if (Number.isFinite(pct) && pct > 0) void updateStock({ ...s, customLimitPct: pct })
                }}
                aria-label={`${s.name} 自定义涨跌幅`}
              />
            </label>
          )}

          <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
            <Button
              size="small"
              danger
              onClick={() => {
                if (!window.confirm(`删除「${s.name}」的配置？`)) return
                void removeStock(s.id)
              }}
            >
              删除
            </Button>
          </div>
        </Card>
      ))}

      <Button block onClick={() => setAdding(true)}>新增股票</Button>

      {missing.length > 0 && (
        <Card>
          <p className="hint-block" style={{ margin: 0 }}>
            <b>明细里有这些股票还没配置：</b>{missing.join('、')}
            <br />
            间隔缺失时不会派生目标价，相关行会进「待补价格」。
          </p>
        </Card>
      )}

      <Modal
        open={adding}
        title="新增股票"
        typewriter={false}
        onClose={() => setAdding(false)}
        footer={
          <div className="row nowrap" style={{ gap: 8 }}>
            <Button
              type="primary"
              style={{ flex: 1 }}
              onClick={() => {
                const cents = toCents(newInterval)
                if (!newName.trim() || cents === null) {
                  notificationOpen({ message: '名称和间隔都要填', type: 'warning' })
                  return
                }
                void addStock({
                  id: stockIdOf(newName.trim()),
                  name: newName.trim(),
                  intervalCents: cents,
                  priceLimitType: 'main_10',
                  enabled: true,
                }).then(() => {
                  setAdding(false)
                  setNewName('')
                  notificationOpen({ message: '已添加，排最后', type: 'success' })
                })
              }}
            >
              添加
            </Button>
            <Button onClick={() => setAdding(false)}>取消</Button>
          </div>
        }
      >
        <div className="form-grid">
          <label>
            <span>名称（要和 Excel 明细写法一致）</span>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 安道麦（不是 安道麦A）" />
          </label>
          <label>
            <span>默认间隔（元）</span>
            <Input value={newInterval} onChange={(e) => setNewInterval(e.target.value)} placeholder="0.57" />
          </label>
        </div>
      </Modal>
    </div>
  )
}

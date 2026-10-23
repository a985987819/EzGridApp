import { useState } from 'react'
import { Button, Card, Input, Modal, Select, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { stockIdOf } from '../../domain/defaults'
import { centsToYuan, toCents } from '../../domain/money'
import type { PriceLimitType } from '../../domain/limit'
import type { StockConfig } from '../../domain/types'

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
  const { stocks, updateStock, addStock, removeStock, records } = useApp()
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newInterval, setNewInterval] = useState('0.57')

  const usedNames = new Set(records.map((r) => r.stockName))
  const missing = [...usedNames].filter((n) => !stocks.some((s) => s.name === n))

  async function onIntervalChange(s: StockConfig, v: string) {
    const cents = toCents(v)
    if (cents === null || cents <= 0) return
    await updateStock({ ...s, intervalCents: cents })
    notificationOpen({ message: `${s.name} 间隔改为 ${v}`, description: '清单已按新间隔重算', type: 'success' })
  }

  return (
    <div className="stack">
      {stocks.map((s) => (
        <Card key={s.id}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 15 }}>{s.name}</strong>
            {usedNames.has(s.name) ? (
              <Tag size="small" variant="soft" color="app-green">在用</Tag>
            ) : (
              <Tag size="small" variant="soft">未使用</Tag>
            )}
            <div className="spacer" />
            <Button
              size="small"
              type="text"
              danger
              onClick={() => {
                if (!window.confirm(`删除「${s.name}」的配置？`)) return
                void removeStock(s.id)
              }}
            >
              删除
            </Button>
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
          <p className="tiny muted" style={{ margin: '8px 0 0' }}>
            目标售价缺失时按「买入价 + 间隔」派生；改完立即重算全表。
          </p>
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
                }).then(() => {
                  setAdding(false)
                  setNewName('')
                  notificationOpen({ message: '已添加', type: 'success' })
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

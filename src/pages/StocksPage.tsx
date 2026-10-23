import { useState } from 'react'
import { useApp } from '../store/useApp'
import { stockIdOf } from '../domain/defaults'
import { centsToYuan, toCents } from '../domain/money'
import type { PriceLimitType } from '../domain/limit'
import type { StockConfig } from '../domain/types'

const LIMITS: PriceLimitType[] = ['main_10', 'gem_20', 'star_20', 'bse_30', 'st_5', 'custom', 'unknown']

export function StocksPage() {
  const { stocks, updateStock, addStock, removeStock, records } = useApp()
  const [newName, setNewName] = useState('')
  const [newInterval, setNewInterval] = useState('0.57')

  const usedNames = new Set(records.map((r) => r.stockName))
  const missing = [...usedNames].filter((n) => !stocks.some((s) => s.name === n))

  async function onIntervalChange(s: StockConfig, v: string) {
    const cents = toCents(v)
    if (cents === null) return
    await updateStock({ ...s, intervalCents: cents })
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>股票</h2>
          <p>默认间隔决定 E 列（买入价 + 间隔）的派生，改完立即重算；价格与金额一律整数分</p>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>配置</h3>
          <span className="hint">{stocks.length} 只</span>
        </header>
        <div className="body tight">
          <table className="grid">
            <thead>
              <tr>
                <th className="l">股票</th>
                <th>默认间隔（元）</th>
                <th className="l">涨跌幅规则</th>
                <th>组池（元）</th>
                <th className="l">说明</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stocks.map((s) => (
                <tr key={s.id}>
                  <td className="l">{s.name}</td>
                  <td className="num">
                    <input
                      defaultValue={centsToYuan(s.intervalCents)}
                      key={`${s.id}-${s.intervalCents}`}
                      onBlur={(e) => void onIntervalChange(s, e.target.value)}
                      style={{ width: 80, textAlign: 'right', padding: '2px 6px', border: '1px solid var(--line)', borderRadius: 3 }}
                    />
                  </td>
                  <td className="l">
                    <select
                      value={s.priceLimitType}
                      onChange={(e) => void updateStock({ ...s, priceLimitType: e.target.value as PriceLimitType })}
                      style={{ padding: '2px 6px', border: '1px solid var(--line)', borderRadius: 3 }}
                    >
                      {LIMITS.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  </td>
                  <td className="num muted">{usedNames.has(s.name) ? '—' : '未使用'}</td>
                  <td className="l muted" style={{ whiteSpace: 'normal' }}>{s.note ?? ''}</td>
                  <td>
                    <button className="btn sm ghost" onClick={() => void removeStock(s.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>新增股票</h3>
          <span className="hint">名称要和 Excel 明细里的写法一致（如「安道麦」而不是「安道麦A」）</span>
        </header>
        <div className="body">
          <div className="row">
            <label className="field">
              名称
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 中国平安" />
            </label>
            <label className="field">
              默认间隔（元）
              <input value={newInterval} onChange={(e) => setNewInterval(e.target.value)} />
            </label>
            <button
              className="btn primary"
              disabled={!newName.trim() || toCents(newInterval) === null}
              onClick={() => {
                const cents = toCents(newInterval)
                if (!newName.trim() || cents === null) return
                void addStock({
                  id: stockIdOf(newName.trim()),
                  name: newName.trim(),
                  intervalCents: cents,
                  priceLimitType: 'main_10',
                })
                setNewName('')
              }}
            >
              添加
            </button>
          </div>
          {missing.length > 0 && (
            <p className="err" style={{ marginBottom: 0 }}>
              明细里有这些股票还没有配置：{missing.join('、')}（间隔缺失时不会派生目标价，会进「待补价格」）
            </p>
          )}
        </div>
      </div>
    </>
  )
}

import { useState } from 'react'
import { AppProvider, useApp } from './store/useApp'
import { Overview } from './pages/Overview'
import { ImportPage } from './pages/ImportPage'
import { TradesPage } from './pages/TradesPage'
import { OrdersPage } from './pages/OrdersPage'
import { StocksPage } from './pages/StocksPage'
import { StatsPage } from './pages/StatsPage'
import { SettingsPage } from './pages/SettingsPage'
import { qty } from './ui/format'

type Tab = 'overview' | 'import' | 'trades' | 'orders' | 'stocks' | 'stats' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'import', label: '导入' },
  { id: 'trades', label: '明细' },
  { id: 'orders', label: '挂单' },
  { id: 'stocks', label: '股票' },
  { id: 'stats', label: '统计' },
  { id: 'settings', label: '备份' },
]

function Shell() {
  const [tab, setTab] = useState<Tab>('overview')
  const [focus, setFocus] = useState<{ stock: string; priceCents: number } | null>(null)
  const { ready, ledger, records } = useApp()

  if (!ready) {
    return <div className="empty">初始化本地库…</div>
  }

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <h1>网格交易管理</h1>
          <span>GRID LEDGER V1</span>
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item${tab === t.id ? ' active' : ''}`}
            onClick={() => {
              setTab(t.id)
              if (t.id !== 'trades') setFocus(null)
            }}
          >
            {t.label}
            {t.id === 'trades' && <span className="badge">{records.length}</span>}
            {t.id === 'orders' && <span className="badge">{ledger.orders.length}</span>}
          </button>
        ))}
        <div className="rail-foot">
          净持仓 {qty(ledger.totals.netQty)} 股
          <br />
          本地库 · 不上传
        </div>
      </nav>

      <main className="main">
        {tab === 'overview' && (
          <Overview
            onPick={(stock, priceCents) => {
              setFocus({ stock, priceCents })
              setTab('trades')
            }}
          />
        )}
        {tab === 'import' && <ImportPage goOverview={() => setTab('overview')} />}
        {tab === 'trades' && <TradesPage focus={focus} onClearFocus={() => setFocus(null)} />}
        {tab === 'orders' && <OrdersPage />}
        {tab === 'stocks' && <StocksPage />}
        {tab === 'stats' && <StatsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}

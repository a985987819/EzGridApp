import { useState } from 'react'
import 'animal-island-ui/style'
import { Tag } from 'animal-island-ui'
import { AppProvider, useApp } from './store/useApp'
import { Overview } from './pages/Overview'
import { TradesPage } from './pages/TradesPage'
import { OrdersPage } from './pages/OrdersPage'
import { StatsPage } from './pages/StatsPage'
import { ManagePage } from './pages/ManagePage'
import { IconChart, IconGear, IconGrid, IconList, IconTag } from './ui/icons'
import './styles.css'

type Tab = 'overview' | 'trades' | 'orders' | 'stats' | 'manage'

const TABS: { key: Tab; label: string; Icon: typeof IconGrid }[] = [
  { key: 'overview', label: '概览', Icon: IconGrid },
  { key: 'trades', label: '明细', Icon: IconList },
  { key: 'orders', label: '挂单', Icon: IconTag },
  { key: 'stats', label: '统计', Icon: IconChart },
  { key: 'manage', label: '管理', Icon: IconGear },
]

function Shell() {
  const [tab, setTab] = useState<Tab>('overview')
  const [focus, setFocus] = useState<{ stock: string; priceCents: number } | null>(null)
  const { ready, ledger, records, baseline } = useApp()

  const failed = baseline.filter((c) => !c.ok).length
  const pendingOrders = ledger.orders.length

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-block">
          <strong>网格交易</strong>
          <span>
            {records.length ? `${records.filter((r) => !r.deletedAt).length} 行 · 净持仓 ${ledger.totals.netQty.toLocaleString('zh-CN')} 股` : '还没有数据'}
          </span>
        </div>
        <div className="spacer" />
        {records.length > 0 && (
          <Tag size="small" variant="soft" color={failed ? 'app-red' : 'app-green'}>
            {failed ? `基准 ${baseline.length - failed}/${baseline.length}` : '基准全中'}
          </Tag>
        )}
      </header>

      <main className="app-main">
        {!ready ? (
          <div className="empty-box">初始化本地库…</div>
        ) : tab === 'overview' ? (
          <Overview
            onPick={(stock, priceCents) => {
              setFocus({ stock, priceCents })
              setTab('trades')
            }}
            goManage={() => setTab('manage')}
          />
        ) : tab === 'trades' ? (
          <TradesPage focus={focus} onClearFocus={() => setFocus(null)} />
        ) : tab === 'orders' ? (
          <OrdersPage />
        ) : tab === 'stats' ? (
          <StatsPage />
        ) : (
          <ManagePage />
        )}
      </main>

      <nav className="app-nav" aria-label="主导航">
        <div className="app-nav-inner">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`nav-btn${tab === key ? ' active' : ''}`}
              onClick={() => {
                setTab(key)
                if (key !== 'trades') setFocus(null)
                window.scrollTo({ top: 0 })
              }}
              aria-current={tab === key ? 'page' : undefined}
              data-nav={key}
            >
              <Icon />
              <span>{label}</span>
              {key === 'orders' && pendingOrders > 0 && <i className="nav-badge">{pendingOrders}</i>}
            </button>
          ))}
        </div>
      </nav>
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

import { useEffect, useRef, useState } from 'react'
import 'animal-island-ui/style'
import { Select } from 'animal-island-ui'
import { AppProvider, useApp } from './store/useApp'
import { Overview } from './pages/Overview'
import { TradesPage } from './pages/TradesPage'
import { OrdersPage } from './pages/OrdersPage'
import { StatsPage } from './pages/StatsPage'
import { ManagePage } from './pages/ManagePage'
import { IconChart, IconGear, IconGrid, IconList, IconTag } from './ui/icons'
import { navigate, parseHash, type Tab, type TradesQuery } from './ui/nav'
import './styles.css'

const TABS: { key: 'overview' | 'trades' | 'orders' | 'stats' | 'manage'; label: string; Icon: typeof IconGrid }[] = [
  { key: 'overview', label: '概览', Icon: IconGrid },
  { key: 'trades', label: '明细', Icon: IconList },
  { key: 'orders', label: '挂单', Icon: IconTag },
  { key: 'stats', label: '统计', Icon: IconChart },
  { key: 'manage', label: '管理', Icon: IconGear },
]

function Shell() {
  // tab 与明细筛选都由 hash 承载（S7）：#/trades?stock=… 可以直达
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const { ready, ledger, activeAccountId, accounts, setActiveAccount } = useApp()

  const goTrades = (q: TradesQuery) => navigate('trades', q)

  // 底部导航：已在明细时只回顶部、不动筛选；从其他 tab 回明细时恢复上次离开时的筛选
  const lastTradesRef = useRef<TradesQuery>({})
  const onNavClick = (key: Tab) => {
    if (key === 'trades') {
      navigate('trades', route.tab === 'trades' ? parseHash().query : lastTradesRef.current)
    } else {
      if (route.tab === 'trades') lastTradesRef.current = parseHash().query
      navigate(key)
    }
    window.scrollTo({ top: 0 })
  }
  const pendingOrders = ledger.orders.length
  const accountOptions = [
    { key: 'all', label: '全部账户' },
    ...accounts.map((a) => ({ key: a.id, label: a.name })),
  ]

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-block">
          <strong>网格交易</strong>
          <span>
            {ledger.totals.rows
              ? `${ledger.totals.rows} 行 · 净持仓 ${ledger.totals.netQty.toLocaleString('zh-CN')} 股`
              : '还没有数据'}
          </span>
        </div>
        <div className="spacer" />
        <div className="account-select">
          <Select
            options={accountOptions}
            value={activeAccountId}
            onChange={(v) => void setActiveAccount(v)}
            aria-label="切换账户"
          />
        </div>
      </header>

      <main className="app-main">
        {!ready ? (
          <div className="empty-box">初始化本地库…</div>
        ) : route.tab === 'overview' ? (
          <Overview goTrades={goTrades} goManage={() => navigate('manage')} />
        ) : route.tab === 'trades' ? (
          <TradesPage urlQuery={route.query} />
        ) : route.tab === 'orders' ? (
          <OrdersPage goTrades={goTrades} />
        ) : route.tab === 'stats' ? (
          <StatsPage goTrades={goTrades} />
        ) : (
          <ManagePage goTrades={goTrades} />
        )}
      </main>

      <nav className="app-nav" aria-label="主导航">
        <div className="app-nav-inner">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`nav-btn${route.tab === key ? ' active' : ''}`}
              onClick={() => onNavClick(key)}
              aria-current={route.tab === key ? 'page' : undefined}
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

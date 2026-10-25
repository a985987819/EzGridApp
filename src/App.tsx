import { useEffect, useRef, useState } from 'react'
import 'animal-island-ui/style'
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
  const { ready, ledger } = useApp()

  // V9.37 切页方向：新页按「往右走」还是「往左走」决定从左/右滑入（底部导航 5 个 tab 的顺序）
  const tabIdx = TABS.findIndex((t) => t.key === route.tab)
  const prevTabIdx = useRef(tabIdx)
  const dir: 'forward' | 'back' = tabIdx >= prevTabIdx.current ? 'forward' : 'back'
  useEffect(() => {
    prevTabIdx.current = tabIdx
  }, [tabIdx])

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

  return (
    <div className="app">
      <main className="app-main" data-dir={dir}>
        {!ready ? (
          <div className="empty-box">初始化本地库…</div>
        ) : route.tab === 'overview' ? (
          <Overview goTrades={goTrades} goManage={() => navigate('manage')} goOrders={() => navigate('orders')} />
        ) : route.tab === 'trades' ? (
          <TradesPage urlQuery={route.query} />
        ) : route.tab === 'orders' ? (
          <OrdersPage goTrades={goTrades} goOverview={() => navigate('overview')} />
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

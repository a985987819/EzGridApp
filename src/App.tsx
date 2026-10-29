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
import { transitionView } from './ui/transitions'
import { usePageMotion } from './ui/pageMotion'
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
  const [dir, setDir] = useState<'forward' | 'back'>('forward')
  const routeRef = useRef(route)
  const mainRef = useRef<HTMLElement>(null)
  usePageMotion(mainRef, route.tab)
  useEffect(() => {
    const onHash = () => {
      const next = parseHash()
      const previous = routeRef.current
      routeRef.current = next
      const changedPage = previous.tab !== next.tab
      const changedManage = previous.tab === 'manage' && next.tab === 'manage' &&
        (['section', 'doc', 'topic', 'scenario'] as const).some(key => previous.manage?.[key] !== next.manage?.[key])
      const returningManage = changedManage && (!next.manage?.section ||
        ((previous.manage?.doc || previous.manage?.topic || previous.manage?.scenario) && !next.manage?.doc && !next.manage?.topic && !next.manage?.scenario))
      const direction = returningManage || TABS.findIndex(t => t.key === next.tab) < TABS.findIndex(t => t.key === previous.tab) ? 'back' : 'forward'
      const update = () => {
        if (changedPage || changedManage) {
          setDir(direction)
          window.scrollTo({ top: 0, behavior: 'instant' })
        }
        setRoute(next)
      }
      if (changedPage || changedManage) transitionView(update, direction, changedPage ? 'page' : 'content')
      else update()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const { ready, ledger } = useApp()

  // V9.66：跨页深链（树/统计/挂单跳明细）落在页面顶部——筛选区是展开状态、不用再滚回去找；
  // 明细页内部的筛选点击不走这里，不会把人顶上去
  const goTrades = (q: TradesQuery) => {
    navigate('trades', q)
  }

  // 底部导航：已在明细时只回顶部、不动筛选；从其他 tab 回明细时恢复上次离开时的筛选
  const lastTradesRef = useRef<TradesQuery>({})
  const onNavClick = (key: Tab) => {
    if (key === 'trades') {
      navigate('trades', route.tab === 'trades' ? parseHash().query : lastTradesRef.current)
    } else {
      if (route.tab === 'trades') lastTradesRef.current = parseHash().query
      navigate(key)
    }
    // 跨页滚动复位放在快照更新内，避免先把旧页面闪回页顶再切换。
    if (key === route.tab) window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const pendingOrders = ledger.orders.length

  return (
    <div className="app">
      <main ref={mainRef} className="app-main" data-dir={dir}>
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
          <ManagePage goTrades={goTrades} query={route.manage} />
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

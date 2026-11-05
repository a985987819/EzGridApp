import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import 'animal-island-ui/style'
import { AppProvider, useApp } from './store/useApp'
import { IconChart, IconGear, IconGrid, IconList, IconTag } from './ui/icons'
import { navigate, parseHash, type Tab, type TradesQuery } from './ui/nav'
import { transitionView } from './ui/transitions'
import { usePageMotion } from './ui/pageMotion'
import { downloadText } from './ui/csv'
import { PageErrorBoundary } from './components/PageErrorBoundary'
import './styles.css'

/**
 * 2026-11-03 加载优化：五个页面全部按页拆 chunk（仅 App shell / store / domain /
 * 共享组件留在 index），首访解析执行减半，发版只重下被改页面的 chunk。
 * PWA 预缓存仍收全部 chunk——离线切页无等待；Suspense 兜底只在未缓存首次进入时闪现。
 */
function createPages() {
  return {
    Overview: lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview }))),
    TradesPage: lazy(() => import('./pages/TradesPage').then((m) => ({ default: m.TradesPage }))),
    OrdersPage: lazy(() => import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage }))),
    StatsPage: lazy(() => import('./pages/StatsPage').then((m) => ({ default: m.StatsPage }))),
    ManagePage: lazy(() => import('./pages/ManagePage').then((m) => ({ default: m.ManagePage }))),
  }
}

function PageSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="empty-box">正在打开…</div>}>{children}</Suspense>
}

const TABS: { key: 'overview' | 'trades' | 'orders' | 'stats' | 'manage'; label: string; Icon: typeof IconGrid }[] = [
  { key: 'overview', label: '概览', Icon: IconGrid },
  { key: 'trades', label: '明细', Icon: IconList },
  { key: 'orders', label: '挂单', Icon: IconTag },
  { key: 'stats', label: '统计', Icon: IconChart },
  { key: 'manage', label: '管理', Icon: IconGear },
]

function Shell() {
  // React.lazy caches a rejected import. A user retry must create fresh lazy objects.
  const [pages, setPages] = useState(createPages)
  const [pageAttempt, setPageAttempt] = useState(0)
  const { Overview, TradesPage, OrdersPage, StatsPage, ManagePage } = pages
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
  const { ready, ledger, exportBackup } = useApp()
  const retryPage = () => {
    setPages(createPages())
    setPageAttempt(attempt => attempt + 1)
  }
  const backupAfterError = async () => {
    const json = await exportBackup()
    downloadText(`grid-backup-${new Date().toISOString().replaceAll(':', '-')}.json`, json, 'application/json;charset=utf-8')
  }

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
        <PageErrorBoundary resetKey={`${JSON.stringify(route)}:${pageAttempt}`} onRetry={retryPage} onBackup={backupAfterError}>
        {!ready ? (
          <div className="empty-box">初始化本地库…</div>
        ) : route.tab === 'overview' ? (
          <PageSuspense><Overview goTrades={goTrades} goManage={() => navigate('manage')} goOrders={() => navigate('orders')} /></PageSuspense>
        ) : route.tab === 'trades' ? (
          <PageSuspense><TradesPage urlQuery={route.query} /></PageSuspense>
        ) : route.tab === 'orders' ? (
          <PageSuspense><OrdersPage goTrades={goTrades} goOverview={() => navigate('overview')} /></PageSuspense>
        ) : route.tab === 'stats' ? (
          <PageSuspense><StatsPage goTrades={goTrades} /></PageSuspense>
        ) : (
          <PageSuspense><ManagePage goTrades={goTrades} query={route.manage} /></PageSuspense>
        )}
        </PageErrorBoundary>
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

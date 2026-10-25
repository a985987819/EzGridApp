import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { notificationOpen } from 'animal-island-ui'
import App from './App'
import './styles.css'

// PWA（V9.16）：V9.40 起改 prompt——新版本只提示、绝不自动 reload。
// 页面常开着编辑时被 autoUpdate 强制刷新，弹窗和滚动位置都会丢；等用户手动刷新再生效。
registerSW({
  immediate: true,
  onNeedRefresh() {
    notificationOpen({
      message: '有新版本',
      description: '已下载，手动刷新页面后生效（不会自动刷新）',
      type: 'info',
    })
  },
  onRegisteredSW(_url, reg) {
    if (!reg) return
    setInterval(() => {
      void reg.update().catch(() => {})
    }, 60 * 60 * 1000)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

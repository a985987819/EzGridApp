import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles.css'

// PWA（V9.16）：autoUpdate——新版本 SW 就绪后自动接管并刷新页面；
// 页面常开时每小时主动查一次更新，手机上也能及时拿到最新版
registerSW({
  immediate: true,
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

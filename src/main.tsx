import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startAppUpdater } from './ui/appUpdate'
import { startAppInstall } from './ui/appInstall'
import App from './App'
import './styles.css'

startAppInstall()
startAppUpdater()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

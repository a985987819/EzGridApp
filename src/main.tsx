import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startAppUpdater } from './ui/appUpdate'
import App from './App'
import './styles.css'

startAppUpdater()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

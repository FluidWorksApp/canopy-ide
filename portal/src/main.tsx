import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/archivo/wght.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@fontsource/vt323/index.css'
import '@shared/tokens.css'
import '@shared/chrome.css'
import '@shared/agents.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

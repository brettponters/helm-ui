import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// In the Electron shell, reserve space for the macOS traffic lights and make the
// top bar draggable (handled in CSS via [data-electron]).
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.dataset.electron = 'true'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// iOS Safari ignores user-scalable=no for pinch, so cancel the gesture events themselves.
// Non-passive on purpose: preventDefault is a no-op on a passive listener.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, e => e.preventDefault(), { passive: false })
}

// Keep the modal overlay inside the part of the screen the on-screen keyboard leaves
// visible. iOS does not resize the layout viewport for the keyboard, so 100dvh alone
// would leave a centred modal half hidden. The overlay reads these two variables.
const syncVisualViewport = () => {
  const vv = window.visualViewport
  const root = document.documentElement.style
  root.setProperty('--vv-h', (vv ? vv.height : window.innerHeight) + 'px')
  root.setProperty('--vv-top', (vv ? vv.offsetTop : 0) + 'px')
}
syncVisualViewport()
window.addEventListener('resize', syncVisualViewport)
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncVisualViewport)
  window.visualViewport.addEventListener('scroll', syncVisualViewport)
}

// Telegram webview: fill the sheet and stop swipe-down from closing it. Every call is
// guarded, so a plain browser (no Telegram object) or an older client (no such method)
// still runs the app.
const configureTelegram = () => {
  const tg = window.Telegram && window.Telegram.WebApp
  if (!tg) return
  for (const [method, args] of [
    ['expand', []], ['disableVerticalSwipes', []],
    ['setBackgroundColor', ['#eeeef2']], ['setHeaderColor', ['#eeeef2']],
  ]) {
    try {
      if (typeof tg[method] === 'function') tg[method](...args)
    } catch {
      // Unsupported on this client version. Nothing to recover.
    }
  }
  // A late SDK load may happen after React is ready. Earlier loads are signalled
  // by App's mount effect so Telegram never exposes an empty root.
  if (document.querySelector('.page')) {
    try { tg.ready?.() } catch { /* older host */ }
  }
}
configureTelegram()
document.getElementById('telegram-sdk')?.addEventListener('load', configureTelegram, { once: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

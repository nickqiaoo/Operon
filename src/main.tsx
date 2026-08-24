import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import Root from './Root'
import { I18nProvider } from './i18n/I18nProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initAnalytics, trackEvent } from './lib/analytics'
import { installOperonProbe } from './lib/operon-probe'
import { installFetchAuthInterceptor } from './lib/web-auth'
import { ensureRandomUUID } from './lib/crypto-polyfill'
import { WebAuthGate } from './components/web/WebAuthGate'
import { DeleteAccountPage, isDeleteAccountRoute } from './components/web/DeleteAccountPage'
import { PwaUpdateManager } from './components/web/PwaUpdateManager'
import { queryClient } from './lib/query-client'
import './styles/globals.css'

// The inline web bootstrap watchdog listens for this event. It cannot rely on
// React code when a cached JS or CSS response contains an HTML fallback, so
// signal as soon as the complete module graph has loaded successfully.
window.dispatchEvent(new Event('operon:boot-module-loaded'))

// Insecure origins (web reached by LAN IP over http) lack crypto.randomUUID —
// polyfill it before anything (chat creation, etc.) calls it. Must run first.
ensureRandomUUID()

// Web target: attach the bearer token to broker requests before anything fetches.
if (__APP_TARGET__ === 'web') installFetchAuthInterceptor()

if (import.meta.env.DEV && import.meta.env.VITE_REACT_DEVTOOLS === '1') {
  void import('./lib/connect-react-devtools')
}

installOperonProbe()
initAnalytics()
trackEvent('app_opened', { platform: navigator.platform })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        {__APP_TARGET__ === 'web' ? (
          // Account deletion sits outside the gate on purpose — see
          // DeleteAccountPage. Everything else goes through it.
          isDeleteAccountRoute() ? (
            <DeleteAccountPage />
          ) : (
            <WebAuthGate>
              <Root />
            </WebAuthGate>
          )
        ) : (
          <Root />
        )}
        <PwaUpdateManager />
      </I18nProvider>
    </QueryClientProvider>
  </ErrorBoundary>
)

// Take down the inline splash as soon as React has painted. It used to wait on
// `window.load`, which never fires if any subresource hangs — leaving an
// installed PWA stuck on the logo with the app already rendered behind it.
requestAnimationFrame(() => {
  requestAnimationFrame(() => window.dispatchEvent(new Event('operon:app-ready')))
})

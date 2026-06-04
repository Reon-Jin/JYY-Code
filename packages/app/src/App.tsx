import { Router, Route } from '@solidjs/router'
import { ErrorBoundary } from 'solid-js'
import { ThemeProvider } from './contexts/ThemeProvider'
import { initTheme } from './hooks/useTheme'
import { AppLayout } from './components/navigation/AppLayout'
import { HomePage } from './routes/home'
import { SessionPage } from './routes/session'
import { EmailPage } from './routes/email'
import './styles/global.css'

// Initialize theme early
initTheme()

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary fallback={(err: Error) => (
        <div style={{
          padding: '32px',
          color: 'var(--color-text-primary)',
          background: 'var(--color-gray-light)',
          height: '100vh',
          display: 'flex',
          'flex-direction': 'column',
          'align-items': 'center',
          'justify-content': 'center',
          'font-family': 'var(--font-text)',
        }}>
          <h1 style={{ 'font-size': '24px', 'margin-bottom': '16px' }}>应用启动错误</h1>
          <pre style={{
            background: 'rgba(0,0,0,0.06)',
            padding: '16px',
            'border-radius': '8px',
            'max-width': '600px',
            overflow: 'auto',
            'font-size': '14px',
          }}>{err.message}</pre>
        </div>
      )}>
        <Router>
          <Route path="/" component={AppLayout}>
            <Route path="/" component={HomePage} />
            <Route path="/session/:id" component={SessionPage} />
            <Route path="/email" component={EmailPage} />
          </Route>
        </Router>
      </ErrorBoundary>
    </ThemeProvider>
  )
}

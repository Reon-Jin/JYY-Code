import { createSignal, createRoot } from 'solid-js'

export type ThemeMode = 'light' | 'dark' | 'system'

// Singleton theme state (not tied to component lifecycle)
function createThemeState() {
  const [mode, setMode] = createSignal<ThemeMode>('system')
  const [resolved, setResolved] = createSignal<'light' | 'dark'>('light')
  let cleanupSystemListener: (() => void) | null = null

  // Apply resolved theme to DOM
  function applyTheme(theme: 'light' | 'dark') {
    document.documentElement.dataset.theme = theme
  }

  // Listen to system theme changes
  function startSystemListener() {
    if (cleanupSystemListener) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (mode() === 'system') {
        const newTheme = e.matches ? 'dark' : 'light'
        setResolved(newTheme)
        applyTheme(newTheme)
      }
    }
    mq.addEventListener('change', handler as (e: MediaQueryListEvent) => void)
    cleanupSystemListener = () =>
      mq.removeEventListener('change', handler as (e: MediaQueryListEvent) => void)
  }

  // Set theme
  function setTheme(newMode: ThemeMode) {
    setMode(newMode)
    let resolvedTheme: 'light' | 'dark'

    if (newMode === 'system') {
      resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      startSystemListener()
    } else {
      resolvedTheme = newMode
      // No need for system listener when manual mode
    }

    setResolved(resolvedTheme)
    applyTheme(resolvedTheme)

    // Persist to electron store if available
    if (window.electron?.setStoreValue) {
      window.electron.setStoreValue('theme', newMode)
    }
  }

  // Toggle between light and dark
  function toggleTheme() {
    const currentResolved = resolved()
    setTheme(currentResolved === 'dark' ? 'light' : 'dark')
  }

  return {
    mode,
    resolved,
    setTheme,
    toggleTheme,
  }
}

// Create singleton
const themeState = createRoot(createThemeState)

// Public hook
export function useTheme() {
  return themeState
}

// Initialize theme from persisted store (call once at app startup)
export function initTheme() {
  // Try to load persisted theme
  if (window.electron?.getStoreValue) {
    window.electron
      .getStoreValue('theme')
      .then((stored: unknown) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          themeState.setTheme(stored)
        } else {
          // Default to system
          themeState.setTheme('system')
        }
      })
      .catch(() => {
        themeState.setTheme('system')
      })
  } else {
    themeState.setTheme('system')
  }
}

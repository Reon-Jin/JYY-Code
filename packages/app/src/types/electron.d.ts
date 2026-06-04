/**
 * Global type declarations for window.electron API (exposed via preload.ts).
 * This file augments the Window interface with the electron context bridge API.
 */

export {}

declare global {
  interface Window {
    electron?: {
      // Dialog
      selectDirectory: () => Promise<string | null>

      // File system
      readFile: (filePath: string) => Promise<string>

      // App info
      getAppVersion: () => Promise<string>
      getPlatform: () => string

      // Window controls
      minimizeWindow: () => Promise<void>
      maximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      isMaximized: () => Promise<boolean>

      // Theme
      getSystemTheme: () => Promise<'light' | 'dark'>
      onThemeChanged: (callback: (theme: 'light' | 'dark') => void) => () => void

      // Persistent store
      getStoreValue: (key: string) => Promise<unknown>
      setStoreValue: (key: string, value: unknown) => Promise<void>

      // Sidecar
      startSidecar: (workspaceDir: string) => Promise<{ port: number; baseUrl: string }>
      stopSidecar: () => Promise<void>
      getSidecarStatus: () => Promise<'stopped' | 'starting' | 'running' | 'error'>
    }
  }
}

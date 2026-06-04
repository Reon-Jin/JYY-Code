import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  // Dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory') as Promise<string | null>,

  // File system
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath) as Promise<string>,

  // App info
  getAppVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
  getPlatform: () => process.platform as string,

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,

  // Theme
  getSystemTheme: () => ipcRenderer.invoke('theme:getSystem') as Promise<'light' | 'dark'>,

  // Persistent store
  getStoreValue: (key: string) => ipcRenderer.invoke('store:get', key) as Promise<unknown>,
  setStoreValue: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),

  // Sidecar
  startSidecar: (workspaceDir: string) => ipcRenderer.invoke('sidecar:start', workspaceDir) as Promise<{ port: number; baseUrl: string }>,
  stopSidecar: () => ipcRenderer.invoke('sidecar:stop') as Promise<void>,
  getSidecarStatus: () => ipcRenderer.invoke('sidecar:status') as Promise<'stopped' | 'starting' | 'running' | 'error'>,

  // Theme change listener (main → renderer)
  onThemeChanged: (callback: (theme: 'light' | 'dark') => void) => {
    const handler = (_: unknown, theme: 'light' | 'dark') => callback(theme)
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.removeListener('theme:changed', handler)
  }
}

contextBridge.exposeInMainWorld('electron', electronAPI)

import { app, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import * as path from 'path'
import { initStore, getStore } from './store'
import { SidecarManager } from './sidecar'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow: BrowserWindow | null = null
let sidecar: SidecarManager | null = null

function createWindow() {
  const isMac = process.platform === 'darwin'

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    ...(isMac ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#1d1d1f',
        height: 38
      },
    } : {
      frame: false,  // Windows: frameless window with custom title bar
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    show: false,
    backgroundColor: '#f5f5f7'
  }

  mainWindow = new BrowserWindow(windowOptions)

  // Load content
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// IPC Handlers
function registerIpcHandlers() {
  // Dialog: select directory
  ipcMain.handle('dialog:selectDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作空间目录'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // File: read file
  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    const fs = await import('fs/promises')
    return fs.readFile(filePath, 'utf-8')
  })

  // App info
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('app:getPlatform', () => process.platform)

  // Window controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  // Theme
  ipcMain.handle('theme:getSystem', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  
  // Store (persistent settings)
  initStore()
  const store = getStore()
  ipcMain.handle('store:get', (_, key: string) => store.get(key))
  ipcMain.handle('store:set', (_, key: string, value: unknown) => store.set(key, value))

  // Sidecar management
  ipcMain.handle('sidecar:start', async (_, workspaceDir: string) => {
    sidecar = new SidecarManager()
    return sidecar.start(workspaceDir)
  })
  ipcMain.handle('sidecar:stop', async () => {
    await sidecar?.stop()
  })
  ipcMain.handle('sidecar:status', () => sidecar?.getStatus() ?? 'stopped')
}

// App lifecycle
app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  await sidecar?.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  await sidecar?.stop()
})

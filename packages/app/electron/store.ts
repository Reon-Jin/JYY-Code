import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

interface AppStoreSchema {
  recentProjects: string[]
  theme: 'light' | 'dark' | 'system'
  windowBounds: {
    x?: number
    y?: number
    width: number
    height: number
  }
  lastActiveSessionId?: string
  lastActiveProject?: string
}

const defaults: AppStoreSchema = {
  recentProjects: [],
  theme: 'system',
  windowBounds: { width: 1280, height: 800 },
}

let store: AppStoreSchema = { ...defaults }
let initialized = false

function filePath(): string {
  return path.join(app.getPath('userData'), 'jyycode-config.json')
}

function ensureDir(file: string) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function initStore() {
  if (initialized) return
  initialized = true
  try {
    const fp = filePath()
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf-8')
      store = { ...defaults, ...JSON.parse(raw) }
    }
  } catch {
    store = { ...defaults }
  }
}

function save() {
  if (!initialized) return
  try {
    const fp = filePath()
    ensureDir(fp)
    fs.writeFileSync(fp, JSON.stringify(store, null, 2), 'utf-8')
  } catch (err) {
    console.error('[store] save error:', err)
  }
}

export function getStore() {
  if (!initialized) initStore()
  const data = store as unknown as Record<string, unknown>
  return {
    get<T = unknown>(key: string): T | undefined {
      return data[key] as T | undefined
    },
    set(key: string, value: unknown): void {
      data[key] = value
      save()
    },
    getAll(): AppStoreSchema {
      return { ...store }
    },
  }
}

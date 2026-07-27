export type StoredDevice = {
  id: string
  name: string
  routeId: string
  relayUrl: string
  vaultKey: CryptoKey
  sealedSessionKey: string
  pairedAt: number
  lastSeen?: number
}

const DB_NAME = "jyycode-mobile"
const STORE_NAME = "devices"

export class DeviceStore {
  private database?: Promise<IDBDatabase>

  async list() {
    const database = await this.open()
    return await request<StoredDevice[]>(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll())
  }

  async get(id: string) {
    const database = await this.open()
    return await request<StoredDevice | undefined>(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id))
  }

  async put(device: StoredDevice) {
    const database = await this.open()
    await request(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(device))
  }

  async remove(id: string) {
    const database = await this.open()
    await request(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id))
  }

  async clear() {
    const database = await this.open()
    await request(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear())
  }

  private open() {
    this.database ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1)
      open.onerror = () => reject(open.error ?? new Error("无法打开本地安全存储"))
      open.onupgradeneeded = () => open.result.createObjectStore(STORE_NAME, { keyPath: "id" })
      open.onsuccess = () => resolve(open.result)
    })
    return this.database
  }
}

function request<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("本地安全存储操作失败"))
  })
}

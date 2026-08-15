import { LockKeyhole, Unlock } from "lucide-solid"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { MobileShell, type PrimaryPage } from "./components/mobile-shell"
import type { StoredDevice } from "./lib/device-store"
import type { RemoteAction, RemoteTask } from "./lib/models"
import { RelayClient, type RelayState } from "./lib/relay-client"
import { DevicesPage } from "./pages/devices-page"
import { InboxPage } from "./pages/inbox-page"
import { SettingsPage } from "./pages/settings-page"
import { TaskDetailPage } from "./pages/task-detail-page"
import { WorkbenchPage } from "./pages/workbench-page"
import { ALL_PROJECTS } from "./components/project-switcher"

type Page = PrimaryPage | "task" | "settings"

export function App() {
  const [page, setPage] = createSignal<Page>("workbench")
  const [tasks, setTasks] = createSignal<RemoteTask[]>([])
  const [devices, setDevices] = createSignal<StoredDevice[]>([])
  const [activeDeviceID, setActiveDeviceID] = createSignal<string>()
  const [selectedProject, setSelectedProject] = createSignal(ALL_PROJECTS)
  const [selectedTask, setSelectedTask] = createSignal<RemoteTask>()
  const [relayState, setRelayState] = createSignal<RelayState>("offline")
  const [locked, setLocked] = createSignal(true)
  const [summaryOnly, setSummaryOnly] = createSignal(true)
  const [notifications, setNotifications] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  let hiddenAt = 0
  let noticeTimer: number | undefined

  const client = new RelayClient({
    onTasks: setTasks,
    onState: setRelayState,
  })
  const activeDevice = () => devices().find((device) => device.id === activeDeviceID())

  async function reloadDevices() {
    setDevices(await client.store.list())
  }

  function showNotice(message: string) {
    setNotice(message)
    if (noticeTimer) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => setNotice(undefined), 4_000)
  }

  async function unlock(deviceID = activeDeviceID() ?? devices()[0]?.id) {
    if (!deviceID) {
      setLocked(false)
      setPage("devices")
      return
    }
    try {
      setRelayState("connecting")
      await client.selectDevice(deviceID)
      setActiveDeviceID(deviceID)
      setLocked(false)
    } catch (error) {
      setRelayState("offline")
      showNotice(error instanceof Error ? error.message : "无法解锁连接")
    }
  }

  async function pair(payload: string) {
    try {
      const device = await client.pair(payload)
      setActiveDeviceID(device.id)
      await client.refresh()
      await reloadDevices()
      setLocked(false)
      showNotice("电脑已安全配对")
    } catch (error) {
      throw error instanceof Error ? error : new Error("配对失败")
    }
  }

  async function selectDevice(id: string) {
    setActiveDeviceID(id)
    if (locked()) return unlock(id)
    client.disconnect()
    setTasks([])
    await unlock(id)
  }

  async function removeDevice(id: string) {
    if (id === activeDeviceID()) {
      try {
        await client.revokeCurrentDevice()
      } catch {
        await client.store.remove(id)
        client.disconnect()
      }
      setActiveDeviceID(undefined)
      setTasks([])
      setLocked(true)
    } else {
      await client.store.remove(id)
    }
    await reloadDevices()
    showNotice("已移除浏览器配对")
  }

  async function runCommand(action: RemoteAction) {
    if (locked() || relayState() !== "online") {
      showNotice("电脑离线或页面已锁定，暂不能操作")
      return undefined
    }
    try {
      const detail = await client.command(selectedTask()?.id ?? "", action)
      await client.refresh()
      return detail
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "操作失败")
      return undefined
    }
  }

  async function clearLocalData() {
    client.disconnect()
    await client.store.clear()
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
    setDevices([])
    setTasks([])
    setActiveDeviceID(undefined)
    setLocked(true)
    setPage("devices")
    showNotice("已清除本地配对和缓存")
  }

  function openTask(task: RemoteTask) {
    setSelectedTask(task)
    setPage("task")
  }
  function navigate(next: PrimaryPage) {
    setPage(next)
  }

  createEffect(() => {
    const active = activeDeviceID()
    if (active && !devices().some((device) => device.id === active)) setActiveDeviceID(undefined)
  })

  onMount(() => {
    void reloadDevices()
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt && Date.now() - hiddenAt > 5 * 60_000) {
        client.disconnect()
        setLocked(true)
        showNotice("离开超过五分钟，已重新锁定")
      } else if (!locked()) {
        void client.refresh().catch(() => undefined)
      }
      hiddenAt = 0
    }
    document.addEventListener("visibilitychange", visibility)
    onCleanup(() => document.removeEventListener("visibilitychange", visibility))
  })
  onCleanup(() => {
    client.disconnect()
    if (noticeTimer) window.clearTimeout(noticeTimer)
  })

  return (
    <>
      <Show
        when={!locked()}
        fallback={
          <LockScreen
            devices={devices()}
            onUnlock={() => void unlock()}
            onPair={() => {
              setLocked(false)
              setPage("devices")
            }}
          />
        }
      >
        <Show when={page() === "task" && selectedTask()}>
          {(task) => (
            <TaskDetailPage
              task={task()}
              online={relayState() === "online"}
              onBack={() => setPage("workbench")}
              onCommand={runCommand}
            />
          )}
        </Show>
        <Show when={page() === "settings"}>
          <SettingsPage
            summaryOnly={summaryOnly()}
            notifications={notifications()}
            onSummaryOnly={setSummaryOnly}
            onNotifications={setNotifications}
            onClear={clearLocalData}
            onRelock={() => {
              client.disconnect()
              setLocked(true)
            }}
            onBack={() => setPage("devices")}
          />
        </Show>
        <Show when={page() === "workbench" || page() === "inbox" || page() === "devices"}>
          <MobileShell page={page() as PrimaryPage} onNavigate={navigate}>
            <Show when={page() === "workbench"}>
              <WorkbenchPage
                tasks={tasks()}
                selectedProject={selectedProject()}
                online={relayState() === "online"}
                deviceName={activeDevice()?.name}
                onProject={setSelectedProject}
                onDevices={() => setPage("devices")}
                onOpenTask={openTask}
                onRefresh={() =>
                  void client
                    .refresh()
                    .catch((error) => showNotice(error instanceof Error ? error.message : "刷新失败"))
                }
                onCreate={async (action) => {
                  await runCommand(action)
                }}
              />
            </Show>
            <Show when={page() === "inbox"}>
              <InboxPage tasks={tasks()} onOpenTask={openTask} />
            </Show>
            <Show when={page() === "devices"}>
              <DevicesPage
                devices={devices()}
                activeDeviceID={activeDeviceID()}
                onPair={pair}
                onSelect={selectDevice}
                onRemove={removeDevice}
                onSettings={() => setPage("settings")}
              />
            </Show>
          </MobileShell>
        </Show>
      </Show>
      <Show when={notice()}>
        {(message) => (
          <p class="toast" role="status">
            {message()}
          </p>
        )}
      </Show>
    </>
  )
}

function LockScreen(props: { devices: StoredDevice[]; onUnlock: () => void; onPair: () => void }) {
  return (
    <main class="lock-screen">
      <LockKeyhole />
      <span class="wordmark">JYYCode 移动版</span>
      <h1>任务已锁定</h1>
      <p>
        {props.devices.length
          ? "为保护已配对电脑的信息，请先解锁此 Safari 会话。"
          : "扫描桌面端二维码，即可开始监控和处理任务。"}
      </p>
      <button class="primary-button" onClick={props.devices.length ? props.onUnlock : props.onPair}>
        {props.devices.length ? (
          <>
            <Unlock />
            解锁并连接
          </>
        ) : (
          "添加电脑"
        )}
      </button>
      <small>离开页面超过五分钟将自动重新锁定；请同时启用 iPhone 的设备锁定。</small>
    </main>
  )
}

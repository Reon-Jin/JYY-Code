import SwiftUI
import UIKit

@main
struct JYYCodeMobileApp: App {
    @UIApplicationDelegateAdaptor(NotificationDelegate.self) private var notificationDelegate
    @StateObject private var store = CompanionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task { await store.start() }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        Group {
            if store.isLocked {
                UnlockView()
            } else {
                TabView {
                    WorkbenchView()
                        .tabItem { Label("工作台", systemImage: "rectangle.3.group") }
                    InboxView()
                        .tabItem { Label("待处理", systemImage: "tray.full") }
                    DevicesView()
                        .tabItem { Label("设备", systemImage: "desktopcomputer") }
                }
                .tint(.accentColor)
            }
        }
        .onChange(of: UIApplication.shared.applicationState) { _, state in
            store.handleAppState(state)
        }
    }
}

struct UnlockView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("JYYCode Mobile")
                .font(.title2.bold())
            Text("使用 Face ID 或设备密码解锁远程任务。")
                .foregroundStyle(.secondary)
            Button("解锁") { Task { await store.unlock() } }
                .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

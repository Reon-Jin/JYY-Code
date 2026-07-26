import Foundation
import LocalAuthentication
import UserNotifications
import UIKit

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var isLocked = true
    @Published private(set) var devices: [DesktopDevice] = []
    @Published private(set) var tasks: [RemoteTask] = []
    @Published private(set) var inbox: [InboxItem] = []
    @Published var errorMessage: String?

    private let relay = RelayClient()
    private var backgroundTimer: Timer?
    private var foregroundRefreshTask: Task<Void, Never>?
    private var summaryObserver: NSObjectProtocol?
    private var deviceSeenObserver: NSObjectProtocol?

    init() {
        summaryObserver = NotificationCenter.default.addObserver(
            forName: .jyycodeSummaryUpdate,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let tasks = notification.userInfo?["tasks"] as? [RemoteTask] else { return }
            Task { @MainActor in self?.applySummary(tasks) }
        }
        deviceSeenObserver = NotificationCenter.default.addObserver(
            forName: .jyycodeDesktopSeen,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let deviceID = notification.userInfo?["deviceID"] as? String else { return }
            Task { @MainActor in self?.markDeviceSeen(deviceID) }
        }
    }

    deinit {
        if let summaryObserver { NotificationCenter.default.removeObserver(summaryObserver) }
        if let deviceSeenObserver { NotificationCenter.default.removeObserver(deviceSeenObserver) }
    }

    func start() async {
        await requestNotifications()
        devices = DeviceStore.load()
        await unlock()
    }

    func unlock() async {
        let context = LAContext()
        do {
            try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock JYYCode Mobile")
            isLocked = false
            await refresh()
            startForegroundRefresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func lock() {
        backgroundTimer?.invalidate()
        backgroundTimer = nil
        foregroundRefreshTask?.cancel()
        foregroundRefreshTask = nil
        isLocked = true
        relay.disconnect()
    }

    func handleAppState(_ state: UIApplication.State) {
        if state == .active {
            backgroundTimer?.invalidate()
            backgroundTimer = nil
            return
        }
        guard !isLocked, backgroundTimer == nil else { return }
        backgroundTimer = Timer.scheduledTimer(withTimeInterval: 5 * 60, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.lock() }
        }
    }

    func refresh() async {
        guard !isLocked else { return }
        do {
            tasks = try await relay.fetchSummary(for: devices)
            applySummary(tasks)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func pair(_ payload: PairingPayload) async throws {
        let device = try await relay.pair(payload)
        devices.append(device)
        DeviceStore.save(devices)
        await refresh()
    }

    func revoke(_ device: DesktopDevice) {
        devices.removeAll { $0.id == device.id }
        DeviceStore.save(devices)
        relay.disconnect(deviceID: device.id)
    }

    func clearLocalCache() {
        errorMessage = nil
        tasks = []
        inbox = []
    }

    func send(_ action: RemoteAction, to task: RemoteTask) async {
        guard devices.first(where: { $0.id == task.deviceID })?.isOnline == true else {
            errorMessage = RelayError.deviceOffline.errorDescription
            return
        }
        do {
            _ = try await relay.send(action, to: task)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadDetail(_ action: RemoteAction, for task: RemoteTask) async -> RemoteDetail? {
        guard devices.first(where: { $0.id == task.deviceID })?.isOnline == true else {
            errorMessage = RelayError.deviceOffline.errorDescription
            return nil
        }
        do {
            return try await relay.send(action, to: task)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func requestNotifications() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
    }

    private func startForegroundRefresh() {
        foregroundRefreshTask?.cancel()
        foregroundRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, !self.isLocked else { return }
                await self.refresh()
            }
        }
    }

    private func applySummary(_ updatedTasks: [RemoteTask]) {
        tasks = updatedTasks.sorted { $0.updatedAt > $1.updatedAt }
        inbox = tasks.flatMap(InboxItem.items(from:))
        let onlineDevices = Set(tasks.map(\.deviceID))
        devices = devices.map { device in
            var device = device
            if onlineDevices.contains(device.id) { device.lastSeen = .now }
            return device
        }
        DeviceStore.save(devices)
    }

    private func markDeviceSeen(_ deviceID: String) {
        devices = devices.map { device in
            var device = device
            if device.id == deviceID { device.lastSeen = .now }
            return device
        }
        DeviceStore.save(devices)
    }
}

final class NotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        RelayClient.registerPushToken(deviceToken)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

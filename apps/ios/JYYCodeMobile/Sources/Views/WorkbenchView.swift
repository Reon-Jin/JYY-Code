import SwiftUI

struct WorkbenchView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var showingCompose = false

    var body: some View {
        NavigationStack {
            List {
                Section("已连接电脑") {
                    if store.devices.isEmpty {
                        Label("扫描二维码以连接你的第一台电脑", systemImage: "iphone.gen3")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.devices) { device in
                            HStack {
                                Image(systemName: device.isOnline ? "desktopcomputer.and.arrow.down" : "desktopcomputer")
                                    .foregroundStyle(device.isOnline ? .green : .secondary)
                                VStack(alignment: .leading) {
                                    Text(device.name)
                                    Text(device.isOnline ? "在线" : "离线")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("需要处理") {
                    let pending = store.inbox.filter { $0.kind == .permission || $0.kind == .question }
                    if pending.isEmpty {
                        Text("当前没有需要你处理的事项。")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(pending) { item in
                            NavigationLink(value: item.taskID) {
                                Label(item.title, systemImage: item.kind == .permission ? "checkmark.shield" : "questionmark.circle")
                            }
                        }
                    }
                }

                Section("活跃任务") {
                    let active = store.tasks.filter { $0.status == .running || $0.status == .waiting }
                    if active.isEmpty {
                        Text("没有正在运行的任务。")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(active) { task in TaskRow(task: task) }
                    }
                }

                Section("最近") {
                    ForEach(store.tasks.filter { $0.status == .completed || $0.status == .failed }) { task in TaskRow(task: task) }
                }
            }
            .navigationTitle("工作台")
            .navigationDestination(for: String.self) { taskID in
                if let task = store.tasks.first(where: { $0.id == taskID }) { TaskDetailView(task: task) }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await store.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingCompose = true } label: { Image(systemName: "square.and.pencil") }
                        .disabled(store.devices.isEmpty)
                }
            }
            .sheet(isPresented: $showingCompose) { NewTaskView() }
        }
    }
}

private struct TaskRow: View {
    let task: RemoteTask

    var body: some View {
        NavigationLink(value: task.id) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(task.title).font(.headline)
                    Spacer()
                    Text(task.status.label).font(.caption).foregroundStyle(task.status.color)
                }
                Text(task.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                ProgressView(value: task.progress)
            }
            .padding(.vertical, 2)
        }
    }
}

private extension RemoteTask.Status {
    var label: String {
        switch self {
        case .running: return "运行中"
        case .waiting: return "等待处理"
        case .completed: return "已完成"
        case .failed: return "失败"
        case .idle: return "空闲"
        }
    }

    var color: Color {
        switch self {
        case .running: return .blue
        case .waiting: return .orange
        case .completed: return .green
        case .failed: return .red
        case .idle: return .secondary
        }
    }
}

private struct NewTaskView: View {
    @EnvironmentObject private var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    @State private var workspace = ""
    @State private var prompt = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("工作区路径", text: $workspace)
                TextEditor(text: $prompt)
                    .frame(minHeight: 150)
            }
            .navigationTitle("新建任务")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") {
                        let temporary = RemoteTask(id: "new", deviceID: store.devices.first?.id ?? "", title: "新任务", status: .idle, summary: "", progress: 0, updatedAt: .now, todo: [], children: [], pending: nil, timeline: [])
                        Task { await store.send(.createTask(workspace: workspace, prompt: prompt), to: temporary); dismiss() }
                    }
                    .disabled(workspace.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

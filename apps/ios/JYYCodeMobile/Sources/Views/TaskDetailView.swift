import SwiftUI

struct TaskDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    let task: RemoteTask
    @State private var message = ""
    @State private var selectedView = 0
    @State private var detail: RemoteDetail?
    @State private var isLoadingDetail = false
    @AppStorage("allowDetailedTaskContent") private var allowDetailedTaskContent = true

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(task.title).font(.title3.bold())
                    Text(task.summary).foregroundStyle(.secondary)
                    ProgressView(value: task.progress)
                    Button(role: .destructive) { Task { await store.send(.stop, to: task) } } label: { Label("停止任务", systemImage: "stop.fill") }
                        .disabled(task.status != .running && task.status != .waiting)
                }
            }

            if let pending = task.pending {
                Section("需要处理") { PendingActionView(pending: pending, task: task) }
            }

            Section("任务进度") {
                ForEach(task.children) { child in
                    Label(child.title, systemImage: child.status == .completed ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(child.status == .failed ? .red : .primary)
                }
            }

            Section("待办") {
                ForEach(task.todo) { item in
                    Label(item.title, systemImage: item.isComplete ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(item.isComplete ? .green : .primary)
                }
            }

            Section("活动") {
                ForEach(task.timeline) { event in
                    VStack(alignment: .leading) {
                        Text(event.title)
                        Text(event.date, style: .relative).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            Section("详细内容") {
                Picker("内容", selection: $selectedView) {
                    Text("摘要").tag(0)
                    Text("对话").tag(1)
                    Text("改动").tag(2)
                }
                .pickerStyle(.segmented)
                if selectedView == 0 {
                    Text("默认只显示摘要。选择“对话”或“改动”后会按需从已配对电脑请求内容。")
                        .foregroundStyle(.secondary)
                } else if !allowDetailedTaskContent {
                    Text("完整内容显示已在“设备 > 隐私”中关闭。")
                        .foregroundStyle(.secondary)
                } else if detail?.kind == (selectedView == 1 ? .conversation : .diff) {
                    ScrollView(.horizontal) {
                        Text(detail?.content ?? "")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                    Button("清除本地内容", role: .destructive) { detail = nil }
                } else {
                    Button(isLoadingDetail ? "正在加密加载…" : "加载内容") {
                        Task {
                            isLoadingDetail = true
                            detail = await store.loadDetail(selectedView == 1 ? .loadConversation : .loadDiff, for: task)
                            isLoadingDetail = false
                        }
                    }
                    .disabled(isLoadingDetail)
                }
            }

            Section("发送后续指令") {
                TextEditor(text: $message).frame(minHeight: 90)
                Button("发送") {
                    let next = message
                    message = ""
                    Task { await store.send(.sendMessage(next), to: task) }
                }
                .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle("任务")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PendingActionView: View {
    @EnvironmentObject private var store: CompanionStore
    let pending: PendingAction
    let task: RemoteTask

    var body: some View {
        switch pending {
        case let .permission(id, title):
            Text(title)
            HStack {
                Button("拒绝", role: .destructive) { Task { await store.send(.approvePermission(id: id, approved: false), to: task) } }
                Button("批准") { Task { await store.send(.approvePermission(id: id, approved: true), to: task) } }
                    .buttonStyle(.borderedProminent)
            }
        case let .question(id, title, options):
            Text(title)
            ForEach(options, id: \.self) { option in
                Button(option) { Task { await store.send(.answerQuestion(id: id, answer: option), to: task) } }
            }
        }
    }
}

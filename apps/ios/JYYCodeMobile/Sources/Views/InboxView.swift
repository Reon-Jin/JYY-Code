import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            List(store.inbox) { item in
                if let task = store.tasks.first(where: { $0.id == item.taskID }) {
                    NavigationLink { TaskDetailView(task: task) } label: {
                        Label(item.title, systemImage: icon(for: item.kind))
                    }
                } else {
                    Label(item.title, systemImage: icon(for: item.kind))
                }
            }
            .overlay {
                if store.inbox.isEmpty { ContentUnavailableView("没有待处理事项", systemImage: "checkmark.circle") }
            }
            .navigationTitle("待处理")
        }
    }

    private func icon(for kind: InboxItem.Kind) -> String {
        switch kind {
        case .permission: return "checkmark.shield"
        case .question: return "questionmark.circle"
        case .failed: return "xmark.octagon"
        case .completed: return "checkmark.circle"
        }
    }
}

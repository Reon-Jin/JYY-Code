import Foundation

struct DesktopDevice: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let routeID: String
    let relayURL: URL
    let sharedKeyReference: String
    var lastSeen: Date?

    var isOnline: Bool {
        guard let lastSeen else { return false }
        return Date().timeIntervalSince(lastSeen) < 45
    }
}

struct PairingPayload: Codable {
    let routeID: String
    let relayURL: URL
    let pairingSecret: String
    let temporaryPublicKey: String
    let expiresAt: Date

    var isExpired: Bool { expiresAt <= Date() }
}

struct RemoteTask: Identifiable, Codable, Hashable {
    enum Status: String, Codable { case running, waiting, completed, failed, idle }

    let id: String
    let deviceID: String
    let title: String
    let status: Status
    let summary: String
    let progress: Double
    let updatedAt: Date
    let todo: [TodoItem]
    let children: [TaskChild]
    let pending: PendingAction?
    let timeline: [TaskEvent]
}

struct TodoItem: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let isComplete: Bool
}

struct TaskChild: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let status: RemoteTask.Status
}

struct TaskEvent: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let date: Date
}

struct RemoteDetail: Codable, Hashable {
    enum Kind: String, Codable { case conversation, diff }
    let kind: Kind
    let content: String
}

enum PendingAction: Codable, Hashable {
    case permission(id: String, title: String)
    case question(id: String, title: String, options: [String])
}

enum RemoteAction: Codable {
    case createTask(workspace: String, prompt: String)
    case sendMessage(String)
    case stop
    case retry
    case approvePermission(id: String, approved: Bool)
    case answerQuestion(id: String, answer: String)
    case loadConversation
    case loadDiff

    private enum CodingKeys: String, CodingKey { case type, workspace, prompt, message, id, approved, answer }
    private enum Kind: String, Codable { case createTask, sendMessage, stop, retry, approvePermission, answerQuestion, loadConversation, loadDiff }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .type) {
        case .createTask: self = .createTask(workspace: try values.decode(String.self, forKey: .workspace), prompt: try values.decode(String.self, forKey: .prompt))
        case .sendMessage: self = .sendMessage(try values.decode(String.self, forKey: .message))
        case .stop: self = .stop
        case .retry: self = .retry
        case .approvePermission: self = .approvePermission(id: try values.decode(String.self, forKey: .id), approved: try values.decode(Bool.self, forKey: .approved))
        case .answerQuestion: self = .answerQuestion(id: try values.decode(String.self, forKey: .id), answer: try values.decode(String.self, forKey: .answer))
        case .loadConversation: self = .loadConversation
        case .loadDiff: self = .loadDiff
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .createTask(workspace, prompt):
            try values.encode(Kind.createTask, forKey: .type); try values.encode(workspace, forKey: .workspace); try values.encode(prompt, forKey: .prompt)
        case let .sendMessage(message):
            try values.encode(Kind.sendMessage, forKey: .type); try values.encode(message, forKey: .message)
        case .stop: try values.encode(Kind.stop, forKey: .type)
        case .retry: try values.encode(Kind.retry, forKey: .type)
        case let .approvePermission(id, approved):
            try values.encode(Kind.approvePermission, forKey: .type); try values.encode(id, forKey: .id); try values.encode(approved, forKey: .approved)
        case let .answerQuestion(id, answer):
            try values.encode(Kind.answerQuestion, forKey: .type); try values.encode(id, forKey: .id); try values.encode(answer, forKey: .answer)
        case .loadConversation: try values.encode(Kind.loadConversation, forKey: .type)
        case .loadDiff: try values.encode(Kind.loadDiff, forKey: .type)
        }
    }
}

struct InboxItem: Identifiable, Hashable {
    enum Kind: String { case permission, question, failed, completed }
    let id: String
    let taskID: String
    let title: String
    let kind: Kind

    static func items(from task: RemoteTask) -> [InboxItem] {
        if let pending = task.pending {
            switch pending {
            case let .permission(id, title): return [InboxItem(id: id, taskID: task.id, title: title, kind: .permission)]
            case let .question(id, title, _): return [InboxItem(id: id, taskID: task.id, title: title, kind: .question)]
            }
        }
        switch task.status {
        case .failed: return [InboxItem(id: task.id, taskID: task.id, title: task.title, kind: .failed)]
        case .completed: return [InboxItem(id: task.id, taskID: task.id, title: task.title, kind: .completed)]
        default: return []
        }
    }
}

enum DeviceStore {
    private static let key = "pairedDesktopDevices"

    static func load() -> [DesktopDevice] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder.jyycode.decode([DesktopDevice].self, from: data)) ?? []
    }

    static func save(_ devices: [DesktopDevice]) {
        UserDefaults.standard.set(try? JSONEncoder.jyycode.encode(devices), forKey: key)
    }
}

extension JSONDecoder {
    static let jyycode: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

extension JSONEncoder {
    static let jyycode: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

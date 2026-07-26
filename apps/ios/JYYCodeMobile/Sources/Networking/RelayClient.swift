import CryptoKit
import Foundation
import UIKit

private let protocolVersion = 1

actor RelayClient {
    private var connections: [String: RelayConnection] = [:]

    nonisolated static func registerPushToken(_ token: Data) {
        // The token is registered through the encrypted desktop channel on the
        // next foreground refresh. It is never included in a visible APNs body.
        UserDefaults.standard.set(token.map { String(format: "%02x", $0) }.joined(), forKey: "apnsToken")
    }

    func pair(_ payload: PairingPayload) async throws -> DesktopDevice {
        guard !payload.isExpired else { throw RelayError.pairingExpired }
        let phonePrivateKey = Curve25519.KeyAgreement.PrivateKey()
        let desktopPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(hex: payload.temporaryPublicKey))
        let shared = try phonePrivateKey.sharedSecretFromKeyAgreement(with: desktopPublicKey)
        let symmetricKey = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(hex: payload.pairingSecret),
            sharedInfo: Data("JYYCodeMobilePairing-v1".utf8),
            outputByteCount: 32
        )
        let deviceID = "iphone_\(UUID().uuidString.lowercased())"
        let keyReference = "relay.\(payload.routeID).\(deviceID)"
        try KeychainStore.save(symmetricKey.data, account: keyReference)
        let device = DesktopDevice(
            id: deviceID,
            name: UIDevice.current.name,
            routeID: payload.routeID,
            relayURL: payload.relayURL,
            sharedKeyReference: keyReference,
            lastSeen: nil
        )
        do {
            let connection = try await connection(for: device)
            try await connection.sendPairingRequest(
                deviceID: deviceID,
                deviceName: UIDevice.current.name,
                publicKey: phonePrivateKey.publicKey.rawRepresentation.hexEncodedString,
                secret: payload.pairingSecret
            )
        } catch {
            KeychainStore.remove(account: keyReference)
            connections.removeValue(forKey: deviceID)?.disconnect()
            throw error
        }
        return device
    }

    func fetchSummary(for devices: [DesktopDevice]) async throws -> [RemoteTask] {
        var tasks: [RemoteTask] = []
        for device in devices {
            let connection = try await connection(for: device)
            tasks += try await connection.requestSummary(pushToken: UserDefaults.standard.string(forKey: "apnsToken"))
        }
        return tasks.sorted { $0.updatedAt > $1.updatedAt }
    }

    func send(_ action: RemoteAction, to task: RemoteTask) async throws -> RemoteDetail? {
        guard let device = connections[task.deviceID]?.device else { throw RelayError.deviceOffline }
        return try await connection(for: device).sendCommand(action, taskID: task.id)
    }

    func disconnect(deviceID: String? = nil) {
        if let deviceID {
            connections.removeValue(forKey: deviceID)?.disconnect()
        } else {
            connections.values.forEach { $0.disconnect() }
            connections.removeAll()
        }
    }

    private func connection(for device: DesktopDevice) async throws -> RelayConnection {
        if let connection = connections[device.id] { return connection }
        let key = SymmetricKey(data: try KeychainStore.data(account: device.sharedKeyReference))
        let connection = RelayConnection(device: device, key: key)
        try await connection.connect()
        connections[device.id] = connection
        return connection
    }
}

private actor RelayConnection {
    let device: DesktopDevice
    private let key: SymmetricKey
    private var socket: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<RelayEnvelope, Error>] = [:]
    private var lastIncomingSequence: UInt64 = 0

    init(device: DesktopDevice, key: SymmetricKey) {
        self.device = device
        self.key = key
    }

    func connect() async throws {
        guard socket == nil else { return }
        let url = device.relayURL
        guard url.scheme == "wss" || url.scheme == "ws" else { throw RelayError.invalidRelayURL }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        socket = task
        try await send(RelayHello(routeID: device.routeID, clientID: device.id, role: "mobile"))
        Task { await receiveLoop() }
    }

    func disconnect() {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        pending.values.forEach { $0.resume(throwing: RelayError.deviceOffline) }
        pending.removeAll()
    }

    func sendPairingRequest(deviceID: String, deviceName: String, publicKey: String, secret: String) async throws {
        let correlationID = UUID().uuidString
        let response = try await request(
            .pair(deviceID: deviceID, deviceName: deviceName, publicKey: publicKey, pairingSecret: secret),
            correlationID: correlationID,
            pairingPublicKey: publicKey
        )
        guard case .pairResult = try decrypt(response) else { throw RelayError.invalidResponse }
    }

    func requestSummary(pushToken: String?) async throws -> [RemoteTask] {
        let correlationID = UUID().uuidString
        let response = try await request(.summary(pushToken: pushToken), correlationID: correlationID)
        guard case let .summary(tasks) = try decrypt(response) else { throw RelayError.invalidResponse }
        await MainActor.run {
            NotificationCenter.default.post(name: .jyycodeDesktopSeen, object: nil, userInfo: ["deviceID": device.id])
        }
        return tasks
    }

    func sendCommand(_ action: RemoteAction, taskID: String) async throws -> RemoteDetail? {
        let commandID = UUID().uuidString
        let response = try await request(.command(id: commandID, taskID: taskID, action: action), correlationID: commandID)
        guard case let .commandResult(ok, error, detail) = try decrypt(response) else { throw RelayError.invalidResponse }
        guard ok else { throw RelayError.desktopRejected(error ?? "The desktop rejected this action.") }
        return detail
    }

    private func request(_ payload: RelayPayload, correlationID: String, pairingPublicKey: String? = nil) async throws -> RelayEnvelope {
        try await withCheckedThrowingContinuation { continuation in
            pending[correlationID] = continuation
            Task {
                do {
                    try await sendEncrypted(payload, recipientID: device.routeID, correlationID: correlationID, pairingPublicKey: pairingPublicKey)
                } catch {
                    pending.removeValue(forKey: correlationID)?.resume(throwing: error)
                }
            }
        }
    }

    private func receiveLoop() async {
        while let socket {
            do {
                let message = try await socket.receive()
                let data: Data
                switch message {
                case let .string(value): data = Data(value.utf8)
                case let .data(value): data = value
                @unknown default: continue
                }
                let envelope = try JSONDecoder.jyycode.decode(RelayEnvelope.self, from: data)
                guard envelope.sequence > lastIncomingSequence else { continue }
                lastIncomingSequence = envelope.sequence
                if envelope.correlationID == nil, case let .summaryUpdate(tasks) = try decrypt(envelope) {
                    await MainActor.run {
                        NotificationCenter.default.post(name: .jyycodeSummaryUpdate, object: nil, userInfo: ["tasks": tasks])
                    }
                    continue
                }
                if let correlationID = envelope.correlationID, let continuation = pending.removeValue(forKey: correlationID) {
                    continuation.resume(returning: envelope)
                }
            } catch {
                disconnect()
                return
            }
        }
    }

    private func send(_ payload: some Encodable) async throws {
        guard let socket else { throw RelayError.deviceOffline }
        try await socket.send(.data(JSONEncoder.jyycode.encode(payload)))
    }

    private func sendEncrypted(
        _ payload: RelayPayload,
        recipientID: String,
        correlationID: String? = nil,
        pairingPublicKey: String? = nil
    ) async throws {
        let encoded = try JSONEncoder.jyycode.encode(payload)
        let sealed = try ChaChaPoly.seal(encoded, using: key)
        let envelope = RelayEnvelope(
            routeID: device.routeID,
            senderID: device.id,
            recipientID: recipientID,
            messageID: UUID().uuidString,
            correlationID: correlationID,
            pairingPublicKey: pairingPublicKey,
            sequence: UInt64(Date().timeIntervalSince1970 * 1000),
            ciphertext: sealed.combined.base64EncodedString()
        )
        try await send(envelope)
    }

    private func decrypt(_ envelope: RelayEnvelope) throws -> RelayPayload {
        guard let data = Data(base64Encoded: envelope.ciphertext) else { throw RelayError.invalidResponse }
        return try JSONDecoder.jyycode.decode(RelayPayload.self, from: ChaChaPoly.open(try ChaChaPoly.SealedBox(combined: data), using: key))
    }
}

private struct RelayHello: Codable {
    let type = "relay.hello"
    let protocolVersion = protocolVersion
    let routeID: String
    let clientID: String
    let role: String
}

private struct RelayEnvelope: Codable {
    let type = "relay.envelope"
    let protocolVersion = protocolVersion
    let routeID: String
    let senderID: String
    let recipientID: String
    let messageID: String
    let correlationID: String?
    let pairingPublicKey: String?
    let sequence: UInt64
    let ciphertext: String
}

private enum RelayPayload: Codable {
    case pair(deviceID: String, deviceName: String, publicKey: String, pairingSecret: String)
    case summary(pushToken: String?)
    case command(id: String, taskID: String, action: RemoteAction)
    case pairResult
    case summaryResult([RemoteTask])
    case summaryUpdate([RemoteTask])
    case commandResult(ok: Bool, error: String?, detail: RemoteDetail?)

    private enum CodingKeys: String, CodingKey { case type, deviceID, deviceName, publicKey, pairingSecret, id, taskID, action, tasks, ok, error, data, pushToken }
    private enum Kind: String, Codable { case pair, summary, command, pairResult, summaryResult, summaryUpdate, commandResult }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .type) {
        case .pair:
            self = .pair(
                deviceID: try container.decode(String.self, forKey: .deviceID),
                deviceName: try container.decode(String.self, forKey: .deviceName),
                publicKey: try container.decode(String.self, forKey: .publicKey),
                pairingSecret: try container.decode(String.self, forKey: .pairingSecret)
            )
        case .summary: self = .summary(pushToken: try container.decodeIfPresent(String.self, forKey: .pushToken))
        case .command: self = .command(id: try container.decode(String.self, forKey: .id), taskID: try container.decode(String.self, forKey: .taskID), action: try container.decode(RemoteAction.self, forKey: .action))
        case .pairResult: self = .pairResult
        case .summaryResult: self = .summaryResult(try container.decode([RemoteTask].self, forKey: .tasks))
        case .summaryUpdate: self = .summaryUpdate(try container.decode([RemoteTask].self, forKey: .tasks))
        case .commandResult: self = .commandResult(ok: try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false, error: try container.decodeIfPresent(String.self, forKey: .error), detail: try container.decodeIfPresent(RemoteDetail.self, forKey: .data))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .pair(deviceID, deviceName, publicKey, pairingSecret):
            try container.encode(Kind.pair, forKey: .type)
            try container.encode(deviceID, forKey: .deviceID)
            try container.encode(deviceName, forKey: .deviceName)
            try container.encode(publicKey, forKey: .publicKey)
            try container.encode(pairingSecret, forKey: .pairingSecret)
        case let .summary(pushToken): try container.encode(Kind.summary, forKey: .type); try container.encodeIfPresent(pushToken, forKey: .pushToken)
        case let .command(id, taskID, action):
            try container.encode(Kind.command, forKey: .type); try container.encode(id, forKey: .id); try container.encode(taskID, forKey: .taskID); try container.encode(action, forKey: .action)
        case .pairResult: try container.encode(Kind.pairResult, forKey: .type)
        case let .summaryResult(tasks): try container.encode(Kind.summaryResult, forKey: .type); try container.encode(tasks, forKey: .tasks)
        case let .summaryUpdate(tasks): try container.encode(Kind.summaryUpdate, forKey: .type); try container.encode(tasks, forKey: .tasks)
        case let .commandResult(ok, error, detail):
            try container.encode(Kind.commandResult, forKey: .type); try container.encode(ok, forKey: .ok); try container.encodeIfPresent(error, forKey: .error); try container.encodeIfPresent(detail, forKey: .data)
        }
    }
}

extension Notification.Name {
    static let jyycodeSummaryUpdate = Notification.Name("ai.jyycode.mobile.summaryUpdate")
    static let jyycodeDesktopSeen = Notification.Name("ai.jyycode.mobile.desktopSeen")
}

enum RelayError: LocalizedError {
    case pairingExpired, invalidRelayURL, deviceOffline, invalidResponse, desktopRejected(String)

    var errorDescription: String? {
        switch self {
        case .pairingExpired: return "The desktop pairing QR code has expired."
        case .invalidRelayURL: return "The pairing QR code contains an invalid relay address."
        case .deviceOffline: return "The paired desktop is offline."
        case .invalidResponse: return "The desktop returned an invalid encrypted response."
        case let .desktopRejected(message): return message
        }
    }
}

extension SymmetricKey {
    var data: Data { withUnsafeBytes { Data($0) } }
}

extension Data {
    init(hex: String) {
        self.init(hex.utf8.chunks(ofCount: 2).compactMap { UInt8(String(decoding: $0, as: UTF8.self), radix: 16) })
    }
}

private extension Data {
    var hexEncodedString: String { map { String(format: "%02x", $0) }.joined() }
}

private extension Collection where Element == UInt8 {
    func chunks(ofCount count: Int) -> [SubSequence] {
        stride(from: startIndex, to: endIndex, by: count).map { start in
            let end = index(start, offsetBy: count, limitedBy: endIndex) ?? endIndex
            return self[start..<end]
        }
    }
}

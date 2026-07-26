import AVFoundation
import SwiftUI
import UIKit

struct DevicesView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var scanning = false
    @State private var errorMessage: String?
    @AppStorage("allowDetailedTaskContent") private var allowDetailedTaskContent = true

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { scanning = true } label: { Label("扫描配对二维码", systemImage: "qrcode.viewfinder") }
                } footer: {
                    Text("每台电脑需单独配对。移除设备会删除此 iPhone 上的密钥。")
                }

                Section("已配对电脑") {
                    ForEach(store.devices) { device in
                        HStack {
                            Image(systemName: device.isOnline ? "desktopcomputer.and.arrow.down" : "desktopcomputer")
                            VStack(alignment: .leading) {
                                Text(device.name)
                                Text(device.isOnline ? "在线" : "离线")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(role: .destructive) { store.revoke(device) } label: { Image(systemName: "trash") }
                        }
                    }
                }

                Section("隐私") {
                    Toggle("允许按需查看完整对话与 Diff", isOn: $allowDetailedTaskContent)
                    Text("关闭后仅保留任务标题、状态和摘要。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("清除本地任务缓存", role: .destructive) { store.clearLocalCache() }
                    Text("不会移除已配对电脑或其安全密钥。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("通知") {
                    Button("打开系统通知设置") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(url)
                    }
                    Text("通知只使用“需要处理 / 已失败 / 已完成”等通用文字，不含任务内容。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设备")
            .sheet(isPresented: $scanning) {
                QRScanner { result in
                    scanning = false
                    switch result {
                    case let .success(raw): Task { await pair(raw) }
                    case let .failure(error): errorMessage = error.localizedDescription
                    }
                }
            }
            .alert("无法配对", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("好", role: .cancel) {}
            } message: { Text(errorMessage ?? "") }
        }
    }

    private func pair(_ raw: String) async {
        do {
            let qr = try JSONDecoder().decode(PairingQRCode.self, from: Data(raw.utf8))
            try await store.pair(qr.payload)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct PairingQRCode: Decodable {
    let routeID: String
    let relayURL: URL
    let pairingSecret: String
    let temporaryPublicKey: String
    let expiresAt: UInt64

    var payload: PairingPayload {
        PairingPayload(routeID: routeID, relayURL: relayURL, pairingSecret: pairingSecret, temporaryPublicKey: temporaryPublicKey, expiresAt: Date(timeIntervalSince1970: TimeInterval(expiresAt)))
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let completion: (Result<String, Error>) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.completion = completion
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
}

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var completion: ((Result<String, Error>) -> Void)?
    private let session = AVCaptureSession()

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
            completion?(.failure(ScannerError.unavailable)); return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { completion?(.failure(ScannerError.unavailable)); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.frame = view.layer.bounds
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        session.startRunning()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        session.stopRunning()
        completion?(.success(value))
    }
}

private enum ScannerError: LocalizedError { case unavailable; var errorDescription: String? { "Camera access is unavailable." } }

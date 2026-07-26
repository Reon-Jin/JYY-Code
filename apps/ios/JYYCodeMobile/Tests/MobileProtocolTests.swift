@testable import JYYCodeMobile
import XCTest

final class MobileProtocolTests: XCTestCase {
    func testActionUsesExplicitAllowlistedWireType() throws {
        let encoded = try JSONEncoder.jyycode.encode(RemoteAction.sendMessage("Continue with the tests."))
        let value = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        XCTAssertEqual(value?["type"] as? String, "sendMessage")
        XCTAssertEqual(value?["message"] as? String, "Continue with the tests.")
        XCTAssertNil(value?["terminal"])
    }

    func testExpiredPairingPayloadIsRejected() {
        let payload = PairingPayload(
            routeID: "desktop_test",
            relayURL: URL(string: "wss://relay.example.test/connect")!,
            pairingSecret: "0123456789abcdef",
            temporaryPublicKey: String(repeating: "a", count: 64),
            expiresAt: Date(timeIntervalSinceNow: -1)
        )
        XCTAssertTrue(payload.isExpired)
    }
}

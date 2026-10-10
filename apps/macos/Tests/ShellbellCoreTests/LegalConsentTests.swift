import XCTest

@testable import ShellbellCore

final class LegalConsentTests: XCTestCase {
  private func withStore(_ body: (LegalConsent, UserDefaults) -> Void) {
    let name = "ShellbellLegalConsentTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    body(LegalConsent(defaults: defaults), defaults)
  }

  func testTermsRequireCurrentVersionAndAcceptanceDate() {
    withStore { consent, defaults in
      XCTAssertFalse(consent.hasAcceptedTerms)
      consent.acceptTerms()
      XCTAssertTrue(LegalConsent(defaults: defaults).hasAcceptedTerms)
      defaults.set(["version": "older", "acceptedAt": Date()], forKey: "shellbell.terms.v1")
      XCTAssertFalse(consent.hasAcceptedTerms)
      defaults.set(["version": LegalConsent.termsVersion], forKey: "shellbell.terms.v1")
      XCTAssertFalse(consent.hasAcceptedTerms)
    }
  }

  func testRelayAgreementIsSpecificToNormalizedOrigin() {
    withStore { consent, defaults in
      consent.acceptRelay(" WSS://PRIVATE.example.com:443/ ")
      XCTAssertTrue(LegalConsent(defaults: defaults).hasAcceptedRelay("wss://private.example.com"))
      for other in [
        "ws://private.example.com", "wss://private.example.com:444", "wss://other.example.com",
      ] {
        XCTAssertFalse(consent.hasAcceptedRelay(other))
      }
      for invalid in [
        "https://private.example.com", "wss://user@private.example.com",
        "wss://private.example.com/path",
      ] {
        XCTAssertNil(LegalConsent.relayOrigin(invalid))
        consent.acceptRelay(invalid)
        XCTAssertFalse(consent.hasAcceptedRelay(invalid))
      }
    }
  }

  func testRevisedNoticeAndCorruptStorageRequireFreshAgreement() {
    withStore { consent, defaults in
      defaults.set(
        ["version": 0, "origins": ["wss://private.example.com"]],
        forKey: "shellbell.relay-consent.v1")
      XCTAssertFalse(consent.hasAcceptedRelay("wss://private.example.com"))
      defaults.set("broken", forKey: "shellbell.relay-consent.v1")
      XCTAssertFalse(consent.hasAcceptedRelay("wss://private.example.com"))
      defaults.set("broken", forKey: "shellbell.terms.v1")
      XCTAssertFalse(consent.hasAcceptedTerms)
    }
  }

  func testRelayChoicesAreBounded() {
    withStore { consent, _ in
      for index in 0..<65 { consent.acceptRelay("wss://relay\(index).example.com") }
      XCTAssertFalse(consent.hasAcceptedRelay("wss://relay0.example.com"))
      XCTAssertTrue(consent.hasAcceptedRelay("wss://relay64.example.com"))
    }
  }
}

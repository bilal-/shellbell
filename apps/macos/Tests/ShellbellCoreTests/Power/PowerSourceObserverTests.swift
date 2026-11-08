import CoreFoundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

final class PowerSourceObserverTests: XCTestCase {
  @MainActor func testPollingDetectsMissedNotificationsAndUnknownReadings() {
    for notificationsAvailable in [false, true] {
      var state = PowerSourceState(power: .ac, isLaptop: true)
      var changes: [PowerSourceState] = []
      let observer = PowerSourceObserver(
        read: { state },
        makeSource: { _ in
          guard notificationsAvailable else { return nil }
          var context = CFRunLoopSourceContext()
          return CFRunLoopSourceCreate(nil, 0, &context)
        })
      observer.start { changes.append($0) }
      observer.refresh()
      XCTAssertEqual(changes, [state])
      for power in [ExternalPower.battery, .unknown, .ac] {
        state = .init(power: power, isLaptop: true)
        observer.refresh()
        XCTAssertEqual(changes.last, state)
      }
      XCTAssertEqual(changes.count, 4)
      observer.stop()
      state = .init(power: .battery, isLaptop: true)
      observer.refresh()
      XCTAssertEqual(changes.count, 4)
      observer.start { changes.append($0) }
      XCTAssertEqual(changes.last, state)
      XCTAssertEqual(changes.count, 5)
      observer.stop()
    }
  }

  @MainActor func testSubscriptionSetupRereadsPowerBeforeReturning() {
    var state = PowerSourceState(power: .ac, isLaptop: true)
    var changes: [ExternalPower] = []
    let observer = PowerSourceObserver(
      read: { state },
      makeSource: { _ in
        state = .init(power: .battery, isLaptop: true)
        return nil
      })
    observer.start { changes.append($0.power) }
    XCTAssertEqual(changes, [.ac, .battery])
    observer.stop()
  }

  func testLidEvidencePreservesUnknownAndRejectsNonBooleanValues() {
    XCTAssertEqual(PowerLidState.decode(kCFBooleanTrue), true)
    XCTAssertEqual(PowerLidState.decode(kCFBooleanFalse), false)
    XCTAssertNil(PowerLidState.decode(nil))
    XCTAssertNil(PowerLidState.decode(NSNumber(value: 1)))
    XCTAssertNil(PowerLidState.decode("closed" as CFString))
  }
}

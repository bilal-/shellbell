import Combine
import Foundation

public struct ComputerUpdateOffer: Equatable {
  public let version: String
  public let build: Int
  public let notes: URL
  public let download: URL?
}

/// One explicit check, using its own child process. Never shares the service bridge.
@MainActor public final class ComputerUpdates: ObservableObject {
  @Published public private(set) var checking = false
  @Published public private(set) var message = "Check when you want to update. Downloads and installation are manual."
  @Published public private(set) var offer: ComputerUpdateOffer?
  public let version: String
  public let build: Int
  private let arm64: Bool
  private let osVersion: String
  private let makeTransport: () throws -> any BridgeTransport
  private let clock: any BridgeScheduling
  private var transport: (any BridgeTransport)?
  private var cancelDeadline: (() -> Void)?
  private var bytes = Data()
  private var generation = 0

  public init(version: String, build: Int, arm64: Bool, osVersion: String,
    clock: any BridgeScheduling, makeTransport: @escaping () throws -> any BridgeTransport) {
    self.version = version; self.build = build; self.arm64 = arm64; self.osVersion = osVersion
    self.clock = clock; self.makeTransport = makeTransport
  }

  public func check() {
    guard !checking else { return }
    cancel()
    checking = true; offer = nil; message = "Checking for updates…"
    let attempt = generation
    do {
      let child = try makeTransport()
      transport = child
      child.onData = { [weak self] data in
        guard let self, self.generation == attempt, self.checking else { return }
        guard self.bytes.count + data.count <= 64 * 1024 else {
          self.fail("The update response was too large. Try again later."); return
        }
        self.bytes.append(data)
      }
      child.onEnd = { [weak self] in
        guard let self, self.generation == attempt, self.checking else { return }
        self.finish()
      }
      cancelDeadline = clock.after(35) { [weak self] in
        guard let self, self.generation == attempt else { return }
        self.fail("The update check timed out. Check your connection and try again.")
      }
    } catch { fail("Could not start the update check. Try again from the installed Shellbell app.") }
  }

  public func cancel() {
    generation += 1
    transport?.onData = nil; transport?.onEnd = nil; transport?.close(); transport = nil
    cancelDeadline?(); cancelDeadline = nil; bytes.removeAll()
    if checking { message = "Update check cancelled." }
    checking = false
  }

  private func fail(_ text: String) { cancel(); offer = nil; message = text }

  private func finish() {
    let data = bytes
    cancel()
    do {
      let result = try JSONDecoder().decode(UpdateResult.self, from: data)
      guard result.schemaVersion == 1, result.currentVersion == version,
        result.release.component == "computer", result.release.channel == "stable",
        result.release.tag == "shellbell@" + result.release.version,
        let installed = Self.parts(version), let latest = Self.parts(result.release.version)
      else { throw BridgeFailure.badRequest }
      let newer = installed.lexicographicallyPrecedes(latest)
      let mac = result.release.platforms.macosArm64
      guard newer || (installed == latest && (mac?.buildNumber ?? 0) > build) else {
        message = "You're up to date."; return
      }
      let tag = "shellbell%40" + result.release.version
      let base = "https://github.com/bilal-/shellbell/releases/"
      let notes = URL(string: base + "tag/" + tag)!
      var download: URL?
      var text = "A newer computer release is available. A compatible Mac installer is not available."
      if let mac, arm64, mac.signed, mac.notarized, mac.buildNumber > 0,
        mac.asset == "Shellbell-\(result.release.version)-arm64.dmg",
        let minimum = Self.parts(mac.minimumOS, allowTwo: true),
        let currentOS = Self.parts(osVersion, allowTwo: true) {
        if currentOS.lexicographicallyPrecedes(minimum) {
          text = "This update requires macOS \(mac.minimumOS) or later."
        } else {
          download = URL(string: base + "download/" + tag + "/" + mac.asset)
          text = "Version \(result.release.version) (build \(mac.buildNumber)) is available. Download the installer, then quit Shellbell before replacing the app."
        }
      }
      offer = ComputerUpdateOffer(version: result.release.version, build: mac?.buildNumber ?? 0,
        notes: notes, download: download)
      message = text
    } catch { fail("Could not verify update information. Check your connection and try again later.") }
  }

  private static func parts(_ text: String, allowTwo: Bool = false) -> [Int]? {
    guard text.count <= 32 else { return nil }
    let values = text.split(separator: ".", omittingEmptySubsequences: false)
    guard values.count == 3 || (allowTwo && values.count == 2) else { return nil }
    var result: [Int] = []
    for value in values {
      guard !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }),
        value == "0" || !value.hasPrefix("0"), let number = Int(value) else { return nil }
      result.append(number)
    }
    if result.count == 2 { result.append(0) }
    return result
  }
}

private struct UpdateResult: Decodable {
  let schemaVersion: Int
  let currentVersion: String
  let release: Release
  struct Release: Decodable {
    let version: String; let tag: String; let component: String; let channel: String
    let platforms: Platforms
  }
  struct Platforms: Decodable { let macosArm64: Mac? }
  struct Mac: Decodable {
    let asset: String; let buildNumber: Int; let minimumOS: String
    let signed: Bool; let notarized: Bool
  }
}

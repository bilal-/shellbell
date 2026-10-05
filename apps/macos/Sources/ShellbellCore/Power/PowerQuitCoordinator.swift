public struct PowerQuitOutcome {
  public let powerRestored: Bool
  public let serviceStopped: Bool
  public var complete: Bool { powerRestored && serviceStopped }
}

/// Both cleanup paths always run. One failure must not leave remote access on,
/// nor may a successful service stop conceal unverified power restoration.
@MainActor public final class PowerQuitCoordinator {
  private var generation: UInt64 = 0
  private var powerResult: Bool?
  private var serviceResult: Bool?
  private var completions: [(PowerQuitOutcome) -> Void] = []
  public init() {}

  public func quit(
    releasePower: (@escaping (Bool) -> Void) -> Void,
    stopService: (@escaping (Bool) -> Void) -> Void,
    completion: @escaping (PowerQuitOutcome) -> Void
  ) {
    if !completions.isEmpty {
      completions.append(completion)
      return
    }
    completions = [completion]
    generation += 1
    let token = generation
    powerResult = nil
    serviceResult = nil
    releasePower { [weak self] value in
      guard let self, self.generation == token, self.powerResult == nil else { return }
      self.powerResult = value
      self.finish()
    }
    stopService { [weak self] value in
      guard let self, self.generation == token, self.serviceResult == nil else { return }
      self.serviceResult = value
      self.finish()
    }
  }

  private func finish() {
    guard let powerResult, let serviceResult else { return }
    let outcome = PowerQuitOutcome(powerRestored: powerResult, serviceStopped: serviceResult)
    let callbacks = completions
    completions = []
    for callback in callbacks { callback(outcome) }
  }
}

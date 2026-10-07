import Foundation

public indirect enum JSONValue: Codable, Equatable, Sendable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  public subscript(_ key: String) -> JSONValue { object?[key] ?? .null }
  public var object: [String: JSONValue]? { if case .object(let v) = self { v } else { nil } }
  public var array: [JSONValue]? { if case .array(let v) = self { v } else { nil } }
  public var string: String? { if case .string(let v) = self { v } else { nil } }
  public var number: Double? { if case .number(let v) = self { v } else { nil } }
  public var bool: Bool? { if case .bool(let v) = self { v } else { nil } }
}

public enum Wire {
  public static let maxID: UInt64 = 9_007_199_254_740_991
  public static let capabilities = [
    "status", "settings", "lifecycle", "pairing", "devices", "diagnostics",
  ]
  public static let configKeys = [
    "relay", "name", "accent", "notifyMinCommandMs", "idleQuietMs", "idleMinActiveMs",
  ]
  public static func valid(_ value: JSONValue, kind: String, command: String? = nil) -> Bool {
    switch kind {
    case "request": return request(value)
    case "response":
      if value["ok"] == .bool(false) {
        return object(
          value,
          [
            "v": literal(.number(1)), "id": positive, "ok": literal(.bool(false)),
            "error": {
              object($0, ["code": { $0.string.flatMap(BridgeFailure.init(rawValue:)) != nil }])
            },
          ])
      }
      guard let command else { return false }
      return object(
        value,
        [
          "v": literal(.number(1)), "id": positive, "ok": literal(.bool(true)),
          "data": { payload($0, command: command) },
        ])
    case "event":
      var fields: [String: Check] = ["v": literal(.number(1)), "flowId": flow]
      if value["event"] == .string("pairing.request") {
        fields.merge([
          "event": literal(.string("pairing.request")), "challengeId": flow,
          "phoneFp": fingerprint, "name": string(1, 64),
        ]) { _, new in new }
      } else {
        fields["event"] = literal(.string("pairing.closed"))
      }
      return object(value, fields)
    case "helper":
      if value["ok"] == .bool(true) {
        return object(
          value,
          [
            "v": literal(.number(1)), "ok": literal(.bool(true)),
            "status": enumeration(["not-registered", "enabled", "requires-approval", "not-found"]),
          ])
      }
      return object(
        value,
        [
          "v": literal(.number(1)), "ok": literal(.bool(false)),
          "error": {
            object(
              $0,
              [
                "code": enumeration(["unavailable", "denied", "invalid-bundle", "operation-failed"])
              ])
          },
        ])
    case "record": return record(value)
    default: return false
    }
  }
  public static func decode(_ data: Data, kind: String, command: String? = nil) throws -> JSONValue
  {
    let value = try parse(data, limit: kind == "record" ? 2 * 1024 * 1024 : LineFramer.lineLimit)
    guard valid(value, kind: kind, command: command) else { throw BridgeFailure.badRequest }
    return value
  }
  static func parse(_ data: Data, limit: Int = LineFramer.lineLimit) throws -> JSONValue {
    guard data.count <= limit, !data.starts(with: [0xef, 0xbb, 0xbf]),
      String(data: data, encoding: .utf8) != nil
    else { throw BridgeFailure.badRequest }
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }

  private typealias Check = (JSONValue) -> Bool
  private static func object(
    _ value: JSONValue, _ required: [String: Check], _ optional: [String: Check] = [:]
  ) -> Bool {
    guard let fields = value.object,
      Set(fields.keys).isSubset(of: Set(required.keys).union(optional.keys)),
      required.allSatisfy({ key, check in fields[key].map(check) == true })
    else { return false }
    return optional.allSatisfy { key, check in fields[key].map(check) ?? true }
  }
  private static func literal(_ value: JSONValue) -> Check { { $0 == value } }
  private static func enumeration(_ values: [String]) -> Check {
    { $0.string.map(values.contains) ?? false }
  }
  private static func string(_ min: Int = 0, _ max: Int = Int.max) -> Check {
    { $0.string.map { (min...max).contains($0.utf16.count) } ?? false }
  }
  private static func regex(_ pattern: String) -> Check {
    { $0.string.map { $0.range(of: pattern, options: .regularExpression) != nil } ?? false }
  }
  private static func nullable(_ check: @escaping Check) -> Check { { $0 == .null || check($0) } }
  private static func array(_ check: @escaping Check, max: Int = Int.max) -> Check {
    { $0.array.map { $0.count <= max && $0.allSatisfy(check) } ?? false }
  }
  private static func integer(_ value: JSONValue, min: Double = 0) -> Bool {
    value.number.map {
      $0.isFinite && $0.rounded(.towardZero) == $0 && $0 >= min && $0 <= Double(maxID)
    } ?? false
  }
  private static func positive(_ value: JSONValue) -> Bool { integer(value, min: 1) }
  private static func boolean(_ value: JSONValue) -> Bool { value.bool != nil }
  private static func uuid(_ value: JSONValue) -> Bool {
    regex(
      "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    )(value)
  }
  private static func fingerprint(_ value: JSONValue) -> Bool { regex("^[a-z2-7]{26}$")(value) }
  private static func flow(_ value: JSONValue) -> Bool { regex("^[A-Za-z0-9_-]{22}$")(value) }
  private static func revision(_ value: JSONValue) -> Bool { regex("^[0-9a-f]{64}$")(value) }
  private static func bounded(_ value: JSONValue) -> Bool {
    value.string.map { $0.utf8.count <= 4096 } ?? false
  }
  public static func path(_ value: JSONValue) -> Bool {
    guard let v = value.string else { return false }
    return v.hasPrefix("/") && bounded(value)
      && !v.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
  }
  private static func runtime(_ value: JSONValue) -> Bool {
    object(
      value,
      [
        "pid": positive, "agentVersion": string(1), "computerFp": fingerprint,
        "stateDir": path, "serviceInstance": nullable(uuid),
      ])
  }
  private static func expected(_ value: JSONValue) -> Bool {
    object(value, ["revision": nullable(uuid), "runtime": nullable(runtime)])
  }
  private static func selection(_ value: JSONValue) -> Bool {
    object(
      value,
      [
                "mode": enumeration(["manual", "persistent", "desktop"]), "stateDir": path,
        "computerFp": fingerprint, "serviceInstance": uuid, "bundlePath": path,
        "bundleId": literal(.string("sh.bilal.shellbell.host")), "agentVersion": string(1),
        "environment": {
          object(
            $0,
            [
              "PATH": { v in
                bounded(v)
                  && (v.string?.components(separatedBy: ":").allSatisfy { path(.string($0)) }
                    ?? false)
              },
              "SHELLBELL_DIR": path, "SHELLBELL_SERVICE_INSTANCE": uuid,
            ],
            ["HERDR_SOCKET_PATH": path, "XDG_CONFIG_HOME": path])
        },
      ])
      && value["environment"]["SHELLBELL_DIR"] == value["stateDir"]
      && value["environment"]["SHELLBELL_SERVICE_INSTANCE"] == value["serviceInstance"]
  }
  private static func transition(_ value: JSONValue, privateRecord: Bool = false) -> Bool {
    var fields: [String: Check] = [
      "id": uuid, "action": enumeration(["start", "stop", "restart", "remove", "recover"]),
      "phase": enumeration([
        "prepared", "source-stop-requested", "source-stopped", "destination-start-requested",
        "awaiting-approval", "destination-ready", "recovery-required",
      ]),
    ]
    if privateRecord {
      fields.merge([
        "source": nullable(selection), "destination": nullable(selection),
        "recoveryId": nullable(uuid),
      ]) { _, new in new }
    }
    return object(
      value, fields,
      privateRecord ? ["restoreLegacy": { object($0, ["restartPrevious": boolean]) }] : [:])
      && (value["restoreLegacy"] == .null || value["action"] == .string("recover"))
  }
  private static func record(_ value: JSONValue) -> Bool {
    object(
      value,
      [
        "v": literal(.number(1)), "revision": uuid, "selection": nullable(selection),
        "transition": nullable({ transition($0, privateRecord: true) }),
        "recovery": nullable({
          object(
            $0,
            [
              "id": uuid, "definitionPath": path,
              "rawBase64": { v in
                guard let s = v.string, let d = Data(base64Encoded: s) else { return false }
                return d.count <= 1_048_576 && d.base64EncodedString() == s
              },
              "sha256": revision, "wasLoaded": boolean, "stateDir": path, "computerFp": fingerprint,
            ])
        }),
      ])
      && (value["transition"]["recoveryId"] == .null
        || value["transition"]["recoveryId"] == value["recovery"]["id"])
  }
  private static func job(_ value: JSONValue) -> Bool {
    object(
      value,
      [
        "registration": enumeration([
          "not-registered", "enabled", "requires-approval", "not-found", "unknown",
        ]),
        "loaded": boolean, "pid": nullable(positive), "bundlePath": nullable(path),
      ])
  }
  private static func phone(_ value: JSONValue) -> Bool {
    object(
      value, ["phoneFp": fingerprint, "name": string(1, 64), "lastSeenAt": nullable(string())])
  }
  private static func local(_ value: JSONValue) -> Bool {
    guard
      object(
        value,
        [
          "controlVersion": literal(.number(1)), "process": runtime,
          "backends": array({
            object($0, ["name": regex("^[a-z][a-z0-9-]{0,31}$"), "connected": boolean])
          }, max: 32),
          "terminalReady": boolean, "relayOnline": boolean, "sessions": { integer($0) },
          "phones": array(phone, max: 10),
          "connected": array(
            {
              object(
                $0, ["phoneFp": fingerprint, "name": string(1, 64), "viewed": nullable(string())],
                ["transport": transport])
            }, max: 10),
        ])
    else { return false }
    let backends = value["backends"].array!
    let names = backends.map { $0["name"].string! }
    return Array(names.prefix(3)) == ["iterm2", "tmux", "herdr"]
      && Set(names).count == names.count
      && Array(names.dropFirst(3)) == names.dropFirst(3).sorted()
      && value["terminalReady"].bool == backends.contains { $0["connected"] == .bool(true) }
  }
  private static func transport(_ value: JSONValue) -> Bool {
    object(
      value, [
        "route": nullable(enumeration(["relay", "direct"])), "ready": boolean,
        "phase": string(0, 32), "lastFailure": nullable(string(0, 32)),
        "relaySent": { integer($0) }, "relayReceived": { integer($0) },
        "directSent": { integer($0) }, "directReceived": { integer($0) },
      ])
  }
  private static func status(_ value: JSONValue) -> Bool {
    object(
      value,
      [
        "revision": nullable(uuid), "selection": nullable(selection),
        "transition": nullable({ transition($0) }),
        "recoveryAvailable": boolean,
        "legacy": {
          object($0, ["installed": boolean, "loaded": boolean, "stateDir": nullable(path)])
        },
        "manual": job, "persistent": job,
        "local": {
          object(
            $0,
            [
              "kind": enumeration(["verified", "foreign", "absent", "unverified"]),
              "status": nullable(local),
            ])
        },
            ], ["manualRecoveryAvailable": boolean, "ownership": ownership, "desktop": job,
                "desktopLogin": enumeration(["not-registered", "enabled", "requires-approval", "not-found", "unknown"])])
    }
    private static func ownership(_ value: JSONValue) -> Bool {
        object(value, [
            "revision": nullable(uuid),
            "mode": nullable(enumeration(["desktop", "headless", "legacy-native"])),
            "consented": boolean, "startupEnabled": nullable(boolean),
            "transition": nullable({ object($0, [
                "id": uuid,
                "source": nullable(enumeration(["desktop", "headless", "legacy-native"])),
                "target": enumeration(["desktop", "headless"]),
                "sourceManager": nullable(enumeration(["desktop-child", "native-manual", "native-persistent", "launchd", "systemd"])),
                "sourceInstance": nullable(uuid), "stateDir": path, "computerFp": fingerprint,
                "targetBundlePath": nullable(path), "targetVersion": string(1, 256),
                "phase": enumeration(["prepared", "source-stopped", "destination-started", "recovery-required"]),
            ]) }),
        ])
    }
  private static func validURL(_ value: JSONValue) -> Bool {
    guard let text = value.string, let url = URL(string: text), let scheme = url.scheme else {
      return false
    }
    if let port = url.port, !(0...65535).contains(port) { return false }
    if ["http", "https", "ws", "wss", "ftp"].contains(scheme.lowercased()) {
      guard let host = url.host, !host.isEmpty else { return false }
    }
    return true
  }
  private static func settings(_ value: JSONValue) -> Bool {
    object(
      value,
      [
        "saved": {
          object(
            $0,
            [
              "v": literal(.number(1)),
              "relayUrl": validURL,
              "computerName": string(1, 64), "accent": string(1, 32),
            ],
            [
              "notifyMinCommandMs": { integer($0) }, "idleQuietMs": positive,
              "idleMinActiveMs": { integer($0) },
              "terminalPlugins": array({ path($0) && ($0.string?.hasSuffix(".mjs") ?? false) }, max: 29),
            ])
        },
        "savedRevision": revision, "appliedRevision": nullable(revision),
        "applied": enumeration(["not-running", "unknown", "matches", "restart-required"]),
      ])
  }
  private static func payload(_ value: JSONValue, command: String) -> Bool {
    switch command {
    case "hello":
      return object(
        value,
        [
          "version": literal(.number(1)), "agentVersion": string(1),
          "capabilities": literal(.array(capabilities.map(JSONValue.string))),
        ])
        case "desktop.setup", "desktop.start", "desktop.stop", "desktop.login.set", "ownership.convert", "ownership.recover",
            "status", "service.start", "service.stop", "service.restart", "service.remove",
      "service.recover":
      return status(value)
    case "settings.get", "settings.set": return settings(value)
    case "devices": return array(phone, max: 10)(value)
    case "devices.revoke": return object(value, ["removed": boolean])
    case "pairing.open":
      return object(
        value,
        [
          "flowId": flow,
          "qrText": { v in string(1)(v) && (v.string?.utf8.count ?? Int.max) <= LineFramer.lineLimit
          }, "expiresAt": positive,
        ])
    case "pairing.close", "pairing.confirm": return object(value, [:])
    case "diagnostics":
      return object(
        value,
        [
          "checks": array(
            {
              object(
                $0,
                [
                  "name": string(1, 64), "ok": boolean,
                  "severity": enumeration(["pass", "warning", "error"]), "detail": string(0, 1024),
                ],
                ["fix": string(0, 2048), "required": boolean])
            }, max: 32)
        ])
    default: return false
    }
  }
  private static func request(_ value: JSONValue) -> Bool {
    guard let command = value["cmd"].string else { return false }
    var fields: [String: Check] = [
      "v": literal(.number(1)), "id": positive, "cmd": literal(.string(command)),
    ]
    var args: [String: Check] = ["expect": expected]
    var optional: [String: Check] = [:]
    switch command {
    case "hello", "status", "settings.get", "diagnostics", "devices": return object(value, fields)
    case "settings.set":
      args["configRevision"] = revision
      args["changes"] = { v in
        guard let changes = v.array, (1...6).contains(changes.count),
          array({ object($0, ["key": enumeration(configKeys), "value": bounded]) })(v)
        else { return false }
        return Set(changes.compactMap { $0["key"].string }).count == changes.count
      }
        case "service.start":
      args.merge([
        "mode": enumeration(["manual", "persistent"]), "consent": literal(.bool(true)),
        "migrateLegacy": boolean,
      ]) { _, new in new }
            optional["stateDir"] = path
        case "desktop.setup", "desktop.start", "desktop.stop", "desktop.login.set", "ownership.convert", "ownership.recover":
            args["ownerRevision"] = nullable(uuid)
            if command == "desktop.login.set" { args["enabled"] = boolean }
            if command == "desktop.setup" || command == "ownership.convert" {
                args["consent"] = literal(.bool(true))
            }
            if command == "ownership.convert" { args["target"] = enumeration(["desktop", "headless"]) }
            if command == "ownership.recover" { args["intentId"] = uuid }
    case "service.stop", "service.restart", "service.remove", "pairing.open": break
    case "service.recover":
      args.merge([
        "action": enumeration(["continue", "restore-legacy", "discard-backup", "use-manual"]),
        "restartPrevious": boolean, "consent": literal(.bool(true)),
      ]) { _, new in new }
      if value["args"]["restartPrevious"] == .bool(true)
        && value["args"]["action"] != .string("restore-legacy")
      {
        return false
      }
    case "devices.revoke": args["phoneFp"] = fingerprint
    case "pairing.close": args["flowId"] = flow
    case "pairing.confirm":
      args.merge(["flowId": flow, "challengeId": flow, "phoneFp": fingerprint, "accept": boolean]) {
        _, new in new
      }
    default: return false
    }
    fields["args"] = { object($0, args, optional) }
    return object(value, fields)
  }
}

import Foundation

public enum PowerVerb: String, Codable, Sendable { case status, acquire, renew, release, recover }

public struct PowerRequest: Codable, Equatable, Sendable {
  public let v: Int
  public let requestID: UInt64
  public let verb: PowerVerb
  public let leaseID: UUID?
  public let holdForRemoval: Bool?
  public init(requestID: UInt64, verb: PowerVerb, leaseID: UUID? = nil, holdForRemoval: Bool? = nil)
  {
    v = 1
    self.requestID = requestID
    self.verb = verb
    self.leaseID = leaseID
    self.holdForRemoval = holdForRemoval
  }
  public enum Failure: Error { case invalidRequest }
  public static func decode(_ bytes: Data, after lastID: UInt64) throws -> PowerRequest {
    guard bytes.count <= 8192,
      let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      Set(object.keys).isSubset(of: ["v", "requestID", "verb", "leaseID", "holdForRemoval"])
    else { throw Failure.invalidRequest }
    let request = try JSONDecoder().decode(Self.self, from: bytes)
    if object.keys.contains("holdForRemoval") {
      guard request.verb == .recover, request.holdForRemoval == true else {
        throw Failure.invalidRequest
      }
    }
    guard request.v == 1, request.requestID > lastID,
      request.requestID <= 9_007_199_254_740_991,
      (request.verb == .renew || request.verb == .release) == (request.leaseID != nil)
    else { throw Failure.invalidRequest }
    return request
  }
}

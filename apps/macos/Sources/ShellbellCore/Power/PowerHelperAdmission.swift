public enum PowerHelperAdmission {
  public enum Failure: Error { case invalidInvocation }
  public static func validate(arguments: [String], realUID: UInt32, effectiveUID: UInt32) throws {
    guard arguments.isEmpty, realUID == 0, effectiveUID == 0 else {
      throw Failure.invalidInvocation
    }
  }
}

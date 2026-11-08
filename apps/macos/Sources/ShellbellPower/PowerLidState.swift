import Foundation
import IOKit

/// Read-only evidence for diagnostics, never permission to change system sleep policy.
public enum PowerLidState {
  public static func read() -> Bool? {
    let service = IOServiceGetMatchingService(
      kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    guard service != IO_OBJECT_NULL else { return nil }
    defer { IOObjectRelease(service) }
    return decode(
      IORegistryEntryCreateCFProperty(
        service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue())
  }

  static func decode(_ value: CFTypeRef?) -> Bool? {
    guard let value, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value as? Bool
  }
}

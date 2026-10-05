import type { HostPlatform } from "@shellbell/protocol";

export function hostPlatform(platform: string): HostPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : "unknown";
}

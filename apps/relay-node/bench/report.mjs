import { cpus, platform, release, totalmem } from "node:os";
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}
export function environment() {
  return {
    node: process.versions.node,
    os: platform(),
    release: release(),
    arch: process.arch,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    transport: "loopback TCP",
    storage: "disposable local temporary directory",
    synthetic: true,
  };
}

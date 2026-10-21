import type { StreamChunk, StreamMessage } from "@shellbell/protocol";

type Applied = Extract<StreamMessage, { type: "stream.applied" }>;

/** Delivery and application are separate watermarks. Neither proves source row continuity. */
export class StreamAppliedProgress {
  private delivered: { generation: number; capture: string; offset: number } | null = null;
  private applied: { generation: number; capture: string; offset: number } | null = null;

  /** Call only after the final chunk of a transfer has been admitted to the ordered route. */
  admit(chunk: StreamChunk): void {
    if (chunk.index !== chunk.count - 1) return;
    const meta = chunk.meta;
    if (meta.kind === "vt-seed") {
      this.delivered = { generation: meta.generation, capture: meta.capture, offset: 0 };
      this.applied = null;
    } else if (meta.kind === "vt" && this.delivered?.generation === meta.generation) {
      if (meta.offset !== this.delivered.offset) throw new Error("Noncontiguous delivery");
      const offset = meta.offset + chunk.totalBytes;
      if (!Number.isSafeInteger(offset)) throw new Error("Stream offset exhausted");
      this.delivered = { ...this.delivered, offset };
    }
  }

  receive(report: Applied): "advanced" | "ignored" | "invalid" {
    const delivered = this.delivered;
    if (!delivered) return "invalid";
    // An old renderer may finish while a newer seed is already on the ordered route.
    if (report.generation < delivered.generation) return "ignored";
    if (
      report.generation !== delivered.generation ||
      report.capture !== delivered.capture ||
      report.offset > delivered.offset ||
      (this.applied !== null && report.offset < this.applied.offset)
    )
      return "invalid";
    if (report.offset === this.applied?.offset) return "ignored";
    this.applied = { ...delivered, offset: report.offset };
    return "advanced";
  }

  get boundary(): Readonly<{ generation: number; capture: string; offset: number }> | null {
    return this.delivered ? { ...this.delivered } : null;
  }

  matches(generation: number, capture: string, offset: number): boolean {
    return (
      this.applied?.generation === generation &&
      this.applied.capture === capture &&
      this.applied.offset === offset
    );
  }
}

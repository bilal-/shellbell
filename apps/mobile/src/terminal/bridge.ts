import type { TerminalRow } from "./adapter";

export interface TerminalModel {
  rows: readonly TerminalRow[];
  cols: number;
  fontSize: number;
  fitWidth: boolean;
  initialAnchor?: string | null;
  cursor: { key: string; x: number; accent: string; blinking: boolean; inferred?: boolean } | null;
}
export interface TerminalFrame extends Omit<TerminalModel, "rows"> {
  document: string;
  revision: number;
  order?: string[];
  upsert: TerminalRow[];
}

export class TerminalBridge {
  private document: string | null = null;
  private revision = 0;
  private latest: TerminalModel | null = null;
  private baseline: TerminalModel | null = null;
  private pending: TerminalModel | null = null;
  constructor(private readonly send: (frame: TerminalFrame) => void) {}
  present(model: TerminalModel): void {
    this.latest = model;
    this.pump();
  }
  ready(document: string): void {
    this.document = document;
    this.revision = 0;
    this.baseline = null;
    this.pending = null;
    this.pump();
  }
  acknowledge(document: string, revision: number): void {
    if (document !== this.document || revision !== this.revision || !this.pending) return;
    this.baseline = this.pending;
    this.pending = null;
    this.pump();
  }
  private pump(): void {
    if (!this.document || !this.latest || this.pending || this.latest === this.baseline) return;
    const next = this.latest;
    const previous = new Map(this.baseline?.rows.map((row) => [row.key, row]));
    const orderChanged =
      !this.baseline ||
      next.rows.length !== this.baseline.rows.length ||
      next.rows.some((row, i) => row.key !== this.baseline?.rows[i]?.key);
    const upsert = next.rows.filter((row) => {
      const old = previous.get(row.key);
      return (
        !old ||
        old.line !== row.line ||
        old.absoluteRow !== row.absoluteRow ||
        old.history !== row.history
      );
    });
    this.pending = next;
    this.send({
      document: this.document,
      revision: ++this.revision,
      ...(orderChanged ? { order: next.rows.map((row) => row.key) } : {}),
      upsert,
      cols: next.cols,
      fontSize: next.fontSize,
      fitWidth: next.fitWidth,
      cursor: next.cursor,
      initialAnchor: next.initialAnchor,
    });
  }
}

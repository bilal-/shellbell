export interface KeyboardAttachmentSource {
  isKeyboardAttached(): Promise<boolean>;
  addListener(
    event: "keyboardChanged",
    listener: (event: { attached: boolean }) => void,
  ): {
    remove(): void;
  };
}

/** Subscribe before reading; a slow initial query must not undo an attachment event. */
export class HardwareKeyboardMonitor {
  private attached = false;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private events = 0;
  private subscription: { remove(): void } | undefined;
  constructor(private readonly source: KeyboardAttachmentSource | null) {}
  getSnapshot = () => this.attached;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.source) {
      const epoch = ++this.epoch;
      this.subscription = this.source.addListener("keyboardChanged", ({ attached }) => {
        if (epoch !== this.epoch || typeof attached !== "boolean") return;
        this.events++;
        this.update(attached);
      });
      const events = this.events;
      void this.source
        .isKeyboardAttached()
        .then((attached) => {
          if (epoch === this.epoch && events === this.events && typeof attached === "boolean")
            this.update(attached);
        })
        .catch(() => {});
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.epoch++;
        this.subscription?.remove();
        this.subscription = undefined;
      }
    };
  };
  private update(attached: boolean) {
    if (this.attached === attached) return;
    this.attached = attached;
    for (const listener of this.listeners) listener();
  }
}

import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { Agent } from "./agent.js";
import { CONTROL_LIMITS, encodeControlLine, writeControlLine } from "./control-framing.js";
import {
  type ControlRuntime,
  ControlV2DataSchemas,
  type ControlV2ErrorCode,
  ControlV2EventSchema,
  type ControlV2Request,
  ControlV2RequestSchema,
  ControlV2ResponseSchema,
} from "./control-v2-protocol.js";
import type { Logger } from "./log.js";

export interface ControlV2Peer {
  readonly handshaken: boolean;
  handle(value: unknown): void;
  close(): void;
}

type PairOwner = {
  peer: Peer;
  flowId: string;
  resolve?: (accept: boolean) => void;
  challengeId?: string;
  phoneFp?: string;
  name?: string;
  timer?: NodeJS.Timeout;
  expiresAt?: number;
  opening: boolean;
};

const capabilities = ["status", "devices", "pairing", "revoke"] as const;

function equalRuntime(a: ControlRuntime, b: ControlRuntime): boolean {
  return (
    a.pid === b.pid &&
    a.agentVersion === b.agentVersion &&
    a.computerFp === b.computerFp &&
    a.stateDir === b.stateDir &&
    a.serviceInstance === b.serviceInstance
  );
}

function idOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export class ControlV2Hub {
  private readonly peers = new Set<Peer>();
  private owner: PairOwner | undefined;
  private stopped = false;
  private readonly newId: () => string;

  constructor(
    private readonly agent: Agent,
    private readonly log: Logger,
    options?: { newId?: () => string },
  ) {
    this.newId = options?.newId ?? (() => randomBytes(16).toString("base64url"));
  }

  get hasPairOwner(): boolean {
    return this.owner !== undefined;
  }

  accept(socket: Socket): ControlV2Peer {
    const peer = new Peer(this, socket, this.agent);
    if (this.stopped) peer.close();
    else this.peers.add(peer);
    return peer;
  }

  confirm(phoneFp: string, name: string): Promise<boolean> {
    const owner = this.owner;
    if (!owner || owner.resolve || this.stopped) return Promise.resolve(false);
    const challengeId = this.newId();
    return new Promise<boolean>((resolve) => {
      if (this.owner !== owner) return resolve(false);
      owner.resolve = resolve;
      owner.challengeId = challengeId;
      owner.phoneFp = phoneFp;
      owner.name = name;
      if (!owner.opening) this.emitRequest(owner, name);
    });
  }

  activate(peer: Peer, flowId: string): void {
    const owner = this.owner;
    if (!owner || owner.peer !== peer || owner.flowId !== flowId) return;
    owner.opening = false;
    if (owner.resolve && owner.phoneFp && owner.challengeId)
      this.emitRequest(owner, owner.name ?? "");
  }

  private emitRequest(owner: PairOwner, name: string): void {
    if (!owner.resolve || !owner.challengeId || !owner.phoneFp) return;
    const resolve = owner.resolve;
    const untilExpiry = Math.max(0, (owner.expiresAt ?? Date.now()) - Date.now());
    owner.timer = setTimeout(
      () => {
        if (this.owner !== owner || owner.resolve !== resolve) return;
        owner.resolve = undefined;
        owner.challengeId = undefined;
        owner.phoneFp = undefined;
        resolve(false);
      },
      Math.min(CONTROL_LIMITS.challengeMs, untilExpiry),
    );
    owner.timer.unref();
    if (
      !owner.peer.event({
        v: 2,
        event: "pairing.request",
        flowId: owner.flowId,
        challengeId: owner.challengeId,
        phoneFp: owner.phoneFp,
        name,
      })
    ) {
      this.clearOwner(owner, false, true);
    }
  }

  notifyClosed(): void {
    const owner = this.owner;
    if (!owner) return;
    this.clearOwner(owner, false, false);
    owner.peer.event({ v: 2, event: "pairing.closed", flowId: owner.flowId });
  }

  stop(): void {
    this.stopped = true;
    const owner = this.owner;
    if (owner) this.clearOwner(owner, true, false);
    for (const peer of this.peers) peer.close();
    this.peers.clear();
  }

  removed(peer: Peer): void {
    this.peers.delete(peer);
    const owner = this.owner;
    if (owner?.peer === peer) this.clearOwner(owner, true, false);
  }

  open(peer: Peer): { flowId: string; qrText: string; expiresAt: number } | ControlV2ErrorCode {
    if (this.owner || this.agent.pairingOpen) return "pairing-busy";
    try {
      const flowId = this.newId();
      const owner: PairOwner = { peer, flowId, opening: true };
      this.owner = owner;
      const opened = this.agent.openPairing();
      if (this.owner !== owner || !this.agent.pairingOpen) {
        this.clearOwner(owner, true, false);
        return "operation-failed";
      }
      owner.expiresAt = opened.expiresAt;
      return { flowId, ...opened };
    } catch {
      const owner = this.owner;
      if (owner?.peer === peer) this.clearOwner(owner, true, false);
      return "operation-failed";
    }
  }

  close(peer: Peer, flowId: string): ControlV2ErrorCode | undefined {
    const owner = this.owner;
    if (!owner || owner.peer !== peer || owner.flowId !== flowId) return "stale-flow";
    this.clearOwner(owner, true, false);
    return undefined;
  }

  answer(
    peer: Peer,
    request: Extract<ControlV2Request, { cmd: "pairing.confirm" }>,
  ): ControlV2ErrorCode | undefined {
    const owner = this.owner;
    if (!owner || owner.peer !== peer || owner.flowId !== request.args.flowId) return "stale-flow";
    if (owner.expiresAt === undefined || Date.now() >= owner.expiresAt) {
      this.clearOwner(owner, true, true);
      return "stale-flow";
    }
    if (
      !owner.resolve ||
      owner.challengeId !== request.args.challengeId ||
      owner.phoneFp !== request.args.phoneFp
    ) {
      return "stale-challenge";
    }
    const resolve = owner.resolve;
    if (owner.timer) clearTimeout(owner.timer);
    owner.timer = undefined;
    owner.resolve = undefined;
    owner.challengeId = undefined;
    owner.phoneFp = undefined;
    owner.name = undefined;
    resolve(request.args.accept);
    return undefined;
  }

  private clearOwner(owner: PairOwner, closeWindow: boolean, emitClosed: boolean): void {
    if (this.owner !== owner) return;
    this.owner = undefined; // release exact ownership before callbacks/notifications
    const resolve = owner.resolve;
    if (owner.timer) clearTimeout(owner.timer);
    owner.timer = undefined;
    owner.resolve = undefined;
    owner.challengeId = undefined;
    owner.phoneFp = undefined;
    owner.name = undefined;
    resolve?.(false);
    if (closeWindow) {
      try {
        this.agent.closePairing();
      } catch {
        this.log.warn("native pairing close failed");
      }
    }
    if (emitClosed) owner.peer.event({ v: 2, event: "pairing.closed", flowId: owner.flowId });
  }
}

class Peer implements ControlV2Peer {
  private helloRuntime: ControlRuntime | undefined;
  private lastId = 0;
  private closed = false;

  constructor(
    private readonly hub: ControlV2Hub,
    private readonly socket: Socket,
    private readonly agent: Agent,
  ) {}

  get handshaken(): boolean {
    return this.helloRuntime !== undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.removed(this);
    this.socket.destroy();
  }

  handle(value: unknown): void {
    if (this.closed || this.socket.destroyed) return;
    const id = idOf(value);
    if (this.handshaken && id !== undefined) {
      if (id <= this.lastId) {
        this.close();
        return;
      }
      this.lastId = id;
    }
    if (value && typeof value === "object" && (value as { v?: unknown }).v !== 2) {
      if (id !== undefined) this.failure(id, "unsupported-version");
      this.close();
      return;
    }
    const parsed = ControlV2RequestSchema.safeParse(value);
    if (!parsed.success) {
      if (id !== undefined) this.failure(id, "bad-request");
      else this.close();
      return;
    }
    const request = parsed.data;
    if (!this.handshaken) {
      if (request.id !== 1 || request.cmd !== "hello") {
        this.close();
        return;
      }
      this.lastId = 1;
      this.helloRuntime = { ...this.runtime() };
      this.success(request, {
        version: 2,
        runtime: this.helloRuntime,
        capabilities,
      });
      return;
    }
    if (request.cmd === "hello") {
      this.close();
      return;
    }
    const helloRuntime = this.helloRuntime;
    const currentRuntime = this.runtime();
    if (
      "expect" in request &&
      (!helloRuntime ||
        !equalRuntime(request.expect, helloRuntime) ||
        !equalRuntime(request.expect, currentRuntime))
    ) {
      this.failure(request.id, "runtime-mismatch");
      return;
    }
    switch (request.cmd) {
      case "status":
        this.success(request, this.status());
        return;
      case "status.config":
        this.success(request, { revision: this.agent.configurationRevision });
        return;
      case "devices":
        this.success(request, this.devices());
        return;
      case "devices.revoke":
        try {
          this.success(request, { removed: this.agent.unpairExact(request.args.phoneFp) });
        } catch {
          this.failure(request.id, "operation-failed");
        }
        return;
      case "pairing.open": {
        const result = this.hub.open(this);
        if (typeof result === "string") this.failure(request.id, result);
        else if (!this.success(request, result)) this.hub.close(this, result.flowId);
        else this.hub.activate(this, result.flowId);
        return;
      }
      case "pairing.close": {
        const error = this.hub.close(this, request.args.flowId);
        if (error) this.failure(request.id, error);
        else if (this.success(request, {})) {
          this.event({ v: 2, event: "pairing.closed", flowId: request.args.flowId });
        }
        return;
      }
      case "pairing.confirm": {
        const error = this.hub.answer(this, request);
        if (error) this.failure(request.id, error);
        else this.success(request, {});
        return;
      }
    }
  }

  event(value: unknown): boolean {
    if (!ControlV2EventSchema.safeParse(value).success) return false;
    return this.write(value);
  }

  private runtime(): ControlRuntime {
    return this.agent.localStatus.process;
  }

  private status(): unknown {
    const a = this.agent;
    return {
      ...a.localStatus,
      relayOnline: a.relayOnline,
      sessions: a.sessionList.length,
      phones: this.devices(),
      connected: a.connectedPhones,
    };
  }

  private devices(): unknown {
    return this.agent.pairingList.map((p) => ({
      phoneFp: p.phoneFp,
      name: p.name,
      lastSeenAt: p.lastSeenAt,
    }));
  }

  private success(request: ControlV2Request, data: unknown): boolean {
    if (!ControlV2DataSchemas[request.cmd].safeParse(data).success) {
      this.failure(request.id, "operation-failed");
      return false;
    }
    const response = { v: 2, id: request.id, ok: true as const, data };
    if (!ControlV2ResponseSchema.safeParse(response).success) {
      this.failure(request.id, "operation-failed");
      return false;
    }
    const frame = encodeControlLine(response);
    if (!frame) {
      this.failure(request.id, "response-too-large");
      return false;
    }
    return this.writeFrame(frame);
  }

  private failure(id: number, code: ControlV2ErrorCode): boolean {
    const response = { v: 2, id, ok: false as const, error: { code } };
    if (!ControlV2ResponseSchema.safeParse(response).success) return false;
    return this.write(response);
  }

  private write(value: unknown): boolean {
    const frame = encodeControlLine(value);
    if (!frame) return false;
    return this.writeFrame(frame);
  }

  private writeFrame(frame: Uint8Array): boolean {
    if (!writeControlLine(this.socket, frame)) {
      this.close();
      return false;
    }
    return true;
  }
}

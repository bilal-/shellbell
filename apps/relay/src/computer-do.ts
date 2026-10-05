import { DurableObject } from "cloudflare:workers";
import { randomBytes } from "@shellbell/protocol";
import {
  createDirectNotificationProvider,
  createNotificationService,
  createRelayCore,
  frameLimitFor,
  InboundQueue,
  type NotificationProvider,
  parseDirectPushCredentials,
  QueueBudget,
  type RelayCore,
} from "@shellbell/relay-core";
import { createCloudflareIdentityStore } from "./adapters/identity-store.js";
import { createCloudflareNotificationStore } from "./adapters/notification-store.js";
import { observePushDelivery } from "./adapters/push-diagnostics.js";
import { createCloudflareScheduler } from "./adapters/scheduler.js";
import { createCloudflareTransport } from "./adapters/transport.js";
import type { Env } from "./env.js";
import {
  SCHEMA_SQL,
  upgradePairIdSchema,
  upgradePushContextSchema,
  upgradeRevocationProofSchema,
} from "./schema.js";

export class ComputerDO extends DurableObject<Env> {
  private readonly transport;
  private readonly core: RelayCore | undefined;
  private readonly inbound = new InboundQueue(new QueueBudget(), 128);

  constructor(
    ctx: DurableObjectState,
    env: Env,
    dependencies: { notificationProvider?: NotificationProvider } = {},
  ) {
    super(ctx, env);
    this.transport = createCloudflareTransport(ctx, undefined, (id) => {
      const task = this.core?.close(id);
      if (task) ctx.waitUntil(task);
    });
    const computerFp = ctx.id.name;
    // Production routing always uses named objects. Unnamed instances are storage-only.
    if (computerFp !== undefined) {
      const notifications = createNotificationService({
        computerFp,
        now: () => Date.now(),
        randomId: () => crypto.randomUUID(),
        store: createCloudflareNotificationStore(ctx.storage, {
          computerFp,
          randomId: () => crypto.randomUUID(),
          attentive: (phone, now) =>
            this.transport
              .sessions()
              .some(
                (session) =>
                  session.state === "phone" && session.fp === phone && session.leaseUntil > now,
              ),
        }),
        provider:
          dependencies.notificationProvider ??
          observePushDelivery(
            createDirectNotificationProvider(
              parseDirectPushCredentials(
                {
                  fcmServiceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
                  apnsPrivateKey: env.APNS_PRIVATE_KEY,
                  apnsTeamId: env.APNS_TEAM_ID,
                  apnsKeyId: env.APNS_KEY_ID,
                  apnsTopic: env.APNS_TOPIC,
                },
                (provider, code) => console.error("relay push unavailable", provider, code),
              ),
            ),
            (diagnostic) => console.info(JSON.stringify({ event: "push-delivery", ...diagnostic })),
          ),
        schedule: () => this.core!.reschedule(),
      });
      this.core = createRelayCore({
        computerFp,
        minFrameMs: Number(env.MIN_FRAME_MS),
        identity: createCloudflareIdentityStore(ctx.storage, computerFp),
        transport: this.transport,
        scheduler: createCloudflareScheduler(ctx.storage),
        notifications,
        runtime: {
          now: () => Date.now(),
          randomBytes,
          randomId: () => crypto.randomUUID(),
          report: (event) => console.error("relay event", event),
        },
      });
    }
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
      upgradePushContextSchema(ctx.storage.sql);
      upgradeRevocationProofSchema(ctx.storage.sql);
      upgradePairIdSchema(ctx.storage.sql);
      if ((await ctx.storage.getAlarm()) === null) await this.core?.reschedule();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!this.core) return new Response("expected named computer", { status: 400 });
    const pair = new WebSocketPair();
    await this.core.open(this.transport.accept(pair[1]));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const id = this.transport.connectionId(ws);
    if (id === undefined || !this.core) return;
    const session = this.transport.session(id);
    if (!session) return;
    const limit = frameLimitFor(session.state, false);
    const length =
      typeof message === "string"
        ? message.length > limit
          ? message.length
          : new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (length > limit) {
      ws.close(4413, "too large");
      await this.core.close(id);
      return;
    }
    const release = this.inbound.admit(id, length);
    if (!release) {
      ws.close(1013, "overloaded");
      await this.core.close(id);
      return;
    }
    try {
      await this.core.message(id, typeof message === "string" ? message : new Uint8Array(message));
    } finally {
      release();
    }
  }

  override async webSocketClose(ws: WebSocket, _code: number): Promise<void> {
    try {
      const id = this.transport.connectionId(ws);
      if (id !== undefined) await this.core?.close(id);
    } finally {
      // Complete client-initiated close handshakes on the pinned runtime.
      try {
        ws.close();
      } catch {
        /* Already closed. */
      }
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1006);
  }

  override async alarm(): Promise<void> {
    await this.core?.wakeup();
  }
}

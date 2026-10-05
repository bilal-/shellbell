import { EventEmitter } from "node:events";
import { create } from "@bufbuild/protobuf";
import type { ClientSub } from "../../src/backends/iterm2/client.js";
import {
  CoordRangeSchema,
  CoordSchema,
  FocusChangedNotificationSchema,
  FocusResponseSchema,
  GetBufferResponseSchema,
  LineContentsSchema,
  ListSessionsResponse_TabSchema,
  ListSessionsResponse_WindowSchema,
  ListSessionsResponseSchema,
  type Notification,
  NotificationResponseSchema,
  SendTextResponseSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
  SessionSummarySchema,
  SizeSchema,
  SplitTreeNode_SplitTreeLinkSchema,
  SplitTreeNodeSchema,
  VariableResponseSchema,
  WindowedCoordRangeSchema,
} from "../../src/backends/iterm2/gen/iterm2_pb.js";

export class FakeClient extends EventEmitter<{ notification: [Notification]; close: [] }> {
  connected = false;
  connects = 0;
  failConnects = 0;
  failListSessions = 0;
  calls: ClientSub[] = [];
  /** Per-session `jobName` override for the fake `variableRequest` reply; default `"zsh"`. */
  jobNames: Record<string, string> = {};
  titles: Record<string, string> = {};
  paths: Record<string, string> = {};
  focused = "S2";
  async connect() {
    this.connects++;
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error("fake connect failed");
    }
    this.connected = true;
  }
  close() {
    this.connected = false;
  }
  async request(sub: ClientSub): Promise<ServerOriginatedMessage> {
    this.calls.push(sub);
    const reply = (value: ServerOriginatedMessage["submessage"]) =>
      create(ServerOriginatedMessageSchema, { id: 1n, submessage: value });
    switch (sub.case) {
      case "listSessionsRequest":
        if (this.failListSessions > 0) {
          this.failListSessions--;
          throw new Error("fake ListSessions failed");
        }
        return reply({ case: "listSessionsResponse", value: layout() });
      case "focusRequest":
        return reply({
          case: "focusResponse",
          value: create(FocusResponseSchema, {
            notifications: [
              create(FocusChangedNotificationSchema, {
                event: { case: "session", value: this.focused },
              }),
            ],
          }),
        });
      case "notificationRequest":
        return reply({
          case: "notificationResponse",
          value: create(NotificationResponseSchema, { status: 0 }),
        });
      case "variableRequest": {
        const name = sub.value.get[0];
        const sid = sub.value.scope.case === "sessionId" ? sub.value.scope.value : "";
        const v =
          name === "session.name"
            ? JSON.stringify(this.titles[sid] ?? `title-${sid}`)
            : name === "jobName"
              ? JSON.stringify(this.jobNames[sid] ?? "zsh")
              : JSON.stringify(this.paths[sid] ?? `/home/${sid}`);
        return reply({
          case: "variableResponse",
          value: create(VariableResponseSchema, { status: 0, values: [v] }),
        });
      }
      case "getBufferRequest":
        return reply({
          case: "getBufferResponse",
          value: create(GetBufferResponseSchema, {
            contents: [create(LineContentsSchema, { text: "hello" })],
            cursor: create(CoordSchema, { x: 5, y: 101n }),
            windowedCoordRange: create(WindowedCoordRangeSchema, {
              coordRange: create(CoordRangeSchema, {
                start: create(CoordSchema, { x: 0, y: 100n }),
              }),
            }),
          }),
        });
      case "sendTextRequest":
        return reply({
          case: "sendTextResponse",
          value: create(SendTextResponseSchema, { status: sub.value.session === "gone" ? 1 : 0 }),
        });
      default:
        throw new Error(`unexpected ${sub.case}`);
    }
  }
}

export function layout() {
  const sess = (id: string, w: number, h: number) =>
    create(SessionSummarySchema, {
      uniqueIdentifier: id,
      title: `t-${id}`,
      gridSize: create(SizeSchema, { width: w, height: h }),
    });
  const leaf = (s: ReturnType<typeof sess>) =>
    create(SplitTreeNode_SplitTreeLinkSchema, { child: { case: "session", value: s } });
  return create(ListSessionsResponseSchema, {
    windows: [
      create(ListSessionsResponse_WindowSchema, {
        windowId: "w1",
        number: 1,
        tabs: [
          create(ListSessionsResponse_TabSchema, {
            tabId: "t1",
            root: create(SplitTreeNodeSchema, {
              links: [leaf(sess("S1", 80, 24)), leaf(sess("S2", 80, 24))],
            }),
          }),
          create(ListSessionsResponse_TabSchema, {
            tabId: "t2",
            tmuxWindowId: "@5",
            root: create(SplitTreeNodeSchema, { links: [leaf(sess("S3", 100, 30))] }),
          }),
        ],
      }),
    ],
  });
}

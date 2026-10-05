import { RELAY_VERSION } from "@shellbell/relay-core";
import type { Env } from "./env.js";

export { ComputerDO } from "./computer-do.js";

const FP_RE = /^[a-z2-7]{26}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        name: "shellbell-relay",
        version: RELAY_VERSION,
        docs: "https://github.com/bilal-/shellbell",
      });
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    const m = /^\/ws\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && m) {
      const fp = m[1] as string;
      if (!FP_RE.test(fp)) return new Response("bad fingerprint", { status: 400 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return env.COMPUTER.get(env.COMPUTER.idFromName(fp)).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

import { createServer } from "node:net";
import { ControlEndpoint } from "../../src/control-endpoint.js";
import { createLogger } from "../../src/log.js";

process.on(
  "message",
  async (message: { command: string; sock: string; pid?: string; raw?: boolean }) => {
    if (message.command === "exit") process.exit(0);
    if (message.command !== "start") return;
    try {
      if (message.raw) {
        const server = createServer((socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(message.sock, resolve);
        });
      } else {
        const endpoint = new ControlEndpoint(
          message.sock,
          (socket) => socket.end("owner\n"),
          createLogger({ stdout: false }),
          message.pid,
        );
        await endpoint.start();
      }
      process.send?.({ ready: true });
    } catch (error) {
      process.send?.({ error: (error as Error).message });
    }
  },
);
process.send?.({ booted: true });

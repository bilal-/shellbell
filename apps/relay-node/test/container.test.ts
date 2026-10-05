import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.js";
import { connect } from "./client.js";

it("packages a pinned non-root image with a private data volume and a minimal context", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  expect(dockerfile).toContain(
    "node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3",
  );
  expect(dockerfile).toMatch(/USER 1000:1000/);
  expect(dockerfile).not.toMatch(/COPY \. \./);
  const ignore = readFileSync(new URL("../../../.dockerignore", import.meta.url), "utf8");
  expect(ignore.split("\n")[0]).toBe("**");
  expect(ignore).not.toContain("!apps/mobile");
});
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
for (const arch of ["arm64", "amd64"]) {
  it.skipIf(process.env.SHELLBELL_CONTAINER_TEST !== "1")(
    `qualifies ${arch} persistence, revocation and exclusive ownership with private mounts`,
    async () => {
      const name = `shellbell-qualification-${randomUUID()}`;
      const volume = `${name}-data`;
      const image = `shellbell-relay-qualification:${arch}`;
      const common = [
        "--platform",
        `linux/${arch}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000",
        "--mount",
        `type=volume,src=${volume},dst=/var/lib/shellbell`,
      ];
      const sockets: Awaited<ReturnType<typeof connect>>[] = [];
      docker("volume", "create", volume);
      try {
        docker("run", "-d", "--name", name, ...common, "-p", "127.0.0.1::8787", image);
        const address = docker("port", name, "8787/tcp");
        let url = `http://${address}`;
        async function ready() {
          url = `http://${docker("port", name, "8787/tcp")}`;
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            try {
              if ((await fetch(`${url}/readyz`)).status === 200) return;
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(`Disposable relay readiness timeout: ${docker("logs", name)}`);
        }
        await ready();
        const evidence = JSON.parse(
          docker(
            "exec",
            name,
            "node",
            "-e",
            "console.log(JSON.stringify({node:process.versions.node,arch:process.arch,uid:process.getuid(),mode:require('fs').statSync('/var/lib/shellbell').mode&511,owner:require('fs').statSync('/var/lib/shellbell').uid}))",
          ),
        );
        expect(evidence).toEqual({
          node: "22.23.1",
          arch: arch === "amd64" ? "x64" : "arm64",
          uid: 1000,
          mode: 0o700,
          owner: 1000,
        });
        expect(
          JSON.parse(
            docker(
              "exec",
              name,
              "node",
              "-e",
              "const fs=require('fs');let readonly=false;try{fs.writeFileSync('/app/probe','synthetic')}catch(e){readonly=e.code==='EROFS'}fs.writeFileSync('/tmp/probe','synthetic');console.log(JSON.stringify({readonly,tempMode:fs.statSync('/tmp').mode&511,tempOwner:fs.statSync('/tmp').uid,dbMode:fs.statSync('/var/lib/shellbell/relay.sqlite').mode&511,licenses:fs.existsSync('/app/licenses/@noble/curves/LICENSE')}))",
            ),
          ),
        ).toEqual({
          readonly: true,
          tempMode: 0o700,
          tempOwner: 1000,
          dbMode: 0o600,
          licenses: true,
        });
        console.log(
          JSON.stringify({
            container: arch,
            execution:
              arch === "amd64" ? "emulated on arm64 Docker host" : "native arm64 Docker host",
            ...evidence,
          }),
        );
        expect(() => docker("run", "--rm", ...common, image)).toThrow();
        expect(() =>
          docker(
            "run",
            "--rm",
            ...common,
            image,
            "backup",
            "--source",
            "/var/lib/shellbell",
            "--destination",
            "/var/lib/shellbell/archives/active.sqlite",
          ),
        ).toThrow();
        const api = createScenarioClient(async (fp) => {
          const c = await connect(url, fp);
          sockets.push(c);
          return c;
        });
        const computer = new TestDevice("synthetic-container-computer");
        const phone = new TestDevice("synthetic-container-phone");
        const { agent } = await api.agentOnline(computer);
        await api.pair(agent, computer, phone);
        for (const c of sockets) c.close();
        docker("restart", name);
        await ready();
        const restarted = await api.agentOnline(computer);
        const viewer = await api.connect(computer.fp);
        expect((await api.authenticate(viewer, phone, "phone")).type).toBe("auth-ok");
        await restarted.agent.nextCtrl();
        restarted.agent.sendCtrl(computer.fp, { type: "unpair", phoneFp: phone.fp });
        expect((await viewer.closed).code).toBe(4004);
        docker("restart", name);
        await ready();
        const revoked = await api.connect(computer.fp);
        expect((await api.authenticate(revoked, phone, "phone")).type).toBe("auth-fail");
        docker("stop", name);
        expect(
          docker(
            "run",
            "--rm",
            ...common,
            image,
            "backup",
            "--source",
            "/var/lib/shellbell",
            "--destination",
            "/var/lib/shellbell/archives/offline.sqlite",
          ),
        ).toContain("backup-complete");
        expect(
          docker(
            "run",
            "--rm",
            ...common,
            image,
            "restore",
            "--source",
            "/var/lib/shellbell/archives/offline.sqlite",
            "--destination",
            "/var/lib/shellbell/restored",
          ),
        ).toContain("restore-complete");
        expect(() =>
          docker(
            "run",
            "--rm",
            ...common,
            image,
            "restore",
            "--source",
            "/var/lib/shellbell/archives/offline.sqlite",
            "--destination",
            "/var/lib/shellbell/restored",
          ),
        ).toThrow();
      } finally {
        for (const c of sockets) c.ws.terminate();
        try {
          docker("rm", "-f", name);
        } finally {
          docker("volume", "rm", volume);
        }
      }
    },
    120000,
  );
}

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PageProcesses } from "../src/web/page-processes.js";
import { PageRegistry } from "../src/web/page-registry.js";

const fixtures: Array<{ home: string; registry: PageRegistry; processes: PageProcesses }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.registry.close();
    await f.processes.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
async function fixture(program: string) {
  const home = mkdtempSync(join(tmpdir(), "shellbell-page-process-"));
  const directory = join(home, ".config/shellbell/apps");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const script = join(home, "provider.cjs");
  writeFileSync(script, program);
  const registry = new PageRegistry({ home, platform: "linux" });
  const processes = new PageProcesses(registry, { home, startMs: 2000, killMs: 700 });
  const f = { home, registry, processes };
  fixtures.push(f);
  const register = async (args: string[] = []) => {
    writeFileSync(
      join(directory, "board.json"),
      JSON.stringify({
        shellbell: 1,
        name: "Board",
        start: [process.execPath, script, ...args],
        cwd: home,
      }),
      { mode: 0o600 },
    );
    await registry.refresh();
  };
  await register();
  return { ...f, register };
}
it("waits for a complete startup record including the full port and sign-in query", async () => {
  const f = await fixture(`const fs=require('node:fs');
    process.stdout.write('{"url":"http://127.0.0.1:471');
    fs.writeFileSync('partial','');
    const t=setInterval(()=>{if(fs.existsSync('release')){
      clearInterval(t);process.stdout.write('23/?t=entry-secret"}\\n');
    }},5);setInterval(()=>{},1000);`);
  let resolved = false;
  const ready = f.processes.resolve("board").then((v) => {
    resolved = true;
    return v;
  });
  await vi.waitFor(() => expect(existsSync(join(f.home, "partial"))).toBe(true));
  expect(resolved).toBe(false);
  writeFileSync(join(f.home, "release"), "");
  const instance = await ready;
  expect(instance.origin.authority).toBe("127.0.0.1:47123");
  expect(instance.entryURL).toBe("http://127.0.0.1:47123/?t=entry-secret");
});
it("does not expose the tail of an oversized diagnostic URL", async () => {
  const f = await fixture(
    `process.stderr.write('http://127.0.0.1:47123/?t='+ 'secret'.repeat(2000));process.exitCode=1;`,
  );
  await expect(f.processes.resolve("board")).rejects.toMatchObject({
    reason: "start-failed",
    detail: "Startup output exceeded the size limit.",
  });
});
it("waits for the old process group to leave a fixed port before replacement", async () => {
  const reserve = net.createServer();
  await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const f = await fixture(`const fs=require('node:fs'),net=require('node:net');
    const old=process.argv[2]!=='new';
    if(!old&&!fs.existsSync('old-stopped'))fs.writeFileSync('overlap','');
    const s=net.createServer();s.on('error',e=>{console.error(e.code);process.exit(1)});
    s.listen(${port},'127.0.0.1',()=>console.log('http://127.0.0.1:${port}/'));
    if(old)process.on('SIGTERM',()=>{
      fs.writeFileSync('stopping','');const t=setInterval(()=>{
        if(fs.existsSync('release')){clearInterval(t);s.close(()=>{
          fs.writeFileSync('old-stopped','');process.exit(0);
        });}
      },5);
    });`);
  await f.processes.resolve("board");
  await f.register(["new"]);
  const replacement = f.processes.resolve("board").catch((e: Error) => e);
  await vi.waitFor(() => expect(existsSync(join(f.home, "stopping"))).toBe(true));
  writeFileSync(join(f.home, "release"), "");
  expect(await replacement).not.toBeInstanceOf(Error);
  expect(existsSync(join(f.home, "overlap"))).toBe(false);
});

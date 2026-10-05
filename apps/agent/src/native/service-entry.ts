import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { paths, readConfig } from "../config.js";
import { boundedRead, optionalStat, privateDirectory, sameFile } from "../host-files.js";
import { loadOrCreateIdentity, readIdentity } from "../identity.js";
import { ServiceOwnerStore } from "../service-ownership.js";
import { bindDesktopOwner } from "./desktop-owner.js";
import type { NativeExecutionKind, NativeSelection } from "./protocol.js";
import { NativeControllerError, NativePathSchema, NativeSelectionSchema } from "./protocol.js";
import { NativeRecordStore } from "./record-store.js";

export function sanitizeNativeEnvironment(
  selection: NativeSelection,
  homeDir: string,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (
    inherited.NODE_OPTIONS ||
    inherited.NODE_PATH ||
    !NativeSelectionSchema.safeParse(selection).success ||
    !NativePathSchema.safeParse(homeDir).success
  )
    throw new NativeControllerError("unsafe-state");
  return { ...selection.environment, HOME: homeDir };
}

/** Admission precedes legacy helpers which may otherwise repair modes or follow links. */
export function admitNativeState(stateDir: string, uid: number, initialize = false) {
  try {
    if (
      uid <= 0 ||
      !NativePathSchema.safeParse(stateDir).success ||
      [...stateDir].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error();
    for (let path = stateDir; ; path = dirname(path)) {
      const st = optionalStat(path);
      if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error();
      if (dirname(path) === path) break;
    }
    if (!optionalStat(stateDir)) {
      if (!initialize) return null;
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    }
    privateDirectory(stateDir, uid);
    if (realpathSync(stateDir) !== stateDir) throw new Error();
    const p = paths(stateDir);
    for (const file of [p.identity, p.pairings, p.config, p.pid])
      if (optionalStat(file)) boundedRead(file, 65536, uid);
    admitNativeLog(p.log, uid);
    const socket = optionalStat(p.sock);
    if (socket && (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o7777) !== 0o600))
      throw new Error();
    readConfig(p);
    return initialize ? loadOrCreateIdentity(p) : readIdentity(p);
  } catch {
    throw new NativeControllerError("unsafe-state");
  }
}
/** Logs can grow past the rotation threshold on their final append. Admission
 * checks the opened file's ownership/type, never its size, timestamps or bytes. */
function admitNativeLog(path: string, uid: number): void {
  const before = optionalStat(path);
  if (!before) return;
  const check = (stat: Stats) => {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o7777) !== 0o600
    )
      throw new Error();
  };
  check(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    check(opened);
    const current = optionalStat(path);
    if (!current) throw new Error();
    check(current);
    if (!sameFile(before, opened) || !sameFile(opened, current)) throw new Error();
  } finally {
    closeSync(fd);
  }
}
export async function runNativeService(
  mode: NativeExecutionKind,
  options: {
    bundlePath: string;
    root: string;
    uid: number;
    ownerInput?: Readable;
    onOwnerLost?(error: unknown | null): void;
    start: (selection: NativeSelection) => Promise<{ stop(): Promise<void> }>;
  },
): Promise<{ stop(): Promise<void> }> {
  const record = new NativeRecordStore(options).inspect(),
    selection = record?.selection;
  if (!selection || selection.mode !== mode || selection.bundlePath !== options.bundlePath)
    throw new NativeControllerError("conflict");
  const identity = admitNativeState(selection.stateDir, options.uid);
  if (!identity || identity.fp !== selection.computerFp)
    throw new NativeControllerError("unsafe-state");
  // source-stop-requested deliberately retains source authorization until release.
  if (mode !== "desktop") return options.start(selection);
  const owner = new ServiceOwnerStore({ stateDir: selection.stateDir, uid: options.uid }).inspect();
  if (
    !options.ownerInput ||
    owner?.mode !== "desktop" ||
    !owner.consented ||
    (owner.transition &&
      (owner.transition.target !== "desktop" ||
        !["source-stopped", "destination-started"].includes(owner.transition.phase)))
  )
    throw new NativeControllerError("conflict");
  let lost = false;
  let creating: Promise<{ stop(): Promise<void> }> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (creating) await (await creating).stop();
    })());
  const lease = bindDesktopOwner(options.ownerInput, {
    instance: selection.serviceInstance,
    onLost: async () => {
      lost = true;
      try {
        await stop();
        options.onOwnerLost?.(null);
      } catch (error) {
        options.onOwnerLost?.(error);
      }
    },
  });
  try {
    await lease.ready;
    if (lost) throw new NativeControllerError("unavailable");
    creating = options.start(selection);
    await creating;
    if (lost) {
      await stop();
      throw new NativeControllerError("unavailable");
    }
    return {
      stop: async () => {
        await stop();
        lease.close();
      },
    };
  } catch (error) {
    lease.close();
    throw error;
  }
}

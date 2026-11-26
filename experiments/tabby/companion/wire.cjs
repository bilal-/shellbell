const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = 2;
const MAX = 550000;
function paths() {
  const root = process.env.SHELLBELL_TABBY_DIR;
  if (!root || !path.isAbsolute(root)) throw Error("Set a private prototype directory");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw Error("Unsafe prototype directory");
  return { root, key: path.join(root, "key"), socket: path.join(root, "bridge.sock") };
}
function readKey(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size !== 32)
      throw Error("Invalid bridge key");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function proof(key, role, server, client, version) {
  return crypto
    .createHmac("sha256", key)
    .update(JSON.stringify([role, server, client, version]))
    .digest("hex");
}
function matches(expected, received) {
  return (
    typeof received === "string" &&
    /^[a-f0-9]{64}$/.test(received) &&
    crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
  );
}
// Length-prefixed frames; allocate only after checking the declared length.
function channel(socket, receive) {
  let frame = Buffer.alloc(4),
    used = 0,
    header = true;
  socket.on("data", (chunk) => {
    try {
      while (chunk.length && !socket.destroyed) {
        const n = chunk.copy(frame, used);
        used += n;
        chunk = chunk.subarray(n);
        if (used !== frame.length) break;
        if (header) {
          const length = frame.readUInt32BE();
          if (!length || length > MAX) throw Error();
          frame = Buffer.allocUnsafe(length);
        } else {
          receive(JSON.parse(frame.toString("utf8")));
          frame = Buffer.alloc(4);
        }
        used = 0;
        header = !header;
      }
    } catch {
      socket.destroy();
    }
  });
  socket.on("error", () => socket.destroy());
  return (message) => {
    const data = Buffer.from(JSON.stringify(message));
    if (socket.destroyed || data.length > MAX || socket.writableLength + data.length > MAX * 5) {
      socket.destroy();
      throw Error("Bridge unavailable");
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length);
    socket.write(Buffer.concat([prefix, data]));
  };
}
module.exports = { paths, readKey, proof, matches, channel, VERSION };

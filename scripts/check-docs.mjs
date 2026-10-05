import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const paths = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const files = paths.filter((file) => /\.mdx?$/.test(file) && existsSync(resolve(root, file)));
const bodies = new Map();
const anchors = new Map();
function prose(source) {
  let fence;
  return source
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
        return "";
      }
      return fence ? "" : line;
    })
    .join("\n");
}
function headingAnchors(body) {
  const ids = new Set();
  const counts = new Map();
  for (const line of body.split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      const slug = heading[1]
        .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
        .replace(/\s/g, "-");
      const count = counts.get(slug) ?? 0;
      ids.add(count ? `${slug}-${count}` : slug);
      counts.set(slug, count + 1);
    }
    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  }
  return ids;
}
for (const file of files) {
  const body = prose(readFileSync(resolve(root, file), "utf8"));
  bodies.set(file, body);
  anchors.set(resolve(root, file), headingAnchors(body));
}
const failures = [];
for (const file of paths) {
  if (
    file.startsWith("docs/") &&
    existsSync(resolve(root, file)) &&
    (/\d{4}-\d{2}-\d{2}/.test(file) || /\/(?:superpowers|audits|benchmarks)\//.test(file))
  )
    failures.push(`${file}: keep current guides in docs/, not dated plans or logs (see AGENTS.md)`);
}
let links = 0;
function check(file, value, line) {
  // Web links, mailboxes and examples are outside this repository check.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return;
  const [rawPath, rawFragment] = value.split("#", 2);
  const path = decodeURIComponent(rawPath.split("?", 1)[0]);
  if (!path && rawFragment === undefined) return;
  links++;
  const destination = path
    ? resolve(path.startsWith("/") ? root : dirname(resolve(root, file)), path.replace(/^\//, ""))
    : resolve(root, file);
  if (!existsSync(destination)) failures.push(`${file}:${line}: missing ${value}`);
  else if (rawFragment && [".md", ".mdx"].includes(extname(destination))) {
    const ids =
      anchors.get(destination) ?? headingAnchors(prose(readFileSync(destination, "utf8")));
    if (!ids.has(decodeURIComponent(rawFragment)))
      failures.push(`${file}:${line}: missing anchor ${value}`);
  }
}
for (const [file, body] of bodies) {
  const references = new Map();
  for (const line of body.split("\n")) {
    const ref = /^\s{0,3}\[([^\]]+)\]:\s+(?:<([^>]+)>|(\S+))/.exec(line);
    if (ref) references.set(ref[1].toLowerCase(), ref[2] ?? ref[3]);
  }
  body.split("\n").forEach((line, index) => {
    // Code spans may contain example link syntax; they are not rendered links.
    const text = line.replace(/(`+)[\s\S]*?\1/g, "");
    for (const match of text.matchAll(
      /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g,
    )) {
      check(file, match[1] ?? match[2], index + 1);
    }
    for (const match of text.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const target = references.get((match[2] || match[1]).toLowerCase());
      if (target) check(file, target, index + 1);
      else failures.push(`${file}:${index + 1}: undefined reference ${match[2] || match[1]}`);
    }
    for (const match of text.matchAll(/\b(?:src|href|srcset)=["']([^"']+)["']/g)) {
      check(file, match[1].split(/\s+/, 1)[0], index + 1);
    }
  });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(`Documentation links OK: ${files.length} files, ${links} local links and assets.`);

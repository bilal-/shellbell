import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRules = [
  {
    name: "local-home",
    pattern: /\/(?:Users|home)\/(?!example\/)[\w.-]+\/(?:workspace|Desktop|Downloads|Documents)\//,
  },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export function scanFiles(files, rules = defaultRules) {
  const findings = [];
  for (const { path, content } of files) {
    for (const [index, line] of content.split("\n").entries()) {
      for (const { name, pattern } of rules) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) findings.push({ path, line: index + 1, rule: name });
      }
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const rules = [...defaultRules];
    if (process.env.SHELLBELL_PRIVATE_AUDIT_RULES) {
      const extra = JSON.parse(readFileSync(process.env.SHELLBELL_PRIVATE_AUDIT_RULES, "utf8"));
      for (const { name, source } of extra) rules.push({ name, pattern: new RegExp(source, "i") });
    }
    const paths = [
      ...new Set(
        execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          encoding: "utf8",
        })
          .split("\0")
          .filter(Boolean),
      ),
    ];
    const findings = scanFiles(
      paths.map((path) => ({
        path,
        content: lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8"),
      })),
      rules,
    );
    for (const finding of findings)
      console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
    console.log(
      `Source audit: ${paths.length} files, ${findings.length} findings (binary metadata requires separate review).`,
    );
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error("Source audit could not complete; check file access and audit configuration.");
    process.exitCode = 2;
  }
}

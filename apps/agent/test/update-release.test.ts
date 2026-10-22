import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, ReleaseClient, releaseAssetURL } from "../src/update-release.js";

const API = "https://api.github.com/repos/bilal-/shellbell";
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture(version = "0.9.0") {
  const tag = `shellbell@${version}`;
  const artifact = Buffer.from("verified fixture artifact");
  const manifest = {
    schemaVersion: 1,
    component: "computer",
    channel: "stable",
    version,
    tag,
    sourceCommit: "a".repeat(40),
    platforms: {
      macosArm64: {
        asset: `Shellbell-${version}-arm64.dmg`,
        sha256: hash(artifact),
        buildNumber: 31,
        minimumOS: "13.0",
        signed: true,
        notarized: true,
      },
      macosHeadless: { asset: `shellbell-${version}.tgz`, sha256: hash(artifact) },
      linuxArm64: {
        asset: `shellbell-${version}-linux-arm64.tar.gz`,
        sha256: hash(artifact),
        minimumGlibc: "2.30",
      },
    },
  };
  const makeAsset = (name: string, bytes: Buffer) => ({
    name,
    size: bytes.length,
    digest: `sha256:${hash(bytes)}`,
    browser_download_url: releaseAssetURL(tag, name),
  });
  let manifestBytes = Buffer.from(JSON.stringify(manifest));
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      makeAsset("computer-release.json", manifestBytes),
      ...Object.values(manifest.platforms).map((item) => makeAsset(item.asset, artifact)),
    ],
  };
  let source = manifest.sourceCommit;
  let releases = [release];
  const request = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(init?.headers).not.toHaveProperty("Authorization");
    const url = String(input);
    if (url === `${API}/releases?per_page=100&page=1`) return Response.json(releases);
    if (url === `${API}/releases/tags/${encodeURIComponent(tag)}`) return Response.json(release);
    if (url === `${API}/git/ref/tags/${encodeURIComponent(tag)}`)
      return Response.json({ object: { type: "commit", sha: source } });
    if (url === releaseAssetURL(tag, "computer-release.json")) return new Response(manifestBytes);
    throw new Error(`Unexpected request: ${url}`);
  });
  return {
    manifest,
    release,
    artifact,
    request,
    client: new ReleaseClient(request),
    setSource(value: string) {
      source = value;
    },
    setReleases(value: typeof releases) {
      releases = value;
    },
    publishManifest() {
      manifestBytes = Buffer.from(JSON.stringify(manifest));
      release.assets[0] = makeAsset("computer-release.json", manifestBytes);
    },
    corruptManifest() {
      manifestBytes = Buffer.from("{}");
    },
  };
}

describe("manual computer release checks", () => {
  it("finds the computer channel rather than a newer mobile/relay publication", async () => {
    const f = fixture();
    f.setReleases([
      { ...f.release, tag_name: "mobile-v9.0.0" },
      { ...f.release, tag_name: "relay-v20.0.0" },
      { ...f.release, tag_name: "shellbell@10.0.0", prerelease: true },
      { ...f.release, tag_name: "shellbell@11.0.0", draft: true },
      f.release,
    ]);
    const result = await f.client.check("0.8.0");
    expect(result.check.available).toBe(true);
    expect(result.check.release.version).toBe("0.9.0");
    expect(result.assets.linuxArm64?.digest).toBe(`sha256:${hash(f.artifact)}`);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.every(([url]) => !String(url).includes("/latest"))).toBe(true);
  });

  it("compares numeric versions without offering a downgrade", async () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.0")).toBe(1);
    expect((await fixture().client.check("0.9.0")).check.available).toBe(false);
    expect((await fixture().client.check("1.0.0")).check.available).toBe(false);
    expect(() => compareVersions("01.0.0", "1.0.0")).toThrow();
  });

  it("checks an explicitly chosen stable version without listing unrelated releases", async () => {
    const f = fixture();
    expect((await f.client.check("0.8.0", "0.9.0")).check.available).toBe(true);
    expect(String(f.request.mock.calls[0]?.[0])).toContain("/releases/tags/shellbell%400.9.0");
    f.release.prerelease = true;
    await expect(f.client.check("0.8.0", "0.9.0")).rejects.toThrow("published stable");
  });

  it.each([
    "source",
    "tag",
    "asset hash",
    "asset URL",
    "duplicate asset",
    "manifest bytes",
    "unsigned Mac",
  ])("refuses mismatched %s", async (kind) => {
    const f = fixture();
    if (kind === "source") f.setSource("b".repeat(40));
    if (kind === "tag") {
      f.manifest.tag = "shellbell@0.8.0";
      f.publishManifest();
    }
    if (kind === "asset hash") f.release.assets[1]!.digest = `sha256:${"b".repeat(64)}`;
    if (kind === "asset URL")
      f.release.assets[1]!.browser_download_url = "https://evil.example/download.dmg";
    if (kind === "duplicate asset") f.release.assets.push(f.release.assets[0]!);
    if (kind === "manifest bytes") f.corruptManifest();
    if (kind === "unsigned Mac") {
      f.manifest.platforms.macosArm64.signed = false;
      f.publishManifest();
    }
    await expect(f.client.check("0.8.0")).rejects.toThrow();
  });

  it("fails closed if bounded history cannot establish the latest release", async () => {
    const release = fixture().release;
    const request = vi.fn(async () => Response.json(Array.from({ length: 100 }, () => release)));
    await expect(new ReleaseClient(request).check("0.8.0")).rejects.toThrow("history is too large");
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("allows official asset CDN redirects, never a different download host", async () => {
    const url = releaseAssetURL("shellbell@0.9.0", "computer-release.json");
    const request = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input) === url
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://release-assets.githubusercontent.com/fixture?signature=temporary",
            },
          })
        : new Response("ok"),
    );
    expect(
      Buffer.from(
        await new ReleaseClient(request).bytes(url, 10, AbortSignal.timeout(1000)),
      ).toString(),
    ).toBe("ok");
    const bad = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/file" } }),
    );
    await expect(new ReleaseClient(bad).bytes(url, 10, AbortSignal.timeout(1000))).rejects.toThrow(
      "Untrusted",
    );
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("bounds bytes even when a server omits its content length", async () => {
    const request = vi.fn(async () => new Response("too many bytes"));
    await expect(
      new ReleaseClient(request).bytes(`${API}/releases`, 5, AbortSignal.timeout(1000)),
    ).rejects.toThrow("size limit");
    await expect(
      new ReleaseClient(request).bytes("http://localhost/file", 5, AbortSignal.timeout(1000)),
    ).rejects.toThrow("Untrusted");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

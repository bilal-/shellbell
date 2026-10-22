import { createHash } from "node:crypto";
import { z } from "zod";

export const RELEASE_REPOSITORY = "https://github.com/bilal-/shellbell";
const API = "https://api.github.com/repos/bilal-/shellbell";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const version = z.string().max(32).regex(VERSION);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const artifact = z.object({ asset: z.string().max(160), sha256: sha }).strict();
const macArtifact = artifact
  .extend({
    buildNumber: z.number().int().positive().max(2_147_483_647),
    minimumOS: z.string().regex(/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/),
    signed: z.literal(true),
    notarized: z.literal(true),
  })
  .strict();
const linuxArtifact = artifact
  .extend({ minimumGlibc: z.string().regex(/^[0-9]{1,6}\.[0-9]{1,6}$/) })
  .strict();

export const ComputerReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    component: z.literal("computer"),
    channel: z.literal("stable"),
    version,
    tag: z.string().max(64),
    sourceCommit: commit,
    platforms: z
      .object({
        macosArm64: macArtifact.optional(),
        macosHeadless: artifact.optional(),
        linuxArm64: linuxArtifact.optional(),
        linuxX64: linuxArtifact.optional(),
      })
      .strict(),
  })
  .strict();
export type ComputerRelease = z.infer<typeof ComputerReleaseSchema>;
export type PlatformArtifact = keyof ComputerRelease["platforms"];
export interface UpdateCheck {
  schemaVersion: 1;
  currentVersion: string;
  available: boolean;
  releaseUrl: string;
  release: ComputerRelease;
}
export interface ReleaseAsset {
  name: string;
  digest: string;
  size: number;
  browser_download_url: string;
}
const GitHubReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        digest: z.string().nullable(),
        size: z.number().int().nonnegative(),
        browser_download_url: z.string(),
      }),
    )
    .max(100),
});
type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;
export function compareVersions(left: string, right: string): number {
  version.parse(left);
  version.parse(right);
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}
export function releaseAssetURL(tag: string, asset: string): string {
  if (!tag.startsWith("shellbell@") || !VERSION.test(tag.slice(10)))
    throw new Error("Invalid computer release tag");
  if (!/^[A-Za-z0-9._-]+$/.test(asset)) throw new Error("Invalid release asset name");
  return `${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${asset}`;
}

/** Public metadata only: no authentication, pairing state, or terminal context. */
export class ReleaseClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  async bytes(url: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.response(url, signal);
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (!response.body) throw new Error("Empty release response");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) throw new Error("Release response exceeds its size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks, length);
  }

  async response(url: string, signal: AbortSignal): Promise<Response> {
    let current = new URL(url);
    // A canonical API/release URL is the only entry point; signed asset-CDN redirects
    // are allowed afterward. Never forward user credentials or arbitrary headers.
    if (
      !(
        current.origin === "https://api.github.com" &&
        current.pathname.startsWith("/repos/bilal-/shellbell/")
      ) &&
      !(
        current.origin === "https://github.com" &&
        current.pathname.startsWith("/bilal-/shellbell/releases/download/")
      )
    )
      throw new Error("Untrusted release URL");
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (
        current.protocol !== "https:" ||
        current.port !== "" ||
        current.username ||
        current.password ||
        ![
          "api.github.com",
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
        ].includes(current.hostname)
      )
        throw new Error("Untrusted release redirect");
      const response = await this.request(current.href, {
        redirect: "manual",
        signal,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Shellbell-update-check" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Error("Invalid release redirect");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          response.status === 403 || response.status === 429
            ? "GitHub is limiting update checks. Try again later."
            : `Update lookup failed (HTTP ${response.status})`,
        );
      }
      return response;
    }
    throw new Error("Too many release redirects");
  }

  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(Buffer.from(await this.bytes(url, 2 * 1024 * 1024, signal)).toString("utf8"));
  }

  async check(
    currentVersion: string,
    requestedVersion?: string,
  ): Promise<{ check: UpdateCheck; assets: Partial<Record<PlatformArtifact, ReleaseAsset>> }> {
    version.parse(currentVersion);
    const signal = AbortSignal.timeout(30_000);
    let selected: GitHubRelease;
    if (requestedVersion) {
      version.parse(requestedVersion);
      selected = GitHubReleaseSchema.parse(
        await this.json(
          `${API}/releases/tags/${encodeURIComponent(`shellbell@${requestedVersion}`)}`,
          signal,
        ),
      );
      if (selected.tag_name !== `shellbell@${requestedVersion}`)
        throw new Error("Release tag mismatch");
    } else {
      // The repository also releases mobile and relay. /releases/latest is not a
      // computer channel. Inspect a bounded set and choose by semantic version.
      const candidates: GitHubRelease[] = [];
      let exhausted = false;
      for (let page = 1; page <= 5; page++) {
        const releases = z
          .array(GitHubReleaseSchema)
          .max(100)
          .parse(await this.json(`${API}/releases?per_page=100&page=${page}`, signal));
        candidates.push(
          ...releases.filter(
            (item) =>
              !item.draft &&
              !item.prerelease &&
              item.tag_name.startsWith("shellbell@") &&
              VERSION.test(item.tag_name.slice(10)),
          ),
        );
        if (releases.length < 100) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted)
        throw new Error("Release history is too large; specify the computer version to check");
      candidates.sort((a, b) => compareVersions(b.tag_name.slice(10), a.tag_name.slice(10)));
      if (!candidates[0]) throw new Error("No stable computer release is available");
      selected = candidates[0];
    }
    if (selected.draft || selected.prerelease)
      throw new Error("Only published stable computer releases can be installed");
    const manifestAsset = this.asset(selected, "computer-release.json", 1024 * 1024);
    const bytes = await this.bytes(manifestAsset.browser_download_url, manifestAsset.size, signal);
    this.verify(bytes, manifestAsset);
    const release = ComputerReleaseSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (release.tag !== selected.tag_name || release.tag !== `shellbell@${release.version}`)
      throw new Error("Computer release metadata does not match its tag");
    const ref = z
      .object({ object: z.object({ type: z.literal("commit"), sha: commit }) })
      .parse(await this.json(`${API}/git/ref/tags/${encodeURIComponent(release.tag)}`, signal));
    if (ref.object.sha !== release.sourceCommit)
      throw new Error("Computer release source does not match its tag");
    const names: Record<PlatformArtifact, string> = {
      macosArm64: `Shellbell-${release.version}-arm64.dmg`,
      macosHeadless: `shellbell-${release.version}.tgz`,
      linuxArm64: `shellbell-${release.version}-linux-arm64.tar.gz`,
      linuxX64: `shellbell-${release.version}-linux-x64.tar.gz`,
    };
    const assets: Partial<Record<PlatformArtifact, ReleaseAsset>> = {};
    for (const key of Object.keys(names) as PlatformArtifact[]) {
      const value = release.platforms[key];
      if (!value) continue;
      if (value.asset !== names[key]) throw new Error("Unexpected computer release asset");
      const asset = this.asset(selected, names[key], 256 * 1024 * 1024);
      if (asset.digest !== `sha256:${value.sha256}`)
        throw new Error("Computer artifact digest mismatch");
      assets[key] = asset;
    }
    if (!Object.keys(assets).length)
      throw new Error("Computer release has no installable artifacts");
    return {
      check: {
        schemaVersion: 1,
        currentVersion,
        available: compareVersions(release.version, currentVersion) > 0,
        releaseUrl: `${RELEASE_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag)}`,
        release,
      },
      assets,
    };
  }

  private asset(release: GitHubRelease, name: string, limit: number): ReleaseAsset {
    const matches = release.assets.filter((item) => item.name === name);
    const value = matches[0];
    if (
      matches.length !== 1 ||
      !value ||
      !value.digest ||
      !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
      value.size < 1 ||
      value.size > limit ||
      value.browser_download_url !== releaseAssetURL(release.tag_name, name)
    )
      throw new Error(`Missing or invalid release asset: ${name}`);
    return { ...value, digest: value.digest };
  }

  verify(bytes: Uint8Array, asset: ReleaseAsset): void {
    if (
      bytes.byteLength !== asset.size ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest
    )
      throw new Error("Downloaded artifact does not match the published digest");
  }
}

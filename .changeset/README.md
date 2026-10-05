# Shellbell changesets

Add a changeset for a change to released behavior with `pnpm exec changeset`.
Name the affected computer, relay or mobile packages and explain the user or
operator result. Pure documentation edits usually do not need a version bump.

`pnpm exec changeset status` previews pending releases. `changeset version` changes
source versions and package changelogs; it does not build or authorize publication.
Private workspace packages are versioned but remain unpublished and untagged by
Changesets. See [release rules](../docs/versioning.md) before preparing versions.

Discuss major upgrades with the owner and obtain explicit approval before adding
major entries or changing the ceilings in [release-policy.json](../release-policy.json).
The approved mobile 1.0 milestone does not authorize 2.x. Run `pnpm check:versions`
to check source versions and the pending release plan before preparation.

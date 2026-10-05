# Release note template

Use this structure for a computer, mobile or relay release. Replace the field
descriptions with confirmed facts. Omit sections that do not apply. A source tag
or an accepted store upload is insufficient evidence that an artifact reached
users. Keep credentials and private account details in the release ledger.

## Identity and availability

Record the component version, release date, source tag and full source commit.
For a mobile beta candidate, record the launch version, testing channel, build
number and source commit. The stable mobile tag is assigned to the candidate
selected for promotion; it is not moved between beta builds.
List each distributed artifact with its platform, version, native build number
when applicable, channel, artifact SHA-256 and availability status. For a relay,
record the adapter and container digest or deployment identity.

State when a platform remains on an older release. Do not imply that both mobile
apps or both Mac architectures shipped together. Public notes can link published
checksums; private signing and upload records stay outside Git.

## Changes

Describe the user or operator outcome of each change. Separate features,
corrections and security changes when that helps readers. Include runtime or OS
requirement changes. Do not list commits as the explanation.

## Upgrade and compatibility

For a major release, describe the scope and reason the owner approved, migration
and pairing impact, and recovery plan. Record the decision without publishing
private conversations. Major approval must precede version preparation.

Include a table of the supported, qualified combinations:

| Computer version | Mobile version, OS and build | Relay version and adapter | Wire profile | Evidence |
| --- | --- | --- | --- | --- |

Add only combinations covered by actual evidence. Identify minimum counterpart
versions when a feature requires them; distinguish those requirements from the
versions used during testing. State whether existing pairings remain usable.

For incompatible changes, give the upgrade order, migration steps, re-pairing
requirements and the visible failure state of unsupported clients. If no
migration is needed, say so explicitly.

## Qualification and limits

Record the artifact checks and device, network and runtime combinations tested.
Identify remaining limits. Distinguish source tests, local artifact verification,
store processing and observations on store-installed devices. Accepted push
requests do not demonstrate notification delivery.

## Recovery

State which previous combinations remain usable, what backups are required and
whether storage migrations or pairing floors prevent rollback. Explain the
recovery release path when a store build cannot be downgraded. Link the current
installation and operator instructions.

See [versioning](versioning.md) for bump rules, counters and release preparation,
and the [release checklist](before-first-release.md) for qualification gates.

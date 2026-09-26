# Contributing to Cockpit Speech

Use an Issue-linked isolated branch/worktree and synthetic fixtures. Follow the
README's Node/pnpm, exact published SDK preparation and existing
typecheck/test/build/package checks. Do not use real recordings, credentials or
production sessions. Obtain independent review and pass required checks before
a normal protected merge.

## Development and immutable installation versions

Keep `package.json` and `cockpit.module.json` at `0.0.0-dev`. Do not prepare version
bumps, tags, release labels or release-only PRs. Development builds report
`dev+<shortSHA>`; development packages are not production release candidates.
The independent SDK pin changes only for a real host-contract requirement.
Keep current compatibility guards and source-derived deployment declarations in
sync. Do not infer compatibility from SDK semver or fabricate database migrations.

Every actual PR merged into `main`, including docs and chores, automatically
attempts a Rolling prerelease at its exact merge SHA. An authorized merge
therefore includes that automatic side effect; a PR-only/no-publish boundary
means **do not merge**. See [Releases](docs/releases.md) for the stable sequence,
four-asset verification, recovery and explicit Milestone promotion procedure.

Tags, generated versions and release assets are immutable. Never replace assets,
move tags or write generated versions to main. Deployment, restart and migration
remain separate authorization boundaries owned by the external deployment
service; publication does not imply deployment.

# Releases

## Rolling cutover

The first merge containing the Rolling workflow is the cutover. Earlier tags and
Releases remain untouched; old PRs are not replayed. Every subsequently closed,
actually merged PR targeting `main` (feature/fix/docs/chore, no label or path
filter) gets an independent attempt for `pull_request.merge_commit_sha`.
Unmerged PRs publish nothing.
The `pull_request_target: closed` trigger allows publication for merged fork
PRs too; its mandatory merged gate and exact merge-SHA checkout never execute
an unmerged contribution with the publication token.

<a id="automated-release-procedure"></a>
## Automated release procedure

`.github/workflows/release.yml`, named **Rolling**, is the permanent sequence
authority. Do not rename, delete/recreate, or reset it. `github.run_number`
produces `0.0.0-rolling.N` and tag `v0.0.0-rolling.N`; reruns retain N and the
original event source. Gaps are valid. Completion time and Release timestamps
are **not** ordering: consumers choose greater sequence numbers only, so a
slow older build never supersedes a newer candidate. Failed attempts neither
cancel nor block later merges. There is deliberately no concurrency group:
GitHub can discard pending runs even with `cancel-in-progress: false`.

Main keeps package and module versions at `0.0.0-dev`. The exact merge SHA is
checked out in an isolated runner, tested, then only the two version fields are
deterministically injected. The build receipt and package verifier reject any
other source changes. No generated changes are pushed to main. Development
builds expose `dev+<8-character-SHA>` through backend/frontend version exports,
the microphone tooltip and the build log; Rolling uses the generated version.

The built archive is uploaded once as `rolling-N`; publication downloads that
same artifact without rebuilding, validates it, creates an immutable lightweight
tag with one HTTPS request, then creates one draft. Each Release has exactly:

- `cockpit-speech-0.0.0-rolling.N.tgz`
- `cockpit-speech-0.0.0-rolling.N.tgz.sha256`
- `cockpit-deployment.json`
- `cockpit-deployment.json.sha256`

The format-2 `channel: rolling` descriptor binds repository, tag, exact source,
version, sequence, archive name and module product. It is embedded at the
archive root **byte-for-byte** equal to the sidecar. Its checksum is independent;
the archive checksum is only a separate asset, never a self-referential
descriptor field. The module product derives API min/max from the actual module
manifest and capability vocabulary from frontend activation guards. Speech uses
no host intents and owns no databases/migrations: the backend only reads
`azure-openai.json`. This does not authorize deleting or rewriting that config.
The previous host commit pin is historical test-pairing evidence, not a new
version-by-version deployment catalog or an automatic compatibility selector.

The full corresponding PR title/body is copied into Release notes along with
source/version/sequence and both checksums. The final publication write appends
a machine-readable original Release/asset ID, size and digest baseline to those
notes; later promotion must match it, not adopt replacement uploads as original.
Mutable download counters are excluded from identity comparisons.
After exact-ID asset download,
checksum, package inventory, embedded descriptor, SDK and tag/source readback,
the draft becomes a non-draft **prerelease**, `make_latest=false`.
Only successful final readback establishes Rolling publication.

<a id="atomic-release-publication"></a>
## Immutable publication and recovery

Tag/create/upload/publish are individual `gh api` HTTPS writes with no retry.
Never substitute `gh release create` with asset arguments: it retries uploads.
Unknown outcomes stop immediately. Read failures do not establish absence.
Inspect authenticated paginated Releases, exact refs and asset IDs before any
separately authorized rerun; never delete a partial draft, replace assets,
move a tag, regenerate a version, or republish an already published Release.

Use `gh api 'repos/waksana/cockpit-speech/releases?per_page=100' --paginate
--slurp` for draft discovery, then `releases/{id}` and its paginated `/assets`.
Download with `releases/assets/{asset_id}` and
`Accept: application/octet-stream`. The published-tag endpoint does not discover
drafts. A complete unique exact-tag draft can be recovered only when all four
assets and Release notes/source match the original checked artifact.

After explicitly resolving an uncertain result, rerunning **failed jobs** can
reuse retained `rolling-N` Actions bytes. Rerunning all jobs cannot overwrite an
existing artifact; an expired/missing artifact or partial draft needs operator
inspection, not rebuilding replacement assets. Build failures before upload
may rerun at the same sequence. The workflow never automatically repairs or
retries uncertain writes. Historical stable releases keep their original rules.

## Explicit Milestone promotion

From `main`, dispatch **Milestone** (`.github/workflows/milestone.yml`) with
`tag` and `confirmation` both set to the same user-selected existing successful
Rolling tag. The workflow rejects non-Rolling names before checkout.
It checks out the selected source for verification only: no build or packaging.
It requires a unique non-draft prerelease, its recorded original publication
identity and checksums, the immutable tag/source, all four
uploaded assets, each GitHub SHA-256 upload digest, both checksum files,
descriptor/schema/source/version, archive inventory and embedded byte equality.
It repeats identity checks immediately before the sole write.

That write only changes the **original Release ID** to `prerelease=false` and
`make_latest=true`. No tag, title, body, source, version or asset is changed.
Afterward, all identities/bytes and the Latest endpoint must agree. A failed or
uncertain write is not retried. Selecting or promoting a Milestone is never
inferred from newest completion, and publishing this workflow does not select one.

## Verification and deployment

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm package` and
`pnpm verify:package module-output/cockpit-speech-0.0.0-dev.tgz` on clean
committed source. Existing tests exercise per-merge identity, ordering,
isolation, packaging, unknown writes, complete draft recovery and invariant
promotion. Tests use synthetic local fixtures and GitHub CLI, never live writes.

Merged, Rolling released, Milestone promoted and externally deployed are four
different outcomes. The external deployment service independently selects
compatible increasing sequences and owns installation, migration, restart and
recovery. A Release is not proof of deployment; no repository workflow contacts
that service.

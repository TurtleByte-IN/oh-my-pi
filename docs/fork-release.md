# Fork release pipeline (TurtleByte-IN/oh-my-pi)

The TurtleByte-IN fork ships the same standalone `omp` binaries as upstream, from the same
`.github/workflows/ci.yml`. Ompanel bundles or downloads them as its sidecar and pins their
checksums. This page covers only how the fork differs from upstream. The pipeline itself is
described in [`natives-build-release-debugging.md`](./natives-build-release-debugging.md#ci).

## Runners

Upstream runs most jobs on its self-hosted `omp-kata` pool. That pool has a Bazel remote cache,
and a fork cannot reach either. Each such job picks its runner by repository: `omp-kata` in
`can1357/oh-my-pi`, and GitHub-hosted `ubuntu-22.04` everywhere else. Pull requests already
used `ubuntu-22.04` upstream, so PR CI runs no differently.

In the fork, the Bazel jobs (`rust_validate`, `native_addons` and `native_addons_cross`) build
with no cache. Before they build, the `bazel-cache` action frees disk space and installs
`ninja-build` and `llvm`. The test fan-out runs `test_coding_agent_native` in three shards, as on
PRs. `native_addons_cross` produces the darwin, arm64, musl and win32 addons. Only the release
jobs use those addons, so in the fork it runs only for releases and release dry runs.

## Required checks

Branch protection on fork `main` requires one status check, `CI gate` (job `ci_gate` in
`ci.yml`). It passes only when every pull-request validation job passed: format, lint and type
check (`Lint, type check & web build`, i.e. `oxfmt --check`, `oxlint` and each package's
`check:types`), the TS test buckets, the CLI and install smoke tests, `MODULE.bazel.lock`
freshness, and the `RPC contract` job ([`rpc-contract.md`](./rpc-contract.md)). A failed or
cancelled job fails the gate. Only `rust_validate` may be skipped, and only on pull requests,
where it never runs. A new validation job must be added to the gate's `needs`; no settings
change is needed. Pull requests run CI without a path filter, so every PR reports the gate.

Four upstream coding-agent tests flake only on GitHub-hosted runners and are skipped there by
name (`skipIf(process.env.GITHUB_ACTIONS === "true")`), still running locally: Mermaid ASCII
rendering, the broker runtime-dir-loss handover, the ACP terminal abort, and the browser
mid-goto cancel.

## Platforms

| Asset | Built on | Smoke-tested on | Status |
| --- | --- | --- | --- |
| `omp-linux-x64` | `ubuntu-22.04` | `ubuntu-22.04` | kept |
| `omp-linux-arm64` | `ubuntu-22.04` (cross) | `ubuntu-24.04-arm` | kept |
| `omp-linux-musl-x64` | `ubuntu-22.04` (cross) | Alpine container on `ubuntu-22.04` | kept |
| `omp-linux-musl-arm64` | `ubuntu-22.04` (cross) | Alpine container on `ubuntu-24.04-arm` | kept |
| `omp-darwin-x64` | `ubuntu-22.04` (cross) | `macos-15-intel` | kept |
| `omp-darwin-arm64` | `ubuntu-22.04` (cross) | `macos-15` | kept |
| `omp-windows-x64.exe` | `ubuntu-22.04` (cross) | `windows-2025` | kept |
| `omp-windows-arm64.exe` | `ubuntu-22.04` (cross) | `windows-11-arm` | kept |

No platform is dropped. Bun cross-compiles every binary on Linux, and Bazel cross-builds each
native addon on Linux. The per-platform runners only run `--version` and `--smoke-test` on the
finished binary.

## macOS signing

The fork has no Apple Developer ID secrets yet (blocker B-001). Until they exist, its macOS
binaries are signed ad hoc, with the same entitlements upstream uses (see
[`macos-signing-notarization.md`](./macos-signing-notarization.md)). Gatekeeper does not check
files fetched with `curl` or by Ompanel's downloader, so the ad hoc signature does not block
those installs.

Developer ID signing and notarization only ever happen for a real `v*` tag release:

- The signing step in `release_binary` receives the `APPLE_*` secrets only when `is-release` is
  true. A release dry run, on any ref including a tag, always signs ad hoc, and `release_smoke`
  then skips the Developer ID assertion.
- When you add the five `APPLE_*` secrets, store them as secrets of the `release` GitHub
  Environment, never as repository secrets. That environment already exists, and its deployment
  policy admits only `v*` tags. In the fork, `release_binary` and `release_smoke` enter the
  environment only during a tag release, so no other ref can read the secrets.
- The repository ruleset "Release tags v*" lets only repository and organization admins create,
  update or delete `v*` tags. Without that ruleset, anyone with write access could push a tag
  and get signed binaries. Keep the ruleset active.

## Release assets

Every release carries these assets:

- the eight binaries above;
- `omp-browser-relay-extension.zip`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`;
- one `<asset>.sha256` file for each of those, in `sha256sum` format (fork only; upstream
  releases keep only `SHA256SUMS.txt`);
- `SHA256SUMS.txt`, which lists the checksum of every asset above.

To verify a single binary, download it together with its `.sha256` file and run
`sha256sum -c omp-linux-x64.sha256` (on macOS, `shasum -a 256 -c`).

## Cutting a release

Fork release tags are `v<upstream-version>-ompanel.<n>`. Every release tag must match
`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`; `release_metadata` fails the run on any other
tag. Only an admin can push the tag (see the tag ruleset above). Cut it from fork `main` and push
it on its own:

```bash
git tag v18.12.6-ompanel.1 origin/main
git push origin v18.12.6-ompanel.1
```

The tag push starts `.github/workflows/fork-release.yml`, which runs `ci.yml` as a reusable
workflow on the tag ref. In `can1357/oh-my-pi` that caller job is skipped, so an upstream tag
push runs nothing; upstream keeps releasing from its atomic main+tag push. The run goes through
the validation gate, the binary build, the smoke tests and `release_assets`, then
`release_github`. Just before it publishes, `release_github` checks two things and fails if
either is false:

- the tag still points at the commit this run built (it was not moved during the run);
- that commit is reachable from `main`.

In the fork, a tagged commit on `main` does not count as a release, so pushing `main` and the
tag together releases only once.

These jobs run only in `can1357/oh-my-pi`, so the fork never publishes to upstream's channels:

- `release_native_leaves` and `release_npm` (the `@oh-my-pi` npm scope);
- `release_build` (build.stencil.so, which trusts upstream's OIDC publisher);
- `release_brew` (`can1357/homebrew-tap`).

## Release dry run

You can build every release asset without a tag and without publishing anything:

```bash
gh workflow run ci.yml -R TurtleByte-IN/oh-my-pi --ref <branch> -f release_dry_run=true
```

A dry run sets `build-release` without `is-release`. It runs the addon builds, `release_binary`,
`release_smoke` and `release_assets`, and uploads the complete asset set as the `release-assets`
workflow artifact. A dry run dispatched from a tag publishes nothing either.

Without a cache, a release or dry run takes about 2.5 hours. Most of that is
`native_addons_cross`, which builds seven addon targets one after another (2 h 22 min in run
40252620252). The binary builds, smoke tests and asset assembly take about 4 minutes after that.

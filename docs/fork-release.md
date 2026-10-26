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

The fork has no Apple Developer ID secrets. Its macOS binaries are therefore signed ad hoc, with
the same entitlements upstream uses (see
[`macos-signing-notarization.md`](./macos-signing-notarization.md)). Gatekeeper does not check
files fetched with `curl` or by Ompanel's downloader, so the ad hoc signature does not block
those installs.

## Release assets

Every release carries these assets:

- the eight binaries above;
- `omp-browser-relay-extension.zip`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`;
- one `<asset>.sha256` file for each of those, in `sha256sum` format;
- `SHA256SUMS.txt`, which lists the checksum of every asset above.

To verify a single binary, download it together with its `.sha256` file and run
`sha256sum -c omp-linux-x64.sha256` (on macOS, `shasum -a 256 -c`).

## Cutting a release

Fork releases are tagged `v<upstream-version>-ompanel.<n>`. Cut the tag from fork `main` and push
it on its own:

```bash
git tag v18.12.6-ompanel.1 origin/main
git push origin v18.12.6-ompanel.1
```

The tag push runs the whole workflow on the tag ref. It runs the validation gate, the binary
build, the smoke tests, `release_assets`, and then `release_github`, which publishes the GitHub
Release. In the fork, a tagged commit on `main` does not count as a release, so a push of `main`
and the tag together releases only once.

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

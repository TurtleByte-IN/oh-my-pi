# RPC contract

The RPC contract is the shape of everything `omp --mode rpc` / `--mode rpc-ui` exchanges with a host: every command and its parameters, every success response `data`, and every frame on stdout and stdin. It is described once, as omptype schemas in `packages/coding-agent/src/modes/rpc/wire`. [RPC Protocol Reference](rpc.md) explains the protocol itself.

The contract has a semver, `contractVersion`. Hosts pin that version and check it on every connection.

## Versions on the wire

| Field | Where | Meaning |
| --- | --- | --- |
| `protocolVersion` | `ready`, `negotiate_protocol` | Framing only: v1 lines, or v2 with `rpc_chunk` reassembly. |
| `contractVersion` | `ready`, `negotiate_protocol` response `data` | Semver of the wire shape. |

```json
{ "type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2], "maxFrameBytes": 1048576, "maxReassembledFrameBytes": 67108864, "contractVersion": "1.0.0" }
{ "id": "p1", "type": "response", "command": "negotiate_protocol", "success": true, "data": { "protocolVersion": 2, "contractVersion": "1.0.0" } }
```

Servers built before contract versions omit `contractVersion`. A host that requires a contract treats a missing field as a mismatch.

## The `packages/rpc-contract` package

`@oh-my-pi/rpc-contract` is a private workspace package. It is not published to npm. Hosts take it from a fork release tag. `bun run gen:rpc` generates all of its files except `package.json`, `README.md`, `tsconfig.json`, and `src/index.ts`:

| File | Content |
| --- | --- |
| `rpc-wire.schema.json` | JSON Schema 2020-12 bundle of every definition, plus the `x-rpc` command table and frame unions ([decoder rules](rpc.md#wire-schema-and-generated-clients)). |
| `contract.json` | `{ contractVersion, schemaHash, schema }` for consumers that do not use TypeScript. |
| `src/wire.generated.ts` | TypeScript types for every definition, plus `RpcWireCommands` (each command's params and result). |
| `src/contract.generated.ts` | `RPC_CONTRACT_VERSION` and `RPC_CONTRACT_SCHEMA_HASH`. |
| `src/index.ts` | Re-exports both generated modules. |

```ts
import { RPC_CONTRACT_VERSION, type ReadyEvent, type RpcWireCommands } from "@oh-my-pi/rpc-contract";
import schema from "@oh-my-pi/rpc-contract/rpc-wire.schema.json" with { type: "json" };
```

The `package.json` `version` always equals the contract version.

## Shape hash

`schemaHash` is `sha256:<hex>` over a canonical form of the schema bundle (`packages/coding-agent/scripts/gen-rpc/contract.ts`):

- Documentation is dropped: the `description`, `title`, and `$comment` keywords, and the command `doc` field. Property names are kept, even a property called `description`.
- Object keys are sorted. Commands are sorted by name. The `required`, `enum`, and `clientOmit` lists are sorted. Moving a definition, a field, or a list entry therefore does not count. The order of union members (`anyOf`) does count.
- Everything else counts. That includes adding, removing, or renaming a definition, command, or field; a change to a field's type, its required status, an enum value, a `const`, or a `default`; the decoder markers (`x-open`, `x-unknown-fallback`, `x-scalar-or-array`); and the command metadata (`params`, `result`, `nullable`, `unwrap`, `timeoutMs`, `completion`, `clientOmit`).

Rewording documentation does not require a new contract version. Changing the shape does.

## Version history and the gate

`packages/coding-agent/src/modes/rpc/wire/contract-history.json` holds the version history: an append-only list of `{ "version", "schemaHash" }` entries. `contract.ts` loads it as `RPC_CONTRACT_HISTORY`, and its last entry is the version the server reports. Never edit, remove, or reorder an entry that has reached the base branch.

`packages/coding-agent/test/rpc-wire/` enforces the history:

- `contract.test.ts` fails in these cases:
  - The current bundle's shape hash differs from the last entry's hash. The failure message prints the new hash.
  - A version is not valid semver, or the versions are not strictly ascending.
  - The last version differs from the `packages/rpc-contract/package.json` version.
  - The base branch's history (read with `git show <base>:…/contract-history.json`) is not an unchanged prefix of the branch's history. Editing or removing a recorded entry fails even when the shape hash matches.
- `generated.test.ts` fails when any generated file is stale, including the files in `packages/rpc-contract`.
- `contract-handshake.test.ts` starts `omp --mode rpc` and checks that `ready` and the `negotiate_protocol` response report `RPC_CONTRACT_VERSION`.

The base branch comes from `OMP_RPC_CONTRACT_BASE_REF`. When that variable is set, the append-only check is mandatory and fails if the ref is missing. When it is unset, the check runs against `origin/main` if that ref exists and is skipped otherwise. The CI job `RPC contract` (`.github/workflows/ci.yml`) works with the shallow checkout: it fetches one commit of the pull request's base branch into `refs/remotes/origin/<base>`, sets the variable, and runs `bun run ci:test:rpc-contract` (every test in `test/rpc-wire`). These tests also run in the regular coding-agent test buckets, where the append-only check is skipped.

`bun run gen:rpc` writes every artifact first. If the shape no longer matches the recorded version, it then exits with code 1 and prints the same instructions as the test.

## Bumping the contract version

1. Change the wire definitions under `packages/coding-agent/src/modes/rpc/wire` (and the server code that produces the frames).
2. Run `bun run gen:rpc`. It exits with code 1 and prints the new `schemaHash`.
3. Choose the next version:
   - **major**: an existing host can break. Examples: a field, command, or frame is removed or renamed; a type narrows or changes; a parameter or field becomes required; an enum value is removed; a default changes; a command's `result`, `nullable`, or `unwrap` changes.
   - **minor**: an addition that hosts may ignore. Examples: a new command, frame, or definition; a new optional field or parameter; a new enum value on a frame the server sends. Hosts must tolerate unknown frames and unknown fields. A generated client reports a frame that carries an unknown enum value as an unknown notification.
   - **patch**: a shape-hash change that alters neither what the server accepts nor what it sends (for example `clientOmit`).
4. Append `{ "version": "<next>", "schemaHash": "<printed hash>" }` to `contract-history.json`.
5. Set the same `version` in `packages/rpc-contract/package.json`.
6. Run `bun run gen:rpc` again. It must exit with code 0. Then commit the regenerated files together with the history entry.
7. Add a `CHANGELOG.md` entry that names the new contract version.

When a merge brings in an upstream change to the wire schema, the gate fails until the adoption pull request performs these steps.

### Rust SDK caveat

The generated Rust structs in `sdk/rust/omp-rpc` (`ReadyEvent`, `NegotiateProtocolResult`, and every other wire struct) are not marked `#[non_exhaustive]`; nothing in that crate is, and the structs do not derive `Default`. Adding an optional field, which is a minor contract bump, therefore breaks Rust code that builds those structs with a struct literal: the code must add the new field. Adding `contractVersion` broke `omp-rpc`'s own client this way. Rust consumers should treat every contract bump as a possible source-breaking change for struct literals, or build the structs by deserializing JSON, where a missing optional field becomes `None`.

## Pinning the contract in a host

The contract version in a release is the one at that fork tag (`v<upstream-version>-ompanel.<n>`). A host pins it as follows:

1. Vendor `packages/rpc-contract` from the tag: `rpc-wire.schema.json`, `contract.json`, and `src/`. Record the tag, `contractVersion`, and `schemaHash` in the host's lock file.
2. In CI, compare the vendored files byte for byte with `git show <tag>:packages/rpc-contract/<file>`. A difference means the vendored copy and the pinned tag disagree.
3. At runtime, read `contractVersion` from `ready` (or from the `negotiate_protocol` response) and compare it with the pinned version. Refuse to drive a sidecar whose version differs from the pin, or is absent. A host that accepts a range instead should accept a sidecar only when its major version equals the pinned major and its minor version is equal to or greater than the pinned minor.

`schemaHash` identifies the shape across tags: two releases with the same hash expose the same wire shape.

## CLI JSON contract

Hosts also drive a few `omp` subcommands and parse their `--json` output. Those outputs form a second contract with its own semver, `cliContractVersion`. It is independent of the RPC `contractVersion`: a change to one never requires a bump of the other.

| Command | Output definition |
| --- | --- |
| `omp config list --json [--cwd <path>]` | `CliConfigList`: `{ value?, redacted?, type, description, source }` per setting key; `source` is the layer supplying the effective value (`default`, `global`, `project`, `overlay`, `runtime`, `env`). Configured credentials carry `redacted: true` and no `value`. |
| `omp config set <key> <value> --json [--scope global\|project] [--cwd <path>]` | `CliConfigSetResult`: `{ key, scope, value?, overriddenBy?, fallbackEnv? }` |
| `omp config reset <key> --json [--scope global\|project] [--cwd <path>]` | `CliConfigResetResult`: `{ key, scope, value?, redacted? }` |
| `omp models [ls\|find\|refresh] [pattern] --json [--kind <kind>]` | `CliModelsList`: `{ models: CliModel[] }` |
| `omp plugin list --json` | `CliPluginList`: `{ npm: CliNpmPlugin[], marketplace: CliMarketplacePlugin[] }` |
| `omp skill list [dir] --json` | `CliSkillList`: `{ skills: CliSkill[], warnings: CliSkillWarning[] }` |

The definitions are omptype schemas in `packages/coding-agent/src/cli/contract`. Objects omp owns reject undeclared keys, so adding a field changes the shape. Three values pass third-party data through and stay open: a plugin's `manifest` (its package.json `omp`/`pi` field verbatim), the install records of the Claude-compatible `installed_plugins.json` registry, and extra pricing keys on a model's `cost`. Only their declared fields are part of the contract.

`bun run gen:rpc` writes the CLI contract into `packages/rpc-contract` next to the RPC files:

| File | Content |
| --- | --- |
| `cli-contract.schema.json` | JSON Schema 2020-12 bundle of every output definition, plus the `x-cli` command table (`name`, `usage`, `output`). |
| `cli-contract.json` | `{ cliContractVersion, schemaHash, schema }`. |
| `src/cli.generated.ts` | `CLI_CONTRACT_VERSION`, `CLI_CONTRACT_SCHEMA_HASH`, a TypeScript type per definition, and `CliJsonOutputs` (each command's output type by command name). |

```ts
import { CLI_CONTRACT_VERSION, type CliJsonOutputs } from "@oh-my-pi/rpc-contract";
import cliSchema from "@oh-my-pi/rpc-contract/cli-contract.schema.json" with { type: "json" };
```

The shape hash follows the RPC rules above; a command's `usage` text is documentation and does not count. The history is `packages/coding-agent/src/cli/contract/contract-history.json`, append-only like the RPC history. `test/rpc-wire/cli-contract.test.ts` (part of the `RPC contract` CI job, with the same `OMP_RPC_CONTRACT_BASE_REF` handling) fails in these cases:

- The bundle's shape hash differs from the last history entry, or a history entry already on the base branch was edited, removed, or reordered.
- The versions are not ascending semver.
- A command's real output no longer matches its definition. The test runs `config list` with a value from every source layer and a configured credential, `config set` and `config reset` in both scopes, `plugin list` with a linked npm plugin and a marketplace install, and `skill list` on a project with a skill, and renders `models --json` for every bundled catalog model.

To change an output: change the command, update its definition in `src/cli/contract/index.ts`, run `bun run gen:rpc` (it prints the new hash and exits 1), append `{ "version": "<next>", "schemaHash": "<printed hash>" }` to the CLI history using the semver rules above, run `bun run gen:rpc` again, and add a `CHANGELOG.md` entry naming the new CLI contract version. The `packages/rpc-contract/package.json` version stays the RPC contract version.

A host vendors the CLI files from the same fork tag as the RPC files and checks them the same way. The binary at that tag implements the vendored `cliContractVersion`; no subcommand reports it at runtime, so the tag pin is the check.

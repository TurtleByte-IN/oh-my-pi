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
- Object keys are sorted, and commands are sorted by name, so authoring order does not count.
- Everything else counts. That includes adding, removing, or renaming a definition, command, or field; a change to a field's type, its required status, an enum value, a `const`, or a `default`; the decoder markers (`x-open`, `x-unknown-fallback`, `x-scalar-or-array`); and the command metadata (`params`, `result`, `nullable`, `unwrap`, `timeoutMs`, `completion`, `clientOmit`).

Rewording documentation does not require a new contract version. Changing the shape does.

## Version history and the gate

`packages/coding-agent/src/modes/rpc/wire/contract.ts` holds `RPC_CONTRACT_HISTORY`. This is an append-only list of `{ version, schemaHash }` entries. The last entry is the version the server reports. Never edit an entry that has been recorded.

`packages/coding-agent/test/rpc-wire/` enforces the history:

- `contract.test.ts` fails when the current bundle's shape hash differs from the last entry's hash. The failure message prints the new hash. The test also fails when versions are not valid semver, are not strictly ascending, or differ from the `packages/rpc-contract/package.json` version.
- `generated.test.ts` fails when any generated file is stale, including the files in `packages/rpc-contract`.
- `contract-handshake.test.ts` starts `omp --mode rpc` and checks that `ready` and the `negotiate_protocol` response report `RPC_CONTRACT_VERSION`.

`bun run gen:rpc` writes every artifact first. If the shape no longer matches the recorded version, it then exits with code 1 and prints the same instructions as the test.

## Bumping the contract version

1. Change the wire definitions under `packages/coding-agent/src/modes/rpc/wire` (and the server code that produces the frames).
2. Run `bun run gen:rpc`. It exits with code 1 and prints the new `schemaHash`.
3. Choose the next version:
   - **major**: an existing host can break. Examples: a field, command, or frame is removed or renamed; a type narrows or changes; a parameter or field becomes required; an enum value is removed; a default changes; a command's `result`, `nullable`, or `unwrap` changes.
   - **minor**: an addition that hosts may ignore. Examples: a new command, frame, or definition; a new optional field or parameter; a new enum value on a frame the server sends. Hosts must tolerate unknown frames and unknown fields. A generated client reports a frame that carries an unknown enum value as an unknown notification.
   - **patch**: a shape-hash change that alters neither what the server accepts nor what it sends (for example `clientOmit`).
4. Append `{ version: "<next>", schemaHash: "<printed hash>" }` to `RPC_CONTRACT_HISTORY`.
5. Set the same `version` in `packages/rpc-contract/package.json`.
6. Run `bun run gen:rpc` again. It must exit with code 0. Then commit the regenerated files together with the history entry.
7. Add a `CHANGELOG.md` entry that names the new contract version.

When a merge brings in an upstream change to the wire schema, the gate fails until the adoption pull request performs these steps.

## Pinning the contract in a host

The contract version in a release is the one at that fork tag (`v<upstream-version>-ompanel.<n>`). A host pins it as follows:

1. Vendor `packages/rpc-contract` from the tag: `rpc-wire.schema.json`, `contract.json`, and `src/`. Record the tag, `contractVersion`, and `schemaHash` in the host's lock file.
2. In CI, compare the vendored files byte for byte with `git show <tag>:packages/rpc-contract/<file>`. A difference means the vendored copy and the pinned tag disagree.
3. At runtime, read `contractVersion` from `ready` (or from the `negotiate_protocol` response) and compare it with the pinned version. Refuse to drive a sidecar whose version differs from the pin, or is absent. A host that accepts a range instead should accept a sidecar only when its major version equals the pinned major and its minor version is equal to or greater than the pinned minor.

`schemaHash` identifies the shape across tags: two releases with the same hash expose the same wire shape.

#!/usr/bin/env bun
/**
 * Generate a `sha256sum`-compatible checksums file for release assets.
 *
 * Usage:
 *   bun scripts/ci-release-checksums.ts [--per-file] <out-file> <asset>...
 *
 * Each `<asset>` is hashed and written as a `<sha256>  <basename>` line,
 * sorted by basename, so the result can be verified after download with
 * `sha256sum -c SHA256SUMS.txt` (or `shasum -a 256 -c` on macOS).
 *
 * `--per-file` also writes `<asset>.sha256` next to each asset, holding that
 * asset's single line, so a client downloading one binary can verify it with
 * one extra request (`sha256sum -c omp-linux-x64.sha256`).
 *
 * Intended for the `release_assets` CI job, run after the release binaries
 * and browser-relay archive are assembled and before the GitHub Release is
 * created, so the checksums file itself ships as one of the release assets.
 */

import * as path from "node:path";

export interface ChecksumEntry {
	name: string;
	sha256: string;
}

export function formatChecksums(entries: readonly ChecksumEntry[]): string {
	return entries
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ sha256, name }) => `${sha256}  ${name}\n`)
		.join("");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const perFile = args[0] === "--per-file";
	const [outFile, ...assetPaths] = perFile ? args.slice(1) : args;
	if (!outFile || assetPaths.length === 0) {
		throw new Error("usage: ci-release-checksums.ts [--per-file] <out-file> <asset>...");
	}

	const entries = await Promise.all(
		assetPaths.map(async assetPath => {
			const hasher = new Bun.CryptoHasher("sha256");
			for await (const chunk of Bun.file(assetPath).stream()) {
				hasher.update(chunk);
			}
			const entry = { name: path.basename(assetPath), sha256: hasher.digest("hex") };
			if (perFile) {
				await Bun.write(`${assetPath}.sha256`, formatChecksums([entry]));
			}
			return entry;
		}),
	);

	await Bun.write(outFile, formatChecksums(entries));
	console.log(
		`Wrote ${entries.length} checksum(s) to ${outFile}${perFile ? ` and ${entries.length} per-file .sha256` : ""}`,
	);
}

if (import.meta.main) {
	await main();
}

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import contract from "../../../rpc-contract/contract.json" with { type: "json" };
import { RPC_CONTRACT_VERSION } from "../../src/modes/rpc/wire/contract";

describe("RPC contract version handshake", () => {
	test("ready and negotiate_protocol report the contract version", async () => {
		const dir = TempDir.createSync("@omp-rpc-contract-");
		const home = dir.path();
		// A model must resolve for RPC mode to start; no request reaches it.
		await Bun.write(
			join(home, ".omp/agent/models.yml"),
			"providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n    apiKey: test-dummy-key\n",
		);
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../../src/cli.ts"),
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: home,
				env: {
					HOME: home,
					PATH: process.env.PATH,
					XDG_CONFIG_HOME: home,
					XDG_DATA_HOME: home,
					PI_CODING_AGENT_DIR: join(home, ".omp/agent"),
					NO_COLOR: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = new Response(child.stderr).text();
		const lines = readLines(child.stdout, AbortSignal.timeout(30000));
		const decoder = new TextDecoder();
		const receive = async (): Promise<Record<string, unknown>> => {
			const line = await lines.next();
			if (line.done) throw new Error(await stderr);
			return JSON.parse(decoder.decode(line.value));
		};
		try {
			let ready = await receive();
			while (ready.type !== "ready") ready = await receive();
			expect(ready).toMatchObject({ protocolVersion: 1, contractVersion: RPC_CONTRACT_VERSION });
			expect(ready.contractVersion).toBe(contract.contractVersion);

			child.stdin.write(`${JSON.stringify({ id: "n1", type: "negotiate_protocol", protocolVersion: 2 })}\n`);
			await child.stdin.flush();
			let response = await receive();
			while (response.type !== "response" || response.id !== "n1") response = await receive();
			expect(response).toMatchObject({
				command: "negotiate_protocol",
				success: true,
				data: { protocolVersion: 2, contractVersion: RPC_CONTRACT_VERSION },
			});
		} finally {
			child.kill();
			await child.exited;
			await stderr;
			await dir.remove();
		}
	}, 60000);
});

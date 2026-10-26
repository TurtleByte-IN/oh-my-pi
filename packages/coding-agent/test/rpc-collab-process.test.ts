/**
 * `collab_start` / `collab_status` / `collab_stop` over a real RPC process and a
 * real (local) relay: wire shapes, link-free `collab_state` frames, a guest
 * joining through the returned link, and the goodbye guests get when stdin ends.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";
import { startLocalRelay } from "../../collab-web/scripts/local-relay";

describe("collab commands over RPC", () => {
	test("start/status/stop wire shapes; guests join through the link and get a goodbye on exit", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-collab-"));
		const relay = startLocalRelay();
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "collab-rpc-agent.ts")], {
			cwd: dir,
			env: {
				...process.env,
				HOME: dir,
				PI_CODING_AGENT_DIR: path.join(dir, "agent"),
				PI_NO_TITLE: "1",
				COLLAB_TEST_RELAY_URL: relay.url,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
		const decoder = new TextDecoder();
		const seen: Record<string, unknown>[] = [];
		const receive = async (): Promise<Record<string, unknown> | undefined> => {
			const line = await lines.next();
			if (line.done) return undefined;
			const frame = JSON.parse(decoder.decode(line.value)) as Record<string, unknown>;
			seen.push(frame);
			return frame;
		};
		const until = async (predicate: (frame: Record<string, unknown>) => boolean) => {
			if (seen.some(predicate)) return;
			for (;;) {
				const frame = await receive();
				if (!frame) throw new Error(await stderr);
				if (predicate(frame)) return;
			}
		};
		let id = 0;
		const command = async (fields: object): Promise<Record<string, unknown>> => {
			const requestId = String(++id);
			child.stdin.write(`${JSON.stringify({ ...fields, id: requestId })}\n`);
			await child.stdin.flush();
			let response: Record<string, unknown> | undefined;
			await until(frame => {
				if (frame.type === "response" && frame.id === requestId) response = frame;
				return response !== undefined;
			});
			return response!;
		};
		const collabStates = () => seen.filter(frame => frame.type === "collab_state");
		const guestFrames: CollabFrame[] = [];
		let guest: CollabSocket | undefined;
		try {
			await until(frame => frame.type === "ready");
			expect(await command({ type: "collab_status" })).toEqual({
				id: "1",
				type: "response",
				command: "collab_status",
				success: true,
				data: { active: false, participants: [] },
			});
			expect(await command({ type: "collab_start", access: "owner" })).toMatchObject({
				success: false,
				error: 'access must be "view" or "control"',
			});

			const started = await command({ type: "collab_start", access: "view" });
			expect(started).toMatchObject({
				command: "collab_start",
				success: true,
				data: {
					active: true,
					access: "view",
					relayConnected: true,
					participants: [{ name: "rpc-host", role: "host" }],
				},
			});
			const link = (started.data as { link: string }).link;
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.writeToken).toBeUndefined();
			expect(collabStates()).toEqual([{ type: "collab_state", active: true, participantCount: 1 }]);

			guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
			const welcomed = Promise.withResolvers<void>();
			const bye = Promise.withResolvers<void>();
			guest.onFrame = frame => {
				guestFrames.push(frame);
				if (frame.t === "welcome") welcomed.resolve();
				if (frame.t === "bye") bye.resolve();
			};
			guest.onOpen = () => guest!.send({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
			guest.connect();
			await welcomed.promise;
			await until(frame => frame.type === "collab_state" && frame.participantCount === 2);
			expect((await command({ type: "collab_status" })).data).toMatchObject({
				active: true,
				link,
				participants: [
					{ name: "rpc-host", role: "host" },
					{ name: "guest", role: "guest", readOnly: true },
				],
			});

			expect(await command({ type: "collab_stop" })).toMatchObject({ success: true, data: { stopped: true } });
			await bye.promise;
			expect(collabStates().at(-1)).toEqual({ type: "collab_state", active: false, participantCount: 0 });
			expect(await command({ type: "collab_stop" })).toMatchObject({ success: true, data: { stopped: false } });

			// A room still open when stdin ends says goodbye before the process exits.
			const second = await command({ type: "collab_start" });
			expect(second).toMatchObject({ success: true, data: { access: "control" } });
			const controlLink = parseCollabLink((second.data as { link: string }).link);
			if ("error" in controlLink) throw new Error(controlLink.error);
			expect(controlLink.writeToken).toBeDefined();
			// No frame carries a link.
			for (const frame of collabStates())
				expect(Object.keys(frame).sort()).toEqual(["active", "participantCount", "type"]);

			await child.stdin.end();
			while (await receive()) {}
			expect(await child.exited).toBe(0);
			expect(collabStates().at(-1)).toEqual({ type: "collab_state", active: false, participantCount: 0 });
		} finally {
			guest?.close();
			child.kill();
			await child.exited;
			await stderr;
			relay.stop();
			await removeWithRetries(dir);
		}
	}, 60_000);
});

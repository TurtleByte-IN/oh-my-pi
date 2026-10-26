/**
 * `collab_start` / `collab_status` / `collab_stop` over a real RPC process and a
 * real (local) relay: wire shapes, link-free `collab_state` frames, a guest
 * joining through the returned link, cancelling a start while the relay
 * connection is still opening, and the room ending as soon as stdin ends.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";
import { startLocalRelay } from "../../collab-web/scripts/local-relay";

type Frame = Record<string, unknown>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The collab RPC fixture on `relayUrl`, with helpers to send commands and read frames. */
async function startAgent(relayUrl: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-collab-"));
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "collab-rpc-agent.ts")], {
		cwd: dir,
		env: {
			...process.env,
			HOME: dir,
			PI_CODING_AGENT_DIR: path.join(dir, "agent"),
			PI_NO_TITLE: "1",
			COLLAB_TEST_RELAY_URL: relayUrl,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	cleanups.push(async () => {
		child.kill();
		await child.exited;
		await stderr;
		await removeWithRetries(dir);
	});
	const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
	const decoder = new TextDecoder();
	const seen: Frame[] = [];
	const receive = async (): Promise<Frame | undefined> => {
		const line = await lines.next();
		if (line.done) return undefined;
		const frame = JSON.parse(decoder.decode(line.value)) as Frame;
		seen.push(frame);
		return frame;
	};
	const until = async (predicate: (frame: Frame) => boolean): Promise<Frame> => {
		const found = seen.find(predicate);
		if (found) return found;
		for (;;) {
			const frame = await receive();
			if (!frame) throw new Error(await stderr);
			if (predicate(frame)) return frame;
		}
	};
	let id = 0;
	/** Writes the command and returns its request id without waiting for the response. */
	const send = async (fields: object): Promise<string> => {
		const requestId = String(++id);
		child.stdin.write(`${JSON.stringify({ ...fields, id: requestId })}\n`);
		await child.stdin.flush();
		return requestId;
	};
	const response = (requestId: string) => until(frame => frame.type === "response" && frame.id === requestId);
	const command = async (fields: object) => response(await send(fields));
	/** Ends stdin, reads stdout to its end, and returns the exit code. */
	const exit = async () => {
		await child.stdin.end();
		while (await receive()) {}
		return child.exited;
	};
	await until(frame => frame.type === "ready");
	return {
		seen,
		until,
		send,
		response,
		command,
		exit,
		collabStates: () => seen.filter(frame => frame.type === "collab_state"),
	};
}

/** A guest joined through `link`, recording when the host's goodbye arrives. */
async function joinGuest(link: string) {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => guest.close());
	const welcomed = Promise.withResolvers<void>();
	const bye = Promise.withResolvers<void>();
	guest.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
		if (frame.t === "bye") bye.resolve();
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	guest.connect();
	await welcomed.promise;
	return { bye: bye.promise };
}

/** A relay that accepts the connection but never answers the WebSocket upgrade: the room never opens. */
function startStalledRelay() {
	const reached = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			reached.resolve();
			return new Promise<Response>(() => {});
		},
	});
	cleanups.push(() => server.stop(true));
	return { url: `ws://localhost:${server.port}`, reached: reached.promise };
}

function startRelay() {
	const relay = startLocalRelay();
	cleanups.push(() => relay.stop());
	return relay;
}

describe("collab commands over RPC", () => {
	test("start/status/stop wire shapes; guests join through the link and get a goodbye on exit", async () => {
		const agent = await startAgent(startRelay().url);
		expect(await agent.command({ type: "collab_status" })).toEqual({
			id: "1",
			type: "response",
			command: "collab_status",
			success: true,
			data: { active: false, participants: [] },
		});
		expect(await agent.command({ type: "collab_start", access: "owner" })).toMatchObject({
			success: false,
			error: 'access must be "view" or "control"',
		});

		const started = await agent.command({ type: "collab_start", access: "view" });
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
		expect(agent.collabStates()).toEqual([{ type: "collab_state", active: true, participantCount: 1 }]);

		const guest = await joinGuest(link);
		await agent.until(frame => frame.type === "collab_state" && frame.participantCount === 2);
		expect((await agent.command({ type: "collab_status" })).data).toMatchObject({
			active: true,
			link,
			participants: [
				{ name: "rpc-host", role: "host" },
				{ name: "guest", role: "guest", readOnly: true },
			],
		});

		expect(await agent.command({ type: "collab_stop" })).toMatchObject({ success: true, data: { stopped: true } });
		await guest.bye;
		expect(agent.collabStates().at(-1)).toEqual({ type: "collab_state", active: false, participantCount: 0 });
		expect(await agent.command({ type: "collab_stop" })).toMatchObject({ success: true, data: { stopped: false } });

		// A room still open when stdin ends says goodbye before the process exits.
		const second = await agent.command({ type: "collab_start" });
		expect(second).toMatchObject({ success: true, data: { access: "control" } });
		const controlLink = parseCollabLink((second.data as { link: string }).link);
		if ("error" in controlLink) throw new Error(controlLink.error);
		expect(controlLink.writeToken).toBeDefined();
		// No frame carries a link.
		for (const frame of agent.collabStates())
			expect(Object.keys(frame).sort()).toEqual(["active", "participantCount", "type"]);

		expect(await agent.exit()).toBe(0);
		expect(agent.collabStates().at(-1)).toEqual({ type: "collab_state", active: false, participantCount: 0 });
	}, 60_000);

	test("collab_stop cancels a start whose relay connection is still opening", async () => {
		const relay = startStalledRelay();
		const agent = await startAgent(relay.url);
		const start = await agent.send({ type: "collab_start" });
		// The host is connecting: the relay has the upgrade request and will never answer it.
		await relay.reached;
		expect(await agent.command({ type: "collab_stop" })).toMatchObject({ success: true, data: { stopped: true } });
		expect(await agent.response(start)).toMatchObject({ command: "collab_start", success: false });
		expect((await agent.command({ type: "collab_status" })).data).toEqual({ active: false, participants: [] });
		expect(agent.collabStates().some(frame => frame.active === true)).toBe(false);
		expect(await agent.exit()).toBe(0);
	}, 60_000);

	test("stdin end closes the room before accepted work drains", async () => {
		const agent = await startAgent(startRelay().url);
		const started = await agent.command({ type: "collab_start" });
		const guest = await joinGuest((started.data as { link: string }).link);
		await agent.until(frame => frame.type === "collab_state" && frame.participantCount === 2);
		// Accepted, still running work keeps the process alive after stdin ends.
		const bash = await agent.send({ type: "bash", command: "sleep 2" });
		expect(await agent.exit()).toBe(0);
		await guest.bye;
		const ended = agent.seen.findIndex(frame => frame.type === "collab_state" && frame.active === false);
		const bashDone = agent.seen.findIndex(frame => frame.type === "response" && frame.id === bash);
		expect(ended).toBeGreaterThanOrEqual(0);
		expect(bashDone).toBeGreaterThan(ended);
	}, 60_000);

	test("a start still connecting when stdin ends never opens a room", async () => {
		const relay = startStalledRelay();
		const agent = await startAgent(relay.url);
		const start = await agent.send({ type: "collab_start" });
		await relay.reached;
		const begun = Date.now();
		expect(await agent.exit()).toBe(0);
		// Shut down at once, not after the relay's 15 s connect timeout.
		expect(Date.now() - begun).toBeLessThan(10_000);
		expect(agent.seen.find(frame => frame.type === "response" && frame.id === start)).toMatchObject({
			success: false,
		});
		expect(agent.collabStates().some(frame => frame.active === true)).toBe(false);
	}, 60_000);
});

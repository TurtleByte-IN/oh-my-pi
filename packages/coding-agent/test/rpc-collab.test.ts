/**
 * RPC collab hosting: `collab_start` hosts the RPC session in a room on request
 * only (`collab.autoStart` is ignored), returns links for the granted access (a
 * view room never hands out its write token), reports every room change as a
 * link-free `collab_state` frame, and the room ends on `collab_stop`, on a
 * session change, and on shutdown without a successor being started.
 *
 * Real CollabController/CollabHost/CollabSocket run over the in-memory relay; the
 * registry's IPC is redirected into a temp dir via a spy on `publishCollabHost`.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHostStoppedError } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { RpcCollabBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collab";
import type { RpcCollabStateFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import * as utils from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { createTestSession, type TestSessionContext } from "./utilities";

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let testSession: TestSessionContext;
let bridge: RpcCollabBridge;
let frames: RpcCollabStateFrame[];
let frameWaiters: { predicate: (frame: RpcCollabStateFrame) => boolean; resolve: () => void }[];
const guestSockets: CollabSocket[] = [];

/** Resolves once a `collab_state` frame matching `predicate` has been emitted (now or later). */
function nextState(predicate: (frame: RpcCollabStateFrame) => boolean): Promise<void> {
	if (frames.some(predicate)) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	frameWaiters.push({ predicate, resolve });
	return promise;
}

/** Join through `link` and resolve once the host's welcome arrived. */
async function join(link: string): Promise<CollabSocket> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	guestSockets.push(socket);
	const welcomed = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	await welcomed.promise;
	return socket;
}

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-collab-"));
	utils.setAgentDir(path.join(tmp, "agent"));
	installInMemoryRelay();
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		real(source, { ...options, dir: tmp }),
	);
	testSession = await createTestSession({
		inMemory: true,
		settingsOverrides: {
			// RPC sessions never follow the saved policy; this proves it.
			"collab.autoStart": "control",
			"collab.relayUrl": RELAY_URL,
			"collab.webUrl": WEB_URL,
			"collab.displayName": "rpc-host",
		},
	});
	frames = [];
	frameWaiters = [];
	bridge = new RpcCollabBridge(testSession.session, frame => {
		frames.push(frame);
		for (const waiter of frameWaiters.filter(w => w.predicate(frame))) {
			frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	});
});

afterEach(async () => {
	for (const socket of guestSockets.splice(0)) socket.close();
	await bridge.shutdown().catch(() => {});
	await testSession.cleanup();
	uninstallInMemoryRelay();
	publishSpy.mockRestore();
	utils.__resetDirsFromEnvForTests();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("RPC collab hosting", () => {
	it("reports no room until one is requested, whatever collab.autoStart says", () => {
		expect(bridge.status()).toEqual({ active: false, participants: [] });
		expect(frames).toEqual([]);
		expect(publishSpy).not.toHaveBeenCalled();
	});

	it("starts a control room with write-token links and reports guests joining", async () => {
		const status = await bridge.start();
		expect(status).toMatchObject({
			active: true,
			access: "control",
			relayConnected: true,
			participants: [{ name: "rpc-host", role: "host" }],
		});
		const parsed = parseCollabLink(status.link!);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.writeToken).toBeDefined();
		expect(status.webLink!.startsWith(WEB_URL)).toBe(true);
		expect(frames).toEqual([{ type: "collab_state", active: true, participantCount: 1 }]);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ access: "control", generation: 1 }]);

		await join(status.link!);
		await nextState(frame => frame.participantCount === 2);
		expect(bridge.status().participants).toEqual([
			{ name: "rpc-host", role: "host" },
			{ name: "guest", role: "guest" },
		]);
		// Frames never carry the capability links.
		for (const frame of frames) expect(Object.keys(frame).sort()).toEqual(["active", "participantCount", "type"]);
	});

	it("a view room hands out only links without the write token", async () => {
		const status = await bridge.start({ access: "view" });
		expect(status.access).toBe("view");
		const parsed = parseCollabLink(status.link!);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.writeToken).toBeUndefined();
		expect(status.webLink!.endsWith(`#${status.link}`)).toBe(true);

		await join(status.link!);
		await nextState(frame => frame.participantCount === 2);
		expect(bridge.status().participants[1]).toEqual({ name: "guest", role: "guest", readOnly: true });
	});

	it("reuses a room that already grants the access and replaces a view room for control", async () => {
		const view = await bridge.start({ access: "view" });
		expect((await bridge.start({ access: "view" })).link).toBe(view.link);
		const control = await bridge.start({ access: "control" });
		expect(control.access).toBe("control");
		expect(control.link).not.toBe(view.link);
		expect((await bridge.start({ access: "view" })).link).toBe(control.link);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ access: "control", generation: 2 }]);
	});

	it("collab_stop ends the room once and reports it", async () => {
		await bridge.start();
		expect(await bridge.stop()).toBe(true);
		expect(frames.at(-1)).toEqual({ type: "collab_state", active: false, participantCount: 0 });
		expect(bridge.status()).toEqual({ active: false, participants: [] });
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect(await bridge.stop()).toBe(false);
	});

	it("a session change ends the room and starts no successor", async () => {
		await bridge.start();
		expect(await testSession.session.newSession()).toBe(true);
		await nextState(frame => !frame.active);
		expect(bridge.status().active).toBe(false);
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("collab_stop cancels a start not yet connecting and reports it stopped", async () => {
		const starting = bridge.start();
		expect(await bridge.stop()).toBe(true);
		await expect(starting).rejects.toThrow(CollabHostStoppedError);
		expect(bridge.status().active).toBe(false);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("collab_stop aborts a relay connection still opening", async () => {
		// A socket that stays CONNECTING: the relay never opens the room.
		const connecting = Promise.withResolvers<void>();
		globalThis.WebSocket = class StalledWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			binaryType = "blob";
			bufferedAmount = 0;
			readyState = 0;
			onopen = null;
			onmessage = null;
			onerror = null;
			onclose = null;
			constructor() {
				connecting.resolve();
			}
			addEventListener() {}
			send() {}
			ping() {}
			close() {
				this.readyState = 3;
			}
			terminate() {
				this.readyState = 3;
			}
		} as unknown as typeof WebSocket;
		const starting = bridge.start();
		await connecting.promise;
		expect(await bridge.stop()).toBe(true);
		await expect(starting).rejects.toThrow(CollabHostStoppedError);
		expect(frames.some(frame => frame.active)).toBe(false);
		expect(bridge.status().active).toBe(false);
		expect(publishSpy).not.toHaveBeenCalled();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("shutdown cancels a start still connecting", async () => {
		const starting = bridge.start();
		await bridge.shutdown();
		await expect(starting).rejects.toThrow(CollabHostStoppedError);
		expect(frames.some(frame => frame.active)).toBe(false);
		await expect(bridge.start()).rejects.toThrow(CollabHostStoppedError);
	});
});

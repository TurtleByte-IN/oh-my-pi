import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --brand flag", () => {
	it("leaves brand unset by default", () => {
		const result = parseArgs(["hello"]);

		expect(result.brand).toBeUndefined();
		expect(result.invalidFlagValues).toEqual([]);
	});

	it("parses --brand with a space-separated name", () => {
		const result = parseArgs(["--brand", "Ompanel", "hello"]);

		expect(result.brand).toBe("Ompanel");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --brand=value and trims surrounding whitespace", () => {
		const result = parseArgs(["--brand= Ompanel ", "hello"]);

		expect(result.brand).toBe("Ompanel");
		expect(result.messages).toEqual(["hello"]);
	});

	it("rejects an empty or control-character name", () => {
		expect(parseArgs(["--brand=  "]).invalidFlagValues).toHaveLength(1);
		expect(parseArgs(["--brand", "a\u001b[31mb"]).invalidFlagValues).toHaveLength(1);
	});
});

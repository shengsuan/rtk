import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRtkBeforeTool,
	rewriteCommand,
	rewriteRunCommandsInput,
} from "./index.js";

const rewrite = (command) => rewriteCommand(command, "rtk");

function runCommands(input, tool = "run_commands") {
	return { tool: { name: tool }, input };
}

describe("rewriteCommand", () => {
	it("returns the rtk form of a command that has an rtk equivalent", () => {
		assert.equal(rewrite("git status"), "rtk git status");
	});

	it("returns undefined for a command rtk does not rewrite", () => {
		assert.equal(rewrite("echo hi"), undefined);
	});

	it("returns undefined when the rtk binary cannot run", () => {
		assert.equal(rewriteCommand("git status", "/nonexistent/rtk"), undefined);
	});
});

describe("rewriteRunCommandsInput", () => {
	it("rewrites a single shell command string", () => {
		assert.equal(rewriteRunCommandsInput("git status", rewrite), "rtk git status");
	});

	it("rewrites only the commands rtk knows in a list", () => {
		assert.deepEqual(
			rewriteRunCommandsInput(["git status", "echo hi"], rewrite),
			["rtk git status", "echo hi"],
		);
	});

	it("returns undefined when no command in the list is rewritten", () => {
		assert.equal(rewriteRunCommandsInput(["echo hi", "true"], rewrite), undefined);
	});

	it("keeps the wrapping object shape for { commands }", () => {
		assert.deepEqual(
			rewriteRunCommandsInput({ commands: ["git status"], timeout: 30 }, rewrite),
			{ commands: ["rtk git status"], timeout: 30 },
		);
	});

	it("leaves structured executable entries untouched", () => {
		const structured = [{ command: "git", args: ["status"] }];
		assert.equal(rewriteRunCommandsInput(structured, rewrite), undefined);
		assert.equal(
			rewriteRunCommandsInput({ command: "git", args: ["status"] }, rewrite),
			undefined,
		);
	});
});

describe("createRtkBeforeTool", () => {
	it("returns a replacement input for a run_commands call that rtk rewrites", () => {
		const beforeTool = createRtkBeforeTool(rewrite);
		assert.deepEqual(beforeTool(runCommands("git status")), {
			input: "rtk git status",
		});
	});

	it("returns undefined for a run_commands call with nothing to rewrite", () => {
		const beforeTool = createRtkBeforeTool(rewrite);
		assert.equal(beforeTool(runCommands("echo hi")), undefined);
	});

	it("ignores calls to tools other than run_commands", () => {
		const beforeTool = createRtkBeforeTool(rewrite);
		assert.equal(beforeTool(runCommands("git status", "read_files")), undefined);
	});

	it("does not rewrite when no rtk binary is available", () => {
		const beforeTool = createRtkBeforeTool(() => undefined);
		assert.equal(beforeTool(runCommands("git status")), undefined);
	});
});

import { spawnSync } from "node:child_process";

const RUN_COMMANDS_TOOL = "run_commands";
const REWRITE_TIMEOUT_MS = 5_000;
// `rtk rewrite` exits 0 when a rewrite is allowed and 3 when it applies but
// the rule asks for confirmation. Cline has no ask semantics for a hook, so
// both rewrite; the tool's own approval policy still decides whether it runs.
const REWRITE_EXIT_CODES = new Set([0, 3]);

export function rewriteCommand(command, rtk = "rtk") {
	const env = { ...process.env };
	delete env.RTK_REWRITE_HOST;
	const result = spawnSync(rtk, ["rewrite", command], {
		encoding: "utf8",
		env,
		timeout: REWRITE_TIMEOUT_MS,
	});
	if (result.error || !REWRITE_EXIT_CODES.has(result.status)) {
		return undefined;
	}
	const rewritten = result.stdout.trim();
	return rewritten && rewritten !== command ? rewritten : undefined;
}

function rewriteShellCommands(commands, rewrite) {
	let changed = false;
	const rewritten = commands.map((command) => {
		const next = rewrite(command);
		if (next === undefined) {
			return command;
		}
		changed = true;
		return next;
	});
	return changed ? rewritten : undefined;
}

// Structured entries ({ command, args }) run an executable directly without a
// shell, so there is no command line for rtk to rewrite and they pass through.
export function rewriteRunCommandsInput(input, rewrite) {
	if (typeof input === "string") {
		return rewriteShellCommands([input], rewrite)?.[0];
	}
	if (Array.isArray(input)) {
		return input.every((entry) => typeof entry === "string")
			? rewriteShellCommands(input, rewrite)
			: undefined;
	}
	if (input && typeof input === "object" && "commands" in input) {
		const { commands } = input;
		if (typeof commands === "string") {
			const next = rewrite(commands);
			return next === undefined ? undefined : { ...input, commands: next };
		}
		if (
			Array.isArray(commands) &&
			commands.every((entry) => typeof entry === "string")
		) {
			const next = rewriteShellCommands(commands, rewrite);
			return next === undefined ? undefined : { ...input, commands: next };
		}
	}
	return undefined;
}

export function createRtkBeforeTool(rewrite) {
	return (context) => {
		if (context.tool.name !== RUN_COMMANDS_TOOL) {
			return undefined;
		}
		const input = rewriteRunCommandsInput(context.input, rewrite);
		return input === undefined ? undefined : { input };
	};
}

// The rewritten command runs in the agent's shell, so rtk has to resolve on
// that PATH. A copy only in the install directory would make every rewritten
// command fail, so the hook stays inert in that case.
function createPathRtkRewriter() {
	let rtkOnPath;
	return (command) => {
		if (rtkOnPath === undefined) {
			const probe = spawnSync("rtk", ["--version"], {
				encoding: "utf8",
				timeout: REWRITE_TIMEOUT_MS,
			});
			rtkOnPath = probe.status === 0 ? "rtk" : null;
		}
		return rtkOnPath ? rewriteCommand(command, rtkOnPath) : undefined;
	};
}

export default {
	name: "rtk",
	manifest: {
		capabilities: ["hooks"],
	},
	hooks: {
		beforeTool: createRtkBeforeTool(createPathRtkRewriter()),
	},
};

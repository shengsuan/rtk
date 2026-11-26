import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = "rtk-ai/rtk";
const FETCH_TIMEOUT_MS = 120_000;

function resolveTarget(platform, arch) {
	if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
	if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
	if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-musl";
	if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-musl";
	if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
	throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

async function fetchBuffer(url) {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`Failed to download ${url}: ${response.status} ${response.statusText}`.trim(),
		);
	}
	return Buffer.from(await response.arrayBuffer());
}

async function resolveVersion() {
	const pinned = process.env.RTK_VERSION?.trim();
	if (pinned) {
		return pinned;
	}
	const response = await fetch(`https://github.com/${REPO}/releases/latest`, {
		redirect: "follow",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const match = /\/releases\/tag\/([^/?#]+)/.exec(response.url);
	if (!match) {
		throw new Error(
			"Could not resolve the latest rtk release; set RTK_VERSION=vX.Y.Z",
		);
	}
	return decodeURIComponent(match[1]);
}

function parseChecksums(text) {
	const checksums = new Map();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
		if (match) {
			checksums.set(match[2], match[1].toLowerCase());
		}
	}
	return checksums;
}

function runVersion(binaryPath) {
	const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${binaryPath} was installed but does not run on this system: ${(result.stderr || result.error?.message || "").trim()}`,
		);
	}
	return result.stdout.trim();
}

function isOnPath(directory) {
	const target = resolve(directory);
	return (process.env.PATH ?? "")
		.split(delimiter)
		.some((entry) => entry && resolve(entry) === target);
}

async function main() {
	const target = resolveTarget(process.platform, process.arch);
	const isWindows = process.platform === "win32";
	const assetName = `rtk-${target}${isWindows ? ".exe" : ""}`;
	const installDir =
		process.env.RTK_INSTALL_DIR?.trim() || join(homedir(), ".local", "bin");

	const version = await resolveVersion();
	const releaseBase = `https://github.com/${REPO}/releases/download/${version}`;
	const checksums = parseChecksums(
		(await fetchBuffer(`${releaseBase}/checksums.txt`)).toString("utf8"),
	);
	const expectedSha256 = checksums.get(assetName);
	if (!expectedSha256) {
		throw new Error(`checksums.txt in ${version} has no entry for ${assetName}`);
	}

	const binaryBytes = await fetchBuffer(`${releaseBase}/${assetName}`);
	const actualSha256 = createHash("sha256").update(binaryBytes).digest("hex");
	if (actualSha256 !== expectedSha256) {
		throw new Error(
			`checksum mismatch for ${assetName}: expected ${expectedSha256}, got ${actualSha256}`,
		);
	}

	const binaryName = isWindows ? "rtk.exe" : "rtk";
	const workDir = mkdtempSync(join(tmpdir(), "rtk-cline-plugin-"));
	try {
		const downloadedBinary = join(workDir, binaryName);
		writeFileSync(downloadedBinary, binaryBytes);
		chmodSync(downloadedBinary, 0o755);

		mkdirSync(installDir, { recursive: true });
		const installedBinary = join(installDir, binaryName);
		copyFileSync(downloadedBinary, installedBinary);
		chmodSync(installedBinary, 0o755);

		const versionOutput = runVersion(installedBinary);
		console.log(`Installed rtk ${version} to ${installedBinary}`);
		console.log(`  ${versionOutput}`);
		if (!isOnPath(installDir)) {
			console.log(`Add ${installDir} to PATH to run "rtk" directly.`);
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`rtk install failed: ${error.message}`);
	process.exitCode = 1;
});

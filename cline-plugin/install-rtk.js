import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const REPO = "rtk-ai/rtk";
const FETCH_TIMEOUT_MS = 120_000;

function resolvePlatform(platform, arch) {
	if (platform === "darwin" && arch === "arm64") {
		return { target: "aarch64-apple-darwin", ext: "tar.gz" };
	}
	if (platform === "darwin" && arch === "x64") {
		return { target: "x86_64-apple-darwin", ext: "tar.gz" };
	}
	if (platform === "linux" && arch === "x64") {
		return { target: "x86_64-unknown-linux-musl", ext: "tar.gz" };
	}
	if (platform === "linux" && arch === "arm64") {
		return {
			target: "aarch64-unknown-linux-musl",
			fallbackTarget: "aarch64-unknown-linux-gnu",
			ext: "tar.gz",
		};
	}
	if (platform === "win32" && arch === "x64") {
		return { target: "x86_64-pc-windows-msvc", ext: "zip" };
	}
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

function selectAsset(checksums, edition, platform) {
	const targets = [platform.target, platform.fallbackTarget].filter(Boolean);
	for (const target of targets) {
		const name = `${edition}-${target}.${platform.ext}`;
		const sha256 = checksums.get(name);
		if (sha256) {
			return { name, sha256 };
		}
	}
	throw new Error(
		`checksums.txt has no ${edition} asset for ${platform.target}`,
	);
}

function assertSafeArchive(archivePath) {
	const listing = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8" });
	if (listing.status !== 0) {
		throw new Error(`Cannot list archive: ${listing.stderr.trim()}`);
	}
	for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
		const normalized = entry.replace(/\\/g, "/");
		if (
			normalized.startsWith("/") ||
			/^[A-Za-z]:/.test(normalized) ||
			normalized.split("/").includes("..")
		) {
			throw new Error(`Archive contains unsafe path: ${entry}`);
		}
	}
}

function extractArchive(archivePath, destination) {
	const result = spawnSync("tar", ["-xf", archivePath, "-C", destination], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`Failed to extract archive: ${result.stderr.trim()}`);
	}
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
	const platform = resolvePlatform(process.platform, process.arch);
	const edition = process.env.RTK_EDITION === "oss" ? "rtk-oss" : "rtk";
	const binaryName = process.platform === "win32" ? "rtk.exe" : "rtk";
	const installDir =
		process.env.RTK_INSTALL_DIR?.trim() || join(homedir(), ".local", "bin");

	const version = await resolveVersion();
	const releaseBase = `https://github.com/${REPO}/releases/download/${version}`;
	const checksums = parseChecksums(
		(await fetchBuffer(`${releaseBase}/checksums.txt`)).toString("utf8"),
	);
	const asset = selectAsset(checksums, edition, platform);
	const archiveBytes = await fetchBuffer(`${releaseBase}/${asset.name}`);

	const actualSha256 = createHash("sha256").update(archiveBytes).digest("hex");
	if (actualSha256 !== asset.sha256) {
		throw new Error(
			`checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actualSha256}`,
		);
	}

	const workDir = mkdtempSync(join(tmpdir(), "rtk-cline-plugin-"));
	try {
		const archivePath = join(workDir, asset.name);
		writeFileSync(archivePath, archiveBytes);
		assertSafeArchive(archivePath);

		const extractDir = join(workDir, "extract");
		mkdirSync(extractDir);
		extractArchive(archivePath, extractDir);

		const extractedBinary = join(extractDir, binaryName);
		if (!existsSync(extractedBinary)) {
			throw new Error(`${binaryName} not found in ${asset.name}`);
		}

		mkdirSync(installDir, { recursive: true });
		const installedBinary = join(installDir, binaryName);
		copyFileSync(extractedBinary, installedBinary);
		chmodSync(installedBinary, 0o755);

		const versionOutput = runVersion(installedBinary);
		console.log(`Installed ${edition} ${version} to ${installedBinary}`);
		console.log(`  ${versionOutput}`);
		if (!isOnPath(installDir)) {
			console.log(
				`Add ${installDir} to PATH to run "${binaryName.replace(".exe", "")}" directly.`,
			);
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`rtk install failed: ${error.message}`);
	process.exitCode = 1;
});

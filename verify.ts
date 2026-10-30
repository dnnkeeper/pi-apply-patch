/**
 * Post-write verification for `apply_patch`.
 *
 * A patch can prove that it matched; it cannot prove that a property now holds for the whole
 * project (a removed name no longer occurs anywhere, a heading survived a renumbering).
 * These checks run in the SAME tool call as the write, so the model does not spend a second
 * round-trip on the grep it would otherwise run by hand.
 *
 * Deliberately literal: needles are case-sensitive substrings matched per line. No regex, no
 * shell, no escaping problems.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ApplyPatchVerifyCheck = {
	mustContain?: string[] | undefined;
	mustNotContain?: string[] | undefined;
	path?: string | undefined;
};

export type ApplyPatchVerifyFailure = {
	kind: "mustContain" | "mustNotContain";
	needle: string;
	/** Project-relative path of the first offending (or missing) file, when there is one. */
	file?: string | undefined;
	/** First hit as `file:line`, or a reason such as `not found in 12 files`. */
	detail: string;
};

export type ApplyPatchVerification = {
	checks: number;
	scannedFiles: number;
	failures: ApplyPatchVerifyFailure[];
	warnings: string[];
};

const MAX_NEEDLES_PER_CHECK = 20;
const MAX_NEEDLE_LENGTH = 200;
const MAX_CHECKS = 20;
const MAX_SCANNED_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HITS_PER_NEEDLE = 3;
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);

/** Keep only well-formed checks; an unusable `verify` must never fail the patch. */
export function normalizeVerifyChecks(raw: unknown): ApplyPatchVerifyCheck[] | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	const entries = Array.isArray(raw) ? raw : [raw];
	const checks: ApplyPatchVerifyCheck[] = [];
	for (const entry of entries.slice(0, MAX_CHECKS)) {
		if (entry === null || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const check: ApplyPatchVerifyCheck = {};
		const mustContain = normalizeNeedles(record.mustContain);
		const mustNotContain = normalizeNeedles(record.mustNotContain);
		if (mustContain) {
			check.mustContain = mustContain;
		}
		if (mustNotContain) {
			check.mustNotContain = mustNotContain;
		}
		if (typeof record.path === "string" && record.path.trim().length > 0) {
			check.path = record.path.trim();
		}
		if (check.mustContain === undefined && check.mustNotContain === undefined) {
			continue;
		}
		checks.push(check);
	}
	return checks.length > 0 ? checks : undefined;
}

function normalizeNeedles(raw: unknown): string[] | undefined {
	// A bare string is the shape most models produce for a single needle: accept it, never reject it.
	const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const needles = values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.slice(0, MAX_NEEDLE_LENGTH))
		.filter((value) => value.length > 0)
		.slice(0, MAX_NEEDLES_PER_CHECK);
	return needles.length > 0 ? needles : undefined;
}

function toDisplayPath(cwd: string, absolutePath: string): string {
	const relative = path.relative(cwd, absolutePath);
	return (relative.length > 0 ? relative : path.basename(absolutePath)).split(path.sep).join("/");
}

function hasGlobChars(value: string): boolean {
	return value.includes("*") || value.includes("?");
}

/** Minimal glob: `**` spans directories, `*` and `?` stay inside one path segment. */
export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.split(path.sep).join("/");
	let source = "";
	for (let index = 0; index < normalized.length; index += 1) {
		const char = normalized[index] as string;
		if (char === "*") {
			if (normalized[index + 1] === "*") {
				index += 1;
				if (normalized[index + 1] === "/") {
					index += 1;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

async function walkFiles(root: string, budget: { remaining: number }, out: string[]): Promise<void> {
	if (budget.remaining <= 0) {
		return;
	}
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (budget.remaining <= 0) {
			return;
		}
		const absolutePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			if (WALK_SKIP_DIRS.has(entry.name)) {
				continue;
			}
			await walkFiles(absolutePath, budget, out);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		out.push(absolutePath);
		budget.remaining -= 1;
	}
}

/** Resolve one check's scope to a list of absolute file paths. */
async function resolveScope(
	cwd: string,
	requestedPath: string | undefined,
	changedFiles: string[],
	budget: { remaining: number },
	warnings: string[],
): Promise<string[]> {
	if (requestedPath === undefined) {
		// Default scope: the files this patch touched (never the whole tree — that would be noisy).
		const files: string[] = [];
		for (const filePath of [...new Set(changedFiles)]) {
			try {
				const info = await stat(filePath);
				if (info.isFile()) {
					files.push(filePath);
				}
			} catch {
				// Deleted by this patch (or never existed): nothing to assert against.
			}
		}
		return files;
	}

	const absolutePath = path.resolve(cwd, requestedPath);
	if (hasGlobChars(requestedPath)) {
		const displayPattern = requestedPath.split(path.sep).join("/");
		const staticPrefix = displayPattern.slice(0, displayPattern.search(/[*?]/));
		const slashIndex = staticPrefix.lastIndexOf("/");
		const baseRelative = slashIndex >= 0 ? staticPrefix.slice(0, slashIndex) : "";
		const base = path.resolve(cwd, baseRelative === "" ? "." : baseRelative);
		const matcher = globToRegExp(displayPattern);
		const candidates: string[] = [];
		await walkFiles(base, budget, candidates);
		const matched = candidates.filter((candidate) => matcher.test(toDisplayPath(cwd, candidate)));
		if (budget.remaining <= 0) {
			warnings.push(`scope '${displayPattern}' hit the ${MAX_SCANNED_FILES}-file scan limit; narrow the path.`);
		}
		return matched;
	}

	try {
		const info = await stat(absolutePath);
		if (info.isFile()) {
			return [absolutePath];
		}
		if (info.isDirectory()) {
			const files: string[] = [];
			await walkFiles(absolutePath, budget, files);
			if (budget.remaining <= 0) {
				warnings.push(`scope '${requestedPath}' hit the ${MAX_SCANNED_FILES}-file scan limit.`);
			}
			return files;
		}
	} catch {
		warnings.push(`scope '${requestedPath}' does not exist.`);
	}
	return [];
}

type ScannedFile = { absolutePath: string; display: string; lines: string[] | undefined };

async function readScannedFile(cwd: string, absolutePath: string): Promise<ScannedFile> {
	const display = toDisplayPath(cwd, absolutePath);
	try {
		const info = await stat(absolutePath);
		if (info.size > MAX_FILE_BYTES) {
			return { absolutePath, display, lines: undefined };
		}
		const text = await readFile(absolutePath, "utf-8");
		if (text.includes("\u0000")) {
			return { absolutePath, display, lines: undefined };
		}
		return { absolutePath, display, lines: text.split(/\r?\n/) };
	} catch {
		return { absolutePath, display, lines: undefined };
	}
}

/**
 * Run every check and report failures. `changedFiles` are absolute paths of files this patch
 * wrote, and are the default scope when a check omits `path`.
 */
export async function runVerifications(
	cwd: string,
	checks: ApplyPatchVerifyCheck[],
	changedFiles: string[],
): Promise<ApplyPatchVerification> {
	const failures: ApplyPatchVerifyFailure[] = [];
	const warnings: string[] = [];
	const budget = { remaining: MAX_SCANNED_FILES };
	const scanned = new Map<string, ScannedFile>();

	for (const check of checks) {
		const scope = await resolveScope(cwd, check.path, changedFiles, budget, warnings);
		for (const absolutePath of scope) {
			if (!scanned.has(absolutePath)) {
				scanned.set(absolutePath, await readScannedFile(cwd, absolutePath));
			}
		}
		const files = scope
			.map((absolutePath) => scanned.get(absolutePath))
			.filter((file): file is ScannedFile => file !== undefined && file.lines !== undefined);

		for (const needle of check.mustContain ?? []) {
			const hits = collectHits(files, needle);
			if (hits.length === 0) {
				failures.push({
					kind: "mustContain",
					needle,
					detail: scope.length === 0 ? "empty scope — nothing was scanned" : `not found in ${files.length} scanned file(s)`,
				});
			}
		}
		for (const needle of check.mustNotContain ?? []) {
			const hits = collectHits(files, needle);
			if (hits.length > 0) {
				failures.push({
					kind: "mustNotContain",
					needle,
					file: hits[0]?.display,
					detail: hits.map((hit) => hit.display + ":" + hit.line).join(", "),
				});
			}
		}
	}

	return { checks: checks.length, scannedFiles: scanned.size, failures, warnings };
}

function collectHits(files: ScannedFile[], needle: string): { display: string; line: number }[] {
	const hits: { display: string; line: number }[] = [];
	for (const file of files) {
		const lines = file.lines ?? [];
		for (let index = 0; index < lines.length; index += 1) {
			if ((lines[index] as string).includes(needle)) {
				hits.push({ display: file.display, line: index + 1 });
				if (hits.length >= MAX_HITS_PER_NEEDLE) {
					return hits;
				}
			}
		}
	}
	return hits;
}

/** One compact verdict block: the first line is machine-stable. */
export function formatVerification(verification: ApplyPatchVerification): string[] {
	const { checks, scannedFiles, failures, warnings } = verification;
	if (failures.length === 0) {
		return [`VERIFY_OK checks=${checks} files=${scannedFiles}`, ...warnings.map((warning) => `note: ${warning}`)];
	}
	const lines = [`VERIFY_FAIL ${failures.length} of ${checks} check(s) — patch applied, invariant does not hold`];
	for (const failure of failures) {
		const verdict = failure.kind === "mustNotContain" ? "still present" : "missing";
		lines.push(`- ${failure.kind} "${failure.needle}" ${verdict}: ${failure.detail}`);
	}
	lines.push(
		"Fix the file(s) above with another apply_patch call (no re-read needed: the hits give file:line), or drop the check if the invariant was wrong.",
	);
	for (const warning of warnings) {
		lines.push(`note: ${warning}`);
	}
	return lines;
}

/**
 * A `verify` argument that normalizes to nothing (no needles, or only a `path`) must never pass as
 * silence: the caller asked for a check and got none, so say so instead of reporting a clean patch.
 */
export const IGNORED_VERIFY_LINE =
	"VERIFY_SKIPPED — verify was sent but had no mustContain/mustNotContain needles, so NOTHING was checked (this is not a pass). " +
	"Resend with needles, e.g. verify=[{\"path\": \"**/*.md\", \"mustNotContain\": [\"<text that must be gone>\"]}], " +
	"or drop verify and verify some other way.";

/**
 * Compose the final result lines for a patch that wrote every hunk, running the `verify`
 * assertions in this same call. A failed assertion sets `isError` but never rolls the write
 * back — the change is on disk and the message says how to fix it.
 */
export async function finalizeSuccessfulPatch(
	cwd: string,
	result: { summaries: string[]; appliedFiles: string[]; failures?: unknown[] | undefined },
	verifyChecks: ApplyPatchVerifyCheck[] | undefined,
	extraLines: string[] = [],
): Promise<{ lines: string[]; isError: boolean; verification?: ApplyPatchVerification | undefined }> {
	const baseLines = [...result.summaries, ...extraLines];
	// A patch that did not fully apply has no invariant to assert yet: its own error is the report.
	if (verifyChecks === undefined || verifyChecks.length === 0 || (result.failures?.length ?? 0) > 0) {
		return { lines: baseLines, isError: false };
	}
	const changedFiles = result.appliedFiles.map((filePath) => path.resolve(cwd, filePath));
	const verification = await runVerifications(cwd, verifyChecks, changedFiles);
	return {
		lines: [...baseLines, ...formatVerification(verification)],
		isError: verification.failures.length > 0,
		verification,
	};
}

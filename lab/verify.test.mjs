// Verify-check tests for apply_patch's `verify` argument.
// Run: node lab/verify.test.mjs   (Node 22+/26 executes the .ts module directly)
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatVerification, IGNORED_VERIFY_LINE, normalizeVerifyChecks, runVerifications } from "../verify.ts";

const ROOT = path.resolve(import.meta.dirname, ".labv");
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) {
		pass += 1;
		console.log(`PASS ${name}`);
	} else {
		fail += 1;
		console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
};

const file = async (relative, content) => {
	const absolute = path.join(ROOT, relative);
	await mkdir(path.dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
	return absolute;
};

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });

// Fixture: two markdown files and one nested one.
const agents = await file("project/AGENTS.md", "# Guide\nWork mode is FAST.\nEvidence ring.\n");
const readme = await file("README.md", "# Kit\nMentions Work mode twice: Work mode.\n");
const nested = await file("project/.ai_memory/notes.md", "no modes here\n");
await file("project/binary.png", "\u0000\u0001binary");
const deletedByPatch = path.join(ROOT, "gone.md");

// 1. default scope = files the patch wrote; a stale needle elsewhere must NOT fail it.
{
	const result = await runVerifications(ROOT, normalizeVerifyChecks([{ mustContain: ["Evidence ring"] }]) ?? [], [agents]);
	check("default scope passes on containing file", result.failures.length === 0, JSON.stringify(result.failures));
	check("default scope scanned exactly the changed file", result.scannedFiles === 1, String(result.scannedFiles));
	check("ok verdict is machine-stable", formatVerification(result)[0] === "VERIFY_OK checks=1 files=1", formatVerification(result)[0]);
}

// 2. mustNotContain in default scope catches the leftover inside the same file.
{
	const result = await runVerifications(ROOT, normalizeVerifyChecks([{ mustNotContain: ["Work mode"] }]) ?? [], [agents]);
	check("mustNotContain fails in default scope", result.failures.length === 1, JSON.stringify(result.failures));
	check("failure carries file:line", /project\/AGENTS\.md:2/.test(result.failures[0]?.detail ?? ""), result.failures[0]?.detail);
	const lines = formatVerification(result);
	check("fail verdict is machine-stable", lines[0].startsWith("VERIFY_FAIL 1 of 1"), lines[0]);
	check("fail verdict names the needle", lines[1]?.includes('"Work mode"'), lines[1]);
}

// 3. glob scope spans nested dirs and finds the other file too.
{
	const result = await runVerifications(ROOT, normalizeVerifyChecks([{ path: "**/*.md", mustNotContain: ["Work mode"] }]) ?? [], []);
	check("glob scope collects both offending files", result.failures.length === 1, JSON.stringify(result.failures));
	check("glob scope scans 3 markdown files", result.scannedFiles === 3, String(result.scannedFiles));
	check("glob reports up to 3 hits", (result.failures[0]?.detail.match(/:(\d+)/g)?.length ?? 0) >= 2, result.failures[0]?.detail);
}

// 4. directory scope.
{
	const result = await runVerifications(ROOT, normalizeVerifyChecks([{ path: "project", mustContain: ["no modes here"] }]) ?? [], []);
	check("directory scope recurses", result.failures.length === 0, JSON.stringify(result.failures));
	check("directory scope skipped the binary", result.scannedFiles === 3, String(result.scannedFiles));
}

// 5. missing needle → failure with a useful detail.
{
	const result = await runVerifications(ROOT, normalizeVerifyChecks([{ path: "project/AGENTS.md", mustContain: ["Standard ring"] }]) ?? [], []);
	check("mustContain miss fails", result.failures.length === 1, JSON.stringify(result.failures));
	check("miss detail counts scanned files", /not found in 1 scanned file/.test(result.failures[0]?.detail ?? ""), result.failures[0]?.detail);
}

// 6. empty scope (file deleted by the patch) is a warning, not a crash.
{
	const result = await runVerifications(ROOT, normalizeVerifyChecks([{ path: "does-not-exist.md", mustContain: ["x"] }]) ?? [], [deletedByPatch]);
	check("missing scope warns instead of throwing", result.warnings.length === 1, JSON.stringify(result.warnings));
	check("missing scope still reports the miss", result.failures.length === 1, JSON.stringify(result.failures));
	check("warnings ride along on the verdict", formatVerification(result).some((line) => line.startsWith("note:")), "no note line");
}

// 7. normalizeVerifyChecks is defensive: junk never fails a patch.
{
	check("undefined stays undefined", normalizeVerifyChecks(undefined) === undefined);
	check("empty array stays undefined", normalizeVerifyChecks([]) === undefined);
	check("non-string needles dropped", normalizeVerifyChecks([{ mustContain: [1, null, "ok"] }])?.[0]?.mustContain?.length === 1);
	check("a bare string needle is accepted", normalizeVerifyChecks([{ mustNotContain: "Old" }])?.[0]?.mustNotContain?.[0] === "Old");
	check("bare-string path-only still means no checks", normalizeVerifyChecks([{ path: "**/*.md", mustContain: "" }]) === undefined);
	check("junk object yields undefined", normalizeVerifyChecks([{ path: "x" }, 42, null]) === undefined);
	check("single object accepted", normalizeVerifyChecks({ mustNotContain: ["a"] })?.length === 1);
	const long = normalizeVerifyChecks([{ mustNotContain: ["y".repeat(500)] }]);
	check("needle truncated to 200", long?.[0]?.mustNotContain?.[0]?.length === 200, String(long?.[0]?.mustNotContain?.[0]?.length));
}

// 8. a verify argument without needles must not pass silently.
{
	const normalized = normalizeVerifyChecks([{ path: "**/*.md" }]);
	check("path-only verify normalizes to undefined", normalized === undefined);
	check("skipped-verify line exists and is machine-stable", IGNORED_VERIFY_LINE.startsWith("VERIFY_SKIPPED"));
	check("skipped-verify says it is not a pass", /this is not a pass/.test(IGNORED_VERIFY_LINE));
	check("skipped-verify shows a retry shape", /Resend with needles/.test(IGNORED_VERIFY_LINE));
}

// 9. two checks in one call, mixed verdicts.
{
	const result = await runVerifications(
		ROOT,
		normalizeVerifyChecks([
			{ path: "project/AGENTS.md", mustContain: ["Evidence ring"] },
			{ path: "project/AGENTS.md", mustNotContain: ["FAST"] },
		]) ?? [],
		[],
	);
	check("mixed checks report only the failure", result.failures.length === 1 && result.checks === 2, JSON.stringify(result.failures));
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// Verify the remaining prose claims that the description makes about behaviour.
import { createJiti } from "jiti";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { applyPatchDetailed } = await jiti.import("../index.ts");
const { normalizeVerifyChecks, finalizeSuccessfulPatch } = await jiti.import("../verify.ts");
const ROOT = path.resolve(import.meta.dirname, ".labc");
let pass = 0, fail = 0;
const check = (n, ok, x = "") => { pass += ok ? 1 : 0; fail += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok || !x ? "" : ` — ${x}`}`); };
const P = (b) => `*** Begin Patch\n${b}\n*** End Patch`;
await rm(ROOT, { recursive: true, force: true }); await mkdir(ROOT, { recursive: true });

// Claim: "Delete File now + Add File in a later call" is the whole-file rewrite route.
await writeFile(path.join(ROOT, "w.txt"), "old body\n");
const sameCall = await applyPatchDetailed(ROOT, P("*** Delete File: w.txt\n*** Add File: w.txt\n+new body"));
check("delete+add in ONE call is rejected (all-or-nothing dry run)", sameCall.failures.length === 1, JSON.stringify(sameCall.failures));
check("nothing was written by the rejected patch", (await readFile(path.join(ROOT, "w.txt"), "utf-8")) === "old body\n");
await applyPatchDetailed(ROOT, P("*** Delete File: w.txt"));
const second = await applyPatchDetailed(ROOT, P("*** Add File: w.txt\n+new body"));
check("delete then add in a LATER call works", second.failures.length === 0, JSON.stringify(second.failures));
check("content replaced", (await readFile(path.join(ROOT, "w.txt"), "utf-8")) === "new body\n");

// Claim: a whole-file rewrite via Update File with the entire old content as '-' lines.
await writeFile(path.join(ROOT, "u.txt"), "a\nb\n");
const rewrite = await applyPatchDetailed(ROOT, P("*** Update File: u.txt\n@@\n-a\n-b\n+x\n+y\n"));
check("Update File rewrite works", rewrite.failures.length === 0, JSON.stringify(rewrite.failures));

// Claim: "@@ <text>" anchors on text that exists; a made-up hint fails.
await writeFile(path.join(ROOT, "h.txt"), "alpha\nneedle\nalpha\n");
const badHint = await applyPatchDetailed(ROOT, P("*** Update File: h.txt\n@@ not_a_real_line\n-alpha\n+ALPHA\n"));
check("a non-existent @@ anchor is rejected", badHint.failures.length === 1 && /Failed to find context/.test(badHint.failures[0].message), JSON.stringify(badHint.failures));
const goodHint = await applyPatchDetailed(ROOT, P("*** Update File: h.txt\n@@ needle\n-alpha\n+ALPHA\n"));
check("an existing @@ anchor is accepted", goodHint.failures.length === 0, JSON.stringify(goodHint.failures));
// Claim: "@@ <text>" must exist, but does NOT steer placement — the removal lines decide that.
check("@@ anchor does not move the edit (removal lines decide)", (await readFile(path.join(ROOT, "h.txt"), "utf-8")) === "ALPHA\nneedle\nalpha\n");

// Claim: verify is skipped when the patch itself failed.
const failed = await applyPatchDetailed(ROOT, P("*** Update File: h.txt\n@@\n-nope\n+nope2"));
const withVerify = await finalizeSuccessfulPatch(ROOT, failed, normalizeVerifyChecks([{ mustContain: ["never"] }]), []);
check("failed patch: verify is not consulted", !withVerify.isError && !withVerify.lines.some((l) => l.startsWith("VERIFY")), withVerify.lines.join(" | "));

// Claim: a bare-string needle (what a small model emits) really checks something.
{
	await writeFile(path.join(ROOT, "s.md"), "OldName stays\n");
	const chk = normalizeVerifyChecks([{ path: "s.md", mustNotContain: "OldName" }]);
	const res = await finalizeSuccessfulPatch(ROOT, { summaries: [], appliedFiles: [], failures: [] }, chk, []);
	check("bare-string needle detects a violation", res.isError && /still present/.test(res.lines.join(" ")), res.lines.join(" | "));
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

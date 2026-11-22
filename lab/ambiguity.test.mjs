// Ambiguous-anchor policy: reject by default (nothing is written), opt-in first-match, and the
// config file keeps unknown keys. Run: node lab/ambiguity.test.mjs
import { createJiti } from "jiti";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
	applyPatchDetailed,
	createApplyPatchTool,
	readApplyPatchAmbiguity,
	readApplyPatchToolset,
	writeApplyPatchConfig,
	writeApplyPatchToolset,
} = await jiti.import("../index.ts");

const ROOT = path.resolve(import.meta.dirname, ".laba");
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	pass += ok ? 1 : 0;
	fail += ok ? 0 : 1;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};
const P = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
const read = (name) => readFile(path.join(ROOT, name), "utf-8");

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });

const ambiguousPatch = P("*** Update File: dup.txt\n@@\n-mark\n+MARK");

// 1. Default: ambiguous anchor rejects the whole patch before writing.
await writeFile(path.join(ROOT, "dup.txt"), "mark\na\nmark\nb\n");
const rejected = await applyPatchDetailed(ROOT, ambiguousPatch);
check("default rejects ambiguity", rejected.failures.length === 1, JSON.stringify(rejected.failures));
check("nothing is written", (await read("dup.txt")) === "mark\na\nmark\nb\n", await read("dup.txt"));
check("failure says ambiguous", /Ambiguous anchor/.test(rejected.failures[0]?.message ?? ""), rejected.failures[0]?.message);
check("failure lists both line numbers", /lines 1, 3/.test(rejected.failures[0]?.message ?? ""), rejected.failures[0]?.message);
check("failure says nothing was written", /nothing was written/.test(rejected.failures[0]?.message ?? ""), rejected.failures[0]?.message);
check("rejection is not a partial success", rejected.hasPartialSuccess === false);

// 2. Opt-in: first-match applies and warns.
await writeFile(path.join(ROOT, "dup.txt"), "mark\na\nmark\nb\n");
const first = await applyPatchDetailed(ROOT, ambiguousPatch, undefined, { rejectAmbiguous: false });
check("ambiguous=first applies", first.failures.length === 0, JSON.stringify(first.failures));
check("ambiguous=first edits the first occurrence", (await read("dup.txt")) === "MARK\na\nmark\nb\n", await read("dup.txt"));
check("ambiguous=first warns", /matched 2 places/.test(first.details.warnings.join("\n")), first.details.warnings.join(" | "));

// 3. All-or-nothing still holds: an ambiguous hunk rejects the whole multi-file patch.
await writeFile(path.join(ROOT, "safe.txt"), "safe\n");
await writeFile(path.join(ROOT, "dup.txt"), "mark\na\nmark\nb\n");
const mixed = await applyPatchDetailed(
	ROOT,
	P("*** Update File: safe.txt\n@@\n-safe\n+SAFE\n*** Update File: dup.txt\n@@\n-mark\n+MARK"),
);
check("ambiguous hunk fails the whole patch", mixed.failures.length === 1, JSON.stringify(mixed.failures));
check("earlier file was not written", (await read("safe.txt")) === "safe\n", await read("safe.txt"));

// 4. '*** End of File' is an explicit last-occurrence choice, not an ambiguity.
await writeFile(path.join(ROOT, "tail.txt"), "mark\na\nmark\n");
const eof = await applyPatchDetailed(ROOT, P("*** Update File: tail.txt\n@@\n-mark\n+LAST\n*** End of File"));
check("*** End of File may match a duplicated pattern", eof.failures.length === 0, JSON.stringify(eof.failures));
check("*** End of File edits the last occurrence", (await read("tail.txt")) === "mark\na\nLAST\n", await read("tail.txt"));

// 5. Unique anchors are unaffected.
await writeFile(path.join(ROOT, "unique.txt"), "one\ntwo\nthree\n");
const unique = await applyPatchDetailed(ROOT, P("*** Update File: unique.txt\n@@\n-one\n two\n+ONE"));
check("unique anchor applies", unique.failures.length === 0, JSON.stringify(unique.failures));

// 6. Config: default reject, explicit values, and unrelated keys survive a write.
const configDir = path.join(ROOT, "agent");
process.env.PI_CODING_AGENT_DIR = configDir;
await mkdir(configDir, { recursive: true });
check("config default is reject", (await readApplyPatchAmbiguity()) === "reject");
check("config default toolset is additive", (await readApplyPatchToolset()) === "additive");

await writeApplyPatchConfig({ ambiguous: "first", customKey: 42 });
check("ambiguous=first is read back", (await readApplyPatchAmbiguity()) === "first");
await writeApplyPatchToolset("replace");
const raw = JSON.parse(await readFile(path.join(configDir, "apply-patch.json"), "utf-8"));
check("writing the toolset preserves ambiguity", raw.ambiguous === "first", JSON.stringify(raw));
check("writing the toolset preserves unknown keys", raw.customKey === 42, JSON.stringify(raw));
check("toolset is read back", (await readApplyPatchToolset()) === "replace");

await writeFile(path.join(configDir, "apply-patch.json"), "{not json");
check("malformed config falls back to reject", (await readApplyPatchAmbiguity()) === "reject");
check("malformed config falls back to additive", (await readApplyPatchToolset()) === "additive");

// 7. The tool call itself honours the config, not just the direct API.
await rm(path.join(configDir, "apply-patch.json"), { force: true });
await writeFile(path.join(ROOT, "live.txt"), "mark\na\nmark\n");
const tool = createApplyPatchTool();
const rejectedCall = await tool.execute(
	"call-1",
	{ input: P("*** Update File: live.txt\n@@\n-mark\n+MARK") },
	undefined,
	undefined,
	{ cwd: ROOT },
);
check("execute rejects an ambiguous patch under the default", rejectedCall.isError === true, JSON.stringify(rejectedCall.content));
check("execute did not write", (await read("live.txt")) === "mark\na\nmark\n", await read("live.txt"));

await writeApplyPatchConfig({ ambiguous: "first" });
const firstCall = await tool.execute(
	"call-2",
	{ input: P("*** Update File: live.txt\n@@\n-mark\n+MARK") },
	undefined,
	undefined,
	{ cwd: ROOT },
);
check("execute applies under ambiguous=first", firstCall.isError !== true, JSON.stringify(firstCall.content));
check("execute wrote the first occurrence", (await read("live.txt")) === "MARK\na\nmark\n", await read("live.txt"));

await rm(ROOT, { recursive: true, force: true });
delete process.env.PI_CODING_AGENT_DIR;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

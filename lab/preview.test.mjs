// Diff-preview bounds: a large file must not turn a one-line edit into a whole-file preview, and
// add/delete of a huge file must be capped. Run: node lab/preview.test.mjs
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	alias: { "@earendil-works/pi-tui": path.resolve(import.meta.dirname, "pi-tui-mock.mjs") },
});
const { createApplyPatchTool } = await jiti.import("../index.ts");

const ANSI = {
	accent: "\x1b[35m",
	error: "\x1b[91m",
	muted: "\x1b[90m",
	toolDiffAdded: "\x1b[32m",
	toolDiffContext: "\x1b[90m",
	toolDiffRemoved: "\x1b[31m",
	toolOutput: "\x1b[37m",
	toolTitle: "\x1b[97m",
	warning: "\x1b[33m",
};
const theme = {
	fg: (name, text) => `${ANSI[name] ?? ""}${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	inverse: (text) => `\x1b[7m${text}\x1b[27m`,
};

const ROOT = path.resolve(import.meta.dirname, ".labp");
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	pass += ok ? 1 : 0;
	fail += ok ? 0 : 1;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};
const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
const tool = createApplyPatchTool();
const execute = (input) => tool.execute("preview", { input }, undefined, undefined, { cwd: ROOT });
const previewOf = (result) => result.details?.preview?.files?.[0];
const render = (result, expanded = true) =>
	tool
		.renderResult(result, { expanded, isPartial: false }, theme, { cwd: ROOT })
		.render(160)
		.map(strip);

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
const big = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`);
await writeFile(path.join(ROOT, "big.txt"), `${big.join("\n")}\n`);

// 1. A one-line edit deep in a large file: compact hunked preview that contains the edit.
{
	const result = await execute("*** Begin Patch\n*** Update File: big.txt\n@@\n-line 4000\n+LINE FOUR THOUSAND\n*** End Patch");
	const preview = previewOf(result);
	const lines = preview?.diff.split("\n") ?? [];
	check("large-file update: preview is small", lines.length <= 20, String(lines.length));
	check("large-file update: added/removed counts stay exact", preview?.added === 1 && preview?.removed === 1, JSON.stringify(preview));
	check("large-file update: the edit is in the preview", preview?.diff.includes("LINE FOUR THOUSAND"), preview?.diff);
	check("large-file update: only 3 lines of context follow", preview?.diff.includes("line 4003") && !preview?.diff.includes("line 4004"), preview?.diff);
	const rows = render(result);
	check("expanded render shows the edit", rows.some((row) => row.includes("LINE FOUR THOUSAND")), rows.join("\n"));
	check("expanded render is not truncated", !rows.some((row) => row.includes("diff truncated")), rows.join("\n"));
}

// 2. Delete of a huge file: the preview is capped, counts are exact, the omission marker explains it.
{
	const result = await execute("*** Begin Patch\n*** Delete File: big.txt\n*** End Patch");
	const preview = previewOf(result);
	const lines = preview?.diff.split("\n") ?? [];
	check("large delete: counts are exact", preview?.added === 0 && preview?.removed === 5000, JSON.stringify(preview));
	check("large delete: preview is capped", lines.length <= 400, String(lines.length));
	check("large delete: omission marker present", /^… \d+ more diff line\(s\)$/.test(lines[lines.length - 1] ?? ""), lines.at(-1));
	const expanded = render(result);
	check("large delete: expanded render does not add a second truncation hint", !expanded.some((row) => row.includes("diff truncated")), expanded.join("\n"));
	check("large delete: stored omission marker is visible", expanded.some((row) => /more diff line\(s\)/.test(row)), expanded.join("\n"));
}

// 3. Add of a huge file is capped the same way.
{
	const body = big.map((line) => `+${line}`).join("\n");
	const result = await execute(`*** Begin Patch\n*** Add File: huge.txt\n${body}\n*** End Patch`);
	const preview = previewOf(result);
	check("large add: counts are exact", preview?.added === 5000 && preview?.removed === 0, JSON.stringify(preview));
	check("large add: preview is capped", (preview?.diff.split("\n").length ?? 0) <= 400, String(preview?.diff.split("\n").length));
}

// 4. A no-op patch must not preview the whole file as context.
{
	await writeFile(path.join(ROOT, "same.txt"), "same\n");
	const result = await execute("*** Begin Patch\n*** Update File: same.txt\n@@\n-same\n+same\n*** End Patch");
	check(
		"no-op: no whole-file preview",
		previewOf(result) === undefined || previewOf(result)?.diff === "",
		JSON.stringify(previewOf(result)?.diff),
	);
}

// 5. A minified single-line file cannot blow up one preview line.
{
	const longLine = "x".repeat(2000);
	await writeFile(path.join(ROOT, "min.js"), `${longLine}\n`);
	const result = await execute(`*** Begin Patch\n*** Update File: min.js\n@@\n-${longLine}\n+short\n*** End Patch`);
	const first = previewOf(result)?.diff.split("\n")[0] ?? "";
	check("long line is truncated", first.length <= 520, String(first.length));
	check("long line keeps the diff sign and number", /^[-+ ]\s*\d+ /.test(first), JSON.stringify(first));
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

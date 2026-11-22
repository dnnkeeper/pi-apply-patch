// TUI renderer checks: changed lines keep the diff colors, collapsed vs expanded differ, and
// failures are visible instead of being swallowed by the diff preview.
// Run: node lab/render.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	alias: {
		"@earendil-works/pi-tui": path.resolve(import.meta.dirname, "pi-tui-mock.mjs"),
	},
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

const GREEN = ANSI.toolDiffAdded;
const RED = ANSI.toolDiffRemoved;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	pass += ok ? 1 : 0;
	fail += ok ? 0 : 1;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function diffLine(sign, number, text) {
	return `${sign}${String(number).padStart(3, " ")} ${text}`;
}

function previewFile(filePath, lines, { operation = "update", movePath } = {}) {
	const added = lines.filter((line) => line.startsWith("+")).length;
	const removed = lines.filter((line) => line.startsWith("-")).length;
	return {
		filePath,
		operation,
		...(movePath ? { movePath } : {}),
		diff: lines.join("\n"),
		added,
		removed,
	};
}

function patchResult({ appliedFiles = [], failures = [], warnings = [], noOps = [] } = {}) {
	return {
		summaries: appliedFiles.map((filePath) => `update: ${filePath}`),
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: {
			mustReadFiles: failures.filter((failure) => failure.code === undefined).map((failure) => failure.filePath),
			mustNotReadFiles: [],
			failedFiles: failures.map((failure) => failure.filePath),
			warnings,
			noOps,
		},
		details: { fuzz: 0, warnings, noOps },
	};
}

function render(details, { content = "", expanded = true, isPartial = false } = {}) {
	const tool = createApplyPatchTool();
	const result = {
		content: content ? [{ type: "text", text: content }] : [{ type: "text", text: "update: src/a.ts" }],
		details,
	};
	const component = tool.renderResult(result, { expanded, isPartial }, theme, { cwd: "C:/proj" });
	return component
		.render(200)
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n");
}

const smallDiff = [
	diffLine(" ", 1, "const keep = true;"),
	diffLine("-", 2, "const value = oldName;"),
	diffLine("+", 2, "const value = newName;"),
	diffLine(" ", 3, "return value;"),
];
const smallPreview = {
	files: [previewFile("src/a.ts", smallDiff)],
	added: 1,
	removed: 1,
};

// 1. Changed lines carry the diff color on their content, not just on the sign.
{
	const out = render({
		preview: smallPreview,
		result: patchResult({ appliedFiles: ["src/a.ts"] }),
	});
	check("added content is green", new RegExp(`${escapeRe(GREEN)}const value = `).test(out), out);
	check("removed content is red", new RegExp(`${escapeRe(RED)}const value = `).test(out), out);
	check("intra-line change stays highlighted", out.includes("\x1b[7mnewName\x1b[27m") || out.includes("\x1b[7moldName\x1b[27m"), out);
	check("title is the applied state", out.includes("Applied patch"), out);
	check("file header names the path", out.includes("src/a.ts"), out);
}

// 2. Collapsed shows a window and a hint; expanded shows the rest.
{
	const lines = [diffLine(" ", 1, "context")];
	for (let index = 0; index < 30; index++) {
		lines.push(diffLine("+", index + 2, `added line ${index}`));
	}
	const preview = { files: [previewFile("src/long.ts", lines)], added: 30, removed: 0 };
	const details = { preview, result: patchResult({ appliedFiles: ["src/long.ts"] }) };
	const collapsed = render(details, { expanded: false });
	const expanded = render(details, { expanded: true });
	check("collapsed window mentions hidden lines", collapsed.includes("more line(s) — expand to view"), collapsed);
	check("collapsed hides the tail", !collapsed.includes("added line 29"), collapsed);
	check("expanded shows the tail", expanded.includes("added line 29"), expanded);
	check("expanded hides no lines", !expanded.includes("more line(s)"), expanded);
}

// 3. A failed patch with nothing written shows the error, not a misleading diff.
{
	const out = render(
		{
			preview: smallPreview,
			result: patchResult({
				failures: [{ filePath: "src/a.ts", operation: "update", message: "Failed to find expected lines" }],
			}),
		},
		{ content: "apply_patch failed.\nFailed:\n- src/a.ts (update): Failed to find expected lines", expanded: false },
	);
	check("failure title", out.includes("Patch failed"), out);
	check("failure reason is visible", out.includes("Failed to find expected lines"), out);
	check("failure does not print the intended diff", !out.includes("newName"), out);
	const redError = out.includes(`${ANSI.error}apply_patch failed.`);
	check("failure text is red", redError, out);
}

// 4. Partial success shows the applied file only.
{
	const first = previewFile("src/a.ts", smallDiff);
	const second = previewFile("src/b.ts", [diffLine("+", 1, "b-only-unique-token"), diffLine("-", 1, "b-old")]);
	const out = render(
		{
			preview: { files: [first, second], added: 2, removed: 2 },
			result: patchResult({
				appliedFiles: ["src/a.ts"],
				failures: [{ filePath: "src/b.ts", operation: "update", message: "b failed" }],
			}),
		},
		{ content: "apply_patch partially failed.\n- src/b.ts (update): b failed" },
	);
	check("partial title", out.includes("Patch partially failed"), out);
	check("applied file diff is shown", out.includes("newName"), out);
	check("failed file diff is not shown", !out.includes("b-only-unique-token"), out);
	check("failure reason is still shown", out.includes("b failed"), out);
}

// 5. Verification failure keeps the diff and shows the verdict.
{
	const out = render(
		{
			preview: smallPreview,
			result: patchResult({ appliedFiles: ["src/a.ts"] }),
			verification: {
				checks: 1,
				scannedFiles: 2,
				failures: [{ kind: "mustNotContain", needle: "oldName", file: "src/b.ts", detail: "src/b.ts:2" }],
				warnings: [],
			},
		},
		{ content: 'VERIFY_FAIL 1 of 1 check(s)\n- mustNotContain "oldName" still present: src/b.ts:2' },
	);
	check("verify failure title", out.includes("verification failed"), out);
	check("verify failure keeps the diff", out.includes("newName"), out);
	check("verify failure reason is visible", out.includes("still present: src/b.ts:2"), out);
}

// 6. Success notices (ambiguity, no-op, verify pass) are visible below the diff.
{
	const out = render({
		preview: smallPreview,
		result: patchResult({
			appliedFiles: ["src/a.ts"],
			warnings: ["src/a.ts: pattern matched 2 places, applied at the first (line 4)."],
			noOps: ["src/a.ts"],
		}),
		verification: { checks: 1, scannedFiles: 3, failures: [], warnings: [] },
	});
	check("ambiguity warning is visible", out.includes("pattern matched 2 places"), out);
	check("ambiguity warning is yellow", out.includes(`${ANSI.warning}src/a.ts: pattern matched`), out);
	check("no-op notice is visible", out.includes("No-op for: src/a.ts"), out);
	check("verify pass is visible", out.includes("VERIFY_OK checks=1 files=3"), out);
}

// 7. No preview at all: fall back to the result text.
{
	const out = render({ result: patchResult({ appliedFiles: ["src/a.ts"] }) }, { content: "update: src/a.ts" });
	check("fallback keeps the summary", out.includes("update: src/a.ts"), out);
}

// 8. A no-op hunk has a context-only diff; do not dump the file as "changes".
{
	const preview = {
		files: [previewFile("src/same.ts", [diffLine(" ", 1, "unchanged-body-token"), diffLine(" ", 2, "also unchanged")])],
		added: 0,
		removed: 0,
	};
	const out = render({ preview, result: patchResult({ appliedFiles: ["src/same.ts"], noOps: ["src/same.ts"] }) });
	check("no-op header says nothing changed", out.includes("no line changes"), out);
	check("no-op diff body is suppressed", !out.includes("unchanged-body-token"), out);
	check("no-op notice is visible", out.includes("No-op for: src/same.ts"), out);
}

// 9. An ambiguous rejection gets its own title and does not show the intended diff.
{
	const out = render(
		{
			preview: smallPreview,
			result: patchResult({
				failures: [
					{
						filePath: "src/a.ts",
						operation: "update",
						message: "Ambiguous anchor in src/a.ts: the 1-line hunk matches 2 places (lines 2, 5), so nothing was written.",
					},
				],
			}),
		},
		{
			content:
				"apply_patch failed.\nFailed:\n- src/a.ts (update): Ambiguous anchor in src/a.ts: the 1-line hunk matches 2 places (lines 2, 5), so nothing was written.",
		},
	);
	check("ambiguous rejection title", out.includes("Patch rejected · ambiguous anchor"), out);
	check("ambiguous rejection hides the diff", !out.includes("newName"), out);
	check("ambiguous rejection shows why", out.includes("matches 2 places"), out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

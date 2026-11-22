import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	getLanguageFromPath,
	highlightCode,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { Type } from "typebox";
import { type ContextLineIndex, type LineReplacement, replacementsAroundContext, SourceText } from "./line-endings.js";
import {
	type ApplyPatchVerification,
	type ApplyPatchVerifyCheck,
	finalizeSuccessfulPatch,
	IGNORED_VERIFY_LINE,
	normalizeVerifyChecks,
} from "./verify.js";
import { writeFileAtomic } from "./write-file-atomic.js";

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
	verify: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.Optional(
					Type.String({
						description:
							"Scope to assert over: a file, a directory, or a glob such as '**/*.md'. Omit to check only the files this patch wrote.",
					}),
				),
				mustContain: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description:
							"Substring(s) that must each appear at least once in the scope. A plain string is accepted for a single needle.",
					}),
				),
				mustNotContain: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description:
							"Substring(s) that must appear nowhere in the scope (e.g. a name this patch removes). A plain string is accepted for a single needle.",
					}),
				),
			}),
			{
				description:
					"Post-write assertions, checked in this same call. Use it for invariants a diff cannot prove: a removed name is gone project-wide, or a heading survived a change. Cheaper and stricter than a follow-up grep.",
			},
		),
	),
});

type ParsedPatch =
	| { type: "add"; filePath: string; content: string }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

type PatchChunk = {
	changeContexts: string[];
	oldLines: string[];
	newLines: string[];
	contextLineIndices: ContextLineIndex[];
	isEndOfFile: boolean;
};

export type FreeformToolFormat = {
	type: "grammar";
	syntax: "lark";
	definition: string;
};

type ApplyPatchToolDefinition = ToolDefinition<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined> & {
	freeform: FreeformToolFormat;
};

export type ApplyPatchExtensionAPI = Pick<
	ExtensionAPI,
	"on" | "getActiveTools" | "setActiveTools" | "registerCommand"
> & {
	registerTool: (tool: ApplyPatchToolDefinition) => void;
};

type ApplyPatchParams = {
	input: string;
	verify?: ApplyPatchVerifyCheck[] | undefined;
	/** True when the model sent a `verify` argument that normalized to zero usable checks. */
	verifyDropped?: boolean | undefined;
	/**
	 * The `verify` value exactly as the caller sent it. Kept so normalization is idempotent:
	 * `prepareArguments` runs first and its output is normalized AGAIN in `execute`, which would
	 * otherwise see no `verify` at all and silently report a clean patch.
	 */
	verifyRaw?: unknown;
};

type ApplyPatchOperation = "add" | "delete" | "update";

/** Per-call behaviour overrides; the extension resolves them from `apply-patch.json`. */
export type ApplyPatchOptions = {
	/** Reject (write nothing) when a chunk's pattern matches several places. Defaults to `true`. */
	rejectAmbiguous?: boolean;
};

type ApplyPatchPreviewFile = {
	filePath: string;
	movePath?: string;
	operation: ApplyPatchOperation;
	diff: string;
	added: number;
	removed: number;
};

type ApplyPatchPreview = {
	files: ApplyPatchPreviewFile[];
	added: number;
	removed: number;
};

type ApplyPatchToolDetails = {
	preview?: ApplyPatchPreview;
	progress?: ApplyPatchProgress;
	result?: ApplyPatchResult;
	verification?: ApplyPatchVerification;
};

type ApplyPatchProgress = {
	applied: number;
	failed: number;
	total: number;
};

type ApplyPatchProgressCallback = (progress: ApplyPatchProgress) => Promise<void> | void;

async function notifyApplyPatchProgress(
	onProgress: ApplyPatchProgressCallback | undefined,
	progress: ApplyPatchProgress,
): Promise<void> {
	try {
		await onProgress?.(progress);
	} catch {
		// Rendering progress must not affect patch application or recovery details.
	}
}

export type ApplyPatchFailure = {
	filePath: string;
	operation: ApplyPatchOperation;
	message: string;
	code?: string | undefined;
};

export type ApplyPatchRecoveryInstructions = {
	mustReadFiles: string[];
	mustNotReadFiles: string[];
	failedFiles: string[];
	warnings: string[];
	noOps: string[];
};

export type ApplyPatchResult = {
	summaries: string[];
	appliedFiles: string[];
	failures: ApplyPatchFailure[];
	hasPartialSuccess: boolean;
	recoveryInstructions: ApplyPatchRecoveryInstructions;
	details: {
		fuzz: number;
		warnings: string[];
		noOps: string[];
	};
};

export class ApplyPatchError extends Error {
	public readonly failures: ApplyPatchFailure[];
	public readonly result: ApplyPatchResult;

	constructor(message: string, result: ApplyPatchResult) {
		super(message);
		this.name = "ApplyPatchError";
		this.failures = result.failures;
		this.result = result;
	}

	hasPartialSuccess(): boolean {
		return this.result.hasPartialSuccess;
	}
}

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchParseError";
	}
}

export class PatchApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchApplicationError";
	}
}

type ApplyPatchRenderState = {
	cwd: string;
	patchText: string;
	callText: string;
};

type ApplyPatchThemeColor =
	| "accent"
	| "error"
	| "muted"
	| "toolDiffAdded"
	| "toolDiffContext"
	| "toolDiffRemoved"
	| "toolOutput"
	| "toolTitle"
	| "warning";

type ApplyPatchTheme = {
	fg: (name: ApplyPatchThemeColor, text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
};

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

const GPT_APPLY_PATCH_PROVIDERS = new Set(["openai", "openai-codex", "azure-openai-responses", "github-copilot"]);
const GPT_APPLY_PATCH_APIS = new Set(["openai-responses", "openai-codex-responses"]);
export const PATCH_PREVIEW_MAX_LINES = 16;
export const PATCH_PREVIEW_MAX_CHARS = 4000;
const PATCH_PREVIEW_HEAD_LINES = 8;
const PATCH_PREVIEW_TAIL_LINES = PATCH_PREVIEW_MAX_LINES - PATCH_PREVIEW_HEAD_LINES - 1;
const PATCH_PREVIEW_TRUNCATION_MARKER = "…";
// Expanded output is the whole diff, but a huge patch must not push the conversation off screen.
const PATCH_EXPANDED_MAX_LINES = 400;
const PATCH_RENDER_INDENT = "  ";
const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

function isChangedPreviewLine(line: string): boolean {
	return /^[+-]\s*\d+\s/.test(line);
}

function countWindowLines(lines: string[], start: number, end: number): number {
	return end - start + (start > 0 ? 1 : 0) + (end < lines.length ? 1 : 0);
}

function formatPreviewWindow(lines: string[], start: number, end: number): string {
	const previewLines = lines.slice(start, end);
	if (start > 0) {
		previewLines.unshift("…");
	}
	if (end < lines.length) {
		previewLines.push("…");
	}
	return previewLines.join("\n");
}

function createChangedHunkPreview(lines: string[]): string | undefined {
	const firstChangedLine = lines.findIndex(isChangedPreviewLine);
	if (firstChangedLine === -1) {
		return undefined;
	}

	let start = firstChangedLine;
	let end = firstChangedLine + 1;
	while (end < lines.length) {
		const line = lines[end];
		if (line === undefined || !isChangedPreviewLine(line)) {
			break;
		}
		end++;
	}

	const changedHunkEnd = end;
	while (end > start && countWindowLines(lines, start, end) > PATCH_PREVIEW_MAX_LINES) {
		end--;
	}

	while (countWindowLines(lines, start, end) < PATCH_PREVIEW_MAX_LINES) {
		const canAddBefore = start > 0;
		const canAddAfter = end < lines.length;
		if (!canAddBefore && !canAddAfter) {
			break;
		}

		const beforeContextLines = firstChangedLine - start;
		const afterContextLines = end - changedHunkEnd;
		if (canAddBefore && (!canAddAfter || beforeContextLines <= afterContextLines)) {
			start--;
		} else {
			end++;
		}
	}

	return formatPreviewWindow(lines, start, end);
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let lines = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			lines += 1;
		}
	}
	return lines;
}

function enforcePreviewCharLimit(preview: string): string {
	if (preview.length <= PATCH_PREVIEW_MAX_CHARS) {
		return preview;
	}

	return `${preview.slice(0, PATCH_PREVIEW_MAX_CHARS - PATCH_PREVIEW_TRUNCATION_MARKER.length).trimEnd()}${PATCH_PREVIEW_TRUNCATION_MARKER}`;
}

export function truncatePreview(text: string): string {
	if (text.length <= PATCH_PREVIEW_MAX_CHARS && countLines(text) <= PATCH_PREVIEW_MAX_LINES) {
		return text;
	}

	const lines = text.split("\n");
	const changedHunkPreview = createChangedHunkPreview(lines);
	const previewText =
		changedHunkPreview ??
		[...lines.slice(0, PATCH_PREVIEW_HEAD_LINES), "…", ...lines.slice(-PATCH_PREVIEW_TAIL_LINES)].join("\n");
	return enforcePreviewCharLimit(previewText);
}

function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams {
	if (typeof args === "string") {
		return { input: args };
	}

	if (args && typeof args === "object") {
		const record = args as { input?: unknown; verify?: unknown; verifyRaw?: unknown };
		const rawVerify = record.verify !== undefined ? record.verify : record.verifyRaw;
		const verify = normalizeVerifyChecks(rawVerify);
		const verifyDropped = rawVerify !== undefined && rawVerify !== null && verify === undefined;
		if (typeof record.input === "string") {
			return {
				input: record.input,
				...(verify ? { verify } : {}),
				...(verifyDropped ? { verifyDropped } : {}),
				...(rawVerify !== undefined ? { verifyRaw: rawVerify } : {}),
			};
		}
	}

	return { input: "" };
}

const STANDARD_EDIT_TOOL_NAMES = ["edit", "write"] as const;
export const APPLY_PATCH_FREEFORM_DESCRIPTION =
	"START AND END EVERY PATCH WITH THE ENVELOPE — a patch without '*** Begin Patch' as its first line is rejected:\n" +
	"*** Begin Patch\\n<one or more hunks>\\n*** End Patch\n" +
	"Edit files by sending ONE such patch as raw text — this is a FREEFORM tool, so the patch is NOT JSON and must not be quoted or escaped. " +
	"The patch text is the `input` argument. Next to it there is an optional `verify` argument: input = what to change, verify = what must be true afterwards. " +
	"If your tool schema shows a `verify` argument, use it (see USE verify below) instead of reading the files again afterwards.\n" +
	"\n" +
	"Hunk headers: '*** Add File: <path>', '*** Update File: <path>' (optionally followed by '*** Move to: <path>'), '*** Delete File: <path>'. " +
	"Any number of hunks, any mix of files, one call.\n" +
	"\n" +
	"USE verify — this is the difference between 'I edited some lines' and 'the change is true'. Pass it whenever the request is project-wide or negative: " +
	"'everywhere', 'all files', 'nothing left', 'remove', 'rename', 'deprecate', or whenever you would otherwise grep/read the result to be sure. " +
	"It runs in this same call and answers with one line — 'VERIFY_OK checks=N files=M' or 'VERIFY_FAIL ...' with file:line — so the follow-up grep or read is redundant. " +
	"Shape: [{\"path\": \"**/*.md\", \"mustNotContain\": [\"OldName\"]}, {\"path\": \"docs/x.md\", \"mustContain\": [\"NewName\"]}]. " +
	"needles are case-sensitive literal substrings (no regex); path is a file, a directory or a glob (** spans directories, * stays inside one segment), and omitting path checks only the files this patch wrote. " +
	"A failing check does NOT roll the write back: it names what still violates the invariant so the next call can fix it.\n" +
	"\n" +
	"LINE RULES (this is where patches usually fail):\n" +
	"- every line inside a hunk starts with exactly one of ' ' (unchanged), '-' (removed) or '+' (added); nothing else may start a line.\n" +
	"- Add File: no '@@' line at all; every content line starts with '+', and a blank line is a lone '+'.\n" +
	"- Update File: each change block starts with a bare '@@' line, or '@@ <text>' where <text> must be a line that EXISTS in the file: it is searched as an anchor and the block is rejected if it is not found, but it does not control where the edit lands (the '-'/' ' lines below it do). Never use it as a comment or a label. Never write unified-diff ranges such as '@@ -1 +1,2 @@'. " +
	"'*** End of File' as the last line of a block means 'anchor at the end of the file'.\n" +
	"- context lines must be copied VERBATIM from the file, indentation and trailing spaces included: the patch matches text, it does not paraphrase. Include 3 lines of surrounding context so the anchor is unique.\n" +
	"- hunks apply top-to-bottom, each against the result of the previous one; a later hunk sees earlier edits.\n" +
	"- duplicate anchors are rejected before writing: add unique context, or use '*** End of File' for the last occurrence.\n" +
	"- a whole-file rewrite is either Delete File now + Add File in a later call, or one Update File whose '-' lines are the entire old content.\n" +
	"\n" +
	"AFTER SUCCESS: do not re-read the files you just edited to confirm the patch landed — the result lists what changed, and verify covers the rest. " +
	"AFTER FAILURE: never resend the same patch. The error quotes the closest actual text with line numbers; rebuild the context lines from that quote.\n" +
	"\n" +
	"EXAMPLE\n" +
	"*** Begin Patch\n" +
	"*** Add File: hello.txt\n" +
	"+Hello world.\n" +
	"*** Update File: example.txt\n" +
	"@@\n" +
	" Hello from the original text file.\n" +
	"+Second line added.\n" +
	"@@ old tail\n" +
	"-old tail\n" +
	"+new tail\n" +
	"*** Delete File: obsolete.txt\n" +
	"*** End Patch";
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export function isOpenAIGptModel(
	model: (Pick<Model<string>, "provider" | "id"> & Partial<Pick<Model<string>, "api">>) | undefined,
): boolean {
	if (!model?.id.startsWith("gpt-")) {
		return false;
	}

	return (
		GPT_APPLY_PATCH_PROVIDERS.has(model.provider) || (model.api !== undefined && GPT_APPLY_PATCH_APIS.has(model.api))
	);
}

function normalizePatchText(patchText: string): string {
	return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2] ?? input;
	}
	return input;
}

function normalizeSeekLine(line: string): string {
	return line
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): { index: number; fuzz: 0 | 1 | 100 | 10000 } | undefined {
	if (pattern.length === 0) {
		return { index: start, fuzz: 0 };
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastStart = lines.length - pattern.length;
	const matches = (index: number, compare: (left: string, right: string) => boolean): boolean => {
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			const line = lines[index + patternIndex];
			const expected = pattern[patternIndex];
			if (line === undefined || expected === undefined || !compare(line, expected)) {
				return false;
			}
		}
		return true;
	};
	const matchesPrepared = (index: number, preparedLines: string[], preparedPattern: string[]): boolean => {
		for (let patternIndex = 0; patternIndex < preparedPattern.length; patternIndex++) {
			const line = preparedLines[index + patternIndex];
			const expected = preparedPattern[patternIndex];
			if (line === undefined || expected === undefined || line !== expected) {
				return false;
			}
		}
		return true;
	};

	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line === expected)) {
			return { index, fuzz: 0 };
		}
	}
	const linesTrimEnd = lines.map((line) => line.trimEnd());
	const patternTrimEnd = pattern.map((line) => line.trimEnd());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrimEnd, patternTrimEnd)) {
			return { index, fuzz: 1 };
		}
	}
	const linesTrim = lines.map((line) => line.trim());
	const patternTrim = pattern.map((line) => line.trim());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrim, patternTrim)) {
			return { index, fuzz: 100 };
		}
	}
	const linesNormalized = lines.map(normalizeSeekLine);
	const patternNormalized = pattern.map(normalizeSeekLine);
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesNormalized, patternNormalized)) {
			return { index, fuzz: 10000 };
		}
	}

	return undefined;
}

/** 0-based start indices of every exact full-file occurrence of the pattern. */
function findExactMatches(lines: string[], pattern: string[]): number[] {
	if (pattern.length === 0) return [];
	const matches: number[] = [];
	for (let index = 0; index + pattern.length <= lines.length; index++) {
		let matched = true;
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			if (lines[index + patternIndex] !== pattern[patternIndex]) {
				matched = false;
				break;
			}
		}
		if (matched) matches.push(index);
	}
	return matches;
}

const FILE_HEADER_MARKERS = [
	["add", "*** Add File: "],
	["delete", "*** Delete File: "],
	["update", "*** Update File: "],
] as const;
const CLOSEST_MATCH_MAX_PAIRS = 8;
const CLOSEST_MATCH_MAX_WIDTH = 160;
const CLOSEST_MATCH_MAX_EXPECTED = 12;
type ClosestWindowPair = { expected: string; actual: string; fileLine: number };
type ClosestWindow = { index: number; matched: number; total: number; pairs: ClosestWindowPair[] };
function truncateMatchLine(line: string): string {
	return line.length > CLOSEST_MATCH_MAX_WIDTH ? line.slice(0, CLOSEST_MATCH_MAX_WIDTH - 3) + "..." : line;
}
function findClosestWindow(lines: string[], pattern: string[], startIndex: number, maxPairs = CLOSEST_MATCH_MAX_PAIRS): ClosestWindow | undefined {
	if (pattern.length === 0 || pattern.length > lines.length) return undefined;
	let best: ClosestWindow | undefined;
	const lastStart = lines.length - pattern.length;
	for (let s = Math.max(0, startIndex); s <= lastStart; s++) {
		let matched = 0;
		const pairs: ClosestWindowPair[] = [];
		for (let i = 0; i < pattern.length; i++) {
			const actual = lines[s + i] ?? "";
			const expected = pattern[i] ?? "";
			if (actual.trim() === expected.trim()) matched++;
			else if (pairs.length < maxPairs) pairs.push({ expected: truncateMatchLine(expected), actual: truncateMatchLine(actual), fileLine: s + i + 1 });
		}
		if (!best || matched > best.matched) {
			best = { index: s, matched, total: pattern.length, pairs };
			if (matched === pattern.length) break;
		}
	}
	return best;
}
function formatClosestMatch(filePath: string, pattern: string[], startIndex: number, lines: string[]): string {
	const closest = findClosestWindow(lines, pattern, startIndex);
	if (!closest || closest.matched === 0) {
		return `No similar block found in ${filePath} — the file may have changed; re-read it and rebuild the hunk. Nothing was written.`;
	}
	const pct = Math.round((closest.matched / closest.total) * 100);
	const out: string[] = [];
	out.push(`Closest match at line ${closest.index + 1} (1-based): ${closest.matched}/${closest.total} lines match (${pct}%).`);
	for (const pair of closest.pairs) out.push(`- expected: ${pair.expected}\n+ actual (line ${pair.fileLine}): ${pair.actual}`);
	const omitted = closest.total - closest.matched - closest.pairs.length;
	if (omitted > 0) out.push(`… ${omitted} more differing line(s) omitted.`);
	out.push(`To accept: re-issue the hunk anchored at line ${closest.index + 1} using the actual lines above as context.`);
	out.push(`To decline: leave the file unchanged (nothing was written).`);
	if (pct < 50) out.push(`Hint: overlap is low — re-read ${filePath} first; the anchor is probably outdated.`);
	return out.join("\n");
}
function formatExpectedLines(oldLines: string[]): string {
	if (oldLines.length <= CLOSEST_MATCH_MAX_EXPECTED) return oldLines.join("\n");
	return oldLines.slice(0, CLOSEST_MATCH_MAX_EXPECTED).join("\n") + `\n… (${oldLines.length - CLOSEST_MATCH_MAX_EXPECTED} more expected line(s) omitted)`;
}
const MOVE_TO_MARKER = "*** Move to: ";

// The parser and extractPatchedPaths both read headers through these two functions, so they share one
// whitespace definition (String.prototype.trim): any path the parser writes is a path consumers that
// gate writes per file (permission prompts) see, spelled the same way.
function parseFileHeader(line: string): { kind: ParsedPatch["type"]; path: string } | undefined {
	const trimmed = line.trim();
	for (const [kind, marker] of FILE_HEADER_MARKERS) {
		if (trimmed.startsWith(marker)) return { kind, path: trimmed.slice(marker.length) };
	}
	return undefined;
}

function parseMoveTo(line: string): string | undefined {
	const trimmed = line.trimEnd();
	return trimmed.startsWith(MOVE_TO_MARKER) ? trimmed.slice(MOVE_TO_MARKER.length) : undefined;
}

export function extractPatchedPaths(patchText: string): string[] {
	const lines = stripHeredoc(normalizePatchText(patchText)).split("\n");
	return lines.flatMap((line) => {
		const path = parseFileHeader(line)?.path ?? parseMoveTo(line.trimStart());
		return path === undefined ? [] : [path];
	});
}

const PATCH_PREVIEW_CONTEXT_LINES = 3;
// A preview must stay bounded even for a whole-file rewrite: the diff is display-only, and storing
// the full text of a large file in the tool result inflates the session without adding information.
const PATCH_PREVIEW_DIFF_MAX_LINES = 400;
const PATCH_PREVIEW_DIFF_MAX_CHARS = 50_000;
const PATCH_PREVIEW_MAX_LINE_CHARS = 500;

type PatchDiffRecord = {
	kind: "added" | "context" | "removed";
	line: string;
	lineNumber: number;
};

function createPatchDiff(oldContent: string, newContent: string): { diff: string; added: number; removed: number } {
	const parts = Diff.diffLines(oldContent, newContent);
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	const records: PatchDiffRecord[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let added = 0;
	let removed = 0;

	for (const part of parts) {
		// CRLF files leave a trailing \r on every line. The TUI treats \r as a line break, which
		// renders an empty row after each diff line; normalize before building the display text.
		const rawLines = normalizePatchText(part.value).split("\n");
		if (rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		for (const line of rawLines) {
			if (part.added) {
				records.push({ kind: "added", line, lineNumber: newLineNum });
				newLineNum++;
				added++;
				continue;
			}

			if (part.removed) {
				records.push({ kind: "removed", line, lineNumber: oldLineNum });
				oldLineNum++;
				removed++;
				continue;
			}

			records.push({ kind: "context", line, lineNumber: oldLineNum });
			oldLineNum++;
			newLineNum++;
		}
	}

	// Keep only the changed lines plus a few lines of context. Without this, editing line 4000 of a
	// 5000-line file stores and renders the whole file as context; the expanded TUI view then fills
	// its budget with unchanged lines and can hide the edit entirely.
	const included = new Uint8Array(records.length);
	let hasChanges = false;
	for (let index = 0; index < records.length; index++) {
		if (records[index]?.kind === "context") {
			continue;
		}
		hasChanges = true;
		const start = Math.max(0, index - PATCH_PREVIEW_CONTEXT_LINES);
		const end = Math.min(records.length - 1, index + PATCH_PREVIEW_CONTEXT_LINES);
		for (let contextIndex = start; contextIndex <= end; contextIndex++) {
			included[contextIndex] = 1;
		}
	}
	if (!hasChanges) {
		return { diff: "", added, removed };
	}

	const output: string[] = [];
	let usedChars = 0;
	let omitted = 0;
	let skipping = false;
	let truncated = false;
	for (let index = 0; index < records.length; index++) {
		if (included[index] !== 1) {
			skipping = true;
			continue;
		}

		const record = records[index];
		if (!record) {
			continue;
		}
		if (truncated) {
			omitted++;
			continue;
		}
		const sign = record.kind === "added" ? "+" : record.kind === "removed" ? "-" : " ";
		const line =
			record.line.length > PATCH_PREVIEW_MAX_LINE_CHARS
				? `${record.line.slice(0, PATCH_PREVIEW_MAX_LINE_CHARS - 1)}…`
				: record.line;
		const rendered = `${sign}${String(record.lineNumber).padStart(lineNumWidth, " ")} ${line}`;
		if (output.length >= PATCH_PREVIEW_DIFF_MAX_LINES - 1 || usedChars + rendered.length > PATCH_PREVIEW_DIFF_MAX_CHARS) {
			truncated = true;
			omitted++;
			continue;
		}
		if (skipping) {
			output.push(PATCH_PREVIEW_TRUNCATION_MARKER);
			usedChars += PATCH_PREVIEW_TRUNCATION_MARKER.length;
			skipping = false;
		}
		output.push(rendered);
		usedChars += rendered.length;
	}

	if (omitted > 0) {
		output.push(`${PATCH_PREVIEW_TRUNCATION_MARKER} ${omitted} more diff line(s)`);
	}

	return { diff: output.join("\n"), added, removed };
}

async function readExistingFileForPreview(absolutePath: string): Promise<string> {
	try {
		return await readFile(absolutePath, "utf-8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return "";
		}
		throw error;
	}
}

function formatLineCountSummary(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}

function formatPatchFileSummary(file: ApplyPatchPreviewFile, cwd: string): string {
	return `${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`;
}

function formatPatchFileHeader(file: ApplyPatchPreviewFile, cwd: string): string {
	return `• ${formatPatchOperation(file.operation)} ${formatPatchFileSummary(file, cwd)}`;
}

function normalizeDisplayPath(filePath: string): string {
	return filePath.replaceAll(path.sep, "/");
}

export function displayPath(filePath: string, cwd: string): string {
	if (!path.isAbsolute(filePath)) {
		return normalizeDisplayPath(filePath);
	}

	const absoluteCwd = path.resolve(cwd);
	const relativePath = path.relative(absoluteCwd, filePath);
	if (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	) {
		return normalizeDisplayPath(relativePath || ".");
	}

	return normalizeDisplayPath(filePath);
}

export function formatPatchFilePath(file: ApplyPatchPreviewFile, cwd: string = process.cwd()): string {
	const filePath = displayPath(file.filePath, cwd);
	if (!file.movePath) {
		return filePath;
	}
	return `${filePath} → ${displayPath(file.movePath, cwd)}`;
}

function formatPatchOperation(operation: ApplyPatchOperation): string {
	if (operation === "add") {
		return "Added";
	}
	if (operation === "delete") {
		return "Deleted";
	}
	return "Edited";
}

export function formatPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string = process.cwd(),
	expanded: boolean = true,
): string {
	const lines: string[] = [];
	if (preview.files.length === 1) {
		const file = preview.files[0];
		if (file) {
			lines.push(formatPatchFileHeader(file, cwd));
			if (expanded && file.diff) {
				lines.push(
					...truncatePreview(file.diff)
						.split("\n")
						.map((line) => `  ${line}`),
				);
			}
		}
		return lines.join("\n");
	}

	const noun = "files";
	lines.push(`• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}`);
	for (const file of preview.files) {
		lines.push(`  └ ${formatPatchFileSummary(file, cwd)}`);
		if (expanded && file.diff) {
			lines.push(
				...truncatePreview(file.diff)
					.split("\n")
					.map((line) => `    ${line}`),
			);
		}
	}
	return lines.join("\n");
}

function getApplyPatchRenderState(toolCallId: string, cwd: string, patchText: string): ApplyPatchRenderState {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (existing && existing.cwd === cwd && existing.patchText === patchText) {
		return existing;
	}

	const nextState: ApplyPatchRenderState = { cwd, patchText, callText: formatInFlightCallText(patchText) };
	applyPatchRenderStates.set(toolCallId, nextState);
	return nextState;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

const IN_FLIGHT_PATH_LIMIT = 3;

export function formatInFlightCallText(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) {
		return "Patching";
	}
	const shown = paths.slice(0, IN_FLIGHT_PATH_LIMIT);
	const omitted = paths.length - shown.length;
	const suffix = omitted > 0 ? `, +${omitted} more` : "";
	if (paths.length === 1) {
		return `Patching ${paths[0]}`;
	}
	return `Patching ${paths.length} files: ${shown.join(", ")}${suffix}`;
}

type RenderableAddedDiffLine = { content: string; kind: "added"; lineNumber: string; sign: "+" };
type RenderableRemovedDiffLine = { content: string; kind: "removed"; lineNumber: string; sign: "-" };
type RenderableContextDiffLine = { content: string; kind: "context"; lineNumber: string; sign: " " };
type RenderableContentDiffLine = RenderableAddedDiffLine | RenderableContextDiffLine | RenderableRemovedDiffLine;
type RenderableDiffLine = RenderableContentDiffLine | { kind: "meta"; text: string };

function parseRenderableDiffLine(line: string): RenderableDiffLine {
	const match = line.match(/^([+\- ])(\s*\d+)\s(.*)$/);
	if (!match) {
		return { kind: "meta", text: line };
	}

	const sign = match[1];
	const lineNumber = match[2];
	if ((sign !== "+" && sign !== "-" && sign !== " ") || lineNumber === undefined) {
		return { kind: "meta", text: line };
	}

	const content = match[3] ?? "";
	if (sign === "+") {
		return { content, kind: "added", lineNumber, sign };
	}
	if (sign === "-") {
		return { content, kind: "removed", lineNumber, sign };
	}
	return { content, kind: "context", lineNumber, sign };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightDiffContent(content: string, filePath: string): string {
	const plainContent = replaceTabs(content);
	const language = getLanguageFromPath(filePath);
	try {
		const highlighted = highlightCode(plainContent, language);
		// Real Pi returns one string per line; tolerate a plain string from older/stubbed builds.
		return Array.isArray(highlighted) ? (highlighted[0] ?? plainContent) : highlighted;
	} catch {
		return plainContent;
	}
}

function renderInlineDiff(
	oldContent: string,
	newContent: string,
	theme: ApplyPatchTheme,
): { added: string; removed: string } {
	const parts = Diff.diffWords(replaceTabs(oldContent), replaceTabs(newContent));
	let added = "";
	let removed = "";
	let firstAdded = true;
	let firstRemoved = true;

	for (const part of parts) {
		if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				added += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstAdded = false;
			}
			if (value) {
				added += theme.inverse(value);
			}
			continue;
		}

		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				removed += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstRemoved = false;
			}
			if (value) {
				removed += theme.inverse(value);
			}
			continue;
		}

		added += part.value;
		removed += part.value;
	}

	return { added, removed };
}

function renderDiffLine(
	line: RenderableContentDiffLine,
	filePath: string,
	theme: ApplyPatchTheme,
	contentOverride?: string,
): string {
	const lineNumber = theme.fg("muted", line.lineNumber);
	if (line.kind === "context") {
		return `${theme.fg("toolDiffContext", line.sign)}${lineNumber} ${highlightDiffContent(line.content, filePath)}`;
	}

	// Changed lines are painted with the diff color as a whole. Syntax colors would win over it and
	// hide the add/remove distinction, which is the one thing that must survive after a patch.
	const diffColor = line.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	const content = theme.fg(diffColor, replaceTabs(contentOverride ?? line.content));
	return `${theme.fg(diffColor, line.sign)}${lineNumber} ${content}`;
}

function renderDiff(diffText: string, filePath: string, theme: ApplyPatchTheme): string {
	// Defensive: previews stored by older versions may still carry CRLF endings.
	const parsedLines = normalizePatchText(diffText).split("\n").map(parseRenderableDiffLine);
	const rendered: string[] = [];
	let index = 0;

	while (index < parsedLines.length) {
		const line = parsedLines[index];
		if (!line) {
			index++;
			continue;
		}

		if (line.kind !== "removed") {
			rendered.push(
				line.kind === "meta"
					? theme.fg("toolDiffContext", line.text)
					: renderDiffLine(line, filePath, theme),
			);
			index++;
			continue;
		}

		const removedLines: RenderableRemovedDiffLine[] = [];
		while (parsedLines[index]?.kind === "removed") {
			const removedLine = parsedLines[index];
			if (removedLine?.kind === "removed") {
				removedLines.push(removedLine);
			}
			index++;
		}

		const addedLines: RenderableAddedDiffLine[] = [];
		while (parsedLines[index]?.kind === "added") {
			const addedLine = parsedLines[index];
			if (addedLine?.kind === "added") {
				addedLines.push(addedLine);
			}
			index++;
		}

		// Interleave only when the block is a one-to-one replacement, so the removed/added pairing is
		// visually obvious. Uneven blocks keep the diff order (all removals, then all additions).
		if (removedLines.length === addedLines.length) {
			for (let pairIndex = 0; pairIndex < removedLines.length; pairIndex++) {
				const removedLine = removedLines[pairIndex];
				const addedLine = addedLines[pairIndex];
				if (!removedLine || !addedLine) {
					continue;
				}

				const inline = renderInlineDiff(removedLine.content, addedLine.content, theme);
				rendered.push(renderDiffLine(removedLine, filePath, theme, inline.removed));
				rendered.push(renderDiffLine(addedLine, filePath, theme, inline.added));
			}
			continue;
		}

		for (const removedLine of removedLines) {
			rendered.push(renderDiffLine(removedLine, filePath, theme));
		}
		for (const addedLine of addedLines) {
			rendered.push(renderDiffLine(addedLine, filePath, theme));
		}
	}

	return rendered.join("\n");
}

function indentBlock(text: string, indent: string): string {
	return text
		.split("\n")
		.map((line) => `${indent}${line}`)
		.join("\n");
}

function formatPatchCounts(file: ApplyPatchPreviewFile, theme: ApplyPatchTheme): string {
	const counts: string[] = [];
	if (file.added > 0) {
		counts.push(theme.fg("toolDiffAdded", `+${file.added}`));
	}
	if (file.removed > 0) {
		counts.push(theme.fg("toolDiffRemoved", `-${file.removed}`));
	}
	return counts.length > 0 ? counts.join(" ") : theme.fg("muted", "no line changes");
}

function renderPatchFileHeader(file: ApplyPatchPreviewFile, cwd: string, theme: ApplyPatchTheme): string {
	const isAdd = file.operation === "add";
	const isDelete = file.operation === "delete";
	const icon = isAdd ? "+" : isDelete ? "-" : "~";
	const iconColor: ApplyPatchThemeColor = isAdd ? "toolDiffAdded" : isDelete ? "toolDiffRemoved" : "accent";
	const label = isAdd ? "new" : isDelete ? "deleted" : file.movePath ? "moved" : "";
	const labelText = label.length > 0 ? ` ${theme.fg("muted", label)}` : "";
	return `${theme.fg(iconColor, icon)} ${theme.fg("accent", formatPatchFilePath(file, cwd))}${labelText} ${formatPatchCounts(file, theme)}`;
}

function countWindowMarkers(lines: string[]): number {
	let markers = 0;
	for (const line of lines) {
		if (line === PATCH_PREVIEW_TRUNCATION_MARKER) {
			markers++;
		}
	}
	return markers;
}

const STORED_DIFF_OMISSION = /^… \d+ more diff line\(s\)$/;

/** Lines of the stored diff that represent real source lines, excluding our own markers. */
function countDiffSourceLines(diffText: string): number {
	const lines = diffText.split("\n");
	const omissionLines = lines[lines.length - 1] !== undefined && STORED_DIFF_OMISSION.test(lines[lines.length - 1] as string) ? 1 : 0;
	return lines.length - countWindowMarkers(lines) - omissionLines;
}

/**
 * The TUI diff view. Collapsed rows get a smart window of the first changed hunk per file (enough to
 * recognize the edit without flooding the transcript); expanded rows get the whole diff, capped so a
 * pathological patch cannot push everything else off screen.
 */
function renderPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string,
	theme: ApplyPatchTheme,
	expanded: boolean,
): string {
	if (preview.files.length === 0) {
		return "";
	}

	const fileCount = Math.max(1, preview.files.length);
	const collapsedBudget = Math.max(3, Math.floor(PATCH_PREVIEW_MAX_LINES / fileCount));
	let expandedBudget = PATCH_EXPANDED_MAX_LINES;
	const blocks: string[] = [];

	for (const file of preview.files) {
		const header = renderPatchFileHeader(file, cwd, theme);
		const diffText = normalizePatchText(file.diff);
		const noLineChanges = file.added === 0 && file.removed === 0;
		if (!diffText || noLineChanges || (!expanded && file.operation === "delete")) {
			blocks.push(header);
			continue;
		}

		const totalLines = countDiffSourceLines(diffText);
		const windowText = expanded ? diffText : truncatePreview(diffText);
		const windowLines = windowText.split("\n");
		const limit = expanded ? expandedBudget : collapsedBudget;
		const keptLines = windowLines.slice(0, Math.max(0, limit));
		if (expanded) {
			expandedBudget -= keptLines.length;
		}

		if (keptLines.length === 0) {
			blocks.push(`${header}\n${theme.fg("muted", `${PATCH_RENDER_INDENT}… ${totalLines} diff line(s) hidden`)}`);
			continue;
		}

		const renderedDiff = renderDiff(keptLines.join("\n"), file.movePath ?? file.filePath, theme);
		const keptOmission =
			keptLines.length > 0 && STORED_DIFF_OMISSION.test(keptLines[keptLines.length - 1] as string) ? 1 : 0;
		const shownSourceLines = keptLines.length - countWindowMarkers(keptLines) - keptOmission;
		const hidden = Math.max(0, totalLines - shownSourceLines);
		const block = [`${header}\n${indentBlock(renderedDiff, PATCH_RENDER_INDENT)}`];
		if (hidden > 0) {
			const hint = expanded ? "diff truncated" : "expand to view";
			block.push(theme.fg("muted", `${PATCH_RENDER_INDENT}… ${hidden} more line(s) — ${hint}`));
		}
		blocks.push(block.join("\n"));
	}

	return blocks.join("\n\n");
}

function formatPendingPatchPaths(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) {
		return "Applying patch...";
	}
	return `Applying patch...\n${paths.map((filePath) => `• ${filePath}`).join("\n")}`;
}

async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
	const files: ApplyPatchPreviewFile[] = [];
	for (const hunk of hunks) {
		const absolutePath = await resolvePatchPath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			const oldContent = await readExistingFileForPreview(absolutePath);
			const diff = createPatchDiff(oldContent, hunk.content);
			files.push({ filePath: hunk.filePath, operation: oldContent.length > 0 ? "update" : "add", ...diff });
			continue;
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			const diff = createPatchDiff(oldContent, "");
			files.push({ filePath: hunk.filePath, operation: "delete", ...diff });
			continue;
		}

		const oldContent = await readFile(absolutePath, "utf-8");
		const newContent =
			// The preview is speculative and must not throw on an ambiguity the real run will either
			// reject (and then hide) or resolve to the first match.
			hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks, false).content;
		if (hunk.movePath) {
			await resolvePatchPath(cwd, hunk.movePath);
		}
		const diff = createPatchDiff(oldContent, newContent);
		const file = { filePath: hunk.filePath, operation: "update", ...diff } satisfies ApplyPatchPreviewFile;
		files.push(hunk.movePath !== undefined ? { ...file, movePath: hunk.movePath } : file);
	}

	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

function parsePatch(patchText: string): ParsedPatch[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split("\n");
	const beginIndex = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1;
	const lastLine = lines[lines.length - 1];
	const endIndex = lastLine?.trim() === "*** End Patch" ? lines.length - 1 : -1;

	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		throw new PatchParseError("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
	}

	const hunks: ParsedPatch[] = [];
	let index = beginIndex + 1;
	while (index < endIndex) {
		// Like Codex, file headers are recognized after trimming, and any other non-blank line between file
		// sections is rejected below; skipping it would silently drop the section it introduces.
		const line = (lines[index] ?? "").trim();
		if (line === "") {
			index++;
			continue;
		}
		const header = parseFileHeader(line);

		if (header?.kind === "add") {
			const filePath = header.path;
			index++;
			const contentLines: string[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.trim().startsWith("*** ")) {
					break;
				}
				if (!nextLine.startsWith("+")) {
					throw new PatchParseError(`Invalid patch format: Add File lines must start with '+'`);
				}
				contentLines.push(nextLine.slice(1));
				index++;
			}
			hunks.push({
				type: "add",
				filePath,
				content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
			});
			continue;
		}

		if (header?.kind === "delete") {
			hunks.push({ type: "delete", filePath: header.path });
			index++;
			continue;
		}

		if (header?.kind === "update") {
			const filePath = header.path;
			index++;
			let movePath: string | undefined;
			const moveTo = parseMoveTo(lines[index] ?? "");
			if (moveTo !== undefined) {
				movePath = moveTo;
				index++;
			}

			const chunks: PatchChunk[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.trim() === "") {
					index++;
					continue;
				}
				if (nextLine.startsWith("*** ")) {
					break;
				}

				const allowMissingContext = chunks.length === 0;
				const changeContexts: string[] = [];
				if (nextLine.startsWith("@@")) {
					while (index < endIndex) {
						const contextLine = lines[index] ?? "";
						if (contextLine === "@@") {
							index++;
							continue;
						}
						if (contextLine.startsWith("@@ ")) {
							changeContexts.push(contextLine.slice("@@ ".length));
							index++;
							continue;
						}
						break;
					}
				} else if (!allowMissingContext) {
					throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				const contextLineIndices: ContextLineIndex[] = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? "";
					if (hunkLine === "*** End of File") {
						if (parsedLines === 0) {
							throw new PatchParseError("Update hunk does not contain any lines");
						}
						isEndOfFile = true;
						index++;
						break;
					}
					if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
						break;
					}
					const prefix = hunkLine[0];
					const value = hunkLine.slice(1);
					if (prefix === undefined) {
						contextLineIndices.push([oldLines.length, newLines.length]);
						oldLines.push("");
						newLines.push("");
					} else if (prefix === " ") {
						contextLineIndices.push([oldLines.length, newLines.length]);
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") {
						oldLines.push(value);
					} else if (prefix === "+") {
						newLines.push(value);
					} else if (parsedLines > 0) {
						break;
					} else {
						throw new PatchParseError(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);
					}
					parsedLines++;
					index++;
				}

				if (parsedLines === 0) {
					throw new PatchParseError("Update hunk does not contain any lines");
				}
				chunks.push({ changeContexts, oldLines, newLines, contextLineIndices, isEndOfFile });
			}
			if (chunks.length === 0 && !movePath) {
				throw new PatchParseError(`Update file hunk for path '${filePath}' is empty`);
			}

			hunks.push(
				movePath !== undefined
					? { type: "update", filePath, movePath, chunks }
					: { type: "update", filePath, chunks },
			);
			continue;
		}

		throw new PatchParseError(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

function parseNonEmptyPatch(patchText: string): ParsedPatch[] {
	const hunks = parsePatch(patchText);
	if (hunks.length > 0) {
		return hunks;
	}

	const normalized = normalizePatchText(patchText).trim();
	if (normalized === "*** Begin Patch\n*** End Patch") {
		throw new PatchParseError("patch rejected: empty patch");
	}
	throw new PatchParseError("apply_patch verification failed: no hunks found");
}

function formatAmbiguousAnchor(filePath: string, pattern: string[], matchLines: number[]): string {
	const shown = matchLines.slice(0, 6).join(", ");
	const more = matchLines.length > 6 ? `, +${matchLines.length - 6} more` : "";
	return [
		`Ambiguous anchor in ${filePath}: the ${pattern.length}-line hunk matches ${matchLines.length} places (lines ${shown}${more}), so nothing was written.`,
		`First matching line: ${truncateMatchLine(pattern[0] ?? "")}`,
		`Fix: copy unique surrounding context into the hunk so it matches exactly one place, or add '*** End of File' when the LAST occurrence is intended.`,
	].join("\n");
}

function replaceChunks(
	content: string,
	filePath: string,
	chunks: PatchChunk[],
	rejectAmbiguous: boolean,
): { content: string; fuzz: number; matches: number; firstMatchLine?: number } {
	// Chunks apply SEQUENTIALLY: each chunk is matched against the content produced by the
	// previous chunk. This makes dependent hunks (-one/+ONE, then -ONE/+ONE-CHAIN) valid and
	// matches how multi-hunk patches are authored. Endings: inserted lines adopt the file's
	// preferred ending, untouched lines keep theirs (SourceText re-parsed at every step).
	let current = content;
	let fuzz = 0;
	let ambiguousMatches = 0;
	let ambiguousLine: number | undefined;

	for (const chunk of chunks) {
		const source = SourceText.parse(current);
		const originalLines = source.texts;
		let lineIndex = 0;
		for (const changeContext of chunk.changeContexts) {
			const contextMatch = seekSequence(originalLines, [changeContext], lineIndex, false);
			if (contextMatch === undefined) {
				throw new PatchApplicationError(`Failed to find context '${changeContext}' in ${filePath}\n${formatClosestMatch(filePath, [changeContext], lineIndex, originalLines)}`);
			}
			fuzz += contextMatch.fuzz;
			lineIndex = contextMatch.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			current = source.replace([{ start: insertionIndex, oldLength: 0, newLines: chunk.newLines }]);
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		// Search always starts at 0 on the CURRENT content: the patch orders chunks by intent,
		// and every earlier chunk is already materialized.
		let foundAt = seekSequence(originalLines, pattern, 0, chunk.isEndOfFile);
		if (foundAt === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") {
				newLines = newLines.slice(0, -1);
			}
			foundAt = seekSequence(originalLines, pattern, 0, chunk.isEndOfFile);
		}

		if (foundAt === undefined) {
			throw new PatchApplicationError(`Failed to find expected lines in ${filePath} (${pattern.length} lines).\nExpected (first ${CLOSEST_MATCH_MAX_EXPECTED}):\n${formatExpectedLines(pattern)}\n${formatClosestMatch(filePath, pattern, 0, originalLines)}\nHint: chunks apply top-to-bottom; each chunk sees the file after the previous chunks of this patch. If this chunk was written against the untouched file, split it into a separate apply_patch call.`);
		}

		fuzz += foundAt.fuzz;
		// `*** End of File` is an explicit choice of the last occurrence, so duplicate matches
		// elsewhere are not ambiguous there. Every other duplicate is unsafe by default.
		if (!chunk.isEndOfFile) {
			const occurrences = findExactMatches(originalLines, pattern);
			if (occurrences.length > 1) {
				if (rejectAmbiguous) {
					throw new PatchApplicationError(
						formatAmbiguousAnchor(
							filePath,
							pattern,
							occurrences.map((index) => index + 1),
						),
					);
				}
				if (occurrences.length > ambiguousMatches) {
					ambiguousMatches = occurrences.length;
					ambiguousLine = foundAt.index + 1;
				}
			}
		}
		// Sequential rewrite of the matched region. Context lines inside the chunk are already
		// part of `pattern`; a plain span replacement keeps their exact text and endings, and
		// inserted lines take the file's preferred ending via source.replace.
		current = source.replace([
			{ start: foundAt.index, oldLength: pattern.length, newLines },
		]);
	}

	return {
		content: current,
		fuzz,
		matches: Math.max(1, ambiguousMatches),
		firstMatchLine: ambiguousLine,
	};
}

async function applySingleHunk(
	cwd: string,
	hunk: ParsedPatch,
	dryRun = false,
	options: ApplyPatchOptions = {},
): Promise<{ summary: string; appliedFile: string; fuzz: number; matches: number; firstMatchLine?: number; noOp: boolean }> {
	const absolutePath = await resolvePatchPath(cwd, hunk.filePath);
	const absoluteMovePath =
		hunk.type === "update" && hunk.movePath ? await resolvePatchPath(cwd, hunk.movePath) : undefined;
	const mutationPaths = absoluteMovePath ? [absolutePath, absoluteMovePath] : [absolutePath];

	const run = async () => {
		if (hunk.type === "add") {
			// Guard against silent overwrite: Add File onto an existing path destroys its content.
			// Must run in dry-run too, so the validation pass rejects the whole patch.
			let addTargetExists = false;
			try {
				await stat(absolutePath);
				addTargetExists = true;
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) throw error;
			}
			if (addTargetExists) {
				throw new PatchApplicationError(
					`Add File target already exists: ${hunk.filePath}. Use Update File to change it, or Delete File first if recreation is intended.`,
		);
			}
			if (!dryRun) {
				await mkdir(path.dirname(absolutePath), { recursive: true });
				await writeFileAtomic(absolutePath, hunk.content);
			}
			return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0, matches: 1, noOp: false };
		}

		if (hunk.type === "delete") {
			await stat(absolutePath);
			if (!dryRun) {
				await rm(absolutePath);
			}
			return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0, matches: 1, noOp: false };
		}

		const currentContent = await readFile(absolutePath, "utf-8");
		const chunkResult =
			hunk.chunks.length === 0
				? { content: currentContent, fuzz: 0, matches: 1, firstMatchLine: undefined }
				: replaceChunks(currentContent, hunk.filePath, hunk.chunks, options.rejectAmbiguous ?? true);
		const nextContent = chunkResult.content;

		if (hunk.movePath && absoluteMovePath) {
			if (!dryRun) {
				await mkdir(path.dirname(absoluteMovePath), { recursive: true });
				await writeFileAtomic(absoluteMovePath, nextContent);
				if (absoluteMovePath !== absolutePath) {
					await rm(absolutePath);
				}
			}
			return {
				summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
				appliedFile: hunk.movePath,
				fuzz: chunkResult.fuzz,
				matches: Math.max(1, chunkResult.matches),
				firstMatchLine: chunkResult.firstMatchLine,
				noOp: nextContent === currentContent,
			};
		}

		if (!dryRun) {
			await writeFileAtomic(absolutePath, nextContent);
		}
		return {
			summary: `update: ${hunk.filePath}`,
			appliedFile: hunk.filePath,
			fuzz: chunkResult.fuzz,
			matches: Math.max(1, chunkResult.matches),
			firstMatchLine: chunkResult.firstMatchLine,
			noOp: nextContent === currentContent,
		};
	};
	return withPatchFileMutationQueues(mutationPaths, run);
}

export async function applyPatchDetailed(
	cwd: string,
	patchText: string,
	onProgress?: ApplyPatchProgressCallback,
	options?: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
	return applyParsedPatchDetailed(cwd, parseNonEmptyPatch(patchText), onProgress, options);
}

async function applyParsedPatchDetailed(
	cwd: string,
	hunks: ParsedPatch[],
	onProgress?: ApplyPatchProgressCallback,
	options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const failures: ApplyPatchFailure[] = [];
	let fuzz = 0;
	const noOps: string[] = [];
	const warnings: string[] = [];

	// Validation pass: ensure every hunk applies before mutating anything (all-or-nothing).
	const validationFailures: ApplyPatchFailure[] = [];
	for (const hunk of hunks) {
		try {
			await applySingleHunk(cwd, hunk, true, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code =
				error && typeof error === "object" && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			validationFailures.push({ filePath: hunk.filePath, operation: hunk.type, message, code });
		}
	}
	if (validationFailures.length > 0) {
		const result: ApplyPatchResult = {
			summaries,
			appliedFiles,
			failures: validationFailures,
			hasPartialSuccess: false,
			recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: [], warnings: [], noOps: [] },
			details: { fuzz: 0, warnings: [], noOps: [] },
		};
		result.recoveryInstructions = createRecoveryInstructions(result);
		return result;
	}

	for (const hunk of hunks) {
		try {
			const { summary, appliedFile, fuzz: hunkFuzz, matches, firstMatchLine, noOp } = await applySingleHunk(cwd, hunk, false, options);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
			fuzz += hunkFuzz;
			if (noOp) {
				noOps.push(appliedFile);
			}
			if (matches > 1) {
				warnings.push(`${hunk.filePath}: pattern matched ${matches} places, applied at the first (line ${firstMatchLine ?? "?"}). Include more surrounding lines to disambiguate.`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code =
				error && typeof error === "object" && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			failures.push({ filePath: hunk.filePath, operation: hunk.type, message, code });
		}
		await notifyApplyPatchProgress(onProgress, {
			applied: appliedFiles.length,
			failed: failures.length,
			total: hunks.length,
		});
	}

	const result: ApplyPatchResult = {
		summaries,
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: [], warnings: [], noOps: [] },
		details: { fuzz, warnings, noOps },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

function isRereadCandidate(failure: ApplyPatchFailure): boolean {
	// ENOENT (missing file), EACCES/EPERM (permission), ENOTDIR/EISDIR (path) are
	// not context mismatches — rereading will not fix them. Only context-line
	// failures (no code, thrown by replaceChunks) benefit from a reread.
	return failure.code === undefined;
}

function createRecoveryInstructions(
	result: Pick<ApplyPatchResult, "appliedFiles" | "failures" | "details">,
): ApplyPatchRecoveryInstructions {
	const mustReadFiles = [...new Set(result.failures.filter(isRereadCandidate).map((failure) => failure.filePath))];
	const mustReadFileSet = new Set(mustReadFiles);
	const failedFileSet = new Set(result.failures.map((failure) => failure.filePath));
	const mustNotReadFiles = [...new Set(result.appliedFiles.filter((filePath) => !mustReadFileSet.has(filePath)))];
	return {
		mustReadFiles,
		mustNotReadFiles,
		failedFiles: [...failedFileSet],
		warnings: result.details.warnings,
		noOps: result.details.noOps,
	};
}

export async function applyPatch(cwd: string, patchText: string, options?: ApplyPatchOptions): Promise<string[]> {
	const hunks = parseNonEmptyPatch(patchText);

	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	for (const hunk of hunks) {
		try {
			const { summary, appliedFile } = await applySingleHunk(cwd, hunk, false, options);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code =
				error && typeof error === "object" && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			const failure = { filePath: hunk.filePath, operation: hunk.type, message, code } satisfies ApplyPatchFailure;
			const result: ApplyPatchResult = {
				summaries,
				appliedFiles,
				failures: [failure],
				hasPartialSuccess: appliedFiles.length > 0,
				recoveryInstructions: createRecoveryInstructions({
					appliedFiles,
					failures: [failure],
					details: { fuzz: 0, warnings: [], noOps: [] },
				}),
				details: { fuzz: 0, warnings: [], noOps: [] },
			};
			throw new ApplyPatchError(message, result);
		}
	}

	return summaries;
}

async function createPendingPatchUpdate(
	cwd: string,
	patchText: string,
	progress?: ApplyPatchProgress,
	previewOverride?: ApplyPatchPreview,
	parsedHunks?: ParsedPatch[],
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const title = progress
		? `Applying patch (${progress.applied + progress.failed}/${progress.total})...`
		: "Applying patch...";
	if (previewOverride) {
		const details: ApplyPatchToolDetails = { preview: previewOverride };
		if (progress) details.progress = progress;
		return {
			text: `${title}\n${formatPatchPreview(previewOverride, cwd)}`,
			details,
		};
	}

	try {
		const hunks = parsedHunks ?? parsePatch(patchText);
		if (hunks.length === 0) {
			return { text: title, details: progress ? { progress } : undefined };
		}

		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some((file) => file.diff.trim().length > 0)) {
			const details: ApplyPatchToolDetails = { preview };
			if (progress) details.progress = progress;
			return { text: `${title}\n${formatPatchPreview(preview, cwd)}`, details };
		}
	} catch {
		return {
			text: progress ? title : formatPendingPatchPaths(patchText),
			details: progress ? { progress } : undefined,
		};
	}

	return { text: progress ? title : formatPendingPatchPaths(patchText), details: progress ? { progress } : undefined };
}

/** Tool set the extension manages: `apply_patch` plus Pi's built-in file editors. */
const APPLY_PATCH_TOOL_NAME = "apply_patch";

/**
 * Which tools the extension declares to the model.
 * - `additive`: `apply_patch` next to `edit`/`write` (default).
 * - `replace`: `apply_patch` instead of `edit`/`write`.
 * - `off`: only `edit`/`write`; `apply_patch` stays registered but is not declared to the model.
 */
export type ApplyPatchToolset = "additive" | "replace" | "off";

export const APPLY_PATCH_TOOLSETS: readonly ApplyPatchToolset[] = ["additive", "replace", "off"];

const DEFAULT_APPLY_PATCH_TOOLSET: ApplyPatchToolset = "additive";

/**
 * What to do when a chunk's context lines match several places in the file.
 * - `reject` (default): fail before writing anything and name the duplicate lines.
 * - `first`: apply at the first occurrence and report an ambiguity warning.
 */
export type ApplyPatchAmbiguity = "reject" | "first";

export const APPLY_PATCH_AMBIGUITIES: readonly ApplyPatchAmbiguity[] = ["reject", "first"];

export const DEFAULT_APPLY_PATCH_AMBIGUITY: ApplyPatchAmbiguity = "reject";

/** User-level config file: `~/.pi/agent/apply-patch.json`. */
const CONFIG_FILE_NAME = "apply-patch.json";

export function isApplyPatchToolset(value: unknown): value is ApplyPatchToolset {
	return value === "additive" || value === "replace" || value === "off";
}

export function isApplyPatchAmbiguity(value: unknown): value is ApplyPatchAmbiguity {
	return value === "reject" || value === "first";
}

function resolveAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) {
		return path.join(homedir(), ".pi", "agent");
	}
	if (configured === "~") {
		return homedir();
	}
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return path.join(homedir(), configured.slice(2));
	}
	return configured;
}

export function applyPatchConfigPath(): string {
	return path.join(resolveAgentDir(), CONFIG_FILE_NAME);
}

/** Raw config object; unreadable or malformed files are treated as empty. */
async function readApplyPatchConfigObject(): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(applyPatchConfigPath(), "utf-8"));
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Read the configured toolset. A missing or malformed file falls back to `additive`. */
export async function readApplyPatchToolset(): Promise<ApplyPatchToolset> {
	const config = await readApplyPatchConfigObject();
	return isApplyPatchToolset(config.toolset) ? config.toolset : DEFAULT_APPLY_PATCH_TOOLSET;
}

/** Read the configured ambiguity policy. Missing or malformed falls back to `reject`. */
export async function readApplyPatchAmbiguity(): Promise<ApplyPatchAmbiguity> {
	const config = await readApplyPatchConfigObject();
	return isApplyPatchAmbiguity(config.ambiguous) ? config.ambiguous : DEFAULT_APPLY_PATCH_AMBIGUITY;
}

/** Merge keys into the config file, preserving every key this version does not know about. */
export async function writeApplyPatchConfig(patch: Record<string, unknown>): Promise<void> {
	const filePath = applyPatchConfigPath();
	const next = { ...(await readApplyPatchConfigObject()), ...patch };
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

export async function writeApplyPatchToolset(toolset: ApplyPatchToolset): Promise<void> {
	await writeApplyPatchConfig({ toolset });
}

function isExtensionManagedTool(toolName: string): boolean {
	return toolName === APPLY_PATCH_TOOL_NAME || STANDARD_EDIT_TOOL_NAMES.some((editToolName) => editToolName === toolName);
}

/** Rewrite a tool list for the given toolset, keeping the order of tools it does not manage. */
export function applyApplyPatchToolset(toolNames: string[], toolset: ApplyPatchToolset): string[] {
	const wanted = new Set<string>();
	if (toolset !== "off") {
		wanted.add(APPLY_PATCH_TOOL_NAME);
	}
	if (toolset !== "replace") {
		for (const editToolName of STANDARD_EDIT_TOOL_NAMES) {
			wanted.add(editToolName);
		}
	}
	const next = toolNames.filter((toolName) => !isExtensionManagedTool(toolName) || wanted.has(toolName));
	for (const toolName of wanted) {
		if (!next.includes(toolName)) {
			next.push(toolName);
		}
	}
	return next;
}

function resolvePatchPath(cwd: string, filePath: string): string {
	return path.resolve(cwd, filePath);
}

async function canonicalMutationPath(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return path.resolve(filePath);
		}
		throw error;
	}
}

async function withPatchFileMutationQueues<T>(filePaths: string[], operation: () => Promise<T>): Promise<T> {
	const canonicalPaths = await Promise.all(filePaths.map(canonicalMutationPath));
	const sortedPaths = [...new Set(canonicalPaths)].sort((left, right) => left.localeCompare(right));

	const runQueued = (index: number): Promise<T> => {
		const filePath = sortedPaths[index];
		if (filePath === undefined) {
			return operation();
		}
		return withFileMutationQueue(filePath, () => runQueued(index + 1));
	};

	return runQueued(0);
}

/**
 * Enforce the configured toolset on the live session and return it.
 * Runs on session start, model switch, before every agent run, and from the `/apply-patch` command.
 */
async function syncToolset(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	toolset?: ApplyPatchToolset,
): Promise<ApplyPatchToolset> {
	const resolved = toolset ?? (await readApplyPatchToolset());
	pi.setActiveTools(applyApplyPatchToolset(pi.getActiveTools(), resolved));
	return resolved;
}

function describeToolset(toolset: ApplyPatchToolset): string {
	switch (toolset) {
		case "additive":
			return "additive — apply_patch plus edit/write";
		case "replace":
			return "replace — apply_patch instead of edit/write";
		case "off":
			return "off — edit/write only, apply_patch hidden";
	}
}

export function createApplyPatchTool(): ApplyPatchToolDefinition {
	const tool = defineTool({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMS,
		// Pi's public grammar hook: models whose provider sets `compat.supportsOpenAIGrammarTools`
		// receive apply_patch as a native OpenAI custom tool constrained by the Codex Lark grammar.
		// Other providers fall back to the plain function tool.
		constrainedSampling: { type: "grammar", variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR } },
		prepareArguments: normalizeApplyPatchArguments,
		promptSnippet: "Apply Codex-format file patches with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
			"In *** Add File *** hunks there is no @@ line: every content line, including blank ones, must start with +.",
			"An anchor that matches several places is unsafe: extend the hunk with unique surrounding lines until the pattern matches exactly one place. Use '*** End of File' to target the last occurrence explicitly.",
			"Rename/remove/'everywhere'/'all files' → pass `verify` in the SAME call (mustNotContain the old name, mustContain the new one across a glob) instead of reading or grepping afterwards; a VERIFY_FAIL means the write happened but the invariant does not hold.",
			"After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
		],
		async execute(
			_toolCallId,
			params,
			_signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<ApplyPatchToolDetails | undefined>> {
			const normalizedParams = normalizeApplyPatchArguments(params);
			if (!normalizedParams.input) {
				throw new Error("input is required");
			}

			let parsedHunks: ParsedPatch[] | undefined;
			try {
				parsedHunks = parseNonEmptyPatch(normalizedParams.input);
			} catch {
				// createPendingPatchUpdate keeps incomplete or invalid patch text renderable.
			}
			const totalOperations = parsedHunks?.length ?? 0;
			const initialProgress = totalOperations > 0 ? { applied: 0, failed: 0, total: totalOperations } : undefined;
			const pendingUpdate = await createPendingPatchUpdate(
				ctx.cwd,
				normalizedParams.input,
				initialProgress,
				undefined,
				parsedHunks,
			);
			onUpdate?.({
				content: [{ type: "text", text: pendingUpdate.text }],
				details: pendingUpdate.details,
			});

			const preview = pendingUpdate.details?.preview;
			const rejectAmbiguous = (await readApplyPatchAmbiguity()) === "reject";
			const result = await applyParsedPatchDetailed(
				ctx.cwd,
				parsedHunks ?? parseNonEmptyPatch(normalizedParams.input),
				async (progress) => {
					const progressUpdate = await createPendingPatchUpdate(
						ctx.cwd,
						normalizedParams.input,
						progress,
						preview,
						parsedHunks,
					);
					onUpdate?.({
						content: [{ type: "text", text: progressUpdate.text }],
						details: progressUpdate.details,
					});
				},
				{ rejectAmbiguous },
			);
			if (result.failures.length > 0) {
				const failureLines = result.failures.map(
					(failure) => `- ${failure.filePath} (${failure.operation}): ${failure.message}`,
				);
				const mustReadFiles = result.recoveryInstructions.mustReadFiles;
				const mustReadText = mustReadFiles.join(" and ");
				return {
					content: [
						{
							type: "text",
							text: [
								result.hasPartialSuccess ? "apply_patch partially failed." : "apply_patch failed.",
								"Failed:",
								...failureLines,
								mustReadFiles.length > 0 ? `Recovery: MUST read ${mustReadText} before retrying.` : "",
								result.appliedFiles.length > 0
									? "Earlier file actions in this patch were already applied."
									: "No file actions were applied.",
								result.recoveryInstructions.mustNotReadFiles.length > 0
									? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
									: "",
							]
								.filter((line) => line.length > 0)
								.join("\n"),
						},
					],
					isError: true,
					details: preview ? { preview, result } : { result },
				};
			}

			const postLines = [
				...result.recoveryInstructions.warnings,
				...(result.recoveryInstructions.noOps.length > 0
					? [`No-op for: ${result.recoveryInstructions.noOps.join(", ")} (content was already identical).`]
					: []),
				...(normalizedParams.verifyDropped ? [IGNORED_VERIFY_LINE] : []),
			];

			const finalized = await finalizeSuccessfulPatch(ctx.cwd, result, normalizedParams.verify, postLines);
			const details: ApplyPatchToolDetails = finalized.verification
				? preview
					? { preview, result, verification: finalized.verification }
					: { result, verification: finalized.verification }
				: preview
					? { preview, result }
					: { result };
			return {
				content: [
					{ type: "text", text: finalized.lines.join("\n") },
				],
				...(finalized.isError ? { isError: true } : {}),
				details,
			};
		},
		renderCall(args, theme, context) {
			const title = theme.fg("toolTitle", theme.bold("apply_patch"));
			if (!context.argsComplete) {
				return new Text(`${title} ${theme.fg("muted", "patching…")}`, 0, 0);
			}

			const normalizedArgs = normalizeApplyPatchArguments(args);
			const renderState = getApplyPatchRenderState(context.toolCallId, context.cwd, normalizedArgs.input);
			if (renderState.callText.length === 0) {
				return new Text(title, 0, 0);
			}
			return new Text(`${title} ${theme.fg("muted", `· ${renderState.callText}`)}`, 0, 0);
		},
		renderResult(result, options, theme, context) {
			const component = new Container();
			component.addChild(new Spacer(1));
			const details = result.details;
			const preview = details?.preview;
			const patchResult = details?.result;
			const verification = details?.verification;
			const failures = patchResult?.failures ?? [];
			const verifyFailures = verification?.failures ?? [];
			const patchFailed = failures.length > 0;
			const verifyFailed = verifyFailures.length > 0;
			const partialSuccess = patchResult?.hasPartialSuccess ?? false;
			const ambiguousFailure = failures.some((failure) => failure.message.startsWith("Ambiguous anchor"));
			const progress = details?.progress;
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => (typeof block.text === "string" ? block.text : ""))
				.filter((value) => value.length > 0)
				.join("\n");

			const title = progress
				? `Applying patch (${progress.applied + progress.failed}/${progress.total})`
				: options.isPartial
					? "Applying patch"
					: patchFailed
						? partialSuccess
							? "Patch partially failed"
							: ambiguousFailure
								? "Patch rejected · ambiguous anchor"
								: "Patch failed"
						: verifyFailed
							? "Patch applied · verification failed"
							: "Applied patch";
			component.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));

			if (!preview) {
				if (!options.isPartial && text.length > 0) {
					component.addChild(new Spacer(1));
					component.addChild(new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0));
				}
				return component;
			}

			// A patch that failed before writing anything has no diff to show: the error is the output.
			const showPreview = !patchFailed || partialSuccess;
			if (showPreview) {
				const appliedFiles = patchResult ? new Set(patchResult.appliedFiles) : undefined;
				const files = appliedFiles
					? preview.files.filter(
							(file) =>
								appliedFiles.has(file.filePath) ||
								(file.movePath !== undefined && appliedFiles.has(file.movePath)),
						)
					: preview.files;
				const body = renderPatchPreview({ ...preview, files }, context.cwd, theme, options.expanded);
				if (body.length > 0) {
					component.addChild(new Spacer(1));
					component.addChild(new Text(body, 0, 0));
				}
			}

			if (options.isPartial) {
				return component;
			}

			if (patchFailed || verifyFailed) {
				if (text.length > 0) {
					component.addChild(new Spacer(1));
					component.addChild(new Text(theme.fg("error", text), 0, 0));
				}
				return component;
			}

			// The long content string (summaries) is redundant with the headers; only the notices that
			// are invisible elsewhere in the TUI are repeated here.
			const warningLines = patchResult?.recoveryInstructions.warnings ?? [];
			const mutedLines = [
				...(patchResult && patchResult.recoveryInstructions.noOps.length > 0
					? [
							`No-op for: ${patchResult.recoveryInstructions.noOps.join(", ")} (content was already identical).`,
						]
					: []),
				...(verification
					? [
							`VERIFY_OK checks=${verification.checks} files=${verification.scannedFiles}`,
							...verification.warnings.map((warning) => `note: ${warning}`),
						]
					: []),
			];
			if (warningLines.length > 0) {
				component.addChild(new Spacer(1));
				component.addChild(new Text(theme.fg("warning", warningLines.join("\n")), 0, 0));
			}
			if (mutedLines.length > 0) {
				component.addChild(new Spacer(1));
				component.addChild(new Text(theme.fg("muted", mutedLines.join("\n")), 0, 0));
			}
			return component;
		},
	});

	return Object.assign(tool, {
		freeform: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		} satisfies FreeformToolFormat,
	});
}

function describeAmbiguity(ambiguity: ApplyPatchAmbiguity): string {
	return ambiguity === "reject"
		? "reject - a pattern that matches several places fails the patch before writing"
		: "first - a pattern that matches several places edits the first one and reports a warning";
}

export function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
	pi.registerTool(createApplyPatchTool());

	pi.on("session_start", async () => {
		await syncToolset(pi);
	});

	pi.on("model_select", async () => {
		await syncToolset(pi);
	});

	pi.on("before_agent_start", async () => {
		await syncToolset(pi);
	});

	pi.registerCommand("apply-patch", {
		description:
			"Choose the file-editing toolset (additive/replace/off) or the ambiguous-anchor policy (reject/first)",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmed = argumentPrefix.trimStart();
			const [head, ...rest] = trimmed.split(/\s+/);
			if (head === "ambiguity") {
				const valuePrefix = (rest[0] ?? "").trim();
				return APPLY_PATCH_AMBIGUITIES.filter((ambiguity) => ambiguity.startsWith(valuePrefix)).map(
					(ambiguity) => ({
						value: `ambiguity ${ambiguity}`,
						label: ambiguity,
						description: describeAmbiguity(ambiguity),
					}),
				);
			}
			const completions: Array<{ value: string; label: string; description: string }> = APPLY_PATCH_TOOLSETS.filter(
				(toolset) => toolset.startsWith(trimmed),
			).map((toolset) => ({
				value: toolset,
				label: toolset,
				description: describeToolset(toolset),
			}));
			if ("ambiguity".startsWith(trimmed)) {
				completions.push({
					value: "ambiguity ",
					label: "ambiguity",
					description: "Ambiguous-anchor policy: reject (default) or first",
				});
			}
			return completions;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			const report = async (toolset: ApplyPatchToolset) => {
				const ambiguity = await readApplyPatchAmbiguity();
				ctx.ui.notify(
					[
						`toolset: ${describeToolset(toolset)}`,
						`ambiguity: ${describeAmbiguity(ambiguity)}`,
						`active tools: ${pi.getActiveTools().join(", ")}`,
						`config: ${applyPatchConfigPath()}`,
					].join("\n"),
					"info",
				);
			};

			if (requested === "ambiguity" || requested.startsWith("ambiguity ")) {
				const values = requested.split(/\s+/);
				const value = values[1];
				if (value === undefined || value === "status") {
					const current = await readApplyPatchAmbiguity();
					ctx.ui.notify(
						[
							`ambiguity: ${describeAmbiguity(current)}`,
							`config: ${applyPatchConfigPath()}`,
							"set it with /apply-patch ambiguity reject or /apply-patch ambiguity first",
						].join("\n"),
						"info",
					);
					return;
				}
				if (!isApplyPatchAmbiguity(value)) {
					ctx.ui.notify(
						`Unknown ambiguity policy "${value}". Use one of: ${APPLY_PATCH_AMBIGUITIES.join(", ")}.`,
						"warning",
					);
					return;
				}
				await writeApplyPatchConfig({ ambiguous: value });
				ctx.ui.notify(`ambiguity: ${describeAmbiguity(value)}\nconfig: ${applyPatchConfigPath()}`, "info");
				return;
			}

			if (requested === "" || requested === "status") {
				const current = await readApplyPatchToolset();
				if (requested === "status") {
					await report(current);
					return;
				}
				const labels = APPLY_PATCH_TOOLSETS.map((toolset) => describeToolset(toolset));
				const picked = await ctx.ui.select(`apply_patch toolset (current: ${current})`, [
					...labels,
					"status — show the current setting and active tools",
				]);
				const pickedToolset = APPLY_PATCH_TOOLSETS.find((toolset) => picked?.startsWith(toolset));
				if (pickedToolset === undefined) {
					await report(current);
					return;
				}
				await writeApplyPatchToolset(pickedToolset);
				await report(await syncToolset(pi, pickedToolset));
				return;
			}

			if (!isApplyPatchToolset(requested)) {
				ctx.ui.notify(
					`Unknown toolset "${requested}". Use one of: ${APPLY_PATCH_TOOLSETS.join(", ")} (or run /apply-patch without arguments).`,
					"warning",
				);
				return;
			}

			await writeApplyPatchToolset(requested);
			await report(await syncToolset(pi, requested));
		},
	});
}

export default registerApplyPatchExtension;

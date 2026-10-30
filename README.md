# pi-apply-patch

A [Pi](https://github.com/earendil-works/pi) extension that adds an `apply_patch` tool: the Codex-format, freeform file-editing tool, with atomic writes and precise failure reporting.

By default the tool is **additive** — the model sees `apply_patch` next to Pi's built-in `edit` / `write`. It can also replace those tools or be switched off at runtime; see [Toolset](#toolset).

## Requirements

- Pi `@earendil-works/pi-coding-agent` 1.3.0 or newer (verified on 1.4.0).
- `diff` and `typebox` resolvable from the extension folder.

When the extension is loaded straight out of a git checkout, `diff` comes from an `npm install` there
— a git-installed package is not dependency-installed automatically. Without it the extension fails to
load (`Cannot find module 'diff'`) and `apply_patch` silently disappears from the toolset while every
other tool keeps working, so the failure is easy to miss. `node_modules/` in that checkout is a working
dependency, not build output.

## The tool

`apply_patch` takes one freeform string (not JSON), wrapped in an envelope:

```
*** Begin Patch
*** Add File: hello.txt
+Hello world.
*** Update File: example.txt
@@
 Hello from the original text file.
+Second line added.
*** End Patch
```

Three hunk types:

| Hunk | What it does |
| --- | --- |
| `*** Add File: <path>` | Creates a file. No `@@` line; every content line starts with `+` (a blank file line is a lone `+`). Refuses to overwrite an existing path. |
| `*** Update File: <path>` | Edits in place, optionally followed by `*** Move to: <path>`. Each chunk starts with a bare `@@`; unchanged lines are prefixed with one space, removals with `-`, additions with `+`. Context must match the file exactly. `@@ <text>` is not a comment: `<text>` must be a line that exists in the file (it is searched as an anchor and the block is rejected when it is absent), but it does not steer placement — the `-`/` ` lines below it do. |
| `*** Delete File: <path>` | Deletes a file. Header only, no body. |

One patch may hold hunks for several files. Chunks inside a single `Update File` apply top to bottom, so a later chunk sees the result of the previous one.

### Arguments

| Argument | Required | What it is |
| --- | --- | --- |
| `input` | yes | The patch text above — the whole `*** Begin Patch` … `*** End Patch` envelope. |
| `verify` | no | Post-write assertions checked in the same call (see below). |

### `verify` — assert the invariant the diff cannot prove

A patch proves that it *matched*; it cannot prove a property now holds for the whole project — that a
removed name occurs nowhere else, or that a heading survived a renumbering. `verify` closes that gap in
the same round-trip (`verify.ts`):

```json
"verify": [
  { "path": "**/*.md", "mustNotContain": ["Work mode", "FAST"] },
  { "path": "project/AGENTS.md", "mustContain": ["Evidence"] }
]
```

| Field | Meaning |
| --- | --- |
| `path` | Scope: a file, a directory (recursive), or a glob (`**` spans directories, `*`/`?` stay inside one segment). Omitting it checks only the files this patch wrote. |
| `mustContain` | Each substring must appear at least once in the scope. A bare string is accepted for one needle. |
| `mustNotContain` | Each substring must appear nowhere in the scope. A bare string is accepted for one needle. |
Limits (silently applied, never a failure): 20 checks, 20 needles per check, 200 chars per needle, 2000
files scanned, 2 MB per file, binary files skipped. Needles are case-sensitive literal substrings per
line — no regex, no shell, nothing to escape.

The verdict is one machine-stable line:

```
VERIFY_OK checks=2 files=3
VERIFY_FAIL 1 of 2 check(s) — patch applied, invariant does not hold
- mustNotContain "Work mode" still present: project/AGENTS.md:28, project/.ai_memory/active_task.md:8
Fix the file(s) above with another apply_patch call (no re-read needed: the hits give file:line), or drop the check if the invariant was wrong.
```

A failing check sets `isError: true` but does **not** roll the write back: the change is on disk and the
message names `file:line` for the next call. Without `verify`, behaviour is byte-identical to before.

`verify` sent with a `path` but no needles is **not** treated as a pass: the result carries
`VERIFY_SKIPPED — … this is not a pass`, with the exact shape to resend. Small models do drop nested
arrays, so this is the common real-world failure, and silence would be a lie.

### What happens on failure

- **Failures are real errors.** A rejected or partially applied patch returns the tool result with `isError: true`, so codemode scripts and other callers see a rejected promise instead of a success string containing "failed".
- **Nothing is written when a hunk does not match.** On a context mismatch the tool reports the closest matching window (1-based line number, matched/total lines, match percent), shows only the differing expected/actual line pairs, and gives explicit accept/decline guidance.
- **No silent overwrite.** `Add File` onto an existing path is rejected together with the whole patch; use `Update File`, or `Delete File` first.
- **Ambiguity is reported.** When a chunk matches several places, the result says so, with the occurrence count and the line the edit landed on.
- **No-ops are reported.** A hunk that leaves the file byte-identical is reported as a no-op instead of a silent success.
- **Atomic writes.** Files are written through a temp file plus rename, serialized per path, with a retry for the Windows `EPERM` case.

### Prompt integration

The description is written for a model that has never seen the tool: it states the envelope first, then
the line rules where patches actually fail (one `' '`/`-`/`+` per line, no unified-diff ranges, verbatim
context, top-to-bottom chunk order), then `verify`, then a full multi-hunk example, and ends with the two
anti-patterns — re-reading files to confirm a patch, and retrying a failed patch unchanged. Prompt
guidelines add the short forms (Add File has no `@@`; an ambiguous anchor matches the first occurrence;
use `verify` instead of a follow-up grep). On providers that support OpenAI grammar tools the patch is
constrained by the Codex Lark grammar; everyone else gets the plain function tool.

## Tests

```sh
node lab/verify.test.mjs        # verify.ts: scopes, globs, needles, verdict formatting — 24 checks, no SDK
node lab/description.test.mjs   # the description's worked example must apply; every rule it states must hold — 19 checks
node lab/claims.test.mjs        # behavioural claims in the docs: rewrite routes, @@ anchors, verify gating — 9 checks
node lab/e2e-jiti.test.mjs      # index.ts through jiti: real patch + verify round-trip — 14 checks
```

The first two suites are the guard against a lying prompt: `description.test.mjs` extracts the example
out of the tool description, applies it to a matching fixture, and asserts each prose rule the
description states; `claims.test.mjs` does the same for behavioural claims in this README (the two
whole-file rewrite routes, what `@@ <text>` really does, `verify` being skipped on a failed patch). The
SDK-dependent suites load `index.ts` through `jiti` exactly as Pi does, so they need `diff`, `typebox` and
the Pi packages resolvable from the extension folder. The older `lab/run*.mjs` scripts run against a
prebuilt `lab/out/`.

## Toolset

Which file-editing tools the model sees is a setting, switchable inside a session:

| Mode | Tools declared to the model |
| --- | --- |
| `additive` (default) | `apply_patch` **and** `edit` / `write` |
| `replace` | `apply_patch` instead of `edit` / `write` |
| `off` | only `edit` / `write`; `apply_patch` stays registered but is not declared |

### In a session

```
/apply-patch                     # pick from a list
/apply-patch status              # current mode, active tools, config path
/apply-patch additive
/apply-patch replace
/apply-patch off
```

Argument completion is available (`/apply-patch rep<Tab>`). A change applies immediately — no `/reload` — and prints the mode, the resulting active tools and the config path. An unknown argument is rejected with a warning and changes nothing.

### Config file

The mode is read from `<agent-dir>/apply-patch.json` (usually `~/.pi/agent/apply-patch.json`; `PI_CODING_AGENT_DIR` is honored):

```json
{
  "toolset": "additive"
}
```

`/apply-patch <mode>` rewrites this file, so the choice is global for new sessions too. A missing or malformed file falls back to `additive`. The extension re-applies the mode on `session_start`, on model switch, and before every agent run, so it also corrects a tool set restored from an old session transcript.

## Install

1. Clone the repo into your Pi extensions folder so the folder name matches the package name:

   ```
   git clone https://github.com/dnnkeeper/pi-apply-patch.git "<agent-dir>/extensions/pi-apply-patch"
   ```

   `<agent-dir>` is usually `~/.pi/agent`.

2. Make sure `diff` and `typebox` resolve from that folder, for example:

   ```
   npm install diff typebox
   ```

3. Register the package in `<agent-dir>/settings.json`:

   ```json
   {
     "packages": ["pi-apply-patch", "..."]
   }
   ```

4. Restart Pi or run `/reload`. `apply_patch` is then available next to `edit` / `write`; use `/apply-patch` to change the toolset.

## Update

```
git pull
```

inside the extension folder, then `/reload` in Pi.

## Files

- `index.ts` — tool definition, patch parsing, application, toolset command and config.
- `line-endings.ts` — line-ending helpers.
- `write-file-atomic.ts` — atomic file writes.
- `lab/` — ad-hoc patch-application test scripts.
- `LICENSE` — license text.

`node_modules/` and editor backups (`*.bak`) are intentionally not committed.

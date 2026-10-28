# pi-apply-patch

A [Pi](https://github.com/earendil-works/pi) extension that adds an `apply_patch` tool: the Codex-format, freeform file-editing tool, with atomic writes and precise failure reporting.

By default the tool is **additive** — the model sees `apply_patch` next to Pi's built-in `edit` / `write`. It can also replace those tools or be switched off at runtime; see [Toolset](#toolset).

## Requirements

- Pi `@earendil-works/pi-coding-agent` 1.3.0 or newer (verified on 1.4.0).
- `diff` and `typebox` resolvable from the extension folder.

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
| `*** Update File: <path>` | Edits in place, optionally followed by `*** Move to: <path>`. Each chunk starts with a bare `@@`; unchanged lines are prefixed with one space, removals with `-`, additions with `+`. Context must match the file exactly. |
| `*** Delete File: <path>` | Deletes a file. Header only, no body. |

One patch may hold hunks for several files. Chunks inside a single `Update File` apply top to bottom, so a later chunk sees the result of the previous one.

### What happens on failure

- **Failures are real errors.** A rejected or partially applied patch returns the tool result with `isError: true`, so codemode scripts and other callers see a rejected promise instead of a success string containing "failed".
- **Nothing is written when a hunk does not match.** On a context mismatch the tool reports the closest matching window (1-based line number, matched/total lines, match percent), shows only the differing expected/actual line pairs, and gives explicit accept/decline guidance.
- **No silent overwrite.** `Add File` onto an existing path is rejected together with the whole patch; use `Update File`, or `Delete File` first.
- **Ambiguity is reported.** When a chunk matches several places, the result says so, with the occurrence count and the line the edit landed on.
- **No-ops are reported.** A hunk that leaves the file byte-identical is reported as a no-op instead of a silent success.
- **Atomic writes.** Files are written through a temp file plus rename, serialized per path, with a retry for the Windows `EPERM` case.

### Prompt integration

The tool ships a rich description (all three hunk types plus a two-file example), so models guess the patch format less often, and prompt guidelines that remind the model to use `apply_patch` instead of mutating files through `bash` or scripts, and how to disambiguate duplicate blocks. On providers that support OpenAI grammar tools the patch is constrained by the Codex Lark grammar; everyone else gets the plain function tool.

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

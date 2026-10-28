# pi-apply-patch

`apply_patch` extension for the Pi coding agent. Applies Codex-format file patches (`Add` / `Update` / `Delete`) with atomic writes and helpful errors. Replaces the built-in `edit` / `write` tools.

## Features

1. **Failures are real errors.** A rejected or partially applied patch returns the tool result with `isError: true`, so programmatic callers (codemode scripts) see a rejected promise instead of a success string containing "apply_patch failed".
2. **Closest-match errors.** When an `Update` anchor does not match the file, the tool reports the closest matching window (1-based line number, matched/total lines, match percent), shows only the differing expected/actual line pairs, and gives explicit accept/decline guidance. Nothing is written on mismatch, and there are no giant dumps.
3. **No silent overwrite by Add File.** `Add File` onto an existing path is rejected (with the whole patch) instead of destroying the file. Use `Update File`, or `Delete File` first.
4. **Sequential chunks.** Chunks of one `Update File` hunk apply top-to-bottom: each chunk sees the file after the previous chunks, so dependent hunks (`-one`/`+ONE`, then `-ONE`/`+ONE-CHAIN`) work.
5. **Ambiguity warnings.** When a pattern matches several places in the file, the result says so with the occurrence count and the line the edit landed on, instead of silently applying to the first occurrence.
6. **No-op detection.** A hunk that leaves the content byte-identical is reported as a no-op instead of a silent "success".
7. **Richer tool description.** The tool spec documents all three hunk types and includes a two-file example, so models guess the patch format less often:
   - `Add File`: no `@@` line, and EVERY content line must start with `+` (a blank file line is a lone `+`).
   - `Update File`: each hunk starts with a bare `@@` line; unchanged lines get a single-space prefix, removals `-`, additions `+`. Context must match the file exactly.
   - `Delete File`: header only, no body.
8. **Prompt guidelines.** Reminders for `Add File` syntax and for disambiguating duplicate blocks (ambiguous anchors match the first occurrence).

## Install

1. Clone this repo into your Pi extensions folder so that the folder name matches the package name:
   `git clone https://github.com/dnnkeeper/pi-apply-patch.git "<agent-dir>/extensions/pi-apply-patch"`
   (`<agent-dir>` is usually `~/.pi/agent`.)
2. Make sure the `diff` and `typebox` packages can be resolved from that folder (for example, run `npm install diff typebox` inside it).
3. Register the package in `<agent-dir>/settings.json`:
   `"packages": [ ..., "pi-apply-patch", ... ]`
4. Reload Pi (`/reload`). The `edit` / `write` tools are then replaced by `apply_patch`.

## Update

Run `git pull` inside the extension folder, then `/reload` Pi.

## Files

- `index.ts` - tool definition, patch parsing and application.
- `line-endings.ts` - line-ending helpers.
- `write-file-atomic.ts` - atomic file writes.
- `LICENSE` - license text.

`node_modules/` and editor backups (`*.bak`) are intentionally not committed.

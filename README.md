# pi-apply-patch (local fork)

A local fork of the Pi coding-agent `apply_patch` extension, tuned for fewer model mistakes and more actionable errors.

Source of the live copy: `C:/Users/dnnke/.pi/agent/extensions/pi-apply-patch-local/`.
To install, copy `index.ts`, `line-endings.ts` and `write-file-atomic.ts` into your Pi `agent/extensions/` directory and reload Pi.

## Local changes vs upstream

1. **Closest-match error instead of opaque failure.** When an `Update File` hunk anchor does not match, the tool no longer dumps the whole expected block. It reports the closest window (1-based line, matched/total, percent), the first differing expected/actual line pairs only, and explicit accept/decline guidance. Nothing is written on mismatch.
2. **Richer tool description.** The `apply_patch` description now documents all three hunk types (`Add File` without `@@` and with `+` on every line, `Update File` with a bare `@@`, `Delete File` header-only) plus a two-file example, so models guess the format less often.
3. **Extra prompt guideline.** `Add File` hunks carry no `@@` line; every content line, including blank ones, must start with `+`.

## Files

- `index.ts` - extension entry point, tool definition, patch parsing and application.
- `line-endings.ts` - line-ending helpers (the live copy uses CRLF).
- `write-file-atomic.ts` - atomic file writes.
- `LICENSE` - upstream license.

`node_modules/` and editor backups (`.bak`) are intentionally not committed.

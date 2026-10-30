// End-to-end: real index.ts (loaded through jiti, like Pi does) + `verify` assertions.
// Run: node lab/e2e-jiti.test.mjs
import { createJiti } from "jiti";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const mod = await jiti.import("../index.ts");
const { normalizeVerifyChecks, finalizeSuccessfulPatch, IGNORED_VERIFY_LINE } = await jiti.import("../verify.ts");
const { applyPatchDetailed, createApplyPatchTool } = mod;

const ROOT = path.resolve(import.meta.dirname, ".labe");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
	pass += ok ? 1 : 0; fail += ok ? 0 : 1;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};
const P = (body) => `*** Begin Patch\n${body}\n*** End Patch`;

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, "docs"), { recursive: true });
await writeFile(path.join(ROOT, "docs", "a.md"), "# A\nWork mode is FAST.\nkeep me\n");
await writeFile(path.join(ROOT, "docs", "b.md"), "# B\nWork mode is AUTO.\n");

const result = await applyPatchDetailed(ROOT, P("*** Update File: docs/a.md\n@@\n # A\n-Work mode is FAST.\n+Depth is a dial.\n keep me"));
check("patch applied", result.failures.length === 0, JSON.stringify(result.failures));

const gone = await finalizeSuccessfulPatch(ROOT, result, normalizeVerifyChecks([{ path: "**/*.md", mustNotContain: ["Work mode"] }]));
check("leftover in the untouched sibling is caught", gone.isError, gone.lines.join(" | "));
check("cites file:line of the leftover", /docs\/b\.md:2/.test(gone.lines.join("\n")), gone.lines.join(" | "));
check("write is NOT rolled back", (await readFile(path.join(ROOT, "docs/a.md"), "utf-8")).includes("Depth is a dial."));

const scoped = await finalizeSuccessfulPatch(ROOT, result, normalizeVerifyChecks([{ mustNotContain: ["Work mode"] }]));
check("default scope ignores untouched files", !scoped.isError, scoped.lines.join(" | "));
check("VERIFY_OK is machine-stable", scoped.lines.some((l) => l.startsWith("VERIFY_OK")), scoped.lines.join(" | "));
const present = await finalizeSuccessfulPatch(ROOT, result, normalizeVerifyChecks([{ mustContain: ["Depth is a dial"] }]));
check("mustContain satisfied", !present.isError, present.lines.join(" | "));

const plain = await finalizeSuccessfulPatch(ROOT, result, undefined);
check("no verify → unchanged behaviour", !plain.isError && !plain.lines.some((l) => l.startsWith("VERIFY")), plain.lines.join(" | "));

await writeFile(path.join(ROOT, "docs", "c.md"), "# C\nWork mode again.\n");
const multi = await applyPatchDetailed(ROOT, P("*** Update File: docs/b.md\n@@\n # B\n-Work mode is AUTO.\n+Depth.\n*** Update File: docs/c.md\n@@\n # C\n-Work mode again.\n+Done.\n"));
const all = await finalizeSuccessfulPatch(ROOT, multi, normalizeVerifyChecks([{ path: "**/*.md", mustNotContain: ["Work mode", "FAST", "AUTO"] }]));
check("multi-file patch + global verify passes", !all.isError, all.lines.join(" | "));
check("scan covered all 3 files", all.lines.some((l) => l.startsWith("VERIFY_OK checks=1 files=3")), all.lines.join(" | "));

// verify sent without needles (a real beam-model failure mode) must not report a clean pass.
{
  const r = await applyPatchDetailed(ROOT, P("*** Update File: docs/a.md\n@@\n # A\n-Depth is a dial.\n+Depth differs.\n"));
  const ignored = await finalizeSuccessfulPatch(ROOT, r, normalizeVerifyChecks([{ path: "**/*.md" }]), [IGNORED_VERIFY_LINE]);
  check("path-only verify surfaces VERIFY_SKIPPED", ignored.lines.some((l) => l.startsWith("VERIFY_SKIPPED")), ignored.lines.join(" | "));
}

// The raw verify value must survive prepareArguments so execute still knows a check was asked for.
{
  const { createApplyPatchTool } = mod;
  const t = createApplyPatchTool();
  const once = t.prepareArguments({ input: "x", verify: [{ path: "**/*.md" }] });
  check("prepareArguments keeps raw verify", once.verifyRaw !== undefined, JSON.stringify(once));
  check("prepareArguments flags the dropped check", once.verifyDropped === true, JSON.stringify(once));
  const twice = t.prepareArguments(once);
  check("re-normalizing is idempotent (no loss on the second pass)", twice.verifyDropped === true, JSON.stringify(twice));
}

const tool = createApplyPatchTool();
check("schema declares verify", JSON.stringify(tool.parameters).includes('"verify"'));
check("schema documents mustNotContain", JSON.stringify(tool.parameters).includes("mustNotContain"));
check("description explains verify", tool.description.includes("verify"));
check("guidelines mention verify", (tool.promptGuidelines ?? []).some((l) => l.includes("verify")));

await rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// The description is the model's only tutorial: everything it claims must be literally true.
// Run: node lab/description.test.mjs
import { createJiti } from "jiti";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { APPLY_PATCH_FREEFORM_DESCRIPTION: D } = await jiti.import("../index.ts");
const { applyPatchDetailed } = await jiti.import("../index.ts");

const ROOT = path.resolve(import.meta.dirname, ".labd");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
	pass += ok ? 1 : 0; fail += ok ? 0 : 1;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};

// 1. The worked example must apply verbatim to a matching project state.
await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
await writeFile(path.join(ROOT, "example.txt"), "Hello from the original text file.\nmiddle\nold tail\n");
await writeFile(path.join(ROOT, "obsolete.txt"), "bye\n");

const example = D.slice(D.lastIndexOf("*** Begin Patch"), D.lastIndexOf("*** End Patch") + "*** End Patch".length);
const applied = await applyPatchDetailed(ROOT, example);
check("example patch applies with zero failures", applied.failures.length === 0, JSON.stringify(applied.failures));
const updated = await readFile(path.join(ROOT, "example.txt"), "utf-8");
check("example added the line", updated.includes("Second line added."), updated);
check("example renamed the tail via @@ hint", updated.includes("new tail") && !updated.includes("old tail"), updated);
check("example created the new file", (await readFile(path.join(ROOT, "hello.txt"), "utf-8")).trim() === "Hello world.");
check("example deleted the file", await readFile(path.join(ROOT, "obsolete.txt"), "utf-8").then(() => false, () => true));

// 2. Every rule the description states is checkable in the text itself.
check("says FREEFORM, not JSON", /FREEFORM/.test(D) && /NOT JSON/.test(D));
check("shows the envelope", D.includes("*** Begin Patch") && D.includes("*** End Patch"));
check("envelope is stated FIRST", D.trimStart().startsWith("START AND END EVERY PATCH WITH THE ENVELOPE"));
check("says a patch without the envelope is rejected", D.includes("as its first line is rejected"));
check("names all three hunk headers", ["Add File", "Update File", "Delete File"].every((h) => D.includes(h)));
check("warns off unified-diff ranges", D.includes("@@ -1 +1,2 @@"));
check("states Add File has no @@", /Add File: no '@@'/.test(D));
check("states verbatim context", /VERBATIM/.test(D));
check("states top-to-bottom order", /top-to-bottom/.test(D));
check("names End of File", D.includes("*** End of File"));
check("says verify is conditional on the schema", /If your tool schema shows a `verify` argument/.test(D));
check("names the trigger words for verify", /rename/.test(D) && /everywhere/.test(D) && /all files/.test(D));
check("says the follow-up grep/read is redundant", /redundant/.test(D));
check("says a failed verify does not roll back", /does NOT roll the write back/.test(D));
check("says do not re-read after success", /do not re-read/.test(D));
check("says never resend a failed patch", /never resend the same patch/i.test(D));
check("machine-stable verdict named", D.includes("VERIFY_OK") && D.includes("VERIFY_FAIL"));
check("description stays under 3.5k chars", D.length < 3500, String(D.length));

await rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

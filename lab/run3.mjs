import { applyPatchDetailed } from "./out/index.js";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";

const A = "C:/Projects/pi-apply-patch/lab/.lab3/";
const reset = async (name, content) => {
  await rm(`${A}${name}`, { force: true });
  await mkdir(A, { recursive: true });
  if (content !== undefined) await writeFile(`${A}${name}`, content);
};
const P = (s) => `*** Begin Patch\n${s}\n*** End Patch`;
const results = {};
const run = async (name, fn) => {
  try { results[name] = await fn(); }
  catch (e) { results[name] = { THROWN: e.message?.split("\n")[0] }; }
};

// T6: два чанка с перекрытием на общей контекстной строке Y
await run("T6_overlap", async () => {
  await reset("t6.txt", "X\nY\nZ\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t6.txt
@@
-X
Y
+MID
@@
Y
-Z
+Z1`));
  return { summaries: r.summaries, content: (await readFile(`${A}t6.txt`, "utf-8")).replaceAll("\n","|") };
});

// T6b: два НЕпересекающихся чанка — должны примениться оба
await run("T6b_disjoint", async () => {
  await reset("t6b.txt", "X\nY\nZ\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t6b.txt
@@
-X
+X1
@@
-Z
+Z1`));
  return { summaries: r.summaries, content: (await readFile(`${A}t6b.txt`, "utf-8")).replaceAll("\n","|") };
});

// T9: fuzz-матч по trailing whitespace — fuzz>0 в details
await run("T9_fuzz_visible", async () => {
  await reset("t9.txt", "alpha\nbeta\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t9.txt
@@
-alpha   
 beta
+ALPHA`));
  return { fuzz: r.details.fuzz, summaries: r.summaries, content: (await readFile(`${A}t9.txt`, "utf-8")).replaceAll("\n","|") };
});

// T1-повтор: зависимые хунки через промежуточный контент
await run("T1_dependent", async () => {
  await reset("t1.txt", "one\ntwo\nthree\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t1.txt
@@
-one
+ONE
@@
-ONE
+ONE-CHAIN`));
  return { summaries: r.summaries, content: (await readFile(`${A}t1.txt`, "utf-8")).replaceAll("\n","|") };
});

// T3-повтор: амбигуитет
await run("T3_ambiguous", async () => {
  await reset("t3.txt", "A\nmark\nB\nA\nmark\nB\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t3.txt
@@
 A
 mark
-B
+B-EDITED`));
  return { summaries: r.summaries, warnings: r.details.warnings, content: (await readFile(`${A}t3.txt`, "utf-8")).replaceAll("\n","|") };
});

console.log(JSON.stringify(results, null, 1));

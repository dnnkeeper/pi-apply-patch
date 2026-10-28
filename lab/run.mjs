import { applyPatchDetailed } from "./out/index.js";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";

const A = new URL("./.lab/", import.meta.url).pathname.slice(1);
const reset = async (name, content) => {
  await rm(`${A}${name}`, { force: true });
  await mkdir(A, { recursive: true });
  if (content !== undefined) await writeFile(`${A}${name}`, content);
};
const P = (s) => `*** Begin Patch\n${s}\n*** End Patch`;
const results = {};
const run = async (name, fn) => {
  try { results[name] = await fn(); }
  catch (e) { results[name] = { THROWN: e.message?.split("\n").slice(0, 1).join(" | ") }; }
};

// T1: зависимые хунки — теперь должны примениться
await run("T1_dependent", async () => {
  await reset("t1.txt", "one\ntwo\nthree\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t1.txt
@@
-one
+ONE
@@
-ONE
+ONE-CHAIN`));
  return { summaries: r.summaries, content: (await readFile(`${A}t1.txt`, "utf-8")).trim() };
});

// T2: Add поверх существующего + валидный update — отвергнуть ВСЁ, файл цел
await run("T2_add_overwrite", async () => {
  await reset("t2.txt", "keep\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t2.txt
@@
-keep
+CHANGED
*** Add File: t2.txt
+OVERWRITE`));
  return { okNoThrow: true, failures: r.failures.map(f => f.message.split("\n")[0]), file: (await readFile(`${A}t2.txt`, "utf-8")).trim() };
});

// T3: неоднозначный якорь — успех + warning с числом вхождений
await run("T3_ambiguous", async () => {
  await reset("t3.txt", "A\nmark\nB\nA\nmark\nB\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t3.txt
@@
 A
 mark
-B
+B-EDITED`));
  return { summaries: r.summaries, warnings: r.details.warnings, content: (await readFile(`${A}t3.txt`, "utf-8")).replaceAll("\n", "|") };
});

// T4: no-op
await run("T4_noop", async () => {
  await reset("t4.txt", "same\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t4.txt
@@
-same
+same
+tail`));
  return { summaries: r.summaries, noOps: r.details.noOps, content: (await readFile(`${A}t4.txt`, "utf-8")).replaceAll("\n", "|") };
});

// T5: атомарность (регресс)
await run("T5_atomic", async () => {
  await reset("t5a.txt", "alpha\n");
  await reset("t5b.txt", "beta\n");
  try {
    await applyPatchDetailed(A, P(`*** Update File: t5a.txt
@@
-alpha
+ALPHA
*** Update File: t5b.txt
@@
-WRONG
+X`));
    return { FAIL: true };
  } catch (e) {
    return { thrown: e.message.split("\n")[0], aUntouched: (await readFile(`${A}t5a.txt`, "utf-8")).trim() === "alpha" };
  }
});

// T6: overlap — два чанка на одну область
await run("T6_overlap", async () => {
  await reset("t6.txt", "X\nY\nZ\n");
  try {
    await applyPatchDetailed(A, P(`*** Update File: t6.txt
@@
-X
+X1
Y
Z`));
    return { FAIL: true };
  } catch (e) { return { thrown: e.message.split("\n")[0] }; }
});

// T7: чистая вставка на границе (регресс старого поведения)
await run("T7_insert", async () => {
  await reset("t7.txt", "a\nb\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t7.txt
@@
+FIRST`));
  return { content: (await readFile(`${A}t7.txt`, "utf-8")).replaceAll("\n", "|") };
});

// T8: CRLF сохранение (регресс)
await run("T8_crlf", async () => {
  await reset("t8.txt", "a1\r\nb1\r\nc1\r\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t8.txt
@@
-b1
+B1`));
  const c = await readFile(`${A}t8.txt`, "utf-8");
  return { content: c.replaceAll("\r\n", "|"), crlfKept: c.includes("\r\n") };
});

console.log(JSON.stringify(results, null, 1));

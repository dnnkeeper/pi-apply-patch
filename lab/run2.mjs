import { applyPatchDetailed } from "./out/index.js";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";

const A = "C:/Projects/pi-apply-patch/lab/.lab2/";
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

// T2: Add поверх существующего + валидный update — ВСЁ отвергнуто, файл цел
await run("T2_add_overwrite", async () => {
  await reset("t2.txt", "keep\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t2.txt
@@
-keep
+CHANGED
*** Add File: t2.txt
+OVERWRITE`));
  return {
    failures: r.failures.map(f => f.message.split("\n")[0]),
    fileUntouched: (await readFile(`${A}t2.txt`, "utf-8")) === "keep\n",
  };
});

// T4: честный no-op: -same/+same без добавлений
await run("T4_noop", async () => {
  await reset("t4.txt", "same\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t4.txt
@@
-same
+same`));
  return { summaries: r.summaries, noOps: r.details.noOps, file: (await readFile(`${A}t4.txt`, "utf-8")).replaceAll("\n","|") };
});

// T5: атомарность — валидный update + промах во втором файле
await run("T5_atomic", async () => {
  await reset("t5a.txt", "alpha\n");
  await reset("t5b.txt", "beta\n");
  try {
    const r = await applyPatchDetailed(A, P(`*** Update File: t5a.txt
@@
-alpha
+ALPHA
*** Update File: t5b.txt
@@
-WRONG
+X`));
    return { NO_THROW_BUT: r.failures.length > 0 ? "returned-failure" : "returned-success", fileA: (await readFile(`${A}t5a.txt`, "utf-8")).trim() };
  } catch (e) {
    return { thrown: true, aUntouched: (await readFile(`${A}t5a.txt`, "utf-8")).trim() === "alpha" };
  }
});

// T6: overlap — два чанка, второй НЕ содержит первый как подстроку
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
  return { summaries: r.summaries, warnings: r.details.warnings, content: (await readFile(`${A}t6.txt`, "utf-8")).replaceAll("\n","|") };
});

// T9: fuzzy-whitespace матч остаётся, но виден в warnings (fuzz>0)
await run("T9_fuzz_visible", async () => {
  await reset("t9.txt", "alpha\nbeta\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t9.txt
@@
-alpha   
+ALPHA
beta`));
  return { fuzz: r.details.fuzz, summaries: r.summaries, content: (await readFile(`${A}t9.txt`, "utf-8")).replaceAll("\n","|") };
});

// T10: чистый однозначный случай — без warning'ов
await run("T10_clean", async () => {
  await reset("t10.txt", "one\ntwo\n");
  const r = await applyPatchDetailed(A, P(`*** Update File: t10.txt
@@
-two
+TWO`));
  return { summaries: r.summaries, warnings: r.details.warnings, fuzz: r.details.fuzz, noOps: r.details.noOps };
});

console.log(JSON.stringify(results, null, 1));

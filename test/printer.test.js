import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { printDocument, isWithinPrintRoot } from "../src/channels/printer.js";

const ROOT = join(os.tmpdir(), "cos-print-root");
process.env.PRINT_ROOT = ROOT;
process.env.PRINTER_ENABLED = "true";

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});
after(() => rm(ROOT, { recursive: true, force: true }));

test("isWithinPrintRoot blocks absolute escapes and traversal, allows files inside", () => {
  assert.equal(isWithinPrintRoot(join(ROOT, "page.png"), ROOT), true);
  assert.equal(isWithinPrintRoot("/etc/passwd", ROOT), false);
  assert.equal(isWithinPrintRoot(join(ROOT, "..", ".env"), ROOT), false);
  assert.equal(isWithinPrintRoot(ROOT, ROOT), false, "the root itself is not a printable file");
});

test("printDocument refuses a path outside PRINT_ROOT without spawning lp", async () => {
  let spawned = false;
  const r = await printDocument("/Users/nic/.ssh/id_rsa", {
    runProcess: async () => { spawned = true; return { code: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /outside the printable folder/i);
  assert.equal(spawned, false, "must not shell out to lp for a refused path");
});

test("printDocument prints a file that lives inside PRINT_ROOT", async () => {
  const f = join(ROOT, "coloring.png");
  await writeFile(f, "PNGDATA");
  let args;
  const r = await printDocument(f, {
    runProcess: async (cmd, a) => { args = { cmd, a }; return { code: 0, stdout: "request id is Office-42 (1 file(s))", stderr: "" }; },
  });
  assert.equal(r.ok, true);
  assert.equal(args.cmd, "lp");
  assert.ok(args.a.includes(f), "the file path is passed to lp");
});

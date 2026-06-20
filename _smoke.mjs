import assert from "node:assert";
import { isWorkDomain } from "./src/guards.js";
import { tryResolveConfirmation } from "./src/confirm.js";
process.env.BRAIN_PATH = "/tmp/cos-brain-test.json";
const { remember, recall } = await import("./src/memory.js");

assert.equal(isWorkDomain("boss@flyerdefense.com"), true);
assert.equal(isWorkDomain(["ok@gmail.com", "x@disney.com"]), true);
assert.equal(isWorkDomain("shelli@freyfam.com"), false);
console.log("guard: work domains classified (confirm-gated, not hard-blocked)  ok");

assert.equal(tryResolveConfirmation("hello there"), false);
assert.equal(tryResolveConfirmation("YES 9Z3Q"), false);
console.log("confirm: parser rejects noise + unknown codes  ok");

await remember("Shelli prefers oat milk");
await remember("Trash pickup is Tuesday");
const hits = await recall("what milk does Shelli like", 2);
assert.ok(hits.length > 0 && hits[0].text.toLowerCase().includes("milk"));
console.log("memory: remember -> recall round-trips  ok");
console.log("\nALL SMOKE CHECKS PASSED");

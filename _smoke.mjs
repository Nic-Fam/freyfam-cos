import assert from "node:assert";
import { assertOutboundAllowed, OutboundBlockedError } from "./src/guards.js";
import { tryResolveConfirmation } from "./src/confirm.js";
process.env.BRAIN_PATH = "/tmp/cos-brain-test.json";
const { remember, recall } = await import("./src/memory.js");

assert.throws(() => assertOutboundAllowed("boss@flyerdefense.com"), OutboundBlockedError);
assert.throws(() => assertOutboundAllowed(["ok@gmail.com", "x@disney.com"]), OutboundBlockedError);
assert.doesNotThrow(() => assertOutboundAllowed("shelli@freyfam.com"));
console.log("guard: read-only domains blocked, family allowed  ok");

assert.equal(tryResolveConfirmation("hello there"), false);
assert.equal(tryResolveConfirmation("YES 9Z3Q"), false);
console.log("confirm: parser rejects noise + unknown codes  ok");

await remember("Shelli prefers oat milk");
await remember("Trash pickup is Tuesday");
const hits = await recall("what milk does Shelli like", 2);
assert.ok(hits.length > 0 && hits[0].text.toLowerCase().includes("milk"));
console.log("memory: remember -> recall round-trips  ok");
console.log("\nALL SMOKE CHECKS PASSED");

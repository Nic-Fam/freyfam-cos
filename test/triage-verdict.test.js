import { test } from "node:test";
import assert from "node:assert";
import { inboundVerdict, heartbeatVerdict } from "../src/triage.js";
import { parseJson } from "../src/claude.js";

test("inboundVerdict: a garbled/prose triage reply falls back to high-stakes standard chief work", () => {
  // parseJson never throws; it returns null. The old try/catch fallback was dead
  // code and the null crashed handleInbound (t.complexity on null).
  const parsed = parseJson("I'm not able to classify this message.");
  assert.equal(parsed, null);
  const v = inboundVerdict(parsed, "please wire $500 to bob");
  assert.deepEqual(v, { agent: "chief-of-staff", complexity: "standard", high_stakes: true, summary: "please wire $500 to bob" });
});

test("inboundVerdict: a valid reply passes through; bad enum values are normalized", () => {
  assert.deepEqual(
    inboundVerdict({ agent: "chef", complexity: "trivial", high_stakes: false, summary: "dinner?" }),
    { agent: "chef", complexity: "trivial", high_stakes: false, summary: "dinner?" }
  );
  const v = inboundVerdict({ agent: 7, complexity: "huge", summary: null }, "msg");
  assert.equal(v.agent, "chief-of-staff");
  assert.equal(v.complexity, "standard");
  assert.equal(v.high_stakes, true, "missing high_stakes defaults to true (safe)");
  assert.equal(v.summary, "msg");
});

test("heartbeatVerdict: null/garbage -> not actionable; items without 'what' are dropped", () => {
  assert.deepEqual(heartbeatVerdict(null), { actionable: false, items: [] });
  assert.deepEqual(heartbeatVerdict({ actionable: true }), { actionable: false, items: [] });
  assert.deepEqual(heartbeatVerdict({ actionable: true, items: [{ what: "" }, null, { what: "x", agent: "chef", urgency: "fyi" }] }), {
    actionable: true,
    items: [{ what: "x", agent: "chef", urgency: "fyi" }],
  });
  assert.deepEqual(heartbeatVerdict({ actionable: false, items: [{ what: "x" }] }), { actionable: false, items: [] });
});

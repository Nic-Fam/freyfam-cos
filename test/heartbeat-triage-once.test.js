import { test, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), `cos-hb-alerts-${process.pid}.json`);
process.env.HEARTBEAT_ALERTS_PATH = TMP;
const { untriaged, markTriaged, signalKey } = await import("../src/heartbeat-alerts.js");
after(() => rm(TMP, { force: true }));

test("each signal is triaged exactly once, so old mail is never re-judged", async () => {
  await rm(TMP, { force: true });
  const old = { id: "AAMk-old", source: "email", from: "no-reply@chase.com", subject: "Your password was changed" };
  const fresh = { id: "AAMk-new", source: "email", from: "deborah@realty.com", subject: "Fairview offer" };
  assert.equal((await untriaged([old])).length, 1);
  await markTriaged([old]);
  const next = await untriaged([fresh, old]);
  assert.deepEqual(next.map((s) => s.id), ["AAMk-new"], "a new email does not drag the old one back into triage");
  assert.equal(signalKey({ source: "kitchen", item: "milk", expiresAt: "2026-10-27" }), "kitchen:milk|2026-10-27");
});

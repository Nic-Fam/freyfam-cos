import { test } from "node:test";
import assert from "node:assert";
import { createLogger } from "../src/log.js";
import { AZURE } from "../src/config.js";

// Capture whatever the logger writes to a stream during fn(), restoring after.
function capture(stream, fn) {
  const lines = [];
  const orig = stream.write;
  stream.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    stream.write = orig;
  }
  return lines;
}

test("logger emits one structured JSON line with merged fields", () => {
  const log = createLogger("queue");
  const [line, ...rest] = capture(process.stdout, () =>
    log.info("consuming", { queue: "inbound-messages", maxDequeue: 5 })
  );
  assert.equal(rest.length, 0, "exactly one line");
  assert.ok(line.endsWith("\n"), "newline-terminated");
  const rec = JSON.parse(line);
  assert.equal(rec.level, "info");
  assert.equal(rec.component, "queue");
  assert.equal(rec.msg, "consuming");
  assert.equal(rec.queue, "inbound-messages");
  assert.equal(rec.maxDequeue, 5);
  assert.ok(typeof rec.t === "string" && rec.t.includes("T"), "ISO timestamp");
});

test("warn and error route to stderr, info to stdout", () => {
  const log = createLogger("daemon");
  const out = capture(process.stdout, () => log.info("up"));
  const err = capture(process.stderr, () => log.error("fatal", { reason: "boom" }));
  assert.equal(out.length, 1, "info -> stdout");
  assert.equal(err.length, 1, "error -> stderr");
  assert.equal(JSON.parse(err[0]).reason, "boom");
});

test("dead-letter queue name derives from the inbound queue", () => {
  assert.equal(AZURE.deadLetterQueue, `${AZURE.inboundQueue}-poison`);
});

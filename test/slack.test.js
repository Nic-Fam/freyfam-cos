import { test } from "node:test";
import assert from "node:assert";
import { agentForChannel, mirrorText, approvalBlocks, downloadSlackFiles } from "../src/channels/slack.js";
import { foldThread } from "../src/conversation.js";

// fetch stub: serve `body` (Buffer) with a content-type header + status.
function fetchStub(body, { status = 200, contentType = "" } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

test("downloadSlackFiles keeps a real image (sniffed downstream)", async () => {
  const { media, attachments } = await downloadSlackFiles(
    [{ url_private: "https://files.slack/x", mimetype: "image/jpeg", name: "a.jpg" }],
    { token: "xoxb-test", fetchImpl: fetchStub(JPEG, { contentType: "image/jpeg" }) }
  );
  assert.equal(media.length, 1);
  assert.equal(attachments.length, 0);
  assert.ok(Buffer.isBuffer(media[0].bytes));
});

test("downloadSlackFiles skips a 200+HTML sign-in page instead of passing it off as an image", async () => {
  // The files:read-scope / not-in-channel failure mode: Slack returns 200 + HTML.
  const html = Buffer.from("<!DOCTYPE html>\n<html><head><title>Sign in</title></head></html>");
  const byHeader = await downloadSlackFiles(
    [{ url_private: "https://files.slack/x", mimetype: "image/jpeg", name: "a.jpg" }],
    { token: "xoxb-test", fetchImpl: fetchStub(html, { contentType: "text/html; charset=utf-8" }) }
  );
  assert.equal(byHeader.media.length, 0, "HTML must not be pushed as an image");
  assert.equal(byHeader.attachments.length, 0);

  // Even if the content-type header lies (says image), the body is sniffed as HTML.
  const bySniff = await downloadSlackFiles(
    [{ url_private: "https://files.slack/x", mimetype: "image/jpeg", name: "a.jpg" }],
    { token: "xoxb-test", fetchImpl: fetchStub(html, { contentType: "image/jpeg" }) }
  );
  assert.equal(bySniff.media.length, 0);
});

test("foldThread leaves the task unchanged when there is no thread history", () => {
  assert.equal(foldThread([], "find me a deal"), "find me a deal");
  assert.equal(foldThread(undefined, "find me a deal"), "find me a deal");
});

test("foldThread prepends recent turns so a forced channel keeps context", () => {
  const history = [
    { role: "user", content: "watch for a Chanel flap bag" },
    { role: "assistant", content: "Tracking it on Vestiaire and Poshmark." },
  ];
  const out = foldThread(history, "any hits yet?");
  assert.match(out, /Recent conversation in this channel:/);
  assert.match(out, /User: watch for a Chanel flap bag/);
  assert.match(out, /You: Tracking it on Vestiaire/); // assistant labeled "You"
  assert.match(out, /User's latest message: any hits yet\?$/);
});

test("agentForChannel forces a specialist for per-agent channels, null otherwise", () => {
  assert.equal(agentForChannel("finance"), "finance");
  assert.equal(agentForChannel("#security"), "security");
  assert.equal(agentForChannel("CHEF"), "chef");
  assert.equal(agentForChannel("cos"), null, "#cos -> chief (null = not forced)");
  assert.equal(agentForChannel("random"), null);
  assert.equal(agentForChannel(null), null);
});

test("mirrorText renders the #command delegation feed", () => {
  const start = mirrorText({ phase: "start", from: "Lloyd", agent: "finance", task: "reconcile October" });
  assert.match(start, /Lloyd → finance/);
  assert.match(start, /reconcile October/);
  const result = mirrorText({ phase: "result", agent: "finance", result: "done, all matched" });
  assert.match(result, /finance/);
  assert.match(result, /done, all matched/);
  assert.equal(mirrorText({ phase: "other" }), "");
  assert.equal(mirrorText(null), "");
});

test("approvalBlocks carries the code in the Approve/Deny button values", () => {
  const blocks = approvalBlocks("9Z3Q", "Email to nic@freyfam.com");
  const actions = blocks.find((b) => b.type === "actions");
  assert.ok(actions, "has an actions block");
  const ids = actions.elements.map((e) => e.action_id);
  assert.deepEqual(ids, ["cos_approve", "cos_deny"]);
  for (const el of actions.elements) assert.equal(el.value, "9Z3Q", "button carries the code");
  assert.match(blocks[0].text.text, /9Z3Q/);
});

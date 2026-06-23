import { test } from "node:test";
import assert from "node:assert";
import { downloadSlackFiles } from "../src/channels/slack.js";

const fakeFetch = (recorder) => async (url, opts) => {
  recorder.push({ url, auth: opts?.headers?.Authorization });
  return { ok: true, arrayBuffer: async () => Buffer.from(`bytes:${url}`) };
};

test("downloads with a bot-token Bearer; images -> media, PDFs -> attachments", async () => {
  const calls = [];
  const files = [
    { mimetype: "image/jpeg", url_private_download: "https://files.slack/i.jpg", name: "photo.jpg" },
    { mimetype: "application/pdf", url_private: "https://files.slack/d.pdf", name: "invoice.pdf" },
  ];
  const { media, attachments } = await downloadSlackFiles(files, { token: "xoxb-test", fetchImpl: fakeFetch(calls) });
  assert.equal(media.length, 1);
  assert.equal(media[0].contentType, "image/jpeg");
  assert.ok(Buffer.isBuffer(media[0].bytes));
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].name, "invoice.pdf");
  assert.match(calls[0].auth, /^Bearer xoxb-test$/); // bot-token download
});

test("no token or no files -> nothing", async () => {
  assert.deepEqual(await downloadSlackFiles([{ mimetype: "image/png", url_private: "x" }], { token: "", fetchImpl: async () => { throw new Error("should not fetch"); } }), { media: [], attachments: [] });
  assert.deepEqual(await downloadSlackFiles(undefined, { token: "t" }), { media: [], attachments: [] });
});

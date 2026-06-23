import { test } from "node:test";
import assert from "node:assert";
import { approvalEmailHtml } from "../src/channels/graph.js";

test("approvalEmailHtml builds Approve/Deny mailto buttons that pre-fill YES/NO <code>", () => {
  const html = approvalEmailHtml("4F2A", "Email to julie@realty.com\nSubject: tour", "cos@freyfam.com");
  // Approve composes "YES 4F2A" to the assistant mailbox; Deny composes "NO 4F2A".
  assert.match(html, /mailto:cos%40freyfam\.com\?subject=Approve%204F2A&body=YES%204F2A/);
  assert.match(html, /mailto:cos%40freyfam\.com\?subject=Deny%204F2A&body=NO%204F2A/);
  assert.match(html, />Approve</);
  assert.match(html, />Deny</);
  // Fallback instruction is present for clients that strip buttons.
  assert.match(html, /reply to this email with "YES 4F2A"/);
});

test("approvalEmailHtml escapes HTML in the action summary (no injection)", () => {
  const html = approvalEmailHtml("AB12", 'Email <script>alert(1)</script> & "stuff"');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

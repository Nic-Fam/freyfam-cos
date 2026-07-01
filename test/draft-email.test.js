import test from "node:test";
import assert from "node:assert";
import { draftMailboxFor } from "../src/channels/graph.js";
import { CHIEF_ONLY_TOOLS } from "../src/agents/tools.js";

test("draftMailboxFor resolves people + addresses, defaults to Nic", () => {
  assert.equal(draftMailboxFor("nic"), "nic@freyfam.com");
  assert.equal(draftMailboxFor("Nic"), "nic@freyfam.com");
  assert.equal(draftMailboxFor("shelli"), "shelli@freyfam.com");
  assert.equal(draftMailboxFor(), "nic@freyfam.com");
  assert.equal(draftMailboxFor("someone@else.com"), "someone@else.com");
  assert.equal(draftMailboxFor("bogus"), "nic@freyfam.com");
});

test("draft_email is chief-only — a specialist can never draft into a family mailbox", () => {
  assert.ok(CHIEF_ONLY_TOOLS.has("draft_email"));
});

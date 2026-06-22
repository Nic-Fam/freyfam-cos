import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-contacts-test.json");
process.env.CONTACTS_PATH = TMP;
const { getEmailContacts, hasEmailed, recordEmailContact } = await import("../src/contacts.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("a brand-new address is a first contact", async () => {
  assert.equal(await hasEmailed("julie@realty.com"), false);
  assert.deepEqual(await getEmailContacts(), []);
});

test("recording makes an address known (case/space-insensitive, idempotent)", async () => {
  await recordEmailContact("Julie@Realty.com");
  assert.equal(await hasEmailed("julie@realty.com"), true);
  assert.equal(await hasEmailed("  JULIE@REALTY.COM "), true);
  await recordEmailContact("julie@realty.com"); // dup
  assert.deepEqual(await getEmailContacts(), ["julie@realty.com"]);
});

test("recordEmailContact accepts a list and skips blanks", async () => {
  await recordEmailContact(["a@x.com", "", "B@y.com"]);
  assert.deepEqual((await getEmailContacts()).sort(), ["a@x.com", "b@y.com"]);
});

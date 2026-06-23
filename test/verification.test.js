import { test } from "node:test";
import assert from "node:assert";
import { extractCode, isVerificationEmail } from "../src/verification.js";

test("extracts a code when a verification keyword precedes it", () => {
  assert.equal(extractCode("Your sign-in code", "Your verification code is 481920. It expires in 10 minutes."), "481920");
  assert.equal(extractCode("Security", "Enter 30561 to continue"), "30561");
  assert.equal(extractCode("Apple ID Code", "Your Apple ID code is: 318204"), "318204");
});

test("does NOT extract from non-verification emails with incidental digits", () => {
  assert.equal(extractCode("Your order shipped", "Order 84727391 arrives Tuesday"), null);
  assert.equal(extractCode("Meeting notes", "We met in 2026 and discussed 12 items"), null);
});

test("skips year-like 4-digit numbers", () => {
  assert.equal(extractCode("Newsletter", "Looking back at 2026"), null);
});

test("isVerificationEmail mirrors extractCode", () => {
  assert.equal(isVerificationEmail("OTP", "Your one-time passcode is 9921"), true);
  assert.equal(isVerificationEmail("Hi", "lunch at noon"), false);
});

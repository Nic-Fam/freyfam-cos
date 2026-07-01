import { test } from "node:test";
import assert from "node:assert";
import { detectFormat, parseChaseCsv, classifyChaseRow, prepareImport, ingestChaseCsv, isChaseCsvAttachment } from "../src/chase-csv.js";

const CREDIT_CSV = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "06/28/2026,06/29/2026,CVS/PHARMACY #09647,Health & Wellness,Sale,-3.94,",
  "06/06/2026,06/07/2026,Payment Thank You-Mobile,,Payment,12089.83,",
  "06/19/2026,06/19/2026,REVOLVE,Shopping,Return,144.54,",
].join("\n");

const CHECKING_CSV = [
  "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
  "DEBIT,06/22/2026,BRIGHT HORIZONS CHILD CARE 9348983,-509.00,ACH_DEBIT,3102.72,",
  "DEBIT,06/12/2026,Zelle payment to Mike Cole JPM99ckhhm19,-1500.00,QUICKPAY_DEBIT,5743.03,",
  "DEBIT,06/08/2026,Payment to Chase card ending in 9634 06/08,-12089.83,ACH_DEBIT,1147.69,",
  "CREDIT,06/12/2026,122383 FLYER DEF PAYROLL PPD ID: 1364227403,4048.66,ACH_CREDIT,7243.03,",
  "DEBIT,06/08/2026,Online Transfer to SAV ...1388,-100.00,ACCT_XFER,,",
  "DEBIT,06/15/2026,FID BKG SVC LLC MONEYLINE,-200.00,ACH_DEBIT,4718.03,",
].join("\n");

test("detectFormat distinguishes the two Chase layouts", () => {
  assert.equal(detectFormat("Transaction Date,Post Date,Description,Category,Type,Amount,Memo"), "credit");
  assert.equal(detectFormat("Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #"), "checking");
  assert.equal(detectFormat("random,columns"), null);
});

test("credit: sales are +spend, refunds are -spend, the payment is excluded", () => {
  const { format, rows } = parseChaseCsv(CREDIT_CSV);
  assert.equal(format, "credit");
  const cvs = classifyChaseRow(rows[0], format);
  assert.deepEqual([cvs.include, cvs.source, cvs.spend, cvs.direction], [true, "credit", 3.94, "out"]);
  const pay = classifyChaseRow(rows[1], format);
  assert.equal(pay.include, false);
  assert.equal(pay.reason, "card payment");
  const ret = classifyChaseRow(rows[2], format);
  assert.deepEqual([ret.include, ret.spend, ret.direction], [true, -144.54, "in"]); // refund nets down
});

test("checking: real debits count; payment/transfer/deposit/savings excluded", () => {
  const { format, rows } = parseChaseCsv(CHECKING_CSV);
  assert.equal(format, "checking");
  const cls = rows.map((r) => classifyChaseRow(r, format));
  assert.deepEqual([cls[0].include, cls[0].spend, cls[0].source], [true, 509, "checking"]); // childcare
  assert.deepEqual([cls[1].include, cls[1].spend], [true, 1500]);                            // Zelle
  assert.equal(cls[2].include, false); assert.equal(cls[2].reason, "card payment");
  assert.equal(cls[3].include, false); assert.match(cls[3].reason, /inflow/);                // payroll
  assert.equal(cls[4].include, false); assert.equal(cls[4].reason, "transfer");
  assert.equal(cls[5].include, false); assert.equal(cls[5].reason, "savings/investment");    // Fidelity
});

test("prepareImport dedupes against already-logged rows", () => {
  const existing = [{ source: "checking", date: "2026-06-22", amount: 509, merchant: "BRIGHT HORIZONS CHILD CARE 9348983" }];
  const prep = prepareImport(CHECKING_CSV, existing);
  // childcare already logged -> skipped; only the Zelle (1500) remains includable
  assert.equal(prep.toLog.length, 1);
  assert.equal(prep.toLog[0].amount, 1500);
  assert.equal(prep.skipped.length, 1);
  assert.ok(prep.excluded.length >= 4); // payment, payroll, transfer, savings
});

test("ingestChaseCsv logs the includable rows and summarizes", async () => {
  const logged = [];
  const r = await ingestChaseCsv(CREDIT_CSV, { logFn: async (t) => logged.push(t), existing: [] });
  assert.equal(r.ok, true);
  assert.equal(r.imported, 2);        // CVS sale + REVOLVE refund; payment excluded
  assert.equal(logged.length, 2);
  assert.match(r.summary, /Imported 2 credit/);
});

test("ingestChaseCsv rejects a non-Chase file", async () => {
  const r = await ingestChaseCsv("date,foo,bar\n2026-01-01,x,y", { logFn: async () => {}, existing: [] });
  assert.equal(r.ok, false);
  assert.match(r.summary, /not a recognized chase csv/i);
});

test("isChaseCsvAttachment recognizes a Chase CSV by name + header", () => {
  const bytes = Buffer.from(CREDIT_CSV, "utf8");
  assert.equal(isChaseCsvAttachment({ name: "Chase9634_Activity.CSV", contentType: "application/octet-stream", bytes }), true);
  assert.equal(isChaseCsvAttachment({ name: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from("x") }), false);
  assert.equal(isChaseCsvAttachment({ name: "notes.csv", contentType: "text/csv", bytes: Buffer.from("a,b,c\n1,2,3") }), false); // csv but not Chase
});

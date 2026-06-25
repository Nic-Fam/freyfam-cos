import { test } from "node:test";
import assert from "node:assert";
import { checkBreaches, newBreachFindings, securityPosture } from "../src/security-monitor.js";

test("checkBreaches is inert without an API key", async () => {
  const r = await checkBreaches(["nic@freyfam.com"], { apiKey: "" });
  assert.equal(r.skipped, true);
  assert.deepEqual(r.results, []);
});

test("checkBreaches maps 404=clean and 200=breach names", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("clean%40")) return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => [{ Name: "Dropbox" }, { Name: "LinkedIn" }] };
  };
  const r = await checkBreaches(["clean@x.com", "hit@x.com"], { apiKey: "k", fetchImpl, delayMs: 0 });
  assert.equal(r.skipped, false);
  assert.deepEqual(r.results.find((x) => x.email === "clean@x.com").breaches, []);
  assert.deepEqual(r.results.find((x) => x.email === "hit@x.com").breaches, ["Dropbox", "LinkedIn"]);
});

test("newBreachFindings reports only exposures not already logged", () => {
  const results = [{ email: "nic@freyfam.com", breaches: ["Dropbox", "LinkedIn"] }];
  const existing = new Set(["Breach exposure: nic@freyfam.com in Dropbox"]);
  const fresh = newBreachFindings(results, existing);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].breach, "LinkedIn");
  assert.match(fresh[0].title, /LinkedIn/);
});

test("securityPosture summarizes open findings worst-first; clean when none open", () => {
  assert.match(securityPosture([]), /no open findings/);
  const out = securityPosture([
    { title: "Breach exposure: nic in Dropbox", severity: "high", status: "open" },
    { title: "Old thing", severity: "low", status: "resolved" }, // resolved -> excluded
    { title: "Weak wifi password", severity: "medium", status: "open" },
  ]);
  assert.match(out, /2 open \(1 high, 1 medium\)/);
  assert.match(out, /Needs attention:[\s\S]*HIGH: Breach exposure/);
  assert.ok(!out.includes("Old thing"));
});

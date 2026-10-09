import { test } from "node:test";
import assert from "node:assert";
import {
  isCommitLabel, isSensitiveField, hostAllowed, elideOldObservations,
  makePageHandlers, runBrowserTask, formatSnapshot,
} from "../src/browser-agent.js";

test("isCommitLabel catches order-placing buttons, not cart building", () => {
  for (const l of ["Place order", "Place your order", "Submit Order", "Pay now", "Buy now", "Complete purchase", "Confirm order"]) {
    assert.equal(isCommitLabel(l), true, l);
  }
  for (const l of ["Add to cart", "Go to checkout", "Review order", "Checkout", "Choose delivery time", "Clip coupon"]) {
    assert.equal(isCommitLabel(l), false, l);
  }
});

test("isSensitiveField refuses password and card fields", () => {
  assert.equal(isSensitiveField({ type: "password" }), true);
  assert.equal(isSensitiveField({ autocomplete: "cc-number" }), true);
  assert.equal(isSensitiveField({ name: "cvv" }), true);
  assert.equal(isSensitiveField({ label: "Card number" }), true);
  assert.equal(isSensitiveField({ type: "search", label: "Search products" }), false);
});

test("hostAllowed matches the host and its subdomains only", () => {
  assert.equal(hostAllowed("https://www.instacart.com/store/costco", ["instacart.com"]), true);
  assert.equal(hostAllowed("https://instacart.com.evil.io/x", ["instacart.com"]), false);
  assert.equal(hostAllowed("not a url", ["instacart.com"]), false);
});

test("elideOldObservations keeps only the newest page observations", () => {
  const convo = [1, 2, 3].map((n) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `snap ${n}` }] }));
  elideOldObservations(convo, ["t1", "t2", "t3"], 2);
  assert.match(convo[0].content[0].content, /removed/);
  assert.equal(convo[1].content[0].content, "snap 2");
  assert.equal(convo[2].content[0].content, "snap 3");
});

// A tiny fake Playwright page: elements keyed by ref, records clicks + typing.
function fakePage(elements) {
  const calls = [];
  let url = "https://www.instacart.com/store/costco/storefront";
  return {
    calls,
    url: () => url,
    goto: async (u) => { url = u; calls.push(`goto ${u}`); },
    waitForLoadState: async () => {},
    screenshot: async () => Buffer.from("jpg"),
    evaluate: async (fn, arg) => {
      if (fn.name === "describeInPage") return elements[arg] || null;
      if (fn.name === "snapshotInPage") {
        return { url, title: "Costco", text: "Cart", elements: Object.entries(elements).map(([ref, e]) => ({ ref: Number(ref), tag: "button", role: "", type: e.type || "", label: e.label, disabled: false, inView: true })) };
      }
      throw new Error(`unexpected evaluate ${fn.name}`);
    },
    locator: (sel) => ({
      first: () => ({
        scrollIntoViewIfNeeded: async () => {},
        boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
        click: async () => calls.push(`locclick ${sel}`),
        fill: async () => {},
      }),
    }),
    mouse: { click: async () => calls.push("mouseclick"), wheel: async () => {} },
    keyboard: { type: async (t) => calls.push(`type ${t}`), press: async (k) => calls.push(`press ${k}`) },
  };
}

const opts = { allowedHosts: ["instacart.com"], pace: false, sleep: async () => {} };

test("click refuses Place order unless the run may commit", async () => {
  const page = fakePage({ 1: { label: "Place order" }, 2: { label: "Add to cart" } });
  const h = makePageHandlers(page, opts);
  assert.match(await h.click({ ref: 1 }), /REFUSED/);
  assert.ok(!page.calls.includes("mouseclick"));
  assert.match(await h.click({ ref: 2 }), /Clicked "Add to cart"/);
  assert.ok(page.calls.includes("mouseclick"));

  const commit = makePageHandlers(page, { ...opts, allowCommit: true });
  assert.match(await commit.click({ ref: 1 }), /Clicked "Place order"/);
});

test("type refuses password fields; navigate refuses other sites", async () => {
  const page = fakePage({ 1: { label: "Password", type: "password" }, 2: { label: "Search" } });
  const h = makePageHandlers(page, opts);
  assert.match(await h.type({ ref: 1, text: "x" }), /REFUSED/);
  assert.match(await h.type({ ref: 2, text: "eggs", submit: true }), /Typed/);
  assert.ok(page.calls.includes("type eggs") && page.calls.includes("press Enter"));
  assert.match(await h.navigate({ url: "https://evil.example.com" }), /REFUSED/);
});

test("formatSnapshot lists refs and truncates long text", () => {
  const out = formatSnapshot({ url: "u", title: "t", text: "x".repeat(5000), elements: [{ ref: 3, tag: "button", role: "", type: "", label: "Add", disabled: false, inView: false }] }, { maxText: 100 });
  assert.match(out, /\[3\] button "Add" \(offscreen\)/);
  assert.match(out, /truncated/);
});

test("runBrowserTask drives tools until the model returns the JSON result", async () => {
  const page = fakePage({ 1: { label: "Add to cart" } });
  const script = [
    { content: [{ type: "tool_use", id: "a", name: "snapshot", input: {} }], usage: { input_tokens: 10 } },
    { content: [{ type: "tool_use", id: "b", name: "click", input: { ref: 1 } }], usage: { input_tokens: 10 } },
    { content: [{ type: "text", text: '{"ok":true,"store":"costco","phase":"fill","added":[{"item":"Eggs","qty":1}],"dropped":[],"total":12.5,"window":"Today 5-6pm"}' }], usage: { input_tokens: 10 } },
  ];
  const seen = [];
  const llm = async ({ messages }) => { seen.push(messages.length); return script.shift(); };
  const out = await runBrowserTask({
    task: "fill", startUrl: "https://www.instacart.com/store/costco/storefront", allowedHosts: ["instacart.com"],
    deps: { openPage: (fn) => fn(page), llm, pace: false, sleep: async () => {}, model: "test" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.result.total, 12.5);
  assert.equal(out.turns, 3);
  assert.equal(out.usage.input_tokens, 30);
  assert.deepEqual(out.transcript, ["goto https://www.instacart.com/store/costco/storefront", 'click "Add to cart"']);
});

test("runBrowserTask stops at max turns and refuses an off-list start URL", async () => {
  const page = fakePage({});
  const llm = async () => ({ content: [{ type: "tool_use", id: String(Math.random()), name: "wait", input: { seconds: 1 } }] });
  const out = await runBrowserTask({
    task: "x", startUrl: "https://www.instacart.com/", allowedHosts: ["instacart.com"], maxTurns: 3,
    deps: { openPage: (fn) => fn(page), llm, pace: false, sleep: async () => {}, model: "test" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.result.reason, "max_turns");
  await assert.rejects(runBrowserTask({ task: "x", startUrl: "https://evil.com", allowedHosts: ["instacart.com"], deps: { openPage: (fn) => fn(page), llm } }));
});

// ===========================================================================
// Lloyd's own browser agent (2026-10). Claude drives the signed-in Chrome profile
// on Lloyd's Mac through a small set of page tools (snapshot / click / type /
// navigate / scroll / wait / screenshot), following a written playbook (the store
// playbooks in grocery-order-playbook.js). This replaces BOTH earlier models:
//   - scripted Playwright selectors (runOrder + data/*-steps.json, never captured)
//   - a human-run Claude Code session driving Claude-in-Chrome
// so the daemon can build a cart on its own, then stage it through confirm.js.
//
// HARD CONSTRAINTS enforced HERE, in the tool layer, not just in the prompt:
//   - COMMIT GUARD: unless the run was started with allowCommit (only the "submit"
//     phase, which only runs after the family's YES), a click on anything labelled
//     like "Place order" / "Pay now" / "Buy now" is refused. A fill run cannot buy.
//   - NO CREDENTIALS: typing into a password / card / CVV field is always refused.
//     The agent never signs in and never enters payment data (saved methods only).
//   - HOST ALLOWLIST: navigate() only goes to the task's allowed hosts.
//   - ONE AT A TIME: a single persistent Chrome profile can only host one run.
// Runs on Lloyd's local Mac only (residential IP + the signed-in profile), never
// in an Azure specialist. Gated by COS_BROWSER_AGENT=true.
// ===========================================================================
import { complete, textOf, toolUses, parseJson } from "./claude.js";
import { MODELS } from "./config.js";
import { withPage, withHeadedPage, humanPauseMs } from "./channels/browser.js";
import { createLogger } from "./log.js";

const log = createLogger("browser-agent");

export const browserAgentEnabled = () =>
  String(process.env.COS_BROWSER_AGENT ?? "false").toLowerCase() === "true";

const AGENT = {
  model: () => process.env.MODEL_BROWSER_AGENT || MODELS.standard,
  maxTurns: () => Number(process.env.BROWSER_AGENT_MAX_TURNS || 80),
  // Bot-protected checkouts (Ralphs/Kroger) behave better headed on the real profile.
  headed: () => String(process.env.BROWSER_AGENT_HEADED ?? "true").toLowerCase() === "true",
};

// --- pure guards (unit-tested) ---------------------------------------------

// Labels that COMMIT money. Deliberately broad: a false positive just means the
// fill phase stops and reports; a false negative could buy something unapproved.
const COMMIT_RE = /\b(place (your )?order|submit order|complete (purchase|order|checkout)|confirm (order|purchase|and pay)|pay now|buy now|purchase now|place order and pay|start checkout and pay)\b/i;
export function isCommitLabel(label) {
  return COMMIT_RE.test(String(label || "").replace(/\s+/g, " "));
}

// Fields the agent must never type into (credentials + payment data).
const SENSITIVE_RE = /(password|passcode|card.?number|cc-?(number|csc|exp)|cvv|cvc|security.?code|ssn|social.?security)/i;
export function isSensitiveField({ type, autocomplete, name, id, label } = {}) {
  if (String(type || "").toLowerCase() === "password") return true;
  return [autocomplete, name, id, label].some((v) => SENSITIVE_RE.test(String(v || "")));
}

export function hostAllowed(url, allowedHosts = []) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// Old snapshots/screenshots are what blow up context on a 60-turn run. Keep the
// newest `keep` page observations verbatim and stub out the rest (mutates convo).
export function elideOldObservations(convo, observationIds, keep = 2) {
  const stale = new Set(observationIds.slice(0, Math.max(0, observationIds.length - keep)));
  if (!stale.size) return;
  for (const msg of convo) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && stale.has(block.tool_use_id) && block.content !== ELIDED) {
        block.content = ELIDED;
      }
    }
  }
}
const ELIDED = "[older page observation removed; call snapshot for the current page]";

// --- page tools --------------------------------------------------------------

export const BROWSER_TOOLS = [
  { name: "snapshot", description: "Read the current page: URL, title, a numbered list of interactive elements (use their ref with click/type), and the visible text. Call after every navigation or click that changes the page.", input_schema: { type: "object", properties: {} } },
  { name: "screenshot", description: "See the current viewport as an image. Use when the snapshot is confusing (overlays, spinners, carousels).", input_schema: { type: "object", properties: {} } },
  { name: "click", description: "Click an element by its ref from the latest snapshot (a real mouse click at its center).", input_schema: { type: "object", properties: { ref: { type: "number" } }, required: ["ref"] } },
  { name: "type", description: "Type text into an input by ref (clears it first). submit:true presses Enter afterwards.", input_schema: { type: "object", properties: { ref: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] } },
  { name: "navigate", description: "Go to a URL (only the store's own sites are allowed).", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "scroll", description: "Scroll the page up or down one screen.", input_schema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"] } },
  { name: "wait", description: "Wait for a slow page to finish loading (1-10 seconds).", input_schema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] } },
];

/* istanbul ignore next -- runs in the browser */
function snapshotInPage(maxEls) {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable=true]';
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const labelOf = (el) => {
    const t = el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder ||
      el.getAttribute("title") || el.getAttribute("name") || el.querySelector?.("img[alt]")?.alt || "";
    return String(t).replace(/\s+/g, " ").trim().slice(0, 90);
  };
  document.querySelectorAll("[data-cos-ref]").forEach((e) => e.removeAttribute("data-cos-ref"));
  const els = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (els.length >= maxEls) break;
    if (!vis(el)) continue;
    n += 1;
    el.setAttribute("data-cos-ref", String(n));
    const r = el.getBoundingClientRect();
    els.push({
      ref: n,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      label: labelOf(el),
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      inView: r.bottom > 0 && r.top < innerHeight,
    });
  }
  const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return { url: location.href, title: document.title, elements: els, text };
}

/* istanbul ignore next -- runs in the browser */
function describeInPage(ref) {
  const el = document.querySelector(`[data-cos-ref="${ref}"]`);
  if (!el) return null;
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return { label, type: el.getAttribute("type") || "", autocomplete: el.getAttribute("autocomplete") || "", name: el.getAttribute("name") || "", id: el.id || "" };
}

export function formatSnapshot(s, { maxText = 3500 } = {}) {
  const els = s.elements.map((e) =>
    `[${e.ref}] ${e.tag}${e.role ? `(${e.role})` : ""}${e.type ? `[${e.type}]` : ""} "${e.label}"${e.disabled ? " (disabled)" : ""}${e.inView ? "" : " (offscreen)"}`
  ).join("\n");
  const text = s.text.length > maxText ? `${s.text.slice(0, maxText)}\n...(truncated)` : s.text;
  return `URL: ${s.url}\nTITLE: ${s.title}\n\nELEMENTS:\n${els || "(none)"}\n\nVISIBLE TEXT:\n${text}`;
}

/** Build the tool handlers bound to one page + one run's guards. Exported for tests. */
export function makePageHandlers(page, { allowedHosts, allowCommit = false, pace = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), transcript = [] } = {}) {
  const humanPause = async () => { if (pace) { const ms = humanPauseMs(); if (ms) await sleep(ms); } };
  const offsite = () => (hostAllowed(page.url(), allowedHosts) ? "" : `\nNOTE: now on ${page.url()}, which is outside the store's sites. Go back or STOP.`);
  const el = (ref) => page.locator(`[data-cos-ref="${Number(ref)}"]`).first();

  return {
    snapshot: async () => formatSnapshot(await page.evaluate(snapshotInPage, 150)),
    screenshot: async () => {
      const buf = await page.screenshot({ type: "jpeg", quality: 55 });
      return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } }];
    },
    click: async ({ ref }) => {
      const d = await page.evaluate(describeInPage, Number(ref));
      if (!d) return `No element with ref ${ref}; take a new snapshot.`;
      if (!allowCommit && isCommitLabel(d.label)) {
        transcript.push(`REFUSED commit click "${d.label}"`);
        return `REFUSED: "${d.label}" would place the order, and this run is not allowed to commit. Stop at review and report the cart.`;
      }
      await humanPause();
      const loc = el(ref);
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const box = await loc.boundingBox();
      // A real mouse click at the element's center: SPA handlers (Ralphs add-to-cart)
      // ignored synthetic clicks in the July dry run but fired on coordinate clicks.
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await loc.click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      transcript.push(`click "${d.label}"`);
      return `Clicked "${d.label}".${offsite()}`;
    },
    type: async ({ ref, text, submit = false }) => {
      const d = await page.evaluate(describeInPage, Number(ref));
      if (!d) return `No element with ref ${ref}; take a new snapshot.`;
      if (isSensitiveField(d)) {
        transcript.push(`REFUSED typing into sensitive field "${d.label || d.name}"`);
        return "REFUSED: that is a password or payment field. Never enter credentials or card data; STOP and report not_signed_in or checkout_failed.";
      }
      await humanPause();
      const loc = el(ref);
      await loc.click({ timeout: 8000 });
      await loc.fill("", { timeout: 5000 }).catch(() => {});
      await page.keyboard.type(String(text), { delay: 60 + Math.floor(Math.random() * 80) });
      if (submit) await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      transcript.push(`type "${String(text).slice(0, 40)}"${submit ? " + Enter" : ""}`);
      return `Typed into "${d.label || d.name}".${offsite()}`;
    },
    navigate: async ({ url }) => {
      if (!hostAllowed(url, allowedHosts)) return `REFUSED: ${url} is not one of the allowed sites (${allowedHosts.join(", ")}).`;
      await humanPause();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      transcript.push(`goto ${url}`);
      return `Loaded ${page.url()}.${offsite()}`;
    },
    scroll: async ({ direction }) => {
      await page.mouse.wheel(0, direction === "up" ? -700 : 700);
      await sleep(400);
      return `Scrolled ${direction}.`;
    },
    wait: async ({ seconds }) => {
      await sleep(Math.min(10, Math.max(1, Number(seconds) || 2)) * 1000);
      return "Waited.";
    },
  };
}

// --- the loop ----------------------------------------------------------------

const SYSTEM = `You are Lloyd's browser operator for the Frey family. You drive the family's own signed-in Chrome through tools to complete ONE task, following its playbook exactly.

How to work:
- Start with snapshot. Act with click/type using the refs from the LATEST snapshot (refs change after the page changes, so snapshot again after anything that changes the page).
- Shopping sites are slow single-page apps. If a page looks half-loaded, wait and snapshot again before deciding anything. Use screenshot when the text snapshot is ambiguous.
- Be deliberate and efficient. Do not explore unrelated pages.
- NEVER sign in, never type a password or card number, never accept upsells, memberships, warranties or tip changes. If a tool says REFUSED, obey it.
- When done (or when you must stop), reply with ONLY the single JSON line the playbook asks for, and no tool call.`;

let _chain = Promise.resolve();
/** Serialize runs: one persistent Chrome profile can host only one agent at a time. */
function exclusive(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

/**
 * Run one browser task. Returns { ok, result (parsed JSON or null), text, turns,
 * transcript, usage }. `deps` (openPage, complete, sleep, pace) are injectable for tests.
 * @param {{task:string, startUrl:string, allowedHosts:string[], allowCommit?:boolean, label?:string}} o
 */
export async function runBrowserTask({ task, startUrl, allowedHosts, allowCommit = false, label = "browser task", maxTurns = AGENT.maxTurns(), deps = {} }) {
  if (!hostAllowed(startUrl, allowedHosts)) throw new Error(`startUrl ${startUrl} is outside allowedHosts`);
  const {
    openPage = AGENT.headed() ? withHeadedPage : withPage,
    llm = complete,
    sleep,
    pace = true,
    model = AGENT.model(),
  } = deps;

  return exclusive(() => openPage(async (page) => {
    const transcript = [];
    const handlers = makePageHandlers(page, { allowedHosts, allowCommit, pace, transcript, ...(sleep ? { sleep } : {}) });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    transcript.push(`goto ${startUrl}`);

    const convo = [{ role: "user", content: `TASK (${allowCommit ? "commit allowed" : "NO commit: stop at review"}):\n${task}` }];
    const observations = [];
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for (let turn = 1; turn <= maxTurns; turn++) {
      const resp = await llm({ model, system: SYSTEM, messages: convo, tools: BROWSER_TOOLS, maxTokens: 1500, cacheConversation: true });
      for (const k of Object.keys(usage)) usage[k] += resp.usage?.[k] || 0;
      const uses = toolUses(resp);
      if (!uses.length) {
        const text = textOf(resp);
        const result = parseJson(text);
        log.info("browser agent finished", { label, turns: turn, ok: Boolean(result?.ok), steps: transcript.length });
        return { ok: Boolean(result?.ok), result, text, turns: turn, transcript, usage };
      }
      convo.push({ role: "assistant", content: resp.content });
      const results = [];
      for (const u of uses) {
        let content;
        try {
          const h = handlers[u.name];
          content = h ? await h(u.input || {}) : `Unknown tool "${u.name}".`;
        } catch (err) {
          content = `Tool "${u.name}" failed: ${err.message}. Snapshot and try another way.`;
        }
        if (u.name === "snapshot" || u.name === "screenshot") observations.push(u.id);
        results.push({ type: "tool_result", tool_use_id: u.id, content });
      }
      convo.push({ role: "user", content: results });
      elideOldObservations(convo, observations);
    }
    log.warn("browser agent hit max turns", { label, maxTurns });
    return { ok: false, result: { ok: false, reason: "max_turns" }, text: "", turns: maxTurns, transcript, usage };
  }));
}

import { test } from "node:test";
import assert from "node:assert";
import { newestInFamily, discoverModelTiers, changeKey, getModelNotifyState, setModelNotifyState, isDeniedModel } from "../src/model-registry.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const catalog = [
  { id: "claude-haiku-4-5", created_at: "2025-10-01T00:00:00Z" },
  { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" },
  { id: "claude-sonnet-4-6", created_at: "2026-01-15T00:00:00Z" },
  { id: "claude-opus-4-7", created_at: "2026-03-01T00:00:00Z" },
  { id: "claude-opus-4-8", created_at: "2026-05-01T00:00:00Z" },
  { id: "claude-fable-5", created_at: "2026-06-01T00:00:00Z" }, // premium: must NOT win heavy
];

const FALLBACK = { triage: "claude-haiku-4-5", standard: "claude-sonnet-4-6", heavy: "claude-opus-4-8" };

test("newestInFamily picks the newest and prefers the undated alias", () => {
  assert.equal(newestInFamily(catalog, "claude-haiku"), "claude-haiku-4-5"); // alias over dated snapshot
  assert.equal(newestInFamily(catalog, "claude-opus"), "claude-opus-4-8");   // 4.8 newer than 4.7
  assert.equal(newestInFamily(catalog, "claude-sonnet"), "claude-sonnet-4-6");
  assert.equal(newestInFamily(catalog, "claude-nope"), null);
});

test("discoverModelTiers reports no changes when config is already newest", async () => {
  const { tiers, changes, ok } = await discoverModelTiers({ listModels: async () => catalog, fallback: FALLBACK });
  assert.equal(ok, true);
  assert.deepEqual(tiers, FALLBACK);
  assert.deepEqual(changes, []);
});

test("heavy stays on the Opus family even though Fable is newer/premium", async () => {
  const { tiers } = await discoverModelTiers({ listModels: async () => catalog, fallback: FALLBACK });
  assert.equal(tiers.heavy, "claude-opus-4-8");
  assert.notEqual(tiers.heavy, "claude-fable-5");
});

test("discoverModelTiers detects a newer Sonnet (e.g. a future Sonnet 6)", async () => {
  const withSonnet6 = [...catalog, { id: "claude-sonnet-6", created_at: "2026-09-01T00:00:00Z" }];
  const { tiers, changes } = await discoverModelTiers({ listModels: async () => withSonnet6, fallback: FALLBACK });
  assert.equal(tiers.standard, "claude-sonnet-6");
  assert.deepEqual(changes, [{ tier: "standard", from: "claude-sonnet-4-6", to: "claude-sonnet-6" }]);
});

test("isDeniedModel matches the alias and its dated snapshots, not siblings", () => {
  const deny = ["claude-sonnet-5"];
  assert.equal(isDeniedModel("claude-sonnet-5", deny), true);
  assert.equal(isDeniedModel("claude-sonnet-5-20260901", deny), true, "dated snapshot of a denied model");
  assert.equal(isDeniedModel("claude-sonnet-4-6", deny), false);
  assert.equal(isDeniedModel("claude-sonnet-50", deny), false, "must not over-match a different number");
  // A LATER VERSION in the same family is a different model and must stay allowed.
  assert.equal(isDeniedModel("claude-sonnet-5-5", deny), false, "a newer point release is not the denied model");
  assert.equal(isDeniedModel("claude-sonnet-5-5-20261001", deny), false);
});

test("the default denylist is empty (the sonnet-5 'empty output' was a max_tokens bug, not the model)", async () => {
  const withSonnet5 = [...catalog, { id: "claude-sonnet-5", created_at: "2026-09-01T00:00:00Z" }];
  const { tiers } = await discoverModelTiers({ listModels: async () => withSonnet5, fallback: FALLBACK });
  assert.equal(tiers.standard, "claude-sonnet-5", "nothing is denied by default");
});

test("an explicit denylist keeps a model from being auto-selected or notified", async () => {
  const withSonnet5 = [...catalog, { id: "claude-sonnet-5", created_at: "2026-09-01T00:00:00Z" }];
  const { tiers, changes } = await discoverModelTiers({ listModels: async () => withSonnet5, fallback: FALLBACK, denylist: ["claude-sonnet-5"] });
  assert.equal(tiers.standard, "claude-sonnet-4-6", "denied model must not win the tier");
  assert.deepEqual(changes, [], "and it must not be surfaced as an available upgrade");
});

test("a family missing from the catalog keeps the configured tier", async () => {
  const noHaiku = catalog.filter((m) => !m.id.startsWith("claude-haiku"));
  const { tiers } = await discoverModelTiers({ listModels: async () => noHaiku, fallback: FALLBACK });
  assert.equal(tiers.triage, "claude-haiku-4-5"); // fallback retained
});

test("API failure keeps configured tiers and reports ok:false", async () => {
  const { tiers, changes, ok } = await discoverModelTiers({
    listModels: async () => { throw new Error("network down"); },
    fallback: FALLBACK,
  });
  assert.equal(ok, false);
  assert.deepEqual(tiers, FALLBACK);
  assert.deepEqual(changes, []);
});

test("notify state persists across reads (survives restart) and defaults cleanly", async () => {
  const path = join(tmpdir(), `model-notify-${process.pid}.json`);
  process.env.MODEL_NOTIFY_STATE_PATH = path;
  try {
    // No file yet -> safe defaults
    assert.deepEqual(await getModelNotifyState(), { lastCheckAt: 0, notifiedKey: null });
    // Persist a key, then a fresh read (simulating a restart) returns it -> no re-notify
    await setModelNotifyState({ lastCheckAt: 1234, notifiedKey: "standard:claude-sonnet-5" });
    const reloaded = await getModelNotifyState();
    assert.equal(reloaded.notifiedKey, "standard:claude-sonnet-5");
    assert.equal(reloaded.lastCheckAt, 1234);
  } finally {
    await rm(path, { force: true });
    delete process.env.MODEL_NOTIFY_STATE_PATH;
  }
});

test("changeKey is stable regardless of order", () => {
  const a = changeKey([{ tier: "standard", to: "claude-sonnet-5" }, { tier: "triage", to: "claude-haiku-5" }]);
  const b = changeKey([{ tier: "triage", to: "claude-haiku-5" }, { tier: "standard", to: "claude-sonnet-5" }]);
  assert.equal(a, b);
});

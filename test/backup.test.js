import { test } from "node:test";
import assert from "node:assert";
import { selectBackupFiles } from "../src/backup.js";

test("selectBackupFiles backs up state JSON (incl. subdirs like decisions) but never the model cache", () => {
  const paths = [
    "brain.json",
    "tasks.json",
    "pending-approvals.json",
    "decisions/finance.json",
    "decisions/chef.json",
    "models/Xenova/all-MiniLM-L6-v2/config.json", // the 87MB embeddings cache — must be excluded
    "models/onnx/model.json",
    "notes.txt", // non-JSON ignored
  ];
  const kept = selectBackupFiles(paths, new Set(["models"]));
  assert.deepEqual(kept.sort(), [
    "brain.json",
    "decisions/chef.json",
    "decisions/finance.json",
    "pending-approvals.json",
    "tasks.json",
  ]);
  // The model cache is never backed up (regenerable, huge).
  assert.ok(!kept.some((p) => p.startsWith("models/")));
});

test("selectBackupFiles tolerates empty / missing input and honors custom excludes", () => {
  assert.deepEqual(selectBackupFiles(), []);
  assert.deepEqual(selectBackupFiles([]), []);
  // A top-level json named like an excluded dir is still kept (only paths UNDER the dir are excluded).
  assert.deepEqual(selectBackupFiles(["models.json", "cache/x.json"], new Set(["cache"])), ["models.json"]);
});

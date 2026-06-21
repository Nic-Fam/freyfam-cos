import { test } from "node:test";
import assert from "node:assert";
import { cosine, embed, isEnabled } from "../src/embeddings.js";

// The suite runs with EMBEDDINGS_PROVIDER=none (see package.json) so it stays
// offline and never downloads a model. These pin the degrade-gracefully path
// and the pure cosine helper. Live model recall is verified out of band.

test("cosine of unit vectors is the dot product, 0 on mismatch", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0, 0], [1, 0]), 0); // length mismatch
  assert.equal(cosine(null, [1]), 0);
});

test("embed() returns null when the provider is disabled", async () => {
  assert.equal(isEnabled(), false);
  assert.equal(await embed("anything"), null);
});

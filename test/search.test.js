import { test } from "node:test";
import assert from "node:assert";
import { mapBraveResults } from "../src/search.js";
import { specialistTools } from "../src/agents/tools.js";

test("mapBraveResults maps and caps the web results", () => {
  const payload = {
    web: {
      results: [
        { title: "A", url: "https://a.com", description: "first" },
        { title: "B", url: "https://b.com", description: "second" },
        { title: "C", url: "https://c.com", description: "third" },
      ],
    },
  };
  assert.deepEqual(mapBraveResults(payload, 2), [
    { title: "A", url: "https://a.com", snippet: "first" },
    { title: "B", url: "https://b.com", snippet: "second" },
  ]);
});

test("mapBraveResults tolerates a missing web block", () => {
  assert.deepEqual(mapBraveResults({}, 5), []);
});

const hasSearch = (agent) => specialistTools(agent).tools.some((t) => t.name === "search");

test("search is granted to resale and security", () => {
  assert.equal(hasSearch("resale"), true);
  assert.equal(hasSearch("security"), true);
});

test("search is NOT granted to finance (locked down) or chef/dev (on demand)", () => {
  assert.equal(hasSearch("finance"), false);
  assert.equal(hasSearch("chef"), false);
  assert.equal(hasSearch("dev"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { unavailableInventory } from "./codeLoadState.js";

test("a failed first load cannot be reported as an empty month", () => {
  assert.equal(unavailableInventory(false, true, 0).title, "Could not load codes");
  assert.equal(unavailableInventory(true, false, 0).title, "Loading codes…");
});
test("a successful empty response and saved records keep their normal inventory display", () => {
  assert.equal(unavailableInventory(false, false, 0), null);
  assert.equal(unavailableInventory(false, true, 50), null);
});

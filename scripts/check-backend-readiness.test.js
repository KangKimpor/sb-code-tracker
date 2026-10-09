import test from "node:test";
import assert from "node:assert/strict";
import { checkBackendReadiness } from "./check-backend-readiness.js";

test("a server-dependent frontend cannot build before rollout is confirmed", () => {
  for (const source of ['import { getFunctions } from "firebase/functions";', "import { getFunctions } from 'firebase/functions';"]) {
    assert.throws(() => checkBackendReadiness(source), /requires the deployed Firebase backend/);
    assert.throws(() => checkBackendReadiness(source, "false"), /requires the deployed Firebase backend/);
    assert.doesNotThrow(() => checkBackendReadiness(source, "true"));
  }
});
test("the compatible frontend can build against the existing Firebase setup", () => {
  assert.doesNotThrow(() => checkBackendReadiness('import { getFirestore } from "firebase/firestore";'));
});

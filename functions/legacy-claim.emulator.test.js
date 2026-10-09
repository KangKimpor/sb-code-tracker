import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { claimCode } from "../src/claimCode.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with npm run test:security, never against production.");
let env;
// The compatibility claim is tested with the deployed rule's available-to-taken constraint.
const rules = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /codes/{id} {
    allow read: if true;
    allow update: if resource.data.status == 'available'
      && request.resource.data.status == 'taken'
      && request.resource.data.code == resource.data.code
      && request.resource.data.createdAt == resource.data.createdAt
      && request.resource.data.monthKey == resource.data.monthKey
      && request.resource.data.takenAt == request.time
      && request.resource.data.takenBy is string
      && request.resource.data.takenBy.size() > 0
      && request.resource.data.takenBy.size() <= 60
      && request.resource.data.takenDevice is string;
  }
}}`;
before(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  env = await initializeTestEnvironment({ projectId: "demo-sb-code-tracker", firestore: { host, port: Number(port), rules } });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), "codes/current"), {
    code: "TEST-VOUCHER", monthKey: "2026-10", status: "available", takenBy: null, takenAt: null, createdAt: 1,
  }));
});
after(async () => { await env?.cleanup(); });
test("compatible claims wait for confirmation and concurrent requests have one winner", async () => {
  const one = env.unauthenticatedContext().firestore(), two = env.unauthenticatedContext().firestore();
  const results = await Promise.allSettled([
    claimCode(one, "current", "One", "device-one", "2026-10"),
    claimCode(two, "current", "Two", "device-two", "2026-10"),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "fulfilled").value, "TEST-VOUCHER");
  const loser = results.find(r => r.status === "rejected").reason;
  assert.ok(loser.message === "already_taken" || loser.code === "permission-denied");
  assert.equal((await getDoc(doc(one, "codes/current"))).data().status, "taken");
});
test("a stale month or nonexistent code does not reveal a voucher or change the record", async () => {
  const client = env.unauthenticatedContext().firestore();
  await assert.rejects(claimCode(client, "current", "Staff", "device", "2026-11"), /wrong_month/);
  await assert.rejects(claimCode(client, "missing", "Staff", "device", "2026-10"), /already_taken/);
  assert.equal((await getDoc(doc(client, "codes/current"))).data().status, "available");
});

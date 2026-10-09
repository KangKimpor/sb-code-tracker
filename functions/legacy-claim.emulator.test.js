import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, disableNetwork, enableNetwork } from "firebase/firestore";
import { claimCode } from "../src/claimCode.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with npm run test:security, never against production.");
let env;
const row = { id: "current", code: "TEST-VOUCHER", monthKey: "2026-10", status: "available", createdAt: 1 };
// The compatibility claim is tested with the deployed rule's available-to-taken constraint.
const rules = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /codes/{id} {
    allow read: if true;
    allow update: if resource.data.status == 'available'
      && request.resource.data.status == 'taken'
      && request.resource.data.code == resource.data.code
      && request.resource.data.createdAt == resource.data.createdAt
      && request.resource.data.get('monthKey', '') == resource.data.get('monthKey', '')
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
test("concurrent compatible writes have one confirmed winner", async () => {
  const one = env.unauthenticatedContext().firestore(), two = env.unauthenticatedContext().firestore();
  const results = await Promise.allSettled([
    claimCode(one, row, "One", "device-one", "2026-10"),
    claimCode(two, row, "Two", "device-two", "2026-10"),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "fulfilled").value, "TEST-VOUCHER");
  const loser = results.find(r => r.status === "rejected").reason;
  assert.ok(loser.message === "already_taken" || loser.code === "permission-denied");
  assert.equal((await getDoc(doc(one, "codes/current"))).data().status, "taken");
});
test("a wrong month cannot queue a reveal and a nonexistent code cannot be saved", async () => {
  const client = env.unauthenticatedContext().firestore();
  let revealed = false;
  await assert.rejects(claimCode(client, row, "Staff", "device", "2026-11", () => { revealed = true; }), /wrong_month/);
  assert.equal(revealed, false);
  await assert.rejects(claimCode(client, { ...row, id: "missing" }, "Staff", "device", "2026-10"));
  assert.equal((await getDoc(doc(client, "codes/current"))).data().status, "available");
});
test("stale cached voucher data cannot overwrite server inventory", async () => {
  const client = env.unauthenticatedContext().firestore();
  for (const stale of [{ code: "OLD-VOUCHER" }, { createdAt: 0 }, { monthKey: "2026-09" }]) {
    await assert.rejects(claimCode(client, { ...row, ...stale }, "Staff", "device", stale.monthKey || "2026-10"));
  }
  assert.equal((await getDoc(doc(client, "codes/current"))).data().status, "available");
});
test("legacy unlabelled vouchers remain claimable", async () => {
  const legacy = { ...row, id: "legacy" };
  delete legacy.monthKey;
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), "codes/legacy"), {
    code: legacy.code, status: legacy.status, createdAt: legacy.createdAt, takenBy: null, takenAt: null,
  }));
  assert.equal(await claimCode(env.unauthenticatedContext().firestore(), legacy, "Staff", "device", "2026-10"), legacy.code);
});
test("a queued claim reveals immediately while server confirmation is pending", async () => {
  const client = env.unauthenticatedContext().firestore();
  await getDoc(doc(client, "codes/current"));
  await disableNetwork(client);
  let revealed = null;
  let confirmed = false;
  const pending = claimCode(client, row, "Staff", "device", "2026-10", code => { revealed = code; })
    .then(value => { confirmed = true; return value; });
  try {
    assert.equal(revealed, row.code);
    await getDoc(doc(client, "codes/current"));
    assert.equal(confirmed, false);
    assert.equal((await getDoc(doc(client, "codes/current"))).data().status, "taken");
  } finally { await enableNetwork(client); }
  assert.equal(await pending, row.code);
  assert.equal(confirmed, true);
});

test("an immediately revealed competing claim still reports its server rejection", async () => {
  const client = env.unauthenticatedContext().firestore();
  await claimCode(env.unauthenticatedContext().firestore(), row, "Winner", "winner-device", "2026-10");
  let revealed = null;
  await assert.rejects(claimCode(client, row, "Loser", "loser-device", "2026-10", code => { revealed = code; }), { code: "permission-denied" });
  assert.equal(revealed, row.code);
  assert.equal((await getDoc(doc(client, "codes/current"))).data().takenBy, "Winner");
});

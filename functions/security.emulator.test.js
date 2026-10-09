import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, query, limit } from "firebase/firestore";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { initializeApp as initializeClient, deleteApp as deleteClient } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut } from "firebase/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { handleRequest, expireCodes, inventoryOf, monthKey } from "./tracker.js";

const projectId = "demo-sb-code-tracker";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Run through npm run test:security; never run against production.");
let env, db, adminApp;
const adminAuth = { uid: "admin-test", token: { adminUntil: Math.floor(Date.now() / 1000) + 3600 } };
const request = (data, auth, ip = "127.0.0.1") => ({ data, auth, rawRequest: { ip } });
const call = (data, auth, ip) => handleRequest(request({ requestId: randomUUID(), ...data }, auth, ip), db, "123456", async (uid, claims) => ({ uid, ...claims }));
const code = (month = monthKey()) => ({ code: "VOUCHER-SECRET", monthKey: month, status: "available", takenBy: null, takenAt: null, createdAt: Date.now() });
async function seed(id, value) {
  await db.collection("codes").doc(id).set(value);
  await db.collection("codeInventory").doc(id).set(inventoryOf(id, value));
}
before(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: await readFile("firestore.rules", "utf8") } });
  adminApp = initializeApp({ projectId }, "security-tests");
  db = getFirestore(adminApp);
});
beforeEach(async () => { await env.clearFirestore(); await seed("current", code()); });
after(async () => { await env?.cleanup(); if (adminApp) await deleteApp(adminApp); });

test("staff can read bounded safe inventory but cannot enumerate raw voucher values", async () => {
  const staff = env.unauthenticatedContext().firestore();
  const inventory = await assertSucceeds(getDocs(query(collection(staff, "codeInventory"), limit(2000))));
  assert.equal(inventory.size, 1);
  assert.equal(JSON.stringify(inventory.docs[0].data()).includes("VOUCHER-SECRET"), false);
  await assertFails(getDocs(collection(staff, "codeInventory")));
  await assertFails(getDocs(query(collection(staff, "codeInventory"), limit(2001))));
  for (const path of ["codes/current", "activityLog/entry", "releaseHistory/entry", "topupRequests/entry", "_rateLimits/entry", "_requestCooldowns/entry"]) await assertFails(getDoc(doc(staff, path)));
});
test("private reads require a valid, unexpired server admin claim", async () => {
  for (const claims of [{}, { adminUntil: 0 }, { adminUntil: "99999999999" }]) {
    await assertFails(getDoc(doc(env.authenticatedContext("user", claims).firestore(), "codes/current")));
  }
  const admin = env.authenticatedContext("admin", adminAuth.token).firestore();
  assert.equal((await assertSucceeds(getDoc(doc(admin, "codes/current")))).data().code, "VOUCHER-SECRET");
  await assertSucceeds(getDocs(collection(admin, "releaseHistory")));
});
test("direct client writes and forged audit/history records are denied even for admins", async () => {
  for (const context of [env.unauthenticatedContext(), env.authenticatedContext("admin", adminAuth.token)]) {
    const client = context.firestore();
    for (const name of ["codes", "codeInventory", "activityLog", "releaseHistory", "topupRequests", "_rateLimits", "_requestCooldowns"]) {
      await assertFails(setDoc(doc(client, name, "forged"), { code: "FORGED", takenAt: { toString: {} } }));
    }
    await assertFails(updateDoc(doc(client, "codes/current"), { status: "taken", takenBy: "Imposter" }));
    await assertFails(deleteDoc(doc(client, "codes/current")));
  }
});
test("competing staff claims yield one voucher and one atomic audit entry", async () => {
  const results = await Promise.allSettled([
    call({ action: "claim", id: "current", name: "One", deviceId: "one" }, undefined, "1.1.1.1"),
    call({ action: "claim", id: "current", name: "Two", deviceId: "two" }, undefined, "2.2.2.2"),
  ]);
  const winner = results.filter(r => r.status === "fulfilled");
  assert.equal(winner.length, 1);
  assert.equal(winner[0].value.code, "VOUCHER-SECRET");
  assert.equal(results.find(r => r.status === "rejected").reason.code, "already-exists");
  const stored = (await db.collection("codes").doc("current").get()).data();
  assert.equal(stored.status, "taken");
  assert.equal(stored.takenBy, winner[0].value.name);
  assert.equal((await db.collection("activityLog").get()).size, 1);
  assert.equal((await db.collection("codeInventory").doc("current").get()).data().code.includes("VOUCHER"), false);
});
test("staff cannot claim future or expired drops or bypass validation with injected fields", async () => {
  for (const [id, month] of [["future", "2099-12"], ["expired", "2000-01"]]) {
    await seed(id, code(month));
    await assert.rejects(call({ action: "claim", id, name: "Staff", deviceId: "device", monthKey: monthKey(), takenAt: 1 }), { code: "failed-precondition" });
    assert.equal((await db.collection("codes").doc(id).get()).data().status, "available");
  }
  for (const data of [{ id: "codes/current", name: "Staff" }, { id: "current", name: "x".repeat(61) }, { id: "current", name: "\n" }]) await assert.rejects(call({ action: "claim", deviceId: "device", ...data }), { code: "invalid-argument" });
});
test("a retry can recover its own claim but another nonce cannot read that voucher", async () => {
  const data = { action: "claim", id: "current", name: "Staff", deviceId: "device", requestId: randomUUID() };
  assert.deepEqual(await call(data), await call(data));
  await assert.rejects(call({ ...data, requestId: randomUUID() }), { code: "already-exists" });
  assert.equal((await db.collection("activityLog").get()).size, 1);
  assert.equal(JSON.stringify((await db.collection("codeInventory").doc("current").get()).data()).includes(data.requestId), false);
});
test("PIN verification creates expiring server claims and throttles wrong attempts", async () => {
  const result = await call({ action: "login", pin: "123456", adminUntil: 99999999999 }, undefined, "3.3.3.3");
  assert.equal(result.token.uid, "tracker-admin");
  assert.ok(result.token.adminUntil <= Date.now() / 1000 + 3600);
  for (let i = 0; i < 5; i++) await assert.rejects(call({ action: "login", pin: "000000" }, undefined, "4.4.4.4"), { code: "unauthenticated" });
  await assert.rejects(call({ action: "login", pin: "123456" }, undefined, "4.4.4.4"), { code: "resource-exhausted" });
});
test("server PIN token signs the browser in with a real, verifiable one-hour admin claim", async () => {
  const clientApp = initializeClient({ projectId, apiKey: "demo-key" }, "pin-session-test");
  const auth = getAuth(clientApp);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  try {
    const result = await handleRequest(request({ action: "login", pin: "123456" }), db, "123456",
      (uid, claims) => getAdminAuth(adminApp).createCustomToken(uid, claims));
    const signed = await signInWithCustomToken(auth, result.token);
    const verified = await getAdminAuth(adminApp).verifyIdToken(await signed.user.getIdToken());
    assert.equal(verified.uid, "tracker-admin");
    assert.ok(verified.adminUntil > Date.now() / 1000);
    assert.ok(verified.adminUntil <= Date.now() / 1000 + 3600);
    await call({ action: "export" }, { uid: verified.uid, token: verified });
  } finally { await signOut(auth); await deleteClient(clientApp); }
});
test("a full global rate bucket cannot be bypassed or grow storage with new IPs", async () => {
  const hash = value => createHash("sha256").update(value).digest("hex");
  await db.collection("_rateLimits").doc(hash("global:login")).set({ count: 100, until: Date.now() + 3600000 });
  await assert.rejects(call({ action: "login", pin: "123456", ip: "forged" }, undefined, "new-ip"), { code: "resource-exhausted" });
  assert.equal((await db.collection("_rateLimits").doc(hash("login:new-ip")).get()).exists, false);
});
test("release uses stored data and atomically writes validated history with server time", async () => {
  await call({ action: "claim", id: "current", name: "Staff", deviceId: "device" });
  await assert.rejects(call({ action: "release", id: "current" }), { code: "permission-denied" });
  await call({ action: "release", id: "current", takenBy: "FORGED", takenAt: { toString: {} }, releasedAt: 1 }, adminAuth);
  const history = (await db.collection("releaseHistory").get()).docs[0].data();
  assert.equal(history.takenBy, "Staff");
  assert.ok(history.takenAt.toMillis() > Date.now() - 60000);
  assert.ok(history.releasedAt.toMillis() > Date.now() - 60000);
  assert.equal(history.source, "server");
  assert.equal((await db.collection("codes").doc("current").get()).data().status, "available");
  assert.equal((await db.collection("activityLog").get()).size, 2);
});
test("old malformed takenAt is sanitized during release", async () => {
  await seed("bad", { ...code(), status: "taken", takenBy: "Staff", takenAt: { toString: {} }, takenDevice: {} });
  await call({ action: "release", id: "bad" }, adminAuth);
  const history = (await db.collection("releaseHistory").get()).docs[0].data();
  assert.equal(history.takenAt, null);
  assert.equal(history.takenDevice, null);
});
test("admin add, label and deletion maintain safe inventory and server audits", async () => {
  assert.equal((await call({ action: "add", codes: ["ONE", "ONE", "TWO"], monthKey: monthKey() }, adminAuth)).count, 2);
  assert.equal((await call({ action: "add", codes: ["ONE"], monthKey: monthKey() }, adminAuth)).count, 0);
  await seed("legacy", { ...code(), monthKey: "" });
  await call({ action: "label", ids: ["legacy"] }, adminAuth);
  assert.equal((await db.collection("codes").doc("legacy").get()).data().monthKey, monthKey());
  await call({ action: "delete", ids: ["legacy"] }, adminAuth);
  assert.equal((await db.collection("codes").doc("legacy").get()).exists, false);
  assert.equal((await db.collection("codeInventory").doc("legacy").get()).exists, false);
  for (const log of (await db.collection("activityLog").get()).docs) assert.equal(log.data().source, "server");
});
test("top-up cooldown persists after admin clearing and limits device-ID churn by IP", async () => {
  const first = await call({ action: "requestTopup", deviceId: "device", ts: 1, monthKey: "2099-01" });
  assert.equal(first.monthKey, monthKey());
  assert.ok(first.ts > Date.now() - 60000);
  await call({ action: "clearRequests" }, adminAuth);
  await assert.rejects(call({ action: "requestTopup", deviceId: "device" }), { code: "resource-exhausted" });
  for (let i = 0; i < 28; i++) await call({ action: "requestTopup", deviceId: `device-${i}` });
  await assert.rejects(call({ action: "requestTopup", deviceId: "new-device" }), { code: "resource-exhausted" });
});
test("retention uses server cutoff and preserves recent records", async () => {
  const now = Date.now();
  for (const [id, ts] of [["old", now - 31 * 86400000], ["recent", now]]) {
    await db.collection("activityLog").doc(id).set({ ts });
    await db.collection("topupRequests").doc(id).set({ ts });
    await db.collection("releaseHistory").doc(id).set({ releasedAt: Timestamp.fromMillis(ts) });
  }
  const result = await call({ action: "clearOldLogs", cutoff: now + 99999999999 }, adminAuth);
  assert.deepEqual(result, { logCount: 1, relCount: 1, reqCount: 1 });
  assert.equal((await db.collection("releaseHistory").doc("recent").get()).exists, true);
});
test("scheduled expiry preserves future and legacy drops", async () => {
  await seed("old", code("2000-01"));
  await seed("future", code("2099-12"));
  const batch = db.batch();
  for (let i = 0; i < 201; i++) batch.set(db.collection("codes").doc(`legacy-${i}`), { ...code(), monthKey: "" });
  await batch.commit();
  await seed("legacy", { ...code(), monthKey: "" });
  await expireCodes(db);
  assert.equal((await db.collection("codes").doc("old").get()).exists, false);
  for (const id of ["current", "future", "legacy"]) assert.equal((await db.collection("codes").doc(id).get()).exists, true);
  assert.equal((await db.collection("codeInventory").doc("old").get()).exists, false);
});
test("no current drop means scheduled expiry preserves old codes", async () => {
  await db.collection("codes").doc("current").delete();
  await seed("old", code("2000-01"));
  await expireCodes(db);
  assert.equal((await db.collection("codes").doc("old").get()).exists, true);
});
test("migration pages through existing records without changing private originals or publishing vouchers", async () => {
  const original = (await db.collection("codes").doc("current").get()).data();
  const batch = db.batch();
  for (let i = 0; i < 205; i++) batch.set(db.collection("codes").doc(`migrate-${i}`), { ...code(), takenAt: { toString: {} } });
  await batch.commit();
  const { stdout } = await promisify(execFile)(process.execPath, ["functions/migrate.js", projectId], { timeout: 30000 });
  assert.match(stdout, /206 records/);
  assert.deepEqual((await db.collection("codes").doc("current").get()).data(), original);
  const inventory = await db.collection("codeInventory").get();
  assert.equal(inventory.size, 206);
  for (const entry of inventory.docs) {
    assert.equal(entry.data().code.includes("VOUCHER"), false);
    assert.equal(entry.data().takenAt, null);
  }
});

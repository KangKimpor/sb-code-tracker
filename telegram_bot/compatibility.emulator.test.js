import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { claimCode } from "../src/claimCode.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run only in a local Firestore emulator.");
const projectId = "demo-sb-code-tracker";
const run = promisify(execFile);
let env;
// Compatibility transitions plus a strict field whitelist catch bot-specific
// fields that could stop the browser claiming a released or newly added row.
const rules = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /codes/{id} {
    allow read: if true;
    allow update: if request.resource.data.keys().hasOnly(
      ['code', 'monthKey', 'status', 'takenBy', 'takenAt', 'takenDevice', 'createdAt'])
      && resource.data.status == 'available'
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
  match /{document=**} { allow read, write: if false; }
}}`;
before(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules } });
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });

async function python(body) {
  const script = `import sys, json
sys.path.insert(0, 'telegram_bot')
from google.cloud import firestore
from store import Store
from models import fingerprint, month_key, TrackerError
db = firestore.Client(project='demo-sb-code-tracker')
store = Store(db)
${body}`;
  const { stdout } = await run(".venv/bin/python", ["-c", script], { timeout: 30000 });
  return JSON.parse(stdout);
}
const seed = () => python(`store.mutate('add', 7, 'seed', month=month_key(), codes=['TEST-VOUCHER'])
print(json.dumps(store.codes()[0], default=str))`);

test("browser can claim a bot-created voucher and reclaim it after a bot release", async () => {
  const row = await seed();
  assert.equal(await claimCode(env.unauthenticatedContext().firestore(), row, "App Staff", "app-device", row.monthKey), "TEST-VOUCHER");
  const released = await python(`row = store.codes()[0]
store.mutate('release', 7, 'release', id=row['id'], expected=fingerprint(row))
print(json.dumps(store.codes()[0], default=str))`);
  assert.equal(await claimCode(env.unauthenticatedContext().firestore(), released, "Second App Staff", "app-device-2", row.monthKey), "TEST-VOUCHER");
  const value = (await getDoc(doc(env.unauthenticatedContext().firestore(), "codes", row.id))).data();
  assert.equal(value.takenBy, "Second App Staff");
});

test("a real compatibility browser and the Python bot have one confirmed claim winner", async () => {
  const row = await seed();
  const results = await Promise.allSettled([
    claimCode(env.unauthenticatedContext().firestore(), row, "App Staff", "app-device", row.monthKey),
    python(`try:
    store.mutate('claim', 7, 'telegram-claim', id='${row.id}', name='Telegram Staff')
    print('true')
except TrackerError:
    print('false')`).then(won => { if (!won) throw new Error("Bot lost competing claim"); return won; }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});

test("legacy client rules deny retry receipts and rate-limit writes", async () => {
  await seed();
  const client = env.unauthenticatedContext().firestore();
  for (const collection of ["_telegramOperations", "_rateLimits", "_requestCooldowns"]) {
    await assertFails(getDoc(doc(client, collection, "probe")));
    await assertFails(setDoc(doc(client, collection, "probe"), { result: { code: "FORGED" } }));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { pinMatches, inventoryOf, monthKey, handleRequest } from "./tracker.js";

test("PIN fails closed and compares the server secret", () => {
  assert.equal(pinMatches("123456", "123456"), true);
  for (const pair of [["123455", "123456"], [123456, "123456"], ["123456", undefined], ["", ""], ["1234", "1234"]]) assert.equal(pinMatches(...pair), false);
});
test("public inventory excludes voucher and device values and sanitizes old timestamps", () => {
  const result = inventoryOf("random123456", { code: "SECRET", takenDevice: "PRIVATE", status: "taken", takenBy: "Staff", takenAt: { toString: {} }, createdAt: 12 });
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(result.takenAt, null);
  assert.equal(inventoryOf("id", { takenAt: Timestamp.fromMillis(1000) }).takenAt.toMillis(), 1000);
});
test("month rolls at ICT midnight", () => {
  assert.equal(monthKey(Date.parse("2026-09-30T16:59:59Z")), "2026-09");
  assert.equal(monthKey(Date.parse("2026-09-30T17:00:00Z")), "2026-10");
});
test("every admin operation rejects absent or expired credentials before accessing storage", async () => {
  for (const action of ["add", "release", "delete", "label", "clearRequests", "clearOldLogs", "export", "unknown"]) {
    for (const auth of [undefined, { token: { adminUntil: 0 } }, { token: { adminUntil: "99999999999" } }]) {
      await assert.rejects(handleRequest({ data: { action }, auth }, null, null, null), { code: "permission-denied" });
    }
  }
});

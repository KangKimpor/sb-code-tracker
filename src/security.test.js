import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase/firestore";
import { toMs, csvSafe } from "./security.js";

test("timestamps accept Firestore and finite legacy milliseconds without coercing objects", () => {
  assert.equal(toMs(Timestamp.fromMillis(1234)), 1234);
  assert.equal(toMs(1234), 1234);
  assert.equal(toMs(0), 0);
  for (const value of [null, undefined, "1234", NaN, Infinity, 8640000000000001, { toString: {} }, { toMillis() { throw Error("must not call"); } }]) {
    assert.equal(toMs(value), null);
  }
});
test("CSV cells neutralize formulas behind whitespace and control prefixes", () => {
  for (const value of ["=SUM(1,2)", "+1", "-1", "@SUM(1)", "\t=1", "\r+1", "\n@a", "   =1", "\uFEFF=1", "\u0000-1"]) assert.equal(csvSafe(value), `'${value}`);
  assert.equal(csvSafe("ABC123"), "ABC123");
  assert.equal(csvSafe("Soklim Sim"), "Soklim Sim");
});

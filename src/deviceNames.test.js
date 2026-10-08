import test from "node:test";
import assert from "node:assert/strict";
import { suggestDeviceName } from "./deviceNames.js";

const claim = (takenDevice, takenBy) => ({ status: "taken", takenDevice, takenBy });

test("the owner's four device suffixes suggest the supplied names", () => {
  for (const [suffix, name] of [
    ["c02e05", "Soklim Sim"], ["0cf376", "Sothea Sorn"],
    ["801a50", "Kimpor Kang"], ["643595", "Hongsrun Lang"],
  ]) assert.equal(suggestDeviceName(`full-device-${suffix}`, null, []), name);
});

test("a confirmed correction on the full device ID overrides the starting name", () => {
  assert.equal(suggestDeviceName("device-801a50", { deviceId: "device-801a50", name: "  New   Name " }, []), "New Name");
  assert.equal(suggestDeviceName("device-801a50", { deviceId: "other-801a50", name: "Wrong Person" }, []), "Kimpor Kang");
});

test("learns a consistent name from records already loaded for this exact device", () => {
  const records = [claim("device-unknown", "Staff Name"), claim("device-unknown", " STAFF   NAME ")];
  assert.equal(suggestDeviceName("device-unknown", null, records), "STAFF NAME");
  assert.equal(suggestDeviceName("other-unknown", null, records), "");
});

test("shared devices with conflicting names are left blank", () => {
  assert.equal(suggestDeviceName("device-shared", null, [claim("device-shared", "Person One"), claim("device-shared", "Person Two")]), "");
});

test("ignores malformed memory, empty names, oversized names, and released records", () => {
  for (const remembered of [null, {}, { deviceId: "device", name: 42 }, { deviceId: "device", name: " " }, { deviceId: "device", name: "x".repeat(61) }]) {
    assert.equal(suggestDeviceName("device", remembered, []), "");
  }
  assert.equal(suggestDeviceName("device", null, [{ ...claim("device", "Previous Name"), status: "available" }]), "");
  assert.equal(suggestDeviceName("", null, [claim("", "Wrong Person")]), "");
});

test("accepts names in other writing systems", () => {
  assert.equal(suggestDeviceName("device", { deviceId: "device", name: "សុខលីម" }, []), "សុខលីម");
});

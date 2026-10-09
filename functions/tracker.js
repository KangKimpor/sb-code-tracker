import { createHash, timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

const HOUR = 60 * 60 * 1000;
const MONTH = 30 * 24 * HOUR;
export const monthKey = (ms = Date.now()) => new Date(ms + 7 * HOUR).toISOString().slice(0, 7);
const hash = value => createHash("sha256").update(value).digest("hex");
export const pinMatches = (given, expected) => typeof given === "string" && /^\d{6}$/.test(given) &&
  typeof expected === "string" && /^\d{6}$/.test(expected) &&
  timingSafeEqual(Buffer.from(hash(given), "hex"), Buffer.from(hash(expected), "hex"));

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new HttpsError("invalid-argument", `Invalid ${label}.`);
  }
  return value.trim();
}
const idOf = value => {
  const id = text(value, "code ID", 128);
  if (id.includes("/") || id === "." || id === "..") throw new HttpsError("invalid-argument", "Invalid code ID.");
  return id;
};
function idsOf(values) {
  if (!Array.isArray(values) || !values.length || values.length > 200) throw new HttpsError("invalid-argument", "Select between 1 and 200 codes.");
  return [...new Set(values.map(idOf))];
}
export function inventoryOf(id, code) {
  // Voucher values and device IDs stay private; only display metadata is published.
  return {
    code: `Code ${id.slice(-6)}`, monthKey: typeof code.monthKey === "string" ? code.monthKey : "",
    status: code.status === "taken" ? "taken" : "available",
    takenBy: typeof code.takenBy === "string" ? code.takenBy.slice(0, 60) : null,
    takenAt: code.takenAt instanceof Timestamp ? code.takenAt : null,
    createdAt: Number.isFinite(code.createdAt) ? code.createdAt : 0,
  };
}
function audit(writer, db, type, message, deviceId = null) {
  writer.set(db.collection("activityLog").doc(), { type, text: message.slice(0, 500), ts: Date.now(), deviceId, source: "server" });
}
function mirror(writer, db, ref, value) {
  writer.set(ref, value);
  writer.set(db.collection("codeInventory").doc(ref.id), inventoryOf(ref.id, value));
}
async function rateLimit(db, limits) {
  const refs = limits.map(([key]) => db.collection("_rateLimits").doc(hash(key)));
  await db.runTransaction(async tx => {
    const snaps = await tx.getAll(...refs);
    const now = Date.now();
    const buckets = snaps.map((snap, index) => {
      const [, maximum, windowMs] = limits[index];
      const prior = snap.data();
      const active = prior && prior.until > now;
      if (active && prior.count >= maximum) throw new HttpsError("resource-exhausted", "Too many attempts. Please try later.");
      const until = active ? prior.until : now + windowMs;
      return { count: active ? prior.count + 1 : 1, until, expiresAt: Timestamp.fromMillis(until + MONTH) };
    });
    buckets.forEach((bucket, index) => tx.set(refs[index], bucket));
  });
}
function requireAdmin(request) {
  if (!Number.isFinite(request.auth?.token?.adminUntil) || request.auth.token.adminUntil <= Date.now() / 1000) {
    throw new HttpsError("permission-denied", "Enter the admin PIN again.");
  }
}
export async function handleRequest(request, db, secretPin, issueToken) {
  const data = request.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpsError("invalid-argument", "Invalid request.");
  const { action } = data;
  const ip = request.rawRequest?.ip;
  if (action === "login" || action === "claim" || action === "requestTopup") {
    if (!ip) throw new HttpsError("unavailable", "Cannot verify the request origin.");
    // Use the platform-derived IP, never an IP sent in the request body.
    await rateLimit(db, [
      [`${action}:${ip}`, action === "login" ? 5 : 30, action === "login" ? 15 * 60 * 1000 : HOUR],
      [`global:${action}`, action === "login" ? 100 : 300, HOUR],
    ]);
  } else requireAdmin(request);

  if (action === "login") {
    if (!/^\d{6}$/.test(secretPin || "")) throw new HttpsError("failed-precondition", "Admin PIN is not configured.");
    if (!pinMatches(data.pin, secretPin)) throw new HttpsError("unauthenticated", "Incorrect PIN.");
    const adminUntil = Math.floor(Date.now() / 1000) + 3600;
    return { token: await issueToken("tracker-admin", { adminUntil }) };
  }
  if (action === "claim") {
    const id = idOf(data.id);
    const name = text(data.name, "staff name", 60);
    const deviceId = text(data.deviceId, "device ID", 64);
    const requestId = text(data.requestId, "claim request", 36);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new HttpsError("invalid-argument", "Invalid claim request.");
    const ref = db.collection("codes").doc(id);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const code = snap.data();
      if (!code) throw new HttpsError("already-exists", "This code was just taken. Please choose another.");
      if (code.monthKey && code.monthKey !== monthKey()) throw new HttpsError("failed-precondition", "This code is not available this month.");
      const value = text(code.code, "stored code", 64);
      // A secret request nonce recovers a committed claim after a lost response without another audit write.
      if (code.status === "taken" && code.claimRequest === requestId && code.takenBy === name && code.takenDevice === deviceId) {
        return { code: value, name, takenAt: code.takenAt.toMillis() };
      }
      if (code.status !== "available") throw new HttpsError("already-exists", "This code was just taken. Please choose another.");
      const takenAt = Timestamp.now();
      mirror(tx, db, ref, { ...code, status: "taken", takenBy: name, takenAt, takenDevice: deviceId, claimRequest: requestId });
      audit(tx, db, "take", `${name} took ${value}`, deviceId);
      return { code: value, name, takenAt: takenAt.toMillis() };
    });
  }
  if (action === "requestTopup") {
    const deviceId = text(data.deviceId, "device ID", 64);
    const ref = db.collection("_requestCooldowns").doc(hash(deviceId));
    return db.runTransaction(async tx => {
      const prior = await tx.get(ref);
      const now = Date.now();
      if (prior.exists && prior.data().until > now) throw new HttpsError("resource-exhausted", "Admin has already been notified. Please try later.");
      const entry = { monthKey: monthKey(now), ts: now, deviceId };
      tx.set(ref, { until: now + 6 * HOUR, expiresAt: Timestamp.fromMillis(now + MONTH) });
      tx.set(db.collection("topupRequests").doc(), entry);
      audit(tx, db, "request", `Top-up requested for ${entry.monthKey}`, deviceId);
      return { monthKey: entry.monthKey, ts: now };
    });
  }
  if (action === "add") {
    const month = data.monthKey;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < monthKey()) throw new HttpsError("invalid-argument", "Choose the current month or a future month.");
    if (!Array.isArray(data.codes) || !data.codes.length || data.codes.length > 200) throw new HttpsError("invalid-argument", "Add between 1 and 200 codes at a time.");
    const values = [...new Set(data.codes.map(v => text(typeof v === "string" ? v.toUpperCase() : v, "code", 64)))];
    return db.runTransaction(async tx => {
      const current = await tx.get(db.collection("codes").where("monthKey", "==", month));
      const existing = new Set(current.docs.map(d => d.data().code));
      const additions = values.filter(v => !existing.has(v));
      if (current.size + additions.length > 1000) throw new HttpsError("resource-exhausted", "A monthly drop can contain up to 1,000 codes.");
      additions.forEach((code, index) => {
        const ref = db.collection("codes").doc();
        mirror(tx, db, ref, { code, monthKey: month, status: "available", takenBy: null, takenAt: null, takenDevice: null, createdAt: Date.now() + index });
      });
      audit(tx, db, month === monthKey() ? "add" : "schedule", `Added ${additions.length} code(s) for ${month}`);
      return { count: additions.length };
    });
  }
  if (action === "release") {
    const ref = db.collection("codes").doc(idOf(data.id));
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const code = snap.data();
      if (!code || code.status !== "taken") throw new HttpsError("failed-precondition", "This code is no longer taken.");
      mirror(tx, db, ref, { ...code, status: "available", takenBy: null, takenAt: null, takenDevice: null, claimRequest: null });
      tx.set(db.collection("releaseHistory").doc(), {
        code: text(code.code, "stored code", 64),
        takenBy: typeof code.takenBy === "string" ? code.takenBy.slice(0, 60) : "-",
        takenAt: code.takenAt instanceof Timestamp ? code.takenAt : null,
        takenDevice: typeof code.takenDevice === "string" ? code.takenDevice.slice(0, 64) : null,
        releasedAt: FieldValue.serverTimestamp(), source: "server",
      });
      audit(tx, db, "release", `Released ${code.code}`);
      return {};
    });
  }
  if (action === "delete" || action === "label") {
    const ids = idsOf(data.ids);
    return db.runTransaction(async tx => {
      const refs = ids.map(id => db.collection("codes").doc(id));
      const snaps = await tx.getAll(...refs);
      if (action === "label" && snaps.some(d => d.exists && d.data().monthKey)) throw new HttpsError("failed-precondition", "Only unlabelled codes can be assigned a month.");
      snaps.filter(d => d.exists).forEach(snap => {
        if (action === "label") mirror(tx, db, snap.ref, { ...snap.data(), monthKey: monthKey() });
        else { tx.delete(snap.ref); tx.delete(db.collection("codeInventory").doc(snap.id)); }
      });
      audit(tx, db, action === "label" ? "schedule" : "delete", `${action === "label" ? "Labelled" : "Deleted"} ${snaps.filter(d => d.exists).length} code(s)`);
      return {};
    });
  }
  if (action === "clearRequests") return prune(db, "topupRequests", "monthKey", "==", monthKey());
  if (action === "clearOldLogs") {
    const cutoff = Date.now() - MONTH;
    const logCount = await prune(db, "activityLog", "ts", "<", cutoff);
    const relCount = await prune(db, "releaseHistory", "releasedAt", "<", Timestamp.fromMillis(cutoff));
    const reqCount = await prune(db, "topupRequests", "ts", "<", cutoff);
    return { logCount, relCount, reqCount };
  }
  if (action === "export") {
    const batch = db.batch();
    audit(batch, db, "export", "CSV export requested");
    await batch.commit();
    return {};
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
}
async function prune(db, collection, field, operator, bound) {
  let count = 0;
  for (;;) {
    const snap = await db.collection(collection).where(field, operator, bound).limit(200).get();
    if (snap.empty) return count;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    audit(batch, db, "delete", `Cleared ${snap.size} records from ${collection}`);
    await batch.commit();
    count += snap.size;
  }
}
export async function expireCodes(db) {
  const month = monthKey();
  const live = await db.collection("codes").where("monthKey", "==", month).limit(1).get();
  if (live.empty) return;
  for (;;) {
    const stale = await db.collection("codes").where("monthKey", ">", "").where("monthKey", "<", month).limit(200).get();
    const targets = stale.docs.filter(d => d.data().monthKey);
    if (!targets.length) return;
    await db.runTransaction(async tx => {
      const fresh = await tx.getAll(...targets.map(d => d.ref));
      let count = 0;
      fresh.forEach(d => {
        if (d.exists && d.data().monthKey && d.data().monthKey < month) {
          tx.delete(d.ref); tx.delete(db.collection("codeInventory").doc(d.id)); count++;
        }
      });
      audit(tx, db, "expire", `Removed ${count} expired code(s) before ${month}`);
    });
  }
}

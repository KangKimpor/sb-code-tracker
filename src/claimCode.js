import { deleteField, doc, updateDoc, serverTimestamp } from "firebase/firestore";

export async function claimCode(db, row, name, deviceId, month, onQueued = () => {}) {
  if (!row || row.status !== "available") throw new Error("already_taken");
  if (row.monthKey && row.monthKey !== month) throw new Error("wrong_month");
  // Live rules reject second claims and changed voucher fields; no extra read is needed.
  const confirmation = updateDoc(doc(db, "codes", row.id), {
    code: row.code, createdAt: row.createdAt,
    monthKey: row.monthKey ?? deleteField(),
    status: "taken", takenBy: name, takenAt: serverTimestamp(), takenDevice: deviceId,
  });
  // Reveal immediately after queuing; callers still handle a rejected server write.
  onQueued(row.code);
  await confirmation;
  return row.code;
}

import { doc, runTransaction, serverTimestamp } from "firebase/firestore";

export async function claimCode(db, id, name, deviceId, month) {
  return runTransaction(db, async transaction => {
    const ref = doc(db, "codes", id);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists() || snapshot.data().status !== "available") throw new Error("already_taken");
    const row = snapshot.data();
    if (row.monthKey && row.monthKey !== month) throw new Error("wrong_month");
    transaction.update(ref, { status: "taken", takenBy: name, takenAt: serverTimestamp(), takenDevice: deviceId });
    return row.code;
  });
}

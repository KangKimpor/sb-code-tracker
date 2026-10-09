import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { inventoryOf } from "./tracker.js";

const projectId = process.argv[2];
if (!projectId) throw new Error("Usage: npm --prefix functions run migrate -- PROJECT_ID (requires Application Default Credentials)");
initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore();
let cursor;
let count = 0;
for (;;) {
  let query = db.collection("codes").orderBy(FieldPath.documentId()).limit(200);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  if (page.empty) break;
  const written = await db.runTransaction(async tx => {
    const latest = await tx.getAll(...page.docs.map(d => d.ref));
    const existing = latest.filter(d => d.exists);
    existing.forEach(d => tx.set(db.collection("codeInventory").doc(d.id), inventoryOf(d.id, d.data())));
    return existing.length;
  });
  count += written;
  cursor = page.docs.at(-1);
}
console.log(`Created safe inventory for ${count} records in ${projectId}; original code records were preserved.`);

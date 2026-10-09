import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { handleRequest, expireCodes } from "./tracker.js";

initializeApp();
const adminPin = defineSecret("ADMIN_PIN");
export const tracker = onCall({
  region: "us-central1", secrets: [adminPin], maxInstances: 5,
  timeoutSeconds: 120, memory: "256MiB",
}, request => handleRequest(request, getFirestore(), adminPin.value(),
  (uid, claims) => getAuth().createCustomToken(uid, claims)));

export const expireMonthlyCodes = onSchedule({
  schedule: "5 0 * * *", timeZone: "Asia/Phnom_Penh",
  region: "us-central1", maxInstances: 1,
}, () => expireCodes(getFirestore()));

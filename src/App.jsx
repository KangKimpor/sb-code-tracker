// Version 1.3.0
import { useState, useEffect, useRef } from "react";
import { Analytics } from "@vercel/analytics/react";
import { initializeApp } from "firebase/app";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, limit, where,
  serverTimestamp, runTransaction, getDocs, writeBatch, Timestamp
} from "firebase/firestore";

// 🔥 Firebase config loaded from environment variables
// Values are set in .env (local) and Vercel Environment Variables (production)
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
// PERF FIX: default getFirestore() has no local cache, so every listener attach and
// every runTransaction (the Take flow) round-trips cold to Firestore's backend with
// no warm channel to reuse. On slow/flaky mobile networks this reads as "laggy, slow
// to load the code" specifically on Take, since the reveal screen intentionally waits
// for server confirmation before showing the code. persistentLocalCache lets the codes
// listener paint from a warm local cache immediately instead of waiting on the network,
// and experimentalAutoDetectLongPolling falls back off WebChannel streaming on networks
// (some mobile carriers, corporate wifi) where it stalls instead of erroring cleanly.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
  experimentalAutoDetectLongPolling: true,
});
const codesRef = collection(db, "codes");
const logsRef = collection(db, "activityLog");
const releaseHistRef = collection(db, "releaseHistory");
// One doc per "we're out" tap from a staff member. Topping up mid-month is normal
// operation here, but the request for it used to happen out of band (a message, or a
// tap on the shoulder), so an empty pool could sit empty simply because nobody told
// the admin. This turns that into a signal the tool itself carries.
const topupReqRef = collection(db, "topupRequests");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// How long a device waits before it can ask for a top-up again. Long enough that
// repeated taps cannot spam the admin, short enough that a pool which empties twice in
// the same month can be reported twice: the second time is the one that matters, and a
// per-month lock would swallow it.
const REQUEST_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Admin alert thresholds.
// At roughly 40 codes for 30 staff, 3 left is about a day of demand: enough notice to
// paste a top-up before anyone is actually turned away.
const LOW_STOCK_THRESHOLD = 3;
// Only nudge about next month's drop inside the last week. Earlier than that it is not yet
// news, and a banner that sits there all month is one people learn to scroll past.
const STAGE_REMINDER_DAYS = 7;

const LS_DEVICE = "sbGrabDeviceId";
const LS_REQUEST = "sbGrabLastRequest";

// ⚠️ NOT A SECURITY BOUNDARY. Vite inlines every VITE_* variable into the public
// bundle at build time, so whatever value this resolves to is readable by anyone
// via DevTools, verified by grepping the built output. `isAdmin` is also plain
// React state and can be flipped in React DevTools without the PIN at all.
// This only prevents accidental clicks on admin controls.
// Real admin gating requires Firebase Auth + custom claims enforced in firestore.rules.
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN || "782945"; // CHANGE THIS or set VITE_ADMIN_PIN in .env
const STATUS = { AVAILABLE: "available", TAKEN: "taken" };

const styles = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }

  :root {
    --bg: #eeeef2;
    --surface: #ffffff;
    --track: #e4e4e9;          /* segmented control + search field */

    --surface-raised: rgba(255,255,255,0.9);
    --surface-2: rgba(116,116,128,0.08);
    --surface-3: rgba(116,116,128,0.12);
    --border: rgba(60,60,67,0.1);
    --border-mid: rgba(60,60,67,0.15);
    --text: #1c1c1e;
    --text-2: #3a3a3c;
    --text-3: #636366;
    --text-4: #aeaeb2;
    --blue: #007aff;
    --blue-light: rgba(0,122,255,0.1);
    --blue-mid: rgba(0,122,255,0.18);
    --green: #34c759;
    --green-dark: #248a3d;
    --green-strong: #1ea94d;   /* hero figure: passes 3:1 at large sizes */

    --green-light: rgba(52,199,89,0.12);
    --green-mid: rgba(52,199,89,0.22);
    --red: #ff3b30;
    --red-dark: #c0392b;
    --red-light: rgba(255,59,48,0.1);
    --red-mid: rgba(255,59,48,0.18);
    --orange: #ff9500;
    --orange-dark: #b26a00;

    --orange-light: rgba(255,149,0,0.1);
    --r-xs: 8px;
    --r-sm: 10px;
    --r: 13px;
    --r-lg: 16px;
    --r-xl: 20px;
    --r-2xl: 26px;
    --sh-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.03);
    --sh: 0 2px 12px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.04);
    --sh-lg: 0 8px 30px rgba(0,0,0,0.09), 0 2px 8px rgba(0,0,0,0.05);
    --sh-xl: 0 20px 60px rgba(0,0,0,0.13), 0 4px 16px rgba(0,0,0,0.06);
    --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
    --font-mono: ui-monospace, 'SF Mono', 'Fira Code', monospace;
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    /* Opaque recessed fill for form controls sitting inside a .mgr-list group, so the
       Code Manager redesign never falls back to the translucent --surface-2/-3 grays.
       Scoped to .mgr-list rather than replacing --surface-2 globally, since --surface-2
       is still load-bearing for the other five modals this task does not touch. */
    --surface-recessed: #f2f2f5;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.1px;
  }

  .page {
    min-height: 100vh;
    display: flex; flex-direction: column;
    width: 100%; max-width: 560px; margin: 0 auto;
    padding: 0 16px 44px;
    text-align: left;   /* index.css centres #root */
  }

  /* ─── HEADER ─── */
  .topbar {
    display: flex; align-items: center; gap: 14px;
    padding: 22px 4px 20px;
  }

  .logo-wrap {
    height: 48px; width: auto;
    background: none; border: none; padding: 0;
    flex-shrink: 0; cursor: pointer; font: inherit;
    display: flex; align-items: center;
    transition: transform 0.18s var(--ease-spring), opacity 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .logo-wrap:hover { transform: scale(1.05); }
  .logo-wrap:active { transform: scale(0.94); opacity: 0.8; }

  /* Height-driven with auto width, so /logo.png can be swapped for a wider
     wordmark version without touching the layout. */
  .logo-img { height: 100%; width: auto; max-width: 104px; object-fit: contain; display: block; }

  .brand { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
  .brand-name {
    font-size: 21px; font-weight: 700; color: var(--text);
    line-height: 1.15; letter-spacing: -0.6px;
  }
  .brand-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    border-radius: 20px; padding: 5px 11px;
    font-size: 12.5px; font-weight: 600; letter-spacing: -0.1px;
    border: 1px solid transparent; white-space: nowrap;
  }
  .pill-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pill.month { background: var(--track); color: var(--text-3); }
  .pill.live { background: var(--track); color: var(--green-strong); }
  .pill.live .pill-dot { background: var(--green); animation: blink 2s infinite; }
  .pill.admin { background: var(--red); border-color: var(--red); color: #fff; }
  .pill.sched { background: rgba(175,82,222,0.10); border-color: rgba(175,82,222,0.28); color: #8e34c4; }
  .pill.sched .pill-dot { background: #af52de; }
  /* Staff waiting on a top-up. Orange rather than red: it is a request to act on, not
     a fault, and red is already spoken for by the admin pill sitting next to it. */
  .pill.req { background: var(--orange-light); border-color: rgba(255,149,0,0.3); color: var(--orange-dark); }
  .pill.req .pill-dot { background: var(--orange); }
  @keyframes blink { 0%,100%{opacity:1;} 50%{opacity:0.3;} }

  .conn-banner {
    background: var(--red-light); color: var(--red);
    border: 1px solid var(--red-mid); border-radius: var(--r-lg);
    padding: 11px 16px; font-size: 13.5px; text-align: center;
    margin-bottom: 14px;
  }
  .conn-banner button {
    margin-left: 10px; background: none; border: 1px solid var(--red); color: var(--red);
    border-radius: var(--r-xs); padding: 3px 11px; font-size: 12.5px; cursor: pointer;
    font-family: var(--font); font-weight: 600;
  }

  .main { flex: 1; display: flex; flex-direction: column; }

  /* ─── AVAILABILITY HERO ─── */
  /* Replaces the three Total/Available/Taken stat cards. Staff only ever asked
     one question here: is there a code left for me. */
  .hero {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--r-2xl); box-shadow: var(--sh);
    padding: 26px 22px; margin-bottom: 16px; text-align: center;
  }
  .hero-num {
    font-size: 30px; font-weight: 800; line-height: 1.1;
    letter-spacing: -1.1px; color: var(--green-strong);
  }
  .hero-num.none { color: var(--text-3); }
  .hero-sub { font-size: 15px; color: var(--text-3); margin-top: 7px; letter-spacing: -0.2px; }
  .hero-sub.urgent { color: var(--orange-dark); font-weight: 600; }

  /* Lives in the hero, not the empty state, so an empty pool always offers a way out
     regardless of which filter is active. Full width and blue, because when it shows it
     is the only action on the screen worth taking. */
  .btn-topup {
    width: 100%; margin-top: 16px;
    background: var(--blue); color: #fff; border: none;
    border-radius: 14px; font-family: var(--font);
    font-size: 14.5px; font-weight: 600; padding: 12px;
    cursor: pointer; transition: background 0.16s, transform 0.16s, box-shadow 0.16s;
    box-shadow: 0 1px 4px rgba(0,122,255,0.3);
    -webkit-tap-highlight-color: transparent;
  }
  .btn-topup:hover:not(:disabled) { background: #0069e0; box-shadow: 0 3px 12px rgba(0,122,255,0.34); }
  .btn-topup:active:not(:disabled) { transform: scale(0.985); }
  .btn-topup:disabled { cursor: default; }
  /* Sent state stays legible rather than dimmed: it is a confirmation, and a greyed-out
     button reads as a failure to a person who just pressed it. */
  .btn-topup.sent {
    background: var(--green-light); color: var(--green-dark);
    box-shadow: none;
  }
  .topup-note { font-size: 12.5px; color: var(--text-4); margin-top: 9px; line-height: 1.45; }

  /* ─── ADMIN ALERTS ─── */
  /* Advisory banners above the hero, admin only. Deliberately not styled as cards: they sit
     between the header and the hero card and should read as an interruption in the flow
     rather than another piece of furniture competing with the availability figure. */
  .admin-alerts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .admin-alert {
    display: flex; align-items: center; gap: 11px; flex-wrap: wrap;
    padding: 12px 14px; border-radius: var(--r-lg);
    border: 1px solid transparent;
    animation: rowIn 0.28s var(--ease-out) both;
  }
  .admin-alert.warn { background: var(--orange-light); border-color: rgba(255,149,0,0.3); }
  .admin-alert.urgent { background: var(--red-light); border-color: var(--red-mid); }
  .admin-alert-ico {
    width: 25px; height: 25px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 700; color: #fff; line-height: 1;
  }
  .admin-alert.warn .admin-alert-ico { background: var(--orange); }
  .admin-alert.urgent .admin-alert-ico { background: var(--red); }
  .admin-alert-main { flex: 1; min-width: 145px; }
  .admin-alert-title { font-size: 13.5px; font-weight: 700; letter-spacing: -0.2px; }
  .admin-alert.warn .admin-alert-title { color: var(--orange-dark); }
  .admin-alert.urgent .admin-alert-title { color: var(--red-dark); }
  .admin-alert-sub { font-size: 12px; color: var(--text-3); line-height: 1.45; margin-top: 2px; }
  /* Solid white against the tint so the action reads as the way out of the alert. */
  .admin-alert-btn {
    background: var(--surface); border: 1px solid var(--border-mid);
    border-radius: 10px; font-family: var(--font);
    font-size: 12.5px; font-weight: 600; color: var(--text-2);
    padding: 8px 14px; cursor: pointer; transition: all 0.15s;
    flex-shrink: 0; white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
  }
  .admin-alert-btn:hover { background: var(--text); color: #fff; border-color: var(--text); }
  .admin-alert-btn:active { transform: scale(0.97); }

  /* ─── TOOLBAR ─── */
  .toolbar { display: flex; flex-direction: column; margin-bottom: 16px; }

  .seg-ctrl {
    display: flex; width: 100%;
    background: var(--track); border-radius: 14px;
    padding: 4px; gap: 2px;
  }
  .seg {
    flex: 1; background: none; border: none; border-radius: 11px;
    font-family: var(--font); font-size: 14.5px; font-weight: 600;
    color: var(--text-2); padding: 9px 6px; cursor: pointer;
    transition: background 0.18s, color 0.18s; white-space: nowrap;
    -webkit-tap-highlight-color: transparent; position: relative;
  }
  .seg.active { background: var(--blue); color: #fff; box-shadow: 0 1px 5px rgba(0,122,255,0.35); }
  .seg:not(.active):hover { color: var(--text); }
  /* Hairline between two inactive segments */
  .seg:not(.active) + .seg:not(.active)::before {
    content: ""; position: absolute; left: -2px; top: 24%; bottom: 24%;
    width: 1px; background: var(--border-mid);
  }

  .btn-mgr {
    display: flex; align-items: center; justify-content: center; gap: 7px;
    width: 100%; margin-top: 10px;
    background: var(--text); color: #fff; border: none;
    border-radius: 14px; font-family: var(--font);
    font-size: 14px; font-weight: 600; padding: 12px;
    cursor: pointer; transition: background 0.16s, transform 0.16s;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-mgr:hover { background: #3a3a3c; }
  .btn-mgr:active { transform: scale(0.985); }

  /* ─── CODE LIST ─── */
  /* Each code is its own card. The .card element is kept as a transparent wrapper
     so the loading and empty states can slot into the same place in the markup.
     NOTE: never use a backtick in this stylesheet, not even inside a comment. It
     closes the surrounding JS template literal, which stays valid syntax, so both
     eslint and the build pass and the app throws on load instead. */
  .card { background: none; border: none; box-shadow: none; }
  .t-body { display: flex; flex-direction: column; gap: 12px; }
  .t-body-inner {
    display: flex; flex-direction: column; gap: 12px;
    animation: listFadeIn 0.22s var(--ease-out) both;
  }
  @keyframes listFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .t-row {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 18px; padding: 16px 18px;
    box-shadow: var(--sh-sm);
    transition: box-shadow 0.18s;
    animation: rowIn 0.28s var(--ease-out) both;
  }
  @keyframes rowIn {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .t-row:hover { box-shadow: var(--sh); }
  .t-row.is-taken { box-shadow: none; background: rgba(255,255,255,0.6); }
  .t-row.is-optimistic { opacity: 0.5; pointer-events: none; }

  .t-code, .t-code-masked {
    flex: 1; min-width: 0;
    font-family: var(--font-mono); font-size: 19px; font-weight: 600;
    color: var(--text); letter-spacing: 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .t-row.is-taken .t-code {
    color: var(--text-4); text-decoration: line-through;
    font-size: 17px; letter-spacing: 0.4px;
  }
  .t-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; min-width: 0; }
  .t-staff {
    font-size: 13.5px; font-weight: 600; color: var(--text-2);
    max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .t-time { font-size: 11.5px; color: var(--text-4); font-family: var(--font-mono); white-space: nowrap; }
  .t-device { font-size: 10.5px; color: var(--text-4); font-family: var(--font-mono); white-space: nowrap; opacity: 0.75; }
  .t-act { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

  /* Badges */
  .bdg {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10.5px; font-weight: 600; border-radius: 20px;
    padding: 2px 8px; border: 1px solid transparent;
  }
  .bdg-dot { width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; }
  .bdg.avail { background: #e3f8e9; color: var(--green-dark); border-color: #b8ecc7; }
  .bdg.avail .bdg-dot { background: var(--green-dark); }
  .bdg.taken { background: #ffe6e4; color: var(--red); border-color: #ffc2bd; }
  .bdg.taken .bdg-dot { background: var(--red); }
  .bdg.sched { background: #f1e3fb; color: #8e34c4; border-color: #ddbdf3; }
  .bdg.sched .bdg-dot { background: #af52de; }
  .bdg.exp { background: var(--surface-recessed); color: var(--text-4); border-color: var(--border-mid); }
  .bdg.exp .bdg-dot { background: var(--text-4); }

  /* Row action buttons */
  .btn-take {
    background: var(--blue); color: #fff; border: none;
    border-radius: 12px; font-family: var(--font);
    font-size: 15px; font-weight: 600; padding: 11px 26px;
    cursor: pointer; transition: background 0.16s, transform 0.16s, box-shadow 0.16s;
    box-shadow: 0 1px 4px rgba(0,122,255,0.32);
    -webkit-tap-highlight-color: transparent;
  }
  .btn-take:hover { background: #0069e0; box-shadow: 0 3px 12px rgba(0,122,255,0.36); }
  .btn-take:active { transform: scale(0.96); }

  .btn-release {
    background: none; border: 1px solid var(--border-mid);
    border-radius: 12px; font-family: var(--font);
    font-size: 13px; font-weight: 600; color: var(--text-3);
    padding: 9px 15px; cursor: pointer; transition: all 0.16s;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-release:hover { border-color: var(--red-mid); color: var(--red); background: var(--red-light); }

  .btn-taken-lock {
    font-size: 12.5px; font-weight: 600; color: var(--text-4);
    padding: 8px 13px; border-radius: 12px;
    background: var(--surface-2);
    display: inline-block; letter-spacing: -0.1px;
  }

  /* ─── EMPTY / LOADING ─── */
  /* Their own card, since the list itself no longer has a container */
  .t-empty, .t-loading {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--r-2xl); box-shadow: var(--sh-sm);
    padding: 52px 24px; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .t-empty-icon {
    width: 46px; height: 46px; border-radius: 50%;
    background: var(--track);
    display: flex; align-items: center; justify-content: center;
    font-size: 21px; margin-bottom: 4px;
  }
  .t-empty-title { font-size: 16px; font-weight: 700; color: var(--text-2); letter-spacing: -0.3px; }
  .t-empty-sub { font-size: 13.5px; color: var(--text-3); line-height: 1.5; max-width: 320px; }

  .spinner {
    width: 24px; height: 24px;
    border: 2.5px solid var(--surface-3);
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .t-loading-text { font-size: 13.5px; color: var(--text-3); }

  /* ─── SMALL PHONES ─── */
  @media (max-width: 420px) {
    .page { padding: 0 12px 36px; }
    .topbar { gap: 11px; padding: 18px 2px 16px; }
    .logo-wrap { height: 40px; }
    .brand-name { font-size: 18.5px; }
    .brand { gap: 6px; }
    .hero { padding: 22px 16px; }
    .hero-num { font-size: 25px; letter-spacing: -0.9px; }
    .hero-sub { font-size: 14px; }
    .seg { font-size: 13.5px; padding: 8px 4px; }
    .t-row { padding: 14px 15px; gap: 10px; }
    .t-code, .t-code-masked { font-size: 17px; letter-spacing: 0.8px; }
    .btn-take { padding: 10px 20px; font-size: 14.5px; }
    /* The alert row runs out of width here and wraps its action onto a second line, where
       it would otherwise sit orphaned under the icon and out of line with the text it
       belongs to. Full width reads as a deliberate action instead.
       This override works from here only because .admin-alert-btn is defined above this
       block. See the source-order note in the steering doc. */
    .admin-alert-btn { width: 100%; }
  }

  /* ─── OVERLAY / MODAL ─── */
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; padding: 20px;
    animation: fadeOvr 0.18s ease;
  }
  @keyframes fadeOvr { from{opacity:0;} to{opacity:1;} }

  .modal {
    background: var(--surface);
    border-radius: var(--r-2xl);
    padding: 26px 24px;
    width: 100%; max-width: 390px;
    box-shadow: var(--sh-xl);
    border: 1px solid var(--border);
    animation: modalIn 0.26s var(--ease-spring);
  }
  .modal.wide {
    max-width: 520px;
    max-height: 88vh;
    overflow-y: auto;
    padding-right: 20px;
  }
  .modal.wide::-webkit-scrollbar { width: 4px; }
  .modal.wide::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 4px; }
  @keyframes modalIn {
    from { opacity: 0; transform: scale(0.93) translateY(14px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }

  .m-head { margin-bottom: 20px; }
  .m-title { font-size: 17px; font-weight: 700; color: var(--text); letter-spacing: -0.4px; margin-bottom: 3px; }
  .m-sub { font-size: 13px; color: var(--text-3); line-height: 1.4; }

  /* Code display in take modal */
  .code-chip {
    background: var(--green);
    border: 1.5px solid var(--green);
    border-radius: var(--r-lg);
    padding: 18px 16px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 22px; font-weight: 700;
    color: #fff;
    letter-spacing: 1.5px;
    margin-bottom: 18px;
    white-space: nowrap;
  }

  /* Release confirm */
  .confirm-chip {
    background: var(--red-light);
    border: 1.5px solid var(--red-mid);
    border-radius: var(--r-lg);
    padding: 18px 16px;
    text-align: center;
    margin-bottom: 4px;
  }
  .confirm-chip-label { font-size: 11px; color: var(--text-4); font-weight: 500; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
  .confirm-chip-code { font-family: var(--font-mono); font-size: 20px; font-weight: 700; color: var(--red); letter-spacing: 0.5px; margin-bottom: 4px; }
  .confirm-chip-by { font-size: 13px; color: var(--text-3); }
  /* Release-only variant: solid orange fill matching .btn-pri.orange, so the box itself
     reads as "this leads to the orange action" the same way the red chip reads as
     "this leads to a destructive action" above. Scoped to .confirm-chip.release rather
     than changing .confirm-chip directly, since that class is shared with the Staged
     codes to remove (delete) confirmation, which should stay red/destructive-coded. */
  .confirm-chip.release {
    background: var(--orange);
    border-color: var(--orange);
  }
  .confirm-chip.release .confirm-chip-label { color: rgba(255,255,255,0.75); }
  .confirm-chip.release .confirm-chip-code,
  .confirm-chip.release .confirm-chip-by,
  .confirm-chip.release .confirm-chip-by strong { color: #fff; }

  /* Form */
  .f-label {
    display: block; font-size: 11px; font-weight: 600;
    color: var(--text-3); text-transform: uppercase;
    letter-spacing: 0.6px; margin-bottom: 6px;
  }
  .f-input {
    width: 100%; background: var(--surface-2);
    border: 1.5px solid var(--border-mid);
    border-radius: var(--r-sm); padding: 10px 14px;
    font-family: var(--font); font-size: 14px; color: var(--text);
    outline: none; transition: all 0.16s; -webkit-appearance: none;
  }
  .f-input:focus { border-color: var(--blue); background: var(--surface); box-shadow: 0 0 0 3px var(--blue-light); }
  .f-input::placeholder { color: var(--text-4); }
  /* Opaque inside the Code Manager's grouped rows. More specific than the base rule
     above so it wins regardless of source order; kept as an addition rather than
     touching .f-input itself, which the PIN and take/release modals also share. */
  .mgr-list .f-input { background: var(--surface-recessed); border-color: var(--border); }
  .mgr-list .f-input:focus { background: var(--surface); }

  /* Drop-month picker. Matches .f-input, but a native select ignores most of it until
     appearance is reset, which also removes the platform caret, hence the inline SVG.
     The shorthand 'background' must come before 'background-image' or it wipes it, and
     :focus sets background-color (not background) for the same reason. */
  .f-select {
    width: 100%; background: var(--surface-2);
    border: 1.5px solid var(--border-mid);
    border-radius: var(--r-sm); padding: 10px 34px 10px 14px;
    font-family: var(--font); font-size: 14px; font-weight: 500; color: var(--text);
    outline: none; cursor: pointer; transition: all 0.16s;
    -webkit-appearance: none; -moz-appearance: none; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238e8e93' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 13px center;
  }
  .f-select:focus { border-color: var(--blue); background-color: var(--surface); box-shadow: 0 0 0 3px var(--blue-light); }
  .mgr-list .f-select { background-color: var(--surface-recessed); border-color: var(--border); }
  .mgr-list .f-select:focus { background-color: var(--surface); }

  .pin-inp {
    width: 100%; background: var(--surface-2);
    border: 1.5px solid var(--border-mid);
    border-radius: var(--r-lg); padding: 14px;
    font-family: var(--font-mono); font-size: 28px;
    letter-spacing: 12px; color: var(--text);
    text-align: center; outline: none;
    transition: all 0.16s; -webkit-appearance: none;
    margin-bottom: 6px;
  }
  .pin-inp:focus { border-color: var(--blue); background: var(--surface); box-shadow: 0 0 0 3px var(--blue-light); }
  .pin-err { font-size: 12px; font-weight: 500; color: var(--red); text-align: center; height: 18px; }
  .take-error {
    font-size: 12.5px; color: var(--red); background: var(--red-light);
    border: 1px solid var(--red-mid); border-radius: var(--r-xs); padding: 8px 12px; margin-top: 4px;
  }

  /* Modal actions */
  .m-actions { display: flex; gap: 8px; margin-top: 18px; }

  .btn-sec {
    flex: 1; background: var(--surface-2);
    border: 1px solid var(--border-mid);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 14px; font-weight: 600; color: var(--text-3);
    padding: 11px; cursor: pointer; transition: all 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-sec:hover { background: var(--surface-3); color: var(--text-2); }
  .btn-sec:active { transform: scale(0.98); }

  .btn-pri {
    flex: 1; border: none; border-radius: var(--r-sm);
    font-family: var(--font); font-size: 14px; font-weight: 600;
    color: #fff; padding: 11px; cursor: pointer;
    transition: all 0.15s; -webkit-tap-highlight-color: transparent;
  }
  .btn-pri:disabled { opacity: 0.32; cursor: not-allowed; }
  .btn-pri:active:not(:disabled) { transform: scale(0.98); }
  .btn-pri.blue { background: var(--blue); box-shadow: 0 1px 4px rgba(0,122,255,0.22); }
  .btn-pri.blue:hover:not(:disabled) { background: #0070f0; box-shadow: 0 3px 10px rgba(0,122,255,0.3); }
  .btn-pri.green { background: var(--green); box-shadow: 0 1px 4px rgba(52,199,89,0.22); }
  .btn-pri.green:hover:not(:disabled) { background: #2db44e; box-shadow: 0 3px 10px rgba(52,199,89,0.3); }
  .btn-pri.orange { background: var(--orange); box-shadow: 0 1px 4px rgba(255,149,0,0.22); }
  .btn-pri.orange:hover:not(:disabled) { background: #e68a00; }
  .btn-pri.red { background: var(--red); box-shadow: 0 1px 4px rgba(255,59,48,0.22); }
  .btn-pri.red:hover:not(:disabled) { background: #e0352a; }

  /* ─── CODE MANAGER: grouped iOS-style list ─── */
  /* Apple settings pattern: a small uppercase label sits above a group, the group itself
     is one opaque surface with hairline dividers between rows and no border around it.
     .mgr-label names the single group directly beneath it (Drop Month, Add Codes, Code
     Inventory, History), the same way iOS Settings labels one setting or one cluster of
     rows immediately below, never a bucket spanning unrelated groups. */
  .mgr-label {
    font-size: 12px; font-weight: 600; color: var(--text-4);
    text-transform: uppercase; letter-spacing: 0.5px;
    margin: 20px 4px 6px;
  }
  .mgr-label:first-of-type { margin-top: 4px; }

  .mgr-list {
    background: var(--surface); border-radius: var(--r-lg);
    box-shadow: var(--sh-sm); overflow: hidden;
    margin-bottom: 4px;
  }
  /* Two groups back to back with no .mgr-label between them (a labeled group followed by
     a conditional alert group, e.g. Drop Month then Scheduled Drops) still need daylight
     between them so they don't read as one merged list. */
  .mgr-list + .mgr-list { margin-top: 14px; }

  /* A static (non-navigating) row holding real content: a picker, an inline add form, a
     scheduled-drop entry. Padding only, no divider styling of its own; dividers come from
     sibling rows via the +.mgr-row-static / +.mgr-row rule below. */
  .mgr-row-static { padding: 14px 16px; }
  .mgr-row-static + .mgr-row-static,
  .mgr-list > .mgr-row-static + .mgr-row {
    border-top: 1px solid var(--border);
  }

  /* A clickable row that pushes a sub-screen, iOS list-row style: label left, trailing
     content (a count, a chevron, or both) right, full-width tap target. */
  .mgr-row {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%; background: none; border: none;
    padding: 14px 16px; cursor: pointer; text-align: left;
    font-family: var(--font); -webkit-tap-highlight-color: transparent;
    transition: background 0.12s;
  }
  .mgr-row:hover { background: var(--bg); }
  .mgr-row:active { background: var(--track); }
  .mgr-row + .mgr-row { border-top: 1px solid var(--border); }
  .mgr-row-title { font-size: 14.5px; font-weight: 500; color: var(--text); }
  .mgr-row-trail {
    display: flex; align-items: center; gap: 6px;
    font-size: 13.5px; color: var(--text-4);
  }
  .mgr-chevron { display: flex; color: var(--text-4); flex-shrink: 0; }

  /* Inline add form, sits inside a .mgr-row-static rather than the modal padding directly
     so it lines up with the rest of the group. */
  .mgr-inline-add { display: flex; gap: 8px; }
  .mgr-inline-add .f-input { flex: 1; }

  /* Back row for a pushed sub-screen. Sits where the modal padding would otherwise start,
     so the whole sub-screen still opens with the same top inset as the root list. */
  .mgr-back {
    display: flex; align-items: center; gap: 6px;
    background: none; border: none; color: var(--blue);
    font-family: var(--font); font-size: 15px; font-weight: 500;
    padding: 0 0 16px; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .mgr-back:hover { opacity: 0.7; }

  /* Advisory rows: Top-up Requests, Expired Codes, No Drop Month. Same opaque .mgr-list
     shell as everything else, tinted only on the icon and title so the group still reads
     as one native list rather than a boxed alert panel. */
  .mgr-alert-row {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px 16px;
  }
  .mgr-alert-ico {
    width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; color: #fff; line-height: 1;
    background: var(--orange);
  }
  .mgr-alert-ico.muted { background: var(--text-4); }
  .mgr-alert-main { flex: 1; min-width: 160px; }
  .mgr-alert-title { font-size: 13.5px; font-weight: 600; color: var(--orange-dark); }
  .mgr-alert-title.muted { color: var(--text-2); }
  .mgr-alert-sub { font-size: 12px; color: var(--text-4); line-height: 1.45; margin-top: 2px; }
  .mgr-alert-btn {
    background: var(--bg); border: 1px solid var(--border-mid);
    border-radius: var(--r-xs); font-family: var(--font);
    font-size: 12px; font-weight: 600; color: var(--text-2);
    padding: 6px 13px; cursor: pointer; transition: all 0.15s;
    flex-shrink: 0; white-space: nowrap;
  }
  .mgr-alert-btn:hover { background: var(--track); }

  /* Drop scheduling */
  .drop-note { font-size: 12px; color: var(--text-4); margin-top: 8px; line-height: 1.45; }
  .drop-note.sched { color: #8e34c4; font-weight: 500; }

  .sched-month { font-size: 13.5px; font-weight: 600; color: var(--text); }
  .sched-meta { font-size: 11.5px; color: var(--text-4); }

  /* Segmented control, native iOS look: a track with a plain-text active state rather
     than a sliding thumb, since the modal shell has no room for the extra layout work
     a thumb needs to stay correct across three widths at every viewport. */
  .seg-ctrl {
    display: flex; background: var(--track); border-radius: var(--r-sm);
    padding: 3px; gap: 3px; margin-bottom: 12px;
  }
  .seg-ctrl button {
    flex: 1; background: none; border: none; border-radius: 7px;
    font-family: var(--font); font-size: 13px; font-weight: 500;
    color: var(--text-3); padding: 7px 4px; cursor: pointer;
    transition: all 0.15s; -webkit-tap-highlight-color: transparent;
  }
  .seg-ctrl button.active {
    background: var(--surface); color: var(--text);
    font-weight: 600; box-shadow: var(--sh-sm);
  }

  /* Narrow phones. Lives here rather than the SMALL PHONES block near the top of the
     sheet: that block sits above every rule these override, and a media query adds no
     specificity, so an override placed before the rule it targets loses on source order
     and does nothing. Same trap documented for .reveal-code. */
  @media (max-width: 420px) {
    .mgr-label { font-size: 11.5px; margin: 18px 2px 6px; }
    .mgr-row-static, .mgr-row, .mgr-alert-row { padding: 12px 14px; }
    .mgr-row-title { font-size: 14px; }
    .mgr-alert-sub { font-size: 11.5px; }
    .mgr-back { font-size: 14.5px; }
    .seg-ctrl button { font-size: 12.5px; padding: 7px 2px; }
  }

  .btn-add {
    background: var(--text); color: #fff; border: none;
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 13px; font-weight: 600; padding: 10px 16px;
    cursor: pointer; transition: all 0.15s; flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-add:hover { background: #3a3a3c; }
  .btn-add:active { transform: scale(0.97); }

  .bulk-ta {
    width: 100%; background: var(--surface-recessed);
    border: 1.5px solid var(--border);
    border-radius: var(--r-sm); padding: 10px 14px;
    font-family: var(--font-mono); font-size: 12.5px;
    color: var(--text); outline: none; resize: vertical;
    min-height: 80px; margin-bottom: 6px;
    transition: all 0.16s; -webkit-appearance: none;
  }
  .bulk-ta:focus { border-color: var(--blue); background: var(--surface); box-shadow: 0 0 0 3px var(--blue-light); }
  .bulk-hint { font-size: 11px; color: var(--text-4); margin-bottom: 10px; }

  .btn-bulk {
    width: 100%; background: var(--surface-2);
    border: 1px solid var(--border-mid); border-radius: var(--r-sm);
    font-family: var(--font); font-size: 13px; font-weight: 600;
    color: var(--text-3); padding: 10px; cursor: pointer;
    transition: all 0.15s;
  }
  .btn-bulk:hover:not(:disabled) { background: var(--surface-3); color: var(--text-2); }
  .btn-bulk:disabled { opacity: 0.35; cursor: default; }

  /* Code list */
  .code-list {
    max-height: 220px; overflow-y: auto;
    border: 1px solid var(--border); border-radius: var(--r-sm);
  }
  .code-list::-webkit-scrollbar { width: 4px; }
  .code-list::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 4px; }

  .cl-item {
    display: flex; align-items: center;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
    gap: 12px; transition: background 0.12s; cursor: pointer;
    user-select: none; -webkit-user-select: none;
  }
  .cl-item:last-child { border-bottom: none; }
  .cl-item:hover { background: var(--bg); }
  .cl-item.sel { background: var(--track); }

  .cl-check {
    width: 18px; height: 18px; border-radius: 5px;
    border: 1.5px solid var(--border-mid);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; background: var(--surface);
    transition: all 0.14s var(--ease-spring);
  }
  .cl-item.sel .cl-check { background: var(--blue); border-color: var(--blue); }
  .cl-check-ico { display: none; }
  .cl-item.sel .cl-check-ico { display: block; }

  .cl-name-row { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .cl-name { font-size: 14px; font-weight: 600; color: var(--text); font-family: var(--font-mono); letter-spacing: 0.2px; }
  .cl-tag {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
    padding: 1px 6px; border-radius: 4px; flex-shrink: 0;
  }
  .cl-tag.sched { background: var(--text); color: #fff; }
  .cl-tag.exp { background: var(--surface-recessed); color: var(--text-4); border: 1px solid var(--border-mid); }
  .cl-meta { font-size: 12px; color: var(--text-3); }

  /* Status: a dot plus label, no filled pill. Apple's list-row convention for state
     (Settings, Health) reads status inline rather than as a loud colored badge. */
  .cl-status {
    display: flex; align-items: center; gap: 5px; flex-shrink: 0;
    font-size: 12px; font-weight: 600;
  }
  .cl-status.avail { color: var(--green-dark); }
  .cl-status.taken { color: var(--text-3); }
  .cl-status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .cl-status.avail .cl-status-dot { background: var(--green-strong); }
  .cl-status.taken .cl-status-dot { background: var(--text-4); }

  .btn-del {
    background: none; border: 1px solid var(--border);
    border-radius: 6px; font-family: var(--font);
    font-size: 11.5px; color: var(--text-4);
    padding: 4px 10px; cursor: pointer; transition: all 0.15s; flex-shrink: 0;
  }
  .btn-del:hover { border-color: var(--red); color: #fff; background: var(--red); }

  .list-empty { padding: 24px; text-align: center; color: var(--text-4); font-size: 13px; }

  /* Selection toolbar: plain text-button row, native select-mode feel rather than a
     tinted card. The "N selected" toolbar only appears once something is selected;
     the quick-select links sit above it at all times. */
  .sel-quick-row {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    margin-bottom: 8px; padding: 0 2px;
  }
  .btn-textlink {
    background: none; border: none; padding: 0;
    font-family: var(--font); font-size: 12.5px; font-weight: 500;
    color: var(--blue); cursor: pointer; transition: opacity 0.15s;
  }
  .btn-textlink:hover { opacity: 0.6; }

  .sel-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 12px; margin-bottom: 8px;
    background: var(--text); border-radius: var(--r-sm);
  }
  .sel-count { font-size: 12.5px; font-weight: 600; color: #fff; }
  .sel-toolbar-actions { display: flex; align-items: center; gap: 14px; }
  .sel-toolbar .btn-textlink { color: rgba(255,255,255,0.7); }
  .sel-toolbar .btn-textlink:hover { color: #fff; opacity: 1; }
  .sel-toolbar .btn-del-sel {
    background: var(--red); color: #fff; border: none;
    border-radius: 6px; font-family: var(--font); font-size: 11.5px;
    font-weight: 600; padding: 5px 12px; cursor: pointer; transition: all 0.15s;
  }
  .sel-toolbar .btn-del-sel:hover { background: var(--red-dark); }

  /* Activity log */
  .act-log { max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-sm); }
  /* Dedicated sub-screen gives Activity Log / Release History the whole modal, so the
     list can run taller than the 180px it got as one section among many on the root
     list. */
  .act-log.tall { max-height: 420px; }
  .act-log::-webkit-scrollbar { width: 4px; }
  .act-log::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 4px; }
  .act-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 12px; border-bottom: 1px solid rgba(60,60,67,0.06); animation: rowIn 0.18s ease; }
  .act-item:last-child { border-bottom: none; }
  .act-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
  .act-dot.add  { background: var(--green); }
  .act-dot.take { background: var(--blue); }
  .act-dot.release { background: var(--orange); }
  .act-dot.delete, .act-dot.bulk { background: var(--red); }
  .act-dot.export { background: #5ac8fa; }
  .act-dot.request { background: var(--orange); }
  .act-dot.schedule { background: #af52de; }
  .act-dot.expire { background: var(--text-4); }
  .act-text { font-size: 12px; color: var(--text-3); flex: 1; line-height: 1.4; }
  .act-text strong { color: var(--text); font-weight: 600; }
  .act-time { font-size: 10.5px; color: var(--text-4); font-family: var(--font-mono); white-space: nowrap; }
  .act-device { color: var(--text-4); font-family: var(--font-mono); font-size: 11px; }
  .act-empty { padding: 20px; text-align: center; color: var(--text-4); font-size: 12.5px; }

  /* Bulk delete confirm modal list */
  .bdc-list { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); max-height: 160px; overflow-y: auto; margin-bottom: 4px; }
  .bdc-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border-bottom: 1px solid rgba(60,60,67,0.06); font-size: 13px; }
  .bdc-item:last-child { border-bottom: none; }
  .bdc-code { font-family: var(--font-mono); font-weight: 600; color: var(--text); }
  .bdc-status { font-size: 11px; color: var(--text-4); }

  /* Export CSV button */
  .btn-export-csv {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
    background: var(--text); border: none; color: #fff;
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 13.5px; font-weight: 600;
    padding: 12px; cursor: pointer; transition: all 0.15s;
    margin-top: 20px;
  }
  .btn-export-csv:hover { background: #3a3a3c; }
  .btn-export-csv:active { transform: scale(0.98); }

  /* Clear Old Logs: outlined destructive, quiet by default since it's a rare
     maintenance action, not something to compete visually with Export CSV. */
  .btn-clear-logs {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
    background: var(--surface); border: 1px solid var(--border-mid); color: var(--red);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 13.5px; font-weight: 600;
    padding: 12px; cursor: pointer; transition: all 0.15s; margin-top: 8px;
  }
  .btn-clear-logs:hover { background: var(--red); border-color: var(--red); color: #fff; }
  .btn-clear-logs:active { transform: scale(0.98); }

  /* ─── CODE REVEAL (inside Take modal) ─── */
  /* The payoff screen, and the only place a code is ever shown deliberately. The code is
     the hero: a solid green block with white text, sized to be read at arm's length, read
     aloud to someone else, or screenshotted and read back later.
     Monospace is kept even though nothing else here uses it. Grab codes get typed into
     another app, so 0 against O and 1 against I have to be tellable apart. */
  .reveal-screen {
    display: flex; flex-direction: column; align-items: center;
    padding: 6px 0 2px;
    animation: modalIn 0.26s var(--ease-spring);
  }
  /* Only the reveal gets these. .modal is shared by every other modal in the app, so the
     rounder corners and roomier padding are applied via a class added when revealing
     rather than by changing the shared token. */
  .reveal-modal { border-radius: 30px; padding: 30px 26px; }
  .reveal-label {
    font-size: 13px; font-weight: 700; color: var(--text-4);
    text-transform: uppercase; letter-spacing: 2px;
  }
  .reveal-code {
    width: 100%; margin: 16px 0 18px;
    background: var(--green); color: #fff;
    border: none; border-radius: 22px;
    padding: 22px 18px; text-align: center;
    font-family: var(--font-mono); font-size: 33px; font-weight: 700;
    letter-spacing: 1px; word-break: break-all;
    /* Soft drop shadow rather than the earlier glow, which read as a halo and made the
       block look like it was floating off the card. */
    box-shadow: 0 3px 10px rgba(52,199,89,0.24);
  }
  .reveal-sub { font-size: 15px; color: var(--text-3); margin-bottom: 22px; }
  .reveal-sub strong { color: var(--text); font-weight: 700; }

  /* Chunkier than the modal buttons elsewhere: this is a one-handed tap on a phone,
     outdoors, and it is the last thing standing between the person and their ride. */
  .reveal-screen .m-actions { width: 100%; margin-top: 0; gap: 10px; }
  .reveal-btn {
    flex: 1; border-radius: 14px; padding: 16px 12px;
    font-size: 15.5px; font-weight: 700;
  }
  .reveal-btn.btn-sec { background: var(--track); border-color: transparent; color: var(--text-2); }
  .reveal-btn.btn-sec:hover { background: var(--surface-3); color: var(--text); }
  .reveal-btn.btn-pri { box-shadow: 0 4px 14px rgba(52,199,89,0.34); }

  .btn-copy { flex: 1; transition: background 0.15s, color 0.15s; }
  /* Defined after .reveal-btn.btn-sec so the confirmed state still wins on the
     reveal screen. Equal specificity, so source order is what decides it. */
  .btn-copy.copied {
    background: var(--green-light); color: var(--green-dark);
    border-color: var(--green-mid);
  }

  /* Narrow phones. This has to live here rather than in the SMALL PHONES block near the
     top of the sheet: a media query adds no specificity, so an override placed before
     the rule it overrides loses on source order and silently does nothing.
     A longer code still wraps via word-break, but this keeps the everyday 8 to 12
     character codes on one line. */
  @media (max-width: 420px) {
    .reveal-modal { border-radius: 26px; padding: 26px 20px; }
    .reveal-code { font-size: 27px; padding: 19px 14px; letter-spacing: 0.5px; }
    .reveal-btn { padding: 15px 10px; font-size: 15px; }
  }

`;

// Handles both plain ms numbers (from optimistic state) and Firestore Timestamp objects (from onSnapshot)
function toMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis(); // Firestore Timestamp
  if (typeof ts === "number") return ts;
  return Number(ts);
}

function formatTime(ts) {
  const ms = toMs(ts);
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Used by the Activity Log and Release History, which both span up to 30 days,
// so the date is included, not just the clock time. Keeps seconds (unlike
// formatTime) because log entries can land within the same minute.
function formatTimeShort(ts) {
  const ms = toMs(ts);
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Prevents spreadsheet formula injection when CSV is opened in Excel/Sheets
function csvSafe(v) {
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

// ─── MONTH SCOPING ───
// Grab codes only work during the calendar month they were issued for, so every code
// carries a `monthKey` of the form "YYYY-MM". The month is always zero-padded, which
// makes plain string comparison chronological too ("2026-09" > "2026-08" > "2026-07"),
// so no date parsing is needed to decide whether a code is live, scheduled, or dead.
//
// Months are resolved from the *client's local* clock on purpose. Staff are all in one
// timezone and expect codes to switch over at local midnight, not UTC midnight (which
// in ICT would flip the tracker at 7am). This is also why the month is not enforced in
// firestore.rules: `request.time` is UTC, so a rule would reject legitimate claims for
// the first 7 hours of every month.
function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthKey() {
  return monthKeyOf(new Date());
}

// Always builds from day 1 so month lengths never matter, and month 12 + 1 rolls the
// year over correctly (new Date(2026, 12, 1) === Jan 2027).
function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return monthKeyOf(new Date(y, m - 1 + delta, 1));
}

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function monthLabelShort(key) {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Splits codes into what staff should see now, what's staged for later, and what has
// expired.
//
//   live       this month's codes: everything staff can claim
//   staged     labelled for a later month, hidden until that month begins
//   stale      labelled for a month that has already passed, so no longer works
//   unlabelled no monthKey at all (added before drop scheduling existed). Counted in
//              `live` as well, and reported separately so admin can resolve them.
//
// A month can run out of codes, so more get added on top part-way through. That makes
// "which month is this code for" the only thing that decides whether a code is live:
// staleness is driven purely by the calendar, never by new codes arriving. Adding codes
// for the current month can therefore never mark anything stale, no matter how many
// times it happens.
//
// Unlabelled codes are never guessed at. A code string says nothing about its month and
// these predate the field, so there is no honest way to date them. They stay live and
// are never deleted automatically; admin labels or removes them once, from the notice in
// Code Manager, after which every code in the collection carries a month.
//
// Module-level and pure so both the cleanup effect and the render path can use it
// without turning it into an effect dependency.
function partitionCodes(list, month) {
  const live = [], staged = [], stale = [], unlabelled = [];
  list.forEach(c => {
    if (!c.monthKey) { unlabelled.push(c); live.push(c); }
    else if (c.monthKey === month) live.push(c);
    else if (c.monthKey > month) staged.push(c);
    else stale.push(c);
  });
  return { live, staged, stale, unlabelled };
}

// How much of this month is left, for the line under the availability figure. Codes
// stop working when the month ends, so a countdown is more use than a bare date: it is
// the difference between "plenty of time" and "use it today".
//
// Counts whole days remaining, so on the last day of the month it reads "today". Built
// from the local clock for the same reason as monthKeyOf.
// `days` and `label` are returned alongside the copy because the admin staging nudge needs
// the raw number, and re-deriving "how much of the month is left" in a second place is how
// the two drift apart. `days` is null whenever it would be meaningless, so a caller has to
// null-check rather than accidentally treating "not this month" as zero days remaining.
function monthExpiry(month) {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return { text: "", urgent: false, days: null, label: "" };
  const last = new Date(y, m, 0);            // day 0 of next month is the last of this one
  const label = last.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const now = new Date();
  // Only meaningful while `month` is the month we are actually in, which it always is
  // on the render path. Fall back to the plain date otherwise.
  if (monthKeyOf(now) !== month) return { text: `Valid until ${label}`, urgent: false, days: null, label };
  const days = last.getDate() - now.getDate();
  if (days <= 0) return { text: `Expire today (${label})`, urgent: true, days, label };
  if (days === 1) return { text: `Expire tomorrow (${label})`, urgent: true, days, label };
  return { text: `Expire in ${days} days (${label})`, urgent: days <= 3, days, label };
}

// Masks an unclaimed code. Shows enough of the prefix to tell codes apart in a list
// while keeping the rest unguessable, and never more than half the string, so a short
// sequential code like "SB-001" does not end up effectively printed in full.
//
// This is presentational only. The full value is already on the device, because the
// listener downloads the whole collection (known risk #2 in the steering doc).
function maskCode(code) {
  const visible = Math.min(5, Math.ceil(code.length / 2));
  return code.slice(0, visible) + "\u2022".repeat(Math.max(code.length - visible, 1));
}

// Human-readable list of the drops a set of codes came from, for log lines and the
// expired-codes notice. Unlabelled codes have no month to name, so they're called out
// as such rather than being silently attributed to one.
function describeDrops(list) {
  return [...new Set(list.map(c => c.monthKey || "~"))].sort()
    .map(key => (key === "~" ? "unlabelled" : monthLabelShort(key)))
    .join(", ");
}

// [[monthKey, codes], ...] in chronological order. Used by the Scheduled Drops list
// and the expired-codes notice, both of which summarise per month rather than per code.
function groupByMonth(list, fallback) {
  const groups = new Map();
  list.forEach(c => {
    const key = c.monthKey || fallback;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ─── DEVICE-LOCAL MEMORY ───
// There is no identity in this app, so nothing per-person can be enforced. What can be
// done is remembering things on the device, which is enough for the top-up button to
// know it has already been pressed.
//
// localStorage throws rather than returning null in several real cases: Safari private
// browsing, cookies blocked, quota exhausted. None of them should stop a staff member
// using the tracker, so every access is wrapped and simply degrades to "this device
// remembers nothing".
function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* remembering is a nicety, never a requirement */ }
}

// A random per-device id, so the admin sees how many *people* are waiting rather than
// how many times a button was tapped. It identifies a browser, not a person, holds no
// personal data, and clearing site data just mints a new one.
function getDeviceId() {
  let id = readLocal(LS_DEVICE);
  if (!id) {
    // randomUUID needs a secure context, which rules it out on plain-http LAN testing.
    id = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    writeLocal(LS_DEVICE, id);
  }
  return id;
}

// { monthKey, ts } for this device's last top-up request, or null if there isn't one.
// Anything unparseable or hand-edited is treated as absent rather than trusted, so a
// bad value can't leave the button permanently disabled.
function readLastRequest() {
  const raw = readLocal(LS_REQUEST);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.monthKey === "string" && typeof v.ts === "number") return v;
    return null;
  } catch { return null; }
}

// Write a log entry to Firestore only. onSnapshot keeps local state in sync (Fix #3).
// Module-level because it closes over nothing but `logsRef`: that keeps it out of the
// dependency array of the cleanup effect, which would otherwise re-run on
// every render (it would be a new function identity each time).
// Intentionally swallows errors: audit logging must never block a staff member.
// deviceId is stamped on every entry (staff takes and admin actions alike) so the
// admin can tell which browser did what without it depending on the free-text name
// typed into the take modal. Calling getDeviceId() here rather than threading it
// through every call site keeps every existing call to log() correct for free.
function log(type, text) {
  addDoc(logsRef, { type, text, ts: Date.now(), deviceId: getDeviceId() }).catch(() => {});
}

export default function App() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connError, setConnError] = useState(false);
  // OFFLINE FIX: persistentLocalCache (added for the "Fix lag" perf change) means
  // onSnapshot's success callback now fires from the local cache even with zero
  // connectivity, so `err` never fires and `loading`/`connError` stop being a reliable
  // proxy for "we can actually reach Firestore right now". `isStale` tracks that gap:
  // true whenever the most recent snapshot came from cache AND the browser reports
  // offline. It does not replace connError (a real listener error is still a real error);
  // it exists so the cleanup sweep, which writes deletes, can refuse to run on data it
  // cannot confirm is current. See the codes listener and the sweep effect below.
  const [isStale, setIsStale] = useState(false);
  const [filter, setFilter] = useState("available");
  const [isAdmin, setIsAdmin] = useState(false);
  const [optimistic, setOptimistic] = useState({});

  // Modals
  const [pinModal, setPinModal] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");

  const [takeModal, setTakeModal] = useState(null);
  const [staffName, setStaffName] = useState("");
  const [takeError, setTakeError] = useState("");

  const [releaseConfirm, setReleaseConfirm] = useState(null);
  const [codeManager, setCodeManager] = useState(false);
  // Which sub-screen of Code Manager is pushed on top of the root list, iOS-settings
  // style. null means the root list. Reset to null whenever Code Manager closes so it
  // never reopens mid-drill-in.
  const [mgrScreen, setMgrScreen] = useState(null);

  // Manager state
  const [newCode, setNewCode] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [selectedCodes, setSelectedCodes] = useState(new Set());
  const [bulkDelConfirm, setBulkDelConfirm] = useState(false);
  // Display-only filter for the All Codes sub-screen's segmented control. Separate from
  // selectedCodes: it narrows what is shown, selection (selAll/selAvail/selTaken/selNone)
  // is unchanged and still operates on the full list regardless of this filter.
  const [mgrCodeFilter, setMgrCodeFilter] = useState("all");

  // ── Month scoping ──
  // The month whose codes are currently live. Held in state rather than read inline so
  // that a month boundary re-renders the app (see the ticker effect below). The tool
  // gets left open on shared devices for days at a time.
  const [nowMonth, setNowMonth] = useState(currentMonthKey);

  // Which month new codes are added for. Defaults to the live month; set it to a future
  // month to stage a drop that stays hidden until that month begins.
  const [dropMonth, setDropMonth] = useState(currentMonthKey);

  // Pending "delete this whole scheduled drop" confirmation: { monthKey, ids }
  const [dropDelConfirm, setDropDelConfirm] = useState(null);

  // Guard for the automatic cleanup below. A ref, not state: it must not trigger a
  // re-render, and it has to be readable synchronously so a snapshot arriving mid-flight
  // can't kick off the same batch of deletes twice.
  //   busy:        a sweep is in flight
  //   failedMonth: the sweep errored this month; don't retry on every snapshot. Cleared
  //                 by a reload, or when the month changes.
  const sweep = useRef({ busy: false, failedMonth: null });

  // Release history, synced from Firebase (lazy: only when Code Manager is open)
  const [releaseHistory, setReleaseHistory] = useState([]);

  // Activity log, synced from Firebase (lazy: only when Code Manager is open)
  const [actLog, setActLog] = useState([]);

  // ── Top-up requests ──
  // Synced for admin only. Unlike the log and release history this cannot be lazy on
  // Code Manager, because the whole point is a badge visible on the main screen without
  // opening anything. Staff never subscribe: they only ever write.
  const [topupRequests, setTopupRequests] = useState([]);

  // This device's last request, mirrored out of localStorage so the button still reads
  // "Admin notified" after a reload instead of inviting a second tap.
  const [lastRequest, setLastRequest] = useState(readLastRequest);
  const [requestBusy, setRequestBusy] = useState(false);

  // Revealed code after successful Take (Fix #11)
  const [revealedCode, setRevealedCode] = useState(null);

  // True while the Take transaction is in flight. Prevents showing the reveal
  // screen before the server has actually confirmed the code, and disables the
  // Confirm button so it can't be double-tapped (Fix #13)
  const [takeBusy, setTakeBusy] = useState(false);

  // Copy-to-clipboard feedback on reveal screen (Fix #12)
  const [copied, setCopied] = useState(false);

  // Holds the pending "Copied ✓" reset timer so repeated copies can't stack
  // independent timers (an earlier one would clear the badge mid-way through a
  // later copy's window). Also lets us cancel it on unmount.
  const copyTimer = useRef(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copyRevealedCode = async (code) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        // Fallback for older/in-app browsers without Clipboard API
        const ta = document.createElement("textarea");
        ta.value = code;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        // iOS Safari ignores select() on its own for a textarea
        ta.setSelectionRange(0, code.length);
        // execCommand returns false on failure instead of throwing. Without this
        // check we fall through to setCopied(true) and show "Copied ✓" while the
        // clipboard is actually untouched, the worst outcome here, since the UI
        // tells the user to rely on it.
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);   // remove before throwing so the node can't leak
        if (!ok) throw new Error("copy_failed");
      }
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write blocked (rare): fail silently, code is still visible on screen
    }
  };

  // Escape closes whichever modal is open
  useEffect(() => {
    const onKey = e => {
      if (e.key !== "Escape") return;
      if (dropDelConfirm) setDropDelConfirm(null);
      else if (bulkDelConfirm) setBulkDelConfirm(false);
      else if (codeManager) {
        // Same slot in the priority order as before. Native iOS behaviour: Escape backs
        // out of a pushed sub-screen first, and only closes the whole modal once back at
        // the root list. The open/close contract for Code Manager itself is unchanged.
        if (mgrScreen) setMgrScreen(null);
        else { setCodeManager(false); setSelectedCodes(new Set()); }
      }
      else if (releaseConfirm) setReleaseConfirm(null);
      else if (takeModal) { setTakeModal(null); setStaffName(""); setRevealedCode(null); setTakeError(""); setCopied(false); }
      else if (pinModal) { setPinModal(false); setPin(""); setPinError(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropDelConfirm, bulkDelConfirm, codeManager, mgrScreen, releaseConfirm, takeModal, pinModal]);

  // Firebase real-time listener: codes (always on)
  useEffect(() => {
    // OFFLINE FIX: includeMetadataChanges plus snapshot.metadata.fromCache is how you
    // tell a genuinely fresh snapshot apart from a cache replay now that persistence is
    // on. fromCache alone is not enough, a healthy online listener also serves its very
    // first paint from cache before the server ack lands, so it is paired with
    // navigator.onLine: only "from cache" AND "browser reports offline" counts as stale.
    const unsub = onSnapshot(codesRef, { includeMetadataChanges: true }, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // `|| 0` keeps the comparator consistent if a doc was added outside the app
      // (e.g. via the Firebase console) and has no createdAt. Otherwise NaN makes
      // the sort order implementation-defined.
      data.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      setCodes(data);
      setLoading(false);
      setConnError(false);
      setIsStale(snap.metadata.fromCache && !navigator.onLine);
    }, err => {
      // ponytail: keep last-good codes on screen; surface a banner instead of an infinite "Connecting..." spinner
      console.error("codes listener failed:", err);
      setLoading(false);
      setConnError(true);
    });
    return () => unsub();
  }, []);

  // Firebase real-time listener: activity log (lazy: only when Code Manager open) (Fix #7)
  useEffect(() => {
    if (!codeManager) return;
    const cutoff = Date.now() - MONTH_MS;
    const q = query(logsRef, where("ts", ">", cutoff), orderBy("ts", "desc"), limit(200));
    const unsub = onSnapshot(q, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setActLog(data);
    }, err => console.error("activity log listener failed:", err));
    return () => unsub();
  }, [codeManager]);

  // Firebase real-time listener: release history (lazy: only when Code Manager open) (Fix #7)
  useEffect(() => {
    if (!codeManager) return;
    const cutoff = Date.now() - MONTH_MS;
    // releasedAt is written with serverTimestamp(), i.e. a Firestore Timestamp.
    // Firestore range scans are confined to the bound's own type, so comparing
    // against a plain number (Date.now()) matched nothing and this list was
    // permanently empty. The bound must be a Timestamp too.
    // (activityLog.ts is a plain number and is correctly compared as one.)
    const q = query(releaseHistRef, where("releasedAt", ">", Timestamp.fromMillis(cutoff)), orderBy("releasedAt", "desc"), limit(200));
    const unsub = onSnapshot(q, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setReleaseHistory(data);
    }, err => console.error("release history listener failed:", err));
    return () => unsub();
  }, [codeManager]);

  // Firebase real-time listener: top-up requests (admin only)
  //
  // Range-filtered on ts and ordered by the same field, exactly like the activity log,
  // so this needs no composite index. The month is filtered client-side instead: adding
  // an equality filter on monthKey next to orderBy("ts") would require one, and index
  // deployment in this project is a manual console step.
  useEffect(() => {
    if (!isAdmin) return;
    const cutoff = Date.now() - MONTH_MS;
    const q = query(topupReqRef, where("ts", ">", cutoff), orderBy("ts", "desc"), limit(200));
    const unsub = onSnapshot(q, snap => {
      setTopupRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, err => console.error("top-up requests listener failed:", err));
    // Dropped on exiting admin so a stale count can't reappear on the next login
    // before the first snapshot lands.
    return () => { unsub(); setTopupRequests([]); };
  }, [isAdmin]);

  // Month boundary ticker. Nobody reloads this page: it sits open on the shared
  // terminal, so the switch from one month's codes to the next has to be noticed while
  // the app is running. A minute of granularity is plenty for a monthly flip and costs
  // nothing; setState with the same key is a no-op, so this doesn't cause re-renders.
  useEffect(() => {
    const t = setInterval(() => {
      const key = currentMonthKey();
      setNowMonth(prev => (prev === key ? prev : key));
    }, 60000);
    return () => clearInterval(t);
  }, []);

  // Never leave the picker pointing at a month that has already passed (possible if the
  // manager was left open across midnight on the 1st).
  useEffect(() => {
    setDropMonth(prev => (prev < nowMonth ? nowMonth : prev));
  }, [nowMonth]);

  // ── Automatic cleanup of codes whose month has passed ──
  // Codes stop working at the source when their month ends, so leaving them in the
  // tracker only invites someone to claim a code that won't redeem.
  //
  // The trigger is the calendar, never the arrival of new codes. That distinction is the
  // whole point: a month can run out of codes and get topped up part-way through, and a
  // top-up must not disturb anything. Codes added for the current month sit alongside
  // what's already there, all equally live. Only a month boundary makes anything stale.
  //
  // Staged drops for later months are never touched either. They are queued work.
  //
  // Hiding is separate from deleting. Stale codes disappear from the table through the
  // `partitionCodes` filter on the render path: no writes, instant, and it still holds if
  // this delete never runs. That is what makes an unattended delete safe here:
  //   1. It's gated on the live set being non-empty, so it can only trim the tracker down
  //      to codes that still work. It can never empty it.
  //   2. There is no server-side scheduler in this project, so this runs on whatever
  //      client happens to be open, trusting that device's clock. A device with a clock
  //      set a month ahead sees this month's live codes as stale, but it would also need
  //      codes for its own wrong month to pass the gate, and it has none, so it skips.
  //
  // Skipped while offline. A failure stops further attempts for the rest of the month so
  // a permission error can't turn every snapshot into another round of failing batches.
  // OFFLINE FIX: `loading`/`connError` alone no longer prove we're online now that
  // persistentLocalCache is on (see isStale above): without this, a device that goes
  // offline mid-session would see a normal-looking, fully-loaded, error-free codes list
  // and happily fire batch.commit() deletes against it. Those deletes would then queue in
  // the local cache indefinitely instead of failing fast, leaving sweep.current.busy stuck
  // true and silently blocking every sweep for the rest of the session, even after
  // reconnecting, since nothing here would ever resolve to flip it back.
  useEffect(() => {
    if (loading || connError || isStale) return;
    if (sweep.current.busy || sweep.current.failedMonth === nowMonth) return;
    const { live, stale } = partitionCodes(codes, nowMonth);
    if (!stale.length) return;
    if (!live.length) return;   // nothing usable would be left, so leave them alone
    sweep.current.busy = true;
    const from = describeDrops(stale);
    const held = stale.filter(c => c.status === STATUS.TAKEN).length;
    (async () => {
      try {
        for (let i = 0; i < stale.length; i += 400) {
          const batch = writeBatch(db);
          stale.slice(i, i + 400).forEach(c => batch.delete(doc(db, "codes", c.id)));
          await batch.commit();
        }
        log("expire", `${monthLabelShort(nowMonth)} started: removed ${stale.length} expired code(s) from ${from}${held ? ` (${held} had been taken)` : ""}`);
      } catch (err) {
        // Deliberately no alert(): this fires on load, unprompted, and an error popup
        // for a background chore would just block a staff member trying to grab a code.
        // The old codes remain hidden either way, so the failure is not user-facing.
        console.error("stale code cleanup failed:", err);
        sweep.current.failedMonth = nowMonth;
      } finally {
        sweep.current.busy = false;
      }
    })();
  }, [codes, loading, connError, isStale, nowMonth]);

  // ── Actions ──
  const handlePin = () => {
    if (pin === ADMIN_PIN) { setIsAdmin(true); setPinModal(false); setPin(""); setPinError(""); }
    else { setPinError("Incorrect PIN. Try again."); setPin(""); }
  };

  const addCode = async () => {
    const t = newCode.trim().toUpperCase();
    // Duplicates are only duplicates within the same drop month. The same code string
    // legitimately reappears in a later month's batch, and rejecting it because a dead
    // July code had the same value would silently drop a code from the August drop.
    const month = dropMonth;
    if (!t || codes.some(c => c.code === t && (c.monthKey || nowMonth) === month)) { setNewCode(""); return; }
    setNewCode("");
    try {
      await addDoc(codesRef, {
        code: t, status: STATUS.AVAILABLE, takenBy: null, takenAt: null,
        createdAt: Date.now(), monthKey: month
      });
      if (month === nowMonth) log("add", `${t} added`);
      else log("schedule", `${t} scheduled for ${monthLabelShort(month)}`);
    } catch (err) {
      // Previously this rejection was unhandled: the input had already been
      // cleared, so the admin lost their input and was never told it failed.
      console.error("addCode failed:", err);
      setNewCode(t);
      alert("Failed to add code. Please try again.");
    }
  };

  const addBulk = async () => {
    const month = dropMonth;
    const lines = bulkText.split(/[\n,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    // Scoped to the target month for the same reason as addCode.
    const existing = new Set(codes.filter(c => (c.monthKey || nowMonth) === month).map(c => c.code));
    const toAdd = [...new Set(lines)].filter(c => !existing.has(c));
    if (!toAdd.length) { setBulkText(""); return; }
    setBulkText("");
    try {
      // Batched instead of Promise.all: a batch is atomic, so a failure can no
      // longer leave a partial set of codes written. Also 1 round trip per 400
      // codes instead of one per code. doc(codesRef) generates the same kind of
      // auto-ID that addDoc does internally.
      const base = Date.now();
      for (let i = 0; i < toAdd.length; i += 400) {
        const batch = writeBatch(db);
        toAdd.slice(i, i + 400).forEach((code, j) => {
          batch.set(doc(codesRef), {
            code, status: STATUS.AVAILABLE, takenBy: null, takenAt: null,
            createdAt: base + i + j,   // same increasing sequence as before, preserves paste order
            monthKey: month
          });
        });
        await batch.commit();
      }
      if (month === nowMonth) log("bulk", `${toAdd.length} code(s) bulk-added`);
      else log("schedule", `${toAdd.length} code(s) scheduled for ${monthLabelShort(month)}`);
    } catch (err) {
      console.error("addBulk failed:", err);
      setBulkText(toAdd.join("\n"));   // restore so a long paste isn't lost
      alert("Failed to add codes. Please try again.");
    }
  };

  const takeCode = async (id, name) => {
    if (takeBusy) return; // guard against double-tap while a request is in flight
    const code = takeModal?.code;
    setTakeBusy(true);
    setTakeError("");
    // Optimistic update for instant table feedback (row shows "taken" right away),
    // but the reveal screen itself waits for server confirmation (Fix #13). This
    // avoids flashing "Your Code" for a code the user didn't actually win when two
    // people tap Take on the same code at nearly the same instant.
    setOptimistic(p => ({ ...p, [id]: { status: STATUS.TAKEN, takenBy: name, takenAt: Date.now() } }));
    // FIX #6: Transaction ensures the code is still available before writing.
    // If two users tap Take at the same time, only one wins and the other sees an error.
    const attempt = runTransaction(db, async (tx) => {
      const ref = doc(db, "codes", id);
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().status !== STATUS.AVAILABLE) {
        throw new Error("already_taken");
      }
      // FIX #7: serverTimestamp() writes the server's authoritative time, not the client clock
      // takenDevice: the claiming browser's random device id (see getDeviceId), so a
      // claim can be traced back to a device even if the typed name is unreliable or
      // reused. Not a person or a fingerprint, same caveat as topupRequests.deviceId.
      tx.update(ref, { status: STATUS.TAKEN, takenBy: name, takenAt: serverTimestamp(), takenDevice: getDeviceId() });
    });
    // FIX #14: runTransaction has no built-in timeout. A stalled connection, rules drift,
    // or a slow round trip left the button on "Confirming..." forever with no error and no
    // recovery except reloading. A bare Promise.race would "fix" that on-screen while the
    // transaction kept running unseen: if it later landed, the code was claimed with the
    // modal already closed and the staff member none the wiser, sometimes leading them to
    // claim a second code thinking the first attempt failed. `timedOut` tracks whether the
    // race's clock branch already won, so the settle handler below can react correctly
    // instead of trusting a stale "still loading" UI state.
    let timedOut = false;
    const TAKE_TIMEOUT_MS = 12000;
    const timer = new Promise((_, reject) => {
      setTimeout(() => { timedOut = true; reject(new Error("timeout")); }, TAKE_TIMEOUT_MS);
    });
    // The attempt keeps running even if the timer wins the race below; this handler is what
    // reconciles a late success or failure once the button has already moved on.
    attempt.then(() => {
      if (!timedOut) return;
      // Landed after we told the staff member it timed out. The code is genuinely theirs now,
      // so surface it rather than leaving it silently claimed under their name with no reveal.
      log("take", `${name} took ${code} (confirmed late after a timeout)`);
      alert(`Your code came through after all: ${code}\nMake sure to note it down.`);
    }).catch(err => {
      if (!timedOut) return;
      // Lost the race after the timeout already rolled back the optimistic row and freed the
      // button. Nothing claimed, nothing to reconcile; only log unexpected failures.
      if (err?.message !== "already_taken") {
        console.error("takeCode settled late after timeout:", err);
      }
    });
    try {
      await Promise.race([attempt, timer]);
    } catch (err) {
      // Rollback optimistic row and show error. Reveal screen was never shown, so nothing to hide
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
      setTakeBusy(false);
      // Optional chaining: if err were ever null the catch block itself would throw,
      // skipping setTakeBusy(false) and permanently freezing the Confirm button.
      if (err?.message === "already_taken") {
        setTakeError("Sorry, this code was just taken by someone else. Please choose another.");
      } else if (err?.message === "timeout") {
        setTakeError("This is taking too long. Check your connection. We'll let you know if it goes through.");
      } else {
        setTakeError("Something went wrong. Please try again.");
      }
      return;
    }
    // Success: clean up optimistic state (onSnapshot will sync the real data) and reveal
    setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
    setStaffName("");
    setTakeBusy(false);
    setRevealedCode({ code, name });
    log("take", `${name} took ${code}`);
  };

  // ── "We're out" ──
  // The one thing a staff member can usefully do when the pool is empty. Deliberately a
  // single tap with no name field: this fires at the exact moment someone is in a hurry
  // and has just been told there is nothing for them, so anything more than one tap gets
  // abandoned. The device id carries the only fact the admin needs, which is that this
  // is one more person rather than one more tap.
  //
  // The cooldown is enforced on the device, not the server, and cannot be otherwise
  // without real auth. Someone determined can clear their storage and ask again. That is
  // an acceptable failure mode: the worst case is an inflated count on a screen that only
  // ever prompts the admin to do something they already intended to do.
  const requestTopup = async () => {
    if (requestBusy || requestSent) return;
    setRequestBusy(true);
    const entry = { monthKey: nowMonth, ts: Date.now(), deviceId: getDeviceId() };
    try {
      await addDoc(topupReqRef, entry);
      // Remembered only after the write is confirmed, so a failed request doesn't
      // silently lock the button for the next six hours.
      const mine = { monthKey: entry.monthKey, ts: entry.ts };
      setLastRequest(mine);
      writeLocal(LS_REQUEST, JSON.stringify(mine));
    } catch (err) {
      console.error("requestTopup failed:", err);
      alert("Could not send the request. Please try again, or tell an admin directly.");
    } finally {
      setRequestBusy(false);
    }
  };

  // Clearing is explicit rather than automatic on the next code being added. Adding codes
  // and resolving the queue are not the same event: an admin often stages a future drop
  // while people are still waiting on this month, and silently wiping the queue there
  // would hide the very thing it exists to show.
  const clearTopupRequests = async () => {
    const ids = monthRequests.map(r => r.id);
    if (!ids.length) return;
    if (!confirm(`Clear ${ids.length} top-up request(s) for ${monthLabel(nowMonth)}?`)) return;
    try {
      await deleteIdsIn("topupRequests", ids);
      log("request", `Cleared ${ids.length} top-up request(s) for ${monthLabelShort(nowMonth)}`);
    } catch (err) {
      console.error("clearTopupRequests failed:", err);
      alert("Failed to clear the requests. Please try again.");
    }
  };

  const releaseCode = async (id) => {
    const code = releaseConfirm?.code;
    const by = releaseConfirm?.takenBy;
    const takenAt = releaseConfirm?.takenAt;
    const takenDevice = releaseConfirm?.takenDevice;
    setOptimistic(p => ({ ...p, [id]: { status: STATUS.AVAILABLE, takenBy: null, takenAt: null, takenDevice: null } }));
    setReleaseConfirm(null);
    try {
      await updateDoc(doc(db, "codes", id), { status: STATUS.AVAILABLE, takenBy: null, takenAt: null, takenDevice: null });
      // History is written only AFTER the release is confirmed. Writing it first
      // meant a failed updateDoc left a permanent record of a release that never
      // happened. `codes` is the source of truth, so ordering it this way makes a
      // missing history row the worst case instead of a phantom one.
      if (code) {
        // serverTimestamp() for releasedAt, authoritative server time
        await addDoc(releaseHistRef, {
          code, takenBy: by || "-", takenAt: takenAt || null, takenDevice: takenDevice || null, releasedAt: serverTimestamp()
        }).catch(err => console.error("release history write failed:", err));
      }
      log("release", `Released ${code}${by ? ` from ${by}` : ""}`);
    } catch (err) {
      // Without this catch the rejection was unhandled and the row silently
      // reverted to "taken" with no explanation to the admin.
      console.error("release failed:", err);
      alert("Failed to release code. Please try again.");
    } finally {
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
    }
  };

  const deleteCode = async (id) => {
    const c = codes.find(x => x.id === id);
    setSelectedCodes(p => { const n = new Set(p); n.delete(id); return n; });
    try {
      await deleteDoc(doc(db, "codes", id));
      if (c) log("delete", `Deleted ${c.code}`);
    } catch (err) {
      console.error("deleteCode failed:", err);
      alert("Failed to delete code. Please try again.");
    }
  };

  // Batched for the same reasons as addBulk: atomic per chunk, and it stays within
  // Firestore's 500-operation limit per batch. Takes ids rather than snapshots (unlike
  // deleteDocsInChunks below) because every caller here works from data already in
  // state, so there's no getDocs round trip to get DocumentReferences from.
  const deleteIdsIn = async (collName, ids) => {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach(id => batch.delete(doc(db, collName, id)));
      await batch.commit();
    }
  };

  const deleteCodeIds = (ids) => deleteIdsIn("codes", ids);

  const bulkDelete = async () => {
    const ids = [...selectedCodes];
    const names = codes.filter(c => ids.includes(c.id)).map(c => c.code);
    const preview = names.slice(0, 5).join(", ") + (names.length > 5 ? ` +${names.length - 5} more` : "");
    setSelectedCodes(new Set());
    setBulkDelConfirm(false);
    try {
      await deleteCodeIds(ids);
      log("bulk", `Deleted ${ids.length} code(s): ${preview}`);
    } catch (err) {
      console.error("bulkDelete failed:", err);
      alert("Failed to delete some codes. Please refresh and try again.");
    }
  };

  // Manual escape hatch for the automatic cleanup: removes expired codes even when this
  // month has none of its own yet, which is the one case the sweep deliberately refuses
  // to touch. Also what an admin reaches for if the sweep failed on a permission error.
  const clearStale = async () => {
    const ids = staleCodes.map(c => c.id);
    if (!ids.length) return;
    const from = describeDrops(staleCodes);
    if (!confirm(`Remove ${ids.length} expired code(s) from ${from}? They no longer work. This cannot be undone.`)) return;
    try {
      await deleteCodeIds(ids);
      log("expire", `Cleared ${ids.length} expired code(s) from ${from}`);
      alert(`✓ Removed ${ids.length} expired code(s).`);
    } catch (err) {
      console.error("clearStale failed:", err);
      alert("Failed to remove expired codes. Please try again.");
    }
  };

  // Assigns a month to codes that predate drop scheduling, so they join the normal
  // lifecycle and get cleaned up on their own at the month boundary. A deliberate click
  // rather than something automatic, because only the admin knows which month these
  // actually belong to. Offered as the current month, which is the case worth automating:
  // "these are the codes we're using right now."
  const labelUnlabelled = async () => {
    const targets = unlabelledCodes;
    if (!targets.length) return;
    if (!confirm(`Assign ${targets.length} code(s) to ${monthLabel(nowMonth)}? They stay live for the rest of the month, then get removed automatically when it ends.`)) return;
    try {
      for (let i = 0; i < targets.length; i += 400) {
        const batch = writeBatch(db);
        targets.slice(i, i + 400).forEach(c => batch.update(doc(db, "codes", c.id), { monthKey: nowMonth }));
        await batch.commit();
      }
      log("schedule", `Assigned ${targets.length} existing code(s) to ${monthLabelShort(nowMonth)}`);
      alert(`✓ ${targets.length} code(s) assigned to ${monthLabel(nowMonth)}.`);
    } catch (err) {
      console.error("labelUnlabelled failed:", err);
      alert("Failed to assign a month to those codes. Please try again.");
    }
  };

  // Removes codes that predate drop scheduling, for when they're leftovers rather than
  // the set in use.
  const removeUnlabelled = async () => {
    const ids = unlabelledCodes.map(c => c.id);
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} code(s) that have no drop month? This cannot be undone.`)) return;
    try {
      await deleteCodeIds(ids);
      log("delete", `Removed ${ids.length} code(s) with no drop month`);
      alert(`✓ Removed ${ids.length} code(s).`);
    } catch (err) {
      console.error("removeUnlabelled failed:", err);
      alert("Failed to remove those codes. Please try again.");
    }
  };

  // Drops a whole staged month, the fix for "I pasted the wrong list for next month".
  const deleteDrop = async () => {
    const { monthKey, ids } = dropDelConfirm || {};
    if (!ids || !ids.length) { setDropDelConfirm(null); return; }
    setDropDelConfirm(null);
    setSelectedCodes(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
    try {
      await deleteCodeIds(ids);
      log("delete", `Deleted scheduled drop for ${monthLabelShort(monthKey)}: ${ids.length} code(s)`);
    } catch (err) {
      console.error("deleteDrop failed:", err);
      alert("Failed to delete the scheduled drop. Please try again.");
    }
  };

  const toggleSel = id => setSelectedCodes(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selAll = () => setSelectedCodes(new Set(codes.map(c => c.id)));
  const selAvail = () => setSelectedCodes(new Set(codes.filter(c => c.status === STATUS.AVAILABLE).map(c => c.id)));
  const selTaken = () => setSelectedCodes(new Set(codes.filter(c => c.status === STATUS.TAKEN).map(c => c.id)));
  const selNone = () => setSelectedCodes(new Set());

  // A writeBatch is capped at 500 operations, so a single batch silently breaks
  // once the backlog grows past it, and log() fires on every add/take/release,
  // so that happens fast. Committing in chunks keeps pruning usable at any size.
  // Returns the number of documents deleted.
  const deleteDocsInChunks = async (docsToDelete) => {
    for (let i = 0; i < docsToDelete.length; i += 400) {
      const batch = writeBatch(db);
      docsToDelete.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return docsToDelete.length;
  };

  const clearOldLogs = async () => {
    if (!confirm("Delete all activity logs, release history, and top-up requests older than 30 days? This cannot be undone.")) return;
    const cutoff = Date.now() - MONTH_MS;
    try {
      // Activity log
      const logQ = query(logsRef, where("ts", "<", cutoff));
      const logSnap = await getDocs(logQ);
      const logCount = await deleteDocsInChunks(logSnap.docs);

      // Release history: previously only hidden from the UI by the listener's
      // cutoff filter, never actually deleted from Firestore. Prune it here too
      // so the collection doesn't grow unbounded.
      // Timestamp bound for the same reason as the listener above: with a plain
      // number this matched nothing, so pruning always reported 0 records.
      const relQ = query(releaseHistRef, where("releasedAt", "<", Timestamp.fromMillis(cutoff)));
      const relSnap = await getDocs(relQ);
      const relCount = await deleteDocsInChunks(relSnap.docs);

      // Top-up requests. Cleared per month from the manager as they're answered, so this
      // only catches ones from a month nobody got around to tidying. ts is a plain
      // number, like activityLog, so the bound is a number too.
      const reqQ = query(topupReqRef, where("ts", "<", cutoff));
      const reqSnap = await getDocs(reqQ);
      const reqCount = await deleteDocsInChunks(reqSnap.docs);

      log("delete", `Cleared ${logCount} old log entry(ies), ${relCount} old release record(s), and ${reqCount} old top-up request(s), older than 30 days`);
      alert(`✓ Deleted ${logCount} old log entries, ${relCount} old release records, and ${reqCount} old top-up requests.`);
    } catch (err) {
      console.error("Clear logs failed:", err);
      alert("Failed to clear logs. Try again.");
    }
  };

  const exportCSV = () => {
    // Exports every code on file, not just the live drop, including staged ones, so the
    // sheet doubles as a record of what's queued. `Drop` is the month the code belongs to
    // (blank for codes added before drop scheduling); `Drop Status` is which bucket it's
    // in right now, taken straight from the same partition the UI uses.
    const rows = [["Code", "Drop", "Drop Status", "Status", "Taken By", "Taken At", "Released At"]];
    codes.forEach(c => {
      rows.push([
        csvSafe(c.code),
        c.monthKey || "",
        liveIds.has(c.id) ? "live" : stagedIds.has(c.id) ? "scheduled" : "old",
        c.status,
        csvSafe(c.takenBy || ""),
        toMs(c.takenAt) ? new Date(toMs(c.takenAt)).toISOString() : "",
        ""
      ]);
    });
    if (releaseHistory.length) {
      rows.push([]);
      rows.push(["--- Release History ---"]);
      rows.push(["Code", "Taken By", "Taken At", "Released At"]);
      releaseHistory.forEach(r => {
        rows.push([
          csvSafe(r.code),
          csvSafe(r.takenBy),
          toMs(r.takenAt) ? new Date(toMs(r.takenAt)).toISOString() : "",
          toMs(r.releasedAt) ? new Date(toMs(r.releasedAt)).toISOString() : ""
        ]);
      });
    }
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    try {
      // Leading BOM so Excel detects UTF-8 and doesn't mangle non-ASCII staff names
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `codes-export-${new Date().toISOString().slice(0,10)}.csv`;
      // Firefox only honours a synthetic click() if the anchor is in the document
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoking synchronously can cancel the download before the browser has
      // finished reading the blob (Safari/Firefox), so defer it instead.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      log("export", `CSV exported: ${codes.length} codes`);
    } catch (err) {
      console.error("CSV export failed:", err);
      alert("Failed to export CSV. Please try again.");
    }
  };

  // ── Drop partitions ──
  // Only the live drop reaches the table and the stat cards. Staged and stale codes are
  // filtered out here rather than in the Firestore query: the listener deliberately stays
  // a single unfiltered subscription (see the listener comment), and this is the same
  // trade-off the code masking already makes: a staged drop is hidden from the UI, not
  // from the network. Anyone who opens DevTools can read next month's codes early, exactly
  // as they can read an unclaimed code today (known risk #2).
  const { live: liveCodes, staged: stagedCodes, stale: staleCodes, unlabelled: unlabelledCodes } =
    partitionCodes(codes, nowMonth);

  const stagedDrops = groupByMonth(stagedCodes, nowMonth);

  // The manager list is the one place that shows every code. Ordered stale → live →
  // staged, matching the order of the sections above it. Unlabelled codes sort first
  // (empty string beats any month key), which is where they belong: they're either the
  // pre-scheduling set about to be replaced, or already superseded.
  // `|| 0` on createdAt for the same reason as the listener's sort.
  const managerCodes = [...codes].sort((a, b) => {
    const ka = a.monthKey || "", kb = b.monthKey || "";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  // Ids are the fastest way to ask "which bucket is this row in?" while rendering the
  // manager list, since the partition already did the work.
  const liveIds = new Set(liveCodes.map(c => c.id));
  const stagedIds = new Set(stagedCodes.map(c => c.id));

  // Current month plus next month only. Codes are never staged further ahead than that.
  const monthOptions = [0, 1].map(n => shiftMonthKey(nowMonth, n));

  // Merge optimistic
  const merged = liveCodes.map(c => optimistic[c.id] ? { ...c, ...optimistic[c.id], _opt: true } : c);

  const sorted = filter === "all"
    ? [...merged].sort((a, b) => (toMs(b.takenAt) || b.createdAt) - (toMs(a.takenAt) || a.createdAt))
    : merged;

  const filtered = sorted.filter(c => {
    if (filter === "available" && c.status !== STATUS.AVAILABLE) return false;
    if (filter === "taken" && c.status !== STATUS.TAKEN) return false;
    return true;
  });

  // The old three stat cards needed a `taken` count too. The availability hero states
  // it as "N of M available", so the third number was dropped rather than left unused.
  const total = merged.length;
  const avail = merged.filter(c => c.status === STATUS.AVAILABLE).length;

  // Recomputed every render, which is what keeps the countdown honest once the ticker
  // rolls `nowMonth` over at midnight on the 1st.
  const expiry = monthExpiry(nowMonth);

  // ── Top-up requests ──
  // Scoped to the live month for the same reason codes are: an unanswered request from
  // last month is history, not a queue, and the codes it was asking for no longer work.
  const monthRequests = topupRequests.filter(r => r.monthKey === nowMonth);

  // Counted by device, so one person tapping twice across two days reads as one person
  // waiting. Falls back to the doc id for any request written without a device id, which
  // counts it as its own person rather than merging unrelated requests into one.
  const waitingCount = new Set(monthRequests.map(r => r.deviceId || r.id)).size;

  // Whether this device has already asked. Evaluated at render rather than on a timer:
  // any snapshot or interaction re-renders, so the worst case is a button that stays
  // disabled a few minutes past its cooldown while nobody is looking at it.
  const requestSent = !!lastRequest
    && lastRequest.monthKey === nowMonth
    && Date.now() - lastRequest.ts < REQUEST_COOLDOWN_MS;

  // Offered whenever there is nothing left to claim, in the hero rather than the empty
  // state, so it can't be hidden behind the Taken or All filter or a stray search term.
  // Hidden from admin, who gets the waiting count instead of a button to notify
  // themselves, and while offline, where the write would only fail.
  const canRequestTopup = !loading && !connError && !isAdmin && avail === 0;

  // ── Admin alerts ──
  // Both alerts describe the same eventual failure, staff arriving to an empty tracker, at
  // two different distances out. Running dry this month is visible to everyone the moment
  // it happens. Next month never being staged is worse precisely because it is invisible:
  // the tracker empties itself at midnight on the 1st, with nobody watching, and the first
  // sign of it is 30 people who cannot book a ride.
  //
  // Admin only, and purely advisory. Nothing here blocks anything, and there is no dismiss
  // button on purpose: each alert clears itself when the thing it is asking for is done,
  // which is a stronger guarantee than a dismissal that hides an unfixed problem.
  const nextMonth = shiftMonthKey(nowMonth, 1);
  const nextMonthStaged = stagedCodes.filter(c => c.monthKey === nextMonth).length;

  const adminAlerts = [];
  if (isAdmin && !loading && !connError) {
    // Stock, gated on total > 0. With nothing on file at all the hero and the empty state
    // already say so in more detail, and "you have run out" is the wrong description of a
    // month that was never filled in the first place.
    if (total > 0 && avail === 0) {
      adminAlerts.push({
        key: "out",
        level: "urgent",
        title: `All ${total} codes claimed`,
        sub: `Nothing is left for ${monthLabel(nowMonth)}. Adding more tops up the live pool and deletes nothing.`,
        action: "Add codes",
        dropTo: nowMonth,
      });
    } else if (total > 0 && avail <= LOW_STOCK_THRESHOLD) {
      adminAlerts.push({
        key: "low",
        level: "warn",
        title: `Only ${avail} code${avail === 1 ? "" : "s"} left`,
        sub: `${avail} of ${total} still available for ${monthLabel(nowMonth)}. Top up before it runs dry.`,
        action: "Add codes",
        dropTo: nowMonth,
      });
    }

    // Staging. `days` is null unless nowMonth really is the current month, so the
    // null-check is what stops this firing on a stale or malformed month key.
    if (expiry.days !== null && expiry.days <= STAGE_REMINDER_DAYS && nextMonthStaged === 0) {
      adminAlerts.push({
        key: "unstaged",
        level: "warn",
        title: `Nothing staged for ${monthLabelShort(nextMonth)}`,
        sub: `These codes stop working after ${expiry.label}. Without a staged drop the tracker is empty on the 1st.`,
        action: `Stage ${monthLabelShort(nextMonth)}`,
        dropTo: nextMonth,
      });
    }
  }

  // Empty-state copy. Month scoping introduces two cases that used to be impossible:
  // this month's drop hasn't been added yet, and everything on file is either staged for
  // a future month or already expired. Telling the two apart matters, because "no codes yet"
  // when 40 codes are sitting ready for next month reads as a bug.
  let emptyIcon = "🔍";
  let emptyTitle = "No results";
  let emptySub = "Try changing your filter";
  if (liveCodes.length === 0) {
    emptyIcon = "📅";
    emptyTitle = `No codes for ${monthLabel(nowMonth)}`;
    if (stagedDrops.length) {
      const [nextKey, nextCodes] = stagedDrops[0];
      emptySub = `${nextCodes.length} code(s) ready for ${monthLabel(nextKey)}. They go live on the 1st.`;
    } else if (staleCodes.length) {
      emptySub = isAdmin
        ? `${staleCodes.length} expired code(s) are hidden because they no longer work. Add this month's codes via Manage Codes.`
        : "Last month's codes have stopped working. Ask an admin to add this month's codes.";
    } else {
      emptySub = isAdmin ? "Add codes via Manage Codes" : "Ask an admin to add this month's codes";
    }
  } else if (filter === "available") {
    emptyIcon = "✓";
    emptyTitle = "All codes taken";
    emptySub = "Every code for this month has been claimed";
  }

  return (
    <>
      <style>{styles}</style>
      <div className="page">

        {/* ── HEADER ── */}
        <nav className="topbar">
          <button
            type="button"
            className="logo-wrap"
            onClick={() => isAdmin ? setIsAdmin(false) : setPinModal(true)}
            title={isAdmin ? "Exit Admin" : "Admin Login"}
            aria-label={isAdmin ? "Exit Admin" : "Admin Login"}
          >
            <img src="/logo.png" alt="SingBuild" className="logo-img" />
          </button>
          <div className="brand">
            <span className="brand-name">SB Grab Code Tracker</span>
            <div className="brand-meta">
              {/* Codes are month-scoped, so which month you're looking at is never implicit */}
              <span className="pill month" title={`Showing codes for ${monthLabel(nowMonth)}`}>
                {monthLabelShort(nowMonth)}
              </span>
              <span className="pill live">
                <span className="pill-dot"></span>Live
              </span>
              {isAdmin && (
                <span className="pill admin">Admin</span>
              )}
              {isAdmin && stagedCodes.length > 0 && (
                <span className="pill sched" title={`${stagedCodes.length} code(s) staged for a future month`}>
                  <span className="pill-dot"></span>{stagedCodes.length} scheduled
                </span>
              )}
              {isAdmin && waitingCount > 0 && (
                <span className="pill req" title={`${waitingCount} staff member(s) have asked for more codes this month`}>
                  <span className="pill-dot"></span>{waitingCount} waiting
                </span>
              )}
            </div>
          </div>
        </nav>

        {connError && (
          <div className="conn-banner">
            Connection lost. Showing last known data. <button onClick={() => window.location.reload()}>Retry</button>
          </div>
        )}
        {!connError && isStale && (
          // OFFLINE FIX: distinct from connError. The listener never errored, it's happily
          // serving last-known data from the local cache while the device itself is offline
          // (see isStale above). Same banner style as connError for consistency, different
          // copy since "connection lost" would be misleading when the app never noticed.
          <div className="conn-banner">
            Offline. Showing last known data. Take may not work until you reconnect.
          </div>
        )}

        <div className="main">

          {/* ── ADMIN ALERTS ── */}
          {/* Each action jumps straight into Code Manager with Drop Month already set to the
              month that alert is about. That is the one field on the screen that silently
              decides whether codes go live now or in a month, so pre-setting it is error
              prevention, not a shortcut: it removes the step where a top-up gets pasted
              into next month's drop, or next month's batch lands in the live pool. */}
          {adminAlerts.length > 0 && (
            <div className="admin-alerts">
              {adminAlerts.map(a => (
                <div key={a.key} className={`admin-alert ${a.level}`}>
                  <span className="admin-alert-ico">!</span>
                  <div className="admin-alert-main">
                    <div className="admin-alert-title">{a.title}</div>
                    <div className="admin-alert-sub">{a.sub}</div>
                  </div>
                  <button className="admin-alert-btn"
                    onClick={() => { setDropMonth(a.dropTo); setCodeManager(true); }}>
                    {a.action}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ── AVAILABILITY ── */}
          <div className="hero">
            <div className={`hero-num${avail === 0 ? " none" : ""}`}>
              {total === 0 ? `No codes for ${monthLabel(nowMonth)}` : `${avail} of ${total} code${total === 1 ? "" : "s"} available`}
            </div>
            {total === 0 && (
              <div className="hero-sub">
                {stagedDrops.length
                  ? `${stagedDrops[0][1].length} ready for ${monthLabel(stagedDrops[0][0])}`
                  : "Waiting for this month's codes"}
              </div>
            )}
            {canRequestTopup && (
              <button
                className={`btn-topup${requestSent ? " sent" : ""}`}
                onClick={requestTopup}
                disabled={requestSent || requestBusy}
              >
                {requestSent ? "Admin notified ✓" : requestBusy ? "Sending…" : "Tell admin we're out"}
              </button>
            )}
            {canRequestTopup && requestSent && (
              <div className="topup-note">More codes get added when the admin sees this.</div>
            )}
          </div>

          {/* ── TOOLBAR ── */}
          <div className="toolbar">
            <div className="seg-ctrl">
              {[{ k: "available", l: "Available" }, { k: "taken", l: "Taken" }, { k: "all", l: "All" }].map(f => (
                <button key={f.k} className={`seg ${filter === f.k ? "active" : ""}`} onClick={() => { setFilter(f.k); }}>{f.l}</button>
              ))}
            </div>
            {isAdmin && (
              <button className="btn-mgr" onClick={() => setCodeManager(true)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="2" fill="#fff"/>
                  <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Manage Codes
              </button>
            )}
          </div>

          {/* ── CODE LIST ── */}
          <div className="card">
            <div className="t-body">
              {loading && (
                <div className="t-loading">
                  <div className="spinner"></div>
                  <span className="t-loading-text">Connecting…</span>
                </div>
              )}
              {!loading && filtered.length === 0 && (
                <div className="t-empty">
                  <div className="t-empty-icon">{emptyIcon}</div>
                  <div className="t-empty-title">{emptyTitle}</div>
                  <div className="t-empty-sub">{emptySub}</div>
                </div>
              )}
              {!loading && filtered.length > 0 && (
                <div className="t-body-inner" key={filter}>
                  {filtered.map((c, i) => (
                    <div key={c.id} className={`t-row ${c.status === STATUS.TAKEN ? "is-taken" : ""} ${c._opt ? "is-optimistic" : ""}`}
                      style={{ animationDelay: `${Math.min(i * 22, 220)}ms` }}>
                      {/* Fix #11: Mask available codes, only reveal after Take flow */}
                      {c.status === STATUS.AVAILABLE && !isAdmin
                        ? <span className="t-code-masked">{maskCode(c.code)}</span>
                        : <span className="t-code">{c.code}</span>
                      }
                      {c.status === STATUS.TAKEN && (
                        <div className="t-meta">
                          <span className="t-staff">{c.takenBy || "-"}</span>
                          {c.takenAt && <span className="t-time">{formatTime(c.takenAt)}</span>}
                          {isAdmin && (
                            <span className="t-device" title={c.takenDevice || "no device id (taken before this feature)"}>
                              dev {c.takenDevice ? c.takenDevice.slice(-6) : "—"}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="t-act">
                        {c.status === STATUS.AVAILABLE
                          ? <button className="btn-take" onClick={() => setTakeModal({ id: c.id, code: c.code })}>Take</button>
                          : isAdmin
                            ? <button className="btn-release" onClick={() => setReleaseConfirm({ id: c.id, code: c.code, takenBy: c.takenBy, takenAt: c.takenAt, takenDevice: c.takenDevice })}>Release</button>
                            : <span className="btn-taken-lock">Taken</span>
                        }
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── PIN MODAL ── */}
      {pinModal && (
        <div className="overlay" onClick={() => { setPinModal(false); setPin(""); setPinError(""); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="m-head">
              <div className="m-title">Admin Login</div>
              <div className="m-sub">Enter your PIN to access admin controls.</div>
            </div>
            <input className="pin-inp" type="password" inputMode="numeric"
              maxLength={6} placeholder="••••" value={pin}
              onChange={e => { setPin(e.target.value); setPinError(""); }}
              onKeyDown={e => e.key === "Enter" && handlePin()} autoFocus />
            <div className="pin-err">{pinError}</div>
            <div className="m-actions">
              <button className="btn-sec" onClick={() => { setPinModal(false); setPin(""); setPinError(""); }}>Cancel</button>
              <button className="btn-pri blue" onClick={handlePin}>Enter</button>
            </div>
          </div>
        </div>
      )}

      {/* ── TAKE MODAL ── */}
      {(takeModal || revealedCode) && (
        <div className="overlay" onClick={() => { setTakeModal(null); setStaffName(""); setRevealedCode(null); setTakeError(""); setCopied(false); }}>
          <div className={`modal${revealedCode ? " reveal-modal" : ""}`} onClick={e => e.stopPropagation()}>
            {revealedCode ? (
              /* Reveal screen, shown after successful Take (Fix #11) */
              <div className="reveal-screen">
                <div className="reveal-label">Your Code</div>
                <div className="reveal-code">{revealedCode.code}</div>
                <div className="reveal-sub">Assigned to <strong>{revealedCode.name}</strong>.</div>
                <div className="m-actions">
                  <button
                    className={`btn-sec reveal-btn btn-copy${copied ? " copied" : ""}`}
                    onClick={() => copyRevealedCode(revealedCode.code)}
                  >
                    {copied ? "Copied ✓" : "Copy Code"}
                  </button>
                  <button className="btn-pri green reveal-btn"
                    onClick={() => { setTakeModal(null); setRevealedCode(null); setCopied(false); }}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              /* Name entry form */
              <>
                <div className="m-head">
                  <div className="m-title">Take Code</div>
                  <div className="m-sub">Enter your name to claim this code.</div>
                </div>
                <div className="code-chip">Reveal on confirm</div>
                <label className="f-label">Your Name</label>
                <input className="f-input" type="text" placeholder="e.g. Kimtong, Sothea, Hongsrun…"
                  value={staffName} onChange={e => setStaffName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && staffName.trim() && !takeBusy && takeCode(takeModal.id, staffName.trim())}
                  disabled={takeBusy}
                  autoFocus />
                {takeError && (
                  <div className="take-error">{takeError}</div>
                )}
                <div className="m-actions">
                  <button className="btn-sec" disabled={takeBusy}
                    onClick={() => { setTakeModal(null); setStaffName(""); setTakeError(""); }}>Cancel</button>
                  <button className="btn-pri green" disabled={!staffName.trim() || takeBusy}
                    onClick={() => staffName.trim() && takeCode(takeModal.id, staffName.trim())}>
                    {takeBusy ? "Confirming…" : "Confirm & Reveal"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── RELEASE CONFIRM ── */}
      {releaseConfirm && (
        <div className="overlay" onClick={() => setReleaseConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="m-head">
              <div className="m-title">Release Code?</div>
              <div className="m-sub">This will make the code available again.</div>
            </div>
            <div className="confirm-chip release">
              <div className="confirm-chip-label">Code to release</div>
              <div className="confirm-chip-code">{releaseConfirm.code}</div>
              {releaseConfirm.takenBy && (
                <div className="confirm-chip-by">Held by <strong>{releaseConfirm.takenBy}</strong></div>
              )}
            </div>
            <div className="m-actions">
              <button className="btn-sec" onClick={() => setReleaseConfirm(null)}>Cancel</button>
              <button className="btn-pri orange" onClick={() => releaseCode(releaseConfirm.id)}>Release</button>
            </div>
          </div>
        </div>
      )}

      {/* ── CODE MANAGER ── */}
      {codeManager && isAdmin && (
        <div className="overlay" onClick={() => { setCodeManager(false); setSelectedCodes(new Set()); setMgrScreen(null); }}>
          <div className="modal wide" onClick={e => e.stopPropagation()}>

            {/* ── ROOT LIST ── */}
            {!mgrScreen && (
              <>
                <div className="m-head">
                  <div className="m-title">Code Manager</div>
                  <div className="m-sub">Add, schedule, review, and remove codes.</div>
                </div>

                {/* Staff waiting on codes. First row, above everything else, because it is
                    the reason the manager is open at all when it appears. Absent entirely
                    when nobody is waiting, so the everyday layout is unchanged. */}
                {monthRequests.length > 0 && (
                  <div className="mgr-list">
                    <div className="mgr-alert-row">
                      <div className="mgr-alert-ico">!</div>
                      <div className="mgr-alert-main">
                        <div className="mgr-alert-title">
                          {waitingCount === 1
                            ? "1 person is waiting for a code"
                            : `${waitingCount} people are waiting for a code`}
                        </div>
                        <div className="mgr-alert-sub">
                          {`Last asked ${formatTimeShort(monthRequests[0].ts)}. `}
                          {`Add codes for ${monthLabel(nowMonth)} below, then clear this.`}
                        </div>
                      </div>
                      <button className="mgr-alert-btn" onClick={clearTopupRequests}>Clear</button>
                    </div>
                  </div>
                )}

                {/* Drop month, applies to both add forms below */}
                <div className="mgr-label">Drop Month</div>
                <div className="mgr-list">
                  <div className="mgr-row-static">
                    <select className="f-select" value={dropMonth} onChange={e => setDropMonth(e.target.value)}>
                      {monthOptions.map(key => (
                        <option key={key} value={key}>
                          {monthLabel(key)}{key === nowMonth ? " (live now)" : ""}
                        </option>
                      ))}
                    </select>
                    <div className={`drop-note${dropMonth === nowMonth ? "" : " sched"}`}>
                      {dropMonth === nowMonth
                        ? "Codes added below go live straight away, alongside the ones already there."
                        : `Codes added below stay hidden until 1 ${monthLabel(dropMonth)}, when they take over and this month's codes are removed automatically.`}
                    </div>
                  </div>
                </div>

                {/* Scheduled drops, one row per staged month, still conditional */}
                {stagedDrops.length > 0 && (
                  <div className="mgr-list">
                    {stagedDrops.map(([key, list]) => (
                      <div key={key} className="mgr-row-static">
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className="bdg sched"><span className="bdg-dot"></span>Staged</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="sched-month">{monthLabel(key)}</div>
                            <div className="sched-meta">
                              {`${list.length} code(s) · goes live 1 ${monthLabel(key)}`}
                            </div>
                          </div>
                          <button className="btn-del"
                            onClick={() => setDropDelConfirm({ monthKey: key, ids: list.map(c => c.id) })}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add codes */}
                <div className="mgr-label">Add Codes</div>
                <div className="mgr-list">
                  <div className="mgr-row-static">
                    <div className="mgr-inline-add">
                      <input className="f-input" type="text" placeholder="e.g. SB-001"
                        value={newCode} onChange={e => setNewCode(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && addCode()} />
                      <button className="btn-add" onClick={addCode}>Add</button>
                    </div>
                  </div>
                  <button className="mgr-row" onClick={() => setMgrScreen("bulk")}>
                    <span className="mgr-row-title">Bulk Add Codes</span>
                    <span className="mgr-chevron">
                      <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                        <path d="M1 1l5.5 5.5L1 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </span>
                  </button>
                </div>

                {/* Expired codes awaiting cleanup */}
                {staleCodes.length > 0 && (
                  <div className="mgr-list">
                    <div className="mgr-alert-row muted">
                      <div className="mgr-alert-ico muted">i</div>
                      <div className="mgr-alert-main">
                        <div className="mgr-alert-title muted">{describeDrops(staleCodes)}</div>
                        <div className="mgr-alert-sub">
                          {"Hidden from staff already. "}
                          {liveCodes.length === 0
                            ? "Removed automatically once this month has codes."
                            : "Cleanup runs automatically. Use this if it hasn't caught up."}
                        </div>
                      </div>
                      <button className="mgr-alert-btn" onClick={clearStale}>Clear Now</button>
                    </div>
                  </div>
                )}

                {/* Codes from before drop scheduling existed */}
                {unlabelledCodes.length > 0 && (
                  <div className="mgr-list">
                    <div className="mgr-alert-row muted">
                      <div className="mgr-alert-ico muted">?</div>
                      <div className="mgr-alert-main">
                        <div className="mgr-alert-title muted">{unlabelledCodes.length} code(s) with no drop month</div>
                        <div className="mgr-alert-sub">
                          {"Treated as live and never auto-removed. Assign if these are this month's, or remove if leftovers."}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button className="mgr-alert-btn" onClick={labelUnlabelled}>
                          Assign to {monthLabelShort(nowMonth)}
                        </button>
                        <button className="mgr-alert-btn" onClick={removeUnlabelled}>Remove</button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Code inventory summary, drills into the full list */}
                <div className="mgr-label">Code Inventory</div>
                <div className="mgr-list">
                  <button className="mgr-row" onClick={() => setMgrScreen("codes")}>
                    <span className="mgr-row-title">All Codes</span>
                    <span className="mgr-row-trail">
                      {codes.length}
                      <span className="mgr-chevron">
                        <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                          <path d="M1 1l5.5 5.5L1 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    </span>
                  </button>
                </div>

                {/* History */}
                <div className="mgr-label">History</div>
                <div className="mgr-list">
                  <button className="mgr-row" onClick={() => setMgrScreen("activity")}>
                    <span className="mgr-row-title">Activity Log</span>
                    <span className="mgr-row-trail">
                      {actLog.length}
                      <span className="mgr-chevron">
                        <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                          <path d="M1 1l5.5 5.5L1 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    </span>
                  </button>
                  <button className="mgr-row" onClick={() => setMgrScreen("history")}>
                    <span className="mgr-row-title">Release History</span>
                    <span className="mgr-row-trail">
                      {releaseHistory.length}
                      <span className="mgr-chevron">
                        <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                          <path d="M1 1l5.5 5.5L1 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    </span>
                  </button>
                </div>

                {/* Export CSV */}
                <button className="btn-export-csv" onClick={exportCSV}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M8 1v9M8 10l-3-3M8 10l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  Export CSV
                </button>

                {/* Clear Old Logs */}
                <button className="btn-clear-logs" onClick={clearOldLogs}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M2 4h12M6.5 7v5M9.5 7v5M3 4l1 10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-10M7 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Clear Old Logs (30d+)
                </button>

                <button className="btn-sec" style={{ width: "100%", padding: 11, borderRadius: "var(--r-sm)", marginTop: 8 }}
                  onClick={() => { setCodeManager(false); setSelectedCodes(new Set()); setMgrScreen(null); }}>
                  Close
                </button>
              </>
            )}

            {/* ── BULK ADD SUB-SCREEN ── */}
            {mgrScreen === "bulk" && (
              <>
                <button className="mgr-back" onClick={() => setMgrScreen(null)}>
                  <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                    <path d="M7 1L1.5 6.5L7 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Code Manager
                </button>
                <div className="m-head">
                  <div className="m-title">Bulk Add</div>
                  <div className="m-sub">One code per line or comma-separated. Duplicates skipped.</div>
                </div>
                <textarea className="bulk-ta" placeholder={"SB-001\nSB-002\nSB-003"}
                  value={bulkText} onChange={e => setBulkText(e.target.value)} autoFocus />
                <button className="btn-bulk" disabled={!bulkText.trim()} onClick={() => { addBulk(); setMgrScreen(null); }}>
                  Add All Codes
                </button>
              </>
            )}

            {/* ── ALL CODES SUB-SCREEN ── */}
            {mgrScreen === "codes" && (
              <>
                <button className="mgr-back" onClick={() => setMgrScreen(null)}>
                  <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                    <path d="M7 1L1.5 6.5L7 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Code Manager
                </button>
                <div className="m-head">
                  <div className="m-title">All Codes</div>
                  <div className="m-sub">{codes.length} code(s) total.</div>
                </div>

                <div className="seg-ctrl">
                  <button className={mgrCodeFilter === "all" ? "active" : ""} onClick={() => setMgrCodeFilter("all")}>All</button>
                  <button className={mgrCodeFilter === "available" ? "active" : ""} onClick={() => setMgrCodeFilter("available")}>Available</button>
                  <button className={mgrCodeFilter === "taken" ? "active" : ""} onClick={() => setMgrCodeFilter("taken")}>Taken</button>
                </div>

                {/* Selection toolbar, unchanged behaviour: selection is independent of the
                    display filter above it. Only shown once something is selected, plain
                    text-button row rather than a tinted card, native-select-mode feel. */}
                {selectedCodes.size > 0 && (
                  <div className="sel-toolbar">
                    <span className="sel-count">{selectedCodes.size} selected</span>
                    <div className="sel-toolbar-actions">
                      <button className="btn-textlink" onClick={selNone}>Clear</button>
                      <button className="btn-del-sel" onClick={() => setBulkDelConfirm(true)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
                <div className="sel-quick-row">
                  <button className="btn-textlink" onClick={selAll}>Select All</button>
                  <button className="btn-textlink" onClick={selAvail}>Select Available</button>
                  <button className="btn-textlink" onClick={selTaken}>Select Taken</button>
                </div>

                {codes.length === 0
                  ? <div className="list-empty">No codes yet.</div>
                  : (
                    <div className="code-list">
                      {managerCodes
                        .filter(c => mgrCodeFilter === "all" ? true : c.status === mgrCodeFilter)
                        .map(c => {
                          const state = liveIds.has(c.id) ? "" : stagedIds.has(c.id) ? "sched" : "exp";
                          const isTaken = c.status === STATUS.TAKEN;
                          return (
                            <div key={c.id} className={`cl-item ${selectedCodes.has(c.id) ? "sel" : ""}`}
                              onClick={() => toggleSel(c.id)}>
                              <div className="cl-check">
                                <svg className="cl-check-ico" width="10" height="10" viewBox="0 0 10 10" fill="none">
                                  <path d="M2 5L4.2 7.5L8 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="cl-name-row">
                                  <span className="cl-name">{c.code}</span>
                                  {state && (
                                    <span className={`cl-tag ${state}`}>{state === "sched" ? "Staged" : "Old"}</span>
                                  )}
                                </div>
                                <div className="cl-meta">
                                  {c.monthKey ? monthLabelShort(c.monthKey) : "No drop month"}
                                  {" · "}
                                  {isTaken ? `Taken by ${c.takenBy || "-"} · ${formatTime(c.takenAt)}` : "Available"}
                                </div>
                              </div>
                              <span className={`cl-status ${isTaken ? "taken" : "avail"}`}>
                                <span className="cl-status-dot"></span>
                                {isTaken ? "Taken" : "Free"}
                              </span>
                              <button className="btn-del" onClick={e => { e.stopPropagation(); deleteCode(c.id); }}>Delete</button>
                            </div>
                          );
                        })}
                    </div>
                  )
                }
              </>
            )}

            {/* ── ACTIVITY LOG SUB-SCREEN ── */}
            {mgrScreen === "activity" && (
              <>
                <button className="mgr-back" onClick={() => setMgrScreen(null)}>
                  <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                    <path d="M7 1L1.5 6.5L7 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Code Manager
                </button>
                <div className="m-head">
                  <div className="m-title">Activity Log</div>
                  <div className="m-sub">Last 200 entries, 30 days.</div>
                </div>
                {actLog.length === 0
                  ? <div className="act-empty">No activity yet.</div>
                  : (
                    <div className="act-log tall">
                      {actLog.map(a => (
                        <div key={a.id} className="act-item">
                          <span className={`act-dot ${a.type}`}></span>
                          <span className="act-text">{a.text}</span>
                          <span className="act-time">{formatTimeShort(a.ts)}</span>
                        </div>
                      ))}
                    </div>
                  )
                }
              </>
            )}

            {/* ── RELEASE HISTORY SUB-SCREEN ── */}
            {mgrScreen === "history" && (
              <>
                <button className="mgr-back" onClick={() => setMgrScreen(null)}>
                  <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                    <path d="M7 1L1.5 6.5L7 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Code Manager
                </button>
                <div className="m-head">
                  <div className="m-title">Release History</div>
                  <div className="m-sub">Past 30 days.</div>
                </div>
                {releaseHistory.length === 0
                  ? <div className="act-empty">No releases in the past 30 days.</div>
                  : (
                    <div className="act-log tall">
                      {releaseHistory.map(r => {
                        const durMs = r.takenAt ? toMs(r.releasedAt) - toMs(r.takenAt) : null;
                        const durH = durMs ? Math.floor(durMs / (1000 * 60 * 60)) : 0;
                        const durM = durMs ? Math.floor((durMs % (1000 * 60 * 60)) / (1000 * 60)) : 0;
                        const durStr = durMs ? (durH > 0 ? ` · held ${durH}h ${durM}m` : ` · held ${durM}m`) : "";
                        return (
                          <div key={r.id} className="act-item">
                            <span className="act-dot release"></span>
                            <span className="act-text">
                              <strong>{r.code}</strong> held by <strong>{r.takenBy}</strong>
                              {r.takenAt && ` · took ${formatTime(r.takenAt)}`}
                              {durStr}
                              {r.takenDevice && <span className="act-device" title={r.takenDevice}> · dev {r.takenDevice.slice(-6)}</span>}
                            </span>
                            <span className="act-time">{formatTimeShort(r.releasedAt)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )
                }
              </>
            )}

          </div>
        </div>
      )}


      {/* ── BULK DELETE CONFIRM ── */}
      {bulkDelConfirm && (
        <div className="overlay" onClick={() => setBulkDelConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="m-head">
              <div className="m-title">Delete {selectedCodes.size} Code{selectedCodes.size > 1 ? "s" : ""}?</div>
              <div className="m-sub">This cannot be undone.</div>
            </div>
            <div className="bdc-list">
              {codes.filter(c => selectedCodes.has(c.id)).map(c => (
                <div key={c.id} className="bdc-item">
                  <span className="bdc-code">{c.code}</span>
                  <span className="bdc-status">{c.status === STATUS.TAKEN ? `Taken · ${c.takenBy}` : "Available"}</span>
                </div>
              ))}
            </div>
            <div className="m-actions">
              <button className="btn-sec" onClick={() => setBulkDelConfirm(false)}>Cancel</button>
              <button className="btn-pri red" onClick={bulkDelete}>Delete All</button>
            </div>
          </div>
        </div>
      )}

      {/* ── SCHEDULED DROP DELETE CONFIRM ── */}
      {dropDelConfirm && (
        <div className="overlay" onClick={() => setDropDelConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="m-head">
              <div className="m-title">Delete {monthLabel(dropDelConfirm.monthKey)} Drop?</div>
              <div className="m-sub">This cannot be undone.</div>
            </div>
            <div className="confirm-chip">
              <div className="confirm-chip-label">Staged codes to remove</div>
              <div className="confirm-chip-code">{dropDelConfirm.ids.length}</div>
              <div className="confirm-chip-by">
                Nothing live is affected. These codes have not gone out yet.
              </div>
            </div>
            <div className="m-actions">
              <button className="btn-sec" onClick={() => setDropDelConfirm(null)}>Cancel</button>
              <button className="btn-pri red" onClick={deleteDrop}>Delete Drop</button>
            </div>
          </div>
        </div>
      )}
      <Analytics />
    </>
  );
}

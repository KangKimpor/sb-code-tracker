// Version 1.3.0
import { useState, useEffect, useRef } from "react";
import pillArtwork from "./assets/pchum-ben-pill.webp";
import pillFont from "./assets/dm-sans-bold.woff2";
import { Analytics } from "@vercel/analytics/react";
import { initializeApp } from "firebase/app";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, limit, where,
  serverTimestamp, getDocs, writeBatch, Timestamp
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
// PERF FIX: default getFirestore() has no local cache, so every listener attach
// round-trips cold to Firestore's backend with no warm channel to reuse. On
// slow/flaky mobile networks this reads as "laggy, slow to load." persistentLocalCache
// lets the codes listener paint from a warm local cache immediately instead of waiting
// on the network, and experimentalAutoDetectLongPolling falls back off WebChannel
// streaming on networks (some mobile carriers, corporate wifi) where it stalls instead
// of erroring cleanly. As of v3.7.0, Take itself no longer waits on a transaction
// round-trip either (the reveal is optimistic, see takeCode), so this cache mainly
// still matters for the initial code list paint and for Release, which still queues
// a plain updateDoc.
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
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html {
    -webkit-text-size-adjust: 100%; text-size-adjust: 100%; touch-action: manipulation;
    overscroll-behavior-y: contain;
    scrollbar-gutter: stable;   /* reserve the scrollbar so locking scroll never shifts the page */
  }
  /* Lock the page behind any open modal. The gutter above stops the layout jump. */
  html:has(.overlay), body:has(.overlay) { overflow: hidden; }

  :root {
    --bg: #eeeef2;
    --surface: #ffffff;
    --track: #e4e4e9;          /* segmented control + search field */

    /* Opaque fills. Each was a translucent color composited over white, which is the
       surface every tag, button and field here sits on. The tints also read correctly on
       the page background, so no white-versus-bg split was needed. */
    --surface-raised: #fdfdfe;
    --surface-2: #f4f4f5;
    --surface-3: #eeeef0;
    --taken-row: #f8f8fa;
    --border: rgba(60,60,67,0.1);
    --border-mid: rgba(60,60,67,0.15);
    --text: #1c1c1e;
    --text-2: #3a3a3c;
    --text-3: #636366;
    --text-4: #aeaeb2;
    --blue: #007aff;
    --blue-light: #e6f2ff;
    --blue-mid: #d1e7ff;
    /* Saturated blue for fills that carry white text: passes 4.5:1, the base blue does not. */
    --blue-dark: #0071e3;
    --blue-hover: #0068d6;
    --blue-press: #005bbf;
    --green: #34c759;
    --green-dark: #1f7a37;    /* text on tints, and fills that carry white text: 4.5:1 or better */
    --green-hover: #1a6b2e;
    --green-press: #155a26;
    --green-strong: #1ea94d;   /* hero figure: passes 3:1 at large sizes */

    --green-light: #e7f8eb;
    --green-mid: #d2f3da;
    --red: #ff3b30;
    --red-dark: #c0392b;
    --red-hover: #ad3225;
    --red-press: #962a1f;
    --red-light: #ffebea;
    --red-mid: #ffdcda;
    --orange: #ff9500;
    --orange-dark: #944f00;
    --orange-hover: #834600;
    --orange-press: #6f3b00;

    --orange-light: #fff4e6;
    --orange-mid: #ffdfb2;
    --purple: #af52de;
    --purple-dark: #8e34c4;
    --purple-light: #f7eefc;
    --purple-mid: #e9cff6;
    --disabled-bg: #e4e4e9;
    --disabled-text: #8e8e93;
    --on-dark-2: #bbbbbc;
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
    /* Pressed fills. Opaque and darker than the resting fill, so a tap reads clearly now
       that the native tap highlight is off. */
    --ink-press: #000000;
    --track-press: #d6d6dc;
    --surface-press: #e9e9ee;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 16px;
    touch-action: manipulation;
    overscroll-behavior-y: contain;
    min-height: 100vh; min-height: 100svh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.1px;
  }

  /* No double-tap zoom and no 300ms tap delay on anything tappable. */
  button, select, input, textarea, label, a,
  .t-row, .cl-item, .mgr-row, .mgr-row-static, .pill, .bdg, .seg, .modal {
    touch-action: manipulation;
  }

  /* Chrome, not content: UI text cannot be long-press selected and shows no iOS callout.
     Code values and form fields stay selectable so a code can still be copied. */
  button, label, h1, h2, h3, .pill, .bdg, .t-row, .cl-item, .mgr-row, .mgr-row-static,
  .mgr-alert-row, .act-item, .bdc-item, .hero-num, .hero-sub, .m-title, .m-sub,
  .logo-img {
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  .reveal-code, .t-code, .t-code-masked, .cl-name, .bdc-code,
  input, textarea, select {
    -webkit-user-select: text; user-select: text;
  }

  .page {
    min-height: 100vh; min-height: 100svh;
    position: relative;
    transform: translateY(var(--pull-distance, 0px));
    transition: transform 0.24s var(--ease-out);
    display: flex; flex-direction: column;
    width: 100%; max-width: 560px; margin: 0 auto;
    padding: env(safe-area-inset-top, 0px) max(16px, env(safe-area-inset-right, 0px))
             calc(44px + env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
    text-align: left;   /* index.css centres #root */
  }
  .page.is-pulling { transition: none; }
  .pull-refresh {
    position: absolute; top: 0; left: 0; width: 100%; height: 56px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transform: translateY(-100%); visibility: hidden; pointer-events: none;
    color: var(--text-3); font-size: 13px; font-weight: 600;
  }
  .pull-refresh.visible { visibility: visible; }
  .pull-refresh-icon { display: inline-block; font-size: 20px; line-height: 1; }
  .pull-refresh.refreshing .pull-refresh-icon { animation: spin 0.8s linear infinite; }
  @media (prefers-reduced-motion: reduce) {
    .page { transition: none; }
    .pull-refresh.refreshing .pull-refresh-icon { animation: none; }
  }

  /* ─── HEADER ─── */
  .topbar {
    display: flex; flex-direction: column; align-items: flex-start; gap: 14px;
    padding: 22px 4px 20px;
  }

  .logo-wrap {
    width: 180px; max-width: 100%;
    background: none; border: none; padding: 0;
    flex-shrink: 0; cursor: pointer; font: inherit;
    display: flex; align-items: center;
    transition: transform 0.12s var(--ease-out), background 0.12s;
  }
  @media (hover: hover) { .logo-wrap:hover { transform: scale(1.05); } }
  .logo-wrap:active { transform: scale(0.97); background: var(--track-press); border-radius: 12px; }

  .logo-img { width: 100%; height: auto; object-fit: contain; display: block; }

  .brand-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .brand-meta:empty { display: none; }

  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    border-radius: 20px; padding: 5px 11px;
    font-size: 12.5px; font-weight: 600; letter-spacing: -0.1px;
    border: 1px solid transparent; white-space: nowrap;
  }
  .pill-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pill.admin { background: var(--red-dark); border-color: var(--red-dark); color: #fff; }
  .pill.sched { background: var(--purple-light); border-color: var(--purple-mid); color: var(--purple-dark); }
  .pill.sched .pill-dot { background: var(--purple); }
  /* Staff waiting on a top-up. Orange rather than red: it is a request to act on, not
     a fault, and red is already spoken for by the admin pill sitting next to it. */
  .pill.req { background: var(--orange-light); border-color: var(--orange-mid); color: var(--orange-dark); }
  .pill.req .pill-dot { background: var(--orange); }

  .conn-banner {
    background: var(--red-light); color: var(--red-dark);
    border: 1px solid var(--red-mid); border-radius: var(--r-lg);
    padding: 11px 16px; font-size: 13.5px; text-align: center;
    margin-bottom: 14px;
  }
  .conn-banner button {
    margin-left: 10px; background: var(--surface); border: 1px solid var(--red-dark); color: var(--red-dark);
    border-radius: var(--r-xs); padding: 3px 11px; font-size: 12.5px; cursor: pointer;
    font-family: var(--font); font-weight: 600;
    transition: background 0.12s, color 0.12s, transform 0.12s;
  }
  .conn-banner button:active { transform: scale(0.97); background: var(--red-press); border-color: var(--red-press); color: #fff; }

  .main { flex: 1; display: flex; flex-direction: column; }

  /* ─── AVAILABILITY HERO ─── */
  /* Replaces the three Total/Available/Taken stat cards. Staff only ever asked
     one question here: is there a code left for me. */
  @font-face {
    font-family: 'Pill DM Sans'; src: url('${pillFont}') format('woff2');
    font-weight: 900; font-display: swap;
  }
  .hero { margin-bottom: 16px; text-align: center; }
  .hero-headline {
    container-type: inline-size; aspect-ratio: 1366 / 340;
    display: flex; align-items: center; justify-content: center;
    background: #fcfaf6 url('${pillArtwork}') center / 100% 100% no-repeat;
    border-radius: 999px; box-shadow: var(--sh);
  }
  .hero-details {
    background: var(--surface); border-radius: var(--r-lg);
    padding: 16px 22px; margin-top: 10px;
  }
  .hero-num {
    max-width: 60%; font-family: 'Pill DM Sans', var(--font);
    font-size: 5cqw; font-weight: 900; line-height: 1.1;
    letter-spacing: 0; color: #098451;
    /* Keyed on the avail/total pair in the JSX below, so React remounts this node
       (and replays the animation) whenever the count actually changes, not on every
       render. Gives the headline figure a small settle instead of silently jumping,
       whether the change came from this device's own Take or someone else's via
       onSnapshot. */
    animation: numSettle 0.24s var(--ease-out) both;
  }
  @keyframes numSettle {
    from { opacity: 0; transform: translateY(-3px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .hero-num.none { color: var(--text-3); }
  .hero-sub { font-size: 15px; color: var(--text-3); margin-top: 7px; letter-spacing: -0.2px; }
  .hero-sub.urgent { color: var(--orange-dark); font-weight: 600; }

  /* Lives in the hero, not the empty state, so an empty pool always offers a way out
     regardless of which filter is active. Full width and blue, because when it shows it
     is the only action on the screen worth taking. */
  .btn-topup {
    width: 100%; margin-top: 16px;
    background: var(--blue-dark); color: #fff; border: none;
    border-radius: 14px; font-family: var(--font);
    font-size: 14.5px; font-weight: 600; padding: 12px;
    cursor: pointer; transition: background 0.12s, transform 0.12s, box-shadow 0.12s;
    box-shadow: 0 1px 4px rgba(0,122,255,0.3);
    -webkit-tap-highlight-color: transparent;
  }
  @media (hover: hover) { .btn-topup:hover:not(:disabled) { background: var(--blue-hover); box-shadow: 0 3px 12px rgba(0,122,255,0.34); } }
  .btn-topup:active:not(:disabled) { transform: scale(0.97); background: var(--blue-press); }
  .btn-topup:disabled { cursor: default; }
  /* Sent state stays legible rather than dimmed: it is a confirmation, and a greyed-out
     button reads as a failure to a person who just pressed it. */
  .btn-topup.sent {
    background: var(--green-light); color: var(--green-dark);
    border: 1px solid var(--green-mid);
    box-shadow: none;
    /* Same one-shot pulse pattern as .btn-copy.copied: confirms the tap landed without
       looping for as long as the sent state remains true. */
    animation: copyPulse 0.32s var(--ease-spring);
  }
  .topup-note { font-size: 12.5px; color: var(--text-4); margin-top: 9px; line-height: 1.45; animation: rowIn 0.22s var(--ease-out) both; }

  /* ─── ADMIN ALERTS ─── */
  /* Advisory banners above the hero, admin only. Deliberately not styled as cards: they sit
     between the header and the hero card and should read as an interruption in the flow
     rather than another piece of furniture competing with the availability figure. */
  .admin-alerts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .admin-alert {
    display: flex; align-items: center; gap: 11px; flex-wrap: wrap;
    padding: 12px 14px; border-radius: var(--r-lg);
    border: 1px solid transparent;
    animation: bannerIn 0.28s var(--ease-out) both;
  }
  /* Motion only: a banner never passes through a translucent state. */
  @keyframes bannerIn { from { transform: translateY(5px); } to { transform: translateY(0); } }
  .admin-alert.warn { background: var(--orange-light); border-color: var(--orange-mid); }
  .admin-alert.urgent { background: var(--red-light); border-color: var(--red-mid); }
  .admin-alert-ico {
    width: 25px; height: 25px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 700; color: #fff; line-height: 1;
  }
  .admin-alert.warn .admin-alert-ico { background: var(--orange-dark); }
  .admin-alert.urgent .admin-alert-ico { background: var(--red-dark); }
  /* Slow, subtle breathing pulse on the urgent icon only (pool fully claimed), not the
     warn tier (low stock, unstaged month). Urgent means "act now"; warn means "worth
     knowing." Scoped to the small icon dot rather than the whole banner so it draws a
     glance without becoming a distraction admin has to stare past all day. */
  .admin-alert.urgent .admin-alert-ico { animation: alertPulse 2.2s ease-in-out infinite; }
  @keyframes alertPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,59,48,0.35); }
    50%      { box-shadow: 0 0 0 6px rgba(255,59,48,0); }
  }
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
    padding: 8px 14px; cursor: pointer; transition: all 0.12s;
    flex-shrink: 0; white-space: nowrap;
  }
  @media (hover: hover) { .admin-alert-btn:hover { background: var(--text); color: #fff; border-color: var(--text); } }
  .admin-alert-btn:active { transform: scale(0.97); background: var(--text-2); color: #fff; border-color: var(--text-2); }

  /* ─── TOOLBAR ─── */
  .toolbar { display: flex; flex-direction: column; margin-bottom: 16px; }
  /* The later modal .seg-ctrl rule adds margin-bottom: 12px here too. Zero it so tabs-to-list
     matches the pill-to-tabs gap (16px each). */
  .toolbar .seg-ctrl { margin-bottom: 0; }

  .seg-ctrl {
    display: flex; width: 100%;
    background: var(--track); border-radius: 14px;
    padding: 4px; gap: 2px;
  }
  .seg {
    flex: 1; background: none; border: none; border-radius: 11px;
    font-family: var(--font); font-size: 14.5px; font-weight: 600;
    color: var(--text-2); padding: 9px 6px; cursor: pointer;
    transition: background 0.12s, color 0.12s, transform 0.12s; white-space: nowrap;
    position: relative;
  }
  .seg.active { background: var(--blue-dark); color: #fff; box-shadow: 0 1px 5px rgba(0,122,255,0.35); }
  @media (hover: hover) { .seg:not(.active):hover { color: var(--text); } }
  .seg:active { transform: scale(0.97); }
  .seg:not(.active):active { background: var(--track-press); }
  .seg.active:active { background: var(--blue-press); }
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
    cursor: pointer; transition: background 0.12s, transform 0.12s;
  }
  @media (hover: hover) { .btn-mgr:hover { background: #3a3a3c; } }
  .btn-mgr:active { transform: scale(0.97); background: var(--ink-press); }

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
  @media (hover: hover) { .t-row:hover { box-shadow: var(--sh); } }
  .t-row.is-taken { box-shadow: none; background: var(--taken-row); }
  /* Pending Take: a solid grey state instead of a fade, so the tap still reads as
     registered while the write is in flight. */
  .t-row.is-optimistic { background: var(--taken-row); pointer-events: none; transition: background 0.22s var(--ease-out); }
  /* Solid grey in place of fading the row: the pending Take button is a disabled control. */
  .t-row.is-optimistic .btn-take { background: var(--disabled-bg); color: var(--disabled-text); box-shadow: none; }
  .t-row.is-optimistic .t-code { color: var(--text-4); }

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
  .t-device { font-size: 10.5px; color: var(--text-4); font-family: var(--font-mono); white-space: nowrap; }
  .t-act { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

  /* Badges */
  .bdg {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10.5px; font-weight: 600; border-radius: 20px;
    padding: 2px 8px; border: 1px solid transparent;
  }
  .bdg-dot { width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; }
  .bdg.avail { background: var(--green-light); color: var(--green-dark); border-color: var(--green-mid); }
  .bdg.avail .bdg-dot { background: var(--green-dark); }
  .bdg.taken { background: var(--red-light); color: var(--red-dark); border-color: var(--red-mid); }
  .bdg.taken .bdg-dot { background: var(--red-dark); }
  .bdg.sched { background: var(--purple-light); color: var(--purple-dark); border-color: var(--purple-mid); }
  .bdg.sched .bdg-dot { background: var(--purple); }
  .bdg.exp { background: var(--surface-recessed); color: var(--text-3); border-color: var(--border-mid); }
  .bdg.exp .bdg-dot { background: var(--text-4); }

  /* Row action buttons */
  .btn-take {
    background: var(--blue-dark); color: #fff; border: none;
    border-radius: 12px; font-family: var(--font);
    font-size: 15px; font-weight: 600; padding: 11px 26px;
    cursor: pointer; transition: background 0.12s, transform 0.12s, box-shadow 0.12s;
    box-shadow: 0 1px 4px rgba(0,122,255,0.32);
  }
  @media (hover: hover) { .btn-take:hover { background: var(--blue-hover); box-shadow: 0 3px 12px rgba(0,122,255,0.36); } }
  .btn-take:active { transform: scale(0.97); background: var(--blue-press); }

  .btn-release {
    background: none; border: 1px solid var(--border-mid);
    border-radius: 12px; font-family: var(--font);
    font-size: 13px; font-weight: 600; color: var(--text-3);
    padding: 9px 15px; cursor: pointer; transition: all 0.12s;
  }
  @media (hover: hover) { .btn-release:hover { border-color: var(--red-mid); color: var(--red-dark); background: var(--red-light); } }
  /* Was missing the tap-scale feedback .btn-take already had, the more common button
     on this same row for non-admins. Admin taps this constantly during release sweeps,
     so the same feedback parity matters here too. */
  .btn-release:active { transform: scale(0.97); background: var(--track-press); }

  .btn-taken-lock {
    font-size: 12.5px; font-weight: 600; color: var(--text-3);
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
    .page {
      padding: env(safe-area-inset-top, 0px) max(12px, env(safe-area-inset-right, 0px))
               calc(36px + env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
    }
    .topbar { gap: 11px; padding: 18px 2px 16px; }
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
  /* Sized to the visible viewport (main.jsx keeps --vv-h and --vv-top current), so the
     on-screen keyboard never covers a centred modal. The 100dvh lines are the fallback
     for the moment before that script has run. */
  .overlay {
    position: fixed; left: 0; right: 0;
    top: var(--vv-top, 0px);
    height: 100svh; height: 100dvh; height: var(--vv-h, 100dvh);
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    padding: max(20px, env(safe-area-inset-top, 0px)) max(20px, env(safe-area-inset-right, 0px))
             max(20px, env(safe-area-inset-bottom, 0px)) max(20px, env(safe-area-inset-left, 0px));
    overscroll-behavior: contain;
    touch-action: none;   /* nothing behind a modal pans; scrollers inside it still do */
    animation: fadeOvr 0.18s ease;
  }
  @keyframes fadeOvr { from{opacity:0;} to{opacity:1;} }

  .modal {
    background: var(--surface);
    border-radius: var(--r-2xl);
    padding: 26px 24px;
    width: 100%; max-width: 390px;
    max-height: 100%;
    overflow-y: auto; overscroll-behavior: contain;
    box-shadow: var(--sh-xl);
    border: 1px solid var(--border);
    animation: modalIn 0.26s var(--ease-spring);
  }
  .modal.wide {
    max-width: 520px;
    max-height: 88svh; max-height: 88dvh;
    max-height: min(100%, 88dvh);
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
  .confirm-chip-code { font-family: var(--font-mono); font-size: 20px; font-weight: 700; color: var(--red-dark); letter-spacing: 0.5px; margin-bottom: 4px; }
  .confirm-chip-by { font-size: 13px; color: var(--text-3); }
  /* Release-only variant: solid orange fill matching .btn-pri.orange, so the box itself
     reads as "this leads to the orange action" the same way the red chip reads as
     "this leads to a destructive action" above. Scoped to .confirm-chip.release rather
     than changing .confirm-chip directly, since that class is shared with the Staged
     codes to remove (delete) confirmation, which should stay red/destructive-coded. */
  .confirm-chip.release {
    background: var(--orange-dark);
    border-color: var(--orange-dark);
  }
  .confirm-chip.release .confirm-chip-label { color: var(--orange-light); }
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
    border-radius: var(--r-sm); padding: 9px 14px;
    font-family: var(--font); font-size: 16px; color: var(--text);
    min-height: 44px;
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
    border-radius: var(--r-sm); padding: 9px 34px 9px 14px;
    font-family: var(--font); font-size: 16px; font-weight: 500; color: var(--text);
    min-height: 44px;
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
  .pin-err { font-size: 12px; font-weight: 500; color: var(--red-dark); text-align: center; height: 18px; }
  .take-error {
    font-size: 12.5px; color: var(--red-dark); background: var(--red-light);
    border: 1px solid var(--red-mid); border-radius: var(--r-xs); padding: 8px 12px; margin-top: 4px;
  }

  /* Modal actions */
  .m-actions { display: flex; gap: 8px; margin-top: 18px; }

  .btn-sec {
    flex: 1; background: var(--surface-2);
    border: 1px solid var(--border-mid);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 14px; font-weight: 600; color: var(--text-3);
    padding: 11px; cursor: pointer; transition: all 0.12s;
  }
  @media (hover: hover) { .btn-sec:hover { background: var(--surface-3); color: var(--text-2); } }
  .btn-sec:active { transform: scale(0.97); background: var(--track-press); color: var(--text-2); }

  .btn-pri {
    flex: 1; border: none; border-radius: var(--r-sm);
    font-family: var(--font); font-size: 14px; font-weight: 600;
    color: #fff; padding: 11px; cursor: pointer;
    transition: all 0.12s;
  }
  .btn-pri:active:not(:disabled) { transform: scale(0.97); }
  .btn-pri.blue { background: var(--blue-dark); box-shadow: 0 1px 4px rgba(0,122,255,0.22); }
  @media (hover: hover) { .btn-pri.blue:hover:not(:disabled) { background: var(--blue-hover); box-shadow: 0 3px 10px rgba(0,122,255,0.3); } }
  .btn-pri.blue:active:not(:disabled) { background: var(--blue-press); }
  .btn-pri.green { background: var(--green); box-shadow: 0 1px 4px rgba(52,199,89,0.22); }
  @media (hover: hover) { .btn-pri.green:hover:not(:disabled) { background: var(--green-strong); box-shadow: 0 3px 10px rgba(52,199,89,0.3); } }
  .btn-pri.green:active:not(:disabled) { background: var(--green-dark); }
  .btn-pri.orange { background: var(--orange-dark); box-shadow: 0 1px 4px rgba(255,149,0,0.22); }
  @media (hover: hover) { .btn-pri.orange:hover:not(:disabled) { background: var(--orange-hover); } }
  .btn-pri.orange:active:not(:disabled) { background: var(--orange-press); }
  .btn-pri.red { background: var(--red-dark); box-shadow: 0 1px 4px rgba(255,59,48,0.22); }
  @media (hover: hover) { .btn-pri.red:hover:not(:disabled) { background: var(--red-hover); } }
  .btn-pri.red:active:not(:disabled) { background: var(--red-press); }
  /* Disabled is a solid grey fill with solid grey text, never a fade. Placed after every
     color variant: they share specificity with this rule, so order decides. */
  .btn-pri:disabled, .btn-pri.blue:disabled, .btn-pri.green:disabled,
  .btn-pri.orange:disabled, .btn-pri.red:disabled {
    background: var(--disabled-bg); color: var(--disabled-text);
    box-shadow: none; cursor: not-allowed;
  }

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
  @media (hover: hover) { .mgr-row:hover { background: var(--bg); } }
  .mgr-row:active { background: var(--track-press); }
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
    background: none; border: none; color: var(--blue-dark);
    font-family: var(--font); font-size: 15px; font-weight: 500;
    padding: 0 0 16px; cursor: pointer;
    transition: color 0.12s, transform 0.12s;
  }
  @media (hover: hover) { .mgr-back:hover { color: var(--blue-press); } }
  .mgr-back:active { color: var(--blue-press); transform: scale(0.97); }

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
    background: var(--orange-dark);
  }
  .mgr-alert-ico.muted { background: var(--text-3); }
  .mgr-alert-main { flex: 1; min-width: 160px; }
  .mgr-alert-title { font-size: 13.5px; font-weight: 600; color: var(--orange-dark); }
  .mgr-alert-title.muted { color: var(--text-2); }
  .mgr-alert-sub { font-size: 12px; color: var(--text-4); line-height: 1.45; margin-top: 2px; }
  .mgr-alert-btn {
    background: var(--bg); border: 1px solid var(--border-mid);
    border-radius: var(--r-xs); font-family: var(--font);
    font-size: 12px; font-weight: 600; color: var(--text-2);
    padding: 6px 13px; cursor: pointer; transition: all 0.12s;
    flex-shrink: 0; white-space: nowrap;
  }
  @media (hover: hover) { .mgr-alert-btn:hover { background: var(--track); } }
  .mgr-alert-btn:active { transform: scale(0.97); background: var(--track-press); }

  /* Drop scheduling */
  .drop-note { font-size: 12px; color: var(--text-4); margin-top: 8px; line-height: 1.45; }
  .drop-note.sched { color: var(--purple-dark); font-weight: 500; }

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
    transition: all 0.12s;
  }
  .seg-ctrl button.active {
    background: var(--surface); color: var(--text);
    font-weight: 600; box-shadow: var(--sh-sm);
  }
  .seg-ctrl button:not(.seg):active { transform: scale(0.97); background: var(--track-press); }
  .seg-ctrl button.active:not(.seg):active { background: var(--surface-press); }

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
    cursor: pointer; transition: all 0.12s; flex-shrink: 0;
  }
  @media (hover: hover) { .btn-add:hover { background: #3a3a3c; } }
  .btn-add:active { transform: scale(0.97); background: var(--ink-press); }

  .bulk-ta {
    width: 100%; background: var(--surface-recessed);
    border: 1.5px solid var(--border);
    border-radius: var(--r-sm); padding: 9px 14px;
    font-family: var(--font-mono); font-size: 16px;
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
    transition: all 0.12s;
  }
  @media (hover: hover) { .btn-bulk:hover:not(:disabled) { background: var(--surface-3); color: var(--text-2); } }
  .btn-bulk:active:not(:disabled) { transform: scale(0.97); background: var(--track-press); color: var(--text-2); }
  .btn-bulk:disabled { background: var(--disabled-bg); border-color: var(--disabled-bg); color: var(--disabled-text); cursor: default; }

  /* Code list */
  .code-list {
    max-height: 220px; overflow-y: auto; overscroll-behavior: contain;
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
  @media (hover: hover) { .cl-item:hover { background: var(--bg); } }
  .cl-item:active { background: var(--track-press); }
  .cl-item.sel { background: var(--track); }
  .cl-item.sel:active { background: var(--track-press); }

  .cl-check {
    width: 18px; height: 18px; border-radius: 5px;
    border: 1.5px solid var(--border-mid);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; background: var(--surface);
    transition: all 0.14s var(--ease-spring);
  }
  .cl-item.sel .cl-check { background: var(--blue-dark); border-color: var(--blue-dark); }
  .cl-check-ico { display: none; }
  .cl-item.sel .cl-check-ico { display: block; }

  .cl-name-row { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .cl-name { font-size: 14px; font-weight: 600; color: var(--text); font-family: var(--font-mono); letter-spacing: 0.2px; }
  .cl-tag {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
    padding: 1px 6px; border-radius: 4px; flex-shrink: 0;
  }
  .cl-tag.sched { background: var(--text); color: #fff; }
  .cl-tag.exp { background: var(--surface-recessed); color: var(--text-3); border: 1px solid var(--border-mid); }
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
    padding: 4px 10px; cursor: pointer; transition: all 0.12s; flex-shrink: 0;
  }
  @media (hover: hover) { .btn-del:hover { border-color: var(--red-dark); color: #fff; background: var(--red-dark); } }
  .btn-del:active { transform: scale(0.97); border-color: var(--red-press); color: #fff; background: var(--red-press); }

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
    color: var(--blue-dark); cursor: pointer; transition: color 0.12s, transform 0.12s;
  }
  @media (hover: hover) { .btn-textlink:hover { color: var(--blue-press); } }
  .btn-textlink:active { color: var(--blue-press); transform: scale(0.97); }

  .sel-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 12px; margin-bottom: 8px;
    background: var(--text); border-radius: var(--r-sm);
  }
  .sel-count { font-size: 12.5px; font-weight: 600; color: #fff; }
  .sel-toolbar-actions { display: flex; align-items: center; gap: 14px; }
  .sel-toolbar .btn-textlink { color: var(--on-dark-2); }
  @media (hover: hover) { .sel-toolbar .btn-textlink:hover { color: #fff; } }
  .sel-toolbar .btn-textlink:active { color: #fff; transform: scale(0.97); }
  .sel-toolbar .btn-del-sel {
    background: var(--red-dark); color: #fff; border: none;
    border-radius: 6px; font-family: var(--font); font-size: 11.5px;
    font-weight: 600; padding: 5px 12px; cursor: pointer; transition: all 0.12s;
  }
  @media (hover: hover) { .sel-toolbar .btn-del-sel:hover { background: var(--red-hover); } }
  .sel-toolbar .btn-del-sel:active { transform: scale(0.97); background: var(--red-press); }

  /* Activity log */
  .act-log { max-height: 180px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--border); border-radius: var(--r-sm); }
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
  .act-dot.delete, .act-dot.bulk { background: var(--red-dark); }
  .act-dot.export { background: #5ac8fa; }
  .act-dot.request { background: var(--orange); }
  .act-dot.schedule { background: var(--purple); }
  .act-dot.expire { background: var(--text-4); }
  .act-text { font-size: 12px; color: var(--text-3); flex: 1; line-height: 1.4; }
  .act-text strong { color: var(--text); font-weight: 600; }
  .act-time { font-size: 10.5px; color: var(--text-4); font-family: var(--font-mono); white-space: nowrap; }
  .act-device { color: var(--text-4); font-family: var(--font-mono); font-size: 11px; }
  .act-empty { padding: 20px; text-align: center; color: var(--text-4); font-size: 12.5px; }

  /* Bulk delete confirm modal list */
  .bdc-list { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); max-height: 160px; overflow-y: auto; overscroll-behavior: contain; margin-bottom: 4px; }
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
    padding: 12px; cursor: pointer; transition: all 0.12s;
    margin-top: 20px;
  }
  @media (hover: hover) { .btn-export-csv:hover { background: #3a3a3c; } }
  .btn-export-csv:active { transform: scale(0.97); background: var(--ink-press); }

  /* Clear Old Logs: outlined destructive, quiet by default since it's a rare
     maintenance action, not something to compete visually with Export CSV. */
  .btn-clear-logs {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
    background: var(--surface); border: 1px solid var(--border-mid); color: var(--red-dark);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 13.5px; font-weight: 600;
    padding: 12px; cursor: pointer; transition: all 0.12s; margin-top: 8px;
  }
  @media (hover: hover) { .btn-clear-logs:hover { background: var(--red-dark); border-color: var(--red-dark); color: #fff; } }
  .btn-clear-logs:active { transform: scale(0.97); background: var(--red-press); border-color: var(--red-press); color: #fff; }

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
    /* The payoff moment of the whole flow, so it gets its own entrance on top of the
       modal's modalIn: the block pops in a beat after the modal settles rather than
       just riding along with it. animation-fill-mode both plus a short delay is enough
       to read as "revealed" without feeling like a separate, competing effect. */
    animation: codePop 0.36s var(--ease-spring) 0.05s both;
  }
  @keyframes codePop {
    from { opacity: 0; transform: scale(0.88); }
    to   { opacity: 1; transform: scale(1); }
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
  @media (hover: hover) { .reveal-btn.btn-sec:hover { background: var(--surface-3); color: var(--text); } }
  .reveal-btn.btn-sec:active { background: var(--track-press); color: var(--text); }
  .reveal-btn.btn-pri { box-shadow: 0 4px 14px rgba(52,199,89,0.34); }

  .btn-copy { flex: 1; transition: background 0.12s, color 0.12s, transform 0.12s; }
  /* Defined after .reveal-btn.btn-sec so the confirmed state still wins on the
     reveal screen. Equal specificity, so source order is what decides it. */
  .btn-copy.copied {
    background: var(--green-light); color: var(--green-dark);
    border-color: var(--green-mid);
    /* One-shot confirmation pulse when the state flips to copied. Runs once (no
       infinite/alternate) so it reads as an acknowledgment, not a persistent state,
       and does not replay while "copied" stays true for its 1.5s window. */
    animation: copyPulse 0.32s var(--ease-spring);
  }
  @keyframes copyPulse {
    0%   { transform: scale(1); }
    45%  { transform: scale(1.045); }
    100% { transform: scale(1); }
  }
  .btn-copy.copied:active { transform: scale(0.97); background: var(--green-mid); }

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

  /* ─── HIT AREAS ─── */
  /* Every tappable element reaches at least 44 by 44px. A transparent pseudo-element grows
     the target only when the element is smaller, so nothing moves on screen. Pills and
     badges are display-only spans and are not tappable, so they are not listed. */
  .logo-wrap,
  .btn-topup,
  .admin-alert-btn,
  .seg,
  .btn-mgr,
  .btn-take,
  .btn-release,
  .conn-banner button,
  .btn-sec,
  .btn-pri,
  .mgr-row,
  .mgr-back,
  .mgr-alert-btn,
  .seg-ctrl button,
  .btn-add,
  .btn-bulk,
  .btn-del,
  .btn-textlink,
  .btn-del-sel,
  .btn-export-csv,
  .btn-clear-logs,
  .cl-item { position: relative; }
  .logo-wrap::after,
  .btn-topup::after,
  .admin-alert-btn::after,
  .seg::after,
  .btn-mgr::after,
  .btn-take::after,
  .btn-release::after,
  .conn-banner button::after,
  .btn-sec::after,
  .btn-pri::after,
  .mgr-row::after,
  .mgr-back::after,
  .mgr-alert-btn::after,
  .seg-ctrl button::after,
  .btn-add::after,
  .btn-bulk::after,
  .btn-del::after,
  .btn-textlink::after,
  .btn-del-sel::after,
  .btn-export-csv::after,
  .btn-clear-logs::after,
  .cl-item::after {
    content: ""; position: absolute; top: 50%; left: 50%;
    width: max(100%, 44px); height: max(100%, 44px);
    transform: translate(-50%, -50%);
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

  const pageRef = useRef(null);
  const [pullState, setPullState] = useState("idle");
  const refreshBlocked = takeBusy || requestBusy || Object.keys(optimistic).length > 0;

  // Ordinary scrolling and bottom-edge bounce stay native. Only a downward drag
  // that starts at the very top takes over touchmove, including in Telegram/PWA.
  useEffect(() => {
    const page = pageRef.current;
    let start = null;
    let distance = 0;
    let frame = null;
    let refreshing = false;
    const blocked = () => refreshBlocked || !!document.querySelector(".overlay");
    const paint = () => page.style.setProperty("--pull-distance", `${distance}px`);
    // Register before a top-edge gesture begins so the browser knows it can be
    // cancelled. Remove it below the top to keep normal scrolling off this path.
    const syncMove = () => {
      if (window.scrollY <= 0) page.addEventListener("touchmove", move, { passive: false });
      else page.removeEventListener("touchmove", move);
    };
    const detach = () => {
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", cancel);
    };
    const reset = () => {
      detach();
      start = null;
      distance = 0;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      page.classList.remove("is-pulling");
      paint();
      setPullState("idle");
    };
    function move(event) {
      if (!start) return;
      if (event.touches.length !== 1 || blocked() || window.scrollY > 0 || !event.cancelable) {
        reset();
        return;
      }
      const dy = event.touches[0].clientY - start.y;
      const dx = event.touches[0].clientX - start.x;
      if (dy < 0 || Math.abs(dx) > Math.abs(dy)) {
        reset();
        return;
      }
      event.preventDefault();
      distance = Math.min(96, Math.max(0, (dy - 8) * 0.5));
      page.classList.add("is-pulling");
      setPullState(distance >= 64 ? "ready" : distance > 0 ? "pulling" : "idle");
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; paint(); });
    }
    function end(event) {
      if (distance > 0 && event.cancelable) event.preventDefault();
      if (distance < 64 || event.touches.length > 0 || blocked() || window.scrollY > 0) {
        reset();
        return;
      }
      detach();
      start = null;
      refreshing = true;
      if (frame !== null) cancelAnimationFrame(frame);
      distance = 64;
      page.classList.remove("is-pulling");
      paint();
      setPullState("refreshing");
      // Give the refreshing indicator a paint before loading the latest app.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => window.location.reload());
      });
    }
    function cancel() { reset(); }
    function begin(event) {
      if (refreshing) return;
      reset();
      if (event.touches.length !== 1 || window.scrollY > 0 || blocked()
          || event.target.closest("input, textarea, select, [contenteditable]")) return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      document.addEventListener("touchend", end, { passive: false });
      document.addEventListener("touchcancel", cancel, { passive: true });
    }
    setPullState("idle");
    page.addEventListener("touchstart", begin, { passive: true });
    window.addEventListener("scroll", syncMove, { passive: true });
    syncMove();
    return () => {
      page.removeEventListener("touchstart", begin);
      page.removeEventListener("touchmove", move);
      window.removeEventListener("scroll", syncMove);
      detach();
      if (frame !== null) cancelAnimationFrame(frame);
      page.classList.remove("is-pulling");
      page.style.removeProperty("--pull-distance");
    };
  }, [refreshBlocked]);

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

  // v3.7.0: FIX #16, replaced runTransaction with a plain updateDoc, and made the
  // reveal itself optimistic instead of waiting on the write. The old design paid a
  // full read-then-write transaction round-trip, and delayed the reveal screen
  // until it confirmed, on every single Take, specifically to guard against two
  // people tapping the same code at nearly the same instant, even though that case
  // is rare (most Takes are uncontested). That made the common, uncontested case
  // pay the same latency as the rare, contested one.
  //
  // Correctness now lives entirely in firestore.rules instead of in this function:
  // the CLAIM branch of the update rule requires resource.data.status ==
  // 'available' at write time, so a losing updateDoc is rejected by the server with
  // permission-denied, the same outcome a failed runTransaction used to produce,
  // just discovered after an optimistic reveal instead of before one. See the
  // "THIS IS THE LOAD-BEARING CHECK" comment in firestore.rules; do not weaken that
  // condition or this whole function becomes unsafe, since nothing else is
  // checking status before writing.
  //
  // A client-side check against the live `codes` state still runs first as a free
  // pre-filter: if the onSnapshot listener already shows this code taken, reject
  // instantly with no network call and no reveal at all. This covers the common
  // "someone beat you to it, and it's already visible in the list" case for free,
  // leaving only genuine same-instant collisions to fall through to the rules
  // check below.
  //
  // Deliberate trade-off, chosen over the phone with Por: the reveal now shows
  // BEFORE the write is confirmed. If this device's write is the one the server
  // rejects, reclaimAfterCollision (below) fires, apologizes, and immediately
  // tries to hand the staff member a different available code instead of leaving
  // them holding a code that silently was never theirs. This is worse for the
  // rare loser of a genuine race (they briefly see a code, then have it corrected)
  // in exchange for every normal Take feeling instant instead of waiting on a
  // round trip that, most of the time, wasn't protecting against anything.
  const takeCode = async (id, name) => {
    if (takeBusy) return; // guard against double-tap while a request is in flight
    const code = takeModal?.code;
    setTakeBusy(true);
    setTakeError("");

    // Free pre-filter: reject instantly if the live list already shows this taken,
    // no network round-trip, no optimistic reveal shown for a code that's
    // visibly already gone.
    const liveRow = codes.find(c => c.id === id);
    if (liveRow && liveRow.status !== STATUS.AVAILABLE) {
      setTakeBusy(false);
      setTakeError("Sorry, this code was just taken by someone else. Please choose another.");
      return;
    }

    setOptimistic(p => ({ ...p, [id]: { status: STATUS.TAKEN, takenBy: name, takenAt: Date.now() } }));

    // Reveal immediately, before the write confirms. This is the actual speedup:
    // the staff member sees their code without waiting on Firestore at all in the
    // common case. reclaimAfterCollision corrects this if it turns out to be wrong.
    setStaffName("");
    setTakeBusy(false);
    setRevealedCode({ code, name });

    const myDevice = getDeviceId();
    updateDoc(doc(db, "codes", id), {
      status: STATUS.TAKEN,
      takenBy: name,
      takenAt: serverTimestamp(),
      takenDevice: myDevice,
    }).then(() => {
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
      log("take", `${name} took ${code}`);
    }).catch(err => {
      // permission-denied here means someone else's write landed first and the
      // server rejected ours, the rules-enforced equivalent of the old
      // "already_taken" transaction failure, just discovered after an optimistic
      // reveal instead of before one. Anything else is a genuine unexpected error
      // (offline, rules drift) and is treated the same way: the reveal the staff
      // member is looking at was never actually confirmed, so it has to be
      // corrected either way.
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
      if (err?.code !== "permission-denied") {
        console.error("takeCode failed after optimistic reveal:", err);
      }
      reclaimAfterCollision(code, name);
    });
  };

  // Fires when an optimistic reveal turns out to have been wrong: this device's
  // write was rejected, so the code on screen was never actually claimed by this
  // staff member. Tells them plainly, then immediately tries to hand them a
  // different available code rather than leaving them empty-handed after already
  // seeing a "Your Code" screen. Rare by design (the pre-filter in takeCode catches
  // the common case), but has to exist because the reveal is no longer gated on
  // write confirmation.
  const reclaimAfterCollision = (lostCode, name) => {
    alert(`Sorry, "${lostCode}" was claimed by someone else at the same moment. Getting you a different code...`);
    const next = codes.find(c => c.status === STATUS.AVAILABLE && c.code !== lostCode);
    setRevealedCode(null);
    if (!next) {
      setTakeModal(null);
      setTakeError("No other codes are available right now. Please try again shortly.");
      return;
    }
    setTakeModal({ id: next.id, code: next.code });
    takeCode(next.id, name);
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
      <div className="page" ref={pageRef}>
        <div className={`pull-refresh ${pullState !== "idle" ? "visible" : ""} ${pullState === "refreshing" ? "refreshing" : ""}`} role="status" aria-live="polite">
          <span className="pull-refresh-icon" aria-hidden="true">↻</span>
          <span>{pullState === "refreshing" ? "Refreshing..." : pullState === "ready" ? "Release to refresh" : "Pull down to refresh"}</span>
        </div>

        {/* ── HEADER ── */}
        <nav className="topbar">
          <button
            type="button"
            className="logo-wrap"
            onClick={() => isAdmin ? setIsAdmin(false) : setPinModal(true)}
            title={isAdmin ? "Exit Admin" : "Admin Login"}
            aria-label={isAdmin ? "Exit Admin" : "Admin Login"}
          >
            <img src="/singbuild-logo.png" alt="Singbuild" width="682" height="185" className="logo-img" draggable="false" />
          </button>
          <div className="brand-meta">
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
            <div className="hero-headline">
              <div key={`${avail}-${total}`} className={`hero-num${avail === 0 ? " none" : ""}`}>
                {total === 0 ? `No codes for ${monthLabel(nowMonth)}` : `${avail} of ${total} code${total === 1 ? "" : "s"} available`}
              </div>
            </div>
            {(total === 0 || canRequestTopup) && <div className="hero-details">
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
            </div>}
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
                              dev {c.takenDevice ? c.takenDevice.slice(-6) : "none"}
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

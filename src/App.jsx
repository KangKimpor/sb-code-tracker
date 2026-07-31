// Version 1.1.0
import { useState, useEffect, useRef } from "react";
import { Analytics } from "@vercel/analytics/react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, onSnapshot,
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
const db = getFirestore(app);
const codesRef = collection(db, "codes");
const logsRef = collection(db, "activityLog");
const releaseHistRef = collection(db, "releaseHistory");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

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
  .pill.admin { background: var(--red-light); border-color: var(--red-mid); color: var(--red-dark); }
  .pill.admin .pill-dot { background: var(--red); }
  .pill.sched { background: rgba(175,82,222,0.10); border-color: rgba(175,82,222,0.28); color: #8e34c4; }
  .pill.sched .pill-dot { background: #af52de; }
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

  .search-box { position: relative; width: 100%; margin-top: 10px; }
  .search-ico {
    position: absolute; left: 15px; top: 50%;
    transform: translateY(-50%); color: var(--text-3);
    pointer-events: none; display: flex;
  }
  .search-inp {
    width: 100%; background: var(--track);
    border: 1.5px solid transparent; border-radius: 14px;
    padding: 12px 14px 12px 41px;
    font-family: var(--font); font-size: 15px; color: var(--text);
    outline: none; transition: background 0.16s, border-color 0.16s;
    -webkit-appearance: none;
  }
  .search-inp:focus { border-color: var(--blue); background: var(--surface); }
  .search-inp::placeholder { color: var(--text-3); }

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
  /* Each code is its own card. `.card` is kept as a transparent wrapper so the
     loading and empty states can slot into the same place in the markup. */
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
  .bdg.taken { background: var(--red-light); color: var(--red); border-color: var(--red-mid); }
  .bdg.taken .bdg-dot { background: var(--red); }
  .bdg.sched { background: rgba(175,82,222,0.10); color: #8e34c4; border-color: rgba(175,82,222,0.28); }
  .bdg.sched .bdg-dot { background: #af52de; }
  .bdg.exp { background: var(--surface-2); color: var(--text-4); border-color: var(--border-mid); }
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
    .search-inp { font-size: 14.5px; }
    .t-row { padding: 14px 15px; gap: 10px; }
    .t-code, .t-code-masked { font-size: 17px; letter-spacing: 0.8px; }
    .btn-take { padding: 10px 20px; font-size: 14.5px; }
  }

  /* ─── OVERLAY / MODAL ─── */
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.28);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; padding: 20px;
    backdrop-filter: blur(12px) saturate(160%);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
    animation: fadeOvr 0.18s ease;
  }
  @keyframes fadeOvr { from{opacity:0;} to{opacity:1;} }

  .modal {
    background: rgba(255,255,255,0.96);
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
    background: var(--green-light);
    border: 1.5px solid var(--green-mid);
    border-radius: var(--r-lg);
    padding: 18px 16px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 22px; font-weight: 700;
    color: var(--green-dark);
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

  /* ─── CODE MANAGER ─── */
  .mgr-section { margin-bottom: 22px; }
  .mgr-head {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; font-weight: 600; color: var(--text-4);
    text-transform: uppercase; letter-spacing: 0.7px;
    padding-bottom: 8px; border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
  }
  .mgr-count {
    background: var(--surface-2); border-radius: 20px;
    padding: 1px 8px; font-size: 11px; color: var(--text-3);
    font-weight: 600;
  }
  .mgr-row { display: flex; gap: 8px; }
  .mgr-row .f-input { flex: 1; }

  /* Drop scheduling */
  .drop-note { font-size: 11.5px; color: var(--text-4); margin-top: 8px; line-height: 1.45; }
  .drop-note.sched { color: #8e34c4; font-weight: 500; }

  .sched-list { border: 1px solid var(--border); border-radius: var(--r-sm); }
  .sched-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-bottom: 1px solid rgba(60,60,67,0.06);
  }
  .sched-item:last-child { border-bottom: none; }
  .sched-main { flex: 1; min-width: 0; }
  .sched-month { font-size: 13px; font-weight: 600; color: var(--text); }
  .sched-meta { font-size: 11px; color: var(--text-4); }

  .exp-box {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 12px; border-radius: var(--r-sm);
    background: var(--surface-2); border: 1px solid var(--border-mid);
  }
  .exp-main { flex: 1; min-width: 140px; }
  .exp-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .exp-meta { font-size: 11px; color: var(--text-4); line-height: 1.45; }
  .btn-exp-clear {
    background: none; border: 1px solid var(--border-mid);
    border-radius: 6px; font-family: var(--font); font-size: 11.5px; font-weight: 600;
    color: var(--text-3); padding: 5px 12px; cursor: pointer;
    transition: all 0.15s; flex-shrink: 0; white-space: nowrap;
  }
  .btn-exp-clear:hover { border-color: var(--red-mid); color: var(--red); background: var(--red-light); }

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
    width: 100%; background: var(--surface-2);
    border: 1.5px solid var(--border-mid);
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
    padding: 9px 12px; border-bottom: 1px solid rgba(60,60,67,0.06);
    gap: 10px; transition: background 0.12s; cursor: pointer;
    user-select: none; -webkit-user-select: none;
  }
  .cl-item:last-child { border-bottom: none; }
  .cl-item:hover { background: var(--surface-2); }
  .cl-item.sel { background: var(--blue-light); }

  .cl-check {
    width: 17px; height: 17px; border-radius: 5px;
    border: 1.5px solid var(--border-mid);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; background: var(--surface);
    transition: all 0.14s var(--ease-spring);
  }
  .cl-item.sel .cl-check { background: var(--blue); border-color: var(--blue); }
  .cl-check-ico { display: none; }
  .cl-item.sel .cl-check-ico { display: block; }

  .cl-name { font-size: 13px; font-weight: 600; color: var(--text); font-family: var(--font-mono); flex: 1; }
  .cl-meta { font-size: 11px; color: var(--text-4); }

  .btn-del {
    background: none; border: 1px solid var(--border);
    border-radius: 6px; font-family: var(--font);
    font-size: 11.5px; color: var(--text-4);
    padding: 3px 9px; cursor: pointer; transition: all 0.15s; flex-shrink: 0;
  }
  .btn-del:hover { border-color: var(--red-mid); color: var(--red); background: var(--red-light); }

  .list-empty { padding: 24px; text-align: center; color: var(--text-4); font-size: 13px; }

  /* Bulk action bar */
  .bulk-bar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 12px;
    background: var(--blue-light); border: 1px solid var(--blue-mid);
    border-radius: var(--r-sm); margin-bottom: 10px; flex-wrap: wrap;
  }
  .bulk-bar-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .bulk-sel-count { font-size: 12.5px; font-weight: 600; color: var(--blue); }
  .btn-sel {
    background: none; border: 1px solid var(--blue-mid);
    border-radius: 6px; font-family: var(--font); font-size: 11.5px;
    font-weight: 500; color: var(--blue); padding: 3px 10px;
    cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  .btn-sel:hover { background: var(--blue-mid); }
  .btn-del-sel {
    background: var(--red); color: #fff; border: none;
    border-radius: 6px; font-family: var(--font); font-size: 11.5px;
    font-weight: 600; padding: 5px 12px; cursor: pointer;
    transition: all 0.15s; flex-shrink: 0; white-space: nowrap;
  }
  .btn-del-sel:hover { background: var(--red-dark); }
  .btn-del-sel:disabled { opacity: 0.35; cursor: default; }

  /* Activity log */
  .act-log { max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-sm); }
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
  .act-dot.schedule { background: #af52de; }
  .act-dot.expire { background: var(--text-4); }
  .act-text { font-size: 12px; color: var(--text-3); flex: 1; line-height: 1.4; }
  .act-text strong { color: var(--text); font-weight: 600; }
  .act-time { font-size: 10.5px; color: var(--text-4); font-family: var(--font-mono); white-space: nowrap; }
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
    background: var(--green-light); border: 1px solid var(--green-mid);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 13px; font-weight: 600; color: var(--green-dark);
    padding: 10px; cursor: pointer; transition: all 0.15s;
  }
  .btn-export-csv:hover { background: var(--green-mid); }
  .btn-export-csv:active { transform: scale(0.98); }

  /* Clear Old Logs button */
  .btn-clear-logs {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
    background: rgba(255, 159, 64, 0.12); border: 1px solid rgba(255, 159, 64, 0.2);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 13px; font-weight: 600; color: #c97a00;
    padding: 10px; cursor: pointer; transition: all 0.15s; margin-top: 8px;
  }
  .btn-clear-logs:hover { background: rgba(255, 159, 64, 0.2); border-color: rgba(255, 159, 64, 0.35); }
  .btn-clear-logs:active { transform: scale(0.98); }

  /* Code reveal screen inside Take modal */
  .reveal-screen {
    display: flex; flex-direction: column; align-items: center;
    gap: 6px; padding: 8px 0 4px;
    animation: modalIn 0.26s var(--ease-spring);
  }
  .reveal-icon { font-size: 32px; margin-bottom: 4px; }
  .reveal-label {
    font-size: 11px; font-weight: 600; color: var(--text-4);
    text-transform: uppercase; letter-spacing: 0.7px;
  }
  .reveal-code {
    font-family: var(--font-mono); font-size: 28px; font-weight: 700;
    color: var(--green-dark); letter-spacing: 2px;
    background: var(--green-light); border: 2px solid var(--green-mid);
    border-radius: var(--r-lg); padding: 18px 28px; margin: 6px 0;
    text-align: center; width: 100%; word-break: break-all;
  }
  .reveal-sub {
    font-size: 13px; color: var(--text-3); margin-bottom: 10px;
  }
  .btn-copy { flex: 1; transition: background 0.15s, color 0.15s; }
  .btn-copy.copied {
    background: var(--green-light); color: var(--green-dark);
    border-color: var(--green-mid);
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
function monthExpiry(month) {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return { text: "", urgent: false };
  const last = new Date(y, m, 0);            // day 0 of next month is the last of this one
  const label = last.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const now = new Date();
  // Only meaningful while `month` is the month we are actually in, which it always is
  // on the render path. Fall back to the plain date otherwise.
  if (monthKeyOf(now) !== month) return { text: `Valid until ${label}`, urgent: false };
  const days = last.getDate() - now.getDate();
  if (days <= 0) return { text: `Expire today (${label})`, urgent: true };
  if (days === 1) return { text: `Expire tomorrow (${label})`, urgent: true };
  return { text: `Expire in ${days} days (${label})`, urgent: days <= 3 };
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

// Write a log entry to Firestore only. onSnapshot keeps local state in sync (Fix #3).
// Module-level because it closes over nothing but `logsRef`: that keeps it out of the
// dependency array of the cleanup effect, which would otherwise re-run on
// every render (it would be a new function identity each time).
// Intentionally swallows errors: audit logging must never block a staff member.
function log(type, text) {
  addDoc(logsRef, { type, text, ts: Date.now() }).catch(() => {});
}

export default function App() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connError, setConnError] = useState(false);
  const [filter, setFilter] = useState("available");
  const [search, setSearch] = useState("");
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

  // Manager state
  const [newCode, setNewCode] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [selectedCodes, setSelectedCodes] = useState(new Set());
  const [bulkDelConfirm, setBulkDelConfirm] = useState(false);

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
      else if (codeManager) { setCodeManager(false); setSelectedCodes(new Set()); }
      else if (releaseConfirm) setReleaseConfirm(null);
      else if (takeModal) { setTakeModal(null); setStaffName(""); setRevealedCode(null); setTakeError(""); setCopied(false); }
      else if (pinModal) { setPinModal(false); setPin(""); setPinError(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropDelConfirm, bulkDelConfirm, codeManager, releaseConfirm, takeModal, pinModal]);

  // Firebase real-time listener: codes (always on)
  useEffect(() => {
    const unsub = onSnapshot(codesRef, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // `|| 0` keeps the comparator consistent if a doc was added outside the app
      // (e.g. via the Firebase console) and has no createdAt. Otherwise NaN makes
      // the sort order implementation-defined.
      data.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      setCodes(data);
      setLoading(false);
      setConnError(false);
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
  useEffect(() => {
    if (loading || connError) return;
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
  }, [codes, loading, connError, nowMonth]);

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
    try {
      // FIX #6: Transaction ensures the code is still available before writing.
      // If two users tap Take at the same time, only one wins and the other sees an error.
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "codes", id);
        const snap = await tx.get(ref);
        if (!snap.exists() || snap.data().status !== STATUS.AVAILABLE) {
          throw new Error("already_taken");
        }
        // FIX #7: serverTimestamp() writes the server's authoritative time, not the client clock
        tx.update(ref, { status: STATUS.TAKEN, takenBy: name, takenAt: serverTimestamp() });
      });
    } catch (err) {
      // Rollback optimistic row and show error. Reveal screen was never shown, so nothing to hide
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
      setTakeBusy(false);
      // Optional chaining: if err were ever null the catch block itself would throw,
      // skipping setTakeBusy(false) and permanently freezing the Confirm button.
      if (err?.message === "already_taken") {
        setTakeError("Sorry, this code was just taken by someone else. Please choose another.");
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

  const releaseCode = async (id) => {
    const code = releaseConfirm?.code;
    const by = releaseConfirm?.takenBy;
    const takenAt = releaseConfirm?.takenAt;
    setOptimistic(p => ({ ...p, [id]: { status: STATUS.AVAILABLE, takenBy: null, takenAt: null } }));
    setReleaseConfirm(null);
    try {
      await updateDoc(doc(db, "codes", id), { status: STATUS.AVAILABLE, takenBy: null, takenAt: null });
      // History is written only AFTER the release is confirmed. Writing it first
      // meant a failed updateDoc left a permanent record of a release that never
      // happened. `codes` is the source of truth, so ordering it this way makes a
      // missing history row the worst case instead of a phantom one.
      if (code) {
        // serverTimestamp() for releasedAt, authoritative server time
        await addDoc(releaseHistRef, {
          code, takenBy: by || "-", takenAt: takenAt || null, releasedAt: serverTimestamp()
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
  // deleteDocsInChunks below) because every caller here works from the live `codes`
  // array, so there's no getDocs round trip to get DocumentReferences from.
  const deleteCodeIds = async (ids) => {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach(id => batch.delete(doc(db, "codes", id)));
      await batch.commit();
    }
  };

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
    if (!confirm("Delete all activity logs and release history older than 30 days? This cannot be undone.")) return;
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

      log("delete", `Cleared ${logCount} old log entry(ies) and ${relCount} old release record(s), older than 30 days`);
      alert(`✓ Deleted ${logCount} old log entries and ${relCount} old release records.`);
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

  // Current month plus the next three, so a drop can be staged well before month end.
  const monthOptions = [0, 1, 2, 3].map(n => shiftMonthKey(nowMonth, n));

  // Merge optimistic
  const merged = liveCodes.map(c => optimistic[c.id] ? { ...c, ...optimistic[c.id], _opt: true } : c);

  const sorted = filter === "all"
    ? [...merged].sort((a, b) => (toMs(b.takenAt) || b.createdAt) - (toMs(a.takenAt) || a.createdAt))
    : merged;

  const filtered = sorted.filter(c => {
    if (filter === "available" && c.status !== STATUS.AVAILABLE) return false;
    if (filter === "taken" && c.status !== STATUS.TAKEN) return false;
    if (search) {
      const q = search.toUpperCase();
      if (!c.code.includes(q) && !(c.takenBy || "").toUpperCase().includes(q)) return false;
    }
    return true;
  });

  // The old three stat cards needed a `taken` count too. The availability hero states
  // it as "N of M available", so the third number was dropped rather than left unused.
  const total = merged.length;
  const avail = merged.filter(c => c.status === STATUS.AVAILABLE).length;

  // Recomputed every render, which is what keeps the countdown honest once the ticker
  // rolls `nowMonth` over at midnight on the 1st.
  const expiry = monthExpiry(nowMonth);

  // Empty-state copy. Month scoping introduces two cases that used to be impossible:
  // this month's drop hasn't been added yet, and everything on file is either staged for
  // a future month or already expired. Telling the two apart matters, because "no codes yet"
  // when 40 codes are sitting ready for next month reads as a bug.
  let emptyIcon = "🔍";
  let emptyTitle = "No results";
  let emptySub = "Try changing your filter or search";
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
  } else if (!search && filter === "available") {
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
                <span className="pill admin">
                  <span className="pill-dot"></span>Admin
                </span>
              )}
              {isAdmin && stagedCodes.length > 0 && (
                <span className="pill sched" title={`${stagedCodes.length} code(s) staged for a future month`}>
                  <span className="pill-dot"></span>{stagedCodes.length} scheduled
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

        <div className="main">

          {/* ── AVAILABILITY ── */}
          <div className="hero">
            <div className={`hero-num${avail === 0 ? " none" : ""}`}>
              {total === 0 ? `No codes for ${monthLabel(nowMonth)}` : `${avail} of ${total} available`}
            </div>
            <div className={`hero-sub${total > 0 && expiry.urgent ? " urgent" : ""}`}>
              {total === 0
                ? (stagedDrops.length
                    ? `${stagedDrops[0][1].length} ready for ${monthLabel(stagedDrops[0][0])}`
                    : "Waiting for this month's codes")
                : expiry.text}
            </div>
          </div>

          {/* ── TOOLBAR ── */}
          <div className="toolbar">
            <div className="seg-ctrl">
              {[{ k: "available", l: "Available" }, { k: "taken", l: "Taken" }, { k: "all", l: "All" }].map(f => (
                <button key={f.k} className={`seg ${filter === f.k ? "active" : ""}`} onClick={() => { setFilter(f.k); }}>{f.l}</button>
              ))}
            </div>
            <div className="search-box">
              <span className="search-ico">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </span>
              <input className="search-inp" type="text" placeholder="Search code or name…" value={search} onChange={e => setSearch(e.target.value)} />
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
                        </div>
                      )}
                      <div className="t-act">
                        {c.status === STATUS.AVAILABLE
                          ? <button className="btn-take" onClick={() => setTakeModal({ id: c.id, code: c.code })}>Take</button>
                          : isAdmin
                            ? <button className="btn-release" onClick={() => setReleaseConfirm({ id: c.id, code: c.code, takenBy: c.takenBy, takenAt: c.takenAt })}>Release</button>
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
          <div className="modal" onClick={e => e.stopPropagation()}>
            {revealedCode ? (
              /* Reveal screen, shown after successful Take (Fix #11) */
              <div className="reveal-screen">
                <div className="reveal-icon">🎉</div>
                <div className="reveal-label">Your Code</div>
                <div className="reveal-code">{revealedCode.code}</div>
                <div className="reveal-sub">Assigned to <strong>{revealedCode.name}</strong>. Screenshot or note this down!</div>
                <div className="m-actions" style={{ width: "100%" }}>
                  <button
                    className={`btn-sec btn-copy${copied ? " copied" : ""}`}
                    onClick={() => copyRevealedCode(revealedCode.code)}
                  >
                    {copied ? "Copied ✓" : "Copy Code"}
                  </button>
                  <button className="btn-pri green" onClick={() => { setTakeModal(null); setRevealedCode(null); setCopied(false); }}>Done</button>
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
            <div className="confirm-chip">
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
        <div className="overlay" onClick={() => { setCodeManager(false); setSelectedCodes(new Set()); }}>
          <div className="modal wide" onClick={e => e.stopPropagation()}>
            <div className="m-head">
              <div className="m-title">Code Manager</div>
              <div className="m-sub">Add, schedule, review, and remove codes.</div>
            </div>

            {/* Drop month, applies to both add forms below */}
            <div className="mgr-section">
              <div className="mgr-head">
                <span>Drop Month</span>
                {dropMonth !== nowMonth && <span className="mgr-count">scheduled</span>}
              </div>
              <select className="f-select" value={dropMonth} onChange={e => setDropMonth(e.target.value)}>
                {monthOptions.map(key => (
                  <option key={key} value={key}>
                    {monthLabel(key)}{key === nowMonth ? " (live now)" : ""}
                  </option>
                ))}
              </select>
              <div className={`drop-note${dropMonth === nowMonth ? "" : " sched"}`}>
                {dropMonth === nowMonth
                  ? "Codes added below go live straight away, alongside the ones already there. Safe to top up as often as you need."
                  : `Codes added below stay hidden from staff until 1 ${monthLabel(dropMonth)}. When that month starts they take over, and this month's codes are removed automatically.`}
              </div>
            </div>

            {/* Single add */}
            <div className="mgr-section">
              <div className="mgr-head"><span>Add Single Code</span></div>
              <div className="mgr-row">
                <input className="f-input" type="text" placeholder="e.g. SB-001"
                  value={newCode} onChange={e => setNewCode(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addCode()} />
                <button className="btn-add" onClick={addCode}>Add</button>
              </div>
            </div>

            {/* Bulk add */}
            <div className="mgr-section">
              <div className="mgr-head"><span>Bulk Add</span></div>
              <textarea className="bulk-ta" placeholder={"SB-001\nSB-002\nSB-003"}
                value={bulkText} onChange={e => setBulkText(e.target.value)} />
              <div className="bulk-hint">One code per line or comma-separated. Duplicates skipped.</div>
              <button className="btn-bulk" disabled={!bulkText.trim()} onClick={addBulk}>Add All Codes</button>
            </div>

            {/* Scheduled drops */}
            {stagedDrops.length > 0 && (
              <div className="mgr-section">
                <div className="mgr-head">
                  <span>Scheduled Drops <span className="mgr-count">{stagedCodes.length}</span></span>
                </div>
                <div className="sched-list">
                  {stagedDrops.map(([key, list]) => (
                    <div key={key} className="sched-item">
                      <span className="bdg sched"><span className="bdg-dot"></span>Staged</span>
                      <div className="sched-main">
                        <div className="sched-month">{monthLabel(key)}</div>
                        <div className="sched-meta">
                          {`${list.length} code(s) · goes live 1 ${monthLabel(key)}, replacing this month's`}
                        </div>
                      </div>
                      <button className="btn-del"
                        onClick={() => setDropDelConfirm({ monthKey: key, ids: list.map(c => c.id) })}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Expired codes awaiting cleanup */}
            {staleCodes.length > 0 && (
              <div className="mgr-section">
                <div className="mgr-head">
                  <span>Expired Codes <span className="mgr-count">{staleCodes.length}</span></span>
                </div>
                <div className="exp-box">
                  <div className="exp-main">
                    <div className="exp-title">{describeDrops(staleCodes)}</div>
                    <div className="exp-meta">
                      {"Their month has passed, so they are already hidden from staff. "}
                      {liveCodes.length === 0
                        ? "They are removed automatically as soon as this month has codes."
                        : "Cleanup runs automatically. Use this if it hasn't caught up."}
                    </div>
                  </div>
                  <button className="btn-exp-clear" onClick={clearStale}>Clear Now</button>
                </div>
              </div>
            )}

            {/* Codes from before drop scheduling existed. Nothing can date them, so they
                stay live until admin says which month they belong to. */}
            {unlabelledCodes.length > 0 && (
              <div className="mgr-section">
                <div className="mgr-head">
                  <span>No Drop Month <span className="mgr-count">{unlabelledCodes.length}</span></span>
                </div>
                <div className="exp-box">
                  <div className="exp-main">
                    <div className="exp-title">{unlabelledCodes.length} code(s) added before scheduling existed</div>
                    <div className="exp-meta">
                      {"Treated as live, and never removed automatically, because there is no record " +
                       "of which month they belong to. If these are this month's codes, assign them " +
                       "so they get cleaned up on their own. If they are leftovers, remove them."}
                    </div>
                  </div>
                  <button className="btn-exp-clear" onClick={labelUnlabelled}>
                    Assign to {monthLabelShort(nowMonth)}
                  </button>
                  <button className="btn-exp-clear" onClick={removeUnlabelled}>Remove</button>
                </div>
              </div>
            )}

            {/* Code list */}
            <div className="mgr-section">
              <div className="mgr-head">
                <span>All Codes <span className="mgr-count">{codes.length}</span></span>
              </div>

              {/* Bulk action bar */}
              <div className="bulk-bar">
                <div className="bulk-bar-left">
                  <span className="bulk-sel-count">{selectedCodes.size} selected</span>
                  <button className="btn-sel" onClick={selAll}>All</button>
                  <button className="btn-sel" onClick={selAvail}>Available</button>
                  <button className="btn-sel" onClick={selTaken}>Taken</button>
                  <button className="btn-sel" onClick={selNone}>Clear</button>
                </div>
                <button className="btn-del-sel" disabled={selectedCodes.size === 0}
                  onClick={() => setBulkDelConfirm(true)}>
                  Delete ({selectedCodes.size})
                </button>
              </div>

              {codes.length === 0
                ? <div className="list-empty">No codes yet.</div>
                : (
                  <div className="code-list">
                    {managerCodes.map(c => {
                      // Bucket comes from the partition rather than comparing months here,
                      // so unlabelled codes are classified the same way everywhere.
                      // Only non-live codes get the extra chip, so the everyday case looks
                      // exactly as it did before.
                      const state = liveIds.has(c.id) ? "" : stagedIds.has(c.id) ? "sched" : "exp";
                      return (
                        <div key={c.id} className={`cl-item ${selectedCodes.has(c.id) ? "sel" : ""}`}
                          onClick={() => toggleSel(c.id)}>
                          <div className="cl-check">
                            <svg className="cl-check-ico" width="10" height="10" viewBox="0 0 10 10" fill="none">
                              <path d="M2 5L4.2 7.5L8 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="cl-name">{c.code}</div>
                            <div className="cl-meta">
                              {c.monthKey ? monthLabelShort(c.monthKey) : "No drop month"}
                              {" · "}
                              {c.status === STATUS.TAKEN ? `Taken by ${c.takenBy || "-"} · ${formatTime(c.takenAt)}` : "Available"}
                            </div>
                          </div>
                          {state && (
                            <span className={`bdg ${state}`}>
                              <span className="bdg-dot"></span>
                              {state === "sched" ? "Staged" : "Old"}
                            </span>
                          )}
                          <span className={`bdg ${c.status === STATUS.AVAILABLE ? "avail" : "taken"}`}>
                            <span className="bdg-dot"></span>
                            {c.status === STATUS.AVAILABLE ? "Free" : "Taken"}
                          </span>
                          <button className="btn-del" onClick={e => { e.stopPropagation(); deleteCode(c.id); }}>Delete</button>
                        </div>
                      );
                    })}
                  </div>
                )
              }
            </div>

            {/* Activity log */}
            <div className="mgr-section" style={{ marginBottom: 16 }}>
              <div className="mgr-head"><span>Activity Log</span></div>
              {actLog.length === 0
                ? <div className="act-empty">No activity yet.</div>
                : (
                  <div className="act-log">
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
            </div>

            {/* Release History */}
            <div className="mgr-section" style={{ marginBottom: 16 }}>
              <div className="mgr-head">
                <span>Release History <span className="mgr-count">{releaseHistory.length}</span></span>
              </div>
              {releaseHistory.length === 0
                ? <div className="act-empty">No releases in the past 30 days.</div>
                : (
                  <div className="act-log">
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
                            </span>
                            <span className="act-time">{formatTimeShort(r.releasedAt)}</span>
                          </div>
                        );
                      })}
                  </div>
                )
              }
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
              onClick={() => { setCodeManager(false); setSelectedCodes(new Set()); }}>
              Close
            </button>
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

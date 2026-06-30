// Version 1.0.3
import { useState, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, limit, where,
  serverTimestamp, runTransaction, getDocs, writeBatch
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

const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN || "782945"; // CHANGE THIS or set VITE_ADMIN_PIN in .env
const STATUS = { AVAILABLE: "available", TAKEN: "taken" };

const styles = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }

  :root {
    --bg: #f2f2f7;
    --surface: #ffffff;
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
    --green-light: rgba(52,199,89,0.12);
    --green-mid: rgba(52,199,89,0.22);
    --red: #ff3b30;
    --red-dark: #c0392b;
    --red-light: rgba(255,59,48,0.1);
    --red-mid: rgba(255,59,48,0.18);
    --orange: #ff9500;
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

  .page { min-height: 100vh; display: flex; flex-direction: column; }

  /* ─── TOPBAR ─── */
  .topbar {
    background: rgba(242,242,247,0.82);
    backdrop-filter: saturate(200%) blur(24px);
    -webkit-backdrop-filter: saturate(200%) blur(24px);
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .topbar-left { display: flex; align-items: center; gap: 10px; }

  .conn-banner {
    background: var(--red-light); color: var(--red); border-bottom: 1px solid var(--red-mid);
    padding: 8px 24px; font-size: 13px; text-align: center;
  }
  .conn-banner button {
    margin-left: 10px; background: none; border: 1px solid var(--red); color: var(--red);
    border-radius: var(--r-xs); padding: 2px 10px; font-size: 12.5px; cursor: pointer;
  }

  .logo-wrap {
    position: relative;
    width: 32px; height: 32px;
    border-radius: var(--r-sm);
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--sh-sm);
    flex-shrink: 0;
    cursor: pointer;
    padding: 0;
    font: inherit;
    transition: transform 0.18s var(--ease-spring), opacity 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .logo-wrap:hover { transform: scale(1.06); }
  .logo-wrap:active { transform: scale(0.93); opacity: 0.8; }

  .logo-img { width: 100%; height: 100%; object-fit: contain; padding: 3px; display: block; }

  .brand { display: flex; flex-direction: column; gap: 0; }
  .brand-name { font-size: 14px; font-weight: 600; color: var(--text); line-height: 1.25; letter-spacing: -0.3px; }
  .brand-sub { font-size: 10.5px; color: var(--text-4); font-weight: 400; letter-spacing: 0.1px; }

  .topbar-right { display: flex; align-items: center; gap: 6px; }

  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    border-radius: 20px; padding: 4px 10px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.2px;
    border: 1px solid transparent;
  }
  .pill-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .pill.live { background: var(--green-light); border-color: var(--green-mid); color: var(--green-dark); }
  .pill.live .pill-dot { background: var(--green); animation: blink 2s infinite; }
  .pill.admin { background: var(--red-light); border-color: var(--red-mid); color: var(--red-dark); }
  .pill.admin .pill-dot { background: var(--red); }
  @keyframes blink { 0%,100%{opacity:1;} 50%{opacity:0.3;} }

  /* ─── MAIN ─── */
  .main { flex: 1; padding: 20px 24px 40px; max-width: 1080px; margin: 0 auto; width: 100%; }

  /* ─── STAT CARDS ─── */
  .stat-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }

  .stat-card {
    background: var(--surface);
    border-radius: var(--r);
    padding: 9px 12px;
    border: 1px solid var(--border);
    box-shadow: var(--sh-sm);
    display: flex; flex-direction: column; gap: 3px;
    transition: box-shadow 0.2s, transform 0.2s;
    position: relative; overflow: hidden;
  }
  .stat-card::before {
    content: "";
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px; border-radius: 2px;
  }
  .stat-card.total::before { background: linear-gradient(90deg, #636366, #aeaeb2); }
  .stat-card.avail::before { background: linear-gradient(90deg, var(--green), #5ec96b); }
  .stat-card.taken::before { background: linear-gradient(90deg, var(--red), #ff6961); }

  .stat-icon {
    width: 22px; height: 22px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px;
  }
  .stat-icon.total { background: var(--surface-2); }
  .stat-icon.avail { background: var(--green-light); }
  .stat-icon.taken { background: var(--red-light); }

  .stat-num {
    font-size: 20px; font-weight: 700; line-height: 1;
    letter-spacing: -1px;
  }
  .stat-num.total { color: var(--text); }
  .stat-num.avail { color: var(--green-dark); }
  .stat-num.taken { color: var(--red); }

  .stat-label { font-size: 10px; font-weight: 500; color: var(--text-4); letter-spacing: 0.1px; }

  /* ─── TOOLBAR ─── */
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 12px; flex-wrap: wrap;
  }

  .seg-ctrl {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 2px; gap: 1px;
    box-shadow: var(--sh-sm);
    flex-shrink: 0;
  }

  .seg {
    background: none; border: none;
    border-radius: 7px;
    font-family: var(--font); font-size: 12.5px; font-weight: 500;
    color: var(--text-3); padding: 5px 14px; cursor: pointer;
    transition: all 0.16s; white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
    position: relative;
  }
  .seg.active {
    background: var(--surface-2);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--sh-sm);
  }
  .seg:not(.active):hover { color: var(--text-2); }

  .search-box {
    flex: 1; min-width: 160px; position: relative;
  }
  .search-ico {
    position: absolute; left: 10px; top: 50%;
    transform: translateY(-50%); color: var(--text-4);
    pointer-events: none; display: flex;
  }
  .search-inp {
    width: 100%; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--r-sm);
    padding: 7px 12px 7px 30px;
    font-family: var(--font); font-size: 13px;
    color: var(--text); outline: none;
    transition: all 0.16s; box-shadow: var(--sh-sm);
    -webkit-appearance: none;
  }
  .search-inp:focus { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-light), var(--sh-sm); }
  .search-inp::placeholder { color: var(--text-4); }

  .btn-mgr {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--text); color: #fff; border: none;
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 12.5px; font-weight: 600; padding: 7px 14px;
    cursor: pointer; transition: all 0.16s; flex-shrink: 0;
    box-shadow: var(--sh-sm); -webkit-tap-highlight-color: transparent;
  }
  .btn-mgr:hover { background: #3a3a3c; box-shadow: var(--sh); }
  .btn-mgr:active { transform: scale(0.97); }

  /* ─── TABLE ─── */
  .card {
    background: var(--surface);
    border-radius: var(--r-xl);
    border: 1px solid var(--border);
    overflow: hidden;
    box-shadow: var(--sh);
  }

  .t-head {
    display: grid;
    grid-template-columns: 40px 1fr 155px 155px 110px;
    padding: 8px 20px;
    background: rgba(116,116,128,0.04);
    border-bottom: 1px solid var(--border);
  }
  .t-h {
    font-size: 10px; font-weight: 600; color: var(--text-4);
    text-transform: uppercase; letter-spacing: 0.8px;
  }

  .t-body { display: flex; flex-direction: column; }

  /* Filter-switch fade wrapper */
  .t-body-inner {
    display: flex; flex-direction: column;
    animation: listFadeIn 0.22s var(--ease-out) both;
  }
  @keyframes listFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .t-row {
    display: grid;
    grid-template-columns: 40px 1fr 155px 155px 110px;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid rgba(60,60,67,0.06);
    transition: background 0.15s;
    animation: rowIn 0.28s var(--ease-out) both;
  }
  @keyframes rowIn {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .t-row:last-child { border-bottom: none; }
  .t-row:hover { background: rgba(116,116,128,0.04); }
  .t-row.is-taken { background: rgba(116,116,128,0.02); }
  .t-row.is-optimistic { opacity: 0.55; pointer-events: none; }

  .t-num { font-size: 11px; color: var(--text-4); font-weight: 500; font-family: var(--font-mono); }
  .t-code {
    font-size: 13.5px; font-weight: 600;
    color: var(--text); letter-spacing: 0.1px;
    font-family: var(--font-mono);
  }
  .t-row.is-taken .t-code { text-decoration: line-through; color: var(--text-4); }
  .t-staff { font-size: 13px; color: var(--text-2); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-time { font-size: 11.5px; color: var(--text-4); font-family: var(--font-mono); }
  .t-act { display: flex; align-items: center; gap: 6px; }

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

  /* Row action buttons */
  .btn-take {
    background: var(--green); color: #fff; border: none;
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 12px; font-weight: 600; padding: 6px 14px;
    cursor: pointer; transition: all 0.16s;
    box-shadow: 0 1px 3px rgba(52,199,89,0.25);
    -webkit-tap-highlight-color: transparent;
  }
  .btn-take:hover { background: #2db44e; box-shadow: 0 3px 10px rgba(52,199,89,0.3); }
  .btn-take:active { transform: scale(0.96); }

  .btn-release {
    background: none; border: 1px solid var(--border-mid);
    border-radius: var(--r-sm); font-family: var(--font);
    font-size: 12px; font-weight: 500; color: var(--text-3);
    padding: 6px 12px; cursor: pointer; transition: all 0.16s;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-release:hover { border-color: var(--red-mid); color: var(--red); background: var(--red-light); }

  .btn-taken-lock {
    font-size: 11.5px; font-weight: 500; color: var(--text-4);
    padding: 6px 10px; border-radius: var(--r-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    display: inline-block; letter-spacing: 0.1px;
  }

  /* Empty / loading states */
  .t-empty {
    padding: 64px 24px; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .t-empty-icon {
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--surface-2);
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; margin-bottom: 2px;
  }
  .t-empty-title { font-size: 14px; font-weight: 600; color: var(--text-3); }
  .t-empty-sub { font-size: 12.5px; color: var(--text-4); }

  .t-loading {
    padding: 64px 24px; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .spinner {
    width: 22px; height: 22px;
    border: 2px solid var(--surface-3);
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .t-loading-text { font-size: 13px; color: var(--text-4); }

  /* ─── MOBILE CARD VIEW ─── */
  @media (max-width: 640px) {
    .main { padding: 14px 14px 32px; }
    .topbar { padding: 0 16px; height: 48px; }
    .brand-sub { display: none; }
    .stat-num { font-size: 18px; letter-spacing: -0.8px; }

    /* Hide table header */
    .t-head { display: none; }

    /* Card layout for each row */
    .t-row {
      display: flex; flex-direction: column;
      gap: 0; padding: 0; align-items: stretch;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      border-radius: 0;
    }
    .t-row:last-child { border-bottom: none; }
    .t-row:hover { background: var(--surface); }

    /* Card inner layout */
    .t-row-mobile-inner {
      display: flex; align-items: center;
      padding: 13px 16px; gap: 12px;
    }

    /* Code pill on mobile */
    .t-num { display: none; }
    .t-code {
      font-size: 15px; font-weight: 700;
      letter-spacing: 0.3px;
    }
    .t-row.is-taken .t-code {
      text-decoration: line-through;
      color: var(--text-4);
    }

    /* Staff + time stacked */
    .t-mobile-info {
      display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0;
    }
    .t-staff {
      font-size: 13px; font-weight: 500; color: var(--text-2);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .t-time { font-size: 11px; color: var(--text-4); }

    /* Hide desktop columns that get restructured */
    .t-desktop-only { display: none; }

    .t-act { margin-top: 0; }

    /* Card wrapper for mobile */
    .card { border-radius: var(--r-lg); }

    /* Toolbar wraps nicely */
    .toolbar { gap: 6px; }
    .search-box { min-width: 0; width: 100%; order: 3; flex-basis: 100%; }
    .btn-mgr { font-size: 12px; padding: 7px 11px; }
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

  /* Masked code in table */
  .t-code-masked {
    font-size: 13.5px; font-weight: 600;
    color: var(--text-4); letter-spacing: 0.1px;
    font-family: var(--font-mono);
  }

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

  /* Mobile info block — hidden on desktop */
  .t-mobile-info { display: none; }
  @media (max-width: 640px) {
    .t-mobile-info { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .t-desktop-only { display: none !important; }
    .t-row {
      display: flex !important;
      flex-direction: row !important;
      align-items: center !important;
      padding: 12px 16px !important;
      gap: 10px !important;
    }
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

function formatTimeShort(ts) {
  const ms = toMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Prevents spreadsheet formula injection when CSV is opened in Excel/Sheets
function csvSafe(v) {
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
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

  // Release history — synced from Firebase (lazy: only when Code Manager is open)
  const [releaseHistory, setReleaseHistory] = useState([]);

  // Activity log — synced from Firebase (lazy: only when Code Manager is open)
  const [actLog, setActLog] = useState([]);

  // Revealed code after successful Take (Fix #11)
  const [revealedCode, setRevealedCode] = useState(null);

  // Copy-to-clipboard feedback on reveal screen (Fix #12)
  const [copied, setCopied] = useState(false);

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
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write blocked (rare) — fail silently, code is still visible on screen
    }
  };

  // Write a log entry to Firestore only — onSnapshot keeps local state in sync (Fix #3)
  const log = (type, text) => {
    addDoc(logsRef, { type, text, ts: Date.now() }).catch(() => {});
  };

  // Escape closes whichever modal is open
  useEffect(() => {
    const onKey = e => {
      if (e.key !== "Escape") return;
      if (bulkDelConfirm) setBulkDelConfirm(false);
      else if (codeManager) { setCodeManager(false); setSelectedCodes(new Set()); }
      else if (releaseConfirm) setReleaseConfirm(null);
      else if (takeModal) { setTakeModal(null); setStaffName(""); setRevealedCode(null); setTakeError(""); setCopied(false); }
      else if (pinModal) { setPinModal(false); setPin(""); setPinError(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bulkDelConfirm, codeManager, releaseConfirm, takeModal, pinModal]);

  // Firebase real-time listener — codes (always on)
  useEffect(() => {
    const unsub = onSnapshot(codesRef, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      data.sort((a, b) => a.createdAt - b.createdAt);
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

  // Firebase real-time listener — activity log (lazy: only when Code Manager open) (Fix #7)
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

  // Firebase real-time listener — release history (lazy: only when Code Manager open) (Fix #7)
  useEffect(() => {
    if (!codeManager) return;
    const cutoff = Date.now() - MONTH_MS;
    const q = query(releaseHistRef, where("releasedAt", ">", cutoff), orderBy("releasedAt", "desc"), limit(200));
    const unsub = onSnapshot(q, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setReleaseHistory(data);
    }, err => console.error("release history listener failed:", err));
    return () => unsub();
  }, [codeManager]);

  // ── Actions ──
  const handlePin = () => {
    if (pin === ADMIN_PIN) { setIsAdmin(true); setPinModal(false); setPin(""); setPinError(""); }
    else { setPinError("Incorrect PIN. Try again."); setPin(""); }
  };

  const addCode = async () => {
    const t = newCode.trim().toUpperCase();
    if (!t || codes.some(c => c.code === t)) { setNewCode(""); return; }
    setNewCode("");
    await addDoc(codesRef, { code: t, status: STATUS.AVAILABLE, takenBy: null, takenAt: null, createdAt: Date.now() });
    log("add", `${t} added`);
  };

  const addBulk = async () => {
    const lines = bulkText.split(/[\n,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    const existing = new Set(codes.map(c => c.code));
    const toAdd = [...new Set(lines)].filter(c => !existing.has(c));
    if (!toAdd.length) { setBulkText(""); return; }
    setBulkText("");
    await Promise.all(toAdd.map((code, i) =>
      addDoc(codesRef, { code, status: STATUS.AVAILABLE, takenBy: null, takenAt: null, createdAt: Date.now() + i })
    ));
    log("bulk", `${toAdd.length} code(s) bulk-added`);
  };

  const takeCode = async (id, name) => {
    const code = takeModal?.code;
    // Optimistic update for instant UI feedback
    setOptimistic(p => ({ ...p, [id]: { status: STATUS.TAKEN, takenBy: name, takenAt: Date.now() } }));
    setStaffName("");
    setTakeError("");
    // Show reveal screen immediately (optimistic)
    setRevealedCode({ code, name });
    try {
      // FIX #6: Transaction ensures the code is still available before writing.
      // If two users tap Take at the same time, only one wins — the other sees an error.
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
      // Rollback: hide reveal screen and show error
      setRevealedCode(null);
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
      if (err.message === "already_taken") {
        setTakeError("Sorry — this code was just taken by someone else. Please choose another.");
      } else {
        setTakeError("Something went wrong. Please try again.");
      }
      return;
    }
    // Clean up optimistic state — onSnapshot will sync the real data
    setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
    log("take", `${name} took ${code}`);
  };

  const releaseCode = async (id) => {
    const code = releaseConfirm?.code;
    const by = releaseConfirm?.takenBy;
    const takenAt = releaseConfirm?.takenAt;
    setOptimistic(p => ({ ...p, [id]: { status: STATUS.AVAILABLE, takenBy: null, takenAt: null } }));
    setReleaseConfirm(null);
    if (code) {
      // FIX #7: serverTimestamp() for releasedAt — authoritative server time
      addDoc(releaseHistRef, {
        code, takenBy: by || "—", takenAt: takenAt || null, releasedAt: serverTimestamp()
      }).catch(() => {});
    }
    try {
      await updateDoc(doc(db, "codes", id), { status: STATUS.AVAILABLE, takenBy: null, takenAt: null });
      log("release", `Released ${code}${by ? ` from ${by}` : ""}`);
    } finally {
      setOptimistic(p => { const n = { ...p }; delete n[id]; return n; });
    }
  };

  const deleteCode = async (id) => {
    const c = codes.find(x => x.id === id);
    setSelectedCodes(p => { const n = new Set(p); n.delete(id); return n; });
    await deleteDoc(doc(db, "codes", id));
    if (c) log("delete", `Deleted ${c.code}`);
  };

  const bulkDelete = async () => {
    const ids = [...selectedCodes];
    const names = codes.filter(c => ids.includes(c.id)).map(c => c.code);
    const preview = names.slice(0, 5).join(", ") + (names.length > 5 ? ` +${names.length - 5} more` : "");
    setSelectedCodes(new Set());
    setBulkDelConfirm(false);
    await Promise.all(ids.map(id => deleteDoc(doc(db, "codes", id))));
    log("bulk", `Deleted ${ids.length} code(s): ${preview}`);
  };

  const toggleSel = id => setSelectedCodes(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selAll = () => setSelectedCodes(new Set(codes.map(c => c.id)));
  const selAvail = () => setSelectedCodes(new Set(codes.filter(c => c.status === STATUS.AVAILABLE).map(c => c.id)));
  const selTaken = () => setSelectedCodes(new Set(codes.filter(c => c.status === STATUS.TAKEN).map(c => c.id)));
  const selNone = () => setSelectedCodes(new Set());

  const clearOldLogs = async () => {
    if (!confirm("Delete all activity logs older than 30 days? This cannot be undone.")) return;
    const cutoff = Date.now() - MONTH_MS;
    try {
      const q = query(logsRef, where("ts", "<", cutoff));
      const snap = await getDocs(q);
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      const count = snap.docs.length;
      log("delete", `Cleared ${count} old log entry(ies) — older than 30 days`);
      alert(`✓ Deleted ${count} old log entries.`);
    } catch (err) {
      console.error("Clear logs failed:", err);
      alert("Failed to clear logs. Try again.");
    }
  };

  const exportCSV = () => {
    const rows = [["Code", "Status", "Taken By", "Taken At", "Released At"]];
    codes.forEach(c => {
      rows.push([
        csvSafe(c.code),
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
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codes-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log("export", `CSV exported — ${codes.length} codes`);
  };

  // Merge optimistic
  const merged = codes.map(c => optimistic[c.id] ? { ...c, ...optimistic[c.id], _opt: true } : c);

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

  const total = merged.length;
  const avail = merged.filter(c => c.status === STATUS.AVAILABLE).length;
  const taken = merged.filter(c => c.status === STATUS.TAKEN).length;

  return (
    <>
      <style>{styles}</style>
      <div className="page">

        {/* ── TOPBAR ── */}
        <nav className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="logo-wrap"
              onClick={() => isAdmin ? setIsAdmin(false) : setPinModal(true)}
              title={isAdmin ? "Exit Admin" : "Admin Login"}
              aria-label={isAdmin ? "Exit Admin" : "Admin Login"}
            >
              <img src="/logo.png" alt="Logo" className="logo-img" />
            </button>
            <div className="brand">
              <span className="brand-name">SB Grab Code Tracker</span>
              <span className="brand-sub">Staff Allocation System</span>
            </div>
          </div>
          <div className="topbar-right">
            <span className="pill live">
              <span className="pill-dot"></span>Live
            </span>
            {isAdmin && (
              <span className="pill admin">
                <span className="pill-dot"></span>Admin
              </span>
            )}
          </div>
        </nav>

        {connError && (
          <div className="conn-banner">
            Connection lost — showing last known data. <button onClick={() => window.location.reload()}>Retry</button>
          </div>
        )}

        <div className="main">

          {/* ── STATS ── */}
          <div className="stat-row">
            <div className="stat-card total">
              <div className="stat-icon total">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <rect x="1" y="1" width="6" height="6" rx="1.5" fill="var(--text-3)"/>
                  <rect x="9" y="1" width="6" height="6" rx="1.5" fill="var(--text-3)"/>
                  <rect x="1" y="9" width="6" height="6" rx="1.5" fill="var(--text-3)"/>
                  <rect x="9" y="9" width="6" height="6" rx="1.5" fill="var(--text-3)"/>
                </svg>
              </div>
              <span className="stat-num total">{total}</span>
              <span className="stat-label">Total Codes</span>
            </div>
            <div className="stat-card avail">
              <div className="stat-icon avail">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6.5" stroke="var(--green-dark)" strokeWidth="1.5"/>
                  <path d="M5 8.5L7 10.5L11 5.5" stroke="var(--green-dark)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="stat-num avail">{avail}</span>
              <span className="stat-label">Available</span>
            </div>
            <div className="stat-card taken">
              <div className="stat-icon taken">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6.5" stroke="var(--red)" strokeWidth="1.5"/>
                  <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="var(--red)" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <span className="stat-num taken">{taken}</span>
              <span className="stat-label">Taken</span>
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

          {/* ── TABLE ── */}
          <div className="card">
            <div className="t-head">
              <span className="t-h">#</span>
              <span className="t-h">Code</span>
              <span className="t-h">Taken By</span>
              <span className="t-h">Taken At</span>
              <span className="t-h">Action</span>
            </div>
            <div className="t-body">
              {loading && (
                <div className="t-loading">
                  <div className="spinner"></div>
                  <span className="t-loading-text">Connecting…</span>
                </div>
              )}
              {!loading && filtered.length === 0 && (
                <div className="t-empty">
                  <div className="t-empty-icon">
                    {filter === "available" ? "✓" : "🔍"}
                  </div>
                  <div className="t-empty-title">
                    {codes.length === 0 ? "No codes yet" : filter === "available" ? "All codes taken" : "No results"}
                  </div>
                  <div className="t-empty-sub">
                    {codes.length === 0 ? "Admin can add codes via Manage Codes" : "Try changing your filter or search"}
                  </div>
                </div>
              )}
              {!loading && filtered.length > 0 && (
                <div className="t-body-inner" key={filter}>
                  {filtered.map((c, i) => (
                    <div key={c.id} className={`t-row ${c.status === STATUS.TAKEN ? "is-taken" : ""} ${c._opt ? "is-optimistic" : ""}`}
                      style={{ animationDelay: `${Math.min(i * 22, 220)}ms` }}>
                      <span className="t-num">{i + 1}</span>
                      {/* Fix #11: Mask available codes — only reveal after Take flow */}
                      {c.status === STATUS.AVAILABLE && !isAdmin
                        ? <span className="t-code-masked">{c.code.slice(0, Math.max(2, c.code.length - 2)).replace(/[A-Z0-9]/g, (ch, idx) => idx < 2 ? ch : "•") + "••"}</span>
                        : <span className="t-code">{c.code}</span>
                      }
                      <span className="t-staff t-desktop-only">{c.takenBy || ""}</span>
                      <span className="t-time t-desktop-only">{c.takenAt ? formatTime(c.takenAt) : ""}</span>
                      <div className="t-mobile-info">
                        <span className="t-staff">{c.takenBy || ""}</span>
                        {c.takenAt && <span className="t-time">{formatTime(c.takenAt)}</span>}
                      </div>
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
              /* Reveal screen — shown after successful Take (Fix #11) */
              <div className="reveal-screen">
                <div className="reveal-icon">🎉</div>
                <div className="reveal-label">Your Code</div>
                <div className="reveal-code">{revealedCode.code}</div>
                <div className="reveal-sub">Assigned to <strong>{revealedCode.name}</strong> — screenshot or note this down!</div>
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
                  onKeyDown={e => e.key === "Enter" && staffName.trim() && takeCode(takeModal.id, staffName.trim())}
                  autoFocus />
                {takeError && (
                  <div className="take-error">{takeError}</div>
                )}
                <div className="m-actions">
                  <button className="btn-sec" onClick={() => { setTakeModal(null); setStaffName(""); setTakeError(""); }}>Cancel</button>
                  <button className="btn-pri green" disabled={!staffName.trim()}
                    onClick={() => staffName.trim() && takeCode(takeModal.id, staffName.trim())}>
                    Confirm & Reveal
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
              <div className="m-sub">Add, review, and remove codes.</div>
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
                    {codes.map(c => (
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
                            {c.status === STATUS.TAKEN ? `Taken by ${c.takenBy} · ${formatTime(c.takenAt)}` : "Available"}
                          </div>
                        </div>
                        <span className={`bdg ${c.status === STATUS.AVAILABLE ? "avail" : "taken"}`}>
                          <span className="bdg-dot"></span>
                          {c.status === STATUS.AVAILABLE ? "Free" : "Taken"}
                        </span>
                        <button className="btn-del" onClick={e => { e.stopPropagation(); deleteCode(c.id); }}>Delete</button>
                      </div>
                    ))}
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
                              <strong>{r.code}</strong> — held by <strong>{r.takenBy}</strong>
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
      <Analytics />
    </>
  );
}

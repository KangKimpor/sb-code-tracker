---
name: sb-grab-code-tracker
description: >
  Expert skill for the SB Grab Code Tracker app built for Singbuild Construction Co. Ltd.
  Use whenever Por asks about the code tracker app, adds features, fixes bugs, changes the
  design or header, updates Firebase logic or rules, deploys, or works on the Telegram bot.
  Also triggers for: grab code, SB tracker, Singbuild app, SingBuildBot, Telegram mini app,
  monthKey, drop month, staged drop, expired codes, top-up request, low stock alert, admin
  PIN, take/release flow, instant reveal, pull to refresh, Pchum Ben banner, Code Manager,
  codeInventory, Cloud Functions, secured rollout, SECURITY_BACKEND_READY, Firebase Hosting,
  Vercel deploy, Firestore gotchas, or the React + Firebase stack for this project. Gives full
  context on what is LIVE versus only STAGED in the repo, the data model, month scoping,
  gotchas, the design system, and the deployment workflow, so no re-explaining is needed.
---

# SB Grab Code Tracker: Expert Skill
**Version 4.0.0**, updated October 15, 2026

> **v4.0.0 note:** v3.0.0 (July 31) predates the October security work, the Telegram bot, the
> dual hosting setup, and a long run of UI changes. The facts below were read out of the repo at
> commit `c50a1af` ("Animation remove") and re-checked against `9d11a3d` (dual-deploy settings). Where this conflicts with v3.0.0, this file is correct.
> **The single most important change: the repo now contains two different backends, and only
> one of them is live.** Read "Live versus staged" before touching rules, auth, or deploys.

## What This App Is

Internal tool for Singbuild staff to claim Grab promo codes from a shared monthly pool. The
company receives roughly 40 codes a month for around 30 staff. A staff member opens the page
(in a browser, as an installed PWA, or from Telegram), taps Take, types a first name, and gets
one code revealed to them; it becomes unavailable to everyone else. Admin adds codes, schedules
next month's batch, and reviews activity. The same Firestore data is also driven by
**@SingBuildBot** on Telegram.

**The rule that shapes everything: a Grab code only works during the calendar month it was
issued for.** That fact drives the `monthKey` field, the staged/live/expired partition, the
expiry countdown, and most of the empty-state copy. Read `references/month-scoping.md` before
touching any of it.

## Live versus staged

This is the first thing to establish in any conversation about backend, rules, or security.

| | **LIVE (what staff use today)** | **STAGED (in the repo, not live)** |
|---|---|---|
| Frontend | The "compatibility client" in `src/App.jsx`: talks to Firestore directly, anonymous | The secured frontend, recoverable from commit `5214624` |
| Admin | Client-side PIN (`VITE_ADMIN_PIN`, fallback `782945`), plain React state | Server-checked PIN in Secret Manager, one-hour custom-token admin session |
| Rules | **Not the repo's `firestore.rules`.** Whatever is published in the Firebase console, unverifiable from the repo | `firestore.rules` as committed: denies every browser write |
| Writes | Browser writes `codes`, `activityLog`, `releaseHistory`, `topupRequests` directly | Only the `tracker` Cloud Function writes, with server-built audit rows |
| Expiry | Hidden on the render path, deleted only by the admin's manual Clear Now | `expireMonthlyCodes` scheduled function, daily 00:05 Asia/Phnom_Penh |
| Voucher secrecy | None: whole `codes` collection is downloaded by every client | `codeInventory` (sanitised, public) vs `codes` (admin only) |

Why it is split: on 2026-10-09 Vercel auto-deployed the secured frontend while the live rules
were still the old ones and the Cloud Functions API was disabled. Every read failed with
`Missing or insufficient permissions` and the app displayed an empty October drop. The fix
restored a client compatible with the live rules and left the secured backend dormant. Full
story in `docs/connection-recovery.md`; the rollout plan is `docs/security-rollout.md`.

**Consequences you must honour:**

- **Never deploy the repo's `firestore.rules` while the compatibility client is serving staff.**
  Those rules deny all browser writes, so claiming would stop working immediately.
- **Never restore the secured `App.jsx`, or set `SECURITY_BACKEND_READY=true`, as a drive-by.**
  It is a coordinated maintenance window: functions, rules, inventory migration, then hosting.
- `npm run build` runs `scripts/check-backend-readiness.js`, which fails the build if
  `src/App.jsx` imports `firebase/functions` while `SECURITY_BACKEND_READY` is not `true`.
  That guard exists so Vercel cannot publish a server-dependent frontend early.

Details of both halves are in `references/backend-and-bot.md`.

| | |
|---|---|
| Stack | React 18, Vite 8, Firebase JS SDK 12 (modular, Firestore only in the client), `@vercel/analytics` |
| Backend (staged) | Firebase Cloud Functions v2 on Node 22 (`functions/`), `firebase-admin` |
| Bot | Python, `telegram_bot/`, Render blueprint `render.yaml`, uses the Admin SDK |
| Auth | **None in the live client.** All Firestore access is anonymous |
| Hosts | **Two, both deploy on every push to `master`:** Vercel and Firebase Hosting |
| Live URLs | https://sb-code-tracker.vercel.app, https://sb-code-tracker.web.app, and the custom domain https://sbgrabcode.mine.bz (served by Firebase Hosting) |
| Config | Firebase credentials and PIN via `.env` and host env vars, never hardcoded (the PIN has a hardcoded fallback, see Known Risks) |
| Node | `^20.19.0 || >=22.12.0` |

### File layout

`src/App.jsx` is still a **single component, now 3113 lines**:

| Lines (approx.) | Contents |
|---|---|
| 1 to 73 | imports, Firebase init, collection refs, constants |
| 75 to 1285 | one **~1,210-line CSS template literal**, injected via `<style>{styles}</style>` |
| 1287 to 1495 | module-level helpers (see below) |
| about 1496 onward | the `App` component: state, effects, actions, derived values, JSX |

Four small modules were extracted from `App.jsx`, each with a `node --test` file:

| File | Exports | Notes |
|---|---|---|
| `src/security.js` | `toMs`, `csvSafe` | Timestamp normalising, CSV formula neutralising (whitespace/control prefixes too) |
| `src/claimCode.js` | `claimCode` | The single-write claim. No test file |
| `src/codeLoadState.js` | `unavailableInventory` | "Loading codes" versus "Could not load codes", so a failed load never reads as "empty month" |
| `src/deviceNames.js` | `suggestDeviceName` | Prefills the staff name. Contains a hardcoded `KNOWN_NAMES` map of device-ID suffixes to staff names |

Other entry points: `src/main.jsx` (iOS pinch-gesture blocking, `--vv-h`/`--vv-top` visual
viewport variables for the keyboard, Telegram WebApp setup), `index.html` (startup splash,
Telegram SDK `<script id="telegram-sdk">`, preloads, PWA meta and manifest, icon cache-busters
`?v=singbuild-20261013`), `src/index.css` (leftover Vite template CSS, see Design Decisions).

Module-level helpers still in `App.jsx`, in source order: `formatTime`, `formatTimeShort`, the
month-scoping block (`monthKeyOf`, `currentMonthKey`, `shiftMonthKey`, `monthLabel`,
`monthLabelShort`, `partitionCodes`, `monthExpiry`, `maskCode`, `describeDrops`,
`groupByMonth`), the device-local block (`readLocal`, `writeLocal`, `getDeviceId`,
`readLastRequest`), `log`, `codesFromSnapshot`. (`toMs` and `csvSafe` now live in
`security.js`.)

Constants: `MONTH_MS`, `REQUEST_COOLDOWN_MS`, `LOW_STOCK_THRESHOLD`, `STAGE_REMINDER_DAYS`,
`LS_DEVICE`, `LS_REQUEST`, `LS_STAFF_NAME`, `ADMIN_PIN`, `STATUS`.

Other top-level folders: `functions/` (staged backend plus its tests and `migrate.js`),
`telegram_bot/`, `scripts/` (build guard), `docs/`, `.github/workflows/deploy-firebase.yml`,
`AGENTS.md` (deploy policy: every update ships to both hosts, see rule of thumb 4),
`.kiro/steering/sb-code-tracker.md` (**an old parallel doc, now badly stale: it still says Vite 5,
no auth, ~2390 lines. This skill is authoritative; do not trust it over this file**).

`log` and the month helpers are module-level on purpose: they close over nothing but a
collection ref. **Never call `localStorage` directly. Go through `readLocal`/`writeLocal`,** which
wrap it in try/catch (it throws in Safari private browsing, with cookies blocked, and when
quota is exhausted).

Because CSS is over a third of the file, **grep for symbols rather than trusting line numbers.**
They shift on every change. Several code comments still mention a "cleanup sweep" effect that no
longer exists (see `references/month-scoping.md`); the comments are stale, not the behaviour.

There are **no props anywhere** (one component, no children) and **no
`useMemo`/`useCallback`/`React.memo`**. Both are deliberate.

### Two GitHub accounts push to this repo

`KangKimpor` (owner) and `kimporprg` (collaborator). Either can push directly to `master`, and
`master` pushes deploy to production on **both hosts**.

- Push rejected with `403`: check `git remote -v` first. A clone from the wrong account's fork URL
  fails with "repository not found", not a permissions error. Fix with
  `git remote set-url origin https://github.com/KangKimpor/sb-code-tracker.git`.
- Push rejected as `non-fast-forward`: run `git pull --no-rebase` first. It may open Vim for a
  merge commit; save and exit with `Esc`, `:wq`, `Enter`. Then push again.

---

## Data Model

**Four collections touched by the live client.** Field types are load-bearing: get them wrong and
queries silently return nothing (Firestore gotcha #1).

| Collection | Field | Type written | Written by |
|---|---|---|---|
| `codes` | `code` | string | `addCode`, `addBulk` |
| | `status` | string `"available"` / `"taken"` | |
| | `takenBy` | string \| null | |
| | `takenAt` | **Timestamp** (`serverTimestamp()`) \| null | `claimCode` |
| | `takenDevice` | string (browser device id, or `"telegram:<numeric id>"` from the bot) | `claimCode`, bot |
| | `createdAt` | **number** (`Date.now()`) | |
| | `monthKey` | **string** `"YYYY-MM"`, absent on codes predating the field | |
| `activityLog` | `type`, `text` | string | `log()` |
| | `ts` | **number** (`Date.now()`) | |
| | `deviceId` | string, added by `log()` | |
| `releaseHistory` | `code`, `takenBy` | string | `releaseCode` |
| | `takenAt` | Timestamp \| null (copied from the code doc) | |
| | `releasedAt` | **Timestamp** (`serverTimestamp()`) | |
| `topupRequests` | `monthKey` | **string** `"YYYY-MM"` | `requestTopup` |
| | `ts` | **number** (`Date.now()`) | |
| | `deviceId` | string (random, from `localStorage`) | |

**Staged or bot-only collections** (the live client never touches them): `codeInventory`
(sanitised public mirror: `code` is replaced by `Code <last 6 of id>`), `_rateLimits`,
`_requestCooldowns`, `_telegramOperations` (bot retry receipts, which can contain claimed
vouchers and must stay server-only).

**Deliberate inconsistency:** `createdAt` and `ts` are plain numbers, `takenAt` and `releasedAt`
are Firestore Timestamps. `toMs()` normalises both on read. **When querying, the comparison bound
must match the stored type.**

```json
// codes document shape (live client)
{
  "id": "auto-generated",
  "code": "SB-001",
  "status": "available" | "taken",
  "takenBy": "Sothea" | null,
  "takenAt": Timestamp | null,
  "takenDevice": "<device id>" | null,
  "createdAt": 1714000000000,
  "monthKey": "2026-10"
}
```

**What the live rules permit cannot be read from this repo.** The committed `firestore.rules` is
the staged secured set. The legacy rules are in git history (`git show bbdd9da:firestore.rules`),
but they whitelist only six `codes` fields and three `activityLog` fields, while the client now
also writes `takenDevice` and `deviceId`. So the live rules were edited after that commit, and
nobody can say exactly how from source. Probe, do not assume (`references/operations.md`).
If activity entries stopped appearing around the time `deviceId` was added, a stale field
whitelist is the first suspect, because `log()` swallows its own errors by design.

---

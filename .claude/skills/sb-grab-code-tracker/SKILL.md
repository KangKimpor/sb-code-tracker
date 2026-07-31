---
name: sb-grab-code-tracker
description: >
  Expert skill for the SB Grab Code Tracker app built for Singbuild Construction Co. Ltd.
  Use this skill whenever Por asks about the code tracker app, wants to add features, fix bugs,
  change the design, update Firebase logic, publish Firestore rules, or deploy changes. Also
  triggers for: code tracker, grab code, SB tracker, Singbuild app, drop month, monthKey, staged
  drop, scheduled drop, expired codes, cleanup sweep, top-up request, low stock alert, admin PIN,
  take/release flow, code masking, reveal screen, Code Manager, activity log, release history,
  env variables, Firestore gotchas, or anything referencing the React + Firebase + Vercel stack
  for this project. Gives Claude full context of the codebase architecture, data model, month
  scoping rules, hard-won Firestore/browser/CSS gotchas, design system, and deployment workflow
  so no re-explaining is needed.
---

# SB Grab Code Tracker: Expert Skill
**Version 3.0.0**, updated July 31, 2026

> **v3.0.0 note:** v2.0.0 predates the four largest changes to this app: month-scoped drop
> scheduling, the mobile-first staff redesign, real Firestore rules being written and
> published, and the top-up request and admin alert features. Every fact below was read out
> of the current source rather than carried forward. Where this conflicts with v2.0.0, this
> file is correct. Notably v2.0.0's design token list, line counts, collection count,
> listener count and `index.css` claims are all now wrong.

## What This App Is

Internal tool for Singbuild staff to claim Grab promo codes from a shared monthly pool. The
company receives roughly 40 codes a month for around 30 staff. A staff member opens the page,
taps Take, types a first name, and gets one code revealed to them; it becomes unavailable to
everyone else instantly. Admin adds codes, schedules next month's batch, and reviews activity.

**The rule that shapes everything: a Grab code only works during the calendar month it was
issued for.** That single fact drives the `monthKey` field, the staged/live/expired
partitioning, the automatic cleanup, the expiry countdown, and most of the empty-state copy.
Read `references/month-scoping.md` before touching any of it.

| | |
|---|---|
| Stack | React 18, Vite, Firebase JS SDK (modular, Firestore only), `@vercel/analytics` |
| Auth | **None.** All Firestore access is anonymous. See Known Risks. |
| Deploy | Vercel, auto-deploys on merge to `master`. PRs get preview URLs. |
| Bundle | ~471 kB / ~142 kB gzip, dominated by `firebase/firestore` |
| Config | Firebase credentials and admin PIN via `.env` and Vercel env vars, never hardcoded |
| Live | https://sb-code-tracker.vercel.app |

### File layout

Tracked source files: `src/App.jsx`, `src/main.jsx`, `src/index.css`, `index.html`,
`vite.config.js`, `eslint.config.js`, `firestore.rules`, `public/{logo.png,favicon.svg,icons.svg}`,
`docs/stitch-ui-prompts.md`, `.kiro/steering/sb-code-tracker.md`.

`src/App.jsx` is a **single component, 2526 lines**:

| Lines | Contents |
|---|---|
| 1 to 61 | imports, Firebase init, collection refs, constants |
| 63 to 873 | one **810-line CSS template literal**, injected via `<style>{styles}</style>` |
| 876 to 1088 | module-level helpers (see below) |
| 1090 onward | the `App` component: state, effects, actions, derived values, JSX |

Constants: `MONTH_MS`, `REQUEST_COOLDOWN_MS`, `LOW_STOCK_THRESHOLD`, `STAGE_REMINDER_DAYS`,
`LS_DEVICE`, `LS_REQUEST`, `ADMIN_PIN`, `STATUS`.

Module-level helpers, in source order: `toMs`, `formatTime`, `formatTimeShort`, `csvSafe`,
then the month-scoping block (`monthKeyOf`, `currentMonthKey`, `shiftMonthKey`, `monthLabel`,
`monthLabelShort`, `partitionCodes`, `monthExpiry`, `maskCode`, `describeDrops`,
`groupByMonth`), then the device-local block (`readLocal`, `writeLocal`, `getDeviceId`,
`readLastRequest`), then `log`.

`log` and the month helpers are module-level on purpose: they close over nothing but a
collection ref, which keeps them out of the cleanup effect's dependency array. An
in-component arrow is a new identity every render, so the effect would re-run constantly.

**Never call `localStorage` directly. Go through `readLocal`/`writeLocal`,** which wrap it in
try/catch. It throws rather than returning null in Safari private browsing, with cookies
blocked, and when quota is exhausted, and none of that may stop a staff member using the tool.

Because CSS is nearly a third of the file, **grep for symbols rather than trusting line
numbers.** They shift on every change.

There are **no props anywhere** (one component, no children) and **no
`useMemo`/`useCallback`/`React.memo`**. Both are deliberate. See Known Design Decisions.

### Two GitHub accounts push to this repo

`KangKimpor` (owner) and `kimporprg` (collaborator). Either can push directly to `master`.

- Push rejected with `403`: check `git remote -v` first. A clone made from the wrong account's
  fork URL (e.g. `kimporprg/sb-code-tracker`, which does not exist) fails with "repository not
  found", not a permissions error. Fix with
  `git remote set-url origin https://github.com/KangKimpor/sb-code-tracker.git`.
- Push rejected as `non-fast-forward`: run `git pull --no-rebase` first. It may open Vim for a
  merge commit; save and exit with `Esc` then `:wq` then `Enter`. Then push again.

---

## Data Model

**Four collections.** Field types are load-bearing: get them wrong and queries silently
return nothing (Firestore gotcha #1).

| Collection | Field | Type written | Written by |
|---|---|---|---|
| `codes` | `code` | string | `addCode`, `addBulk` |
| | `status` | string `"available"` / `"taken"` | |
| | `takenBy` | string \| null | |
| | `takenAt` | **Timestamp** (`serverTimestamp()`) \| null | `takeCode` |
| | `createdAt` | **number** (`Date.now()`) | |
| | `monthKey` | **string** `"YYYY-MM"`, absent on codes predating the field | `addCode`, `addBulk` |
| `activityLog` | `type`, `text` | string | `log()` |
| | `ts` | **number** (`Date.now()`) | |
| `releaseHistory` | `code`, `takenBy` | string | `releaseCode` |
| | `takenAt` | Timestamp \| null (copied from the code doc) | |
| | `releasedAt` | **Timestamp** (`serverTimestamp()`) | |
| `topupRequests` | `monthKey` | **string** `"YYYY-MM"` | `requestTopup` |
| | `ts` | **number** (`Date.now()`) | |
| | `deviceId` | string (random, from `localStorage`) | |

**Deliberate inconsistency:** `createdAt` and `ts` are plain numbers, `takenAt` and
`releasedAt` are Firestore Timestamps. `toMs()` normalises both on read. **When querying, the
comparison bound must match the stored type.**

```json
// codes document shape
{
  "id": "auto-generated",
  "code": "SB-001",
  "status": "available" | "taken",
  "takenBy": "Sothea" | null,
  "takenAt": Timestamp | null,
  "createdAt": 1714000000000,
  "monthKey": "2026-08"
}
```

`firestore.rules` is written, committed, and published. It permits exactly three `codes`
transitions: CLAIM (available to taken), RELEASE (taken to available), and LABEL (set
`monthKey` on a doc that has none). `code` and `createdAt` are immutable.

---

## Reference Files

Load these on demand. Do not guess at their contents.

| File | Read it when |
|---|---|
| `references/month-scoping.md` | Touching `monthKey`, drop scheduling, the cleanup sweep, expiry, or any empty state. **The most dangerous subsystem in the app: it deletes documents.** |
| `references/audit-notes.md` | Writing or debugging any Firestore query or rules change, any clipboard/CSV/download code, or checking whether a change follows existing conventions. |
| `references/ui-notes.md` | Any design or CSS change. Contains the two traps that have each caused a real outage or silent dead code. |
| `references/operations.md` | Deploying, publishing rules, verifying what production actually serves, or running the manual test checklists. |

Three rules of thumb worth remembering without opening anything:

1. **If a field is written with `serverTimestamp()`, every query bound against it must be a
   `Timestamp`.** Comparing to a plain number returns zero results with no error. This is how
   Release History shipped permanently empty.
2. **Never put a backtick or `${` inside the `styles` literal, not even in a comment.** It
   closes the template literal, stays valid JavaScript, passes eslint and the build, and takes
   production down as a blank page.
3. **Publishing `firestore.rules` is a separate manual step from deploying code.** Merging does
   nothing to the live rules. Publish rules first.

---

## Architecture Overview

```
App.jsx (single component)
├── CSS-in-JS styles (810 lines, CSS variables in :root)
├── Module helpers: toMs, formatTime, formatTimeShort, csvSafe,
│                   month scoping (10 fns), device-local (4 fns), log
├── State
│   ├── codes, loading, connError      : main data, plus retry banner
│   ├── optimistic                    : pending row updates before server confirms
│   ├── filter, search                : staff list controls
│   ├── isAdmin, pinModal, pin, pinError
│   ├── takeModal, staffName, takeError, takeBusy, revealedCode, copied
│   ├── releaseConfirm, codeManager, bulkDelConfirm, dropDelConfirm
│   ├── newCode, bulkText, selectedCodes  : manager forms
│   ├── nowMonth, dropMonth           : month scoping (see reference)
│   ├── sweep (ref)                   : cleanup guard, busy + failedMonth
│   ├── actLog, releaseHistory        : lazy, admin-only
│   └── topupRequests, lastRequest, requestBusy  : top-up signal
├── Effects
│   ├── onSnapshot codes              : always on, error sets connError
│   ├── onSnapshot activityLog        : lazy, only while Code Manager open
│   ├── onSnapshot releaseHistory     : lazy, only while Code Manager open
│   ├── onSnapshot topupRequests      : gated on isAdmin, NOT on Code Manager
│   ├── month ticker (60s)            : notices a month boundary on a long-open tab
│   ├── dropMonth clamp               : never points at a past month
│   ├── cleanup sweep                 : deletes expired codes (see reference)
│   └── Escape keydown                : closes whichever modal is open, in priority order
├── Actions: handlePin, addCode, addBulk, takeCode, requestTopup, clearTopupRequests,
│            releaseCode, deleteCode, deleteIdsIn, deleteCodeIds, bulkDelete, clearStale,
│            labelUnlabelled, removeUnlabelled, deleteDrop, selection helpers,
│            deleteDocsInChunks, clearOldLogs, exportCSV, copyRevealedCode
├── Derived: partitionCodes -> live/staged/stale/unlabelled, stagedDrops, managerCodes,
│            merged + sorted + filtered, total/avail, expiry, monthRequests/waitingCount,
│            requestSent/canRequestTopup, adminAlerts
└── JSX: staff screen + 6 modals + <Analytics />
```

**Four listeners, all with `return () => unsub()` cleanup.** Keep the lazy pattern
(`if (!codeManager) return;`) on the log and history listeners: it exists to conserve
free-tier quota. Only the `codes` listener sets `connError`; the others log to console.

`topupRequests` is gated differently on purpose: the whole point is a badge visible on the
main screen without opening anything, so it cannot wait for Code Manager. Staff never
subscribe to it, they only write. Its query is range-filtered on `ts` and ordered by the same
field, exactly like `activityLog`, so it needs **no composite index**. Adding
`where("monthKey", "==", ...)` next to `orderBy("ts")` would require one, and index deployment
here is a manual console step, so that would break on first run rather than locally.

**Optimistic UI:** on take/release the row flips immediately via `optimistic`, keyed by code
id, cleared once the server confirms. **The reveal screen deliberately waits for server
confirmation** so a loser in a race never sees "Your Code".

**Admin alerts** are built into an `adminAlerts` array in the derived section: `low` (3 or
fewer available), `out` (zero available), both gated on `total > 0`, and `unstaged` (last 7
days of the month with nothing staged for next month). Each button opens Code Manager with
`dropMonth` pre-set to the month that alert is about, which is error prevention rather than a
shortcut. There is no dismiss button: each alert clears when the thing it asks for is done.

**Top-up requests** let a staff member report an empty pool in one tap. Counted by a random
`localStorage` device id so admin sees people rather than taps. The six hour cooldown is
device-local and cannot be otherwise without auth.

---

## Design System

Apple-style light theme, mobile first. **Use these tokens, never hardcoded colours.**
Verbatim from the current `:root`:

```css
--bg: #eeeef2;              --surface: #ffffff;
--track: #e4e4e9;           /* segmented control + search field */
--surface-raised: rgba(255,255,255,0.9);
--surface-2: rgba(116,116,128,0.08);   --surface-3: rgba(116,116,128,0.12);
--border: rgba(60,60,67,0.1);          --border-mid: rgba(60,60,67,0.15);
--text: #1c1c1e;  --text-2: #3a3a3c;  --text-3: #636366;  --text-4: #aeaeb2;
--blue: #007aff;  --blue-light: rgba(0,122,255,0.1);  --blue-mid: rgba(0,122,255,0.18);
--green: #34c759; --green-dark: #248a3d;
--green-strong: #1ea94d;    /* hero figure: passes 3:1 at large sizes */
--green-light: rgba(52,199,89,0.12);   --green-mid: rgba(52,199,89,0.22);
--red: #ff3b30;   --red-dark: #c0392b; --red-light: rgba(255,59,48,0.1);
--red-mid: rgba(255,59,48,0.18);
--orange: #ff9500; --orange-dark: #b26a00; --orange-light: rgba(255,149,0,0.1);
--r-xs: 8px; --r-sm: 10px; --r: 13px; --r-lg: 16px; --r-xl: 20px; --r-2xl: 26px;
--sh-sm / --sh / --sh-lg / --sh-xl
--font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', ...
--font-mono: ui-monospace, 'SF Mono', 'Fira Code', monospace
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
```

**Layout:** one centred column, `max-width: 560px`, mobile first, with a `420px` breakpoint
for small phones. There is no separate desktop table any more: it is the same card layout at
every width. The primary action colour is blue, so `.btn-take` is blue rather than green.
Monospace is only ever used for code values.

More detail, plus the two CSS traps, in `references/ui-notes.md`.

---

## Features Reference

| Feature | Notes |
|---|---|
| Real-time code list | `onSnapshot`, whole collection, sorted by `createdAt` |
| **Month scoping** | Only the current month's codes reach the list. Staged and expired are filtered out on the render path |
| **Availability hero** | "N of M available" plus an expiry countdown, urgent at 3 days or less |
| Filter tabs | Available / Taken / All, uses `filter` as React key for animation |
| Search | By code or staff name. Does not apply to the manager's All Codes list |
| **Code masking** | Available codes masked for non-admins; prefix plus bullets, capped at half the string |
| **Take flow** | Modal, name, Confirm and Reveal. `runTransaction` so only one of two simultaneous tappers wins |
| **Reveal screen** | Code as hero: solid green block, white monospace, `.reveal-modal` for rounder card. Copy Code plus Done |
| Copy to clipboard | Clipboard API with `execCommand` fallback, "Copied ✓" for 1.5s |
| Release flow | Admin only, confirmation modal showing current holder, writes `releaseHistory` |
| **Top-up request** | Staff tap "Tell admin we're out" when nothing is claimable. Admin sees an "N waiting" pill and a manager section |
| **Admin alerts** | Low stock, all claimed, and nothing staged for next month. Buttons pre-set Drop Month |
| Admin PIN | `VITE_ADMIN_PIN`, falls back to `782945`. Not a security boundary |
| Code Manager | Wide modal: Top-up Requests, Drop Month, Add Single, Bulk Add, Scheduled Drops, Expired Codes, No Drop Month, All Codes, Activity Log, Release History, Export CSV, Clear Old Logs |
| **Drop Month picker** | Current month plus next three. Choosing a future month stages a hidden drop |
| **Scheduled Drops** | Staged batches grouped by month with a per-drop delete |
| **Expired / No Drop Month** | Notices with Clear Now, and Assign to month / Remove |
| Bulk add | One per line or comma-separated. Dedupes within the paste and against the target month only |
| Bulk delete | Click rows to select, All/Available/Taken/Clear shortcuts, confirm modal listing every code |
| Activity log | 200 entries, 30 day window, colour-coded dots, lazy, admin only. Types: `take`, `release`, `add`, `bulk`, `delete`, `export`, `schedule`, `expire`, `request` |
| Release history | Lazy, admin only, shows hold duration ("held 3h 12m") |
| Clear Old Logs | Prunes `activityLog`, `releaseHistory` **and** `topupRequests` older than 30 days |
| CSV export | All codes including staged, with drop month and bucket. Formula-injection hardened by `csvSafe`, UTF-8 BOM |
| Connection error | `connError` banner keeps last-known data visible instead of hanging on "Connecting..." |
| Escape key | Closes whichever modal is open, in stacking priority order |
| Vercel Analytics | `<Analytics />` at the JSX root, passive page views only |

---

## Known Risks

Real, and not safe to fix blind. Do not silently "fix" these without Por's go-ahead and the
right environment.

1. **Admin is not a security boundary.** The PIN is inlined into the public bundle and
   `isAdmin` is plain React state, flippable in DevTools. Consequently `allow delete: if true`
   on `codes` is unavoidable: **anyone can delete every code.** Closing this needs Firebase
   Auth plus custom claims, and a staging Firebase project before touching production rules.
2. **Unclaimed code values are readable.** The listener downloads the whole collection, so
   masking is cosmetic. **This extends to staged drops:** next month's codes are hidden from
   the UI, not from the network, and can be read in DevTools before their month starts. Real
   protection needs the value in a separate rules-gated doc, or a Cloud Function that returns
   it on successful claim.
3. **Deployed rules cannot be verified from the repo.** `firestore.rules` is the intended
   state; the live rules are whatever is in the Firebase console. `references/operations.md`
   has a read-only probe that detects drift.
4. **`topupRequests` writes are unauthenticated and unthrottled.** Rules cannot identify a
   device, so the cooldown is client-side only. Contained on purpose: write-only for staff,
   nothing sensitive, feeds one advisory number, pruned by Clear Old Logs. Re-check if
   anything ever starts acting on that count automatically.
5. **High-severity transitive dependency vulnerabilities** via `firebase@10.14.1`
   (`undici`, `protobufjs`, `@grpc/grpc-js`). `npm audit fix --force` wants a major Firebase
   upgrade. Separate branch with full read/write smoke testing, not a drive-by.
6. **`App.jsx` is one 2526-line file.** Splitting it is real debt reduction but carries UI
   regression risk with no tests. Regression tests first.
7. **No offline support.** No persistence is enabled, and `runTransaction` cannot queue, so
   Take will never work offline. Release can queue.
8. **No tests and no CI.** The only automated check is `npm run lint`.
9. **`public/icons.svg`** looks unused in-repo, but external references cannot be ruled out
   from source alone. Needs verification, not deletion.

---

## Known Design Decisions

Several things that look like dead code or bugs are deliberate. Check here before agreeing to
"fix" anything.

- **Single file** `App.jsx`: intentional, no build complexity.
- **No memoization.** `merged`/`sorted`/`filtered`/`total`/`avail` recompute every render.
  With one component and no memoized children, `useMemo` prevents zero re-renders, only array
  work, which is microseconds at this scale. Do not add `useMemo`/`useCallback`/`React.memo`
  as a performance fix without a measured problem.
- **The 810-line CSS string stays in the JS bundle.** Moving it to a `.css` file would cut JS
  size and enable separate caching, but it is a restructure with no functional gain.
- **No auth, for now.** See Known Risks.
- **No server-side scheduler.** The monthly rollover is a client-side effect, not a Cloud
  Function or cron. See `references/month-scoping.md` for why that is safe.
- **`src/index.css` is leftover Vite template CSS. Do not delete it.** Most of it is dead
  (`h1`/`h2`/`code`/`p`, `#social`, a dark-mode block shadowed by App's later `<style>`). It
  used to pin `#root` to a fixed 1126px column, **which is no longer true**: it is now
  `width: 100%` with a flex column and `min-height: 100svh`, and `.page` centres the content
  itself. Two things still matter: `color-scheme: light dark` (so native controls render dark
  in dark mode even though the app stays light), and nested `@media` inside `:root`, which
  Vite does not transpile, so pre-16.5 Safari ignores those rules.
- **Native `alert`/`confirm`** in `clearStale`, `labelUnlabelled`, `removeUnlabelled`,
  `clearOldLogs`, `clearTopupRequests`. Rare admin-only actions, and native dialogs are
  accessible by default. A custom modal is new surface area for a non-problem.
- **Duplicate detection is per drop month.** The same code string legitimately reappears in a
  later month's batch.
- **Masking is presentational.** Do not present it as security.
- **The reveal screen has no expiry date, Grab redemption hint, or "screenshot this" reminder.**
  The supplied mockup has none, and the implementation follows the mockup. Dropping the
  reminder is only safe because a claimed code renders unmasked in the list, so it stays
  recoverable by searching your own name. **If masking is ever extended to claimed codes, that
  reminder has to come back.**
- **The reveal code stays monospace,** the only monospace on that screen, even though the
  mockup uses a geometric sans. Grab codes get retyped into another app, so `0` against `O`
  and `1` against `I` must stay distinguishable.
- **No em dashes or en dashes anywhere.** Owner preference, applied across the whole repo:
  source comments, UI strings, rules comments, markdown, commit messages, and chat. Rewrite
  the sentence rather than substituting a hyphen: a colon where the dash introduced something,
  a comma where it was parenthetical, a full stop where it joined two clauses. Check with
  `grep -rnP '\x{2014}|\x{2013}' src/ firestore.rules docs/ .claude/` before pushing, which
  uses PCRE escapes so the check itself contains no dashes. The box-drawing separators in the
  CSS section banners are not dashes and should be left alone.

---

## Roadmap

Done: CSV export, concurrency protection, server timestamps, log cleanup, Vercel Analytics,
copy to clipboard, **Firestore security rules** (written, published, three permitted
transitions), **code expiry** (implemented as month scoping rather than a 30 day timer),
**top-up requests**, **low stock and unstaged month alerts**.

Open, roughly in value order:

1. **Mask claimed codes too.** Currently a claimed code renders in full to everyone, so any
   staff member can read and redeem someone else's single-use code before they do. Cheap fix,
   the only leak with a real victim. Note the coupling to the reveal screen above.
2. **Remember the staff name on the device,** plus a "your code this month" card. `takeCode`
   clears the name on every success and there is no recovery path except searching 40 rows.
3. **Real auth** (Google sign-in restricted to the work domain). Unlocks enforceable per
   person limits, a genuine "my codes" view, server-side code hiding, and closes
   `allow delete: if true`.
4. **Move drop activation and cleanup to a scheduled job,** so month boundaries stop
   depending on someone having a tab open with a correct clock.
5. **Per person claim guard** and admin-side claim counts. Device-local nudge plus visibility;
   not enforceable without auth, so never present it as a rule.
6. **Honest offline behaviour.** Enable the local cache so the list renders, then detect
   offline and say claiming needs signal.
7. Automatic log retention, so pruning is not a manual click.
8. Split `App.jsx`, admin tabs, pagination or virtualization for the manager list.
9. Date filters, code categories by project or site, QR scan to Take, usage stats.

Dropped as not worth it: dark mode, compact view toggle, skeleton loaders. All cosmetic for a
tool someone opens for 20 seconds a month. Note dark mode is currently half-broken by
`color-scheme: light dark` in `index.css` fighting App's light palette; either finish it or
drop that line.

---

## How to Use This Skill

| Por asks to | Do this |
|---|---|
| Add a feature | Follow existing patterns: handler plus JSX plus styles in the CSS literal. Check the roadmap first, several items have prior analysis |
| Fix a bug | Check state names and the patterns above before guessing |
| Change the design | Use the tokens, never hardcoded colours. **Read `references/ui-notes.md` first**, both traps there fail silently |
| Add a modal | State flag, JSX conditional, spring easing, and add it to the Escape handler's priority order |
| Touch anything month-related | **Read `references/month-scoping.md` first.** This subsystem deletes documents |
| Write or debug a Firestore query | **Read `references/audit-notes.md` gotcha #1 first**, before assuming the query logic is wrong |
| Change the `codes` shape or add a collection | Update `firestore.rules`, and **publish it before the code deploys**. See `references/operations.md` |
| Touch clipboard, CSV, or downloads | Browser gotchas in `references/audit-notes.md` |
| Deploy | `references/operations.md`. Verify what production actually serves; a merge is not proof |
| Add a log type | Handler call with the new type string, plus a matching `.act-dot.{type}` CSS rule |
| Ask "is X safe to delete" | Check Known Risks and Known Design Decisions first |

---

## Changelog

### v3.0.0, July 31, 2026
Rewrite against the current source. v2.0.0 predated four major changes and several of its
stated facts are now wrong.

- **Corrected from v2.0.0:** `App.jsx` is 2526 lines (was 1708); CSS literal is 810 lines
  spanning 63 to 873 (was 767); **four** collections and **four** listeners (was three and
  three); bundle ~471 kB / ~142 kB gzip; the entire design token list changed names and values
  (`--text2` to `--text-2/-3/-4`, `--radius-*` to `--r-*`, `--shadow-*` to `--sh-*`, plus new
  `--track`, `--green-strong`, `--orange-dark`); `index.css` no longer pins `#root` to 1126px,
  so v2.0.0's warning about that is obsolete; `firestore.rules` is no longer "test mode,
  roadmap item 13", it is written and published.
- **New:** month-scoped drop scheduling and automatic cleanup, split into
  `references/month-scoping.md`. `monthKey`, the live/staged/stale/unlabelled partition, the
  top-up invariant, the sweep's `live.length > 0` guard, the month ticker.
- **New:** `references/ui-notes.md`, covering the CSS-in-JS backtick landmine that took
  production down as a blank page, and the source-order trap where a media query placed before
  the rule it overrides is silently dead code.
- **New:** `references/operations.md`, covering rules publishing, the read-only probe that
  detects rules drift, the Vercel deployment that was silently skipped, and the clock-based
  test checklists.
- **New features documented:** top-up requests (`topupRequests`, device-local cooldown), admin
  low stock and unstaged month alerts, the rebuilt reveal screen, the mobile-first staff
  redesign, Scheduled Drops, Expired Codes and No Drop Month notices.
- **New gotcha:** reading a field that does not exist in rules is an error that denies the
  write, so `.get(key, default)` is required for any optional field. Now gotcha #7 in
  `references/audit-notes.md`.
- **New convention:** no em dashes or en dashes anywhere in the repo.
- **Risk updates:** added unauthenticated `topupRequests` writes, no offline support, no tests
  or CI. Reconfirmed the first three.
- **Roadmap rewritten** with the completed items marked and the open ones ordered by value.
  Added "mask claimed codes" as the top item: currently any staff member can read and redeem
  someone else's claimed single-use code.
- **Version:** 2.0.0 to 3.0.0

### v2.0.0, July 27, 2026
Rewrite based on a correctness and hardening audit (PRs #10, #11) verified against the code
rather than assumed. Added the Firestore gotchas (7), browser gotchas (3), code conventions,
and operations sections. Verified no auth, no props, no memoization. Flagged admin-not-a-
security-boundary, readable unclaimed codes, and unverifiable deployed rules.

### v1.0.6, July 1, 2026
Safe items from the June 30 audit plus fixes made during deployment. `toMs()` applied
consistently to sort and CSV export; `log()` moved after the write succeeds; bulk add
dedupes the paste itself; `takeBusy` double-tap guard with the reveal gated on server
confirmation; release history pruning; listener error handling with `connError`; `csvSafe()`
formula-injection hardening; Escape key closes modals; logo became a real `<button>`; deleted
dead `src/App.css`; fixed `npm run lint` false positives by wiring `eslint-plugin-react`.

### v1.0.5, June 27, 2026
Copy-to-clipboard button on the reveal screen, Clipboard API with `execCommand` fallback,
`copied` state showing "Copied ✓" for 1.5s.

### v1.0.4, May 15, 2026
Vercel Analytics.

### v1.0.3, May 12, 2026
`runTransaction` concurrency protection on Take, `serverTimestamp()` for `takenAt` and
`releasedAt` with the `toMs()` helper, admin Clear Old Logs button.

### v1.0.2, May 10, 2026
Firebase config and admin PIN moved to env vars, code masking, reveal screen, lazy listeners,
release history duration, `log()` stopped writing local state.

### v1.0.1, May 10, 2026
Initial release: core take/release/manage flow, real-time sync, admin PIN, Code Manager, bulk
operations, activity log, release history, stat cards, CSV export, mobile layout.

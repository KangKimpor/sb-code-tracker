# Backend, Hosting, and the Telegram Bot

Read this before answering anything about security, auth, the admin PIN, Cloud Functions,
`firestore.rules`, `codeInventory`, hosting, or the bot. The recurring trap in this area is
conflating **what is in the repo** with **what is running**. Say which one you mean every time.

Sources: `docs/connection-recovery.md`, `docs/security-rollout.md`,
`docs/security-verification.md`, `telegram_bot/README.md`, `functions/`, `firebase.json`,
`render.yaml`, `.github/workflows/deploy-firebase.yml`. Re-read them if the question is about a
detail that is not here, because they change faster than this file.

---

## Timeline that explains the current state

- **2026-10-09, `5214624`:** server-enforced security committed. Frontend reads `codeInventory`
  and calls the `tracker` function.
- **Same day:** Vercel auto-deployed that frontend. Live Firestore still ran the legacy rules,
  `codeInventory` was empty, and the Cloud Functions API was disabled. Result: permission errors
  and a falsely empty October drop. Underlying data was intact (50 codes, 33 available at
  inspection).
- **Recovery (`5a61d66` and following):** restored a client compatible with the live rules,
  kept the PIN and all data, removed browser-driven deletion, added instant reveal, added the
  build guard. The staged backend stayed in the repo, dormant.
- **2026-10-10:** Telegram bot added, using the Admin SDK so it needs neither the functions nor
  new rules.

---

## The staged secured backend (not live)

`firestore.rules` as committed (26 lines):

- `codeInventory`: public `get`, public `list` capped at 2000 docs, no writes.
- `codes`: readable only with an admin claim, no writes.
- `activityLog`, `releaseHistory`, `topupRequests`: admin read only, no writes.
- Everything else denied.
- Admin means `request.auth.token.adminUntil` is a number in the future.

`functions/index.js` exports two things:

- **`tracker`**, an `onCall` function (us-central1, `maxInstances: 5`, secret `ADMIN_PIN`).
  `functions/tracker.js` dispatches on `data.action`:

| Action | Auth | Notes |
|---|---|---|
| `login` | none, throttled | Checks the six-digit PIN with a constant-time hash compare, returns a custom token carrying `adminUntil` one hour out. 5 tries per IP per 15 minutes, 100 global per hour |
| `claim` | none, throttled | Transaction. Takes `id`, `name`, `deviceId`, `requestId` (a UUID nonce). A repeat with the same nonce, name and device returns the already-committed claim, so a lost response is recoverable without a second audit row. Rejects a code from another month. 30 per IP per hour, 300 global |
| `requestTopup` | none, throttled | Six hour per-device cooldown in `_requestCooldowns` |
| `add` | admin | Month must be current or future, 1 to 200 codes per call, at most 1,000 per month, deduped within the month |
| `release` | admin | Writes `releaseHistory` and the audit row in the same transaction |
| `delete`, `label` | admin | 1 to 200 ids. `label` only works on codes with no `monthKey` |
| `clearRequests`, `clearOldLogs`, `export` | admin | Pruning and an audit entry for exports |

- **`expireMonthlyCodes`**, `onSchedule` at `5 0 * * *` in `Asia/Phnom_Penh`. Same safety shape as
  the old browser sweep: it does nothing unless a current-month drop exists, never touches future
  or unlabelled drops, and uses the server's ICT month so a wrong browser clock cannot delete.

Design points worth knowing:

- Every mutation writes the code, its `codeInventory` mirror, and a server-built audit row
  (`source: "server"`) in **one transaction**. The browser can no longer forge audit entries.
- The month is `new Date(ms + 7h).toISOString().slice(0, 7)`: ICT, fixed offset, no DST.
- `inventoryOf(id, code)` is the single place that decides what is public: label
  `Code <last 6 of id>`, `monthKey`, `status`, `takenBy` (60 chars), `takenAt`, `createdAt`.
  Voucher values and device ids are deliberately left out.
- `functions/migrate.js PROJECT_ID` backfills `codeInventory` from `codes` with fresh
  transactional reads, preserving originals. It needs Application Default Credentials.
- Rate-limit and cooldown docs carry `expiresAt`; enable Firestore TTL on it.

### Rollout order (summary of `docs/security-rollout.md`)

Anonymous staff access stays; only admin and all writes change. In one maintenance window:
install both lockfiles, run lint/tests/`test:security`/build, store the existing PIN as the
`ADMIN_PIN` secret, deploy `functions` and `firestore:rules` together, run the migration,
deploy hosting with the secured frontend, verify claim/PIN/release/bulk/top-up/CSV/logout, then
set `SECURITY_BACKEND_READY=true` in Vercel **and** the GitHub repo variable. Needs a billing
enabled Firebase project, Firebase Authentication (custom tokens need no provider), the signing
permission for the runtime service account, a fresh Firestore backup, and a re-authenticated
Firebase CLI. **Reverting only Hosting afterwards is unsafe** because old clients' writes are
denied by the new rules; roll back UI changes while keeping the new rules and backend.

### Honest limits of the secured design

Staff access is anonymous by intent: anyone with the URL can claim a current code or type any
name. Keeping the existing PIN keeps the risk that someone already learned it from the old public
bundle. Rate limits bound accepted writes; they do not stop distributed abuse or read billing,
so App Check and billing alerts are recommended on top. Vouchers already downloaded cannot be
made secret again. The test CLI (`firebase-tools@15.33.0`) has upstream advisories but is not
shipped to browsers or functions.

---

## Hosting and deploy pipeline (live)

| Host | Trigger | What runs | URL |
|---|---|---|---|
| **Vercel** | every push to `master`, PR previews too | `npm run build` (includes the readiness guard) | sb-code-tracker.vercel.app |
| **Firebase Hosting** | push to `master` or manual dispatch, via `.github/workflows/deploy-firebase.yml` | `npm ci`, `npm ci --prefix functions`, `lint`, `test`, `test:security` (Java 21), `build`, then deploy to channel `live` | sb-code-tracker.web.app, its `firebaseapp.com` twin, and the custom domain sbgrabcode.mine.bz |

- The two deploy the **same commit independently**, so completion times differ and one can be
  stale while the other is current. Verify each (`references/operations.md`).
- The Firebase workflow fails early if `VITE_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`,
  `_APP_ID` or `VITE_ADMIN_PIN` secrets are missing (the PIN check was added in `9d11a3d`). It
  needs `FIREBASE_SERVICE_ACCOUNT` to publish.
- **Build settings must be kept identical between Vercel and GitHub Actions,** including the PIN,
  while the compatibility frontend uses it. Never commit or print the values. See Known Risk 2
  in `SKILL.md`.
- `AGENTS.md` sets the policy: deploy the same commit to both hosts, confirm both succeed, fix or
  rerun a failed one rather than leaving a host behind, and do not deploy Firestore rules or
  Cloud Functions as part of a hosting update.
- Vercel does not run the tests. Only the Firebase workflow does.
- `firebase.json` also holds the functions source (`nodejs22`), the rules path, emulator ports
  (firestore 8080, auth 9099) and a one-year immutable cache header on `/assets/**`.
- `vercel.json` is now only the schema line. It used to carry a cache header for the removed
  header-ring asset.

---

## The Telegram bot

**@SingBuildBot**, code in `telegram_bot/` (`bot.py`, `store.py`, `models.py`, tests, README).
Deployed through the Render blueprint `render.yaml` as service `singbuild-tracker-bot` on the
free plan, **one instance only**, webhook at `/telegram`, long polling when `WEBHOOK_URL` is
unset. It is separate from the group-chat bot `sb-groupchat-bot`; the code refuses a token for
the wrong bot. Whether the Render service is running right now **cannot be verified from the
repo**: the README says code alone does not activate an existing bot.

How it relates to the website:

- **Same Firestore database, no copied inventory.** `/app` opens the website at `TRACKER_APP_URL`.
- It uses the **Admin SDK**, so it ignores security rules entirely. That is why it works without
  deploying the functions or new rules, and why it must never be given a broad hosting key: use
  a dedicated service account with `roles/datastore.user`.
- Each mutation writes the code, the `codeInventory` mirror, the audit row and a retry receipt in
  one transaction. Receipts live in `_telegramOperations` and can contain claimed vouchers, so
  that collection, `_rateLimits` and `_requestCooldowns` **must stay denied to clients**.
- The live website's own writes do **not** maintain the `codeInventory` mirror. The bot's do.
  So the mirror can drift until the migration is re-run, which is required before any secured rollout.
- Claims from Telegram carry `takenDevice: "telegram:<numeric id>"`. A browser device id and a
  Telegram id are different, so a name alone never links accounts or grants `/mine` access.
- There is **no automatic monthly deletion** in the bot. Filtering flips at ICT midnight and
  admins remove expired drops explicitly, matching the current website.

Admin on Telegram needs **both** the numeric Telegram user id in `ADMIN_USER_IDS` and the
existing six-digit PIN. Sessions last one hour, prompts and confirmations expire after five
minutes, state for names, selections, sessions and pending confirmations is in memory and resets
on restart, while claims, cooldowns, quotas, history and receipts persist in Firestore.

Staff commands include `/codes`, `/search`, `/status`, `/name`, `/take`, `/mine`, `/topup`.
Admin commands cover `/admin`, `/logout`, `/manager`, `/add`, `/schedule`, `/drops`,
`/delete_drop`, `/select`, `/delete`, `/delete_selected`, `/release`, `/clear_expired`,
`/label_unlabelled`, `/remove_unlabelled`, `/history`, `/activity`, `/requests`,
`/clear_requests`, `/clear_logs`, `/export`. `/start`, `/help`, `/cancel` are universal.
The README has the full feature map against the web app; keep the two in step when a
workflow changes.

Rate limits: 120 commands per hour per Telegram account, 5 PIN attempts per account per 15
minutes (100 global per 15), 30 claims or top-up confirmations per hour per account (300
global), plus the six hour top-up cooldown. Bulk actions run in batches of at most 200 and
report completed work if a later batch fails. CSV uses formula escaping, no rich-text parsing,
and logs never contain the token.

Bot env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `ADMIN_PIN`, `ADMIN_USER_IDS`,
`WEBHOOK_SECRET`, `WEBHOOK_URL`, `FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`
(a Render secret file), `TRACKER_APP_URL`. **Never put any of these in `VITE_*` variables, in a
commit, or in a Telegram message.**

The website also runs inside Telegram as a mini app: `index.html` loads the SDK, `main.jsx`
expands the sheet, disables vertical swipe-to-close and sets the colours, and `App` calls
`ready()` on mount, all behind guards so a normal browser is unaffected.

---

## Tests that exist

| Command | Covers |
|---|---|
| `npm test` | `node --test` on `src/*.test.js` and `scripts/*.test.js`, then `npm --prefix functions test` (`functions/tracker.test.js`) |
| `npm run test:security` | Needs Java 21. Firestore and Auth emulators: `security.emulator.test.js`, `legacy-claim.emulator.test.js` (competing claims against the compatibility client) |
| `python -m unittest discover -s telegram_bot -p test_bot.py -v` | Bot logic |
| bot emulator tests | `telegram_bot/compatibility.emulator.test.js` and `test_store_emulator.py`, run together with the emulators per the bot README |

All use demo project ids and never touch production data. A passing suite is not evidence about
the live rules: nothing here exercises them.

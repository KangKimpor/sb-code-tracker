# Operations: Deploying, Publishing Rules, and Verifying

Read this before deploying, publishing rules, or claiming a change is live. The recurring
lesson in this project is that **a merge is not evidence of a deployment, and a deployment is
not evidence the feature works.** Both have failed silently here.

---

## Local dev

```bash
npm run dev     # http://localhost:5173
```

### Environment variables (required)

Create `.env` in the project root, same level as `package.json`:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
VITE_ADMIN_PIN=...
```

The same keys must exist in **Vercel, Settings, Environment Variables** for production. `.env`
is gitignored and must never be committed. There is no `.env.example` in the repo, so this list
is the reference.

---

## Verify before pushing

```bash
npx eslint .        # must be clean
npm run build       # must pass
```

Plus the stylesheet check from `references/ui-notes.md` if you touched the CSS, and:

```bash
# PCRE escapes, so this command contains no dashes itself
grep -rnP '\x{2014}|\x{2013}' src/ firestore.rules docs/ .claude/   # must be empty
```

**A passing build is not evidence a Firestore change works.** Nothing here is exercised against
a live database. Behaviour changes need the manual checklists below.

---

## Deploying rules: manual, and merging does nothing

1. Firebase Console, Firestore Database, **Rules**
2. **Copy the existing rules to a text file first.** That is the rollback.
3. Paste in `firestore.rules`, **Publish**
4. Immediately on the live site: take a code, then release it. This is the only way to verify
   the `request.time` checks, since the Rules Playground cannot (gotcha #4).
5. If Take fails: the console shows `permission-denied`, restore the saved rules.

**Rules and app code that change together must be published together, rules first.** Vercel
deploys on merge; rules do not. Any release that adds or renames a field on `codes`, or adds a
whole collection, has a window where writes fail with `permission-denied` because the
`hasOnly()` whitelist or the catch-all deny rejects the new shape. Publishing rules first is
safe in a way the reverse is not: a newly *allowed* key is harmless to a client that never
sends it.

**This has already gone wrong once.** The `topupRequests` block was merged and deployed while
the live rules were an older version, so the feature was live and completely dead. It failed
quietly for staff (one alert they would ignore) and invisibly for admin (a count that never
appeared), so nothing about it looked like a rules problem.

### Read-only probe for rules drift

Every collection in `firestore.rules` has `allow read: if true`, and a collection with no rules
block falls through to the catch-all deny. So **a read tells you whether a block is deployed**,
with no writes and no side effects. The control collection is the important part: if it also
returns 200, the published rules are too permissive.

```bash
JS=$(curl -sf https://sb-code-tracker.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -sf "https://sb-code-tracker.vercel.app/$JS" > /tmp/live.js
# NOTE: Vite emits these as BACKTICK template literals, not double-quoted strings.
PID=$(grep -o 'projectId:`[^`]*`' /tmp/live.js | head -1 | tr -d '`' | sed 's/projectId://')
KEY=$(grep -o 'apiKey:`[^`]*`'    /tmp/live.js | head -1 | tr -d '`' | sed 's/apiKey://')

for C in codes activityLog releaseHistory topupRequests zzzControlNoRulesBlock; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    "https://firestore.googleapis.com/v1/projects/$PID/databases/(default)/documents/$C?pageSize=1&key=$KEY")
  echo "  $C -> $CODE"
done
```

Expected: `200` for the four real collections, `403` for the control. A `403` on a real
collection means its block is missing from the published rules.

This needs no credentials because `VITE_*` values are inlined into the public bundle by design.

**What the probe does not cover:** the `create` rules and their field whitelists and type
checks, which only an actual write exercises. A write test is possible (and reversible, since
`topupRequests` allows delete) but it mutates production data, so ask first.

---

## A merge does not guarantee a deployment

Vercel usually deploys on push to `master`, but it has silently skipped a merge at least once:
PR #21 merged as `e6b1bfc` and Vercel created **no deployment for it at all**, not a failed
one. Production kept serving the previous bundle, so the change simply appeared not to exist.
The commit status stayed `pending` with zero statuses reported.

So after merging, verify what is actually being served:

```bash
JS=$(curl -sf https://sb-code-tracker.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -sf "https://sb-code-tracker.vercel.app/$JS" | grep -c "a string only your change contains"
```

A string unique to the change is the reliable probe. **Bundle hashes are not**, because Vercel
inlines the `VITE_*` values at build time, so a production bundle never matches a local build
byte for byte.

Good probe strings for existing features: `Tell admin we're out` (top-up), `claim-code` (the
claim and reveal rebuild), `admin-alert` (admin alerts), `topupRequests` (the collection).

For a CSS change, grep the served bundle for the declaration itself, since the stylesheet ships
inside a JS string and keeps its whitespace:

```bash
python3 -c "
import re,sys; src=open('/tmp/live.js',encoding='utf-8',errors='replace').read()
m=re.search(r'\.reveal-code\s*\{([^}]*)\}', src)
print(m.group(1) if m else 'NOT FOUND')"
```

To see whether a deployment exists for a commit at all:

```bash
curl -sf "https://api.github.com/repos/KangKimpor/sb-code-tracker/deployments?per_page=5"
```

Look for an entry with `"environment": "Production"` whose `sha` is your merge commit. No entry
means Vercel never picked the push up, which is a different problem from a failed build and is
not fixable from the repo. Either press **Redeploy** in the Vercel dashboard or push another
commit to `master`.

---

## If the git push tooling fails

The sandbox's built-in `github_push_to_remote` and `github_create_pull_request` have gone
unavailable mid-session. Plain `git push` cannot substitute: the remote is an auth gateway
needing a header the tool injects, and there is no token, credential helper, or authenticated
`gh` in the sandbox.

**The fallback is the installed `github` power**, which ships its own MCP server with
`push_to_remote` and `create_pull_request`. Same operations, different code path, and it works
when the built-ins do not. Activate the power and call its tools.

Also: **check PR state before pushing to an existing branch.** If its PR is already merged, the
branch may have been auto-deleted, and pushing to it strands the commit with no open PR
pointing at it. A commit on a deleted branch is dangling: still reachable by SHA for a while,
then garbage collected. Create a new branch instead.

---

## Manual test checklist for Firestore changes

- Take a code, reveal screen shows the code, row updates to Taken
- Copy Code, paste elsewhere to confirm it really copied
- Admin: add single code, bulk add (**check order is preserved**), duplicate is skipped
- Bulk delete; release a code and confirm it **appears in Release History**
- Export CSV, opens correctly in Excel
- **Offline (airplane mode):** Take shows a clear error, not a frozen button; Add shows "Failed
  to add code" **and the typed text is still in the box**

That last one is the clearest signal the error handling is intact.

### Top-up requests

- Claim every code so the pool is empty, the hero offers "Tell admin we're out", tap it, it
  becomes "Admin notified", **reload and it is still "Admin notified"** (this proves the
  `localStorage` mirror works)
- Log in as admin: an "N waiting" pill appears and Code Manager shows Top-up Requests at the top
- Add a code: the request is **still there**, because clearing is explicit
- Clear: the pill disappears
- **With storage unavailable** (Safari private browsing, or cookies blocked): the request must
  still send; only the "already asked" memory is lost, so the button returns to its normal state
  instead of the page breaking

Note the awkwardness: the button only appears when nothing is claimable and is hidden from
admin, so testing it needs an empty pool.

### Drop scheduling

Time-dependent, so change the **OS** date, not a JS variable, and reload.

- **The top-up case, and the one most worth re-checking after any change to the cleanup:** with
  codes already live for this month, set Drop Month to the **current** month and add more.
  Nothing may be deleted, earlier codes stay claimable, and the count goes up by exactly what
  you added. Repeat two or three times.
- **Migration:** with only unlabelled codes on file, load the app. They must still be visible
  and claimable, nothing deleted, and a "No Drop Month" notice appears in Code Manager. Top up
  the current month and confirm they *still* are not deleted.
- Set Drop Month to next month and bulk add: the new codes do **not** appear in the list, they
  show under Scheduled Drops with a "Staged" badge, and this month's codes are still live.
- Roll the clock to the 1st of that month and reload: staged codes are now live, last month's
  are gone from the list *and* from Firestore, and the Activity Log gains a
  `<Month> started: removed N expired code(s)...` entry.
- Stage two future months, then roll into the first: the second must still be staged.
- **The important one:** with *only* expired codes on file and nothing for this month, roll the
  clock forward. The list shows "No codes for <month>" and they are hidden, but **still present
  in Firestore**. The sweep must refuse to run. If they get deleted here, the
  `live.length > 0` guard is broken and the tracker can be emptied.
- Set the clock a month *ahead* of live codes: nothing is deleted, same guard.
- Claim a code then roll into the next month: the expired taken code is removed too, and the log
  entry notes how many had been taken.
- "Assign to <month>" on the No Drop Month notice: codes stay live, then are removed
  automatically at the next month boundary. This exercises the LABEL rule; a `permission-denied`
  here means the deployed rules predate it.

### Admin alerts

Also clock-dependent. Log in as admin first; the banners never render for staff.

- **Low stock:** claim codes until 3 remain, an orange "Only 3 codes left" appears. Claim the
  rest, it is replaced by a red "All N codes claimed". Add a code, both clear.
- **Unstaged nudge:** set the date to the 24th of a 31-day month with nothing staged for next
  month, "Nothing staged for <next>" appears. Set it to the 23rd, it is gone. In a 28-day
  February the window opens on the 21st, not the 24th, because it counts days remaining rather
  than a fixed date.
- **The nudge clears on staging, not on adding:** with the nudge showing, add codes to the
  *current* month, the nudge must remain. Stage one code for next month, it clears. This is the
  assertion that catches a check against `stagedCodes` as a whole instead of next month
  specifically.
- **Drop Month pre-set:** with Drop Month left on a future month, tap the low-stock banner's
  "Add codes", the manager must open with Drop Month back on the **current** month. Tap the
  staging banner's "Stage <next>", it must open on **next** month. Getting this backwards is how
  a top-up silently lands in a staged drop.

Reset the clock afterwards, and clean up test codes before switching back: anything written
while the clock was wrong keeps that `monthKey`.

### Testing date arithmetic without moving the clock

For edge cases (month lengths, leap years, year rollover, the exact boundary day, the
`days === null` guard), extracting `monthExpiry` from source and freezing `Date` is far cheaper
than an OS date change. Extract the function text rather than copying it, so the test exercises
the shipped code:

```js
const src = readFileSync("src/App.jsx", "utf8");
// walk braces from `function monthExpiry(` to its closing brace, eval, then stub globalThis.Date
```

Cases worth covering: the 1st of a 31-day month (30 days, no nudge), the 23rd and 24th (8 then
7 days, nudge boundary), the last day (0 days, "Expire today"), a 28-day February, a 29-day
leap February, 31 December (year rollover to `2027-01`), and `monthExpiry` of a non-current or
malformed key returning `days: null`. Worth redoing if `monthExpiry` is ever touched.

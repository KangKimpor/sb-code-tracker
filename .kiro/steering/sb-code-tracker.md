# sb-code-tracker: Project Knowledge

Staff code allocation tool. React + Vite + Firebase Firestore, deployed on Vercel.
Written during a correctness/hardening audit (PRs #10 and #11). Everything here was
verified against the actual code, not assumed.

---

## Project facts

| | |
|---|---|
| Stack | React 18, Vite 5, Firebase JS SDK (modular), `@vercel/analytics` |
| Auth | **None.** All Firestore access is anonymous. |
| Deploy | Vercel, auto-deploys on merge to `master`. PRs get preview URLs. |
| Bundle | ~534 kB / ~142 kB gzip (dominated by `firebase/firestore`) |

### File layout

Only 7 source files. `src/App.jsx` is a **single component, ~2140 lines**:

- Lines 1 to 39: imports, Firebase init, constants (`MONTH_MS`, `ADMIN_PIN`, `STATUS`)
- Then one ~700-line CSS template literal, injected via `<style>{styles}</style>`
- After the CSS: module-level helpers `toMs`, `formatTime`, `formatTimeShort`, `csvSafe`,
  the month-scoping block (`monthKeyOf`, `currentMonthKey`, `shiftMonthKey`, `monthLabel`,
  `monthLabelShort`, `partitionByMonth`, `groupByMonth`), and `log`
- Then the `App` component: state, effects, actions, derived values, JSX

`log` is module-level on purpose: it closes over nothing but `logsRef`, and keeping it out
of the component means the cleanup effect doesn't take it as a dependency (an
in-component arrow is a new identity every render, so the effect would re-run constantly).

Because the CSS occupies nearly half the file, **grep for symbols rather than trusting
line numbers**, they shift on every change.

There are **no props anywhere** (one component, no children) and **no `useMemo`/`useCallback`/`React.memo`**.
That's a deliberate decision, not an oversight. See "Decisions" below.

### Data model

Three collections. **The field types are load-bearing. Get them wrong and queries silently break.**

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

Note the deliberate inconsistency: `createdAt` and `ts` are plain numbers, but
`takenAt` and `releasedAt` are Firestore Timestamps. `toMs()` normalises both when reading.
**When querying, the comparison value must match the stored type.** See gotcha #1.

---

## Drop scheduling and automatic cleanup

The business rule this implements: **a grab code only works during the calendar month it
was issued for.** Next month's codes are added a few days before month end and must stay
hidden until that month starts, at which point the previous month's codes are deleted.

**A month can also run out of codes and get topped up part-way through.** That is why
staleness is driven purely by the calendar and never by new codes arriving: codes added for
the current month join what is already there, all equally live, however many times it
happens. Only a month boundary makes anything stale. Breaking this is the easiest way to
destroy live codes, so it is worth restating in any future change to the cleanup.

Nothing about a code string reveals which month it belongs to, so `monthKey` (`"YYYY-MM"`)
is the only record of that. `partitionCodes(codes, nowMonth)` derives everything else:

| Bucket | Condition | Behaviour |
|---|---|---|
| live | `monthKey == nowMonth`, plus every unlabelled code | shown in the table, claimable, counted in the stat cards |
| staged | `monthKey > nowMonth` | hidden from the table; visible to admin under Scheduled Drops. **Never deleted by cleanup**, it is queued work rather than a leftover |
| stale | `monthKey < nowMonth` | hidden immediately, then deleted |
| unlabelled | no `monthKey` | also counted in `live`, and reported separately so admin can resolve it |

**Unlabelled codes are never dated by the app.** Codes written before this feature have no
`monthKey`, and a code string carries no clue about its month, so there is no honest way to
infer one. They stay live and are never deleted automatically. Admin resolves them once,
from the "No Drop Month" notice in Code Manager, by either assigning the current month
(`labelUnlabelled`, which puts them into the normal lifecycle so they expire on their own)
or removing them (`removeUnlabelled`). After that every code in the collection has a month
and the ambiguity is gone for good.

Deriving their month from `createdAt` looks tempting and is wrong: codes are added days
before the month they are for, so a July code typically has a June `createdAt` and would be
deleted the moment it went live.

**The month is always zero-padded, and that is load-bearing.** It makes plain string
comparison chronological (`"2026-09" < "2026-10"`, `"2026-12" < "2027-01"`), which is why
the partition is three `===`/`<`/`>` checks and no date parsing. An unpadded `"2026-9"`
would sort *after* `"2026-10"` and the code would expire two months early, hence the
regex check in `firestore.rules`, and why `monthKeyOf` is the only place keys are built.

### Local clock, not UTC, in the app *and* in the rules

Months resolve from `new Date()` on the client, so the switchover happens at **local**
midnight. Staff are in UTC+7 and expect the 1st to mean their 1st.

This is also why `firestore.rules` deliberately does **not** validate `monthKey` against
the current month. `request.time` is UTC, so a rule like "monthKey must equal the server's
month" would reject every legitimate claim during the first 7 hours of each month in ICT.
The rules validate the *format* only. Don't add a server-side month check without solving
the timezone problem first.

### The cleanup sweep, and the invariant that makes it safe

**The trigger is the calendar, never "codes were added."** A staged drop cleans up the
month it belongs to, on the 1st. Topping up the current month cleans up nothing.

There is **no server-side scheduler** in this project (no Cloud Functions, no cron, see
Decisions below), so the cleanup runs client-side in a `useEffect` on whatever browser
happens to be open, trusting that device's clock. Two things keep that from being
dangerous:

1. **Hiding is separate from deleting.** Stale codes vanish from the table through the
   `partitionCodes` filter on the render path: no writes, instant, works even if the
   delete never happens. Staff can never claim a dead code, regardless.
2. **The sweep refuses to run unless the live set is non-empty** (`live.length > 0`). So it
   can only trim the tracker down to codes that still work, never empty it. A device with
   its clock set a month ahead sees this month's codes as stale, but it would also need
   codes for its own wrong month to pass the gate, and it has none, so it skips.

The `sweep` ref carries `busy` (a snapshot arriving mid-flight can't start the same deletes
twice) and `failedMonth` (one failure stops further attempts that month, so a permission
error can't turn every snapshot into another round of failing batches). Skipped while
`connError` is set.

**Don't gate the sweep on a month-keyed "already done" flag.** Stale codes can appear after
a successful sweep, for instance when someone adds a code from the Firebase console, and a
blanket month lock would ignore them until the next reload.

**The background effect never calls `alert()`.** That's a deliberate deviation from the
repo's error convention: it fires unprompted on load, so an error popup for a background
chore would just block a staff member who wants to grab a code. It `console.error`s and
leaves the stale codes hidden. The manual admin equivalents (`clearStale`, `deleteDrop`,
`labelUnlabelled`, `removeUnlabelled`) do alert, because a human clicked them.

### Duplicate detection is per month

`addCode`/`addBulk` dedupe within the target month only. The same code string legitimately
reappears in a later month's batch, and skipping it because a dead code from two months ago
had the same value would silently drop a code from the new drop.

### Background effects don't `alert()`

A deviation from the repo's error convention, and an intentional one: the cleanup fires
unprompted on load, so an error popup for a background chore would just block a staff member
who wants to grab a code. It `console.error`s and leaves the stale codes hidden. The *manual*
admin equivalents (`clearStale`, `deleteDrop`) do alert, because a human clicked them.

---

## Firestore gotchas (the expensive lessons)

These caused real, silent bugs in this project. They generalise to any Firestore app.

### 1. A range query's bound must be the same type as the stored field

Firestore indexes order values **by type first, then by value**, and a range scan is
confined to the bound's own type band. Comparing a Timestamp field against a plain
number matches **nothing**: no error, no warning, just an empty result set.

```js
// BROKEN: releasedAt is a Timestamp, cutoff is a number → 0 results, always
where("releasedAt", ">", Date.now() - MONTH_MS)

// CORRECT
where("releasedAt", ">", Timestamp.fromMillis(Date.now() - MONTH_MS))
```

This shipped and made the entire Release History feature permanently empty, while its
"No releases in the past 30 days" empty state made it look like normal behaviour.
`activityLog.ts` is a number and was correctly compared as one. The bug was only
where the types diverged.

**Rule of thumb:** if a field is written with `serverTimestamp()`, every query bound
against it must be a `Timestamp`.

### 2. `writeBatch` caps at 500 operations

An unbounded `getDocs(...)` fed into a single batch works fine in testing and then
fails permanently once the collection grows past 500. Always chunk:

```js
for (let i = 0; i < docs.length; i += 400) {
  const batch = writeBatch(db);
  docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
  await batch.commit();
}
```

### 3. Prefer `writeBatch` over `Promise.all` for multi-document writes

`Promise.all(items.map(addDoc))` rejects on the *first* failure while the rest keep
running, leaving a partial write with no record of what landed. A batch is atomic per
chunk, and it's one round trip per 400 docs instead of one per doc.

`doc(collectionRef)` with no path generates an auto-ID, exactly what `addDoc` does
internally, so `batch.set(doc(codesRef), data)` is the batch equivalent of `addDoc`.

### 4. The Rules Playground cannot test `serverTimestamp()`

The standard way to force a server-side timestamp in rules is:

```
request.resource.data.takenAt == request.time
```

This is correct and necessary: rules can't tell that the *server* supplied the value,
so without it a client could write a fake time. **But the Playground makes you type a
literal timestamp, which will never equal `request.time`, so it always reports "Denied."**

Consequence: rules containing this check must be verified **live**, with the previous
rules saved for rollback. Don't panic at a Playground denial on these lines.

### 5. `is int` vs `is number` in rules

Rules treat `int` and `float` as distinct types; `is number` accepts both. JavaScript has
only one number type, so whether `Date.now()` arrives as `integerValue` or `doubleValue`
depends on SDK serialisation.

**In this project `is int` is verified working** for both `codes.createdAt` and
`activityLog.ts`, confirmed by successfully adding a code and seeing new Activity Log
entries after publishing. Keep it. If a future SDK change breaks code creation or
silently stops logging, relax those two lines to `is number`.

### 6. `serverTimestamp()` reads as `null` in the local snapshot

`onSnapshot` fires optimistically before the server acknowledges, so a freshly written
`serverTimestamp()` field is briefly `null`. `toMs()`/`formatTime()` return `""` for
this, so it shows as blank for a moment. Expected; don't "fix" it.

### 7. Reading a field that doesn't exist is an *error* in rules, and denies the write

Not `null`, not `undefined`, but an error, which fails the whole condition. So a rule that
freezes a field across an update breaks the instant one document is missing that field:

```
// BREAKS for any doc written before monthKey existed: reading resource.data.monthKey
// errors, the CLAIM branch evaluates false, and the code becomes unclaimable forever.
&& request.resource.data.monthKey == resource.data.monthKey

// CORRECT: Map.get(key, default) is total. Same default on both sides means
// "absent on both" compares equal, so unlabelled codes stay claimable.
&& request.resource.data.get('monthKey', '') == resource.data.get('monthKey', '')
```

This matters most when **adding a field to an existing collection**: the rule is written
against the new shape, every existing document has the old shape, and the failure mode is
a total outage of the app's core action rather than a visibly broken feature. In this app
unlabelled codes are the live set immediately after deploy, so a direct comparison would
have meant *nobody could take a code at all* until the next drop landed.

Use `.get(key, default)` for any field that is optional in practice, and
`'field' in resource.data` when you need to branch on presence.

([rules.Map reference](https://firebase.google.com/docs/reference/rules/rules.Map):
`get(key, default_value)` returns the default when the key is absent.)

### 8. Rules are safe to commit publicly

Rules are enforced server-side; knowing them grants nothing. Firebase's own tooling
assumes `firestore.rules` lives in version control. Collection and field names are
already visible in the client bundle anyway.

**Never commit:** service account JSON, Admin SDK private keys, `.env` files.
Safe to commit: `firestore.rules`, `firebase.json`, `VITE_FIREBASE_*` config values.

---

## The CSS-in-JS landmine

**A backtick anywhere in the `styles` template literal takes the whole app down, and
nothing in the toolchain catches it.** This shipped once and produced a blank dark page in
production.

```js
/* Each code is its own card. `.card` is kept as a wrapper */   // <- ends the literal
```

The backtick closes the template literal. What follows parses as a property access on the
resulting string plus a tagged template call, which is **valid JavaScript**, so `eslint` is
clean and `vite build` succeeds. It throws only when the module first runs:

```
Uncaught TypeError: "<the entire stylesheet>".card is not a function
```

Because it throws at module scope, `main.jsx` never renders, so `<style>{styles}</style>`
never reaches the DOM either. The result is an unstyled empty `#root`: the browser paints
its own dark canvas via `color-scheme: light dark` from `src/index.css`, which looks like a
theming bug and sends you hunting in entirely the wrong place.

The same applies to `${`, which would be read as an interpolation.

Check before pushing any change to the stylesheet:

```bash
python3 - <<'EOF'
src = open("src/App.jsx", encoding="utf-8").read()
s = src.index("const styles = `") + 16
body = src[s:src.index("\n`;\n", s)]
bad = [l for l in body.split("\n") if "`" in l or "${" in l]
print("BAD:", bad) if bad else print("stylesheet clean")
EOF
```

### Verifying a UI change actually means running the bundle

The gap that let this reach production: the redesign was checked by extracting the
stylesheet with a regex and rendering it in a standalone HTML page. The CSS looked perfect,
because a stray backtick is harmless inside a real `<style>` tag. Only the **JavaScript**
was broken.

`eslint` clean plus `npm run build` passing is not evidence the app runs. To actually prove
it, inline the built bundle into a page and confirm React mounts:

```bash
npm run build
# build an HTML file with the built .css in a <style> and the built .js in an
# inline <script type="module">, then:
agent-browser --session exec open "file:///.../dist/__exec.html"
agent-browser --session exec eval "document.getElementById('root').children.length"   # must be > 0
```

Inline the script rather than linking it: `file://` blocks external module fetches, and an
inline module reports real error messages instead of an opaque "Script error". Firestore is
unreachable without `.env`, so the app renders its empty state, which is enough to prove the
module executed and React mounted.

---

## Browser gotchas

### `document.execCommand("copy")` returns `false`, it does not throw

```js
const ok = document.execCommand("copy");
document.body.removeChild(ta);      // clean up BEFORE throwing
if (!ok) throw new Error("copy_failed");
```

Ignoring the return value means showing "Copied ✓" on a failed copy. In this app the UI
tells users to rely on that confirmation, so a false positive is the worst outcome.
Also: iOS Safari needs `ta.setSelectionRange(0, text.length)`, not just `ta.select()`.

### Blob downloads need the anchor in the DOM and a deferred revoke

```js
document.body.appendChild(a);   // Firefox ignores click() on a detached anchor
a.click();
document.body.removeChild(a);
setTimeout(() => URL.revokeObjectURL(url), 1000);   // sync revoke can cancel the download
```

Both failures are silent. Add `"\uFEFF"` to the front of CSV content so Excel detects UTF-8.

### `VITE_*` env vars are inlined into the public bundle

This is by design, not a misconfiguration. `VITE_ADMIN_PIN` is readable by anyone via
DevTools, confirmed by grepping the built output. Changing it in Vercel does not make
it secret; it only removes it from the public repo.

---

## Code conventions in this repo

### Every Firestore call needs a `catch` with user-visible feedback

These are `async` functions wired straight to `onClick`. Without a `catch`, a failure is
an unhandled promise rejection that the user never sees:

```js
const addCode = async () => {
  setNewCode("");
  try {
    await addDoc(codesRef, {...});
    log("add", `${t} added`);
  } catch (err) {
    console.error("addCode failed:", err);
    setNewCode(t);                                  // restore input, don't lose their work
    alert("Failed to add code. Please try again.");
  }
};
```

`alert()` is the established pattern for failure feedback here. Two details that matter:

- **If you clear an input before `await`, restore it in the `catch`.** Otherwise a failed
  write silently destroys what the user typed.
- **`try`/`finally` with no `catch` still leaks the rejection.** `finally` runs, so
  optimistic state gets rolled back and the UI snaps back with no explanation, which
  reads to the user as "my click didn't register."

`log()` is the one intentional exception: it ends in `.catch(() => {})` because audit
logging must never block a staff member from taking a code.

### Write the source of truth first, derived records after

```js
await updateDoc(codeRef, { status: "available", ... });   // source of truth
if (code) await addDoc(releaseHistRef, {...});            // derived audit record
```

The reverse order created a permanent record of a release that never happened when the
update failed. A *missing* audit row is recoverable; a *phantom* one is a lie in your data.

The inner `addDoc` keeps its own `.catch` so an audit-write failure doesn't trigger a
misleading "Failed to release" alert when the release actually succeeded.

### Claim/release integrity

`takeCode` uses `runTransaction`: read the doc, verify `status === "available"`, then
update. Throwing a plain `Error("already_taken")` inside the callback aborts without
consuming a retry (correct, a conflict isn't transient), while genuine contention is
retried by the SDK. Single-document scope means partial writes are structurally impossible.

**Do not replace this with a plain `updateDoc`.** It's the only thing preventing two staff
from claiming the same code simultaneously.

`runTransaction` requires connectivity and cannot be queued offline, so Take will never
work offline. Release (a plain `updateDoc`) can queue.

### Listeners

Three `onSnapshot` listeners, all with `return () => unsub()` cleanup:

1. `codes`: always on
2. `activityLog`: lazy, only while Code Manager is open
3. `releaseHistory`: lazy, only while Code Manager is open

Keep the lazy pattern (`if (!codeManager) return;`), it exists to conserve free-tier quota.
Only the `codes` listener sets the `connError` banner; the other two log to console only.

### Defensive patterns worth keeping

```js
if (err?.message === "already_taken")            // a null err would throw inside catch,
                                                 // skipping setTakeBusy(false) → frozen button
data.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))   // NaN = inconsistent comparator
`Taken by ${c.takenBy || "-"}`                   // avoid rendering literal "null"
```

### Timestamp formatting

- `formatTime` → `27 Jul 14:32`: main table, "took at"
- `formatTimeShort` → `27 Jul 14:32:05`: Activity Log, Release History (keeps seconds
  because entries can land in the same minute)

Both omit the year: the retention window is 30 days, so a year never disambiguates.
`toMs()` handles Firestore Timestamps, plain numbers, and null uniformly. Always route
timestamps through it.

### No em dashes or en dashes, anywhere

Owner preference, applied across the whole repo: source comments, UI strings, rules
comments, markdown, commit messages. The repo was swept clean of them, so any that appear
in a diff are new.

Rewrite the sentence rather than substituting a hyphen. A colon works where the dash
introduced something, a comma where it was parenthetical, and a full stop where it joined
two independent clauses. `grep -n '—\|–'` before pushing.

One thing that is *not* a dash and should be left alone: the `───` separators in the CSS
section banners are box-drawing characters.

---

## Decisions (don't "fix" these)

**`src/index.css` is leftover Vite template CSS.** Most of it is dead (`h1`/`h2`/`code`/`p`
rules, `#social`, and a dark-mode block shadowed by App's later `<style>`). It used to also
pin `#root` to a fixed 1126px column with side borders, which shaped the whole layout; the
mobile-first redesign replaced that with `width: 100%` and `.page` now centres the content
itself. What is left of `#root` is only the flex column and `min-height`.

Two things in the file still matter. It uses nested `@media` inside `:root`, which Vite
doesn't transpile, so pre-16.5 Safari ignores those rules. And `color-scheme: light dark`
is still set, so in dark mode native controls render dark even though the app stays light
(App's `:root` is injected later and wins on `--bg`).

**No memoization, intentionally.** `merged`/`sorted`/`filtered`/`total`/`avail`/`taken`
recompute every render. With one component and no memoized children, `useMemo` would
prevent zero re-renders, only array work, which is microseconds at this scale.

**The ~700-line CSS string stays in the JS bundle.** Moving it to a `.css` file would cut
JS size and enable separate caching, but it's a restructure with no functional gain.

## The staff-facing layout

Rebuilt from a supplied design. Worth knowing before changing any of it:

- **One centred column, max 560px, mobile-first.** There is no longer a desktop table and a
  phone card view: it is the same card layout at every width, so there is only one thing to
  keep working. The old `.t-head` grid, `.t-num`, `.t-desktop-only` and `.t-mobile-info` are
  gone, along with the `!important` mobile overrides that used to fight the desktop grid.
- **One availability figure, not three stat cards.** `.hero` states "N of M available" with
  the expiry countdown under it. Staff asked one question here, so `taken` is no longer
  computed. `monthExpiry()` produces the countdown and flags `urgent` at three days or less.
- **Each code is a card.** `.card` is now a transparent wrapper that exists only so the
  loading and empty states can occupy the same slot in the markup, which is why `.t-empty`
  and `.t-loading` carry their own card styling.
- **`maskCode()` shows a longer prefix than the original two characters,** capped at half
  the string so a short sequential code is not effectively printed in full. Still cosmetic:
  the real value is already on the device (known risk #2).
- **New tokens:** `--track` for the segmented control and search field, `--green-strong` for
  the hero figure (chosen to clear 3:1 at large sizes), `--orange-dark` for the urgent
  expiry line. The primary action colour is blue, so `.btn-take` is blue rather than green.
- **`/logo.png` is the full SingBuild lockup**, rendered height-driven with `width: auto`, so
  it can be swapped for a different crop without touching the layout.

The modals kept their existing styling. They share the same tokens so they still read as one
app, but they were not part of the supplied design and have not been reworked.

**No server-side scheduler, deliberately.** The monthly rollover is a client-side effect,
not a Cloud Function or Vercel Cron. Adding one means `firebase-admin`, a service-account
secret, and a deploy pipeline that doesn't exist here, for a job whose entire output is
"delete some documents once a month". The client-side version is safe because hiding is
decoupled from deleting and the sweep can't empty the tracker (see Month scoping). If
scheduled infrastructure ever arrives for another reason, moving the sweep there is a
clean win: it would no longer depend on someone having the app open.

---

## Known open risks

1. **Admin is not a security boundary.** The PIN is in the public bundle and `isAdmin` is
   plain React state, flippable in DevTools. Consequently `allow delete: if true` on
   `codes` is unavoidable: **anyone can delete every code.** Closing this needs Firebase
   Auth + custom claims.
2. **Unclaimed code values are readable.** The listener downloads the whole collection, so
   masking in the table is cosmetic only. Real protection needs the value in a separate
   doc gated by rules, or a Cloud Function that returns it on successful claim.
   **This extends to staged drops:** next month's codes are hidden from the UI, not from
   the network, so they can be read in DevTools before their month starts. Same mechanism,
   same fix. Worth knowing before staging a drop weeks ahead.
3. **Deployed rules can't be verified from the repo.** `firestore.rules` is the intended
   state; the live rules are whatever is in the Firebase console. Keep them in sync manually.

---

## Operations

### Verify before pushing

```bash
npx eslint .        # must be clean
npm run build       # must pass
```

A build passing is **not** evidence a Firestore change works. Nothing here is exercised
against a live database. Behaviour changes need the manual checks below.

### Deploying rules (not automatic, merging does nothing)

1. Firebase Console → Firestore Database → **Rules**
2. **Copy the existing rules to a text file first.** That's the rollback.
3. Paste in `firestore.rules`, **Publish**
4. Immediately on the live site: take a code, then release it. This is the only way to
   verify the `request.time` checks (gotcha #4).
5. If Take fails: console shows `permission-denied` → restore the saved rules.

**Rules and app code that change together must be published together.** Vercel deploys on
merge; rules do not. Any release that adds or renames a field on `codes` has a window
between the two where writes fail with `permission-denied`, because the `hasOnly()`
whitelist rejects the new shape. Publish the rules first: they are backwards-compatible
with the currently deployed app in a way the reverse is not (a new *allowed* key is
harmless to a client that never sends it).

Symptom of getting this wrong: adding a code shows "Failed to add code", and the console
shows `permission-denied` on `codes`.

### Manual test checklist for Firestore changes

- Take a code → reveal screen shows the code → row updates to Taken
- Copy Code → paste elsewhere to confirm it really copied
- Admin: add single code, bulk add (**check order is preserved**), duplicate is skipped
- Bulk delete, release a code → **appears in Release History**
- Export CSV → opens correctly in Excel
- **Offline (airplane mode):** Take shows a clear error, not a frozen button;
  Add shows "Failed to add code" **and the typed text is still in the box**

That last one is the clearest signal the error handling is intact.

### Testing drop scheduling

The behaviour is time-dependent, so the only honest test is to move the clock. Change the
**OS** date (not just a JS variable, `new Date()` reads the system clock) and reload:

- **The top-up case, and the one most worth re-checking after any change to the cleanup:**
  with codes already live for this month, set Drop Month to the **current** month and add
  more. Nothing may be deleted, the earlier codes stay claimable, and the count goes up by
  exactly what you added. Repeat it two or three times. A month running out of codes and
  being topped up is normal operation, not an edge case.
- **Migration:** with only unlabelled codes on file, load the app. They must still be
  visible and claimable, nothing is deleted, and a "No Drop Month" notice appears in Code
  Manager. Top up the current month and confirm they *still* aren't deleted.
- Set Drop Month to next month, bulk add → the new codes do **not** appear in the table,
  they show under Scheduled Drops with a "Staged" badge, and this month's codes are still live
- Roll the OS clock to the 1st of that month, reload → staged codes are now live, last
  month's are gone from the table *and* from Firestore, and the Activity Log gains a
  `<Month> started: removed N expired code(s)...` entry
- Stage two future months, then roll into the first → the second must still be staged, not
  deleted
- **The important one:** with *only* expired codes on file (nothing for this month), roll
  the clock forward → the table shows "No codes for <month>" and they are hidden, but
  **still present in Firestore**. The sweep must refuse to run. If they get deleted here,
  the `live.length > 0` guard is broken and the tracker can be emptied.
- Set the clock a month *ahead* of live codes → nothing is deleted (same guard)
- Claim a code, then roll into the next month → the expired taken code is removed too, and
  the log entry notes how many had been taken
- "Assign to <month>" on the No Drop Month notice → the codes stay live, and are then
  removed automatically at the next month boundary. This exercises the LABEL rule; a
  `permission-denied` here means the deployed rules predate it.

Reset the clock afterwards. Anything written while the clock was wrong keeps that
`monthKey`, so clean up test codes before switching back.

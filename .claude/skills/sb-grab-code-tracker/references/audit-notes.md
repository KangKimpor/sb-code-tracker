# Firestore and Browser Gotchas, Code Conventions

Read this file when writing or debugging any Firestore query, rules change, or
clipboard/CSV/download code, or when reviewing whether existing conventions are being
followed. Verified against the actual code, not assumed.

---

## Firestore Gotchas (the expensive lessons)

These caused real, silent bugs in this project. They generalise to any Firestore app.

### 1. A range query's bound must be the same type as the stored field

Firestore indexes order values **by type first, then by value**, and a range scan is confined
to the bound's own type band. Comparing a Timestamp field against a plain number matches
**nothing**: no error, no warning, just an empty result set.

```js
// BROKEN: releasedAt is a Timestamp, cutoff is a number -> 0 results, always
where("releasedAt", ">", Date.now() - MONTH_MS)

// CORRECT
where("releasedAt", ">", Timestamp.fromMillis(Date.now() - MONTH_MS))
```

This shipped and made the entire Release History feature permanently empty, while its "No
releases in the past 30 days" empty state made it look like normal behaviour.
`activityLog.ts` is a number and was correctly compared as one. The bug was only where the
types diverged. `topupRequests.ts` is also a number, deliberately, so it follows the
`activityLog` pattern.

**Rule of thumb:** if a field is written with `serverTimestamp()`, every query bound against
it must be a `Timestamp`.

### 2. `writeBatch` caps at 500 operations

An unbounded `getDocs(...)` fed into a single batch works fine in testing, then fails
permanently once the collection grows past 500. Always chunk:

```js
for (let i = 0; i < docs.length; i += 400) {
  const batch = writeBatch(db);
  docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
  await batch.commit();
}
```

The 400 chunk size appears in several places. `deleteIdsIn(collName, ids)` is the shared
helper for deleting by id; `deleteDocsInChunks(docs)` is the one for snapshots from `getDocs`.
Use them rather than writing a fifth copy of the loop.

### 3. Prefer `writeBatch` over `Promise.all` for multi-document writes

`Promise.all(items.map(addDoc))` rejects on the *first* failure while the rest keep running,
leaving a partial write with no record of what landed. A batch is atomic per chunk, and it is
one round trip per 400 docs instead of one per doc. `doc(collectionRef)` with no path
generates an auto-ID, exactly what `addDoc` does internally, so `batch.set(doc(codesRef),
data)` is the batch equivalent of `addDoc`.

### 4. The Rules Playground cannot test `serverTimestamp()`

The standard way to force a server-side timestamp in rules:

```
request.resource.data.takenAt == request.time
```

This is correct and necessary: rules cannot tell that the *server* supplied the value, so
without it a client could write a fake time. **But the Playground makes you type a literal
timestamp, which will never equal `request.time`, so it always reports "Denied."** Rules
containing this check must be verified **live**, with the previous rules saved for rollback.
Do not panic at a Playground denial on these lines.

### 5. `is int` vs `is number` in rules

Rules treat `int` and `float` as distinct types; `is number` accepts both. JavaScript has one
number type, so whether `Date.now()` arrives as `integerValue` or `doubleValue` depends on SDK
serialisation. **`is int` is verified working** for `codes.createdAt`, `activityLog.ts` and
`topupRequests.ts`, confirmed by successful writes after publishing. Keep it. If a future SDK
change breaks code creation or silently stops logging, relax those lines to `is number`.

### 6. `serverTimestamp()` reads as `null` in the local snapshot

`onSnapshot` fires optimistically before the server acknowledges, so a freshly written
`serverTimestamp()` field is briefly `null`. `toMs()` and `formatTime()` return `""` for this,
so it shows as blank for a moment. Expected; do not "fix" it.

### 7. Reading a field that does not exist is an *error* in rules, and denies the write

Not `null`, not `undefined`, but an error, which fails the whole condition. So a rule that
freezes a field across an update breaks the instant one document is missing that field:

```
// BREAKS for any doc written before monthKey existed: reading resource.data.monthKey
// errors, the CLAIM branch evaluates false, and the code becomes unclaimable forever.
&& request.resource.data.monthKey == resource.data.monthKey

// CORRECT: Map.get(key, default) is total. The same default on both sides means
// "absent on both" compares equal, so unlabelled codes stay claimable.
&& request.resource.data.get('monthKey', '') == resource.data.get('monthKey', '')
```

This matters most when **adding a field to an existing collection**: the rule is written
against the new shape, every existing document has the old shape, and the failure mode is a
total outage of the app's core action rather than a visibly broken feature. Here, unlabelled
codes were the live set immediately after deploy, so a direct comparison would have meant
*nobody could take a code at all* until the next drop landed.

Use `.get(key, default)` for any field that is optional in practice, and
`'field' in resource.data` when branching on presence.

### 8. A brand-new collection is denied by default, and it fails quietly

The catch-all `match /{document=**} { allow read, write: if false; }` denies any collection
without its own block. Shipping app code that writes a new collection before publishing the
rules means every write fails with `permission-denied`.

**This has already happened once in this project.** The `topupRequests` block was merged and
deployed while the live rules were an older version, so the top-up feature was live and
completely dead: staff taps failed with one alert they would ignore, and the admin count
simply never appeared. Nothing about it looked like a rules problem.

Publish rules first. `references/operations.md` has a read-only probe that detects this.

### Rules are safe to commit publicly

Rules are enforced server-side; knowing them grants nothing. Firebase's own tooling assumes
`firestore.rules` lives in version control, and collection and field names are already visible
in the client bundle. **Never commit:** service account JSON, Admin SDK private keys, `.env`
files. **Safe to commit:** `firestore.rules`, `firebase.json`, `VITE_FIREBASE_*` values.

### What the rules actually permit

`codes` allows exactly three transitions, and `code` and `createdAt` are immutable:

- **CLAIM:** available to taken, requires a non-empty `takenBy` under 60 chars and
  `takenAt == request.time`.
- **RELEASE:** taken to available, nulls `takenBy` and `takenAt`.
- **LABEL:** set `monthKey` on a doc that has none. Restricted with
  `!('monthKey' in resource.data)` so a code can never be moved between drops, which would
  allow dodging cleanup or unhiding a staged drop early.

`monthKey` format is validated (`^[0-9]{4}-(0[1-9]|1[0-2])$`) because the whole month scheme
relies on zero-padded, string-sortable keys. It is deliberately **not** validated against the
current month: `request.time` is UTC and staff are UTC+7, so that would reject legitimate
writes for the first 7 hours of every month.

---

## Browser Gotchas

### `document.execCommand("copy")` returns `false`, it does not throw

```js
const ok = document.execCommand("copy");
document.body.removeChild(ta);      // clean up BEFORE throwing
if (!ok) throw new Error("copy_failed");
```

Ignoring the return value means showing "Copied ✓" on a failed copy, and this app's UI tells
users to rely on that confirmation, so a false positive is the worst outcome. iOS Safari also
needs `ta.setSelectionRange(0, text.length)`, not just `ta.select()`.

### Blob downloads need the anchor in the DOM and a deferred revoke

```js
document.body.appendChild(a);   // Firefox ignores click() on a detached anchor
a.click();
document.body.removeChild(a);
setTimeout(() => URL.revokeObjectURL(url), 1000);   // sync revoke can cancel the download
```

Both failures are silent. Add `"\uFEFF"` to the front of CSV content so Excel detects UTF-8.

### `localStorage` throws, it does not return null

Safari private browsing, blocked cookies, and exhausted quota all make `localStorage.getItem`
and `setItem` **throw**. This app wraps every access in `readLocal`/`writeLocal` so it degrades
to "this device remembers nothing" rather than breaking the page. Never call `localStorage`
directly here.

`crypto.randomUUID` also needs a secure context, which rules it out for plain-http LAN
testing, hence the `Math.random` fallback in `getDeviceId`.

### `VITE_*` env vars are inlined into the public bundle

By design, not a misconfiguration. `VITE_ADMIN_PIN` is readable by anyone via DevTools,
confirmed by grepping the built output. Changing it in Vercel does not make it secret, it only
removes it from the public repo.

This cuts both ways usefully: the Firebase `projectId` and `apiKey` can be read straight out
of the deployed bundle, which is how the rules-drift probe in `references/operations.md` works
without any credentials. Note the values are emitted as **backtick** template literals, not
double-quoted strings, so grep accordingly.

---

## Code Conventions

### Every Firestore call needs a `catch` with user-visible feedback

These are `async` functions wired straight to `onClick`. Without a `catch`, a failure is an
unhandled promise rejection the user never sees:

```js
const addCode = async () => {
  setNewCode("");
  try {
    await addDoc(codesRef, {...});
    log("add", `${t} added`);
  } catch (err) {
    console.error("addCode failed:", err);
    setNewCode(t);                                  // restore input, do not lose their work
    alert("Failed to add code. Please try again.");
  }
};
```

`alert()` is the established pattern for failure feedback here.

- **If you clear an input before `await`, restore it in the `catch`.** Otherwise a failed write
  silently destroys what the user typed. `addBulk` does this too, restoring the whole paste.
- **`try`/`finally` with no `catch` still leaks the rejection.** `finally` runs, so optimistic
  state gets rolled back and the UI snaps back with no explanation, which reads to the user as
  "my click did not register".

`log()` is the one intentional exception: it ends in `.catch(() => {})` because audit logging
must never block a staff member from taking a code.

**Background effects never `alert()`.** The cleanup sweep fires unprompted on load, so an
error popup for a background chore would just block someone trying to grab a code. It
`console.error`s. The manual admin equivalents (`clearStale`, `deleteDrop`, `labelUnlabelled`,
`removeUnlabelled`) do alert, because a human clicked them.

### Remember device-local state only after the write confirms

```js
await addDoc(topupReqRef, entry);
writeLocal(LS_REQUEST, JSON.stringify(mine));   // only now
```

Reversing this locks the button for six hours on a request that never landed.

### Write the source of truth first, derived records after

```js
await updateDoc(codeRef, { status: "available", ... });   // source of truth
if (code) await addDoc(releaseHistRef, {...});            // derived audit record
```

The reverse order created a permanent record of a release that never happened when the update
failed. A *missing* audit row is recoverable; a *phantom* one is a lie in your data. The inner
`addDoc` keeps its own `.catch` so an audit-write failure does not trigger a misleading "Failed
to release" alert when the release actually succeeded.

### Claim integrity

`takeCode` uses `runTransaction`: read the doc, verify `status === "available"`, then update.
Throwing a plain `Error("already_taken")` inside the callback aborts without consuming a retry
(correct, a conflict is not transient), while genuine contention is retried by the SDK.
Single-document scope makes partial writes structurally impossible.

**Do not replace this with a plain `updateDoc`.** It is the only thing preventing two staff
from claiming the same code simultaneously.

`runTransaction` requires connectivity and cannot be queued offline, so Take will never work
offline. Release (a plain `updateDoc`) can queue.

**The row is optimistic, the reveal is not.** `optimistic` flips the row instantly, but
`revealedCode` is only set after the transaction confirms, so a loser in a race never sees
"Your Code".

### Listeners

Four `onSnapshot` listeners, all with `return () => unsub()` cleanup:

1. `codes`: always on
2. `activityLog`: lazy, only while Code Manager is open
3. `releaseHistory`: lazy, only while Code Manager is open
4. `topupRequests`: gated on `isAdmin`, **not** on Code Manager

Keep the lazy pattern (`if (!codeManager) return;`), it exists to conserve free-tier quota.
Only the `codes` listener sets the `connError` banner; the others log to console only.

`topupRequests` is gated differently because the badge must be visible on the main screen
without opening anything. Staff never subscribe, they only write, so the read cost falls on
the one admin device. Its cleanup also clears the array so a stale count cannot flash on the
next login before the first snapshot lands.

**Avoid composite indexes.** Index deployment here is a manual console step with no
`firebase.json`, so a query needing one works in nobody's environment until someone clicks a
link in an error message. Range-filter and order by the *same* field, then filter the rest
client-side, which is what both `activityLog` and `topupRequests` do with `ts`.

### Defensive patterns worth keeping

```js
if (err?.message === "already_taken")     // a null err would throw inside the catch,
                                          // skipping setTakeBusy(false) -> frozen button
data.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))   // NaN = inconsistent comparator
`Taken by ${c.takenBy || "-"}`            // avoid rendering literal "null"
expiry.days !== null && expiry.days <= 7  // null <= 7 is TRUE in JS; the guard is load-bearing
```

That last one matters: `monthExpiry` returns `days: null` for any month that is not the current
one and for a malformed key. Without the explicit null check the staging nudge fires on a stale
key.

### Timestamp formatting

- `formatTime` gives `27 Jul 14:32`: main list, "took at"
- `formatTimeShort` gives `27 Jul 14:32:05`: Activity Log, Release History, top-up requests
  (keeps seconds because entries can land in the same minute)

Both omit the year: the retention window is 30 days, so a year never disambiguates. `toMs()`
handles Firestore Timestamps, plain numbers and null uniformly. Always route timestamps
through it.

### `MONTH_MS` is 30 days, not a calendar month

`MONTH_MS = 30 * 24 * 60 * 60 * 1000` is an approximation used for log retention windows and
query cutoffs. It is unrelated to `monthKey`, which is a real calendar month. Do not conflate
them: using `MONTH_MS` for anything month-scoped will drift.

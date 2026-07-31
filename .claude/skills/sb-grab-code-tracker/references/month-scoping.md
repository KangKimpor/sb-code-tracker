# Month Scoping, Drop Scheduling, and Automatic Cleanup

**Read this before touching anything involving `monthKey`, drop scheduling, expiry, the
cleanup sweep, or any empty state. This is the only subsystem in the app that deletes
documents unprompted.**

---

## The business rule

**A Grab code only works during the calendar month it was issued for.** Next month's codes are
added a few days before month end and must stay hidden until that month begins, at which point
the previous month's codes stop working and are removed.

**A month can also run out of codes and get topped up part-way through.** This is normal
operation, not an edge case, and it is why staleness is driven purely by the calendar and never
by new codes arriving. Codes added for the current month join what is already there, all
equally live, however many times it happens. **Only a month boundary makes anything stale.**

Breaking that distinction is the easiest way to destroy live codes, so it is worth restating in
any future change to the cleanup.

---

## `monthKey`

Nothing about a code string reveals which month it belongs to, so `monthKey` (`"YYYY-MM"`) is
the only record of it.

**The month is always zero-padded, and that is load-bearing.** It makes plain string comparison
chronological (`"2026-09" < "2026-10"`, `"2026-12" < "2027-01"`), which is why the partition is
three `===`/`<`/`>` checks with no date parsing. An unpadded `"2026-9"` would sort *after*
`"2026-10"` and the code would expire two months early. Hence the regex in `firestore.rules`,
and why `monthKeyOf` is the only place keys are built.

### Local clock, not UTC, in the app *and* in the rules

Months resolve from `new Date()` on the client, so the switchover happens at **local**
midnight. Staff are in UTC+7 and expect the 1st to mean their 1st.

This is also why `firestore.rules` deliberately does **not** validate `monthKey` against the
current month. `request.time` is UTC, so a rule requiring "monthKey equals the server's month"
would reject every legitimate claim during the first 7 hours of each month in ICT. The rules
validate the *format* only. Do not add a server-side month check without solving the timezone
problem first.

---

## The partition

`partitionCodes(list, month)` is module-level and pure, so both the cleanup effect and the
render path can use it without it becoming an effect dependency.

| Bucket | Condition | Behaviour |
|---|---|---|
| `live` | `monthKey === nowMonth`, **plus every unlabelled code** | shown in the list, claimable, counted in the hero |
| `staged` | `monthKey > nowMonth` | hidden from the list; visible to admin under Scheduled Drops. **Never deleted by cleanup**, it is queued work rather than a leftover |
| `stale` | `monthKey < nowMonth` | hidden immediately, then deleted |
| `unlabelled` | no `monthKey` | also counted in `live`, and reported separately so admin can resolve it |

It runs **on the render path**, so hiding is instant and write-free. That decoupling is what
makes the delete safe: stale codes vanish from the list through the filter, with no writes,
even if the delete never happens. Staff can never claim a dead code regardless.

### Unlabelled codes are never dated by the app

Codes written before this field existed have no `monthKey`, and a code string carries no clue
about its month, so there is no honest way to infer one. They stay live and are never deleted
automatically. Admin resolves them once, from the "No Drop Month" notice in Code Manager, by
either assigning the current month (`labelUnlabelled`, putting them into the normal lifecycle
so they expire on their own) or removing them (`removeUnlabelled`). After that every code in
the collection has a month and the ambiguity is gone for good.

**Deriving their month from `createdAt` looks tempting and is wrong:** codes are added days
before the month they are for, so a July code typically has a June `createdAt` and would be
deleted the moment it went live.

---

## The cleanup sweep, and the invariants that make it safe

A `useEffect` keyed on `[codes, loading, connError, nowMonth]`. There is **no server-side
scheduler** in this project, so it runs client-side on whatever browser happens to be open,
trusting that device's clock. Three things keep that from being dangerous:

1. **Hiding is separate from deleting.** Covered above.
2. **The sweep refuses to run unless the live set is non-empty** (`live.length > 0`). It can
   only ever trim the tracker down to codes that still work; it can never empty it. A device
   with its clock set a month ahead sees this month's codes as stale, but it would also need
   codes for its own wrong month to pass the gate, and it has none, so it skips.
3. **It never touches staged drops.**

The `sweep` ref carries `busy` (a snapshot arriving mid-flight cannot start the same deletes
twice) and `failedMonth` (one failure stops further attempts that month, so a permission error
cannot turn every snapshot into another round of failing batches). Skipped while `connError` is
set or `loading`.

**Do not gate the sweep on a month-keyed "already done" flag.** Stale codes can appear after a
successful sweep, for instance when someone adds a code from the Firebase console, and a
blanket month lock would ignore them until the next reload.

**The sweep never calls `alert()`.** It fires unprompted on load; an error popup for a
background chore would block a staff member trying to grab a code.

`clearStale` is the manual escape hatch: it removes expired codes even when this month has none
of its own yet, which is the one case the sweep deliberately refuses to touch. It is also what
an admin reaches for if the sweep failed on a permission error.

---

## The month ticker

A 60-second `setInterval` re-checks `currentMonthKey()` and updates `nowMonth`. Nobody reloads
this page: it sits open on a shared device for days, so the switch from one month's codes to
the next has to be noticed while the app is running. `setState` with the same key is a no-op,
so this causes no re-renders in the normal case.

A second effect clamps `dropMonth` so the picker never points at a month that has already
passed, which is possible if the manager was left open across midnight on the 1st.

---

## Expiry copy

`monthExpiry(month)` returns `{ text, urgent, days, label }`.

- `text` is the hero sub-line: "Expire in 5 days (31 Aug)", "Expire tomorrow", "Expire today".
- `urgent` is true at 3 days or less, which colours the line orange.
- `days` is the raw whole-days-remaining count, used by the admin staging nudge.
- `label` is the last date of the month, e.g. "31 Aug".

**`days` is `null` whenever it would be meaningless**, meaning any month that is not the
current one, and any malformed key. That is deliberate: it forces callers to null-check instead
of quietly treating "not this month" as "expires today". `null <= 7` is `true` in JavaScript,
so a missing guard silently fires the nudge on a stale key.

`days` is computed as `last.getDate() - now.getDate()`, which is only valid because the
function early-returns unless `month` is the current month. The window it drives therefore
opens on a *date that shifts with month length*: 7 days out is the 24th in a 31-day month and
the 21st in February.

---

## Admin alerts built on top of this

Both live in an `adminAlerts` array in the derived section, admin only, purely advisory.

| Alert | Condition |
|---|---|
| `low` | `total > 0 && avail <= LOW_STOCK_THRESHOLD` (3) |
| `out` | `total > 0 && avail === 0` |
| `unstaged` | `expiry.days !== null && expiry.days <= STAGE_REMINDER_DAYS` (7) and next month has zero staged codes |

`low` and `out` are mutually exclusive, so at most two banners show.

**`unstaged` is the one that matters.** Running dry mid-month is visible to everyone the moment
it happens, and staff have the top-up button for it. Next month never being staged is worse
precisely because it is invisible: the tracker empties itself at midnight on the 1st with
nobody watching, and the first sign is 30 people who cannot book a ride.

Why the specific gates:

- **`total > 0` on the stock alerts.** With nothing on file the hero already says "No codes for
  <Month>" and the empty state says what to do. More importantly, "you have run out" is the
  wrong description of a month that was never filled.
- **Next month specifically, not "anything staged".** `stagedCodes` covers every future month,
  so the check must be `c.monthKey === shiftMonthKey(nowMonth, 1)`. Staging September does not
  help if August is empty.
- **Seven days, not the whole month.** A banner that sits there all month is one people learn
  to scroll past.
- **No dismiss button.** Each alert clears itself when the thing it asks for is done, which is
  a stronger guarantee than a dismissal that hides an unfixed problem. Dismissal would also
  need persistence to survive a reload, and a dismissed "nothing staged" is exactly the outage
  this exists to prevent.

**Each alert's button opens Code Manager and sets `dropMonth` to the month that alert is
about:** current month for a top-up, next month for staging. This is error prevention, not a
shortcut. Drop Month silently decides whether codes go live immediately or in a month, and it
persists across manager opens. Without the pre-set, the two realistic mistakes are pasting a
top-up into next month's staged drop (the live pool stays empty and nobody notices) and pasting
next month's batch into the live pool (codes go out weeks early). Both are consistent with the
alert the admin just tapped, which is what makes them easy to make.

---

## Duplicate detection is per month

`addCode` and `addBulk` dedupe within the target month only. The same code string legitimately
reappears in a later month's batch, and skipping it because a dead code from two months ago had
the same value would silently drop a code from the new drop.

---

## Other things that depend on this

- **Empty-state copy** has four variants: no search results, no codes for this month, a staged
  drop is ready and goes live on the 1st, and everything claimed. Telling them apart matters
  because "no codes yet" while 40 sit ready for next month reads as a bug.
- **Top-up requests are scoped to `nowMonth`** on the render path, like codes. An unanswered
  request from last month is history, not a queue, and the codes it asked for no longer work.
- **CSV export includes every code on file**, staged ones too, with `Drop` (the month) and
  `Drop Status` (live / scheduled / old) taken from the same partition the UI uses.
- **`describeDrops`** uses `"~"` as the unlabelled sentinel, relying on `~` sorting after
  digits.

---

## Testing this

Behaviour is time-dependent, so the only honest test is to move the **OS** clock, not a JS
variable, since `new Date()` reads the system clock. Reset it afterwards, and clean up test
codes before switching back: anything written while the clock was wrong keeps that `monthKey`.

Full checklists, including the top-up invariant test and the admin alert tests, are in
`references/operations.md`.

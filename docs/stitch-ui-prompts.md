# Stitch prompts: SB Grab Code Tracker UI redesign

Copy-paste prompts for [Google Stitch](https://stitch.withgoogle.com/) to redesign the
staff-facing UI of this app. Everything Stitch needs is written into the prompts, so no
knowledge of the codebase is required to use them.

---

## How to use this file

Stitch works best with **one screen per prompt**, and **one or two changes per follow-up**,
rather than a single prompt describing the whole app. It also offers two quality modes, the
higher-quality one having a smaller monthly generation quota.

Recommended run order:

1. Set the canvas to **Mobile** (see [Mobile or desktop](#mobile-or-desktop) if that is
   wrong for your staff).
2. Run **Prompt 1** on the higher-quality mode. This establishes the design system that
   every later prompt inherits.
3. Run **Prompts 2 to 5** on the standard mode, in order. Each one says "keep the same
   design system", which is what carries the visual language forward.
4. Use **Prompt 6** one line at a time, reviewing the result before the next.
5. Read [Constraints when porting back](#constraints-when-porting-back) before rebuilding
   anything in `src/App.jsx`.

Sources for the guidance above: [Stitch prompt guide on the Google AI Developers
Forum](https://discuss.ai.google.dev/t/stitch-prompt-guide/83844), [Stitch announcement on
the Google Developers Blog](https://developers.googleblog.com/stitch-a-new-way-to-design-uis/),
and a [feature and quota overview](https://uithings.com/what-is-google-stitch).
Content was rephrased for compliance with licensing restrictions.

---

## App context

Background for you, not for pasting. It is the reasoning behind what the prompts ask for,
so you can write your own prompts later without rereading the code.

| Fact | Why it changes the design |
|---|---|
| A code only works during its calendar month | Expiry has to be visible, or staff claim a code that will not redeem |
| Roughly 40 codes per month for around 30 staff | Scarcity is the main thing a person wants to know on arrival, so availability beats statistics |
| Codes get topped up mid-month when they run low | "None left" is temporary, not an error, and the copy should say so |
| One code per claim, claimed for good | The claim needs a confirmation step and a final, memorable reveal |
| Two people can tap at the same instant | A "someone just took it" state is a normal path, not an edge case |
| No login, staff type their first name | Nothing personalised can be enforced, only remembered on the device |
| Unclaimed codes are masked in the UI | Every client downloads the full list, so masking is the only thing standing between a curious person and a free code |
| Used on a phone, outdoors, in a hurry | One-handed reach, large tap targets, high contrast, no thin low-contrast text |
| The list syncs live between devices | Cards can change under the user's finger, so state changes need to read clearly |

---

## Prompt 1: the main screen

```
Design a mobile app screen for "SB Grab Code Tracker", an internal tool where
staff at a company claim a Grab promo code to pay for a work ride.

Context that shapes the design:
- Each code works only during the calendar month it was issued for. Right now
  it is August 2026, and these codes stop working after 31 August.
- Codes are a limited shared pool, roughly 40 per month for around 30 staff.
  When they run out, more get added mid-month. Staff care most about "is there
  one left for me right now".
- A code can only be claimed by one person. Two people may tap at the same
  moment, so the design must handle "someone just took it" gracefully.
- Staff use this on their phone, often standing outside in bright sun, in a
  hurry, one-handed, right before booking a ride.
- There is no login. A staff member types their first name when claiming.
- Codes look like "SB-4K92" or "GRABSB7X3M" and must be shown in a monospace
  font. Codes that nobody has claimed yet are deliberately masked, shown as
  the first two characters followed by dots, and only revealed to the person
  who claims one.

The screen needs:
- A header with the app name, a small pill showing the active month ("Aug 2026"),
  and a live-updating indicator because the list syncs in real time.
- A prominent summary of how many codes are left, framed as availability rather
  than raw statistics. Something like "12 of 40 still available" that a person
  can read in one glance. Include how long they remain valid.
- A filter for Available / Taken / All, and a search field for a code or a name.
- The list of codes as tappable cards, not a dense data table. Each available
  card shows the masked code and a large primary "Take" button. Each claimed
  card shows the code, who has it, and when they took it, in a visually
  de-emphasised style so the eye goes to what is still free.
- Comfortable thumb-sized tap targets and a layout that works one-handed.

Style: clean, calm, modern, iOS-like. Light background, white cards, generous
rounded corners around 14 to 20px, soft subtle shadows, system sans-serif
typography, and monospace only for code values. Use green for available, red
for taken, blue for primary actions and orange for warnings. High contrast so
it stays readable in sunlight. Do not use gradients or decorative imagery.
```

---

## Prompt 2: the claim sheet

```
Add a bottom sheet for claiming a code, opened by tapping Take on a card.

It asks for the staff member's first name in a single text field, with example
Khmer names as placeholder text like "e.g. Kimtong, Sothea, Hongsrun". Below
the field, make it clear the code stays hidden until they confirm, and that
claiming is final and assigns that code to them.

Include a confirm button and a cancel button. Show a loading state on the
confirm button while the claim is being checked, because it takes a second and
must not be tappable twice.

Also design an error state inside this same sheet for when someone else claimed
that code a moment earlier. The message should be reassuring and point them
back to picking another code, not feel like their fault.

Keep the same design system as the previous screen.
```

---

## Prompt 3: the reveal

The payoff screen, and the weakest part of the current UI.

```
Design the success screen shown immediately after a code is claimed. This is
the most important screen in the app and the current version undersells it.

The claimed code is the hero: very large, monospace, unmistakably readable at
arm's length, easy to read aloud, and easy to screenshot. Include the staff
member's name so it is obvious the code belongs to them.

Below it, in priority order:
- A large "Copy code" button with a clear confirmed state after tapping.
- A short reminder to screenshot or write it down, because this screen will not
  be shown again.
- Brief guidance on where the code goes: open the Grab app, enter it as a
  promo code before booking.
- The date it stops working.
- A done button to return to the list.

Feel: a small moment of reward, confident and celebratory but restrained. No
confetti animation, no cartoon illustrations. Keep the same design system.
```

---

## Prompt 4: the states that get skipped

```
Design four states for the code list screen, as separate variants.

1. Nothing available yet for this month, but next month's codes are already
   prepared and waiting. Explain that they unlock on the 1st, and show how many
   are ready, so it is clear nothing is broken.
2. Every code for this month has been claimed. Explain that more may be added,
   and show who to ask.
3. Connection lost. A non-blocking banner saying the list may be out of date,
   with a retry action, while still showing the last known codes underneath.
4. First load, as skeleton placeholders rather than a spinner.

Each should be calm and informative rather than alarming, and should tell the
person what happens next instead of only what is wrong. Keep the same design
system.
```

---

## Prompt 5: admin

The largest available UX win. Today this is one long scrolling modal.

```
Design an admin screen for the same app. Today everything lives in one long
scrolling modal and it is overwhelming, so break it into tabs or sections.

The admin manages monthly batches of codes, called drops. They add next month's
codes a few days before the month ends, and those stay hidden from staff until
that month begins.

Sections needed:
- Add codes: a month selector defaulting to the current month, a single-code
  field, and a bulk paste area for one code per line. Make it obvious which
  month the codes being added will belong to, since this is the single most
  consequential choice on the screen. Adding to the current month tops up the
  live pool; choosing a future month schedules it.
- Scheduled drops: upcoming batches grouped by month, each showing its code
  count, the date it goes live, and an option to delete the whole batch.
- Expired codes: batches whose month has passed, already hidden from staff,
  with a clear-now action.
- All codes: a searchable list with multi-select and bulk delete, where each
  row shows the code, which month it belongs to, and whether it is free or
  claimed and by whom.
- Activity log: a compact timeline of who claimed what and when, plus
  administrative actions.

Include the ability to release a claimed code back to the pool, for when
someone claims one by mistake.

Destructive actions need confirmation and should state exactly what will be
removed. Keep the same design system, with a slightly more information-dense
layout since this is an admin tool.
```

---

## Prompt 6: refinements

Run these individually, checking the output between each.

```
Make the available-code cards more visually dominant than the claimed ones.
```

```
Add a dark mode variant of the code list screen.
```

```
Remember the staff member's name on the device so returning users confirm with
one tap instead of retyping it.
```

```
Add a compact view toggle for when there are 40+ codes in the list.
```

```
Show a persistent hint of how many days remain before this month's codes expire.
```

---

## Constraints when porting back

The design can improve on everything visual, but these are load-bearing and cannot be
redesigned away without breaking the app or leaking codes.

**Masked until claimed is not decoration.** Every client subscribes to the whole `codes`
collection, so an unclaimed code value is already on the device and readable in DevTools.
Masking in the UI is the only thing that stops casual code harvesting. A prettier layout
that prints full code values hands them out without a claim being recorded.

**There is no identity.** The name is typed, not authenticated, and `isAdmin` is client
state behind a PIN that ships in the public bundle. Anything Stitch invents along the lines
of "my claimed codes", "reserve for later", or a per-person monthly limit can only be a
device-local convenience. None of it is enforceable, so do not present it as a rule.

**Claiming must stay a single confirmed transaction.** The claim runs inside a Firestore
transaction so two simultaneous taps cannot both win. Any redesign that claims optimistically
on tap, or splits claiming across screens, has to preserve the "you did not get it" path.

**Month scoping drives what is shown.** The table renders only the current month's codes.
Staged and expired codes are filtered out on the render path. A design that merges all
months into one list would show staff codes that do not work.

**Adding codes for the current month must never delete anything.** Topping up mid-month is
normal operation. Only a month boundary retires codes.

See `.kiro/steering/sb-code-tracker.md` for the full reasoning behind each of these.

---

## Mobile or desktop

The prompts assume phones, on the basis that the app has a 640px breakpoint that reflows the
table into cards, and that a Grab ride is booked on a phone.

The current layout is actually a fixed 1126px desktop shell with that phone breakpoint bolted
on, so it is worth deciding which one is primary before designing. If staff mostly use a
shared desktop, switch Stitch to **Web** mode and change the opening line of Prompt 1 to
"Design a responsive web app screen". The rest of every prompt carries over unchanged.

# UI, CSS, and the Two Traps

Read this before any design or CSS change. Both traps below fail silently: one took production
down as a blank page, the other produces dead code that looks correct on a desktop viewport.

---

## Trap 1: the CSS-in-JS landmine

**A backtick anywhere in the `styles` template literal takes the whole app down, and nothing in
the toolchain catches it.** This shipped once and produced a blank dark page in production.

```js
/* Each code is its own card. `.card` is kept as a wrapper */   // <- ends the literal
```

The backtick closes the template literal. What follows parses as a property access on the
resulting string plus a tagged template call, which is **valid JavaScript**, so `eslint` is
clean and `vite build` succeeds. It throws only when the module first runs:

```
Uncaught TypeError: "<the entire stylesheet>".card is not a function
```

Because it throws at module scope, `main.jsx` never renders, so `<style>{styles}</style>` never
reaches the DOM either. The result is an unstyled empty `#root`: the browser paints its own
dark canvas via `color-scheme: light dark` from `src/index.css`, which looks like a theming bug
and sends you hunting in entirely the wrong place.

The same applies to `${`, which would be read as an interpolation.

Check before pushing any stylesheet change:

```bash
python3 - <<'EOF'
src = open("src/App.jsx", encoding="utf-8").read()
s = src.index("const styles = `") + 16
body = src[s:src.index("\n`;\n", s)]
bad = [l for l in body.split("\n") if "`" in l or "${" in l]
print("BAD:", bad) if bad else print("stylesheet clean")
EOF
```

The `───` characters in the CSS section banners are box-drawing characters, not dashes or
backticks. Leave them alone.

### Verifying a UI change means running the bundle

The gap that let the backtick reach production: the redesign was checked by extracting the
stylesheet with a regex and rendering it in a standalone HTML page. The CSS looked perfect,
because a stray backtick is harmless inside a real `<style>` tag. Only the **JavaScript** was
broken.

`eslint` clean plus `npm run build` passing is not evidence the app runs. Serve `dist/` and
confirm React actually mounts and the stylesheet reached the DOM:

```js
// in the page, after loading the real built bundle
document.getElementById('root').childElementCount > 0            // must be > 0
[...document.querySelectorAll('style')]
  .reduce((n, s) => n + s.textContent.length, 0)                 // must be ~35000, not 0
getComputedStyle(document.body).backgroundColor                  // must be rgb(238,238,242)
```

Firestore is unreachable without `.env`, so the app sits on its loading or empty state, which
is enough to prove the module executed. Note two harmless artifacts of a local static server:
`/_vercel/insights/script.js` 404s (Vercel serves it in production), and emoji render as boxes
in a headless container with no emoji font.

---

## Trap 2: one stylesheet means source order decides everything

Every rule lives in one literal, so **a media query placed before the rule it overrides does
nothing at all**. A media query adds no specificity; when specificity ties, source order wins,
and `@media` blocks are not hoisted.

This bit the reveal redesign. The `SMALL PHONES` block sits near the top of the sheet, with the
main-screen rules it overrides (`.page`, `.hero`, `.t-row`, `.btn-take`), but the modal and
reveal rules are hundreds of lines further down. A `.reveal-code { font-size: 25px }` added to
that early block was dead: the base `.reveal-code` came later and won at every width.

It fails silently, and it looks correct on a desktop viewport where the override was never
meant to apply.

**So: put a phone override immediately after the rules it overrides,** unless what you are
overriding is already above the `SMALL PHONES` block. There are now two
`@media (max-width: 420px)` blocks, one near the top for the main screen and one at the end for
the reveal, and that duplication is intentional. `.admin-alert-btn` is defined above the first
block, so its override correctly lives there.

Verify an override actually applied rather than eyeballing it:

```js
await page.evaluate(() => getComputedStyle(document.querySelector(".reveal-code")).fontSize)
// at a 375px viewport this must report the override, not the base value
```

The same trap applies to plain specificity ties: `.btn-copy.copied` has to come after
`.take-btn.btn-sec`, because both are two-class selectors and only order separates them.
Moving either changes which colour a copied button is.

---

## The staff-facing layout

Rebuilt from a supplied design. Worth knowing before changing any of it:

- **One centred column, `max-width: 560px`, mobile first.** There is no longer a desktop table
  and a phone card view: it is the same card layout at every width, so there is only one thing
  to keep working. The old `.t-head` grid, `.t-num`, `.t-desktop-only` and `.t-mobile-info` are
  gone, along with the `!important` mobile overrides that used to fight the desktop grid.
- **One availability figure, not three stat cards.** `.hero` states "N of M available" with the
  expiry countdown under it. Staff asked one question here, so `taken` is no longer computed.
- **Each code is a card.** `.card` is now a transparent wrapper that exists only so the loading
  and empty states can occupy the same slot in the markup, which is why `.t-empty` and
  `.t-loading` carry their own card styling.
- **`maskCode()`** shows a prefix of up to 5 characters, capped at half the string so a short
  sequential code is not effectively printed in full. Still cosmetic: the real value is already
  on the device.
- **The primary action colour is blue**, so `.btn-take` is blue rather than green.
- **`/logo.png` is the full Singbuild lockup**, rendered height-driven with `width: auto`, so it
  can be swapped for a different crop without touching the layout. It doubles as the admin
  login control and is a real `<button type="button">` with an `aria-label`.

### The hero also carries two conditional elements

- **`.btn-topup`**, full width and blue, shown only when there is nothing to claim. It lives in
  the hero rather than the empty state so it cannot be hidden behind the Taken or All filter or
  a stray search term. Its sent state is green-tinted rather than dimmed: it is a confirmation,
  and a greyed-out button reads as a failure to someone who just pressed it.
- **`.admin-alerts`** sit above the hero, admin only. Deliberately not styled as cards: they
  should read as an interruption in the flow rather than another piece of furniture competing
  with the availability figure. Orange for warnings, red for urgent, with a white action button
  so the way out of the alert is obvious.

---

## The take modal: two states of one screen

The claim step and the reveal are **the same modal element**, built from the same parts so that
confirming reads as the code filling in rather than a jump to a different screen.

| Shared | Claim only | Reveal only |
|---|---|---|
| `.take-modal`, `.take-icon`, `.take-label`, `.take-btn` | `.claim-screen`, `.claim-code`, `.claim-note`, `.claim-field-label`, `.claim-input` | `.reveal-screen`, `.reveal-code`, `.reveal-sub`, `.btn-copy` |

**The code block keeps identical metrics in both states**, same 22px radius, 33px monospace,
and the same total height, so the card does not resize on confirm. The claim block uses 20px
padding plus a 2px dashed border while the reveal uses 22px padding and no border, which sums
to the same box. Measured at 89px tall at 474px wide and 75px at 375px, identical in both
states. **If you change one block's padding, change the other to match**, or the card will jump.

- **Claim state:** dashed border, `--surface-2` fill, `--text-4` text, showing
  `maskCode(takeModal.code)`. Dashed and muted reads as "not yours yet", and showing the mask
  rather than a placeholder lets someone confirm they tapped the row they meant. That mask is
  the one the list already shows, so it leaks nothing. Label reads `THIS CODE`, and the icon is
  a padlock.
- **Reveal state:** solid `var(--green)`, white text, soft `0 3px 10px` drop shadow. An earlier
  version used a heavier `0 6px 20px` glow, which read as a halo and made the block look
  detached from the card. Label reads `YOUR CODE`, and the icon is a party popper. The
  `THIS CODE` to `YOUR CODE` progression is the point: it states the change of ownership.
- **`.take-modal` is a separate class, not a change to `.modal`.** `.modal` is shared by the
  PIN, release, manager and both confirm dialogs, so the rounder 30px corners and roomier
  padding cannot go on the shared token without restyling all of them. It is applied
  unconditionally to this modal so both states share the card.
- **`.claim-input` is 16px for a functional reason, not a cosmetic one.** iOS Safari zooms the
  whole page when a focused input is under 16px, which on this screen would shove the confirm
  button off the viewport mid-claim. `.f-input` is 14px, and `.claim-input` sits after it in the
  sheet so it wins on source order.
- **The code stays monospace,** the only monospace on the screen. Grab codes get retyped into
  the Grab app, so `0` against `O` and `1` against `I` have to be distinguishable. This is the
  one deliberate departure from the mockup, which uses a geometric sans. It is a one-line change
  if Por ever prefers exact visual fidelity.
- The full code is **only ever rendered after the transaction confirms**. The claim state has no
  access to it beyond the mask, which is what stops a loser in a race from seeing a code.
- **The mockup has no "screenshot this" reminder, no expiry date, and no Grab redemption hint,
  and the implementation follows the mockup.** Dropping the reminder is only safe because a
  claimed code renders unmasked in the list, so it is recoverable by searching your own name.
  **If masking is ever extended to claimed codes, that reminder has to come back**, or the code
  becomes genuinely unrecoverable once the modal closes.
- Long codes wrap via `word-break: break-all` rather than overflowing. Verified with a 21
  character code at both 474px and 375px.

### Reaching it to test

The reveal is only reachable by claiming a code, which needs an available code **for the
current month**. If every code is staged for next month, there is no Take button and the screen
cannot be reached at all. This has already caused a false "the redesign is missing" report.

To see it out of season: as admin, add one code with Drop Month on the **current** month, then
claim it. That test code cleans itself up at the next month boundary, since the sweep removes
expired codes once the new month has live ones.

---

## Modals

All six share `.modal`, are closable by Escape (one `window` keydown listener, checked in
stacking priority order) and by overlay click. `.modal.wide` is the Code Manager: 520px,
`max-height: 88vh`, scrolling.

Adding a modal means: a state flag, a JSX conditional, spring easing on entry
(`--ease-spring`), and **adding it to the Escape handler's priority order**. Forgetting the
last one is the usual bug.

Known accessibility gaps, not yet addressed: modals have no `role="dialog"` or focus trap
(though Escape and `autoFocus` are handled), and the code rows and manager rows are `div`s with
`onClick` rather than buttons.

---

## Dark mode is currently half-broken

`src/index.css` sets `color-scheme: light dark`, so native controls render dark in dark mode,
while App's injected `:root` forces a light palette and wins on `--bg`. The result is dark
native controls against light cards. Either finish dark mode properly or drop that one line.
Do not delete `index.css` wholesale; see Known Design Decisions in `SKILL.md`.

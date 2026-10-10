# SingBuildBot — SB Grab Code Tracker on Telegram

This service adds the tracker workflows to [@SingBuildBot](https://t.me/SingBuildBot).
The website and bot use the **same `sb-code-tracker` Firestore database**. There is
no copied inventory, separate voucher pool or Gemini dependency. The bot's
`/app` button opens the website. It is separate from `sb-groupchat-bot`, whose
bot is `SingBuildGroupChatBot` and whose features are chat recaps and exports.

## Feature map

| App workflow | Telegram workflow |
| --- | --- |
| Available / taken / all tabs, refresh | `/codes [available\|taken\|all] [page]` and buttons |
| Search staff / displayed code label | `/search <text>` |
| Stock counts, expiry, low stock and queue count | `/status` |
| Staff name, claim and copy a voucher | `/name`, Claim buttons, `/take <ID> [name]`; select and copy the private reply |
| Retrieve a claimed voucher | `/mine` reveals current claims made by this Telegram account |
| Request top-up and six-hour cooldown | `/topup` and confirmation button |
| Admin PIN / logout | `/admin`, then send PIN privately; `/logout` |
| Code manager and filters | `/manager [all\|available\|taken] [YYYY-MM\|live\|expired\|unlabelled] [page]` |
| Single / bulk add and future drops | `/add [YYYY-MM] <codes>`, `/schedule YYYY-MM <codes>`; comma or newline separated, up to 200 per paste |
| Review drops and remove an incorrect drop | `/drops`, `/delete_drop YYYY-MM` and buttons |
| Select individual / all / available / taken codes | Manager Select buttons, `/select all\|available\|taken\|none\|<IDs>` (all/status respects the last manager scope) |
| Delete single / selected codes | `/delete <IDs>`, `/delete_selected`; review and confirm |
| Release and save previous taker/device/time | `/release <ID>` and manager buttons |
| Remove expired codes | `/clear_expired` |
| Adopt / remove unlabelled legacy codes | `/label_unlabelled`, `/remove_unlabelled` |
| Release history and activity | `/history [page]`, `/activity [page]`, last 30 days |
| Review / resolve current top-up queue | `/requests [page]`, `/clear_requests` |
| Clear records older than 30 days | `/clear_logs` (activity, releases and requests) |
| CSV export | `/export`: every drop plus the last 30 days of release history; UTF-8 BOM and formula protection |

`/start` provides the menu, `/help` lists all commands, and `/cancel` cancels
prompts and outstanding confirmation buttons. Admin features require the
numeric Telegram user ID in `ADMIN_USER_IDS` **and** the existing six-digit PIN.
Sessions last one hour; confirmation buttons and prompts expire after five
minutes. A hostname or Telegram username is not an admin identity.

Staff access is open, like the app. Names remain staff-entered labels rather
than verified employee identities. Browser device IDs and Telegram account IDs
are different: a name alone cannot link accounts or grant `/mine` access to a
claim made in the browser. Both interfaces show the shared claim's name and
time. Telegram claims use `takenDevice: "telegram:<numeric ID>"`.

## Deployment

The source and Render blueprint are ready, but code alone cannot activate an
existing Telegram bot. Deployment needs its BotFather token, a Firestore runtime
service account and the bot host. Keep these credentials in the host's secret
settings; **do not send them in Telegram commands, commit them, or put them in
`VITE_*` build variables**.

1. Merge this change or configure the service to use its feature branch. On
   Render, create a Blueprint from `KangKimpor/sb-code-tracker` using the root
   `render.yaml`. Alternatively create one Python web service with the build
   and start commands from that file. Run **one instance**. Render's free
   service can sleep, so cold starts delay replies; an always-on plan removes
   that delay and may incur charges.
2. Create/select a service account for **`sb-code-tracker`**, grant Firestore
   data access (`roles/datastore.user`), and upload its JSON key as Render Secret
   File `tracker-service-account.json`. Its mounted path must match
   `GOOGLE_APPLICATION_CREDENTIALS`. Do not reuse a broadly privileged hosting
   deployment key for the bot. On a Google host, prefer an attached service
   account / Application Default Credentials over a downloaded key.
3. Set `TELEGRAM_BOT_TOKEN` to the token for **@SingBuildBot**, `ADMIN_PIN` to
   the tracker's existing six-digit PIN, and `ADMIN_USER_IDS` to comma-separated
   numeric IDs for tracker administrators. The bot checks its Telegram username
   before processing updates and refuses a token for the group-chat bot.
4. Generate a random secret locally, for example
   `python -c 'import secrets; print(secrets.token_urlsafe(48))'`. Store it as
   `WEBHOOK_SECRET`. Set `WEBHOOK_URL` to the service's public HTTPS origin,
   for example `https://singbuild-tracker-bot.onrender.com`, with no trailing
   path. Keep `TRACKER_APP_URL=https://sb-code-tracker.web.app` or set the
   verified app URL. Restart/redeploy after adding settings.
5. Startup registers `/telegram` as the webhook and sets the Telegram command
   menu. The webhook requires Telegram's secret-token header; the secret is
   never placed in the URL. Use Render's default TCP health check; this service
   does not expose a public `/` HTTP health page. Before switching a bot with an
   existing deployment, stop that deployment so two processes cannot replace
   each other's webhooks. Do not drop pending updates during the switch.
6. Verify `/start`, `/status`, `/codes`, wrong and correct PIN login, logout,
   add/schedule, one test claim, `/mine`, release/history, a top-up, its duplicate
   rejection, a small confirmed deletion and CSV export. Verify that the app
   sees the same records and that a released **bot-created** code can be claimed
   in the app. Use designated test vouchers and remove only those afterwards.

The current website is the compatibility frontend described in
[connection-recovery.md](../docs/connection-recovery.md). This bot uses the Admin
SDK, so it works without deploying the staged Cloud Functions or changing the
website's Firestore rules. **Do not deploy `firestore.rules`, restore the secured
frontend or set `SECURITY_BACKEND_READY` just to launch this bot.** The website's
existing anonymous access and browser admin PIN limitations still apply.

The supplied legacy and staged rules deny unknown/server-only collections.
Confirm that deployed rules also deny client access to `_rateLimits`,
`_requestCooldowns` and `_telegramOperations`. Receipts can contain claimed
vouchers; they must remain server-only. Optionally enable Firestore TTL on
`expiresAt` for those three collections. Without TTL, receipts/rate buckets remain
stored; rate windows still expire normally. Bot writes also mirror
`codeInventory` to support a later secured frontend; the website's legacy writes
do not maintain that mirror, so the existing migration is still required before
the secured rollout.

## Local run and checks

```sh
python -m venv .venv
.venv/bin/pip install -r telegram_bot/requirements.txt
# Export host settings from telegram_bot/.env.example in your shell.
# Leave WEBHOOK_URL unset for long polling. Do not poll while a live webhook runs.
.venv/bin/python telegram_bot/bot.py
```

The service does not automatically read `.env` files. Export variables in the
shell or use your host's environment settings. Names, selections, PIN sessions
and pending confirmation buttons are in memory and reset on restart; users can
set their name again and reopen the menu. Claims, top-up cooldowns, quotas,
history, audit and mutation retry receipts persist in Firestore. Telegram
framework updates are queued in memory after the webhook acknowledges them;
process termination can lose a queued, unprocessed update. Recover committed
claims using `/mine`; refresh other state before retrying. This is not a durable
job queue or a promise of exactly-once message delivery.

```sh
.venv/bin/python -m unittest discover -s telegram_bot -p test_bot.py -v
npm run lint
npm test
npm run build
# Java 21+ needed. These tests use demo IDs and never production data.
npx --yes firebase-tools@15.33.0 emulators:exec --only firestore,auth --project demo-sb-code-tracker 'node --test --test-concurrency=1 functions/security.emulator.test.js functions/legacy-claim.emulator.test.js telegram_bot/compatibility.emulator.test.js && .venv/bin/python -m unittest discover -s telegram_bot -p test_store_emulator.py -v'
```

Each claim/release/add/delete/label writes its code, public inventory mirror,
audit row and retry receipt in a single Firestore transaction. Competing
app/bot claims resolve against the same document. Telegram reveals only after
the transaction commits. The compatibility browser still has its documented
optimistic reveal behavior; this bot does not change it. A confirmation
fingerprints each selected code so an intervening claim/release/edit aborts that
batch. Bulk actions use batches of at most 200 codes; if a later batch fails,
the bot reports completed work. There is no automatic monthly deletion in this
service; filtering switches at ICT midnight and admins can remove expired drops
explicitly, matching the current compatibility app.

Commands are capped at 120/hour per Telegram account. PIN attempts are capped
at five per account per 15 minutes and 100 globally per 15 minutes. Claims and
top-up confirmations are capped at 30/hour per account and 300/hour globally.
Top-ups additionally have a persistent six-hour account cooldown. Telegram
quota keys are distinct from browser IP/device buckets, since the webhook's
server IP is shared. Staff cannot use admin callbacks, even if they know button
data, and group commands direct users to a private chat. CSV formula escaping,
no Telegram rich-text parsing, and token-free request logging keep user-entered
names, vouchers and credentials out of executable formatting or logs.
